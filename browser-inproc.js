/* ===================== playwright-jev-agent · 进程内浏览器后端 =====================
 * 与 browser-driver.js（playwright-cli 薄壳）并列的第二条后端：**自己 require
 * playwright-core，长期持有一个 BrowserContext**，把每个操作做成进程内调用。
 *
 * 为什么需要它（2026-09-29 真机实测，同一台机器、同一个 mailbox 演示页）：
 *   playwright-cli 是**每条命令一个新进程**（browser-driver.js 里 spawn 那一层），
 *   实测底价 0.93~1.18s/次，其中约 0.8~1.0s 是 CLI 启动时 require('playwright-core')
 *   的模块加载 —— 而 CLI 源码里没有任何常驻 IPC 通道，躲不掉。一轮 8 步要走 30+ 条命令，
 *   于是「Jev 只占 7%、93% 是进程开销」成了整轮 82s 的主因。
 *
 *   操作                        进程内        走 playwright-cli
 *   ariaSnapshot({mode:'ai'})   111ms         1350~2000ms
 *   context.pages() 取标签页     0ms           1200~2300ms
 *   截图 + 读矩形                ~318ms        3200~3700ms（2 次进程）
 *   动作 + settle + 取快照       608ms         1900~3000ms
 *
 * 依赖注入而不是 require('./browser-driver.js')：后者会形成循环依赖（driver 要 require
 * 本模块来做后端分发），而且**白名单与解析函数必须只有一份**（validateAct / usableSnapshot /
 * parseRectCsv / RECT_SNIPPET …）—— 各写一遍就是两套行为，迟早漂移。所以由 driver 侧
 * 调 createInprocBackend(shared) 把那份共享面注进来。
 *
 * 与 CLI 后端的**对外契约完全一致**（server.js / 前端一行都不用改）：
 *   open/close/snapshot/pageInfo/act/rect/screenshot/viewport/fullscreen/resize
 * 其中 act 的返回必须保持 {ok, result, snapshot} —— 前端的 makeSnapshotCarrier
 * （public/js/auto-core.js:makeSnapshotCarrier）靠 act.snapshot 把「上一步动作带回的快照」
 * 顶替下一步的 snapshot 调用，这条链路每步能省一次取快照。
 *
 * 弹窗（原生 confirm/alert/prompt）是两条后端**行为差异最大**的一处，见下面 DIALOG 一节：
 * CLI 会立刻报 "does not handle the modal state"，而 playwright-core 要么自动 dismiss
 * （不挂监听器时，confirm 返回 false → 动作静默变成空操作），要么让所有调用**挂住**
 * （挂了不处理的监听器时，实测 click 超时 8s、ariaSnapshot/screenshot/count >6s 不返回）。
 * 照搬 CLI 的写法在这里是错的，必须主动拦截 + 与弹窗事件赛跑。
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* 与 CLI 后端**逐字相同**的一句弹窗文案：auto-core 的 isModalSnapshotError 按
 * /modal state/i 匹配它，据此把这一步转成「弹窗步」（只问一道「动作」题）。
 * 这句是对外契约的一部分，改一个字就会让弹窗处理整条链失效。 */
const MODAL_SNAPSHOT_ERROR = 'Tool "browser_snapshot" does not handle the modal state.';

/* 进程内后端起不来时给用户的话。**必须可操作**：说清装什么、或怎么切回 CLI。 */
const INSTALL_HINT = '（执行 npm i playwright-core 安装后重试，或在「运行参数 → 驱动后端」切回 playwright-cli）';

/* attach 的超时。CLI 后端那边是 3 分钟，因为 Chrome 144+ 的「允许远程调试」弹窗
 * 靠那条挂着的连接维持、要留给用户点击的时间；进程内 connectOverCDP 同样会触发
 * 那个授权弹窗，所以对齐同一个量级。 */
const CDP_CONNECT_TIMEOUT_MS = 180000;

let pw = null;            // playwright-core 模块（懒加载，只成功一次）
let pwError = null;       // 加载失败的原因（懒加载，只失败一次）
let pwVersion = null;

function loadPlaywright() {
  if (pw || pwError) return pw;
  try {
    pw = require('playwright-core');
    try { pwVersion = require('playwright-core/package.json').version; } catch (_) { pwVersion = null; }
  } catch (e) {
    pwError = String((e && e.message) || e);
  }
  return pw;
}

/* 会话 → 连接状态。与 CLI 后端一样是进程内内存：server 重启即失效（不会有半开状态残留）。 */
const sessions = new Map();

function state(session) {
  return sessions.get(String(session == null ? '' : session)) || null;
}

/* ---------------- 共享面（由 browser-driver.js 注入） ----------------
 * 这些是两条后端**必须一致**的东西：白名单校验、快照可用性判定、矩形片段与解析、
 * 模式计划、错误翻译、CDP 端点发现。全部由 driver 侧注入，本模块不自己实现一份。 */
let shared = null;
let getDataDir = () => path.join(__dirname, 'data');

function createInprocBackend(injected) {
  shared = injected;
  if (typeof injected.getDataDir === 'function') getDataDir = injected.getDataDir;
  return api;
}

/* ---------------- 小工具 ---------------- */

/* 内存里的快照直接就是字符串，没有 CLI 那套「写成 .yml 工件再读回来」的搬运。
 * 空/无 ref 一律当没拿到 —— 下游（refCriteria / 召回 / 标注）全按 ref 行解析，
 * 没有 ref 的文本喂进去等于「页面上没有可操作元素」，而且**不会报错**。
 * 判定复用 driver 的 usableSnapshot（唯一权威，别在这里再写一遍正则）。 */
function snapOf(text) {
  return shared.usableSnapshot(text);
}

