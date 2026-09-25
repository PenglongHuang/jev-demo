/**
 * browser-driver — playwright-cli 薄驱动（playwright-jev-agent）
 *
 * 职责（设计文档 §5）：
 *  - 以子进程方式调用全局安装的 playwright-cli（Windows 下是 .cmd，必须 shell:true）
 *  - 命令白名单硬校验：Jev 只能触发设计 §7 的 27 个浏览器操作，其余一律拒绝
 *  - 每条命令 30s 超时强杀；输出统一走 --json 包裹（成功 {result} / 失败 {isError,error}）
 *  - cwd 固定为 data/（由 server.js 注入 driver.dataDir），截图工件落在 data/ 下
 *
 * 对外接口（server.js 调用）：
 *  status()                                  → {available, version} | {available:false, reason:'not-installed', error}
 *  open(session, url, {browser})             → {ok, browser} | {ok:false, error(人话)}；browser ∈ chrome(默认)/msedge，
 *                                              缺失时自动换另一个内核重试；实例为独立临时 profile（不碰用户日常浏览器）
 *  snapshot(session)                         → {ok, snapshot(YAML 文本)}
 *  pageInfo(session)                         → {ok, url, title}（工程自动执行 tab-list，不占 Jev 动作）
 *  resize(session, w, h)                     → {ok}（工程自动执行，设置页面视口尺寸）
 *  viewport(session)                         → {w,h} | null（工程自动执行，读当前视口）
 *  fullscreen(session)                       → {ok}（工程自动执行，CDP 真全屏）
 *  act(session, command, ref, text)          → {ok, result} | {ok:false, error}
 *  rect(session, ref)                        → {ok, rect:{x,y,w,h}, viewport:{w,h}}（操作前读位置，标注用）
 *  screenshot(session, name)                 → {ok, dataUrl} | {ok:false, error}
 *  close(session)                            → {ok}
 *
 * 零第三方依赖，仅 Node 内置模块。
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const CMD_TIMEOUT_MS = 30000;      // 每条命令 30s 超时（设计 §11）
const VERSION_CACHE_MS = 60000;    // playwright-cli 安装探测缓存 60s（设计 §4）

/* ---------------- 白名单 + 参数形状（设计 §7：27 个浏览器操作） ----------------
 * ref:    需要 ref（元素定位，来自快照）
 * text:   需要文本参数（变量池 / LLM 生成）
 * optional: 文本可省（tab-new 的 URL、dialog-accept 的 prompt、tab-close 的序号）
 * url:    文本必须是 http(s) URL
 * int:    文本必须是非负整数（标签页序号）
 * pair:   文本必须是 "x,y" 整数对（鼠标坐标 / 滚轮增量）
 * 读取 / 存储 / 网络 / 会话 / 调试类命令一律不在表内 = 硬拒绝。 */
const OPS = {
  click: { ref: true },
  dblclick: { ref: true },
  fill: { ref: true, text: true },
  type: { ref: true, text: true },
  select: { ref: true, text: true },
  check: { ref: true },
  uncheck: { ref: true },
  hover: { ref: true },
  drop: { ref: true },
  upload: { text: true },
  press: { text: true },
  keydown: { text: true },
  keyup: { text: true },
  mousemove: { text: true, pair: true },
  mousedown: {},
  mouseup: {},
  mousewheel: { text: true, pair: true },
  goto: { text: true, url: true },
  'go-back': {},
  'go-forward': {},
  reload: {},
  'tab-new': { text: true, url: true, optional: true },
  'tab-select': { text: true, int: true },
  'tab-close': { text: true, int: true, optional: true },
  'tab-list': {},
  'dialog-accept': { text: true, optional: true },
  'dialog-dismiss': {},
};

const REF_RE = /^[A-Za-z0-9_-]+$/;

/* 可选浏览器内核（open 的 --browser 只认这几个 chromium 系通道；
 * firefox/webkit 对 accessibility 快照支持差，不开放）。 */
