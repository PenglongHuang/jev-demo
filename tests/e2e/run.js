/* ===================== playwright-jev-agent · E2E 复杂场景验收 =====================
 * 前置：node server.js 已在本机 3000 端口运行；playwright-cli 已安装。
 * 模式：
 *   E2E_UPSTREAM=mock（默认）—— 配置页指向本地 oracle mock（真实协议形状，
 *     逐请求校验前端 state/问题构造契约），LLM 走本地 OpenAI 兼容 mock；
 *   E2E_UPSTREAM=real + TYPESAFE_API_KEY=... —— 同一流程直连真实 Jev 官网。
 *
 * 场景：
 *   S1 连续模式 · 归档 9 月对账单（干扰项必须保留）
 *   S2 连续模式 · 搜索邮件（生成输入 → LLM → fill 闭环）
 *   S3 单步确认 · 归档（逐轮人工代理点「执行本步」）
 *   S4 步数上限=2 · 不可完成任务 → 触发上限终止
 *   S5 原生弹窗 · 删除邮件（click 触发 confirm → 快照被拒 → 弹窗步 dialog-accept）
 *   S6 订单后台 · select 的「文本」补问（候选=下拉框真实选项，事故场景回归）
 *   S7 哨兵标签回归（参数归一后标签不残留「其他 · 展开下一批」）
 *   S8 外层就地编辑 + 错误条（可选中/可复制/可收起）
 * 运行：node tests/e2e/run.js   （或 npm run test:e2e）
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const driver = require(path.join(__dirname, '..', '..', 'browser-driver.js'));
const { parseSnapshotRefs } = require(path.join(__dirname, '..', '..', 'public', 'js', 'util.js'));
const { pngHasPixel, pngPixels } = require(path.join(__dirname, '..', 'png-pixels.js'));
const { startMocks } = require('./mock-server');

const ORIGIN = process.env.E2E_ORIGIN || 'http://localhost:3000';
const UPSTREAM = process.env.E2E_UPSTREAM || 'mock';
/* E2E 跑哪个内核：默认跟随应用默认（chrome），JEVDEMO_BROWSER=msedge 可覆盖。
 * 原先写死 msedge，每次验收都会弹 Edge。 */
const BROWSER = process.env.JEVDEMO_BROWSER || 'chrome';
/* 只跑指定场景（E2E_ONLY=s5 / s1,s3）：调试或复核单个场景时避免整套弹窗打扰 */
const ONLY = (process.env.E2E_ONLY || '').toLowerCase();
const want = (id) => !ONLY || ONLY.split(',').map((s) => s.trim()).includes(id);
const UI = 'e2eui';                       /* 我方驱动 playground 页的 playwright 会话 */
const EVID_DIR = path.join(__dirname, '..', '..', 'docs', 'superpowers', 'evidence');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  console.log((ok ? 'PASS' : 'FAIL') + ' · ' + name + (detail ? ' — ' + detail : ''));
}

/* ---------- playwright 裸调用（仅测试工具用：eval 等 driver 白名单外命令） ---------- */
function rawExec(args) {
  const { quoteArg } = driver._test;
  return new Promise((resolve) => {
    const line = ['playwright-cli', '-s=' + UI].concat(args.map(quoteArg)).join(' ');
    const child = spawn(line, { shell: process.platform === 'win32', cwd: driver.dataDir, windowsHide: true });
    let out = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) { /* noop */ }
      resolve(out + '\n[E2E rawExec 超时 60s 被杀]');
    }, 60000);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('error', (e) => { clearTimeout(timer); resolve(out + '\n[E2E rawExec 启动失败] ' + e.message); });
    child.on('close', () => { clearTimeout(timer); resolve(out); });
  });
}

/* ---------- 页面操作辅助（真实 UI 路径：快照 → 找 ref → act） ---------- */
async function snapUI() {
  const r = await driver.snapshot(UI);
  if (!r.ok) throw new Error('playground 快照失败：' + r.error);
  return r.snapshot;
}
function findRefs(snapshotText, matcher) {
  return parseSnapshotRefs(snapshotText).filter((r) => matcher.test(r.label));
}
async function clickLabel(matcher, nth) {
  let hit = await findLabel(matcher, nth);
  if (!hit) throw new Error('UI 上找不到控件：' + matcher);
  const r = await driver.act(UI, 'click', hit.ref, null);
  if (!r.ok) throw new Error('click ' + hit.ref + ' 失败：' + r.error);
  await sleep(400);
  return hit;
}
/* AX 快照偶发取到 DOM 更新中的瞬间（实测：S5 setTask 时一次快照里没有
 * 「⚙ 运行参数」）—— 找不到时重试一次再判缺失，两拍都空才算真没有。 */
async function findLabel(matcher, nth) {
  let snap = await snapUI();
  let refs = findRefs(snap, matcher);
  let hit = refs[nth == null ? 0 : nth];
  if (hit) return hit;
  await sleep(900);
  snap = await snapUI();
  refs = findRefs(snap, matcher);
  hit = refs[nth == null ? 0 : nth];
  if (!hit) {
    fs.writeFileSync(path.join(EVID_DIR, 'findlabel-miss-flat.txt'), snap, 'utf8');
    throw new Error('UI 上找不到控件：' + matcher + '（快照 ' + snap.length + ' 字符已存证）');
  }
  return hit;
}
async function fillLabel(matcher, text, nth) {
  const hit = await findLabel(matcher, nth);
  const r = await driver.act(UI, 'fill', hit.ref, text);
  if (!r.ok) throw new Error('fill ' + hit.ref + ' 失败：' + r.error);
  await sleep(300);
  return hit;
}

/* ---------- 服务端任务浏览器（与前端循环同一 IP 会话） ----------
 * 注意：node fetch 与页面 fetch 的源 IP 可能落在不同协议栈（::1 vs 127.0.0.1），
 * IP 哈希出的会话名就不同。验证一律从 playground 页面内部发请求（pageApi），
 * 与循环自身完全同源。 */