function errText(e) {
  const m = String((e && e.message) || e || '');
  /* Playwright 的报错带多行 "Call log:" 与 ANSI 色码，直接喂给模型太吵；
   * 复用 driver 的摘要（同一份实现，两条后端的报错风格才不会分叉） */
  return shared.summarizeError ? shared.summarizeError(m) : m;
}

/* ---------------- 打开 ---------------- */

/* 把 --start-maximized / viewport:null / 物理像素那组启动参数从共享面取出来。
 * **不抄字面量**：那组参数（含 native 时的 --force-device-scale-factor=1）与 CLI 后端
 * 必须完全一致，否则两条后端在同一个屏幕上会给出不同视口，截图与标注全部对不上。 */
function launchArgs(opts) {
  const cfg = shared.buildMaximizedConfig({ native: Boolean(opts && opts.native) });
  const lo = (cfg && cfg.browser && cfg.browser.launchOptions) || {};
  return {
    args: Array.isArray(lo.args) ? lo.args.slice() : [],
    viewport: cfg && cfg.browser && cfg.browser.contextOptions ? cfg.browser.contextOptions.viewport : null,
  };
}

/* 内核缺失（本机没装 Chrome/Edge）时的兜底：换另一个内核再试一次。
 * 与 CLI 后端同一条策略，错误翻译也走同一份 humanBrowserError。 */
async function launchWithFallback(chromium, profileDir, opts) {
  const first = shared.BROWSERS[opts.browser] ? opts.browser : 'chrome';
  const alt = first === 'msedge' ? 'chrome' : 'msedge';
  const { args, viewport } = launchArgs(opts);
  const base = { headless: false, viewport, args };
  if (opts.maximize === false) { base.args = base.args.filter((a) => a !== '--start-maximized'); base.viewport = undefined; }
  let lastErr = null;
  for (const channel of [first, alt]) {
    try {
      const context = await chromium.launchPersistentContext(profileDir, Object.assign({}, base, { channel }));
      return { ok: true, context, browser: channel };
    } catch (e) {
      lastErr = e;
      const msg = String((e && e.message) || e);
      const profileMsg = shared.humanProfileError ? shared.humanProfileError(msg) : null;
      /* profile 被占用不是「内核缺失」：换内核重试没意义，而且会白等一次启动。
       * 立刻如实回报（与 CLI 后端同一条判断） */
      if (profileMsg) return { ok: false, error: profileMsg };
      if (!shared.looksLikeBrowserMissing(msg)) return { ok: false, error: msg };
    }
  }
  return { ok: false, error: shared.humanBrowserError(first + ' → ' + alt, String((lastErr && lastErr.message) || lastErr)) };
}

/* CDP 端点解析：与 CLI 后端的 open() 用的是**同一批纯函数**（cdpProbe / resolveHttpTarget
 * / humanCdpProbeError）。这段逻辑踩坑最多（Chrome 136+ 默认禁远程调试、CLI 拼的
 * ws://…/devtools/browser 必 404、端口文件可能是陈旧残留），绝不能在这里重写一份。 */
