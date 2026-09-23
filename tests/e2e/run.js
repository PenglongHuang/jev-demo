/* ===================== Auto 浏览器模式 · E2E 复杂场景验收 =====================
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
 * 运行：node tests/e2e/run.js   （或 npm run test:e2e）
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const driver = require(path.join(__dirname, '..', '..', 'browser-driver.js'));
const { parseSnapshotRefs } = require(path.join(__dirname, '..', '..', 'public', 'js', 'util.js'));
const { startMocks } = require('./mock-server');

const ORIGIN = process.env.E2E_ORIGIN || 'http://localhost:3000';
const UPSTREAM = process.env.E2E_UPSTREAM || 'mock';
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
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('close', () => resolve(out));
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
  const snap = await snapUI();
  const refs = findRefs(snap, matcher);
  const hit = refs[nth == null ? 0 : nth];
  if (!hit) throw new Error('UI 上找不到控件：' + matcher + '（快照 ' + snap.length + ' 字符）');
  const r = await driver.act(UI, 'click', hit.ref, null);
  if (!r.ok) throw new Error('click ' + hit.ref + ' 失败：' + r.error);
  await sleep(400);
  return hit;
}
async function fillLabel(matcher, text, nth) {
  const snap = await snapUI();
  const refs = findRefs(snap, matcher);
  const hit = refs[nth == null ? 0 : nth];
  if (!hit) throw new Error('UI 上找不到输入框：' + matcher);
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
async function resetMailbox() {
  const snap = await taskSnapshot();
  const refs = parseSnapshotRefs(snap).filter((r) => /重置演示/.test(r.label));
  if (!refs.length) throw new Error('任务浏览器里找不到「重置演示」');
  const r = await pageApi('/api/browser/act', { command: 'click', ref: refs[0].ref });
  if (!r.ok) throw new Error('重置失败：' + (r.error && r.error.message ? r.error.message : String(r.error || '')));
  await sleep(600);
}

/* ---------- 轮询等待运行终结 ----------
 * 以状态条 pill 变为「已结束」为准 —— finishRun 的 finally 必然触发；
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
    if (/已结束/.test(flat)) {
      if (tag) fs.writeFileSync(path.join(EVID_DIR, tag + '-flat.txt'), snap, 'utf8');
      return flat;
    }
    if (snap.length !== lastLen) { lastLen = snap.length; lastProgress = Date.now(); }
    if (Date.now() - lastProgress > 45000) throw new Error('运行停滞超 45s（页面无变化）');
    if (/Jev 调用失败/.test(flat)) throw new Error('循环内 Jev 调用失败：' + flat.slice(flat.indexOf('Jev 调用失败'), flat.indexOf('Jev 调用失败') + 200));
  }
  throw new Error('等待运行终结超时（pill 未变为已结束）');
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
  await clickLabel(/官网 .*配置|配置$/);                  /* 顶栏按钮名：官网 ⚙ 配置 */
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
  const opened = await driver.open(UI, ORIGIN, { browser: 'msedge' });
  if (!opened.ok) throw new Error('打开 playground 失败：' + opened.error);
  await sleep(1200);

  if (mocks) {
    await configureMock(mocks.sysonePort, mocks.llmPort);
    record('配置 · 提供商指向 oracle mock + 生成模型槽位', true, 'sysone=' + mocks.sysonePort + ' llm=' + mocks.llmPort);
  }

  /* 进入 Auto 面板 */
  await clickLabel(/"Auto 浏览器"/);
  await sleep(400);

  const GOAL_ARCHIVE = '在收件箱里找到招商银行信用卡中心发来的 9 月电子对账单邮件，点击那一行的「归档」按钮';
  const DEMO_URL = ORIGIN + '/demo/mailbox.html';

  async function fillForm(goal, url) {
    await fillLabel(/"任务目标"/, goal);
    await fillLabel(/"起始 URL"/, url);
  }

  /* ---------- S1 连续 · 归档 9 月对账单 ---------- */
  try {
    await fillForm(GOAL_ARCHIVE, DEMO_URL);
    await clickLabel(/"连续自动"/);
    await clickLabel(/打开浏览器并开始/);
    const flat = await waitEnd('s1-terminal');
    await sleep(1500);
    const box = await taskSnapshot();
    const okMail = /已归档 1 封/.test(box)
      && !/listitem "邮件[^"]*9 月电子对账单/.test(box)
      && /listitem "邮件[^"]*8 月电子对账单/.test(box)
      && /listitem "邮件[^"]*兴业银行/.test(box);
    const okDone = /Jev 判定：任务已完成|任务完成（Jev 连续两轮/.test(flat);
    const okUi = okDone && (/click【e\d+ · 归档】/.test(flat) || /归档/.test(flat));
    record('S1 连续模式 · 精确归档 9 月对账单（8 月/兴业保留）', okMail && okUi && okDone,
      (okMail ? '邮箱状态正确：已归档 1 封、干扰项保留' : '邮箱状态异常') + '；终止=' + okDone);
    await saveShot('e2e-s1-archive');
  } catch (e) { record('S1 连续模式 · 归档对账单', false, e.message); }

  /* ---------- S2 连续 · 搜索（生成输入 → LLM → fill 闭环） ---------- */
  try {
    await resetMailbox();
    await fillForm('在邮箱里搜索出所有招商银行相关的邮件', DEMO_URL);
    await clickLabel(/打开浏览器并开始/);
    const flat = await waitEnd('s2-terminal');
    await sleep(1500);
    const box = await taskSnapshot();
    const items = (box.match(/- listitem "邮件/g) || []).length;
    const filtered = /searchbox "搜索邮件" (?:\[[^\]]+\] )*\[ref=[^\]]+\]: 招商银行/.test(box) && items === 5;
    const llmVisible = /生成文本 → 招商银行/.test(flat) && /生成输入【/.test(flat);
    const done = /Jev 判定：任务已完成|任务完成（Jev 连续两轮|连续 3 步执行失败/.test(flat);
    record('S2 生成输入闭环（LLM → fill → 过滤 5 封）', filtered && llmVisible && done,
      '邮箱过滤=' + filtered + '；UI 可见生成文本=' + llmVisible + '；终止=' + done +
      (done && /连续 3 步执行失败/.test(flat) ? '（存在执行失败步骤，详见 s2-terminal-flat.txt）' : ''));
    await saveShot('e2e-s2-llm');
  } catch (e) { record('S2 生成输入闭环', false, e.message); }

  /* ---------- S3 单步确认 · 逐轮点「执行本步」 ---------- */
  try {
    await resetMailbox();
    await fillForm(GOAL_ARCHIVE, DEMO_URL);
    await clickLabel(/"单步确认"/);
    await clickLabel(/打开浏览器并开始/);
    const t0 = Date.now();
    let confirms = 0;
    while (Date.now() - t0 < 150000) {
      const snap = await snapUI();
      const flat = snap.replace(/\s+/g, ' ');
      if (/已结束/.test(flat)) break;
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
      ok ? '单步路径完成归档' : '单步路径异常（confirms=' + confirms + '）');
    await saveShot('e2e-s3-single');
  } catch (e) { record('S3 单步确认模式', false, e.message); }

  /* ---------- S4 步数上限=2 ---------- */
  try {
    await resetMailbox();
    await fillForm('把收件箱里的所有邮件都归档', DEMO_URL);
    await fillLabel(/"步数上限"/, '2');
    await clickLabel(/"连续自动"/);
    await clickLabel(/打开浏览器并开始/);
    const flat4 = await waitEnd('s4-terminal', 120000);
    record('S4 步数上限终止（max=2 触发 banner）', /达到步数上限（2）/.test(flat4));
    await saveShot('e2e-s4-maxsteps');
  } catch (e) { record('S4 步数上限终止', false, e.message); }

  /* ---------- 构造契约终审 + LLM prompt 可见性 ---------- */
  if (mocks) {
    try {
      const rep = await mocks.report();
      record('M1 前端构造契约（每请求 4 问 / 31 动作候选 / 参数=快照全量 ref）',
        rep.violations.length === 0,
        rep.violations.length ? rep.violations.slice(0, 4).join(' | ') : '共 ' + rep.reqCount + ' 次请求零违规');
      /* oracle 每轮决策日志（排障证据） */
      fs.writeFileSync(path.join(EVID_DIR, 'oracle-decisions.json'), JSON.stringify(rep.decisions, null, 2), 'utf8');
      const llmOk = rep.llmCalls.length >= 1 && rep.llmCalls[0].prompt
        && rep.llmCalls[0].prompt.some((m) => /在邮箱里搜索出所有招商银行相关的邮件/.test(m.content))
        && rep.llmCalls[0].prompt.some((m) => /搜索邮件/.test(m.content))
        && rep.llmCalls[0].auth === 'Bearer mock-llm-key';
      record('M2 LLM prompt 工程（目标+字段上下文注入，key 经请求头透传）', llmOk,
        'llm 调用 ' + rep.llmCalls.length + ' 次');
      mocks.close();
    } catch (e) { record('M1/M2 mock 终审', false, e.message); }
  }

  /* ---------- 清理与汇总 ---------- */
  await pageApi('/api/browser/close', {}).catch(() => {});
  await driver.close(UI).catch(() => {});
  const failed = results.filter((r) => !r.ok);
  const lines = results.map((r) => (r.ok ? '✅' : '❌') + ' ' + r.name + (r.detail ? ' — ' + r.detail : ''));
  fs.writeFileSync(path.join(EVID_DIR, 'e2e-result.md'),
    '# Auto 浏览器 E2E · ' + new Date().toISOString() + '\n\n上游：' + UPSTREAM + '\n\n' + lines.join('\n') + '\n\n结果：' +
    (results.length - failed.length) + '/' + results.length + ' 通过\n', 'utf8');
  console.log('\n==== E2E 汇总：' + (results.length - failed.length) + '/' + results.length + ' 通过 ====');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('E2E 致命错误：', e && e.stack || e);
  process.exit(2);
});
