/**
 * browser-driver — playwright-cli 薄驱动（playwright-jev-agent）
 *
 * 职责（设计文档 §5）：
 *  - 以子进程方式调用全局安装的 playwright-cli（Windows 下是 .cmd，必须 shell:true）
 *  - 命令白名单硬校验：Jev 只能触发设计 §7 的 19 个浏览器操作，其余一律拒绝
 *  - 每条命令 30s 超时强杀；输出统一走 --json 包裹（成功 {result} / 失败 {isError,error}）
 *  - cwd 固定为 data/（由 server.js 注入 driver.dataDir），截图工件落在 data/ 下
 *
 * 对外接口（server.js 调用）：
 *  status()                                  → {available, version} | {available:false, reason:'not-installed', error}
 *  cdpProbe()                                → {available, channel, endpoint, hint}（CDP 预检：默认 profile 里有没有 DevToolsActivePort）
 *  open(session, url, {browser, mode, cdp})  → {ok, browser, mode} | {ok:false, error(人话)}；browser ∈ chrome(默认)/msedge，
 *                                              mode ∈ isolated(默认)/persistent/cdp —— 见下方「浏览器模式」；
 *                                              内核缺失时自动换另一个重试（仅 isolated/persistent：那两个实例是我们起的）
 *  snapshot(session)                         → {ok, snapshot(YAML 文本)}
 *  pageInfo(session)                         → {ok, url, title, tabs}（工程自动执行 tab-list，不占 Jev 动作）
 *  resize(session, w, h)                     → {ok}（工程自动执行，设置页面视口尺寸；cdp 模式拒绝）
 *  viewport(session)                         → {w,h} | null（工程自动执行，读当前视口）
 *  fullscreen(session)                       → {ok}（工程自动执行，CDP 真全屏；cdp 模式拒绝）
 *  act(session, command, ref, text)          → {ok, result} | {ok:false, error}
 *  rect(session, ref)                        → {ok, rect:{x,y,w,h}, viewport:{w,h}}（操作前读位置，标注用）
 *  screenshot(session, name)                 → {ok, dataUrl} | {ok:false, error}
 *  close(session)                            → {ok, mode, attached}（cdp 下只断开连接，绝不关用户的浏览器）
 *
 * 零第三方依赖，仅 Node 内置模块。
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { createInprocBackend } = require('./browser-inproc.js');

/* ---------------- 后端选择（两条后端：进程内 playwright-core / playwright-cli） ----------------
 * 进程内是默认：每条命令不再新起一个 node 进程，实测把每步机械开销从 ~8.4s 压到 ~1.0s
 * （见 browser-inproc.js 文件头）。playwright-cli 那条完整保留作兜底 ——
 * 环境变量 JEVDEMO_BACKEND=cli 或 UI 上的「驱动后端」都能切回去。
 *
 * 选择只认三处，优先级从高到低：open 的 opts.backend（UI 传的）→ 环境变量 → 默认 inproc。
 * 非法值一律按默认走（不抛错：一个拼错的字符串不该让整轮跑不起来）。 */
const BACKENDS = { inproc: true, cli: true };
const DEFAULT_BACKEND = 'inproc';
function resolveBackend(o) {
  const explicit = o && o.backend != null ? String(o.backend) : '';
  if (BACKENDS[explicit]) return explicit;
  const env = process.env.JEVDEMO_BACKEND != null ? String(process.env.JEVDEMO_BACKEND) : '';
  if (BACKENDS[env]) return env;
  return DEFAULT_BACKEND;
}

const INPROC_HINT = '（执行 npm i playwright-core 安装，或把「运行参数 → 驱动后端」切回 playwright-cli）';

/* 进程内后端实例：懒建一次。共享面在这里注入 —— 白名单校验、快照可用性判定、矩形片段
 * 与解析、模式计划、错误翻译、CDP 端点发现**全部取自本文件**，browser-inproc.js 里
 * 不再写第二份（两套行为迟早漂移，而白名单与 ref 解析漂移是静默的那种错）。 */
let inprocInstance = null;
let inprocTried = false;
function inprocBackend() {
  if (inprocTried) return inprocInstance;
  inprocTried = true;
  try {
    inprocInstance = createInprocBackend({
      getDataDir: () => dataDir,
      ACTION_TIMEOUT_MS: ACTION_TIMEOUT_MS,
      SETTLE_MS: SETTLE_MS, SETTLE_REQ_CAP_MS: SETTLE_REQ_CAP_MS,
      SETTLE_NAV_MS: SETTLE_NAV_MS, SNAPSHOT_CAP_MS: SNAPSHOT_CAP_MS,
      REF_RE: REF_RE, OPS: OPS, BROWSERS: BROWSERS, MODES: MODES,
      PROFILE_DIR: PROFILE_DIR, CDP_CHANNELS: CDP_CHANNELS,
      SNAPSHOT_TRUSTED_ACTIONS: SNAPSHOT_TRUSTED_ACTIONS, HTTP_URL_RE: HTTP_URL_RE,
      validateAct: validateAct, usableSnapshot: usableSnapshot, summarizeError: summarizeError,
      parseRectCsv: parseRectCsv, parseTabs: parseTabs, parseWindowSize: parseWindowSize,
      RECT_SNIPPET: RECT_SNIPPET, uploadPathAllowed: uploadPathAllowed,
      buildMaximizedConfig: buildMaximizedConfig, openPlan: openPlan,
      tabSelectRefusal: tabSelectRefusal,
      looksLikeBrowserMissing: looksLikeBrowserMissing,
      humanBrowserError: humanBrowserError, humanProfileError: humanProfileError,
      humanCdpProbeError: humanCdpProbeError, humanCdpAttachError: humanCdpAttachError,
      cdpProbe: cdpProbe, channelPortFile: channelPortFile, resolveHttpTarget: resolveHttpTarget,
    });
  } catch (e) {
    inprocInstance = null;
  }
  return inprocInstance;
}

/* 这条会话现在归哪条后端：**以进程内后端自己的会话表为唯一判据**（inst.state —— 它手上
 * 还留着这个会话就归它），不再在 sessionState 里另存一份后端字段（两份状态迟早不同步）。
 *
 * 判据必须是「会话还在不在它手上」，而**不是** isOpen 那个「页还活着吗」——
 * 这两件事在真实场景里会分开：用户在专用标签页上手动关掉它（或那一页崩了）时，进程内
 * 那边的会话仍在、只是 st.page.isClosed() 为真。按 isOpen 判就会误判成「这条会话不归
 * 进程内」→ close 走 CLI → CLI 侧压根没有这个会话（它的 close 是空操作，还回 ok）→
 * 那个真实窗口与 isolated 的临时 profile 目录永远收不了尾（下次 open 撞 profile 占用），
 * 而 inproc 那条能把「关页 / 关上下文 / 删临时 profile / 清会话表」一次做全的 close
 * 从头到尾没被调用过；act / snapshot 这些入口也会被推去 CLI，报出 CLI 的「没有这个会话」，
 * 而不是前端认得、据此整轮停手的「专用标签页已不在」。
 * isOpen 的对外语义保持原样（它表达「页还在、能继续操作」，前端与守卫依赖这个判断），
 * 两件事分开问：liveness 走 isOpen，归属走 state。
 *
 * 没开的会话一律走 CLI —— 那条路会给出「请先 open」的人话报错，与改动前一致。 */
function useInproc(session) {
  const inst = inprocBackend();
  if (!inst) return false;
  /* state 是本文件与进程内后端之间的既有接口（两条后端共享的那份 api）。万一它将来不在，
   * 退回旧判据 —— 行为与改动前一致，总好过把整条会话默认推给 CLI。 */
  if (typeof inst.state !== 'function') return Boolean(inst.isOpen(session));
  return Boolean(inst.state(session));
}

const IS_WIN = process.platform === 'win32';
const CMD_TIMEOUT_MS = 30000;      // 每条命令 30s 超时（设计 §11）
const VERSION_CACHE_MS = 60000;    // playwright-cli 安装探测缓存 60s（设计 §4）

/* 单个浏览器动作（click / fill…）的 actionability 预算。
 * playwright-cli 的 defaultConfig 写死 timeouts.action = 5000（coreBundle 的 defaultConfig），
 * 对真实页面太短：动作要等元素「visible, enabled and stable」，稳定判定靠注入脚本的两帧
 * rAF，标签页被切到后台或窗口被遮挡时 rAF 会被节流，5s 一眨眼就到 —— 报出来的就是
 * `TimeoutError: Timeout 5000ms exceeded. | - waiting for element to be visible, enabled and stable`。
 * Playwright 自己的默认动作超时是 30s，这里对齐（实测同一元素隔一会儿重试就过）。
 * 走环境变量而不是 config 文件：daemon 是 open/attach 那一次起的，env 随 spawn 传下去即可，
 * 三种模式一起生效，也不用为「不开最大化」再多写一个 config 文件。
 * JEVDEMO_ACTION_TIMEOUT_MS 只影响我们起的 CLI 进程，不动用户的任何设置。 */
const ACTION_TIMEOUT_MS = Number(process.env.JEVDEMO_ACTION_TIMEOUT_MS) > 0
  ? Number(process.env.JEVDEMO_ACTION_TIMEOUT_MS)
  : 30000;

/* 动作之后「等页面稳定」的那几个数：与上游 playwright-mcp 的 waitForCompletion 逐条对齐
 * （coreBundle 里 click 等动作的 handle 就是 setIncludeSnapshot() + await waitForCompletion()）。
 * 上游这么做是因为它把动作之后的快照当成「下一步的页面依据」交回给模型 —— 我们复用这份
 * 快照，就必须等得一样多，否则拿到的是动作那一瞬间的页面（异步渲染还没落地）。
 * 差别有一处：上游 hover / select / uncheck / navigate / reload 这类**根本不等**，
 * 动作返回即拍；我们自己控制这条命令，把它们也一并等上。 */
const SETTLE_MS = 500;             // 动作之后先给的固定静默期
const SETTLE_REQ_CAP_MS = 5000;    // 等动作期间发出的请求完成的上限
const SETTLE_NAV_MS = 10000;       // 触发了导航时等 load 的上限
const SNAPSHOT_CAP_MS = 10000;     // 取快照自己的上限（原生弹窗挂着时上游是 race 掉的，我们没有那层）

/* 合并命令（动作 + 等稳定 + 取快照）的子进程超时。
 * 必须盖住这条命令里**所有**会等待的段：动作本身（ACTION_TIMEOUT_MS）、守卫的
 * Promise.race（GUARD_RACE_MS）、settle（静默 500 + 请求上限 5000 + 再静默 500，
 * 导航则 SETTLE_NAV_MS）、以及取快照自己的上限（SNAPSHOT_CAP_MS）。
 * 少算哪一段，表现都是「动作其实已经做成了，这一步却报超时失败」—— 比慢更糟。 */
const ACT_FAST_TIMEOUT_MS = ACTION_TIMEOUT_MS + 2 * (SETTLE_MS + SETTLE_REQ_CAP_MS + SETTLE_NAV_MS + SNAPSHOT_CAP_MS);

/* 子进程环境：**每次 spawn 时现取** process.env（不能模块加载时就快照 —— 那样运行期
 * 改过的 PATH 等一律看不见，测试里换 playwright-cli 桩会直接失效）。 */
function cliEnv() {
  return Object.assign({}, process.env, { PLAYWRIGHT_MCP_TIMEOUT_ACTION: String(ACTION_TIMEOUT_MS) });
}

/* ---------------- 白名单 + 参数形状（设计 §7：19 个浏览器操作） ----------------
 * ref:    需要 ref（元素定位，来自快照）
 * text:   需要文本参数（变量池 / 下拉框选项名 / 键名 / LLM 生成）
 * optional: 文本可省（tab-new 的 URL、dialog-accept 的 prompt、tab-close 的序号）
 * url:    文本必须是 http(s) URL
 * int:    文本必须是非负整数（标签页序号）
 * 坐标鼠标 / 修饰键 / 双击 / 拖拽 8 个动作随 auto-core 裁剪同步移除
 * （a11y 快照驱动下不可达或无场景），此处硬拒绝防回潮。
 * 读取 / 存储 / 网络 / 会话 / 调试类命令一律不在表内 = 硬拒绝。 */