async function resolveCdpEndpoint(target) {
  const t = String(target || '').trim();
  if (/^wss?:\/\//i.test(t)) return { ok: true, endpoint: t };
  if (shared.CDP_CHANNELS && shared.CDP_CHANNELS.indexOf(t) >= 0) {
    const file = shared.channelPortFile(t, process.platform, process.env);
    const probed = await shared.cdpProbe(file ? [{ channel: t, file }] : []);
    if (!probed || !probed.available) {
      return { ok: false, error: shared.humanCdpProbeError(t, probed) };
    }
    return { ok: true, endpoint: probed.endpoint };
  }
  if (/^https?:\/\//i.test(t)) {
    /* http 形态在默认 profile 上必然 404（Chrome 147+ 关了 /json 发现）。
     * 与 CLI 后端同一策略：先按用户填的试，那条死路才回退到端口文件里的 ws。 */
    const swapped = shared.resolveHttpTarget(t);
    if (swapped) return { ok: true, endpoint: swapped };
    return { ok: true, endpoint: t };
  }
  return { ok: false, error: 'CDP 连接目标只能是内核名（chrome / msedge）或 ws:// / http:// 端点' };
}

/* 能力探测：ariaSnapshot({mode:'ai'}) 必须吐出带 [ref=…] 的快照。
 * **探能力而不是查版本号** —— playwright-core ≥1.59.0 才有 mode:'ai'，但版本号对不上
 * （被别的包拉平、镜像里是魔改版）一样会静默出错，而那正是最贵的一种错：
 * 快照里没有 ref，下游全按「页面上没有可操作元素」处理，整个 agent 直接瘫掉却不报错。
 * 进程内只探一次，**且只缓存成功**：页面还在卸载/渲染时会瞬时抛错，把那次失败也钉住的
 * 话此后每次 open 都失败、只能重启 server。 */
let capability = null;
async function probeCapability(page) {
  if (capability && capability.ok) return capability;
  let result;
  try {
    const text = await page.ariaSnapshot({ mode: 'ai' });
    result = snapOf(text)
      ? { ok: true }
      : { ok: false, error: '当前 playwright-core 不产出带 ref 的 AI 快照（需 ≥1.59.0）' + INSTALL_HINT };
  } catch (e) {
    result = { ok: false, error: '当前 playwright-core 不支持 AI 快照（需 ≥1.59.0）：' + errText(e) + INSTALL_HINT };
  }
  if (result.ok) capability = result;
  return result;
}

/* ---------------- DIALOG：与 CLI 行为差异最大的一处 ----------------
 * 实测（真机，mailbox 的删除按钮触发 confirm）：
 *   · **不挂 'dialog' 监听器** → Playwright 自动 dismiss，confirm 返回 false，
 *     删除**静默变成空操作**，快照 0 字节变化。模型看不到任何进展 → 原地重试。
 *   · **挂了监听器但不处理** → 弹窗留住，但所有页面调用**挂住**：
 *     click 8s 超时、ariaSnapshot / screenshot / locator.count() >6s 不返回。
 * CLI 不是这样：它一遇到弹窗就立刻回一句 "does not handle the modal state"。
 *
 * 所以要复刻 CLI 的**对外行为**（而不是它的实现）：
 *   ① 建页后立刻挂监听器把弹窗留住（正确性前提，不是优化）
 *   ② 弹窗挂着期间，所有读类调用**不碰 Playwright**，直接回那句 CLI 文案
 *   ③ 触发弹窗的那次动作与「弹窗事件」赛跑：弹窗先到就算这次动作**成功**（动作确实
 *      已经触发了），只是不带快照 —— 否则会白等一个 30s 超时，比慢更糟 */
function attachDialogKeeper(page, st) {
  page.on('dialog', (d) => {
    st.pendingDialog = d;
    if (st.dialogSignal) { const f = st.dialogSignal; st.dialogSignal = null; f(); }
  });
}

/* 认领一页：记进 ownedPages + 挂弹窗守卫 + 接住它自己开出来的子页（window.open /
 * target=_blank），子页再开子页也照此链下去 —— 那些都是我们这一侧的页，不认领就等于
 * 让它们上的原生 confirm 被 Playwright 静默 dismiss（见 DIALOG 一节的实测）。
 * **判据是「谁生的」而不是 context.on('page')**：附身模式下后者会把监听器挂到用户自己
 * 的标签页上、把用户的弹窗留住，那是越界。沿 popup 事件走只覆盖我们自己发起的链子。 */
function ownPage(page, st) {
  st.ownedPages.add(page);
  attachDialogKeeper(page, st);
  page.on('popup', (child) => ownPage(child, st));
}

function modalError() {
  return { ok: false, error: MODAL_SNAPSHOT_ERROR };
}

/* 当前页可用吗：拿不到（会话没了 / 我们的页被关掉）就返回停手原因。
 * 这是 CLI 那套 window.name 守卫在进程内的**替代品**：我们手里始终握着 Page 句柄，
 * 所以「页还在不在」直接问它就行，不必再往页面里写标记、再到处读回来比对
 * （那条路的代价是每条命令前多一次 eval，且用户关掉页时得靠轮询发现）。 */
function currentPage(session) {
  const st = state(session);
  if (!st) return { error: { ok: false, error: '浏览器未打开：请先点开始（或调用 open）' } };
  const p = st.page;
  if (!p || p.isClosed()) {
    return {
      error: {
        ok: false, lostTab: true,
        error: '专用标签页已不在（被关闭或被切走）：为免误动你自己的页面，这里停手了。重新开始即可开一个新标签页。',
      },
    };
  }
  return { page: p, st };
}

/* ---------------- 打开 / 关闭 ---------------- */

async function open(session, url, opts) {
  const o = opts || {};
  const chromium = (loadPlaywright() || {}).chromium;
  if (!chromium) {
    return { ok: false, error: '进程内后端不可用：无法加载 playwright-core —— ' + (pwError || '未知原因') + INSTALL_HINT };
  }
  /* 起点 URL 必须是 http(s)：判定用 shared 注入的那份（就是 openViaCli 用的同一条规则，
   * 不许在这里另写一份正则）。放在计划函数之前 —— 空 URL / 非法协议都不该走到起浏览器、
   * 建 profile 那一步（CLI 后端同样是起进程之前就挡）。 */
  const target = String(url || '');
  if (!shared.HTTP_URL_RE.test(target)) {
    return { ok: false, error: '起始 URL 必须以 http:// 或 https:// 开头：' + JSON.stringify(target.slice(0, 80)) };
  }
  /* 模式/内核/目标/CDP 目标的校验全部复用 driver 的计划函数（唯一权威）：
   * 非法模式、非法 CDP 目标、persistent 缺目录都在**起进程之前**报人话。
   * 入参只带「确实给了值」的键，与 browser-driver.js 的 openViaCli 同一口径：openPlan 用
   * hasOwnProperty 判「调用方有没有显式给 mode」，透传一个 undefined 会被 String() 成
   * 'undefined' → 报「不支持的浏览器模式」→ open 失败并静默退回 CLI。线上 HTTP 层永远带
   * mode（server.js 缺省 isolated），所以这只在直接调 API / 测试的路径上炸 —— 也就是说
   * 默认后端此前根本没被那些测试跑到过。 */
  const planOpts = {
    url: url, browser: o.browser, profileDir: getDataDir(),
    maximize: Boolean(o.maximize), native: Boolean(o.native),
  };
  if (o.mode !== undefined && o.mode !== null) planOpts.mode = o.mode;
  if (o.cdp !== undefined && o.cdp !== null) planOpts.cdp = o.cdp;
  let plan;
  try {
    plan = shared.openPlan(planOpts);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }

  /* 同一个会话重复 open：先把上一条拆掉，免得留下两个窗口（与 CLI 后端一致：
   * 「上轮结束后浏览器可能还开着，已开会话上再 open 会报错」）。 */
  if (sessions.has(String(session))) await close(session);

  const dataDir = getDataDir();
  let context = null;
  let browser = plan.browser;
  let mode = plan.mode;
  let ownedPages = new Set();
  let cdpBrowser = null;

  if (mode === 'cdp') {
    const ep = await resolveCdpEndpoint(plan.target);
    if (!ep.ok) return { ok: false, error: ep.error };
    try {
      cdpBrowser = await chromium.connectOverCDP(ep.endpoint, { timeout: CDP_CONNECT_TIMEOUT_MS });
    } catch (e) {
      return { ok: false, error: shared.humanCdpAttachError ? shared.humanCdpAttachError(String((e && e.message) || e)) : String((e && e.message) || e) };
    }
    context = cdpBrowser.contexts()[0] || await cdpBrowser.newContext();
    /* attach 之前就开着的都是**用户的**标签页：记下来当 tab-select 的禁选基线。
     * 复用 CLI 后端那份纯函数判定，不另写一套。 */
    const preExisting = context.pages().map((p) => p.url());
    let page = null;
    try {
      page = await context.newPage();
      const st = { mode, browser, context, page, ownedPages, preExisting, cdpBrowser, pendingDialog: null, dialogSignal: null, tmpProfile: null };
      /* 认领要在 goto **之前**：首次加载期间弹出来的弹窗与子页同样得管起来 */
      ownPage(page, st);
      await page.goto(url, { waitUntil: 'load', timeout: shared.ACTION_TIMEOUT_MS });
      sessions.set(String(session), st);
      return { ok: true, browser, mode, attached: true, maximized: false, native: false };
    } catch (e) {
      /* 断开连接**不替我们收尾**：close() 只认 sessions 里登记过的会话，而这里登记在 goto
       * 之后 —— 于是我们 newPage 出来的那个专用标签页会留在用户浏览器里，每失败一次就在
       * 人家的标签栏上多一个。只关我们自己建的那一个，用户的页一根手指都不碰。 */
      if (page) { try { await page.close(); } catch (_) { /* 已经关了就算了 */ } }
      try { await cdpBrowser.close(); } catch (_) { /* 断开失败无所谓：用户的浏览器本来就不归我们关 */ }
      return { ok: false, error: '已连上浏览器，但新建专用标签页失败（为免动到你已开的标签页，已断开）：' + errText(e) };
    }
  }

  /* isolated：每次一个全新的临时 profile（不落盘进 data/browser-profile，
   * 与 CLI 后端的 isolated 同义：关掉即消失，不碰用户的登录态）。
   * persistent：profile 落在 data/browser-profile/ —— **与 CLI 后端同一个目录**，
   * 两条后端可以互接（用 CLI 后端登录一次，切到进程内后端仍复用那份登录态）。 */
  const profileDir = mode === 'persistent'
    ? path.join(dataDir, shared.PROFILE_DIR)
    : path.join(dataDir, 'inproc-profile-' + String(session).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24));
  try {
    fs.mkdirSync(mode === 'persistent' ? path.join(dataDir, shared.PROFILE_DIR) : profileDir, { recursive: true });
  } catch (e) {
    return { ok: false, error: '创建浏览器 profile 目录失败：' + errText(e) };
  }

  /* cdp 模式下窗口类选项无意义（那是用户的窗口）。此处已不是 cdp，照旧处理。
   * 注意 maximize 缺省按 true 走（与 server.js 的 windowMode=max 缺省一致） */
  const launched = await launchWithFallback(chromium, profileDir, {
    browser, maximize: o.maximize !== false, native: o.native,
  });
  if (!launched.ok) return { ok: false, error: launched.error };
  context = launched.context;
  browser = launched.browser;
  const page = context.pages()[0] || await context.newPage();
  ownedPages = new Set(context.pages());
  const st = {
    mode, browser, context, page, ownedPages, preExisting: [],
    cdpBrowser: null, pendingDialog: null, dialogSignal: null,
    tmpProfile: mode === 'isolated' ? profileDir : null,
  };
  ownPage(page, st);
  /* 先把会话登记上，**再**去 goto：close() 只认 sessions 里这条记录，登记晚一步的话
   * goto 失败时 close() 拿到 null，会当「本来就没开着」直接返回 —— 浏览器窗口、isolated
   * 的临时 profile、persistent 的 profile 占用就全留在机器上了。 */
  sessions.set(String(session), st);
  try {
    await page.goto(url, { waitUntil: 'load', timeout: shared.ACTION_TIMEOUT_MS });
  } catch (e) {
    await close(session).catch(() => {});
    return { ok: false, error: '打开起始 URL 失败：' + errText(e) };
  }
  const cap = await probeCapability(page);
  if (!cap.ok) {
    await close(session).catch(() => {});
    return { ok: false, error: cap.error };
  }
  return { ok: true, browser, mode, maximized: Boolean(o.maximize !== false), native: Boolean(o.native) };
}