const BROWSERS = { chrome: true, msedge: true };

/* ---------------- Windows cmd.exe 引号封装 ----------------
 * shell:true 时 Node 不替我们加引号，必须自己拼命令行。
 * 规则：拒绝 " 与 %（防注入 / 防 cmd 变量展开）；含空白、cmd 元字符或非 ASCII 时包双引号。
 * 这里的拒绝与 validateAct 对 text 的校验一致 —— 引号封装的安全性由「上游禁止这些字符」保证。 */
function quoteArg(s) {
  if (/["%\r\n]/.test(s)) throw new Error('参数含有不允许的字符（双引号、百分号或换行）：' + JSON.stringify(String(s).slice(0, 60)));
  return /[\s&|<>()^\u0080-￿]/.test(s) ? '"' + s + '"' : String(s);
}

/* ---------------- act 参数校验（白名单硬校验，违规即抛错） ---------------- */
function validateAct(command, ref, text) {
  const shape = OPS[command];
  if (!shape) throw new Error('不允许的命令：' + JSON.stringify(String(command)) + '（白名单外 / 已被硬排除）');

  let outRef = null;
  if (shape.ref) {
    if (!ref || !REF_RE.test(ref)) throw new Error('命令 ' + command + ' 需要合法 ref（形如 e12），收到：' + JSON.stringify(String(ref == null ? '' : ref).slice(0, 40)));
    outRef = ref;
  } else if (ref) {
    throw new Error('命令 ' + command + ' 不接受 ref 参数');
  }

  let outText = null;
  if (text != null && String(text) !== '') {
    const t = String(text);
    if (!shape.text) throw new Error('命令 ' + command + ' 不接受文本参数');
    if (/["%\r\n]/.test(t)) throw new Error('文本参数含有不允许的字符（双引号、百分号或换行）');
    if (shape.url && !/^https?:\/\//i.test(t)) throw new Error('命令 ' + command + ' 的文本必须是 http:// 或 https:// 开头的 URL');
    if (shape.int && !/^\d+$/.test(t)) throw new Error('命令 ' + command + ' 的文本必须是非负整数（标签页序号）');
    if (shape.pair && !/^\s*-?\d+\s*,\s*-?\d+\s*$/.test(t)) throw new Error('命令 ' + command + ' 的文本必须是 "x,y" 整数坐标对');
    outText = t;
  }
  if (shape.text && !shape.optional && outText == null) {
    throw new Error('命令 ' + command + ' 需要文本参数');
  }
  return { op: command, ref: outRef, text: outText };
}

/* ---------------- argv 组装（对齐 playwright-cli 各命令签名） ---------------- */
function buildArgv(command, ref, text) {
  const v = validateAct(command, ref, text);
  if (v.ref != null && v.text != null) return [v.op, v.ref, v.text];   // fill/type/select
  if (v.ref != null) return [v.op, v.ref];                             // click/dblclick/check/...
  if (v.text != null) return [v.op, v.text];                           // press/goto/tab-select/...
  return [v.op];                                                       // 无参动作
}

/* ---------------- 子进程封装 ---------------- */
let dataDir = path.join(__dirname, 'data');   // server.js 启动时注入 DATA_DIR

function killTree(child) {
  if (!child || child.killed) return;
  if (IS_WIN && child.pid) {
    // shell:true 时杀 cmd 不一定杀到 playwright-cli，按进程树强杀
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (_) { /* noop */ }
  } else {
    try { child.kill('SIGKILL'); } catch (_) { /* noop */ }
  }
}

function run(session, args, opts) {
  const useJson = !opts || opts.json !== false;
  const argv = (session ? ['-s=' + session] : []).concat(args, useJson ? ['--json'] : []);

  return new Promise((resolve) => {
    let child;
    try {
      if (IS_WIN) {
        // npm 全局命令是 .cmd：Node 安全策略要求 shell:true，引号自行拼装
        const line = ['playwright-cli'].concat(argv.map(quoteArg)).join(' ');
        child = spawn(line, { shell: true, cwd: dataDir, windowsHide: true });
      } else {
        child = spawn('playwright-cli', argv, { cwd: dataDir, windowsHide: true });
      }
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: String(e && e.message || e), timedOut: false });
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, CMD_TIMEOUT_MS);

    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + String(e && e.message || e), timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code == null ? -1 : code, stdout, stderr, timedOut }); });
  });
}