const OPS = {
  click: { ref: true },
  fill: { ref: true, text: true },
  type: { ref: true, text: true },
  select: { ref: true, text: true },
  check: { ref: true },
  uncheck: { ref: true },
  hover: { ref: true },
  upload: { text: true },
  press: { text: true },
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

/* 「这个字符串是不是 http(s) URL」的唯一一份判定：起点 URL（openViaCli 与进程内后端的
 * open 都要在**起浏览器之前**挡掉非 http(s) 的起点）与 `url` 形命令参数共用它。
 * 进程内后端经 shared 注入拿到**同一个对象** —— 别在那边的注入行里再写一份字面量，
 * 两边文本一旦分叉，就是「CLI 拒了、进程内放了」这种查起来最费劲的静默不一致。
 * （另有两处 /^https?:\/\// 是取主机名用的 CDP 端点解析，语义不同，不并进来。） */
const HTTP_URL_RE = /^https?:\/\//i;

/* 可选浏览器内核（open 的 --browser 只认这几个 chromium 系通道；
 * firefox/webkit 对 accessibility 快照支持差，不开放）。 */
const BROWSERS = { chrome: true, msedge: true };

/* ---------------- 浏览器模式（连接方式，与内核正交） ----------------
 * 模式是 open() 的选项，**不是** Jev 能触发的动作：attach 仍在 OPS 硬拒绝名单里
 * （tests/driver.spec.js 也盯着这条），只有本文件的工程侧代码能调它 —— 与
 * run-code / eval 的既有先例一致。
 *
 *   isolated   —— 默认。每次 run 起一个干净实例（browserType.launch），profile 不落盘，
 *                 关掉即消失。既有的「不碰用户日常浏览器」承诺由它承担。
 *   persistent —— 仍是我们自己起的窗口，但 profile 落盘到 data/browser-profile/：
 *                 用户手动登录一次，后续 run 复用（不碰日常浏览器，也不用每次重登）。
 *   cdp        —— 不启动浏览器，attach 到用户已开着调试端口的 Chrome/Edge，
 *                 直接复用其真实 profile 的登录态。**会操作用户的真实浏览器**，
 *                 因此窗口类动作（resize / fullscreen / maximize）在本模式下全部住手，
 *                 且只在我们自己新建的专用标签页里操作（见 TAB_MARK_SNIPPET 守卫）。 */
const MODES = { isolated: true, persistent: true, cdp: true };
const PROFILE_DIR = 'browser-profile';   // persistent 的 profile 目录名（data/ 下，随 data/ 一起 gitignore）
const CDP_TARGET_MAX = 300;              // CDP 连接目标串长度上限
/* attach --cdp 认的内核名 = 去读该浏览器**默认** user data dir 里的 DevToolsActivePort。
 * 注意 CLI 自己会把端口拼成 ws://localhost:<port>/devtools/browser（coreBundle
 * resolveChannelEndpoint），实测这个地址被 Chrome 回 404 —— 所以我们先自己解析端口文件、
 * 拼出候选端点并真探一次（见 cdpCandidates / probeCdpEndpoint），内核名只作兜底。
 * Chrome 136+ 在默认目录上默认禁用远程调试，需在 chrome://inspect 勾选允许。 */
const CDP_CHANNELS = ['chrome', 'chrome-beta', 'chrome-dev', 'chrome-canary',
  'msedge', 'msedge-beta', 'msedge-dev', 'msedge-canary'];

/* 会话级的模式记忆：open 时写入、close 时清除。窗口类动作与标签页守卫靠它判断
 * 「这个会话是不是附身在用户浏览器上」。进程内内存，server 重启即失效（守卫随之
 * 降级为不拦截，不会误伤）。 */
const sessionState = new Map();

/* ---------------- CDP 连接目标校验（进命令行前唯一一道闸） ---------------- */
function validateCdpTarget(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) throw new Error('CDP 模式需要一个连接目标：填内核名（chrome / msedge）自动探测，或填 ws:// 端点');
  if (t.length > CDP_TARGET_MAX) throw new Error('CDP 连接目标过长（上限 ' + CDP_TARGET_MAX + ' 字符）');
  if (/["%\r\n]/.test(t)) throw new Error('CDP 连接目标含有不允许的字符（双引号、百分号或换行）');
  if (CDP_CHANNELS.indexOf(t) >= 0) return t;
  if (!/^(wss?|https?):\/\//i.test(t)) {
    throw new Error('CDP 连接目标只能是内核名（' + CDP_CHANNELS.slice(0, 2).join(' / ') + '）或 ws:// / http:// 端点');
  }
  return t;
}

/* ---------------- open 计划（纯函数：三种模式各自产出什么命令行 + 什么 config） ----------------
 * 抽成纯函数是为了能在不起浏览器的前提下把三条路径钉死在单元测试里。
 * 返回 { mode, browser, attached, target?, config, commands:[[argv...], ...] }。
 *
 * 为什么 cdp 走 attach + tab-new 两条命令，而不是往 config 里塞 browser.cdpEndpoint
 * 走 open：open 的最后一步是 goto，而 attach 之后 daemon 的「当前标签页」是用户浏览器里
 * 已存在的那一个 —— goto 会直接导航用户的标签页。先 attach（只读快照，不改动页面）
 * 再用 tab-new 新建我们自己的标签页，才能真正做到「绝不动用户已开的标签」。 */
function openPlan(opts) {
  const o = opts || {};
  const mode = Object.prototype.hasOwnProperty.call(o, 'mode') ? String(o.mode) : 'isolated';
  if (!MODES[mode]) {
    throw new Error('不支持的浏览器模式：' + JSON.stringify(String(o.mode).slice(0, 40)) + '（可选 isolated / persistent / cdp）');
  }
  const browser = BROWSERS[o.browser] ? o.browser : 'chrome';
  const url = String(o.url == null ? '' : o.url);

  if (mode === 'cdp') {
    const explicit = o.cdp == null ? '' : String(o.cdp).trim();
    const target = validateCdpTarget(explicit || browser);
    return {
      mode: mode,
      browser: BROWSERS[target] ? target : browser,
      target: target,
      attached: true,
      config: null,                                   // 没有 launch，也就没有启动参数可言
      commands: [['attach', '--cdp=' + target], ['tab-new', url]],
    };
  }

  const argv = ['open', url, '--browser', browser, '--headed'];
  if (mode === 'persistent') {
    const dir = String(o.profileDir == null ? '' : o.profileDir).trim();
    if (!dir) throw new Error('persistent 模式需要 profileDir（浏览器 profile 目录，必须落在 data/ 下）');
    argv.push('--profile', path.join(dir, PROFILE_DIR));
  }
  return {
    mode: mode,
    browser: browser,
    attached: false,
    config: o.maximize ? buildMaximizedConfig({ native: Boolean(o.native) }) : null,
    commands: [argv],
  };
}

/* ---------------- 专用标签页标记（cdp 模式的守卫） ----------------
 * 附身到用户浏览器后，daemon 的「当前标签页」指向我们 tab-new 出来的那一个。用户若手动
 * 关掉它，playwright-cli 会把当前标签页挪到相邻的那个 —— 那是**用户自己的页面**，
 * 必须立刻停手，否则下一步就在人家页面上点起来了。
 *
 * 标记用 window.name：它挂在浏览上下文上，**跨导航存活**（JS 变量一导航就没了，
 * localStorage/sessionStorage 会往用户站点里塞东西 —— 都不行）。名字是运行时才写的、
 * 页面看不见的属性，除了本次 run 谁也不会用这个值。 */
let tabTokenSeq = 0;
function newTabToken(session) {
  tabTokenSeq += 1;
  const base = String(session == null ? '' : session).replace(/[^A-Za-z0-9_-]/g, '').slice(-16) || 'tab';
  return 'jevtab-' + base + '-' + tabTokenSeq;
}

function tabMarkSnippet(token) {
  return '(function(){ window.name = \'' + String(token) + '\'; return window.name; })()';
}

const TAB_READ_SNIPPET = '(function(){ return window.name || \'\'; })()';

/* eval 的返回值被 CLI 又 JSON 序列化了一次（同 rect 的处理）：剥引号、去空白后全等比较 */
function tabGuardOk(expected, raw) {
  const want = String(expected == null ? '' : expected);
  if (!want) return false;
  let got = String(raw == null ? '' : raw).trim();
  if (/^".*"$/.test(got)) {
    try { got = String(JSON.parse(got)); } catch (_) { return false; }
  }
  return got.trim() === want;
}

/* 原生弹窗（confirm / alert / prompt）挂着时的守卫行为。
 * 实测（CDP + 真 Chrome）：弹窗占住渲染主线程，浏览器侧一切 JS 工具都回同一句
 *   Tool "browser_evaluate" does not handle the modal state.
 * 这时读 window.name 判不了标签页归属，但**不能就此当成「标签页没了」** —— 那会把
 * 整轮运行在弹窗这一步上打断，而且连 dialog-accept 都会被自己拦住（弹窗永远处理不掉）。
 * 弹窗只可能是我们自己那一页弹出来的（弹窗由我们下发的命令触发），所以放行这几条：
 * 读类（它们本身在弹窗期间也会被 CLI 拒掉，只是别让守卫先拦）与弹窗处理类。
 * 标签页类命令（tab-close / tab-select / tab-new）**不在名单里**：它们在弹窗期间照样
 * 会执行，且会改「当前标签页」，判不了归属就不动手。 */
const MODAL_GUARD_RE = /does not handle the modal state/i;
const MODAL_SAFE_COMMANDS = {
  'page-info': 1, snapshot: 1, screenshot: 1, rect: 1,
  'dialog-accept': 1, 'dialog-dismiss': 1,
};

/* CDP 守卫的单一入口：当前标签页还是不是我们自己那一个。返回 null = 放行。
 *
 * 为什么必须是单一入口：守卫原先只在 pageInfo 里，而 pageInfo 与本步真正下发命令之间
 * 隔着 Jev 调用 + 文本补问 + 单步确认（可以几分钟）—— 用户在这期间关掉专用标签页，
 * playwright-cli 会把「当前标签页」挪到相邻页面，也就是**用户自己的页面**，随后
 * act 里那批不带 ref 的命令（goto / reload / press / tab-close）会在人家页面上真执行。
 * 所以 snapshot / act / rect / screenshot 全都要过这一关。
 *
 * 只在 cdp + 有 token 时生效：其余模式没有「别人的标签页」这回事，零开销。
 * 判定本身是一次只读 eval（读 window.name），落在用户页面上也无副作用。
 * command 用于「弹窗态」这一条出口的放行判断（见 MODAL_SAFE_COMMANDS）。 */
async function ownTabRefusal(session, command) {
  const st = sessionState.get(session);
  if (!st || st.mode !== 'cdp' || !st.tabToken) return null;
  const guard = await exec(session, ['eval', TAB_READ_SNIPPET]);
  if (guard.ok && tabGuardOk(st.tabToken, guard.result)) return null;
  /* eval 本身失败 + 是弹窗态 → 交给上面的名单决定放行还是停手 */
  if (!guard.ok && MODAL_GUARD_RE.test(guard.error)) {
    if (MODAL_SAFE_COMMANDS[String(command == null ? '' : command)]) return null;
    return {
      ok: false, lostTab: true,
      error: '页面卡在原生弹窗上：' + String(command || '该动作') + ' 在弹窗期间判不了标签页归属，已停手。'
        + '先处理弹窗（接受 / 取消），页面恢复后再继续。',
    };
  }
  return {
    ok: false, lostTab: true,
    error: LOST_TAB_ERROR,   /* 与快路径同一句（前端据此整轮停手，两处必须字字相同） */
  };
}

/* 把当前标签页认作我们的（tab-select / tab-new 之后调用）。
 * 这两个命令都会让「当前标签页」变成一个 window.name 为空的**新页面**（新 Tab 是全新
 * 浏览上下文），不打标记的话下一步的守卫会立刻把它判成「切走了」而误杀整轮运行 ——
 * 而模型恰恰被提示教着用 tab-select 去追 target=_blank 开出来的新 Tab（auto-core 的
 * 「标签页」说明）。 */
async function markOwnTab(session) {
  const st = sessionState.get(session);
  if (!st || st.mode !== 'cdp' || !st.tabToken) return { ok: true };
  const marked = await exec(session, ['eval', tabMarkSnippet(st.tabToken)]);
  if (!marked.ok || !tabGuardOk(st.tabToken, marked.result)) {
    return {
      ok: false, lostTab: true,
      error: '切换标签页后没能标记新页面（可能切到了你自己的标签页）：为免误操作，这里停手了。'
        + '重新开始即可开一个新标签页。',
    };
  }
  return { ok: true };
}

/* tab-select 能不能选这一页：**我们 attach 之前就存在的标签页都是用户的**，
 * 不许把运行范围扩到那儿去（模型看到「标签页」列表里有个标题眼熟的页，完全可能
 * 直接选过去）。纯函数，便于单测；preExisting 为空数组时不拦（拿不到基线就别乱拒）。 */
function tabSelectRefusal(preExisting, url) {
  const u = String(url == null ? '' : url);
  if (!u || !Array.isArray(preExisting) || !preExisting.length) return null;
  if (preExisting.indexOf(u) < 0) return null;
  return {
    ok: false,
    error: '那个标签页是运行开始前就开着的（你自己的页面），不在本次运行的操作范围内：'
      + '要操作的内容请通过我们自己的标签页打开（点链接 / goto），再用 tab-select 切过去。',
  };
}

/* ---------------- CDP 快路径：守卫 + 动作合并成一条 run-code ----------------
 *
 * 为什么合并（2026-09-28 本机实测）：
 *   ① 每条命令都是一次新进程（底价 0.9~1.0s），而 CDP 的守卫是**每条命令前再单跑一次
 *      eval**（实测 1.5s）。合并成一条 run-code 后，一次进程把「查归属 + 干活」都做完，
 *      每步少 3~5 次进程。
 *   ② 更要紧的是原子性：分两条命令时，「查到归属」与「真动手」之间隔着一次进程往返，
 *      用户在那个窗口里关掉或切走专用标签页，动作就落到他自己的页面上了。同一条
 *      run-code 里 page 句柄在命令开始时就绑定了，判完立刻动手，那个窗口不存在。
 *
 * 代码走 --filename 落文件，不塞进命令行：quoteArg 会拒双引号与百分号（cmd 展开面），
 * 而 fill 的文本里什么都可能有。文件放 data/ 下（与截图同域，随 data/ 一起 gitignore），
 * cmd 层完全不经手；片段本身仍只用单引号，保持「片段自身干净」这条纪律。
 *
 * 失败收场三条路，都不静默：
 *   JEV_OWN_TAB_LOST  —— 归属不对：与老路同一句话，前端据此整轮停手
 *   JEV_GUARD_UNKNOWN —— 守卫跑不出来（原生弹窗占住渲染主线程时 evaluate 既不返回也不
 *                        报错，见 MODAL_GUARD_RE）：**退回老路**，让原来的守卫去认弹窗态
 *   其它              —— 原样带回（summarizeError 会保住行尾根因）
 */
const GUARD_LOST_MARK = 'JEV_OWN_TAB_LOST';
const GUARD_UNKNOWN_MARK = 'JEV_GUARD_UNKNOWN';
/* 守卫 evaluate 的等待上限。弹窗占住渲染主线程时它不会返回，只能主动放弃并退回老路。 */
const GUARD_RACE_MS = 2500;
const LOST_TAB_ERROR = '专用标签页已不在（被关闭或被切走）：为免误动你自己的页面，这里停手了。'
  + '重新开始即可开一个新标签页。';

/* 能做进快路径的动作：形状都是「定位到 ref 再调 locator 同名 API」，与 CLI 内部
 * （coreBundle 的 frame.click / fill / hover / check / uncheck）逐字等价。
 * select / type / upload / press / goto / 标签页类 / 弹窗类**不在**此列：它们要么有 CLI
 * 自己的参数解析（select 的选项名匹配），要么是弹窗态下必须照发的命令 —— 走老路更稳。 */
const MERGED_ACTIONS = { click: 1, fill: 1, hover: 1, check: 1, uncheck: 1 };

/* 标签页标记是运行时生成的（jevtab-<会话>-<序号>），这里再挡一道：形状不对就不用快路径，
 * 免得把可疑字符拼进代码片段。 */
const TOKEN_SAFE_RE = /^[A-Za-z0-9_-]+$/;

/* 片段里的单引号 JS 字面量。validateAct 已挡掉双引号 / 百分号 / 换行，
 * 这里只需处理反斜杠与单引号本身。 */
function jsLiteral(s) {
  return '\'' + String(s).replace(/\\/g, '\\\\').replace(/'/g, '\\\'') + '\'';
}

/* 守卫片段：先判归属，归属不对就抛标记。守卫本身也设了等待上限（见 GUARD_RACE_MS）。
 * 计时必须用 page.waitForTimeout，**不能用 setTimeout**：run-code 的函数不在 Node 作用域里
 * 求值，那里没有 setTimeout（实测：CDP 真机跑出来就是 `ReferenceError: setTimeout is not defined`，
 * 合并后的每一步动作都会当场失败）。 */
function guardLines(token) {
  return 'const __g = await Promise.race([page.evaluate(() => window.name || \'\'),'
    + ' page.waitForTimeout(' + GUARD_RACE_MS + ').then(() => \'__jev_guard_timeout__\')]);'
    + ' if (__g === \'__jev_guard_timeout__\') throw new Error(\'' + GUARD_UNKNOWN_MARK + '\');'
    + ' if (__g !== \'' + String(token) + '\') throw new Error(\'' + GUARD_LOST_MARK + '\');';
}

/* 动手前先确认这一页真的在渲染。
 * 2026-09-28 用真 CDP 会话实测（临时 profile 的 Chrome，driver attach 后 tab-new）：
 *   ① 我们那个专用标签页的 document.visibilityState = **hidden**（后台标签页）
 *   ② 老路直接 click → TimeoutError（稳定判定永远不满足）
 *   ③ page.bringToFront() → visibilityState 变 visible，同一个元素 **1.58s 点成功**
 * 原因：后台标签页被 Chrome 节流，rAF 不跑，而 Playwright 的 actionability「stable」要
 * 连续两帧包围盒不变 —— 等不到就是等到超时为止。这不是超时设小了，给多久都没用。
 * 只在**确实被隐藏**时才把自己提到前台：用户正看着我们这一页时不抢焦点。
 * 也**不用 force:true** 绕过判定：那会连「有没有被别的东西挡住」一起跳过，撞上登录
 * 遮罩会直接点穿过去，比失败更糟（会话 r-0926-0046-qrys 就是被遮罩反复挡住直到终止）。 */
const VISIBLE_FIRST_LINE = 'if (await page.evaluate(() => document.visibilityState) !== \'visible\')'
  + ' { try { await page.bringToFront(); } catch (__ev) {} }';

/* 动作之后：等页面稳定，再把无障碍快照取回来（与上游 waitForCompletion + setIncludeSnapshot
 * 同语义，见 SETTLE_MS 的说明）。**必须用 page.waitForTimeout**：run-code 的函数不在 Node
 * 作用域里求值，那里没有 setTimeout（同 guardLines 踩过的坑）。
 * 只在动作真的成功了才取（__err 为空）：失败了就让调用方照旧走「真取一次快照」那条路，
 * 失败步的快照时点与现在完全一致，不叠加新的变量。
 * 取到的文本里没有 ref 就当作没取到（下游全按 ref 行解析，无 ref 等于空页面）——
 * 这条同时兜住「这个 Playwright 版本不认 mode:'ai'」与「弹窗期间取不到快照」两种情形。 */
function settleAndSnapshotLines() {
  return [
    'let __snap = null;',
    /* 整段「等稳定 + 取快照」都不许把动作的成功改写成失败：动作已经做成了，这里再出什么岔子
     * （标签页在静默期被关掉、页面被销毁、waitForTimeout 跟着 reject）也只当「这次没取到」，
     * 交给下一步真取一次。所以外面这一层 try/catch 是**语义**上的：宁可多跑一次快照，
     * 也不能让 driver 报「这一步失败了」——前端会据此把已经生效的动作再喂回模型。 */
    'if (!__err) {',
    '  try {',
    /* 500ms 静默期**在摘监听之前**等：上游就是「动作 → page.waitForTimeout(500) → 才 dispose」
     * （waitForCompletion 的 finally），静默期内才发出的请求（debounce 的 fetch、链式请求）
     * 同样算这个动作引出来的。摘早了就会漏掉它们，等于没等。
     * 监听本身在整段结束处统一摘（成功失败都摘得到，见 mergedActCode）。
     * 已知边界（与上游一致，不是我们的缺口）：静默期结束之后才**发起**的请求不在等待范围内 ——
     * 例如 800ms 后才开始的 debounce fetch，这份快照就是它之前的样子。上游同样如此。 */
    '    await page.waitForTimeout(' + SETTLE_MS + ');',
    '    if (__reqs.some((__r) => __r.isNavigationRequest())) {',
    '      await page.mainFrame().waitForLoadState(\'load\', { timeout: ' + SETTLE_NAV_MS + ' }).catch(() => {});',
    '    } else {',
    '      const __waits = __reqs.filter((__r) => [\'document\', \'stylesheet\', \'script\', \'xhr\', \'fetch\'].indexOf(__r.resourceType()) >= 0)',
    '        .map((__r) => __r.response().then((__x) => __x && __x.finished()).catch(() => {}));',
    '      await Promise.race([Promise.all(__waits), page.waitForTimeout(' + SETTLE_REQ_CAP_MS + ')]);',
    '      if (__reqs.length) await page.waitForTimeout(' + SETTLE_MS + ');',
    '    }',
    /* 取快照也要有上限：动作成功、随后页面弹出原生弹窗时，上游那条调用是被
     * _raceAgainstModalStates 包住的（弹窗一出现就立刻放弃），我们这里没有那层 ——
     * 只 try/catch 兜不住「一直挂着不返回」。所以自己跟一个超时赛跑，超时当作没取到。 */
    '    __snap = await Promise.race([',
    '      page.ariaSnapshot({ mode: \'ai\' }),',
    '      page.waitForTimeout(' + SNAPSHOT_CAP_MS + ').then(() => null),',
    '    ]);',
    '  } catch (__es) { __snap = null; }',
    '}',
  ];
}

function mergedActCode(token, command, ref, text) {
  const opts = '{ timeout: ' + ACTION_TIMEOUT_MS + ' }';
  const call = command === 'fill'
    ? 'await __loc.fill(' + jsLiteral(text) + ', ' + opts + ');'
    : 'await __loc.' + command + '(' + opts + ');';
  /* 动手前先确认自己在渲染（见 VISIBLE_FIRST_LINE 的说明）：后台标签页的 rAF 被节流，
   * 稳定判定（要两帧）永远不满足 —— 那正是 `waiting for element to be visible, enabled
   * and stable` 那条超时的来路。只在**确实被隐藏**时才把自己提到前台，用户正看着
   * 我们这一页时不抢焦点。 */
  return [
    'async page => {',
    guardLines(token),
    VISIBLE_FIRST_LINE,
    'const __loc = page.locator(\'aria-ref=' + ref + '\').first();',
    'let __err = null;',
    /* 请求监听必须在动作之前挂上：settle 要等的正是「这个动作自己引出来的请求」。
     * 摘监听放在整段最后（成功失败都过那里）—— 失败路径不 settle，但也不能把监听留在页面上。 */
    'const __reqs = [];',
    'const __onReq = (__r) => __reqs.push(__r);',
    'page.on(\'request\', __onReq);',
    'try { ' + call + ' } catch (__e) { __err = String((__e && __e.message) || __e); }',
  ].concat(settleAndSnapshotLines()).concat([
    'page.off(\'request\', __onReq);',
    'return { actError: __err, snapshot: __snap };',
    '}',
  ]).join('\n');
}

/* 截图 + 读位置合并成一条命令。
 * scale 必须是 'css'：CLI 的 screenshot 默认就是 CSS 像素档（--hires 才是设备像素），
 * 2026-09-28 实测两条路产出的 PNG **尺寸与字节数完全相同**（dpr=1.25 的机器上，
 * 不指定 scale 会得到 1295×889 的设备像素图，标注几何会整片偏 1.25 倍）。
 * ref 为空（goto / press / 终止帧这类没有目标元素的动作）时只截图。 */
function mergedShotCode(token, name, ref) {
  const lines = [
    'async page => {',
    guardLines(token),
    VISIBLE_FIRST_LINE,   /* 后台标签页的截图同样会卡在渲染上（老路的截图重试就是为它加的） */
    'const __r = { rectCsv: null, rectError: null };',
    'try { await page.screenshot({ path: ' + jsLiteral(name) + ', scale: \'css\' }); }'
      + ' catch (__e) { return { shotError: String((__e && __e.message) || __e) }; }',
  ];
  if (ref) {
    lines.push('try {');
    lines.push('  const __el = page.locator(\'aria-ref=' + ref + '\').first();');
    lines.push('  __r.rectCsv = await __el.evaluate(' + RECT_SNIPPET + ');');
    lines.push('} catch (__e) { __r.rectError = String((__e && __e.message) || __e); }');
  }
  lines.push('return __r;');
  lines.push('}');
  return lines.join('\n');
}

/* 合并命令的代码落哪个文件：每个会话一个（会话内顺序执行，写完即用，用完即覆盖）。 */
function codeFilePath(session) {
  const safe = String(session == null ? '' : session).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 's';
  return path.join(dataDir, 'auto-cli.code.' + safe + '.js');
}

/* run-code 的返回值被 CLI 又序列化了一次：字符串带引号、对象变成 JSON 字符串。 */
function codeValue(raw) {
  let v = raw;
  if (typeof v === 'string') {
    const t = v.trim();
    if (/^".*"$/.test(t)) { try { v = JSON.parse(t); } catch (_) { return null; } }
  }
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { return null; } }
  return v && typeof v === 'object' ? v : null;
}

/* 跑一条合并命令。返回：
 *   { ok:true, value }                        —— 命令跑通（value 是片段返回的对象）
 *   { ok:false, lostTab:true, error }         —— 归属不对，前端据此停手
 *   { ok:false, error }                       —— 其它失败，原样带回
 *   { fallback:true }                         —— 这条不该用快路径（退回老路，不算失败） */
async function execCode(session, code, opts) {
  const file = codeFilePath(session);
  try { quoteArg(file); } catch (_) { return { fallback: true }; }   // 路径进不了命令行（罕见字符）
  try {
    fs.writeFileSync(file, code, 'utf8');
  } catch (_) {
    return { fallback: true };                                       // 写不了文件就退回老路
  }
  const out = await exec(session, ['run-code', '--filename=' + file], opts);
  if (out.ok) return { ok: true, value: out.result };
  const err = String(out.error || '');
  if (err.indexOf(GUARD_LOST_MARK) >= 0) return { ok: false, lostTab: true, error: LOST_TAB_ERROR };
  /* 守卫跑不出来（弹窗态）或这个 CLI 版本不认 run-code：退回老路，由它去认弹窗态 */
  if (err.indexOf(GUARD_UNKNOWN_MARK) >= 0 || /unknown command|not supported|不允许的命令/i.test(err)) {
    return { fallback: true };
  }
  return { ok: false, error: out.error };
}

/* 这个会话能不能走快路径（CDP + 已打标记 + 标记形状安全）。其余模式没有守卫要合并，
 * 走老路零风险 —— 快路径只用来省 CDP 的守卫进程。 */
function fastPathToken(session) {
  const st = sessionState.get(session);
  if (!st || st.mode !== 'cdp' || !st.tabToken) return null;
  return TOKEN_SAFE_RE.test(String(st.tabToken)) ? String(st.tabToken) : null;
}

/* attach 失败是不是「http 形态在默认 profile 上必然 404」这条死路。
 * 必须与 403 分开：403 是「授权没点」，重试会把「允许远程调试」弹窗打掉（见 cdpAttachConfig）。 */function isHttpDiscoveryDead(raw) {
  const s = String(raw || '');
  if (/403|forbidden|connection rejected/i.test(s)) return false;
  return /does not look like a DevTools server|Unexpected status 404/i.test(s);
}

/* why：窗口类动作只对我们自己起的实例有意义。附身模式下改的是用户正在用的窗口与视口。 */
const CDP_WINDOW_REFUSAL = 'CDP 模式不改动你的浏览器窗口（resize / fullscreen / 最大化都只对我们自己起的实例生效）';

function cdpRefusal(session) {
  const st = sessionState.get(session);
  return st && st.mode === 'cdp' ? { ok: false, error: CDP_WINDOW_REFUSAL } : null;
}

/* ---------------- CDP 预检：默认 profile 里有没有 DevToolsActivePort ----------------
 * 失败率最高的一步是「浏览器压根没开调试端口」，UI 事先说清楚比事后翻译报错有用。
 * 只读文件，不启动任何东西。 */
function parseDevToolsPort(content) {
  const m = String(content == null ? '' : content).trim().match(/^(\d+)\b/);
  if (!m) return null;
  const p = Number(m[1]);
  return p >= 1 && p <= 65535 ? p : null;
}

function cdpUserDataDirs(platform, env) {
  const e = env || {};
  const list = [];
  /* 按**目标平台**选分隔符：这些路径可能指向非本机平台（测试断言、跨平台排查），
   * 用 path.join 会带上宿主平台的分隔符（Windows 上把 mac 路径拼成 \Users\x\...）。 */
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32') {
    const local = e.LOCALAPPDATA;
    if (!local) return [];
    list.push({ channel: 'chrome', file: p.join(local, 'Google', 'Chrome', 'User Data', 'DevToolsActivePort') });
    list.push({ channel: 'msedge', file: p.join(local, 'Microsoft', 'Edge', 'User Data', 'DevToolsActivePort') });
  } else if (platform === 'darwin') {
    if (!e.HOME) return [];
    list.push({ channel: 'chrome', file: p.join(e.HOME, 'Library', 'Application Support', 'Google', 'Chrome', 'DevToolsActivePort') });
    list.push({ channel: 'msedge', file: p.join(e.HOME, 'Library', 'Application Support', 'Microsoft Edge', 'DevToolsActivePort') });
  } else {
    if (!e.HOME) return [];
    list.push({ channel: 'chrome', file: p.join(e.HOME, '.config', 'google-chrome', 'DevToolsActivePort') });
    list.push({ channel: 'msedge', file: p.join(e.HOME, '.config', 'microsoft-edge', 'DevToolsActivePort') });
  }
  return list;
}