/* isolated 的临时 profile 用完即删：它是我们造的，留着只是占盘，而且占着就会让下次 open
 * 撞 profile 占用（缺陷 1 的另一面）。**不能只删一次** —— 实测 context.close() 返回时
 * 浏览器进程还没退干净、目录仍被占着，第一次 rmSync 必失败，隔几百毫秒再删就成功。
 * 所以短延时重试几次：有限次数、百毫秒级 —— close() 是「关闭浏览器」按钮的同步路径，
 * 不能让它转圈。重试完仍失败才保留原来那条「删不掉就算了」的兜底。 */
async function removeProfileDir(dir) {
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch (_) { /* 浏览器还在退出 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function close(session) {
  const st = state(session);
  if (!st) return { ok: true, closed: false, mode: null, attached: false };
  sessions.delete(String(session));
  /* cdp：**只断开连接**，绝不关用户的浏览器（与 CLI 后端同一承诺）。
   * 顺带把我们建的那个专用标签页关掉，免得每跑一轮留一个。 */
  if (st.mode === 'cdp' && st.cdpBrowser) {
    try { for (const p of st.ownedPages) { if (!p.isClosed()) await p.close().catch(() => {}); } } catch (_) { /* noop */ }
    try { await st.cdpBrowser.close(); } catch (_) { /* 断开失败不影响用户浏览器 */ }
    return { ok: true, closed: true, mode: 'cdp', attached: true };
  }
  try { await st.context.close(); } catch (_) { /* 已关就算了 */ }
  if (st.tmpProfile) await removeProfileDir(st.tmpProfile);
  return { ok: true, closed: true, mode: st.mode, attached: false };
}

/* ---------------- 读类 ---------------- */

async function snapshot(session) {
  const cur = currentPage(session);
  if (cur.error) return cur.error;
  if (cur.st.pendingDialog) return modalError();
  try {
    const text = await cur.page.ariaSnapshot({ mode: 'ai' });
    const use = snapOf(text);
    if (!use) return { ok: false, error: '快照不可用：未取到带 ref 的内容（页面可能正在卸载或为空）' };
    return { ok: true, snapshot: use };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

/* 标签页列表：CLI 后端是解析 tab-list 的文本，这里是 context.pages() —— 但**对外同形**
 * （{index, current, title, url}），因为 auto-core 的「标签页」字段按这个形状解析。
 * current 判定用我们自己持有的 Page 身份比对：比 CLI 的 "(current)" 文本标记可靠
 * （那行标记在切标签页的瞬间可能还没更新）。 */
async function pageInfo(session) {
  const cur = currentPage(session);
  if (cur.error) return Object.assign({ url: '', title: '', tabs: [] }, cur.error);
  const { page, st } = cur;
  try {
    const pages = st.context.pages();
    /* 标题各读各的，串行 await 会白等 (n-1) 个来回 —— 每步都要调一次 pageInfo */
    const titles = await Promise.all(pages.map((p) => p.title().catch(() => '')));
    const tabs = pages.map((p, i) => ({ index: i, current: p === page, title: titles[i], url: p.url() }));
    const me = tabs.find((t) => t.current);
    return { ok: true, url: me ? me.url : page.url(), title: me ? me.title : '', tabs };
  } catch (e) {
    return { ok: false, url: '', title: '', tabs: [], error: errText(e) };
  }
}

async function viewport(session) {
  const cur = currentPage(session);
  if (cur.error) return null;
  try { return await cur.page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight })); } catch (_) { return null; }
}