const api = (p, body) => fetch(ORIGIN + p, {
  method: body ? 'POST' : 'GET',
  headers: { 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
}).then((r) => r.json());

/* 页内取值唯一通道：把一段 JS 交给 playwright-cli 的 eval，结果走 base64 标记回来。
 * 标记通道是为了避开 CLI 的引号封装与 stdout 转义歧义。pageApi（页内发请求）与
 * uiProbe（页内读 DOM）都走它 —— 此前两处各写一遍这 10 行，通道一旦要修就会漏一处。 */
async function evalInPage(js, label) {
  const out = await rawExec(['eval', js, '--json']);
  const env = driver._test.parseEnvelope({ code: 0, stdout: out, stderr: '' });
  if (!env.ok) throw new Error(label + ' eval 失败：' + env.error);
  const m = String(env.result).match(/E2ERES([A-Za-z0-9+/=]*)E2ERES/);
  if (!m) throw new Error(label + ' 无标记输出：' + String(env.result).slice(0, 160));
  return Buffer.from(m[1], 'base64').toString('utf8');
}

async function pageApi(path, bodyObj) {
  /* 请求体以单引号 JS 字面量嵌入（值仅含 ASCII 安全字符），页内再 JSON.stringify，
   * 避免外层 CLI 引号封装与双引号冲突；响应走 base64 通道避开转义歧义 */
  const lit = JSON.stringify(bodyObj === undefined ? {} : bodyObj).replace(/"/g, "'");
  const js = "fetch('" + path + "',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(" + lit + ")})"
    + ".then(function(r){return r.text()})"
    + ".then(function(t){return 'E2ERES'+btoa(unescape(encodeURIComponent(t)))+'E2ERES'})";
  const text = await evalInPage(js, 'pageApi');
  try { return JSON.parse(text); }
  catch (e) { throw new Error('pageApi 返回非 JSON：' + text.slice(0, 160)); }
}

async function taskSnapshot() {
  const r = await pageApi('/api/browser/snapshot', {});
  if (!r.ok) {
    /* 快照拿不到时最常见的两种死法（任务浏览器压根没开 / 运行中途挂了）在页面上各有一处证据：
     * pill 的 data-state 与错误条正文。不带上它们，现场只剩一句「The browser is not open」，
     * 看不出是没开成还是跑挂了 —— 实测就为此多花了一轮排查。 */
    let why = '';
    try {
      why = await uiProbe("(function(){var p=document.getElementById('autoRunPill'),b=document.getElementById('autoErrorBar');"
        + "return JSON.stringify({pill:p?String(p.dataset.state||''):'',错误条:(b&&!b.hidden)?document.getElementById('autoErrorBody').textContent.slice(0,240):''})})()");
    } catch (_) { /* 页面也读不到就只报原始错误 */ }
    throw new Error('任务浏览器快照失败：' + (r.error && r.error.message ? r.error.message : String(r.error || ''))
      + (why ? '；页面状态=' + why : ''));
  }
  return r.snapshot;
}

/* ---------- 右侧详情的页内探针 ----------
 * 详情区只渲染「当前选中的那一个节点」，aria 快照又是整页扁平文本（树上的标题会把
 * 断言喂饱），所以结构断言必须先点树、再在 DOM 上取值 —— 走与 pageApi 同一条 base64 标记通道。
 * 表达式可以是异步的（点节点后等两帧要返回 Promise）：先 await 再序列化，
 * 否则 Promise 会被 JSON.stringify 成 {}，取值静默变成 undefined。 */
async function uiProbe(expr) {
  const js = "Promise.resolve().then(function(){return (" + expr + ")})"
    + ".then(function(r){return 'E2ERES'"
    + "+btoa(unescape(encodeURIComponent(JSON.stringify(r))))+'E2ERES'})";
  return JSON.parse(await evalInPage(js, 'uiProbe'));
}

/* 按标题点树上的行动节点（多个命中取最后一个），等两帧让详情重建完 */
async function clickTreeNode(re) {
  return uiProbe("(function(){var t=document.querySelectorAll('.tn'),hit=null;"
    + "for(var i=0;i<t.length;i++){if((" + re + ").test(t[i].textContent))hit=t[i];}"
    + "if(!hit)return {ok:false};hit.click();"
    + "return new Promise(function(res){requestAnimationFrame(function(){requestAnimationFrame(function(){res({ok:true})})})})})()");
}

/* 详情区结构化取值：结论行 / 问题块 / 候选 / 作答卡 / 概率条 */
async function detailProbe() {
  return uiProbe("(function(){var q=function(s){return Array.prototype.map.call("
    + "document.querySelectorAll(s),function(n){return n.textContent.trim()})};return {"
    + "head:(document.getElementById('fdHead')||{}).textContent||'',"
    + "secHeads:q('.sec-head'),qNames:q('.qblock-name'),qMeta:q('.qblock-meta'),"
    + "chips:q('.crit-chip'),cardNames:q('.qcard-name'),conf:q('.qcard-conf'),"
    + "bars:q('.bar-row .bar-label'),verdict:q('.fu-hit')}})()");
}

/* 驱动页的截图工件落在 data/<session>.png，会话名由请求方 IP 哈希而来 —— 测试不去复刻
 * 那个哈希，按「比 since 更新」找本轮新写的那张即可。 */
/* 驱动页的截图工件落在 data/<name>.png。而全仓**唯一**的调用方是 auto.js 的
 * takeShot()，它总是传 name='step-N'（或 'step-N-final'）—— 已提交版本亦然。
 * 原先这里只认 jev*.png，而 jev<会话哈希>.png 只在调用方**不传 name** 时才由
 * server 兜底产生（server: payload.name ? name : session），全仓已无这样的调用方。
 * 后果：glob 永远匹配不到本轮文件 → pageClean 恒为 false → 「标注不许画进被驱动页面」
 * 这条不变量长期**无人看守**（S1 因此在我动手之前就是永久红）。
 * 两种形状都收；历史遗留文件由 mtime 过滤排掉。 */
function newestDrivenShot(sinceMs) {
  const dir = path.join(__dirname, '..', '..', 'data');
  return fs.readdirSync(dir)
    .filter((f) => /^(?:jev|step-).*\.png$/.test(f))
    .map((f) => ({ f: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .filter((x) => x.m >= sinceMs)
    .sort((a, b) => b.m - a.m)[0] || null;
}

/* 取出步骤卡里那张图本身（就是 img.src 的 dataURL）—— 断言与留证都用它。
 * 这是「人看到的那张图上真的有标注」唯一直接的证据：标注现在画在图上、不往被驱动
 * 页面注入节点，所以只能从卡片里的图取证。几何（data-anno）一并回传，便于排障。 */
async function cardShot() {
  const js = "(function(){var i=document.querySelector('.step-shot[data-anno]');"
    + "if(!i) return 'noanno';if(!/^data:image/.test(i.src)) return 'nosrc';"
    + "return i.dataset.anno+'@'+i.src;})()";
  const out = await rawExec(['eval', js, '--json']);
  const env = driver._test.parseEnvelope({ code: 0, stdout: out, stderr: '' });
  const raw = env.ok ? String(env.result == null ? '' : env.result).replace(/^"|"$/g, '') : '';
  const at = raw.indexOf('@');
  if (at < 0) return { dataUrl: '', anno: '', reason: raw || 'eval 无输出' };
  return { dataUrl: raw.slice(at + 1), anno: raw.slice(0, at), reason: '' };
}

/* 本轮最新一条运行记录（前端 auto.js 跑动中把 {meta,steps} PUT 落盘到 data/runs/<id>.json）。
 * 取 mtime 不早于本轮开始、且最新的一条；读不出来返回 null —— 调用方据此报红，
 * 不能让「记录没读到」悄悄变成「断言通过」。 */
function newestRunRecord(sinceMs) {
  const dir = path.join(__dirname, '..', '..', 'data', 'runs');
  let files;
  try { files = fs.readdirSync(dir); } catch (_) { return null; }
  const newest = files
    .filter((f) => /^r-.*\.json$/.test(f))
    .map((f) => ({ f: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .filter((x) => x.m >= sinceMs)
    .sort((a, b) => b.m - a.m)[0];
  if (!newest) return null;
  try { return JSON.parse(fs.readFileSync(newest.f, 'utf8')); } catch (_) { return null; }
}

/* 标注的**位置**断言。
 *
 * 为什么不能只断言「图里有标注色」：框整体画偏时颜色照样在（2026-09-28 修的那次偏移
 * 就是如此，颜色断言全绿、问题靠人眼看图才发现）。位置真值取本轮记录里那一步的
 * anno.rect —— 它与截图是同一时刻读的页内 getBoundingClientRect，而 css 档截图的内容
 * 与 CSS 像素同刻度（见 public/js/anno.js 文件头 3），所以框必须与 rect 逐字段相等，
 * 且确实落在图上。
 *
 * 边界：本用例的窗口是 100% 缩放（画布宽 == 视口宽），这条守的是「契约不被改坏」；
 * 「页面缩放 ≠100%（画布宽 == 视口宽/缩放）时也必须不偏」的复现与实测数字在
 * tests/anno.spec.js 的 B 站用例里。 */
function checkAnnoPosition(card, sinceMs) {
  const got = String(card.anno || '').split(',').map(Number).slice(0, 4);
  if (got.length < 4 || got.some((v) => !Number.isFinite(v))) {
    return { ok: false, detail: '卡片 data-anno 不合法：' + JSON.stringify(card.anno) };
  }
  const rec = newestRunRecord(sinceMs);
  if (!rec) return { ok: false, detail: '没找到本轮运行记录（data/runs 里 mtime >= 本轮开始的记录）' };
  const step = (rec.steps || []).find((s) => s.anno && s.anno.box && s.anno.rect);
  if (!step) return { ok: false, detail: '记录里没有「带标注几何」的步骤' };
  const r = step.anno.rect, vp = step.anno.viewport;
  const want = [r.x, r.y, Math.max(r.w, 8), Math.max(r.h, 8)];
  const same = want.every((v, i) => Math.abs(v - got[i]) <= 1);   /* 记录里的框是四舍五入过的整数 */
  const px = pngPixels(card.dataUrl);
  const inside = Boolean(px) && got[0] + got[2] > 0 && got[1] + got[3] > 0 && got[0] < px.w && got[1] < px.h;
  return {
    ok: same && inside,
    detail: '框=' + got.join(',') + ' 元素=' + want.join(',')
      + ' 视口=' + (vp ? vp.w + 'x' + vp.h : '?') + ' 图=' + (px ? px.w + 'x' + px.h : '?')
      + (same ? '' : ' ← 框没套在元素上') + (inside ? '' : ' ← 框不在图上'),
  };
}
async function resetMailbox() {
  const snap = await taskSnapshot();
  const refs = parseSnapshotRefs(snap).filter((r) => /重置演示/.test(r.label));
  if (!refs.length) throw new Error('任务浏览器里找不到「重置演示」');
  const r = await pageApi('/api/browser/act', { command: 'click', ref: refs[0].ref });
  if (!r.ok) throw new Error('重置失败：' + (r.error && r.error.message ? r.error.message : String(r.error || '')));
  await sleep(600);
}

/* ---------- 结束态：读页面语义属性，不解析展示文案 ----------
 * #autoRunPill 的 data-state 是展示层与 E2E 的公共契约（running/done/aborted/
 * giveup/limit/fails/error）。aria 快照只有文本、读不到 data-*，所以走页内 eval。
 * 这样将来再调 pill 文案（「已结束」→「任务已完成」之类）不会连带炸测试。 */
async function pillState() {
  const out = await rawExec(['eval',
    "(function(){var p=document.getElementById('autoRunPill');return p?String(p.dataset.state||''):''})()",
    '--json']);
  const env = driver._test.parseEnvelope({ code: 0, stdout: out, stderr: '' });
  const raw = env.ok ? String(env.result == null ? '' : env.result).trim() : '';
  /* eval 的返回值被 CLI 又 JSON 序列化了一次，字符串带引号（实测返回 "running"）。
   * 不剥掉的话 waitEnd 里 state !== 'running' 恒成立 —— 运行还没终结就返回，
   * 四个场景全部假失败。 */
  return raw.replace(/^"|"$/g, '');
}

/* ---------- 轮询等待运行终结 ----------
 * 以 pill 的 data-state 离开 running 为准 —— finishRun 必然写入该属性。
 * 不能匹配 banner/toast 文本：toast 是 aria-live status，上一场景的残留
 * 提示会在 2.2s 内造成假阳性。 */
async function waitEnd(tag, timeoutMs) {
  const t0 = Date.now();
  let lastLen = 0;
  let lastProgress = Date.now();
  while (Date.now() - t0 < (timeoutMs || 180000)) {
    await sleep(2500);
    const snap = await snapUI();
    const flat = snap.replace(/\s+/g, ' ');
    const state = await pillState();
    if (state && state !== 'running') {
      /* 上面那次快照可能早于 finishRun 落盘（本轮实测：pill 的 data-state 已是 limit，
       * 快照里还写着「运行中 / 第 2 / 2 步」）—— 终结后再取一次，拿到的才是终态 UI。 */
      const finalSnap = await snapUI();
      if (tag) fs.writeFileSync(path.join(EVID_DIR, tag + '-flat.txt'), finalSnap, 'utf8');
      return { flat: finalSnap.replace(/\s+/g, ' '), state };
    }
    if (snap.length !== lastLen) { lastLen = snap.length; lastProgress = Date.now(); }
    if (Date.now() - lastProgress > 45000) throw new Error('运行停滞超 45s（页面无变化）');
    if (/Jev 调用失败/.test(flat)) throw new Error('循环内 Jev 调用失败：' + flat.slice(flat.indexOf('Jev 调用失败'), flat.indexOf('Jev 调用失败') + 200));
  }
  throw new Error('等待运行终结超时（pill 的 data-state 仍为 running）');
}

async function saveShot(name) {
  const r = await driver.screenshot(UI, name);
  if (r.ok) {
    fs.mkdirSync(EVID_DIR, { recursive: true });
    fs.writeFileSync(path.join(EVID_DIR, name + '.png'), Buffer.from(r.dataUrl.split(',')[1], 'base64'));
  }
}

/* ---------- 配置（真实 UI 路径走配置弹窗；mock 模式把自定义 endpoint 指向 oracle） ---------- */
async function configureMock(sysonePort, llmPort) {
  await clickLabel(/官网 .*配置|API 配置|配置$/);          /* 顶栏按钮名：旧「官网 ⚙ 配置」/ 新 sr-only「API 配置 · 提供商」 */
  const prov = findRefs(await snapUI(), /combobox "提供商"/)[0];
  if (!prov) throw new Error('配置弹窗未打开（找不到「提供商」下拉）');
  const sel = await driver.act(UI, 'select', prov.ref, '自定义');
  if (!sel.ok) throw new Error('切换自定义提供商失败：' + sel.error);
  await sleep(500);
  await fillLabel(/textbox "接口地址"/, 'http://127.0.0.1:' + sysonePort + '/v1/systemone');
  await fillLabel(/"API Key"/, 'e2e-mock-key');
  await fillLabel(/"自定义模型名"/, 'jev-latest');
  /* 生成模型槽位是可折叠分节（默认收起）：不展开的话里面的输入框不在无障碍树里，
   * fillLabel 会直接报「找不到控件」。点一下标题行展开 —— 也顺便验了这条交互路径。 */
  await clickLabel(/生成模型/);
  await sleep(400);
  await fillLabel(/"Base URL"/, 'http://127.0.0.1:' + llmPort + '/v1');
  await fillLabel(/"API Key"/, 'mock-llm-key', 1);        /* 第二个 API Key = 生成模型槽位 */
  await fillLabel(/"模型名"/, 'mock-llm');                /* 生成模型名 */
  await clickLabel(/保存并应用/);
  /* 确认弹窗真的关上（save 早退会留弹窗 + toast 提示原因） */
  for (let i = 0; i < 10; i++) {
    await sleep(400);
    const st = await rawExec(['eval', "(function(){var m=document.getElementById('configModal');return 'MODAL hidden='+(m&&m.hidden)+' toast='+(document.getElementById('toast').textContent||'').slice(0,60)})()", '--json']);
    const env = driver._test.parseEnvelope({ code: 0, stdout: st, stderr: '' });
    const info = String(env.result || '');
    if (/hidden=true/.test(info)) return;
    if (i === 9) throw new Error('配置弹窗未能关闭：' + info.replace(/^MODAL /, ''));
  }
}

/* ===================== 主流程 ===================== */
(async () => {
  fs.mkdirSync(EVID_DIR, { recursive: true });
  const mocks = UPSTREAM === 'mock' ? await startMocks() : null;

  /* 打开 playground */
  const opened = await driver.open(UI, ORIGIN, { browser: BROWSER });
  if (!opened.ok) throw new Error('打开 playground 失败：' + opened.error);
  /* 实际内核可能与请求的不同（driver 在首选内核启动失败时会静默换另一个），先亮出来 */
  console.log('内核：' + opened.browser);
  await sleep(1200);

  if (mocks) {
    await configureMock(mocks.sysonePort, mocks.llmPort);
    record('配置 · 提供商指向 oracle mock + 生成模型槽位', true, 'sysone=' + mocks.sysonePort + ' llm=' + mocks.llmPort);
  }

  /* 进入 playwright-jev-agent 面板（顶栏 Tab） */
  await clickLabel(/playwright-jev-agent/);
  await sleep(400);

  const GOAL_ARCHIVE = '在收件箱里找到招商银行信用卡中心发来的 9 月电子对账单邮件，点击那一行的「归档」按钮';
  const DEMO_URL = ORIGIN + '/demo/mailbox.html';

  /* ---------- 任务配置：主字段在外层就地编辑，运行参数（步数/节奏）在 #taskModal 弹窗里 ----------
   * 任务目标 / 起始 URL 直接 fillLabel 即可；只有要改步数上限或节奏时才开门、关窗。
   * 关窗仍要轮询：保存失败时弹窗不关，而此时原因写在页面顶部的 #autoErrorBar（可复制），
   * 不把它带出来就只会看到后续找不到控件的二次报错。 */
  async function setTask(opts) {
    await fillLabel(/"任务目标"/, opts.goal);
    await fillLabel(/"起始 URL"/, opts.url);
    if (opts.maxSteps == null && !opts.cadence) return;
    await clickLabel(/⚙ 运行参数/);
    await sleep(500);
    if (opts.maxSteps != null) await fillLabel(/"步数上限"/, String(opts.maxSteps));
    if (opts.cadence) await clickLabel(new RegExp('"' + opts.cadence + '"'));
    await clickLabel(/保存并应用/);
    for (let i = 0; i < 10; i++) {
      await sleep(300);
      const st = await rawExec(['eval',
        "(function(){var m=document.getElementById('taskModal');var e=document.getElementById('autoErrorBar');"
        + "return 'TASK hidden='+(m&&m.hidden)+' err='+((e&&!e.hidden)?e.textContent:'')})()", '--json']);
      const env = driver._test.parseEnvelope({ code: 0, stdout: st, stderr: '' });
      const info = String(env.result || '');
      if (/hidden=true/.test(info)) return;
      if (i === 9) throw new Error('运行参数弹窗未能保存关闭：' + info.replace(/^TASK /, ''));
    }
  }

  /* ---------- S9 · UX 不变量（14 项修复的回归护栏） ----------
   * 全部走 uiProbe（页内 JS 探针），不跑任务、不依赖 mock —— 只验 DOM 与几何。
   * 单独调试：E2E_ONLY=s9 node tests/e2e/run.js
   * Wave 0 写入时**应当全红**；Wave 1 的 Agent 把它改绿。
   * 位置必须在 S1 之前，两个理由：① S9.3 要验「运行流水空态文案」，
   * 只有本会话还没跑过任何任务时 #autoFlow .out-empty 才存在；
   * ② S9.10 要验「空闲时关闭浏览器不可点」，必须在 S1 打开任务浏览器之前跑。
   * 条目 8 与 11 没有探针：8 由 tests/runs-retention.spec.js 覆盖，
   * 11 需要真在跑的循环（S9 不跑任务），走代码审查。 */
  if (want('s9')) try {
    const S9_ID = 'r-0909-0909-s9ux';
    /* 先造一条确定性的合成记录：5、7、9、14 需要「有历史会话、且某步有多个行动」。
     * 记录名带 s9ux 便于识别；本块结尾会删掉，不给真实 data/runs 留垃圾。 */
    /* steps 必须带 payload：AutoCore.actionsOf 只在 payload（或 request）存在时才产出
     * 「首轮」行动 —— 不给 payload 的话每步 0 个行动，S9.7 就永远量不到东西。 */
    const mkStep = (n, acts) => ({
      n,
      label: acts > 1 ? 'click 【e' + n + ' · 目标元素】' : 'click 【e' + n + ' · 另一个挺长的元素名】',
      decision: { action: 'click', param: 'e' + n },
      exec: { cmd: 'playwright-cli click e' + n, ok: true, elapsedMs: 900 + n },
      payload: { state: {}, model: 'm', questions: { 动作: {}, 参数: {}, 未完成: {} } },
      followUps: acts > 1 ? [{
        kind: 'text', forAction: 'fill', text: '关键词',
        payload: { state: {}, model: 'm', questions: { 文本: {} } },
        response: null, error: null,
      }] : [],
      screenshot: null, refLabels: {},
    });
    const mkRec = {
      meta: {
        id: S9_ID, goal: 'S9 UX 不变量合成记录', endState: 'done', stepCount: 11,
        startedAt: '2026-09-09T09:09:00Z', endedAt: '2026-09-09T09:10:00Z', variables: [],
      },
      /* 第 2 步 2 个行动（首轮 + 补问），其余 1 个 —— 正好检验「单行动不渲染子行」 */
      steps: Array.from({ length: 11 }, (_, i) => mkStep(i + 1, i === 1 ? 2 : 1)),
    };
    await uiProbe("fetch('/api/runs/" + S9_ID + "',{method:'PUT',headers:{'Content-Type':'application/json'},"
      + "body:JSON.stringify(" + JSON.stringify(mkRec).replace(/"/g, "'") + ")}).then(function(r){return r.status})");

    /* --- 入口 A：Demo 模式。先显式载入一个含长快照的预设 ——
       S9.1（字段自适应）与 S9.13（删问题撤销）都依赖「预设已载入」，
       不能靠上一个场景的残留状态。 --- */
    const s9a0 = await uiProbe("(function(){"
      + "var segs=document.querySelectorAll('#modeSeg .seg-btn');"
      + "for(var i=0;i<segs.length;i++)if(segs[i].dataset.mode==='demo')segs[i].click();"
      + "return new Promise(function(res){setTimeout(function(){"
      + "var chips=document.querySelectorAll('#presets .chip'),hit=null;"
      + "Array.prototype.forEach.call(chips,function(c){if(/邮箱收件箱/.test(c.textContent))hit=c});"
      + "if(hit)hit.click();"
      + "setTimeout(function(){res({预设已载入:!!hit,问题数:"
      + "document.querySelectorAll('#qList .q').length})},600)},300)})})()");
    /* 前置条件单独记一条：它红了的话，S9.1/S9.4/S9.13 的结论都不成立，
     * 不该让它的失败藏在别人的 detail 里。 */
    record('S9.0 前置：Demo 预设（含长快照）已载入',
      s9a0.预设已载入 && s9a0.问题数 > 0,
      '预设=' + (s9a0.预设已载入 ? '已载入' : '未载入') + '；问题数=' + s9a0.问题数);

    /* 条目 4：主操作必须在首屏内**可达**。
     * 交付形态是「顶栏常驻发送按钮」，所以这里断言的是「它与卡片按钮同源可用」，
     * 而**不是**卡片按钮的位置 —— 卡片按钮在 state 卡之下，结构上必然在折线之外，
     * 那正是顶栏按钮存在的理由（且条目 1 修好后 state 卡会更高，它只会更靠下）。
     * 点击走的是真 send()：用桩替换 window.fetch 拦住 /api/systemone，
     * 既不打扰 oracle mock 的构造契约统计，又能观察到「答案区确实被驱动了」。
     *
     * ⚠️ 探针串里**绝不能出现双引号、百分号或换行** —— rawExec 的 quoteArg 会直接拒绝
     * （报「参数含有不允许的字符」），整块 S9 会当场崩在这里。这就是既有 pageApi
     * 要 `.replace(/"/g, "'")` 的原因。所以桩响应故意返回**空文本**（不需要 JSON 的引号）：
     * send() 会走 `if (!rawText.trim())` 那条分支，把错误摊进答案区，效果一样。 */
    const s9a = await uiProbe("(function(){"
      + "var st=document.getElementById('sendTop');"
      + "var send=document.getElementById('send');"
      + "if(!st||!send)return {错误:'按钮不存在'};"
      + "var seen=[];var of=window.fetch;"
      + "window.fetch=function(u){var url=String(u);"
      + "if(url.indexOf('/api/systemone')!==-1){seen.push(url);"
      + "return Promise.resolve({ok:false,status:418,"
      + "text:function(){return Promise.resolve('')}});}"
      + "return of.apply(this,arguments)};"
      + "var pane=document.getElementById('paneAnswers');"
      + "var before=pane.textContent;"
      + "st.click();"
      + "setTimeout(function(){window.fetch=of},1200);"
      + "return new Promise(function(res){setTimeout(function(){"
      + "res({顶栏按钮存在:true,顶栏可见:!st.hidden&&!!st.offsetParent,"
      + "卡片按钮存在:!!send,"
      + "触发了发送:seen.length>0,"
      + "答案区有反应:pane.textContent!==before})},1000)})})()");
    record('S9.4 Demo 顶栏常驻发送按钮（在首屏内、与卡片按钮同源可用）',
      s9a.顶栏按钮存在 && s9a.顶栏可见 && s9a.卡片按钮存在
      && s9a.触发了发送 && s9a.答案区有反应,
      '顶栏=' + (s9a.顶栏可见 ? '可见' : '不可见')
      + '；卡片按钮=' + (s9a.卡片按钮存在 ? '在' : '缺失')
      + '；点击后=' + (s9a.触发了发送 ? '发出 /api/systemone' : '未发出请求')
      + '/' + (s9a.答案区有反应 ? '答案区有反应' : '答案区无反应'));

    /* 条目 1：载入预设后每个多行值都必须撑到 min(内容高度, 该控件自己的上限)。
     * ⚠️ 判据必须与「上限」一致，不能要求「完全不被截断」：autoGrow 的 cap
     * （.kv-val 480 / 纯文本 460）与 styles.css 的 .kv-val{max-height:480px}
     * 都是设计上就该有的上限 —— 「可访问性快照」那一格是 252 行 / 12359 字符，
     * 真按内容全高展开会把页面撑到 8000px，那是更糟的体验。
     * 缺陷的本质是「连自己的上限都没够到」（实测 61px vs 480px），不是「被限高」。
     * 明细里会把「内容超过上限」的字段标出来，方便判断上限本身够不够。 */
    const s9b = await uiProbe("(function(){"
      + "var CAP=480,PLAIN=460;"
      + "var ns=document.querySelectorAll('#stateForm .kv-val, #stateForm .state-plain-ta'),bad=[],rows=[];"
      + "Array.prototype.forEach.call(ns,function(v){"
      + "var cap=(v.className.indexOf('state-plain-ta')!==-1)?PLAIN:CAP;"
      + "var want=Math.min(v.scrollHeight,cap);"
      + "var k=v.closest('.kv-row');var name=k?((k.querySelector('.kv-key')||{}).value||'?'):'纯文本';"
      + "rows.push(name+':'+v.clientHeight+'/'+want+(v.scrollHeight>cap?'(内容'+v.scrollHeight+'超上限)':''));"
      + "if(v.clientHeight<want-2)bad.push(name+':'+v.clientHeight+'<'+want)});"
      + "return {字段数:ns.length,不合格:bad,明细:rows}})()");
    record('S9.1 state 表单长文本撑到各自上限（不再被压成 61px 小框）',
      s9b.字段数 > 0 && s9b.不合格.length === 0,
      '字段 ' + s9b.字段数 + ' 个；不合格=' + (s9b.不合格.join('、') || '无')
      + ' | ' + s9b.明细.join(' | '));

    /* 条目 13：删除问题 → 撤销提示 → 撤销后恢复 */
    const s9f = await uiProbe("(function(){"
      + "var before=document.querySelectorAll('#qList .q').length;"
      + "var del=document.querySelector('#qList .q .q-del');if(!del)return {错误:'无问题可删'};"
      + "del.click();"
      + "return new Promise(function(res){setTimeout(function(){"
      + "var box=document.querySelector('#undoHost .undo-toast');"
      + "var mid=document.querySelectorAll('#qList .q').length;"
      + "var btn=box?box.querySelector('.undo-btn'):null;if(btn)btn.click();"
      + "setTimeout(function(){res({删前:before,删后:mid,提示可见:!!box,撤销后:"
      + "document.querySelectorAll('#qList .q').length})},300)},200)})})()");
    record('S9.13 删除问题后可撤销（5 秒窗口 + 撤销生效）',
      s9f.提示可见 && s9f.删后 === s9f.删前 - 1 && s9f.撤销后 === s9f.删前,
      JSON.stringify(s9f));

    /* --- 入口 B：Auto 模式（空态文案 / 开跑检查 / 会话面板 / 树 / 导出 / 删除确认 / 关闭按钮）--- */
    const s9c = await uiProbe("(function(){"
      + "var segs=document.querySelectorAll('#modeSeg .seg-btn');"
      + "for(var i=0;i<segs.length;i++)if(segs[i].dataset.mode==='auto')segs[i].click();"
      + "return new Promise(function(res){setTimeout(function(){"
      + "var empty=document.querySelector('#autoFlow .out-empty');"
      + "var pf=document.getElementById('autoPreflight');"
      + "var items=pf?pf.querySelectorAll('.pf-item'):[];"
      + "res({空态文案:empty?empty.textContent.replace(/\\s+/g,' ').trim():'',"
      + "检查条存在:!!pf,检查项数:items.length,"
      + "检查项:Array.prototype.map.call(items,function(n){return n.textContent.trim()+'/'+n.className}),"
      + "开始按钮可点:!document.getElementById('autoStart').disabled})},400)})})()");
    /* 条目 3：空态文案不得复述控件文案 —— 否则 S8 的 findLabel(/打开浏览器并开始/)
     * 会在无障碍快照里先撞上这段文字（静态文本也进快照），点到非控件上。 */
    const copyBad = /打开浏览器并开始|运行参数|关闭浏览器|中止/.test(s9c.空态文案);
    record('S9.3 运行流水空态文案不再指向已改名/已移除的控件',
      s9c.空态文案.length > 0 && !copyBad,
      '文案=「' + s9c.空态文案.slice(0, 60) + '…」' + (copyBad ? ' ✗ 复述了控件文案' : ''));

    /* 条目 3 的**第三处副本**：任务摘要卡的空态（`#taskSummaryBody .ts-empty`），
     * 只在「任务目标与起始 URL 同时为空」时出现。它是 S8 的另一个陷阱：
     * `#taskSummary` 在 DOM 里位于 `#autoStart` **之前**，`findLabel` 取 `refs[0]` ——
     * 这段静态文本若复述「打开浏览器并开始」，就会抢在真按钮前面被点到。
     * 这里把两个字段清空造出该状态、读原文，验完立刻用场景 chip 恢复现场。 */
    const s9i = await uiProbe("(function(){"
      + "var g=document.getElementById('autoGoal');var u=document.getElementById('autoUrl');"
      + "g.value='';u.value='';"
      + "g.dispatchEvent(new Event('input',{bubbles:true}));"
      + "u.dispatchEvent(new Event('input',{bubbles:true}));"
      + "return new Promise(function(res){setTimeout(function(){"
      + "var e=document.querySelector('#taskSummaryBody .ts-empty');"
      + "var txt=e?e.textContent.replace(/\\s+/g,' ').trim():'';"
      + "var chip=document.querySelector('#autoScenarios .chip');"
      + "if(chip)chip.click();"
      + "setTimeout(function(){res({空态文案:txt,已恢复:g.value.length>0&&u.value.length>0})},400)"
      + "},300)})})()");
    const copyBad3 = /打开浏览器并开始|运行参数|关闭浏览器|中止/.test(s9i.空态文案);
    record('S9.3b 任务摘要空态文案同样不复述控件名（S8 findLabel 的另一个陷阱）',
      s9i.空态文案.length > 0 && !copyBad3 && s9i.已恢复,
      '文案=「' + s9i.空态文案.slice(0, 70) + '」' + (copyBad3 ? ' ✗ 复述了控件文案' : '')
      + '；现场已恢复=' + s9i.已恢复);

    /* 条目 6：四格检查（引擎 / Jev Key / 任务目标 / 起始 URL），且**不禁用**开始按钮 ——
     * 后者是 S8 的契约：配置不合法要能点开始，然后把原因摊进 #autoErrorBar。 */
    const pfNames = s9c.检查项.map((s) => s.split('/')[0]);
    record('S9.6 开跑前检查条（四格 + 不禁用开始按钮）',
      s9c.检查条存在 && s9c.检查项数 === 4 && s9c.开始按钮可点
      && pfNames.some((t) => /引擎/.test(t)) && pfNames.some((t) => /Key|密钥/.test(t)),
      '项=' + s9c.检查项.join(' | ') + '；开始按钮可点=' + s9c.开始按钮可点);

    /* 条目 12：任务目标框的高度上限。
     * 这条探针**同时上报「受限高度」与「自然高度」** —— 两者相等就说明
     * #autoGoal 本来就不会长（它没接 autoGrow，rows=3 定高），这条「缺陷」不成立，
     * 那条 max-height 也只是个不生效的护栏。数据说话，不靠印象。 */
    const s9h = await uiProbe("(function(){"
      + "var g=document.getElementById('autoGoal');if(!g)return {错误:'找不到 autoGoal'};"
      + "var limited=Math.round(g.getBoundingClientRect().height);"
      + "g.style.maxHeight='none';"
      + "var natural=Math.round(g.getBoundingClientRect().height);"
      + "g.style.maxHeight='';"
      + "return {受限高度:limited,自然高度:natural,视口高:window.innerHeight,"
      + "内容超框:g.scrollHeight>g.clientHeight+2}})()");
    record('S9.12 任务目标框不霸屏（上报受限/自然高度以判定该缺陷是否成立）',
      s9h.受限高度 > 0 && s9h.受限高度 <= 100,
      '受限=' + s9h.受限高度 + 'px / 自然=' + s9h.自然高度 + 'px'
      + (s9h.受限高度 > s9h.自然高度 + 2 ? '（max-height 真的在起作用）' : '（max-height 未生效=非问题）')
      + '；视口=' + s9h.视口高);

    /* 条目 2 + 5 + 7 + 9：打开合成历史会话，验面板几何、树、标签、导出 */
    const s9d = await uiProbe("(function(){"
      + "document.getElementById('autoSessBtn').click();"
      + "return new Promise(function(res){setTimeout(function(){"
      + "var p=document.getElementById('autoSessPanel');"
      + "var list=document.getElementById('autoSessList');"
      + "var box=p?p.getBoundingClientRect():{height:0};"
      + "var filt=document.getElementById('sessFilter');"
      + "var rows=list?list.querySelectorAll('.sess-item'):[];"
      + "var pick=null;Array.prototype.forEach.call(rows,function(r){var s=r.querySelector('.sid');"
      + "if(s&&s.textContent.trim()==='" + S9_ID + "')pick=r.querySelector('.pick')});"
      + "if(pick)pick.click();"
      + "setTimeout(function(){"
      + "var tree=document.getElementById('flowTree');"
      + "var kids=tree?tree.querySelectorAll('.tn.kid'):[];"
      + "var acts=tree?tree.querySelectorAll('.tn.act-kid'):[];"
      + "var clipped=[];Array.prototype.forEach.call(kids,function(k){var lb=k.querySelector('.lb');"
      + "if(!lb)return;"
      /* 折行钳制是「按高度截断」：内容放不下时 scrollHeight > clientHeight；
       * 修之前是 nowrap + ellipsis（单行横向截断，scrollWidth > clientWidth）。
       * 两个方向都量，避免「改成两行后横向不再溢出」被误判成不截断。 */
      + "if(lb.scrollWidth>lb.clientWidth+2||lb.scrollHeight>lb.clientHeight+2)"
      + "clipped.push(lb.textContent.trim().slice(0,30)+'('+lb.scrollWidth+'/'+lb.clientWidth+','+lb.scrollHeight+'/'+lb.clientHeight+')')});"
      + "var ex=document.getElementById('autoExport');"
      + "res({面板高:Math.round(box.height),视口高:window.innerHeight,"
      + "过滤框存在:!!filt,步骤数:kids.length,行动子行数:acts.length,被截断标签:clipped,"
      + "导出可见:!!(ex&&!ex.hidden),导出文案:ex?ex.textContent.trim():''})},1000)},1600)})})()");
    record('S9.2 会话面板有高度上限 + 过滤框（135 条记录不再撑爆页面）',
      s9d.面板高 > 0 && s9d.面板高 <= Math.max(420, s9d.视口高 * 0.6) + 2 && s9d.过滤框存在,
      '面板高=' + s9d.面板高 + 'px（视口 ' + s9d.视口高 + '）');
    /* 期望值是 2，不是 1 —— 这条路探针自己走歪过一次，记下来：
     * 合成记录 11 步共 12 个行动（11 首轮 + 第 2 步 1 个文本补问）。
     * 修法「仅 acts.length > 1 才渲染子行」下，唯一的 2 行动步骤（第 2 步）会把
     * **两个**行动都渲染出来 = 2 行；单行动步骤不再渲染子行。
     * 想压到 1 行只有「多行动步骤里只渲染非首轮行动」一条路，但那样全树再没有
     * 「Jev 首轮」行 —— S6 的 clickTreeNode('/Jev 首轮/') 与
     * dMain.cardNames === '动作,参数,未完成' 会直接变红。
     * 所以这条断言测的是「单行动步骤不再产生噪声行」：12 → 2。 */
    record('S9.7 单行动步骤不再渲染子行（11 步 12 行 → 2 行）',
      s9d.步骤数 === 11 && s9d.行动子行数 === 2,
      '步骤 ' + s9d.步骤数 + ' 行 / 行动子行 ' + s9d.行动子行数 + ' 行（修复前 12 行）');
    record('S9.9 步骤标签折行后不再截断元素名', s9d.被截断标签.length === 0,
      s9d.被截断标签.length ? '仍被截断：' + s9d.被截断标签.slice(0, 2).join(' | ') : '全部完整');
    record('S9.5 历史会话可导出（按钮可见且指向被查看的会话）',
      s9d.导出可见 && s9d.导出文案.indexOf(S9_ID) !== -1,
      '导出按钮=' + (s9d.导出可见 ? '可见' : '隐藏') + '「' + s9d.导出文案 + '」');

    /* 条目 14：删除会话走自绘弹窗，不碰原生 confirm
     * （拦 window.confirm 计数：只要它被调用，就说明还在用原生弹窗） */
    const s9e = await uiProbe("(function(){"
      + "var calls=0;var orig=window.confirm;window.confirm=function(){calls++;return false};"
      + "document.getElementById('autoSessBtn').click();"
      + "return new Promise(function(res){setTimeout(function(){"
      + "var rows=document.querySelectorAll('#autoSessList .sess-item');"
      + "var del=null;Array.prototype.forEach.call(rows,function(r){var s=r.querySelector('.sid');"
      + "if(s&&s.textContent.trim()==='" + S9_ID + "')del=r.querySelector('.sess-del')});"
      + "if(del)del.click();"
      + "setTimeout(function(){"
      + "var m=document.getElementById('confirmModal');"
      /* ⚠️ 可见性判据不能用 offsetParent：.modal-backdrop 是 position:fixed，
       * 而 fixed 元素的 offsetParent 恒为 null —— 那会把「明明开着」判成不可见
       * （S9.14 就这么假红过一次）。改用布局盒子高度。 */
      + "var visible=!!(m&&!m.hidden&&m.getBoundingClientRect().height>0);"
      + "var title=(document.getElementById('confirmTitle')||{}).textContent||'';"
      + "var body=(document.getElementById('confirmBody')||{}).textContent||'';"
      + "var cancel=m?m.querySelector('#confirmCancel'):null;if(cancel)cancel.click();"
      + "window.confirm=orig;"
      + "res({原生调用次数:calls,弹窗可见:visible,标题:title,正文:body})},600)},1600)})})()");
    record('S9.14 删除会话用自绘确认弹窗（含步数上下文，不再 window.confirm）',
      s9e.弹窗可见 && s9e.原生调用次数 === 0 && /步/.test(s9e.正文),
      '原生 confirm 调用=' + s9e.原生调用次数 + '；弹窗=' + (s9e.弹窗可见 ? '可见' : '不可见')
      + '「' + s9e.标题 + '」' + s9e.正文.slice(0, 40));

    /* 条目 10：空闲时点「关闭浏览器」不得谎报「已关闭」。
     * ⚠️ 判据是**服务端那句真话进了提示**，不是按钮 disabled。
     * 曾一度用「空闲即禁用」来实现，但那会制造反向谎言（V2 审查发现）：刷新页面后
     * 页内状态丢失，isolated/persistent 留下的浏览器其实还开着，按钮却被禁用并写着
     * 「当前没有开着的浏览器（无需关闭）」—— 用户反而失去了唯一的关闭入口。
     * 现在按钮保持可点，靠服务端（A1 的 closed:false）说真话。
     * 注：这条隐含要求「空闲时可点」；将来若真做了准确探测再禁用，要同步改成
     * 断言 disabled + title 的文案。 */
    const s9g = await uiProbe("(function(){"
      + "var b=document.getElementById('autoCloseBrowser');"
      + "var t=document.getElementById('toast');"
      + "if(!b)return {错误:'按钮不存在'};"
      + "b.click();"
      + "return new Promise(function(res){setTimeout(function(){"
      + "var txt=(t?t.textContent:'')||'';"
      + "res({禁用:b.disabled,toast:txt,标题:b.title||'',"
      + "谎报:txt.indexOf('浏览器已关闭')!==-1,"
      + "真话:txt.indexOf('没有开着')!==-1||txt.indexOf('无需关闭')!==-1})},1000)})})()");
    record('S9.10 空闲时点「关闭浏览器」不谎报「已关闭」（服务端说真话）',
      s9g.真话 && !s9g.谎报,
      '禁用=' + s9g.禁用 + '；toast=「' + s9g.toast + '」');

    /* 收尾：删掉本块的合成记录，不给真实 data/runs 留垃圾；
     * 并把模式留在 auto —— S1 就在 auto 模式下开工。 */
    await uiProbe("fetch('/api/runs/" + S9_ID + "',{method:'DELETE'})"
      + ".then(function(r){return r.status})");
    await uiProbe("(function(){var segs=document.querySelectorAll('#modeSeg .seg-btn');"
      + "for(var i=0;i<segs.length;i++)if(segs[i].dataset.mode==='auto')segs[i].click();"
      + "return 'auto'})()");

  } catch (e) { record('S9 UX 不变量', false, e.message); }

  /* ---------- S1 连续 · 归档 9 月对账单 ---------- */
  if (want('s1')) try {
    await setTask({ goal: GOAL_ARCHIVE, url: DEMO_URL, cadence: '连续自动' });
    const t0 = Date.now();
    await clickLabel(/打开浏览器并开始/);
    const { flat, state } = await waitEnd('s1-terminal');
    await sleep(1500);
    const box = await taskSnapshot();
    const okMail = /已归档 1 封/.test(box)
      && !/listitem "邮件[^"]*9 月电子对账单/.test(box)
      && /listitem "邮件[^"]*8 月电子对账单/.test(box)
      && /listitem "邮件[^"]*兴业银行/.test(box);
    const okDone = state === 'done';
    const okUi = okDone && (/click【e\d+ · 归档】/.test(flat) || /归档/.test(flat));
    /* 标注：既要在卡片那张图上（人看的地方），又不许出现在被驱动的页面里。
     * 这一步点的「归档」按下就重渲染列表 —— 正是标注最容易静默失效的场景。
     * 必须先把树点到归档步：运行结束时视图跟随的是终止步，而终止帧按设计就不标注
     * （终止步 takeShot 不带 ref，走 anno=null 那条分支）。旧断言直接取当前视图，
     * 取到的永远是那张无标注的终止帧，于是恒判 noanno —— 与标注功能无关。 */
    await sleep(800);
    const clickArch = await clickTreeNode('/归档】/');
    await sleep(500);
    const card = await cardShot();
    const anno = checkAnnoPosition(card, t0);
    const okCard = clickArch.ok && Boolean(card.dataUrl)
      && pngHasPixel(card.dataUrl, [225, 29, 72]) && anno.ok;
    if (card.dataUrl) {
      fs.writeFileSync(path.join(EVID_DIR, 'anno-s1-card.png'), Buffer.from(card.dataUrl.split(',')[1], 'base64'));
    }
    const shot = newestDrivenShot(t0);
    const pageClean = Boolean(shot) && !pngHasPixel(fs.readFileSync(shot.f), [225, 29, 72]);
    record('S1 连续模式 · 精确归档 9 月对账单（8 月/兴业保留）', okMail && okUi && okDone && okCard && pageClean,
      (okMail ? '邮箱状态正确：已归档 1 封、干扰项保留' : '邮箱状态异常')
      + '；终止 state=' + state
      + '；卡片图标注=' + (pngHasPixel(card.dataUrl, [225, 29, 72]) ? '有' : '没有（' + (card.reason || '图里无标记色') + '）')
      + '（' + anno.detail + '）'
      + '；被驱动页面=' + (pageClean ? '干净（无标注痕迹）' : (shot ? '不该有标注却出现了' : '本轮没找到驱动页截图')));
    await saveShot('e2e-s1-archive');
  } catch (e) { record('S1 连续模式 · 归档对账单', false, e.message); }

  /* ---------- S2 连续 · 搜索（生成输入 → LLM → fill 闭环） ---------- */
  if (want('s2')) try {
    await resetMailbox();
    await setTask({ goal: '在邮箱里搜索出所有招商银行相关的邮件', url: DEMO_URL, cadence: '连续自动' });
    await clickLabel(/打开浏览器并开始/);
    const { flat, state } = await waitEnd('s2-terminal');
    await sleep(1500);
    const box = await taskSnapshot();
    const items = (box.match(/- listitem "邮件/g) || []).length;
    const filtered = /searchbox "搜索邮件" (?:\[[^\]]+\] )*\[ref=[^\]]+\]: 招商银行/.test(box) && items === 5;
    /* LLM 块渲染在「LLM 生成输入」那个行动节点的视图里，必须先点过去 —— 运行结束时
     * 视图跟随的是终止步，整页平面文本里自然找不到它。旧断言拿 flat 直接找，恒为 false；
     * 步骤标签「生成输入【…】」在树上，所以那条半真半假地过（与 S6 旧断言同一个病根）。 */
    const clickLlm = await clickTreeNode('/LLM 生成输入/');
    await sleep(500);
    const llmGen = await uiProbe("(function(){var n=document.querySelector('.llm-gen');"
      + "return {可见:!!n, 文:n?n.textContent.trim():''}})()");
    const llmVisible = clickLlm.ok && llmGen.可见 && /生成文本 → 招商银行/.test(llmGen.文)
      && /生成输入【/.test(flat);
    const done = state === 'done' || state === 'fails';
    record('S2 生成输入闭环（LLM → fill → 过滤 5 封）', filtered && llmVisible && done,
      '邮箱过滤=' + filtered + '；UI 可见生成文本=' + (llmVisible ? '「' + llmGen.文 + '」' : '未渲染')
      + '；终止 state=' + state +
      (state === 'fails' ? '（存在执行失败步骤，详见 s2-terminal-flat.txt）' : ''));
    await saveShot('e2e-s2-llm');
  } catch (e) { record('S2 生成输入闭环', false, e.message); }

  /* ---------- S3 单步确认 · 逐轮点「执行本步」 ---------- */
  if (want('s3')) try {
    await resetMailbox();
    await setTask({ goal: GOAL_ARCHIVE, url: DEMO_URL, cadence: '单步确认' });
    await clickLabel(/打开浏览器并开始/);
    const t0 = Date.now();
    let confirms = 0;
    let s3State = '';
    while (Date.now() - t0 < 150000) {
      const snap = await snapUI();
      s3State = await pillState();
      if (s3State && s3State !== 'running') break;
      const refs = findRefs(snap, /执行本步/);
      if (refs.length) {
        const r = await driver.act(UI, 'click', refs[0].ref, null);
        if (!r.ok) throw new Error('点击执行本步失败：' + r.error);
        confirms++;
        await sleep(1500);
      } else {
        await sleep(2000);
      }
    }
    const box = await taskSnapshot();
    const ok = /已归档 1 封/.test(box) && confirms >= 1;
    record('S3 单步确认模式（代理确认 ' + confirms + ' 次）', ok,
      (ok ? '单步路径完成归档' : '单步路径异常（confirms=' + confirms + '）') + '；终止 state=' + s3State);
    await saveShot('e2e-s3-single');
  } catch (e) { record('S3 单步确认模式', false, e.message); }

  /* ---------- S4 步数上限=2 ---------- */
  if (want('s4')) try {
    await resetMailbox();
    await setTask({ goal: '把收件箱里的所有邮件都归档', url: DEMO_URL, maxSteps: 2, cadence: '连续自动' });
    await clickLabel(/打开浏览器并开始/);
    /* state=limit 说明是按上限收敛；快照里的「共 2 步」证明 maxSteps=2 确实生效
     * （上限原因句现在只挂在 progress 的 title 上，aria 快照读不到） */
    const { flat: flat4, state: state4 } = await waitEnd('s4-terminal', 120000);
    record('S4 步数上限终止（max=2）', state4 === 'limit' && /共 2 步/.test(flat4),
      'state=' + state4 + '；步数标注=' + (/共 2 步/.test(flat4) ? '共 2 步' : '未找到'));
    await saveShot('e2e-s4-maxsteps');
  } catch (e) { record('S4 步数上限终止', false, e.message); }

  /* ---------- S5 原生弹窗 · 删除（click 删除 → confirm → 弹窗步 → dialog-accept） ----------
   * 修复前的行为：confirm 打开后 snapshot 报 "does not handle the modal state"，
   * 循环以 error 终止、邮件没删成。现在这一轮转为弹窗步（只问一道动作题），
   * 处理完弹窗继续。断言三件事：邮件真删了（已删除 1 封 + 8 月不在列表 + 9 月保留）、
   * 正常走完（state=done 而非 error）、UI 上能看到 dialog-accept 这步。 */
  if (want('s5')) try {
    await resetMailbox();
    await setTask({ goal: '在收件箱里删除 8 月电子对账单那封邮件，浏览器弹出确认框时选择接受', url: DEMO_URL, maxSteps: 6, cadence: '连续自动' });
    await clickLabel(/打开浏览器并开始/);
    const { flat: flat5, state: state5 } = await waitEnd('s5-terminal');
    await sleep(1500);
    const box = await taskSnapshot();
    const okMail = /已删除 1 封/.test(box)
      && !/listitem "邮件[^"]*8 月电子对账单/.test(box)
      && /listitem "邮件[^"]*9 月电子对账单/.test(box);
    const sawDialog = /处理弹窗 · dialog-accept/.test(flat5) || /dialog-accept/.test(flat5);
    record('S5 原生弹窗（confirm → 弹窗步 → dialog-accept → 恢复循环）',
      okMail && state5 === 'done' && sawDialog,
      '邮箱状态=' + (okMail ? '已删除 1 封、9 月保留' : '异常')
      + '；终止 state=' + state5
      + '；UI 可见弹窗步=' + sawDialog);
    await saveShot('e2e-s5-dialog');
  } catch (e) { record('S5 原生弹窗', false, e.message); }

  /* ---------- S6 订单后台 · select 的「文本」补问（事故场景的结构性回归） ----------
   * 旧 4 题制的事故路径：模型在「搜索买家王小明」与「切换发货状态」两个子目标间
   * 摇摆，拼出 select e15 "王小明"（下拉框里根本没有这个选项）。现在「文本」延后
   * 到动作+参数落定后单题补问，候选就是该下拉框当时的真实选项名 —— 本场景断言：
   * 补问真的发生且 UI 可见、oracle 答案落在候选内（M1 的违规面）、select 执行后
   * 目标选项真的 [selected]、循环正常收敛 done。 */
  if (want('s6')) try {
    await setTask({ goal: '在「订单状态」下拉框选择「已付款待发货」', url: ORIGIN + '/demo/orders.html', maxSteps: 5, cadence: '连续自动' });
    await clickLabel(/打开浏览器并开始/);
    const { state: state6 } = await waitEnd('s6-terminal');
    await sleep(1500);
    /* 整页平面快照：树上的行动标题在这里（详情区只渲染当前选中的那一个节点，
     * 结构断言走 uiProbe —— 否则树上的标题会把断言喂饱，这正是这条断言此前失效的原因） */
    const flat6 = (await snapUI()).replace(/\s+/g, ' ');
    fs.writeFileSync(path.join(EVID_DIR, 's6-terminal-flat.txt'), flat6, 'utf8');
    const box = await taskSnapshot();
    const okSelect = /option "已付款待发货"[^\n]*\[selected\]/.test(box);
    const sawCmd = /select【e\d+ · 订单状态】 "已付款待发货"/.test(flat6);
    /* 标题与首轮同构：种类 · 题数 · 上下文 */
    const sawTitle = /文本补问 · 1 题 · select/.test(flat6);

    /* 补问节点：一次调用的完整视图 —— 问题块（1 道）+ 候选（=下拉框真实选项）+ 作答概率分布 */
    const clickFu = await clickTreeNode('/文本补问/');
    await sleep(400);
    const dFu = await detailProbe();
    /* 分项布尔值：挂掉时能一眼看出是哪一条（全并成一个 bool 会只留一句"false"） */
    const fuChecks = {
      节点可点: clickFu.ok,
      题名: dFu.qNames.join() === '文本',
      题数标题: dFu.secHeads.some((h) => /本轮输入 · 1 道问题/.test(h)),
      候选含真实选项: dFu.chips.includes('已付款待发货'),
      结论: dFu.verdict[0] === '已选定 已付款待发货',
      作答卡: dFu.cardNames.join() === '文本',
      置信度: dFu.conf.length === 1,
      概率条: dFu.bars.includes('已付款待发货'),
    };
    const sawFollowUp = Object.keys(fuChecks).every((k) => fuChecks[k]);

    /* 首轮节点：概率分布网格只留首轮真问过的三题，「文本」不再混进来 */
    const clickMain = await clickTreeNode('/Jev 首轮/');
    await sleep(400);
    const dMain = await detailProbe();
    const gridOk = clickMain.ok && dMain.cardNames.join() === '动作,参数,未完成';

    record('S6 select 文本补问（候选=真实选项 → 选中已付款待发货）',
      okSelect && sawFollowUp && sawCmd && sawTitle && state6 === 'done',
      '下拉框=' + (okSelect ? '已选中' : '未选中')
      + '；补问卡=' + JSON.stringify(fuChecks)
      + '；标题题数=' + sawTitle
      + '；时间线命令=' + (sawCmd ? 'select 命中' : '未见')
      + '；终止 state=' + state6);
    record('S6 补问卡与首轮卡对齐（补问含问题块/候选/概率分布；首轮网格不再混入「文本」）',
      sawFollowUp && gridOk,
      '补问卡=' + JSON.stringify(dFu)
      + '；首轮网格=' + JSON.stringify(dMain.cardNames));
    await saveShot('e2e-s6-select');
  } catch (e) { record('S6 select 文本补问', false, e.message); }

  /* ---------- S7 哨兵标签回归 ----------
   * 动作不需要元素时模型仍可能回「其他」（REF_MORE）。前端在 ⑤b 会把参数归一为空，
   * 但标签是 ⑤ 按**原始**参数算的 —— 不重算就会把「其他 · 展开下一批」这种哨兵文案
   * 留在时间线上，读起来像真的在展开候选批次（实测事故：dialog-dismiss 步骤）。 */
  if (want('s7')) try {
    await setTask({ goal: '哨兵标签回归：直接收起弹层', url: DEMO_URL, maxSteps: 4, cadence: '连续自动' });
    await clickLabel(/打开浏览器并开始/);
    const { flat, state } = await waitEnd('s7-terminal');
    await sleep(1200);
    const leaked = /dialog-dismiss【其他 · 展开下一批】/.test(flat);
    const hasLabel = /dialog-dismiss/.test(flat);
    record('S7 哨兵标签（参数被归一为空后，标签不残留「其他 · 展开下一批」）',
      !leaked && hasLabel && (state === 'done' || state === 'fails' || state === 'limit'),
      '标签=' + (hasLabel ? (leaked ? '残留哨兵文案' : '干净') : '未找到 dialog-dismiss')
      + '；终止 state=' + state);
  } catch (e) { record('S7 哨兵标签', false, e.message); }

  /* ---------- S8 外层就地编辑 + 错误条（可复制） ----------
   * 两件事一起验，都发生在「点开始之前」，不需要真跑任务：
   *   ① 任务目标 / 起始 URL / 输入变量就在外层（#taskSummary 内）且可编辑
   *   ② 配置不合法时，原因摊在页面里的 #autoErrorBar（不是 2 秒就消失的 toast）：
   *      正文可选中、有「复制」按钮、有「✕」收起
   * 曾经的形态是「弹窗里一行小字 + toast」—— 报错原文没法复制，只能肉眼抄。 */
  if (want('s8')) try {
    await fillLabel(/"任务目标"/, '外层就地编辑回归');
    /* 清空 URL 故意造一个非法配置：driver 的 fill 不收空文本（validateAct 要求非空），
     * 所以这里走页内事件模拟「用户把内容删光」 */
    await uiProbe("(function(){var u=document.getElementById('autoUrl');u.value='';u.dispatchEvent(new Event('input',{bubbles:true}));return u.value})()");
    await clickLabel(/打开浏览器并开始/);
    await sleep(700);
    const bar = await uiProbe("(function(){var b=document.getElementById('autoErrorBar'),t=document.getElementById('autoErrorTitle'),x=document.getElementById('autoErrorBody');"
      + "var s=document.getElementById('taskSummary');"
      + "return {可见:!!(b&&!b.hidden&&b.offsetParent),标题:t?t.textContent:'',正文:x?x.textContent:'',可选中:x?getComputedStyle(x).userSelect:'',"
      + "外层可编辑:!!(s&&s.contains(document.getElementById('autoGoal'))&&s.contains(document.getElementById('autoUrl'))&&s.contains(document.getElementById('autoVars'))),"
      + "目标框可见:!!(document.getElementById('autoGoal')||{}).offsetParent}})()");
    const barOk = bar.可见 && /任务配置不完整/.test(bar.标题) && /起始 URL/.test(bar.正文) && bar.可选中 === 'text';
    /* 复制按钮：必须在同一个页内调用里点完再等 —— 按钮文案 1.6s 后自动复位，
     * 跨调用（每次要起一个 CLI 进程）读到的一定是复位后的值。 */
    const copied = await uiProbe("(function(){var b=document.getElementById('autoErrorCopy');b.click();"
      + "return new Promise(function(res){setTimeout(function(){res(b.textContent)},1000)})})()");
    const copyOk = /已复制|Ctrl\+C/.test(String(copied));
    await clickLabel(/✕/);
    await sleep(400);
    const closed = await uiProbe("(function(){var b=document.getElementById('autoErrorBar');return !(b&&!b.hidden&&b.offsetParent)})()");
    await fillLabel(/"起始 URL"/, DEMO_URL);   /* 别把空 URL 留给后面的场景 */
    record('S8 外层可就地编辑 + 出错摊在页面里（可选中/可复制/可收起）',
      barOk && copyOk && closed && bar.外层可编辑 && bar.目标框可见,
      '错误条=' + (bar.可见 ? '可见' : '不可见') + '「' + bar.标题 + '」'
      + '；正文=' + (bar.可选中 === 'text' ? '可选中' : '选择被禁用(' + bar.可选中 + ')')
      + '；复制=' + (copyOk ? '按钮变为「' + copied + '」' : '点了没反应（' + copied + '）')
      + '；收起=' + (closed ? '生效' : '没生效')
      + '；外层三字段=' + (bar.外层可编辑 ? '在摘要内' : '不在摘要内')
      + '；目标框=' + (bar.目标框可见 ? '可见可编辑' : '不可见'));
  } catch (e) { record('S8 外层就地编辑 + 错误条', false, e.message); }

  /* ---------- 树状态点尺寸不变量 ----------
   * 状态点的 class 是 `dot <状态>` 两段式，历史上与 Demo 模式的全局 `.err`（错误框，
   * padding 14/16px）撞名 —— 失败步骤的点被撑成 34×30 的红块。这里把全部状态组合
   * 在页内造出来量一遍：只要再有全局同名裸类长出来，这条立刻红。
   * root 是会话根的空心圆环（9px + 2px 边框 = 13px），单独给上限。
   * 宿主必须 display:flex —— 不然 span.dot 是行内元素，量出来宽 0、高等于行高，
   * 八个状态会一起"超标"，这条就成了永远红的假护栏。 */
  try {
    const dots = await uiProbe("(function(){var host=document.createElement('div');"
      + "host.style.cssText='position:absolute;left:-9999px;top:0;display:flex;gap:8px';"
      + "['ok','err','error','pending','run','term','mute','root'].forEach(function(s){"
      + "var d=document.createElement('span');d.className='dot '+s;d.dataset.s=s;host.appendChild(d)});"
      + "document.body.appendChild(host);"
      + "var out=[].map.call(host.children,function(d){var r=d.getBoundingClientRect();"
      + "return {s:d.dataset.s,w:Math.round(r.width),h:Math.round(r.height)}});"
      + "host.remove();return out})()");
    const bad = dots.filter((d) => (d.s === 'root' ? (d.w > 14 || d.h > 14) : (d.w > 8 || d.h > 8)));
    record('树状态点尺寸不变量（任意状态都不被全局同名类撑开）', bad.length === 0,
      bad.length ? '超标：' + bad.map((d) => d.s + '=' + d.w + 'x' + d.h).join('、')
        : dots.map((d) => d.s + '=' + d.w + 'x' + d.h).join(' '));
  } catch (e) { record('树状态点尺寸不变量', false, e.message); }

  /* ---------- 构造契约终审 + LLM prompt 可见性 ---------- */
  if (mocks) {
    try {
      const rep = await mocks.report();
      record('M1 前端构造契约（每请求 3 问 / 23 动作候选 / 参数候选 ⊆ 快照 ref（密集页自动裁剪））',
        rep.violations.length === 0,
        rep.violations.length ? rep.violations.slice(0, 4).join(' | ') : '共 ' + rep.reqCount + ' 次请求零违规');
      /* oracle 每轮决策日志（排障证据） */
      fs.writeFileSync(path.join(EVID_DIR, 'oracle-decisions.json'), JSON.stringify(rep.decisions, null, 2), 'utf8');
      const llmOk = rep.llmCalls.length >= 1 && rep.llmCalls[0].prompt
        && rep.llmCalls[0].prompt.some((m) => /在邮箱里搜索出所有招商银行相关的邮件/.test(m.content))
        && rep.llmCalls[0].prompt.some((m) => /搜索邮件/.test(m.content))
        && rep.llmCalls[0].auth === 'Bearer mock-llm-key';
      /* LLM 只在 S2 被调用：E2E_ONLY 过滤掉 S2 时这条没有断言面，不参与判定 */
      if (want('s2')) {
        record('M2 LLM prompt 工程（目标+字段上下文注入，key 经请求头透传）', llmOk,
          'llm 调用 ' + rep.llmCalls.length + ' 次');
      }
      mocks.close();
    } catch (e) { record('M1/M2 mock 终审', false, e.message); }
  }

  /* ---------- 清理与汇总 ---------- */
  await pageApi('/api/browser/close', {}).catch(() => {});
  await driver.close(UI).catch(() => {});
  const failed = results.filter((r) => !r.ok);
  const lines = results.map((r) => (r.ok ? '✅' : '❌') + ' ' + r.name + (r.detail ? ' — ' + r.detail : ''));
  fs.writeFileSync(path.join(EVID_DIR, 'e2e-result.md'),
    '# playwright-jev-agent E2E · ' + new Date().toISOString() + '\n\n上游：' + UPSTREAM + '\n\n' + lines.join('\n') + '\n\n结果：' +
    (results.length - failed.length) + '/' + results.length + ' 通过\n', 'utf8');
  console.log('\n==== E2E 汇总：' + (results.length - failed.length) + '/' + results.length + ' 通过 ====');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('E2E 致命错误：', e && e.stack || e);
  process.exit(2);
});