/* 内核名 → 它默认 user data dir 里的 DevToolsActivePort 路径（不认识的内核给 null） */
function channelPortFile(channel, platform, env) {
  const hit = cdpUserDataDirs(platform, env).find((d) => d.channel === channel);
  return hit ? hit.file : null;
}

/* 端口 → CDP 端点 **http 形态**。
 * 为什么不拼 ws://host:port/devtools/browser：那是「浏览器级 ws 端点去掉 UUID 路径」的样子，
 * Chrome 直接 404（实测本机 Chrome + 临时 profile + 调试端口）。而 http://host:port 由
 * Playwright 走 /json/version 自己发现真正的 webSocketDebuggerUrl，一次成功。
 * 用 127.0.0.1 而不是 localhost：Chrome 只绑 IPv4，Node 解析 localhost 可能先试 ::1，
 * 于是「探得到却连不上」。 */
function httpEndpointForPort(port) {
  const p = Number(port);
  if (!isFinite(p) || p < 1 || p > 65535) return null;
  return 'http://127.0.0.1:' + Math.floor(p);
}

/* 反过来：http(s) 形态端点里那个端口号（不是 http 形态就给 null）。
 * 用途见 resolveHttpTarget —— http 形态在**默认 profile** 上必然 404（/json 发现被关了），
 * 而端口文件里就躺着那条能用的 ws 路径。 */