/* ---------------- 动作 ---------------- */

/* 定位器：与 CLI 的 aria-ref 选择器引擎同源（playwright-core 内置，见 coreBundle 的
 * _createAriaRefEngine）。所以进程内后端产出的 ref 与 CLI 后端**指同一批元素**。 */
function locatorOf(page, ref) {
  return page.locator('aria-ref=' + ref).first();
}

/* 动手前先确认这一页真的在渲染 —— 与 CLI 后端的 VISIBLE_FIRST_LINE 同一条判定
 * （见 browser-driver.js 的实测：后台专用标签页 visibilityState=hidden 时 rAF 被节流，
 * 动作的 actionability「stable」要连续两帧包围盒不变，等不到就是等到超时为止 ——
 * 实测 bringToFront 之后同一个元素 1.58s 点成功）。**只在确实不可见时才提前台**：
 * 用户正看着我们这一页时不抢焦点，否则屏幕上会乱跳。
 * 读不到就算了，照旧往下走 —— 动作自己会报超时，别在这里把错误提前。 */
async function ensureVisible(page) {
  if (!page || page.isClosed()) return;
  try {
    if (await page.evaluate(() => document.visibilityState) !== 'visible') await page.bringToFront();
  } catch (_) { /* noop */ }
}

/* 截图失败里哪些值得重试：**只有超时**（判定与 browser-driver.js 的 SHOT_TIMEOUT_RE 逐字相同，
 * 但那份没在 shared 面上，这里只能自己留一份）。重试的理由同 CLI 老路：这张图是标注与人眼
 * 复核的唯一凭据，丢一次整步就没图了；丢标签页/弹窗这类失败重试没意义，只是白等一个超时。 */
const SHOT_TIMEOUT_RE = /TimeoutError|timeout|超时/i;

/* 动作派发。抛出的错误由调用方 errText 收口。
 * `ref` 为 null 的动作（goto / reload / press / 标签页类 / 弹窗类）不走定位器。 */