/* --json 的输出形状不统一：多数命令是 {result: "..."}，失败是 {isError, error}，
 * 而 snapshot 直接输出 {snapshot: "..."} 对象（实测 v0.1.17）。
 * 这里把对象形结果解包成文本：优先 snapshot / result / text 字段。 */
function unwrapResult(r) {
  if (typeof r === 'string') return r;
  if (r && typeof r === 'object') {
    if (typeof r.snapshot === 'string') return r.snapshot;
    if (typeof r.result === 'string') return r.result;
    if (typeof r.text === 'string') return r.text;
    if (!Object.keys(r).length) return '';
    return JSON.stringify(r, null, 2);
  }
  return r == null ? '' : String(r);
}

/* --json 包裹解析：成功 {result} / 失败 {isError,error}。
 * 实测 playwright-cli 失败时退出码仍是 0 且输出 "### Error"，退出码不可靠，
 * 必须以 JSON 包裹为准；非 JSON 输出按「code!=0 或有 stderr 则失败」兜底。 */
function parseEnvelope(out) {
  const text = String(out.stdout || '').trim();
  if (!text) {
    if (out.code !== 0 || String(out.stderr || '').trim()) {
      return { ok: false, error: String(out.stderr || '').trim().slice(0, 500) || ('进程异常退出 code=' + out.code) };
    }
    return { ok: true, result: '' };
  }
  try {
    const j = JSON.parse(text);
    if (j && j.isError) return { ok: false, error: String(j.error || 'playwright-cli 执行出错').slice(0, 500) };
    if (j && typeof j === 'object') return { ok: true, result: unwrapResult(j) };   // 覆盖 {result} 与 {snapshot} 两种形状
    return { ok: true, result: text };
  } catch (_) {
    if (out.code !== 0 || String(out.stderr || '').trim()) {
      return { ok: false, error: (String(out.stderr || '').trim() || text).slice(0, 500) };
    }
    return { ok: true, result: text };
  }
}

async function exec(session, args, opts) {
  const out = await run(session, args, opts);
  if (out.timedOut) return { ok: false, error: '命令超时（' + Math.round(CMD_TIMEOUT_MS / 1000) + 's）被终止：' + String(args[0]) };
  return parseEnvelope(out);
}

/* ---------------- 对外接口 ---------------- */

let versionCache = { at: 0, value: null };

async function status() {
  const now = Date.now();
  if (versionCache.value && now - versionCache.at < VERSION_CACHE_MS) return versionCache.value;

  const out = await run(null, ['--version'], { json: false });
  let value;
  if (out.code === 0 && out.stdout.trim()) {
    value = { available: true, version: out.stdout.trim().split(/\r?\n/)[0] };
  } else {
    const all = (out.stderr + '\n' + out.stdout);
    const notInstalled = /not recognized|not found|enoent|commandnotfound/i.test(all);
    value = {
      available: false,
      reason: notInstalled ? 'not-installed' : 'error',
      error: notInstalled ? 'playwright-cli 未安装：请执行 npm i -g @playwright/cli' : all.trim().slice(0, 300) || '未知错误',
    };
  }
  versionCache = { at: now, value };
  return value;
}

function looksLikeBrowserMissing(errText) {
  return /browser|channel|executable|launch|找到.*浏览器/i.test(String(errText || ''));
}