function httpTargetPort(target) {
  const m = /^https?:\/\/([^/?#]+)/i.exec(String(target == null ? '' : target).trim());
  if (!m) return null;
  const hostPort = m[1];
  const pm = /:(\d+)$/.exec(hostPort);
  if (!pm) return null;                       /* 没写端口 = 80/443，不是调试端口 */
  const p = Number(pm[1]);
  return (isFinite(p) && p >= 1 && p <= 65535) ? p : null;
}

/* http 端点 → 端口文件里那条 ws 端点（对不上就 null，原样放行）。
 * 为什么只在**本机地址**上换：端口文件描述的必定是本地浏览器，拿它去替换一个远程地址
 * 等于把用户的意图劫持到本机。为什么对不上就放行：非默认 profile（如测试用的临时
 * user-data-dir）上 /json 发现是好的，http 形态照样能用 —— 不能一刀切禁掉。 */
function resolveHttpTarget(target, dirs) {
  const port = httpTargetPort(target);
  if (port == null) return null;
  const m = /^https?:\/\/([^/?#]+)/i.exec(String(target).trim());
  const host = m[1].replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host)) return null;
  const list = Array.isArray(dirs) ? dirs : cdpUserDataDirs(process.platform, process.env);
  for (let i = 0; i < list.length; i++) {
    let info = null;
    try { info = parseDevToolsActivePort(fs.readFileSync(list[i].file, 'utf8')); } catch (_) { info = null; }
    if (!info || info.port !== port) continue;
    const ws = wsEndpointForPortPath(info.port, info.wsPath);
    if (ws) return ws;
  }
  return null;
}

/* ---------------- CDP 预检：端口文件 + 真探一次端点 ----------------
 * 失败率最高的一步是「浏览器压根没开调试端口」，UI 事先说清楚比事后翻译报错有用。
 * 但**不能只看端口文件**：它是磁盘残留物 —— 浏览器异常退出会留下陈旧端口，Chrome 136+
 * 在默认 profile 上还会绑着端口却拒绝 DevTools 请求（本机实测：9222 在监听、文件也写着
 * 9222，端口还归一个**没有任何调试参数、桌面双击起来的** chrome.exe，/json/version 回 404、
 * ws 握手挂死）。所以照 Playwright 的做法真探一次，探得通才算数。
 *
 * 两种端点形态都要试，按可靠性排序：
 *   ① ws://127.0.0.1:<port>/devtools/browser/<uuid>  —— 端口文件第二行给的，**权威**。
 *      chrome://inspect 手动允许的那种 Chrome 只讲 ws，HTTP 发现路径一律 404
 *      （Playwright 的报错原文就是 "This does not look like a DevTools server, try ws://"）。
 *      `--remote-debugging-port=9222` 启动的那种两者都讲，ws 也通。
 *   ② http://127.0.0.1:<port>  —— 由 Playwright 走 /json/version 自行发现，作兜底。
 * 注意①必须是**带 UUID 的完整路径**：少一段的 ws://host:port/devtools/browser 会被 404。 */
const CDP_PROBE_TIMEOUT_MS = 700;

function cdpProbeHint() {
  return '要复用你已登录的浏览器：先在那个浏览器里访问 chrome://inspect/#remote-debugging 勾选「Allow remote debugging for this browser instance」'
    + '（**别**给它加 --remote-debugging-port 启动：Chrome 136+ 在默认 profile 上会忽略这个参数），'
    + '之后**每次运行**它还会弹一次「Allow remote debugging?」的确认框 —— 点允许（没弹的话，把那个勾选框取消再重新勾上）。'
    + '端点框**留空**即可自动探测（推荐）；手填只认 ws://127.0.0.1:<端口>/devtools/browser/<uuid> 这种形态 —— '
    + '它就是浏览器 profile 目录里 DevToolsActivePort 这个文件的第二行，http 形态在默认 profile 上必定 404。';
}

/* Chrome 144+ 对每次浏览器运行都要一次「允许远程调试」授权：勾选框只是开关，弹窗才是本次的许可。
 * 连上它的唯一前提是——**那条挂着的连接要一直在**，弹窗才留在屏幕上等人点。
 * 所以 cdpTimeout 必须为 0（Playwright 文档：Pass 0 to disable timeout），
 * 而且失败后**不能自动重试**：重试会立刻造出新弹窗，把一次授权变成无限弹窗。 */
function cdpAttachConfig() {
  return { browser: { cdpTimeout: 0 } };
}

/* 端口文件第二行的 ws 路径形态。拼错就是 404，所以读进来与拼端点时都按它校验 ——
 * 同一条正则只能有一处定义（早先 parseDevToolsActivePort 与 wsEndpointForPortPath 各写一遍）。 */
const WS_BROWSER_PATH_RE = /^\/devtools\/browser\/[A-Za-z0-9._-]+$/;

/* 端口文件两行：端口 + ws 路径（/devtools/browser/<uuid>） */
function parseDevToolsActivePort(content) {
  const lines = String(content == null ? '' : content).split(/\r?\n/);
  const port = parseDevToolsPort(lines[0]);
  if (!port) return null;
  const wsPath = String(lines[1] || '').trim();
  return { port: port, wsPath: WS_BROWSER_PATH_RE.test(wsPath) ? wsPath : null };
}

function wsEndpointForPortPath(port, wsPath) {
  const p = Number(port);
  if (!isFinite(p) || p < 1 || p > 65535) return null;
  const w = String(wsPath == null ? '' : wsPath).trim();
  /* 只认 DevTools 那一种形态；其它（含空）一律当没读到 —— 拼错就是 404 */
  if (!WS_BROWSER_PATH_RE.test(w)) return null;
  return 'ws://127.0.0.1:' + Math.floor(p) + w;
}

/* 端口探活：**只做 TCP 连接，绝不做 ws 握手**。
 * 为什么不能用握手探活：Chrome 144+ 的「Allow remote debugging?」弹窗由那条挂着的连接维持，
 * 探一下就断开等于把用户正要点的弹窗打掉（browser-harness 的注释：重试会立刻造出新弹窗，
 * 把一次授权变成无限弹窗）。TCP 连一下是惰性的：Chrome 收下 socket 但不会因此触发授权。 */
function probeTcp(port) {
  return new Promise((resolve) => {
    const p = Number(port);
    if (!isFinite(p) || p < 1 || p > 65535) return resolve({ ok: false, reason: 'unreachable' });
    const sock = net.connect({ host: '127.0.0.1', port: Math.floor(p) });
    let done = false;
    const finish = (r) => { if (done) return; done = true; try { sock.destroy(); } catch (_) { /* noop */ } resolve(r); };
    sock.setTimeout(CDP_PROBE_TIMEOUT_MS);
    sock.on('connect', () => finish({ ok: true }));
    sock.on('timeout', () => finish({ ok: false, reason: 'unreachable' }));
    sock.on('error', () => finish({ ok: false, reason: 'unreachable' }));
  });
}

/* 一个内核名的候选端点，按可靠性排序：ws（端口文件第二行）→ http 发现。
 * 一并回传解析出的 info：调用方（cdpProbe）还要用 info.port 探活，
 * 早先它自己又 readFileSync + parse 了一遍同一个文件。 */
function cdpCandidates(file) {
  let info = null;
  try { info = parseDevToolsActivePort(fs.readFileSync(file, 'utf8')); } catch (_) { info = null; }
  if (!info) return null;
  const list = [];
  const ws = wsEndpointForPortPath(info.port, info.wsPath);
  if (ws) list.push(ws);                 /* 权威形态：带 UUID，Chrome 147+ 只剩它能用 */
  const httpEnd = httpEndpointForPort(info.port);
  if (httpEnd) list.push(httpEnd);
  return list.length ? { info: info, list: list } : null;
}

/* cdpProbe 的 reason 取值域**只有这两个**（外加 server 侧的 no-driver / error，
 * 见 server.js 的 cdp-probe 分支）：
 *   no-port-file —— 连端口文件都没有
 *   unreachable  —— 有端口文件，但那个端口没人监听
 * 前端据此分派文案。这里曾经列过一个 permission-blocked（「端口在监听但浏览器拒绝
 * DevTools」），但**没有任何路径能产出它**：探活只做一次 TCP connect（probeTcp 的注释
 * 讲了为什么不能做握手 —— 会打掉用户正要点的授权弹窗），而「拒绝 DevTools」只有真连一次
 * 才知道。那种情况由 attach 阶段负责翻译：humanCdpAttachError 的 403 / 404 两条。
 *
 * dirs 可注入（默认本机候选）——测试用它喂临时端口文件，不必碰真实浏览器。 */
async function cdpProbe(dirs) {
  const list = Array.isArray(dirs) ? dirs : cdpUserDataDirs(process.platform, process.env);
  let sawPortFile = false;
  for (let i = 0; i < list.length; i++) {
    const cand = cdpCandidates(list[i].file);
    if (!cand) continue;
    sawPortFile = true;
    const probe = await probeTcp(cand.info.port);
    if (probe.ok) {
      return { available: true, reason: null, channel: list[i].channel, endpoint: cand.list[0], hint: cdpProbeHint() };
    }
  }
  return {
    available: false,
    reason: sawPortFile ? 'unreachable' : 'no-port-file',
    channel: null, endpoint: null, hint: cdpProbeHint(),
  };
}

/* 自动探测（内核名）失败时的人话：各自指到对症的下一步。
 * 关键是不再去 attach —— 对着没有端口的浏览器 attach 只会白等超时。
 * 分支与 cdpProbe 的 reason 取值域一一对应（只有这两条，见 cdpProbe 的注释）：
 * 「授权没点」不在这里，它归 humanCdpAttachError 的 403 分支。 */
function humanCdpProbeError(channel, probe) {
  const why = (probe && probe.reason) || 'unreachable';
  if (why === 'no-port-file') {
    return '没探到 ' + channel + ' 开着调试端口。' + cdpProbeHint();
  }
  return '探到 ' + channel + ' 的调试端口但连不上（那个浏览器多半已经关了，留下的是陈旧的端口文件）。' + cdpProbeHint();
}

/* attach 失败的翻译：403 就是「授权没点」；404/「不是 DevTools 服务器」是 http 形态的
 * 死路（与授权无关，别再教人去点允许）。 */
function humanCdpAttachError(raw) {
  const s = String(raw || '');
  if (/403|forbidden|connection rejected/i.test(s)) {
    return '浏览器拒绝了这次调试连接 —— 它在等你点「允许远程调试」（弹框写着 Allow remote debugging?）。'
      + '请在**那个**浏览器窗口上点允许；如果没看到弹框，去 chrome://inspect/#remote-debugging 把'
      + '「Allow remote debugging for this browser instance」取消再重新勾上，然后再点开始（别反复重试：重试会把弹框打掉）。';
  }
  if (/does not look like a DevTools server|Unexpected status 404/i.test(s)) {
    return '连不上那个浏览器（CDP）：端点用的是 http 形态，而它回的是 404 —— '
      + 'Chrome 147+ 在**默认 profile** 上关掉了 /json 发现（所以 http 形态必定 404，这不代表端口没开）。'
      + '把「CDP 端点」**留空**让它自动探测，或填 `DevToolsActivePort` 第二行那条：'
      + 'ws://127.0.0.1:<端口>/devtools/browser/<uuid>（这个文件在浏览器 profile 目录里，'
      + 'Chrome 是 %LOCALAPPDATA%\\Google\\Chrome\\User Data\\DevToolsActivePort）。';
  }
  return '连不上那个浏览器（CDP）：' + s.slice(0, 240) + ' ' + cdpProbeHint();
}

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
    if (shape.url && !HTTP_URL_RE.test(t)) throw new Error('命令 ' + command + ' 的文本必须是 http:// 或 https:// 开头的 URL');
    if (shape.int && !/^\d+$/.test(t)) throw new Error('命令 ' + command + ' 的文本必须是非负整数（标签页序号）');
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
  if (v.ref != null) return [v.op, v.ref];                             // click/check/hover/...
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
    /* stdin 明确给 'ignore'：默认三路都是 pipe，而 CLI 从不读 stdin —— 子进程先退出、
     * 父进程那端还挂着管道时，Windows 上会撞 libuv 的
     * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c`，
     * 表现为**只有 server 进程内**调 CLI 恒失败（实测 health 一直报引擎不可用，
     * 而 standalone 跑同一个探测是好的），于是 UI 误判「引擎未安装」。 */
    const STDIO = ['ignore', 'pipe', 'pipe'];
    try {
      if (IS_WIN) {
        // npm 全局命令是 .cmd：Node 安全策略要求 shell:true，引号自行拼装
        const line = ['playwright-cli'].concat(argv.map(quoteArg)).join(' ');
        child = spawn(line, { shell: true, env: cliEnv(), cwd: dataDir, windowsHide: true, stdio: STDIO });
      } else {
        child = spawn('playwright-cli', argv, { env: cliEnv(), cwd: dataDir, windowsHide: true, stdio: STDIO });
      }
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: String(e && e.message || e), timedOut: false });
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    /* 批量命令默认 30s；CDP attach 必须放宽（见 CDP_ATTACH_TIMEOUT_MS 的说明） */
    const timeoutMs = (opts && opts.timeoutMs) || CMD_TIMEOUT_MS;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);

    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + String(e && e.message || e), timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code == null ? -1 : code, stdout, stderr, timedOut }); });
  });
}