async function runAction(st, command, ref, text) {
  const page = st.page;
  const timeout = shared.ACTION_TIMEOUT_MS;
  const loc = ref ? locatorOf(page, ref) : null;
  switch (command) {
    case 'click': return loc.click({ timeout });
    case 'fill': return loc.fill(text == null ? '' : text, { timeout });
    case 'type': return loc.pressSequentially(text == null ? '' : text, { timeout });
    case 'select': return loc.selectOption(text == null ? '' : text, { timeout });
    case 'check': return loc.check({ timeout });
    case 'uncheck': return loc.uncheck({ timeout });
    case 'hover': return loc.hover({ timeout });
    case 'upload': {
      /* OPS 里 upload 只有 text（文件路径）、**不接受 ref**，与 CLI 的 `upload <file>` 同形。
       * CLI 那边打到哪个文件框由它自己决定；进程内等价做法是页面上第一个 file input。
       * 路径安全性由 driver 的 uploadPathAllowed 把关（只允许 data/ 内的文件），
       * 那道校验在 act() 里、两条后端共用，这里只管把文件塞进去。 */
      const input = page.locator('input[type=file]').first();
      await input.setInputFiles(String(text), { timeout });
      return null;
    }
    case 'press':
      /* OPS 里 press 不接受 ref（全局按键，如 Escape / Enter），发给页面键盘 ——
       * 与 playwright-cli 的 press 语义一致。validateAct 会拒掉带 ref 的 press，
       * 所以这里不存在「发给某个元素」的分支。 */
      await page.keyboard.press(String(text));
      return null;
    case 'tab-list':
      /* 显式空操作（**不是**疏漏）：CLI 后端下这条会真跑一次 tab-list，但 auto.js 的
       * executeDecision 并不消费 act 的 result —— 标签页列表是在**下一步**的
       * page-info 里进 state 的（AUTO_TOOLS 对这条的说明也写着「结果会并入下一步骤的上下文」）。
       * 所以进程内直接认成功即可，省掉一次纯浪费的往返，语义完全一致。 */
      return null;
    case 'goto': return page.goto(String(text), { waitUntil: 'load', timeout });
    case 'go-back': return page.goBack({ timeout });
    case 'go-forward': return page.goForward({ timeout });
    case 'reload': return page.reload({ timeout });
    case 'tab-new': {
      const p2 = await st.context.newPage();
      ownPage(p2, st);
      st.page = p2;
      if (text) await p2.goto(String(text), { waitUntil: 'load', timeout });
      return null;
    }
    case 'tab-select': {
      const idx = Number(text);
      const pages = st.context.pages();
      const target = pages[idx];
      if (!target) throw new Error('没有第 ' + idx + ' 个标签页（当前共 ' + pages.length + ' 个）');
      /* 附身模式下**不许选用户自己的页**：复用 CLI 后端那份纯函数判定。
       * 拿不到基线（preExisting 为空）时不拦 —— 与 CLI 后端同一条规矩。 */
      const refuse = shared.tabSelectRefusal(st.preExisting, target.url());
      if (refuse) throw new Error(refuse.error);
      /* 切过去就**认领**（与 CLI 后端的 markOwnTab 同一条规矩：tab-select 之后那个浏览
       * 上下文就是我们的当前页）。这也统一了本文件自己的口径 —— tab-close 的接替者只在
       * st.ownedPages 里找，这里若不认领，切过去的页下一条命令就会被守卫判成「不是我们的」
       * 而停手。防「动到用户页面」的那道闸是上面的 tabSelectRefusal，不是所有权集合。 */
      st.ownedPages.add(target);
      st.page = target;
      await target.bringToFront();
      return null;
    }
    case 'tab-close': {
      const pages = st.context.pages();
      const idx = text == null || text === '' ? pages.indexOf(st.page) : Number(text);
      const target = pages[idx];
      if (!target) throw new Error('没有第 ' + idx + ' 个标签页');
      if (target === st.page) {
        const rest = pages.filter((p) => p !== target);
        await target.close();
        /* 接替者只在自己人的页里找：附身模式下相邻的多半是**用户自己的**标签页，
         * 把 st.page 落到它上面等于把「当前页」交到人家手里、后面的动作就往人家页面上动。
         * 找不到自己人就保持指向已关闭的那一页，由 currentPage 报「专用标签页已不在」停手
         * （与 rest 为空时同一语义：CLI 那边也是切到相邻页后靠守卫停手）。 */
        const next = rest.find((p) => st.ownedPages.has(p));
        if (next) st.page = next;
        st.ownedPages.delete(target);
        return null;
      }
      await target.close();
      st.ownedPages.delete(target);
      return null;
    }
    case 'dialog-accept':
    case 'dialog-dismiss': {
      const d = st.pendingDialog;
      if (!d) throw new Error('当前没有待处理的对话框');
      st.pendingDialog = null;
      if (command === 'dialog-accept') await d.accept(text == null ? undefined : String(text));
      else await d.dismiss();
      return null;
    }
    default:
      /* 白名单已经在 validateAct 里把关，走到这里只可能是两条后端的白名单漂移了 */
      throw new Error('进程内后端未实现的动作：' + command);
  }
}

/* 动作之后「等页面稳定」+ 取快照。语义与 CLI 后端逐条对齐（见 browser-driver.js 的
 * settleAndSnapshotLines）：静默期在**摘监听之前**等（静默期内才发出的 debounce 请求
 * 也算这个动作引出来的）→ 有导航则等 load，否则等动作期间发出的请求（上限 5s）→
 * 再静默一次 → 取快照（自己的上限 10s）。
 * 任何一步出岔子都只当「这次没取到」，**绝不把动作的成功改写成失败** ——
 * 动作已经做成了，下一步真取一次快照即可。
 * wantSnap=false（动作不在快照白名单里，见 act()）：等稳定照做，只是不取快照。 */
async function settleAndSnapshot(page, reqs, st, wantSnap) {
  try {
    if (!page.isClosed()) await page.waitForTimeout(shared.SETTLE_MS);
    if (st.pendingDialog) return null;
    if (reqs.some((r) => r.isNavigationRequest())) {
      await page.mainFrame().waitForLoadState('load', { timeout: shared.SETTLE_NAV_MS }).catch(() => {});
    } else {
      const waits = reqs
        .filter((r) => ['document', 'stylesheet', 'script', 'xhr', 'fetch'].indexOf(r.resourceType()) >= 0)
        .map((r) => r.response().then((x) => x && x.finished()).catch(() => {}));
      await Promise.race([Promise.all(waits), page.waitForTimeout(shared.SETTLE_REQ_CAP_MS)]);
      if (reqs.length) await page.waitForTimeout(shared.SETTLE_MS);
    }
    if (st.pendingDialog) return null;
    /* 不在快照白名单里的动作：稳定已经等到了，快照就别取了 —— 结果一定要丢，多打一次
     * 只是白花一次页面往返（对调用方不可观察）。 */
    if (!wantSnap) return null;
    return await Promise.race([
      page.ariaSnapshot({ mode: 'ai' }),
      page.waitForTimeout(shared.SNAPSHOT_CAP_MS).then(() => null),
    ]);
  } catch (_) {
    return null;
  }
}