function humanBrowserError(tried, raw) {
  if (looksLikeBrowserMissing(raw)) {
    return '未找到可用的本机浏览器（已尝试 ' + tried + '）：请安装 Microsoft Edge 或 Google Chrome 后重试。原始错误：' + String(raw).slice(0, 200);
  }
  return String(raw);
}

async function open(session, url, opts) {
  const target = String(url || '');
  if (!/^https?:\/\//i.test(target)) return { ok: false, error: '起始 URL 必须以 http:// 或 https:// 开头：' + JSON.stringify(target.slice(0, 80)) };

  const requested = (opts && opts.browser) || 'chrome';
  const first = BROWSERS[requested] ? requested : null;
  if (!first) {
    return { ok: false, error: '不支持的浏览器内核：' + JSON.stringify(String(requested).slice(0, 40)) + '（可选 chrome / msedge）' };
  }

  /* 最大化：写 config 文件并经 --config 传给 open（daemon 的 cwd 是 dataDir，
   * config 路径含空格时 quoteArg 会自动包引号） */
  let configArgs = [];
  if (opts && opts.maximize) {
    const cfgPath = path.join(dataDir, MAXIMIZED_CONFIG_FILE);
    try {
      fs.writeFileSync(cfgPath, JSON.stringify(buildMaximizedConfig({ native: Boolean(opts.native) }), null, 2));
      configArgs = ['--config', cfgPath];
    } catch (e) {
      return { ok: false, error: '写入最大化配置失败：' + String(e && e.message || e) };
    }
  }

  const out = await exec(session, ['open', target, '--browser', first, '--headed'].concat(configArgs));
  if (out.ok) return { ok: true, browser: first, maximized: Boolean(opts && opts.maximize), native: Boolean(opts && opts.native) };

  // 懒探测（设计 §4）：首选浏览器缺失时自动换另一个内核试一次，并把失败翻译成人话
  if (looksLikeBrowserMissing(out.error)) {
    const alt = first === 'msedge' ? 'chrome' : 'msedge';
    const retry = await exec(session, ['open', target, '--browser', alt, '--headed'].concat(configArgs));
    if (retry.ok) return { ok: true, browser: alt, maximized: Boolean(opts && opts.maximize), native: Boolean(opts && opts.native) };
    return { ok: false, error: humanBrowserError(first + ' → ' + alt, retry.error) };
  }
  return { ok: false, error: humanBrowserError(first, out.error) };
}

async function snapshot(session) {
  const out = await exec(session, ['snapshot']);
  return out.ok ? { ok: true, snapshot: out.result } : out;
}

/* 工程自动执行（不占 Jev 动作名额）：tab-list 拿当前标签页 url+标题。
 * 实测输出形如 "- 0: (current) [Example Domain](https://example.com/)" */
async function pageInfo(session) {
  const out = await exec(session, ['tab-list']);
  if (!out.ok) return { ok: false, url: '', title: '', error: out.error };
  const m = String(out.result || '').match(/-\s*\d+:\s*\(current\)\s*\[([^\]]*)\]\(([^)]*)\)/);
  return { ok: true, url: m ? m[2] : '', title: m ? m[1] : '' };
}

/* 工程自动执行（不占 Jev 动作名额，同 pageInfo/tab-list）：调整浏览器窗口尺寸。
 * 固定尺寸场景用 resize；「全屏」场景不用 resize（会把已最大化的窗口又变回普通
 * 窗口），而是走 open 的 maximize 分支（见 buildMaximizedConfig）。 */
function parseWindowSize(w, h) {
  const nw = Math.floor(Number(w));
  const nh = Math.floor(Number(h));
  if (!isFinite(nw) || !isFinite(nh) || nw < 200 || nh < 200 || nw > 10000 || nh > 10000) return null;
  return { w: nw, h: nh };
}