/* --json 的输出形状不统一：多数命令是 {result: "..."}，失败是 {isError, error}，
 * snapshot 在 v0.1.17 直接输出 {snapshot: "YAML 文本"}，0.1.18+ 变成
 * {snapshot: […无障碍树…]}（转写见上）。click/open 返回的 {snapshot:{file}}
 * 是工件路径不是树，不在此列。这里把对象形结果解包成文本：优先
 * snapshot（字符串原样 / 数组转写）→ result → text 字段。 */
function unwrapResult(r) {
  if (typeof r === 'string') return r;
  if (r && typeof r === 'object') {
    if (typeof r.snapshot === 'string') return r.snapshot;
    if (Array.isArray(r.snapshot)) return treeToSnapshotYaml(r.snapshot);
    if (typeof r.result === 'string') return r.result;
    if (typeof r.text === 'string') return r.text;
    if (!Object.keys(r).length) return '';
    return JSON.stringify(r, null, 2);
  }
  return r == null ? '' : String(r);
}

/* ---------------- 0.1.18+ 结构化快照 → YAML 文本转写 ----------------
 * @playwright/cli 0.1.18 起 snapshot --json 的输出从 {snapshot:"YAML 字符串"}
 * 变成 {snapshot:[…无障碍树…]}（node 键：role/name/text/ref/children/cursor/
 * level/active/selected/disabled…，输入框的值也走 text）。下游全部吃 YAML 行
 * 格式（util.parseSnapshotRefs、auto-core state 组装、冒烟断言），这里按 0.1.17
 * 对同一页面的实测行格式逐行转写回去：
 *   <2×depth 空格>- role "name" [level=N] [flag…] [ref=eN] [cursor=pointer][: text]
 * 有 children 的行以裸 ":" 结尾（text 与 children 并存时 YAML 无法同时表达，
 * children 优先 —— 实测简历页 404 节点中 0 个并存）。name 用 JSON.stringify
 * 加引号、text 折叠空白；不做 YAML 标量转义 —— 消费方是自家解析器与 Jev
 * 提示词，不是 YAML 解析器（0.1.17 的单引号包裹反而会污染首词 role 提取）。 */
const TREE_FLAG_KEYS = ['active', 'checked', 'disabled', 'expanded', 'selected'];   // 布尔标记，固定顺序输出保证确定性

function renderTreeNode(node, depth, lines) {
  if (!node || typeof node !== 'object') return;
  let line = '- ' + String(node.role || 'generic');
  if (node.name != null) line += ' ' + JSON.stringify(String(node.name));
  if (node.level != null) line += ' [level=' + node.level + ']';
  TREE_FLAG_KEYS.forEach((k) => { if (node[k] === true) line += ' [' + k + ']'; });
  if (node.ref != null) line += ' [ref=' + node.ref + ']';
  if (node.cursor != null) line += ' [cursor=' + node.cursor + ']';
  const kids = Array.isArray(node.children) ? node.children : null;
  if (kids && kids.length) {
    lines.push('  '.repeat(depth) + line + ':');
    kids.forEach((c) => renderTreeNode(c, depth + 1, lines));
  } else {
    const text = node.text != null ? String(node.text).replace(/\s+/g, ' ').trim() : '';
    lines.push('  '.repeat(depth) + line + (text ? ': ' + text : ''));
  }
}

function treeToSnapshotYaml(tree) {
  if (!Array.isArray(tree) || !tree.length) return '';
  const lines = [];
  tree.forEach((n) => renderTreeNode(n, 0, lines));
  return lines.join('\n');
}

/* Playwright 把 actionability 失败的根因写在日志行的**行尾**
 * （「… intercepts pointer events」/「… subtree intercepts pointer events」），
 * 它前面是可能几百字符长的元素标签。一刀切 slice(0,500) 会把这段行尾连根因一起切掉，
 * 上游只剩「Timeout 5000ms exceeded」可推理 —— 实测会话 r-0926-0046-qrys
 * 因此连续 3 步重复点同一个被登录弹窗遮挡的元素，直到「连续 3 步失败」终止。
 * 所以：保留首行 + 根因行，长行折叠中段（行尾的根因短语必须活下来）。 */
const ROOT_CAUSE_RE = /intercepts pointer events|subtree intercepts|not visible|not stable|outside of the viewport|element is not (enabled|attached|visible)|403 Forbidden|Connection rejected|not look like a DevTools server|Allow remote debugging/;

function clipMiddle(line, max) {
  const s = String(line);
  if (s.length <= max) return s;
  const tail = Math.floor(max / 2);
  return s.slice(0, max - tail - 1) + '…' + s.slice(-tail);
}

