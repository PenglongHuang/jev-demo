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
 * 运行：node tests/e2e/run.js   （或 npm run test:e2e）
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const driver = require(path.join(__dirname, '..', '..', 'browser-driver.js'));
const { parseSnapshotRefs } = require(path.join(__dirname, '..', '..', 'public', 'js', 'util.js'));
const { pngHasPixel } = require(path.join(__dirname, '..', 'png-pixels.js'));
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
 * 「✎ 编辑配置」）—— 找不到时重试一次再判缺失，两拍都空才算真没有。 */
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

async function pageApi(path, bodyObj) {
  /* 请求体以单引号 JS 字面量嵌入（值仅含 ASCII 安全字符），页内再 JSON.stringify，
   * 避免外层 CLI 引号封装与双引号冲突；响应走 base64 通道避开转义歧义 */
  const lit = JSON.stringify(bodyObj === undefined ? {} : bodyObj).replace(/"/g, "'");
  const js = "fetch('" + path + "',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(" + lit + ")})"
    + ".then(function(r){return r.text()})"
    + ".then(function(t){return 'E2ERES'+btoa(unescape(encodeURIComponent(t)))+'E2ERES'})";
  const out = await rawExec(['eval', js, '--json']);
  const env = driver._test.parseEnvelope({ code: 0, stdout: out, stderr: '' });
  if (!env.ok) throw new Error('pageApi eval 失败：' + env.error);
  const m = String(env.result).match(/E2ERES([A-Za-z0-9+/=]*)E2ERES/);
  if (!m) throw new Error('pageApi 无标记输出：' + String(env.result).slice(0, 160));
  try { return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')); }
  catch (e) { throw new Error('pageApi 返回非 JSON：' + Buffer.from(m[1], 'base64').toString('utf8').slice(0, 160)); }
}

async function taskSnapshot() {
  const r = await pageApi('/api/browser/snapshot', {});
  if (!r.ok) throw new Error('任务浏览器快照失败：' + (r.error && r.error.message ? r.error.message : String(r.error || '')));
  return r.snapshot;
}

/* 驱动页的截图工件落在 data/<session>.png，会话名由请求方 IP 哈希而来 —— 测试不去复刻
 * 那个哈希，按「比 since 更新」找本轮新写的那张即可。 */
function newestDrivenShot(sinceMs) {
  const dir = path.join(__dirname, '..', '..', 'data');
  return fs.readdirSync(dir)
    .filter((f) => /^jev.*\.png$/.test(f))
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

  /* ---------- 任务配置：表单住在 #taskModal 弹窗里（主面板只剩只读摘要） ----------
   * 所以任务目标 / 起始 URL / 步数上限 / 节奏 的读写都必须「先开门、后关窗」，
   * 不能像表单内联时那样直接 fillLabel。
   * 保存时 saveTaskModal → validateForm 会拦截非法输入并把原因写进 #taskError 且不关窗，
   * 因此关窗要轮询校验，失败时把原因带出来（否则只会看到后续找不到控件的二次报错）。 */
  async function setTask(opts) {
    await clickLabel(/✎ 编辑配置/);
    await sleep(500);
    await fillLabel(/"任务目标"/, opts.goal);
    await fillLabel(/"起始 URL"/, opts.url);
    if (opts.maxSteps != null) await fillLabel(/"步数上限"/, String(opts.maxSteps));
    if (opts.cadence) await clickLabel(new RegExp('"' + opts.cadence + '"'));
    await clickLabel(/保存并应用/);
    for (let i = 0; i < 10; i++) {
      await sleep(300);
      const st = await rawExec(['eval',
        "(function(){var m=document.getElementById('taskModal');var e=document.getElementById('taskError');"
        + "return 'TASK hidden='+(m&&m.hidden)+' err='+((e&&!e.hidden)?e.textContent:'')})()", '--json']);
      const env = driver._test.parseEnvelope({ code: 0, stdout: st, stderr: '' });
      const info = String(env.result || '');
      if (/hidden=true/.test(info)) return;
      if (i === 9) throw new Error('任务弹窗未能保存关闭：' + info.replace(/^TASK /, ''));
    }
  }

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
     * 这一步点的「归档」按下就重渲染列表 —— 正是标注最容易静默失效的场景。 */
    /* 标注：既要在卡片那张图上（人看的地方），又不许出现在被驱动的页面里。
     * 这一步点的「归档」按下就重渲染列表 —— 正是标注最容易静默失效的场景。 */
    await sleep(800);
    const card = await cardShot();
    const okCard = Boolean(card.dataUrl) && pngHasPixel(card.dataUrl, [225, 29, 72]);
    if (card.dataUrl) {
      fs.writeFileSync(path.join(EVID_DIR, 'anno-s1-card.png'), Buffer.from(card.dataUrl.split(',')[1], 'base64'));
    }
    const shot = newestDrivenShot(t0);
    const pageClean = Boolean(shot) && !pngHasPixel(fs.readFileSync(shot.f), [225, 29, 72]);
    record('S1 连续模式 · 精确归档 9 月对账单（8 月/兴业保留）', okMail && okUi && okDone && okCard && pageClean,
      (okMail ? '邮箱状态正确：已归档 1 封、干扰项保留' : '邮箱状态异常')
      + '；终止 state=' + state
      + '；卡片图标注=' + (okCard ? '有（几何 ' + card.anno + '）' : '没有（' + (card.reason || '图里无标记色') + '）')
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
    const llmVisible = /生成文本 → 招商银行/.test(flat) && /生成输入【/.test(flat);
    const done = state === 'done' || state === 'fails';
    record('S2 生成输入闭环（LLM → fill → 过滤 5 封）', filtered && llmVisible && done,
      '邮箱过滤=' + filtered + '；UI 可见生成文本=' + llmVisible + '；终止 state=' + state +
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
    /* 补问记录渲染在步骤卡的 <details class="req-details"> 里，落定后是折叠态 ——
     * aria 快照只收可见文本，先在页内展开全部请求信息再取一次平面快照 */
    await rawExec(['eval',
      "(function(){document.querySelectorAll('details.req-details').forEach(function(d){d.open=true});return 'ok'})()",
      '--json']);
    await sleep(500);
    const flat6 = (await snapUI()).replace(/\s+/g, ' ');
    fs.writeFileSync(path.join(EVID_DIR, 's6-terminal-flat.txt'), flat6, 'utf8');
    const box = await taskSnapshot();
    const okSelect = /option "已付款待发货"[^\n]*\[selected\]/.test(box);
    const sawFollowUp = /文本补问/.test(flat6) && /已选定 已付款待发货/.test(flat6);
    const sawCmd = /select【e\d+ · 订单状态】 "已付款待发货"/.test(flat6);
    record('S6 select 文本补问（候选=真实选项 → 选中已付款待发货）',
      okSelect && sawFollowUp && sawCmd && state6 === 'done',
      '下拉框=' + (okSelect ? '已选中' : '未选中')
      + '；UI 补问记录=' + sawFollowUp
      + '；时间线命令=' + (sawCmd ? 'select 命中' : '未见')
      + '；终止 state=' + state6);
    await saveShot('e2e-s6-select');
  } catch (e) { record('S6 select 文本补问', false, e.message); }

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