async function resize(session, w, h) {
  const size = parseWindowSize(w, h);
  if (!size) return { ok: false, error: '窗口尺寸必须是 200~10000 的整数（收到 ' + JSON.stringify(String(w)) + '×' + JSON.stringify(String(h)) + '）' };
  return exec(session, ['resize', String(size.w), String(size.h)]);
}

/* 最大化 config：playwright-cli 的 config 文件里 browser.launchOptions 与
 * browser.contextOptions 会被 daemon 原样透传给 launchPersistentContext
 * （coreBundle.js createPersistentBrowser），因此 chromium 原生
 * --start-maximized + viewport:null 即为真最大化（窗口进入最大化态，
 * viewport = 工作区全幅），不是 resize 模拟的「摆成工作区大小的普通窗口」。
 * 注意：不能再叠加 --window-position —— 实测应用位置会把最大化打回普通
 * 窗口（视口 1036x710），两个参数互斥。
 *
 * native=true 时追加 --force-device-scale-factor=1：让 Chrome 忽略 Windows
 * 显示缩放按物理像素渲染。例如 1920×1080 屏 + 系统 125% 缩放，默认页面视口
 * 只有 1536×864（CSS 像素 = 物理 ÷ 1.25）；强制 100% 后视口就是 1920×1080，
 * 截图与页面布局都与屏幕原生分辨率一致。 */
function buildMaximizedConfig(opts) {
  const args = ['--start-maximized'];
  if (opts && opts.native) args.push('--force-device-scale-factor=1', '--high-dpi-support=1');
  return {
    browser: {
      launchOptions: { args },
      contextOptions: { viewport: null },
    },
  };
}

/* 工程自动执行（不占 Jev 名额，同 pageInfo）：读当前视口尺寸，
 * 用于 open(maximize) 后校验最大化是否真的生效（企业策略等可能忽略
 * --start-maximized），失败则由 server 触发 resize 兜底。 */