/* act：**白名单硬校验走共享的那份**（validateAct），两条后端不许各写一份。
 * 返回形状必须保持 {ok, result, snapshot} —— 前端 snapshotCarrier 靠 act.snapshot
 * 省掉下一步的取快照。失败路径**不要**带 snapshot：失败步的快照时点必须与改动前一致，
 * 否则失败原因（弹窗 / 被遮挡）会被上一份快照盖掉。 */
async function act(session, command, ref, text) {
  const cmd = String(command == null ? '' : command);
  let v;
  try {
    v = shared.validateAct(cmd, ref, text);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  /* 与 CLI 后端同一条安全限制（browser-driver.js 的 act 里也有这一道）：
   * upload 只允许 data/ 目录内的文件，防「读任意本地文件 → 经页面文件框外发」。
   * 两条后端共用同一个 uploadPathAllowed，别在这里另写一份路径判断。 */
  if (v.op === 'upload' && v.text != null && !shared.uploadPathAllowed(getDataDir(), v.text)) {
    return { ok: false, error: 'upload 只允许 data/ 目录内的文件（安全限制），收到：' + String(v.text).slice(0, 120) };
  }

  /* 弹窗处理类动作**不需要页面**（也就没有「页丢了」可言）：弹窗挂着时页面调用全挂住，
   * 只有这两条能把局面解开。所以它们排在 currentPage 之前。 */
  const st0 = state(session);
  if (st0 && (v.op === 'dialog-accept' || v.op === 'dialog-dismiss')) {
    try {
      await runAction(st0, v.op, v.ref, v.text);
      return { ok: true, result: '', snapshot: null };
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
  }

  const cur = currentPage(session);
  if (cur.error) return cur.error;
  const st = cur.st;
  /* 弹窗挂着时页面调用会挂住（实测 >6s 不返回），读类一律直接拒绝 —— 与 CLI 后端
   * 的 MODAL_SAFE_COMMANDS 同一条规矩：标签页类命令在弹窗期间会真的改「当前标签页」，
   * 判不了归属就不动手。 */
  if (st.pendingDialog) return { ok: false, error: MODAL_SNAPSHOT_ERROR };

  /* 动手前确认自己在渲染（见 ensureVisible）：后台标签页里每次 click/fill 都要白等满
   * ACTION_TIMEOUT_MS 才失败。放在这里而不是 runAction 里 —— 弹窗类动作走的是上面那条
   * 早退分支，那边不能插 evaluate（弹窗挂着时页面调用会挂住）。 */
  await ensureVisible(st.page);

  /* 请求监听挂在**动作之前**：settle 要等的正是「这个动作自己引出来的请求」。
   * 记下挂在哪一页上 —— tab-new / tab-select / tab-close 会把 st.page 换掉，
   * 摘监听必须摘原来那一页，否则新页上会永久留一个监听器。 */
  const listenPage = st.page;
  const reqs = [];
  const onReq = (r) => reqs.push(r);
  listenPage.on('request', onReq);
  try {
    let actErr = null;
    const actP = runAction(st, v.op, v.ref, v.text)
      .then(() => 'DONE', (e) => { actErr = e; return 'DONE'; });
    /* 与「弹窗事件」赛跑：Playwright 的 click 在弹窗未处理时会一直挂着（实测 8s 超时），
     * 但动作**确实已经做成了**（弹窗就是它弹出来的）。弹窗先到就立刻按成功返回，
     * 不带快照 —— 下一步的 snapshot 会认出弹窗态，转成「弹窗步」交给 Jev 决定。
     * 那条挂着的 actP 不再 await：它的成功/失败都与本步结论无关（两个分支都已收成
     * 字符串，不会变成 unhandled rejection）；实测弹窗被 accept 之后它会自己 resolve。 */
    const dialogP = new Promise((res) => { st.dialogSignal = () => res('DIALOG'); });
    const winner = await Promise.race([actP, dialogP]);
    if (winner === 'DIALOG' || st.pendingDialog) {
      return { ok: true, result: '', snapshot: null };
    }
    if (actErr) return { ok: false, error: errText(actErr) };
    /* 动作后的快照只交给**动作自身完成条件已包住页面更新**的那些动作（白名单经 shared 注入，
     * 与 CLI 老路是同一张表，别在这里再抄一份字面量）：fill / hover / select / uncheck /
     * type / go-back / go-forward 拿到的是「半路」快照 —— 顶替下一步依据等于让模型看着
     * 上一页做决策。settle 一步都不省（那是两条后端「动作已完成」的等价物），只是这种动作
     * 不再多打一次 ariaSnapshot：那条结果本来就要丢掉，省掉它对调用方不可观察。 */
    const wantSnap = Boolean(shared.SNAPSHOT_TRUSTED_ACTIONS && shared.SNAPSHOT_TRUSTED_ACTIONS[v.op]);
    const snapText = await settleAndSnapshot(st.page, reqs, st, wantSnap);
    return { ok: true, result: '', snapshot: wantSnap ? snapOf(snapText) : null };
  } finally {
    st.dialogSignal = null;
    if (!listenPage.isClosed()) listenPage.off('request', onReq);
  }
}

/* ---------------- 截图 / 矩形 ---------------- */

/* 截图 + 读矩形合并成一次调用（进程内两者本来就是同一次往返内的两个小操作）。
 * 位置与截图取自**同一时刻、且都在动作之前** —— 这是刻意的：演示页「归档」「删除」
 * 点完就重渲染、ref 立刻失效，放到动作后取位置会一条都标不出来。
 * 输出形状与 CLI 后端一致：{ok, dataUrl, rect, viewport}。 */
async function screenshot(session, name, ref) {
  const cur = currentPage(session);
  if (cur.error) return cur.error;
  const st = cur.st;
  if (st.pendingDialog) return { ok: false, error: MODAL_SNAPSHOT_ERROR };
  const file = String(name || 'shot').replace(/[^A-Za-z0-9_-]/g, '') + '.png';
  const abs = path.join(getDataDir(), file);
  /* 后台标签页的截图同样会卡在渲染上（CLI 那条路是在截图前先判可见性、超时再兜一次） */
  await ensureVisible(st.page);
  try {
    /* scale:'css' 不能省：CLI 的 screenshot 默认就是 CSS 像素档（--hires 才是设备像素），
     * 标注几何按 CSS 像素换算。不指定会在 dpr≠1 的机器上拿到设备像素图，标注整片偏掉。 */
    await st.page.screenshot({ path: abs, scale: 'css' });
  } catch (e) {
    /* 只重试一次，且**只有超时**值得重试（同上）：两次都超时就如实报失败，不装成功。 */
    if (!SHOT_TIMEOUT_RE.test(errText(e))) return { ok: false, error: errText(e) };
    try { await st.page.screenshot({ path: abs, scale: 'css' }); }
    catch (e2) { return { ok: false, error: errText(e2) }; }
  }
  let out;
  try {
    out = { ok: true, dataUrl: 'data:image/png;base64,' + fs.readFileSync(abs).toString('base64') };
  } catch (_) {
    return { ok: false, error: '截图文件读取失败（预期路径 ' + abs + '）' };
  }
  /* 位置读不到只是标不出框，不影响这张图（与 CLI 后端同一条判定） */
  if (ref && shared.REF_RE.test(String(ref))) {
    const pos = await readRect(st, String(ref));
    if (pos) { out.rect = pos.rect; out.viewport = pos.viewport; }
  }
  return out;
}

/* RECT_SNIPPET 在 driver 那边是**字符串形式的箭头函数**（CLI 的合并命令把它拼进生成的
 * 代码里，当函数字面量用）。进程内不能直接把它交给 locator.evaluate —— 字符串会被当成
 * **表达式**求值，拿到的是函数对象而不是它的返回值（实测：rect 恒为 undefined）。
 * 所以在这里把它还原成真函数，片段仍是同一份（唯一权威，别在本地重写一份几何读取）。 */
let rectFnCache = null;
function rectFn() {
  if (!rectFnCache) rectFnCache = new Function('return (' + shared.RECT_SNIPPET + ');')();
  return rectFnCache;
}

async function readRect(st, ref) {
  if (st.pendingDialog) return null;
  try {
    const csv = await locatorOf(st.page, ref).evaluate(rectFn());
    /* 解析走共享的那份（唯一权威）—— 进程内拿到的是真字符串，不像 CLI 那样被
     * 再 JSON 序列化一层，但 parseRectCsv 两种输入都吃。 */
    return shared.parseRectCsv(csv);
  } catch (_) {
    return null;
  }
}

async function rect(session, ref) {
  const r = String(ref == null ? '' : ref);
  if (!shared.REF_RE.test(r)) return { ok: false, error: '读元素位置需要合法 ref（形如 e12），收到：' + JSON.stringify(r.slice(0, 40)) };
  const cur = currentPage(session);
  if (cur.error) return cur.error;
  if (cur.st.pendingDialog) return modalError();
  const pos = await readRect(cur.st, r);
  if (!pos) return { ok: false, error: '元素位置读不到（ref 可能已失效）' };
  return { ok: true, rect: pos.rect, viewport: pos.viewport };
}

/* ---------------- 窗口 ---------------- */

/* 窗口类动作只对我们自己起的实例有意义：附身模式下改的是用户的窗口与视口。
 * 判定复用 CLI 后端同一句话（server.js 也按 ok/error 原样显示）。 */
function cdpRefusal(st) {
  return st && st.mode === 'cdp'
    ? { ok: false, error: 'CDP 模式不改动你的浏览器窗口（resize / fullscreen / 最大化都只对我们自己起的实例生效）' }
    : null;
}

async function resize(session, w, h) {
  const cur = currentPage(session);
  if (cur.error) return cur.error;
  const refuse = cdpRefusal(cur.st);
  if (refuse) return refuse;
  const size = shared.parseWindowSize(w, h);
  if (!size) return { ok: false, error: '窗口尺寸必须是 200~10000 的整数（收到 ' + JSON.stringify(String(w)) + '×' + JSON.stringify(String(h)) + '）' };
  try {
    await cur.st.page.setViewportSize({ width: size.w, height: size.h });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

/* 真·全屏：与 CLI 后端同一条路径（CDP Browser.setWindowBounds），只是不再起进程。
 * 为什么不用启动参数：实测 --start-fullscreen / --kiosk 会被 Chrome 忽略，
 * 只有这条可靠（详见 browser-driver.js 里的 FULLSCREEN_SNIPPET 注释）。 */
async function fullscreen(session) {
  const cur = currentPage(session);
  if (cur.error) return cur.error;
  const refuse = cdpRefusal(cur.st);
  if (refuse) return refuse;
  try {
    const cdp = await cur.st.page.context().newCDPSession(cur.st.page);
    const info = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId: info.windowId, bounds: { windowState: 'fullscreen' } });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

/* ---------------- 状态 ---------------- */

function available() {
  const chromium = (loadPlaywright() || {}).chromium;
  if (!chromium) return { ok: false, version: null, error: '无法加载 playwright-core：' + (pwError || '未知原因') };
  return { ok: true, version: pwVersion, error: null };
}

function isOpen(session) {
  const st = state(session);
  return Boolean(st && st.page && !st.page.isClosed());
}

const api = {
  open, close, snapshot, pageInfo, act, rect, screenshot,
  viewport, fullscreen, resize, available, isOpen, state,
  MODAL_SNAPSHOT_ERROR,
};

module.exports = { createInprocBackend, MODAL_SNAPSHOT_ERROR };