function summarizeError(raw) {
  const s = String(raw == null ? '' : raw).replace(/\u001b\[[0-9;]*m/g, '');
  const lines = s.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return '';
  const picked = [clipMiddle(lines[0], 120)];
  const key = lines.find((l) => ROOT_CAUSE_RE.test(l));
  if (key) {
    if (key !== lines[0]) picked.push(clipMiddle(key, 300));
  } else if (lines.length > 1) {
    picked.push(clipMiddle(lines[lines.length - 1], 200));   // 没有根因行：留一行尾部上下文
  }
  return picked.join(' | ');
}

/* --json 包裹解析：成功 {result} / 失败 {isError,error}。
 * 实测 playwright-cli 失败时退出码仍是 0 且输出 "### Error"，退出码不可靠，
 * 必须以 JSON 包裹为准；非 JSON 输出按「code!=0 或有 stderr 则失败」兜底。 */
function parseEnvelope(out) {
  const text = String(out.stdout || '').trim();
  if (!text) {
    if (out.code !== 0 || String(out.stderr || '').trim()) {
      return { ok: false, error: summarizeError(out.stderr) || ('进程异常退出 code=' + out.code) };
    }
    return { ok: true, result: '' };
  }
  try {
    const j = JSON.parse(text);
    /* 工件路径在成功与失败两个分支上都要带出去：**失败的动作同样会写工件**
     * （CLI 的响应里 Error 段与 Snapshot 段并不互斥），只报成功的那个分支等于
     * 让失败动作的文件永远没人删。读不读由调用方决定。 */
    const rel = j && typeof j === 'object' ? snapshotArtifactRel(j) : null;
    if (j && j.isError) {
      const out = { ok: false, error: summarizeError(j.error) || 'playwright-cli 执行出错' };
      if (rel) out.artifact = rel;
      return out;
    }
    if (j && typeof j === 'object') {
      const out = { ok: true, result: unwrapResult(j) };   // 覆盖 {result} 与 {snapshot} 两种形状
      if (rel) out.artifact = rel;
      return out;
    }
    return { ok: true, result: text };
  } catch (_) {
    if (out.code !== 0 || String(out.stderr || '').trim()) {
      return { ok: false, error: summarizeError(String(out.stderr || '').trim() || text) };
    }
    return { ok: true, result: text };
  }
}

async function exec(session, args, opts) {
  const out = await run(session, args, opts);
  if (out.timedOut) {
    const secs = Math.round(((opts && opts.timeoutMs) || CMD_TIMEOUT_MS) / 1000);
    return { ok: false, error: '命令超时（' + secs + 's）被终止：' + String(args[0]) };
  }
  return parseEnvelope(out);
}

/* ---------------- 动作之后的快照工件 ----------------
 * playwright-cli 的部分动作会在结果里附一份「动作之后」的无障碍快照：
 *   click  → {snapshot:{file:'.playwright-cli\\page-<ISO>.yml'}}
 *   open   → {result:{snapshot:{file:…}}}（同一个东西，嵌了一层）
 * 2026-09-29 实测（v0.1.17，text 与 --json 两种输出都看过）：**只有可能改变页面结构的
 * 动作才有** —— click / hover / select / uncheck / goto / reload / go-back / go-forward /
 * upload / tab-new(带 url) / press(仅 Enter) 有；fill / check / 非 Enter 的 press /
 * tab-list 没有（返回 {}）。源码里就是这么写的：browser_type 只在 pressSequentially 分支
 * 调 setIncludeSnapshot()，browser_press_key 只在 key === 'Enter' 时调。
 * 所以调用方**必须**能接受「这次没有」，退回真取一次快照。 */
function snapshotArtifactRel(j) {
  const cands = [j && j.snapshot, j && j.result && j.result.snapshot];
  for (const c of cands) {
    if (c && typeof c === 'object' && !Array.isArray(c) && typeof c.file === 'string' && c.file) return c.file;
  }
  return null;
}

/* 工件路径 → data/ 沙箱内的绝对路径；出格或不成立一律 null。
 * 路径是 CLI 给的（相对 dataDir 的 cwd），照 uploadPathAllowed 的规矩关进 data/。 */
function artifactAbsPath(rel) {
  const t = String(rel == null ? '' : rel).trim();
  if (!t) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return null;   // file:// 之类一律不当路径用
  const root = path.resolve(dataDir);
  const abs = path.resolve(root, t);
  return abs.startsWith(root + path.sep) ? abs : null;
}

/* 读回工件文本；任何一步不成立就返回 null —— 调用方退回真取一次快照，
 * 绝不拿「半截文本」或「空字符串」当下一步的页面依据。
 * 读完即删：每个动作一个文件，不删会无限堆积。 */
function readArtifactSnapshot(rel) {
  const abs = artifactAbsPath(rel);
  if (!abs) return null;
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch (_) { return null; }
  try { fs.unlinkSync(abs); } catch (_) { /* 删不掉不影响这一次的使用 */ }
  return normalizeArtifactText(text);
}

/* 不要这份工件，但**必须把它删掉**：CLI 每次动作都可能写一个文件（失败的动作也写），
 * 不删就是每步一个 yml 永远留在 data/.playwright-cli 里（实测该目录已 3550 个文件 / 68MB）。
 * 读不读由调用方决定，收尾一律走这里。 */
function discardArtifact(rel) {
  const abs = artifactAbsPath(rel);
  if (!abs) return false;
  try { fs.unlinkSync(abs); return true; } catch (_) { return false; }
}

/* 0.1.18+ 的工件可能是结构化树（JSON）而不是 YAML 文本 —— 用已有的转写器统一成 YAML 行，
 * 认不出的形状一律 null（退回真取）。0.1.17 的工件是文本，直接原样返回。 */
function normalizeArtifactText(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  if (text[0] !== '[' && text[0] !== '{') return text;
  try {
    const j = JSON.parse(text);
    if (Array.isArray(j)) return treeToSnapshotYaml(j).trim() || null;
  } catch (_) { /* 不是 JSON：按文本处理 */ }
  return null;
}

/* 哪些动作自带的快照可以当「下一步的页面依据」用。
 * 判据是**动作自身的完成条件有没有包住页面更新**，不是「有没有工件」：
 *   · click / upload / press —— 上游 setIncludeSnapshot() + await waitForCompletion()
 *     （动作后固定 500ms + 等动作期间发出的请求），页面已稳。
 *   · goto / reload —— Playwright 的导航 API 默认等 'load'。
 *   · tab-new / tab-select / tab-close —— 切过去的那一页本来就是加载好的。
 * 不带的三个（工件照样有，读完即弃，下一步真取一次）：
 *   · hover / select / uncheck —— 上游**不等稳定**（动作返回即拍）；select 触发的 fetch
 *     通常还没回来，拿这种「半路」快照顶替下一步依据，等于让模型看着上一页做决策。
 *   · go-back / go-forward —— 上游显式写的是 `waitUntil: 'commit'`（实测源码：goBack/goForward
 *     都是 { waitUntil: 'commit', ... }），只等导航提交，页面内容几乎还没到。
 * 丢掉快照的代价只是那几步没省下进程，与改动前完全一致。
 * （CDP 快路径不受这张表约束：那条命令里的等稳定是我们自己做的。） */
const SNAPSHOT_TRUSTED_ACTIONS = {
  click: 1, upload: 1, press: 1, goto: 1, reload: 1,
  'tab-new': 1, 'tab-select': 1, 'tab-close': 1,
};

/* 一份「能当下一步页面依据用」的快照：**是字符串**、非空、且带 ref。
 * 为什么必须有 ref：下游（refCriteria / paramCriteria / 召回 / 标注 / checkSelectOption）
 * 全部按 ref 行解析，没有 ref 的文本喂进去等于空页面 —— 会静默变成「页面上没有可操作元素」。
 * 为什么必须是字符串：数组/对象到这里只可能是形状不对（String([…]) 会把元素拼成一串，
 * 看起来「像」快照），一律当没拿到。
 * 这条同时保住了原生弹窗那条路：弹窗期间取不到快照（工件为空 / ariaSnapshot 抛错），
 * 于是这里返回 null、下一步真取一次，由 snapshot 接口照旧报出 modal state 错误。 */
function usableSnapshot(text) {
  if (typeof text !== 'string') return null;
  return text.indexOf('[ref=') >= 0 ? text : null;
}

/* ---------------- 对外接口 ---------------- */

let versionCache = { at: 0, value: null };

async function status() {
  const now = Date.now();
  if (versionCache.value && now - versionCache.at < VERSION_CACHE_MS) return versionCache.value;

  const out = await run(null, ['--version'], { json: false });
  let cli;
  if (out.code === 0 && out.stdout.trim()) {
    cli = { available: true, version: out.stdout.trim().split(/\r?\n/)[0] };
  } else {
    const all = (out.stderr + '\n' + out.stdout);
    const notInstalled = /not recognized|not found|enoent|commandnotfound/i.test(all);
    cli = {
      available: false,
      reason: notInstalled ? 'not-installed' : 'error',
      error: notInstalled ? 'playwright-cli 未安装：请执行 npm i -g @playwright/cli' : all.trim().slice(0, 300) || '未知错误',
    };
  }

  /* 进程内后端：这里只问「playwright-core 能不能加载」（真正的能力探测需要一个活页面，
   * 放在 open 时做，见 browser-inproc.js 的 probeCapability）。
   * **available 取两条后端的或**：装了 playwright-core、没装 playwright-cli 的机器
   * 照样能驱动浏览器，按 CLI 单独报会让前端把「引擎未安装」显示成红的。
   * version 优先报 CLI 的（既有 pill 文案不变），CLI 缺席时报进程内那份。 */
  const inst = inprocBackend();
  const ip = inst ? inst.available() : { ok: false, version: null, error: '进程内后端模块加载失败' };
  const inprocSt = ip.ok
    ? { available: true, version: ip.version }
    : { available: false, reason: 'not-installed', error: ip.error };
  const preferred = resolveBackend(null);
  const value = {
    available: cli.available || inprocSt.available,
    version: cli.version || inprocSt.version,
    reason: cli.available ? undefined : cli.reason,
    error: cli.available ? undefined : cli.error,
    /* 这一轮实际会走哪条：选了 inproc 但它不可用就落到 cli，反之亦然 */
    backend: preferred === 'inproc' ? (inprocSt.available ? 'inproc' : 'cli') : 'cli',
    backends: { cli: cli, inproc: inprocSt },
  };
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

/* 持久 profile 被占用：上一次的窗口还开着（Chrome 的进程单例锁），换个人话 */
function humanProfileError(raw) {
  const s = String(raw || '');
  if (/already in use|SingletonLock|ProcessSingleton|另一位|另一个/i.test(s)) {
    return '这个持久 profile 已被占用（多半是上次的浏览器窗口还开着）：先关掉它，或点「关闭浏览器」再重试。原始错误：' + s.slice(0, 200);
  }
  return null;
}

/* 建立我们自己的专用标签页：列基线 → 新建 → 打标记，三步全过才写 sessionState。
 * 这是「绝不碰你自己标签页」的守卫，**只能有一份实现** —— 新 attach 与复用已有连接
 * 两条路都走这里（此前各写一遍，收紧守卫时只改一处就会漏掉另一处）。
 *
 * 失败只回报 stage，**收场策略留给调用方**：两条路有意不同，不能统一 ——
 *   新 attach 失败 → 拆掉刚建的 daemon，不然留个半开状态；
 *   复用失败      → **不能拆**。Chrome 144+ 的授权是按连接给的，拆了用户得回浏览器
 *                   再点一次「允许远程调试」；连接还活着，原地重试更划算。
 * 返回 { ok:true } 或 { ok:false, stage:'tab-new'|'mark', error? }。 */
async function startOwnTab(session, plan) {
  /* 此刻列出来的都是**用户的**标签页（我们自己的那个还没建 / 刚关掉），
   * 记下来当 tab-select 的禁选基线 */
  const pre = await exec(session, ['tab-list']);
  const preExisting = pre.ok ? parseTabs(pre.result).map((t) => t.url) : [];

  const tab = await exec(session, plan.commands[1]);   // ['tab-new', url]
  /* tab-new 也会写一份工件，而这一步不消费它（第 1 步的快照永远是**真取**的：
   * 人工登录门在上面，门后那一页才是模型的第一次输入）。不删就每个会话留一个。 */
  discardArtifact(tab.artifact);
  if (!tab.ok) return { ok: false, stage: 'tab-new', error: tab.error };

  const token = newTabToken(session);
  const marked = await exec(session, ['eval', tabMarkSnippet(token)]);
  if (!marked.ok || !tabGuardOk(token, marked.result)) return { ok: false, stage: 'mark' };

  sessionState.set(session, { mode: 'cdp', tabToken: token, preExisting: preExisting });
  return { ok: true };
}

/* CDP 复用：会话已经附身且 daemon 还活着时，**绝不再 attach 一次**。
 * Chrome 144+ 的「允许远程调试」授权是**按连接**给的 —— 再连一次就要用户再点一次，
 * 而用户点的那一下必须正好落在"这条挂着的连接"上。所以一条连接用到死：
 * 复用同一条连接，只换标签页。 */
async function reuseCdpTab(session, plan) {
  const st = sessionState.get(session);
  /* 上一次 run 留下的专用标签页若还在（标记还是我们的），先关掉它 ——
   * 否则每跑一轮就多留一个标签页。读标记是只读的，即便当前页是用户的也安全。 */
  const cur = await exec(session, ['eval', TAB_READ_SNIPPET]);
  if (cur.ok && tabGuardOk(st.tabToken, cur.result)) {
    const closed = await exec(session, ['tab-close']);
    discardArtifact(closed.artifact);   // tab-close 同样可能留一份没人消费的工件
  }

  const t = await startOwnTab(session, plan);
  if (!t.ok) {
    /* 失败**不拆连接**（见 startOwnTab 的注释）：授权按连接给，拆了用户得再点一次允许。 */
    return {
      ok: false,
      error: t.stage === 'tab-new'
        ? '复用已有 CDP 连接时新建标签页失败：' + t.error
        : '复用已有 CDP 连接时没能标记专用标签页，已停手（不碰你的标签页）',
    };
  }
  return { ok: true, browser: plan.browser, mode: 'cdp', attached: true, reused: true, maximized: false, native: false };
}

/* CDP：attach → 新建专用标签页 → 打标记。三步全过才认这个会话，
 * 任一步失败就断开（不留半开的 daemon，也不写 sessionState）。
 *
 * attach 用**放宽的超时**且**不重试**：Chrome 144+ 会弹「Allow remote debugging?」，
 * 而弹窗只由这条挂着的连接维持 —— 超时被强杀或自动重试都会把它打掉，用户就没得点了。
 * 3 分钟是给用户留的点击窗口（browser-harness 那边干脆不设超时；我们有 UI，得最终收场）。 */
/* 等待用户在浏览器里点「允许远程调试」的窗口。默认 3 分钟；验收/调试可用
 * JEVDEMO_CDP_ATTACH_MS 放宽（用户得先注意到那个弹框再点，窗口太短会白等）。 */
const CDP_ATTACH_TIMEOUT_MS = Number(process.env.JEVDEMO_CDP_ATTACH_MS) > 0
  ? Number(process.env.JEVDEMO_CDP_ATTACH_MS)
  : 180000;

async function openCdp(session, plan, extraArgs, fallbackPlan) {
  const attachArgs = plan.commands[0].concat(extraArgs || []);
  let attach = await exec(session, attachArgs, { timeoutMs: CDP_ATTACH_TIMEOUT_MS });
  discardArtifact(attach.artifact);   // attach 也可能带一份没人消费的工件
  /* 手填的 http 形态在默认 profile 上必然 404（Chrome 147+ 关了 /json 发现）：这条不是
   * 授权问题，回退到端口文件里那条 ws 再试一次。**只在 404 这条死路上回退** —— 403 是
   * 「授权没点」，重试会把那条维持弹窗的连接打掉（见 cdpAttachConfig 的注释）。
   * 顺序是「用户填的优先」：他能连上就按他的来，不静默改掉他给的端点。 */
  let swappedFrom = null;
  if (!attach.ok && fallbackPlan && isHttpDiscoveryDead(attach.error)) {
    const retry = await exec(session, fallbackPlan.commands[0].concat(extraArgs || []), { timeoutMs: CDP_ATTACH_TIMEOUT_MS });
    discardArtifact(retry.artifact);
    if (retry.ok) { swappedFrom = plan.target; plan = fallbackPlan; attach = retry; }
  }
  if (!attach.ok) return { ok: false, error: humanCdpAttachError(attach.error) };

  /* 我们自己的标签页还没建：此刻列出来的都是**用户的**，记下来当 tab-select 的禁选基线 */
  const t = await startOwnTab(session, plan);
  if (!t.ok) {
    await exec(session, ['close']);   /* 新 attach 出来的 daemon 不留半开（见 startOwnTab 的注释） */
    return {
      ok: false,
      error: t.stage === 'tab-new'
        ? '已连上浏览器，但新建专用标签页失败（为免动到你已开的标签页，已断开）：' + t.error
        : '连上了浏览器，但没能标记专用标签页 —— 无法保证只操作我们自己的标签页，已断开',
    };
  }
  return {
    ok: true, browser: plan.browser, mode: 'cdp', attached: true, target: plan.target,
    maximized: false, native: false, swappedFrom: swappedFrom,
  };
}

/* open 的**后端分发**：先按选择试进程内，起不来就自动退回 CLI 并把原因带回前端。
 * 退回不是静默降级 —— 返回值里带 backendFallback（人话原因），前端会 toast 一次，
 * 免得用户以为跑的是快的那条。 */

/* 给 open 的返回值补上「这一轮实际走了哪条后端」。**成功才贴**（失败时这条信息没意义）。
 * 纯 CLI 那一支以前不贴：前端 `opened.backend || runCfg.backend` 的回退值恰好等于真值
 * （请求的就是 cli），所以看不出来 —— 但那让「backend 是本次调用的结果说明」这条契约
 * 只在回退分支上成立，pin 到 CLI 的测试没法据此断言自己真的跑在 CLI 上。 */
function withBackend(result, name) {
  if (result && result.ok && result.backend == null) result.backend = name;
  return result;
}

async function open(session, url, opts) {
  const o = opts || {};
  const want = resolveBackend(o);
  if (want !== 'inproc') return withBackend(await openViaCli(session, url, o), 'cli');

  const inst = inprocBackend();
  if (!inst) {
    const r = await openViaCli(session, url, o);
    if (r && r.ok) {
      r.backend = 'cli';
      r.backendFallback = '进程内后端不可用（无法加载 playwright-core）：已改用 playwright-cli' + INPROC_HINT;
    }
    return r;
  }
  const r = await inst.open(session, url, o);
  if (r && r.ok) {
    /* sessionState 只记模式这一件事：**不在这里记后端** —— 归属由 useInproc 现问进程内
     * 后端的会话表（见它的注释），另存一份迟早与真身不同步（这条曾在误判时把 close 送错后端）。
     * 返回给前端的那份 backend 是**本次调用的结果说明**，不落进状态里。 */
    sessionState.set(session, { mode: r.mode });
    return Object.assign({}, r, { backend: 'inproc' });
  }
  /* 进程内起不来：回退 CLI。**别把 inproc 的失败原样抛回去** —— 用户要的是「跑起来」，
   * 不是一条他无从下手的报错。原始原因一并带回去，好排查。 */
  const cli = await openViaCli(session, url, o);
  if (cli && cli.ok) {
    cli.backend = 'cli';
    cli.backendFallback = '进程内后端启动失败，已改用 playwright-cli：' + String((r && r.error) || '未知原因');
  }
  return cli;
}

async function openViaCli(session, url, opts) {
  const o = opts || {};
  const target = String(url || '');
  if (!HTTP_URL_RE.test(target)) return { ok: false, error: '起始 URL 必须以 http:// 或 https:// 开头：' + JSON.stringify(target.slice(0, 80)) };

  const requested = o.browser || 'chrome';
  if (!BROWSERS[requested]) {
    return { ok: false, error: '不支持的浏览器内核：' + JSON.stringify(String(requested).slice(0, 40)) + '（可选 chrome / msedge）' };
  }

  /* 计划先行：模式非法 / CDP 目标非法 / persistent 缺目录，都在起进程之前就返回人话。
   * 只把「确实给了值」的选项透传下去（mode: null 这类线上脏值按缺省 isolated 处理 ——
   * 万一有调用方没跟上，退回到最收敛的模式，而不是抛错或退到会碰用户浏览器的模式）。 */
  const planOpts = {
    url: target, browser: requested, profileDir: dataDir,
    maximize: Boolean(o.maximize), native: Boolean(o.native),
  };
  if (o.mode !== undefined && o.mode !== null) planOpts.mode = o.mode;
  if (o.cdp !== undefined && o.cdp !== null) planOpts.cdp = o.cdp;

  let plan;
  let fallbackPlan = null;
  try {
    plan = openPlan(planOpts);
    /* 目标是内核名时先自己预检 + 解析端点（见 cdpCandidates：CLI 的内核形态会拼出 404 的
     * ws 地址）。预检不通过就直接报人话 —— 对着拒绝 DevTools 的端口 attach 会白等 30s。 */
    if (plan.mode === 'cdp' && CDP_CHANNELS.indexOf(plan.target) >= 0) {
      const file = channelPortFile(plan.target, process.platform, process.env);
      const probed = await cdpProbe(file ? [{ channel: plan.target, file: file }] : []);
      if (!probed.available) return { ok: false, error: humanCdpProbeError(plan.target, probed) };
      plan = openPlan(Object.assign({}, planOpts, { cdp: probed.endpoint }));
    }
    /* 手填了 http 形态端点（占位符以前就是这么教的）→ 端口文件里能对上端口就备一条 ws。
     * 默认 profile 上 http 形态必然 404（Chrome 147+ 关了 /json 发现），换掉即"填了也能用"。
     * **但不在这里静默替换**：端口文件是磁盘残留物，可能属于另一个浏览器，换掉会把一个
     * 本来能连的端点变成连不上的。所以先按用户填的试，只有 404 那条死路才回退到 ws。 */
    if (plan.mode === 'cdp' && httpTargetPort(plan.target) != null) {
      const swapped = resolveHttpTarget(plan.target);
      if (swapped) fallbackPlan = openPlan(Object.assign({}, planOpts, { cdp: swapped }));
    }
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }

  if (plan.mode === 'cdp') {
    /* ① 已经附身且还活着 → 复用这条连接（授权是按连接给的，重建就要用户再点一次允许）。
     *   判活用一个便宜且只读的命令；失败说明 daemon 没了，清掉状态走 ②。 */
    const st = sessionState.get(session);
    if (st && st.mode === 'cdp' && st.tabToken) {
      const alive = await exec(session, ['tab-list']);
      if (alive.ok) return reuseCdpTab(session, plan);
      sessionState.delete(session);
    } else if (st) {
      /* ② 这条会话上一轮跑的是别的模式（比如独立实例）：先把它拆掉，
       *   否则 attach 会复用到那个已存在的 daemon，模式就串了。 */
      await exec(session, ['close']);
      sessionState.delete(session);
    } else {
      /* ③ 没有状态但可能有残留 daemon（server 重启过）：宁可多花用户一次允许，
       *   也要保证连上的确实是 CDP 而不是别的实例。 */
      await exec(session, ['close']);
    }
    /* cdpTimeout=0（不超时）经 --config 交给 CLI：Chrome 144+ 的「允许远程调试」弹窗
     * 靠那条挂着的连接维持，默认 30s 超时会把弹窗打掉。 */
    const cdpCfgPath = path.join(dataDir, CDP_CONFIG_FILE);
    try {
      fs.writeFileSync(cdpCfgPath, JSON.stringify(cdpAttachConfig(), null, 2));
    } catch (e) {
      return { ok: false, error: '写入 CDP 连接配置失败：' + String(e && e.message || e) };
    }
    return openCdp(session, plan, ['--config', cdpCfgPath], fallbackPlan);
  }

  /* 最大化：写 config 文件并经 --config 传给 open（daemon 的 cwd 是 dataDir，
   * config 路径含空格时 quoteArg 会自动包引号） */
  let configArgs = [];
  if (plan.config) {
    const cfgPath = path.join(dataDir, MAXIMIZED_CONFIG_FILE);
    try {
      fs.writeFileSync(cfgPath, JSON.stringify(plan.config, null, 2));
      configArgs = ['--config', cfgPath];
    } catch (e) {
      return { ok: false, error: '写入最大化配置失败：' + String(e && e.message || e) };
    }
  }

  /* persistent：profile 目录必须先存在（Chrome 会往里写，但父目录不存在时它不建） */
  if (plan.mode === 'persistent') {
    try {
      fs.mkdirSync(path.join(dataDir, PROFILE_DIR), { recursive: true });
    } catch (e) {
      return { ok: false, error: '创建浏览器 profile 目录失败：' + String(e && e.message || e) };
    }
  }

  const out = await exec(session, plan.commands[0].concat(configArgs));
  /* open 也会写一份工件（{result:{snapshot:{file}}}），同样没人消费 ——
   * 第 1 步的快照必须真取（人工登录门在 open 之后）。只删不留。 */
  discardArtifact(out.artifact);
  if (out.ok) {
    sessionState.set(session, { mode: plan.mode });
    return { ok: true, browser: plan.browser, mode: plan.mode, maximized: Boolean(o.maximize), native: Boolean(o.native) };
  }

  const profileMsg = plan.mode === 'persistent' ? humanProfileError(out.error) : null;
  if (profileMsg) return { ok: false, error: profileMsg };

  // 懒探测（设计 §4）：首选浏览器缺失时自动换另一个内核试一次，并把失败翻译成人话
  if (looksLikeBrowserMissing(out.error)) {
    const alt = requested === 'msedge' ? 'chrome' : 'msedge';
    const retryPlan = openPlan(Object.assign({}, planOpts, { browser: alt }));
    const retry = await exec(session, retryPlan.commands[0].concat(configArgs));
    if (retry.ok) {
      sessionState.set(session, { mode: plan.mode });
      return { ok: true, browser: alt, mode: plan.mode, maximized: Boolean(o.maximize), native: Boolean(o.native) };
    }
    return { ok: false, error: humanBrowserError(requested + ' → ' + alt, retry.error) };
  }
  return { ok: false, error: humanBrowserError(requested, out.error) };
}

async function snapshot(session) {
  if (useInproc(session)) return inprocBackend().snapshot(session);
  const refuse = await ownTabRefusal(session, 'snapshot');
  if (refuse) return refuse;
  const out = await exec(session, ['snapshot']);
  return out.ok ? { ok: true, snapshot: out.result } : out;
}

/* 工程自动执行（不占 Jev 动作名额）：tab-list 拿当前标签页 url+标题，
 * 并解析出全部标签页 —— auto 循环把它们写进 state 的「标签页」字段，
 * 模型才能感知「点击开了新 Tab 但我还停在原页面」这类多 Tab 事实
 * （实测事故：百度结果链接 target=_blank，连点 7 次同一 ref 都在开新 Tab，
 * 而快照始终是原页面，模型无从察觉）。实测输出形如：
 *   - 0: (current) [Example Domain](https://example.com/)
 *   - 1: [百度一下](https://www.baidu.com/) */
function parseTabs(text) {
  const tabs = [];
  String(text || '').split('\n').forEach((line) => {
    /* 标题取贪婪、URL 锚定行尾：标题本身可能含 ]（"[PDF] 报告"、"[图]xx"），
     * 用 [^\]]* 会跨不过那个 ] 而整行失配 —— 当前标签页一旦失配，pageInfo 的
     * url/title 全空、refPageUrl 被钉在空串上，失败记忆跨页面导航一直不重置。
     * 贪婪标题取到最后一个 "]("，正好是标题与 URL 的分界（URL 允许含括号）。 */
    const m = line.match(/-\s*(\d+):\s*(\(current\)\s*)?\[([\s\S]*)\]\((.*)\)\s*$/);
    if (!m) return;
    tabs.push({ index: parseInt(m[1], 10), current: Boolean(m[2]), title: m[3], url: m[4] });
  });
  return tabs;
}

async function pageInfo(session) {
  if (useInproc(session)) return inprocBackend().pageInfo(session);
  /* CDP 守卫（读路径这一道；act / snapshot / rect / screenshot 各自还有一道） */
  const refuse = await ownTabRefusal(session, 'page-info');
  if (refuse) return Object.assign({ url: '', title: '', tabs: [] }, refuse);

  const out = await exec(session, ['tab-list']);
  if (!out.ok) return { ok: false, url: '', title: '', tabs: [], error: out.error };
  const tabs = parseTabs(out.result);
  const cur = tabs.find((t) => t.current) || null;
  return { ok: true, url: cur ? cur.url : '', title: cur ? cur.title : '', tabs };
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
  if (useInproc(session)) return inprocBackend().resize(session, w, h);
  const refuse = cdpRefusal(session);
  if (refuse) return refuse;
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
  if (useInproc(session)) return inprocBackend().viewport(session);
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
  if (useInproc(session)) return inprocBackend().fullscreen(session);
  const refuse = cdpRefusal(session);
  if (refuse) return refuse;
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

/* RECT_SNIPPET 的返回值解析（单一定义：老路的 eval 与快路径的 locator.evaluate 共用）。
 * eval 的返回值被 CLI 又 JSON 序列化了一次，字符串带引号 —— 先剥再解析。 */
const RECT_CSV_RE = /^(-?\d+),(-?\d+),(\d+),(\d+),(\d+),(\d+)$/;

function parseRectCsv(raw) {
  let text = raw;
  if (typeof text === 'string' && /^".*"$/.test(text)) {
    try { text = JSON.parse(text); } catch (_) { /* 保持原样 */ }
  }
  const m = String(text).match(RECT_CSV_RE);
  if (!m) return null;
  return { rect: { x: +m[1], y: +m[2], w: +m[3], h: +m[4] }, viewport: { w: +m[5], h: +m[6] } };
}

async function rect(session, ref) {
  if (useInproc(session)) return inprocBackend().rect(session, ref);
  const r = String(ref == null ? '' : ref);
  if (!REF_RE.test(r)) return { ok: false, error: '读元素位置需要合法 ref（形如 e12），收到：' + JSON.stringify(r.slice(0, 40)) };
  const refuse = await ownTabRefusal(session, 'rect');
  if (refuse) return refuse;
  const out = await exec(session, ['eval', RECT_SNIPPET, r]);
  if (!out.ok) return out;
  const pos = parseRectCsv(out.result);
  if (!pos) return { ok: false, error: '元素位置解析失败：' + JSON.stringify(String(out.result).slice(0, 60)) };
  return { ok: true, rect: pos.rect, viewport: pos.viewport };
}

const MAXIMIZED_CONFIG_FILE = 'auto-cli.config.json';
const CDP_CONFIG_FILE = 'auto-cli.cdp.config.json';   // CDP 连接配置（cdpTimeout=0）

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
  if (useInproc(session)) return inprocBackend().act(session, command, ref, text);
  let argv;
  try {
    argv = buildArgv(String(command || ''), ref, text);
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
  if (String(command) === 'upload' && text != null && !uploadPathAllowed(dataDir, text)) {
    return { ok: false, error: 'upload 只允许 data/ 目录内的文件（安全限制），收到：' + String(text).slice(0, 120) };
  }
  /* CDP 快路径：守卫与动作合并成一条 run-code（见上方 CDP 快路径一节）。
   * 归属判定**从 ownTabRefusal 挪进了同一条命令里**，所以这条分支必须在它之前。 */
  const fastToken = MERGED_ACTIONS[String(command || '')] ? fastPathToken(session) : null;
  if (fastToken && REF_RE.test(String(ref == null ? '' : ref))) {
    const fast = await execCode(session, mergedActCode(fastToken, String(command), String(ref), String(text == null ? '' : text)), { timeoutMs: ACT_FAST_TIMEOUT_MS });
    if (!fast.fallback) {
      if (!fast.ok) return fast;               // 含 lostTab：前端据此整轮停手
      const v = codeValue(fast.value) || {};
      if (v.actError) return { ok: false, error: String(v.actError) };
      return { ok: true, result: '', snapshot: usableSnapshot(v.snapshot) };
    }
    /* fallback：这条不该用快路径（弹窗态 / 老版本 CLI）→ 落到下面的老路 */
  }
  /* 守卫先过：标签页已经丢了就用「已不在」这条更根本的原因停手，别去算归属 */
  const refuse = await ownTabRefusal(session, String(command || ''));
  if (refuse) return refuse;
  /* tab-select 再判归属：查一次 tab-list 拿目标序号当下真实的 URL，命中
   * 「attach 之前就开着」的集合就直接拒 —— 否则一选就把当前页变成用户的页面，
   * 后面每一步守卫都得停手（选完再判就晚了：人已经在人家页面上了）。 */
  if (String(command) === 'tab-select') {
    const st = sessionState.get(session);
    if (st && st.mode === 'cdp' && Array.isArray(st.preExisting) && st.preExisting.length) {
      const list = await exec(session, ['tab-list']);
      if (list.ok) {
        const tabs = parseTabs(list.result);
        const target = tabs.find((t) => String(t.index) === String(argv[1]));
        const selectRefuse = target ? tabSelectRefusal(st.preExisting, target.url) : null;
        if (selectRefuse) return selectRefuse;
      }
    }
  }
  const out = await exec(session, argv);
  /* 失败分支的 discardArtifact 是**防御性**的，不是实测路径：实测（对抗评审复核过源码）失败的
   * 动作是在 handler 里 throw，CLI 直接走 formatError，serialize()/_build() 根本没跑，
   * 因此不会留下工件。但「响应里有 Error 段」与「有 Snapshot 段」并不互斥，版本一变就可能
   * 同时出现 —— 那时这份文件同样没人读，留着就是永久垃圾。删掉不读：拿「动作失败之后」的页面
   * 当下一步依据，正是这次改动要避免的那类过期依据。 */
  if (!out.ok) { discardArtifact(out.artifact); return out; }
  /* 动作之后的那份快照工件（只有部分动作有，见 snapshotArtifactRel）：
   * 在这里就读掉，免得下面 markOwnTab 的早退把它落在盘上。
   * 还要过 SNAPSHOT_TRUSTED_ACTIONS 那一关 —— 只有「动作自身完成条件已包住页面更新」的动作，
   * 它的快照才配当下一步的页面依据；其余（hover/select/uncheck）当场丢弃，让下一步真取一次。 */
  let postActionSnapshot = null;
  if (SNAPSHOT_TRUSTED_ACTIONS[String(command || '')]) {
    postActionSnapshot = usableSnapshot(readArtifactSnapshot(out.artifact));
  } else {
    discardArtifact(out.artifact);
  }
  /* tab-select / tab-new 之后当前页是一个全新的浏览上下文（window.name 为空），
   * 不重新打标记的话下一步守卫会把它判成「切走了」而误杀整轮运行。 */
  if (String(command) === 'tab-select' || String(command) === 'tab-new') {
    const marked = await markOwnTab(session);
    if (!marked.ok) return marked;
  }
  return { ok: true, result: out.result, snapshot: postActionSnapshot };
}

/* 截图失败里哪些值得重试：**只有超时**。
 * 为什么重试：playwright-cli 的 screenshot 默认走 css 档，实测在 dpr 为小数等情形下会撞 CLI
 * 的 5s 动作超时（同一命令隔一会儿重试往往就过）。这张图是标注与人眼复核的唯一凭据 ——
 * 丢一次整步就没图了。丢标签页 / 弹窗这类失败不重试：重试没意义，只是白等一个超时周期。 */
const SHOT_TIMEOUT_RE = /TimeoutError|timeout|超时/i;

/* ref 可选：带上就在同一条命令里把该元素的位置与视口一并读回来（前端据此把「即将被
 * 操作的元素」标到图上）。CDP 下这一步尤其值钱 —— 老路要跑四次进程（守卫+rect、
 * 守卫+截图），合并后一次。 */
async function screenshot(session, name, ref) {
  if (useInproc(session)) return inprocBackend().screenshot(session, name, ref);
  const file = String(name || 'shot').replace(/[^A-Za-z0-9_-]/g, '') + '.png';
  const fastToken = fastPathToken(session);
  if (fastToken) {
    const r = String(ref == null ? '' : ref);
    const fast = await execCode(session, mergedShotCode(fastToken, file, REF_RE.test(r) ? r : null));
    if (!fast.fallback) {
      if (!fast.ok) return fast;               // 含 lostTab：前端据此整轮停手
      const v = codeValue(fast.value) || {};
      /* 截图本身失败才算失败：位置读不到只是标不出框（老路同样如此），不影响这张图 */
      if (v.shotError) return { ok: false, error: String(v.shotError) };
      const p = path.join(dataDir, file);
      try {
        const dataUrl = 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
        const out = { ok: true, dataUrl };
        const pos = parseRectCsv(v.rectCsv);
        if (pos) { out.rect = pos.rect; out.viewport = pos.viewport; }
        return out;
      } catch (_) {
        return { ok: false, error: '截图文件读取失败（预期路径 ' + p + '）' };
      }
    }
    /* fallback：弹窗态或这个 CLI 版本不认 run-code → 落到下面的老路 */
  }
  /* 守卫也在这里：截图会把当前页面拍下来存进 data/ 与运行记录 ——
   * 当前页若是用户自己的页面，那就是把人家页面收进了我们的记录里。 */
  const refuse = await ownTabRefusal(session, 'screenshot');
  if (refuse) return refuse;
  const argv = ['screenshot', '--filename', file];
  let out = await exec(session, argv);
  /* 只重试一次；两次都超时就如实把失败带回去（不装成功，也不无限重试） */
  if (!out.ok && SHOT_TIMEOUT_RE.test(String(out.error || ''))) out = await exec(session, argv);
  if (!out.ok) return out;
  const p = path.join(dataDir, file);
  try {
    const dataUrl = 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
    return { ok: true, dataUrl };   // 文件保留在 data/ 下，便于排查与留证
  } catch (_) {
    return { ok: false, error: '截图文件读取失败（预期路径 ' + p + '）' };
  }
}

/* close：停掉这个 CLI 会话的 daemon。
 * CDP 模式下它**只断开连接**，绝不关用户的浏览器（playwright-cli 的 stop 只删 session
 * 文件并退出进程；只有我们自己 launch 出来的实例才在 gracefullyCloseSet 里）。 */
async function close(session) {
  const st = sessionState.get(session);
  /* 进程内后端自己持有连接：交给它关（它会区分「关掉我们起的实例」与「只断开
   * 附身连接」，并把 isolated 的临时 profile 清掉，最后删掉它会话表里的条目）。
   * sessionState 一并清干净 —— 那是 CLI 侧的守卫状态，不该跨轮留着。
   * **页已经被用户关掉时同样要走到这里**：useInproc 问的是归属（那条会话还在不在进程内
   * 手上），不是页活着没（见它的注释）—— 只有这条 close 能把上下文与临时 profile 收干净。 */
  if (useInproc(session)) {
    const r = await inprocBackend().close(session);
    sessionState.delete(session);
    try { fs.unlinkSync(codeFilePath(session)); } catch (_) { /* 没有就算了 */ }
    return r;
  }
  const out = await exec(session, ['close']);
  sessionState.delete(session);
  /* 快路径的代码文件随会话一起清掉（每会话一份，覆盖式使用，留着只会积灰） */
  try { fs.unlinkSync(codeFilePath(session)); } catch (_) { /* 没有就算了 */ }
  if (!out.ok) return out;
  /* closed=false 表示关闭前压根没有开着的会话 —— 前端据此别说「浏览器已关闭」。
   * ok/mode/attached 三个字段是既有契约，保持原样。 */
  return {
    ok: true, mode: (st && st.mode) || 'isolated',
    attached: Boolean(st && st.mode === 'cdp'), closed: Boolean(st),
  };
}

module.exports = {
  status,
  cdpProbe,
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
  /* 模式白名单的唯一权威：server.js 校验 open 的 mode 就用它（别再抄一份字面量）。
   * 前端那份在 index.html 的 <option> 里（前端够不着这个模块）。 */
  MODES,
  set dataDir(v) { dataDir = v; },
  get dataDir() { return dataDir; },
  _test: { quoteArg, validateAct, buildArgv, OPS, REF_RE, BROWSERS, MODES, CDP_CHANNELS, PROFILE_DIR, CDP_TARGET_MAX, openPlan, validateCdpTarget, newTabToken, tabMarkSnippet, tabGuardOk, ownTabRefusal, markOwnTab, tabSelectRefusal, isHttpDiscoveryDead, MODAL_GUARD_RE, MODAL_SAFE_COMMANDS, TAB_MARK_SNIPPET: tabMarkSnippet, TAB_READ_SNIPPET, parseDevToolsPort, parseDevToolsActivePort, wsEndpointForPortPath, cdpUserDataDirs, channelPortFile, httpEndpointForPort, httpTargetPort, resolveHttpTarget, cdpProbe, cdpProbeHint, humanCdpProbeError, humanCdpAttachError, cdpAttachConfig, probeTcp, CDP_CONFIG_FILE, reuseCdpTab, CDP_ATTACH_TIMEOUT_MS, cdpRefusal, sessionState, parseEnvelope, unwrapResult, treeToSnapshotYaml, uploadPathAllowed, parseWindowSize, buildMaximizedConfig, FULLSCREEN_SNIPPET, RECT_SNIPPET, parseTabs, summarizeError, clipMiddle, MAXIMIZED_CONFIG_FILE,
    /* CDP 快路径（守卫 + 动作合并成一条 run-code）*/
    MERGED_ACTIONS, GUARD_LOST_MARK, GUARD_UNKNOWN_MARK, LOST_TAB_ERROR, GUARD_RACE_MS,
    ACTION_TIMEOUT_MS, ACT_FAST_TIMEOUT_MS, SETTLE_MS, SETTLE_REQ_CAP_MS, SETTLE_NAV_MS, SNAPSHOT_CAP_MS,
    cliEnv, guardLines, jsLiteral, mergedActCode, mergedShotCode,
    codeValue, parseRectCsv, fastPathToken, codeFilePath,
    /* 动作后快照：路径认领、沙箱读回 / 丢弃、形状转写与「能不能用」的判定 */
    snapshotArtifactRel, artifactAbsPath, readArtifactSnapshot, discardArtifact,
    normalizeArtifactText, usableSnapshot,
    /* 后端分发（进程内 playwright-core / playwright-cli）：选择规则、错误翻译、
     * 以及进程内后端实例本身（测试要直接驱它，别经过 CLI 那条路） */
    BACKENDS, DEFAULT_BACKEND, resolveBackend, useInproc, inprocBackend, openViaCli,
    looksLikeBrowserMissing, humanBrowserError, humanProfileError },
};
