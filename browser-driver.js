/**
 * browser-driver — playwright-cli 薄驱动（Auto 浏览器模式）
 *
 * 职责（设计文档 §5）：
 *  - 以子进程方式调用全局安装的 playwright-cli（Windows 下是 .cmd，必须 shell:true）
 *  - 命令白名单硬校验：Jev 只能触发设计 §7 的 27 个浏览器操作，其余一律拒绝
 *  - 每条命令 30s 超时强杀；输出统一走 --json 包裹（成功 {result} / 失败 {isError,error}）
 *  - cwd 固定为 data/（由 server.js 注入 driver.dataDir），截图工件落在 data/ 下
 *
 * 对外接口（server.js 调用）：
 *  status()                                  → {available, version} | {available:false, reason:'not-installed', error}
 *  open(session, url, {browser})             → {ok, browser} | {ok:false, error(人话)}
 *  snapshot(session)                         → {ok, snapshot(YAML 文本)}
 *  pageInfo(session)                         → {ok, url, title}（工程自动执行 tab-list，不占 Jev 动作）
 *  act(session, command, ref, text)          → {ok, result} | {ok:false, error}
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
    if (j && Object.prototype.hasOwnProperty.call(j, 'result')) {
      return { ok: true, result: typeof j.result === 'string' ? j.result : JSON.stringify(j.result) };
    }
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

  const first = (opts && opts.browser) || 'msedge';
  const out = await exec(session, ['open', target, '--browser', first, '--headed']);
  if (out.ok) return { ok: true, browser: first };

  // 懒探测（设计 §4）：首选浏览器缺失时自动换另一个内核试一次，并把失败翻译成人话
  if (looksLikeBrowserMissing(out.error)) {
    const alt = first === 'msedge' ? 'chrome' : 'msedge';
    const retry = await exec(session, ['open', target, '--browser', alt, '--headed']);
    if (retry.ok) return { ok: true, browser: alt };
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

async function act(session, command, ref, text) {
  let argv;
  try {
    argv = buildArgv(String(command || ''), ref, text);
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
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
  act,
  screenshot,
  close,
  set dataDir(v) { dataDir = v; },
  get dataDir() { return dataDir; },
  _test: { quoteArg, validateAct, buildArgv, OPS, REF_RE },
};