async function viewport(session) {
  const out = await exec(session, ['eval', "(function(){return window.innerWidth+'x'+window.innerHeight})()"]);
  if (!out.ok) return null;
  const m = String(out.result || '').match(/(\d+)x(\d+)/);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

/* 真·全屏（工程自动执行，不占 Jev 名额）。
 *
 * 为什么不用启动参数：实测本机 Chrome 上，--start-fullscreen 与 --kiosk
 * 虽进入进程命令行却被忽略（窗口仍是默认 1036x711），只有 --start-maximized
 * 生效；F11 经 CDP 派发也到不了浏览器 UI 层。可靠路径是 CDP
 * Browser.setWindowBounds(windowState:'fullscreen')：窗口进入全屏态
 * （outer == inner == 屏幕全尺寸，连任务栏一起盖住，无浏览器工具栏）。
 *
 * 安全性：run-code 能执行任意 Playwright 代码，因此它**不在** OPS 白名单里
 * （Jev 无法触发）；只有本文件的工程侧函数（pageInfo/resize/viewport/fullscreen）
 * 直接调用 exec 使用它。片段本身不含双引号与百分号，符合 quoteArg 约束。 */
const FULLSCREEN_SNIPPET =
  'async page => { const cdp = await page.context().newCDPSession(page); ' +
  'const info = await cdp.send(\'Browser.getWindowForTarget\'); ' +
  'await cdp.send(\'Browser.setWindowBounds\', { windowId: info.windowId, bounds: { windowState: \'fullscreen\' } }); ' +
  'return \'fullscreen\'; }';

async function fullscreen(session) {
  const out = await exec(session, ['run-code', FULLSCREEN_SNIPPET]);
  return out.ok ? { ok: true } : out;
}

/* ---------------- 读元素矩形（工程自动执行，不占 Jev 名额） ----------------
 * 步骤截图的标注用它：在**操作前**读被操作元素的位置，连同当时的视口尺寸一起返回。
 * 两者必须同一时刻读到 —— 截图是设备像素、矩形是 CSS 像素，换算比例只能这么算出来
 * （本项目窗口方案有原生像素/固定尺寸等，DPR 不固定，不能假设 1:1）。
 * 标注本身画在图上（public/js/anno.js），被驱动的页面里不留任何痕迹。 */
const RECT_SNIPPET =
  'el => { var r=el.getBoundingClientRect(); return Math.round(r.left)+\',\'+Math.round(r.top)+\',\''
  + '+Math.round(r.width)+\',\'+Math.round(r.height)+\',\'+window.innerWidth+\',\'+window.innerHeight; }';

async function rect(session, ref) {
  const r = String(ref == null ? '' : ref);
  if (!REF_RE.test(r)) return { ok: false, error: '读元素位置需要合法 ref（形如 e12），收到：' + JSON.stringify(r.slice(0, 40)) };
  const out = await exec(session, ['eval', RECT_SNIPPET, r]);
  if (!out.ok) return out;
  /* eval 的返回值被 CLI 又 JSON 序列化了一次，字符串带引号 —— 剥掉再解析 */
  let text = out.result;
  if (typeof text === 'string' && /^".*"$/.test(text)) {
    try { text = JSON.parse(text); } catch (_) { /* 保持原样 */ }
  }
  const m = String(text).match(/^(-?\d+),(-?\d+),(\d+),(\d+),(\d+),(\d+)$/);
  if (!m) return { ok: false, error: '元素位置解析失败：' + JSON.stringify(String(text).slice(0, 60)) };
  return { ok: true, rect: { x: +m[1], y: +m[2], w: +m[3], h: +m[4] }, viewport: { w: +m[5], h: +m[6] } };
}

const MAXIMIZED_CONFIG_FILE = 'auto-cli.config.json';   // 落在 dataDir（daemon 的 cwd）

/* upload 文件路径必须落在 data/ 目录内（防「读任意本地文件 → 经页面文件框
 * 外发」的泄露原语）。允许相对 data/ 的路径与绝对路径两种写法；URI 形式
 * （file:// 等）会被当成相对文件名绕过前缀判断，直接拒绝。 */
function uploadPathAllowed(baseDir, text) {
  const t = String(text).trim();
  if (!t || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false;
  const root = path.resolve(baseDir);
  const resolved = path.resolve(root, t);
  return resolved === root || resolved.startsWith(root + path.sep);
}

async function act(session, command, ref, text) {
  let argv;
  try {
    argv = buildArgv(String(command || ''), ref, text);
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
  if (String(command) === 'upload' && text != null && !uploadPathAllowed(dataDir, text)) {
    return { ok: false, error: 'upload 只允许 data/ 目录内的文件（安全限制），收到：' + String(text).slice(0, 120) };
  }
  const out = await exec(session, argv);
  return out.ok ? { ok: true, result: out.result } : out;
}

async function screenshot(session, name) {
  const file = String(name || 'shot').replace(/[^A-Za-z0-9_-]/g, '') + '.png';
  const out = await exec(session, ['screenshot', '--filename', file]);
  if (!out.ok) return out;
  const p = path.join(dataDir, file);
  try {
    const dataUrl = 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
    return { ok: true, dataUrl };   // 文件保留在 data/ 下，便于排查与留证
  } catch (_) {
    return { ok: false, error: '截图文件读取失败（预期路径 ' + p + '）' };
  }
}

async function close(session) {
  return exec(session, ['close']);
}

module.exports = {
  status,
  open,
  snapshot,
  pageInfo,
  resize,
  viewport,
  fullscreen,
  act,
  rect,
  screenshot,
  close,
  set dataDir(v) { dataDir = v; },
  get dataDir() { return dataDir; },
  _test: { quoteArg, validateAct, buildArgv, OPS, REF_RE, BROWSERS, parseEnvelope, unwrapResult, uploadPathAllowed, parseWindowSize, buildMaximizedConfig, FULLSCREEN_SNIPPET, RECT_SNIPPET },
};
