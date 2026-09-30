/* browser-driver 真实 playwright-cli 冒烟：对内置 mailbox 演示页跑
 * open → snapshot → pageInfo → 中文 fill → 精确归档 → 弹窗 → 截图 → close。
 * 引擎不可用时整组跳过，不算失败。
 *
 * **跑在默认后端上**（现在是进程内 / playwright-core）：这些用例问的是 driver 的对外行为，
 * 默认走哪条就该验哪条 —— 曾经因为 inproc 的 open 有个 mode 传参缺陷、每次静默退回 CLI，
 * 整组用例名义上全绿却一条都没碰到默认后端，六个缺陷因此活到人工评审才被翻出来。
 * 只有「合并动作片段」那一条是 CLI 路的产物，它自带 CLI 会话（见那条的说明）。 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');
const net = require('net');
const childProcess = require('child_process');

const ROOT = path.join(__dirname, '..');
const driver = require(path.join(ROOT, 'browser-driver.js'));
const { parseSnapshotRefs } = require(path.join(ROOT, 'public', 'js', 'util.js'));
const { startServer } = require('./helpers/server.js');

const SESSION = 'jevsmoke' + Date.now().toString(36);
/* 「合并动作片段」那条专用的 CLI 会话：默认后端是进程内，CLI 看不见那条会话（见用例说明） */
const SESSION_CLI = SESSION + 'cli';
/* 冒烟用哪个内核：默认跟随应用默认（chrome），JEVDEMO_BROWSER=msedge 可覆盖。
 * 夹具（tests/fixtures/*.js）是 msedge 采的静态数据，与这里跑哪个内核无关；
 * 原先在此写死 msedge，于是每次 npm test 都会弹一个 Edge 窗口。 */
const BROWSER = process.env.JEVDEMO_BROWSER || 'chrome';
let serverBase = null;
let serverChild = null;
let engineOk = false;   /* 两条后端里任一可用即可跑本组 */
let cliOk = false;      /* 只有「合并动作片段」那条需要真的 spawn playwright-cli */

test.before(async () => {
  /* 起静态服务复用 server.js（随机端口） */
  const srv = startServer(31000);
  serverChild = srv.child;
  serverBase = srv.base;
  await srv.wait();
  const st = await driver.status();
  engineOk = Boolean(st.available);
  cliOk = Boolean(st.backends && st.backends.cli && st.backends.cli.available);
});

test.after(async () => {
  if (engineOk) await driver.close(SESSION).catch(() => {});
  if (cliOk) await driver.close(SESSION_CLI).catch(() => {});
  if (serverChild) serverChild.kill();
});

test('smoke：open / snapshot / pageInfo', async (t) => {
  if (!engineOk) return t.skip('playwright-cli 不可用，跳过真实浏览器冒烟');
  const opened = await driver.open(SESSION, serverBase + '/demo/mailbox.html', { browser: BROWSER });
  assert.ok(opened.ok, 'open 失败：' + (opened.error || ''));
  /* 打印实际内核：首选内核启动失败时 driver 会静默换另一个并丢掉原始错误，
   * 只有这行输出能让人看出「要的是 A、跑的是 B」。 */
  t.diagnostic('实际内核：' + opened.browser);

  const snap = await driver.snapshot(SESSION);
  assert.ok(snap.ok && snap.snapshot.includes('[ref='));
  assert.match(snap.snapshot, /收件箱/);
  assert.match(snap.snapshot, /招商银行信用卡中心/);

  const info = await driver.pageInfo(SESSION);
  assert.ok(info.ok);
  assert.match(info.url, /\/demo\/mailbox\.html/);
  assert.match(info.title, /灵犀邮箱/);
});

test('smoke：中文 fill 搜索框 → 快照反映过滤结果', async (t) => {
  if (!engineOk) return t.skip('playwright-cli 不可用');
  const snap1 = await driver.snapshot(SESSION);
  const refs = parseSnapshotRefs(snap1.snapshot);
  const search = refs.find((r) => /searchbox "搜索邮件"/.test(r.label));
  assert.ok(search, '快照里找不到搜索框 ref');

  const filled = await driver.act(SESSION, 'fill', search.ref, '招商银行');
  assert.ok(filled.ok, 'fill 失败：' + (filled.error || ''));

  /* 演示页搜索是 input 即时过滤：招行系邮件共 5 封（信用卡中心 3 + 储蓄卡 2） */
  const snap2 = await driver.snapshot(SESSION);
  const items = (snap2.snapshot.match(/- listitem "邮件/g) || []).length;
  assert.strictEqual(items, 5, '过滤后应为 5 封招商银行相关邮件');
});

test('smoke：精确归档 9 月对账单（干扰项保留）', async (t) => {
  if (!engineOk) return t.skip('playwright-cli 不可用');
  const snap = await driver.snapshot(SESSION);
  const refs = parseSnapshotRefs(snap.snapshot);
  /* 过滤后列表第 1 封是 9 月对账单（09-23 08:12 最新），其后的第一个「归档」按钮 */
  const archive = refs.find((r) => /button "归档"/.test(r.label));
  assert.ok(archive, '找不到归档按钮 ref');

  const clicked = await driver.act(SESSION, 'click', archive.ref, null);
  assert.ok(clicked.ok, 'click 失败：' + (clicked.error || ''));

  const snap2 = await driver.snapshot(SESSION);
  /* 注意：归档后的 toast 提示也含主题文本，须按 listitem 结构断言 */
  assert.doesNotMatch(snap2.snapshot, /listitem "邮件 1：招商银行信用卡中心 · 您的 9 月电子对账单已生成"/, '9 月对账单应已归档移出列表');
  assert.match(snap2.snapshot, /listitem "邮件.*您的 8 月电子对账单已生成"/, '8 月干扰项应保留');
  assert.strictEqual((snap2.snapshot.match(/- listitem "邮件/g) || []).length, 4, '过滤 5 封归档 1 封后应剩 4 封');
});

test('smoke：删除触发原生 confirm → dialog-accept 接受', async (t) => {
  if (!engineOk) return t.skip('playwright-cli 不可用');
  const snap = await driver.snapshot(SESSION);
  const refs = parseSnapshotRefs(snap.snapshot);
  const del = refs.find((r) => /button "删除"/.test(r.label));
  assert.ok(del, '找不到删除按钮 ref');

  /* click 触发原生 confirm 后页面被挂起，需要 dialog-accept 收尾 */
  const clicked = await driver.act(SESSION, 'click', del.ref, null);
  await new Promise((r) => setTimeout(r, 400));
  const accepted = await driver.act(SESSION, 'dialog-accept', null, null);
  assert.ok(accepted.ok, 'dialog-accept 失败：' + (accepted.error || ''));

  const snap2 = await driver.snapshot(SESSION);
  const items = (snap2.snapshot.match(/- listitem "邮件/g) || []).length;
  assert.strictEqual(items, 3, '删除 1 封后应剩 3 封');
});

/* 回归：读元素位置必须是**只读**的，且位置与视口同一时刻读到。
 * 早先的实现是往页面注入 overlay 画标记 —— 人盯着被驱动的浏览器窗口会看到环，
 * 还多一份污染快照的风险。现在标注只画在图上，页面必须一尘不染：本用例把它钉死。
 * 位置准不准另有一条：读数要落在元素自己身上（宽度/高度为正、在视口内）。 */
test('smoke：读元素位置只读不改页面，且位置与视口同一时刻读到', async (t) => {
  if (!engineOk) return t.skip('playwright-cli 不可用');
  const before = await driver.snapshot(SESSION);
  const refs = parseSnapshotRefs(before.snapshot);
  const target = refs.find((r) => /button "归档"/.test(r.label)) || refs.find((r) => r.interactive);
  assert.ok(target, '快照里找不到可点元素');

  const r = await driver.rect(SESSION, target.ref);
  assert.ok(r.ok, 'rect 失败：' + (r.error || ''));
  assert.ok(r.rect.w > 0 && r.rect.h > 0, '元素尺寸应为正：' + JSON.stringify(r.rect));
  assert.ok(r.viewport.w > 0 && r.viewport.h > 0, '视口尺寸应为正：' + JSON.stringify(r.viewport));
  assert.ok(r.rect.x >= 0 && r.rect.y >= 0, '元素应落在视口内：' + JSON.stringify(r.rect));
  assert.ok(r.rect.x + r.rect.w <= r.viewport.w + 2 && r.rect.y + r.rect.h <= r.viewport.h + 2,
    '元素不该超出视口：rect=' + JSON.stringify(r.rect) + ' viewport=' + JSON.stringify(r.viewport));

  /* 只读：读数前后快照必须逐字节一致（页面里不留任何节点） */
  const after = await driver.snapshot(SESSION);
  assert.strictEqual(after.snapshot, before.snapshot, '读位置不得改动页面');
});

/* 动作之后的快照（「直接顶替下一步的 snapshot」）在真机上的两条：
 *   ① 老路（CLI 动作命令）对**会给工件的动作**必须把快照带回来，且内容是**动作之后**的页面；
 *   ② 对**不给工件的动作**（fill 就是）必须如实为 null —— 前端据此真取一次，
 *      不许把「没有」伪装成「有」（伪装了的后果是下一步拿空页面当依据）。
 * 断言挑的是「动作把这一封邮件移出了列表」这件事在快照里看得见 —— 这正是整件事的意义：
 * 拿到的必须是动作之后的页面，不是动作之前的。 */
test('smoke：click 顺带带回动作后的快照，fill 如实没有', async (t) => {
  if (!engineOk) return t.skip('playwright-cli 不可用');
  const opened = await driver.open(SESSION, serverBase + '/demo/mailbox.html', { browser: BROWSER });
  assert.ok(opened.ok, 'open 失败：' + (opened.error || ''));

  const before = await driver.snapshot(SESSION);
  const subject = (before.snapshot.match(/listitem "邮件 \d+：([^"]+)"/) || [])[1];
  assert.ok(subject, '快照里找不到邮件条目');
  const archive = parseSnapshotRefs(before.snapshot).find((r) => /button "归档"/.test(r.label));
  assert.ok(archive, '找不到归档按钮 ref');

  const clicked = await driver.act(SESSION, 'click', archive.ref, null);
  assert.ok(clicked.ok, 'click 失败：' + (clicked.error || ''));
  assert.equal(typeof clicked.snapshot, 'string', 'click 必须带回动作后的快照（上游 setIncludeSnapshot + waitForCompletion）');
  assert.match(clicked.snapshot, /\[ref=/, '带回来的必须是能用的快照（下游全按 ref 行解析）');
  assert.doesNotMatch(clicked.snapshot, new RegExp('listitem "邮件 \\d+：' + subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    '带回来的必须是**动作之后**的页面：被归档的那封不该还在里面');

  const filled = await driver.act(SESSION, 'fill', parseSnapshotRefs(before.snapshot).find((r) => /searchbox/.test(r.label)).ref, '招商');
  assert.ok(filled.ok, 'fill 失败：' + (filled.error || ''));
  assert.equal(filled.snapshot, null,
    '上游对 fill（browser_type 的普通分支）不给工件 —— 这里必须如实为 null，前端才会真取一次');
});

/* CDP 快路径那条合并命令（动作 + 等稳定 + 取快照）在真机上跑得通。
 * 快路径只在 cdp 模式启用，但片段本身与模式无关：这里直接把生成出来的那条命令喂给
 * run-code（守卫要的 window.name 先自己写上），验的是片段本身 —— 它要同时在浏览器里
 * 做成三件事：动作、等稳定、把快照交回来。
 *
 * **这一条自带 CLI 会话**：它验的 mergedActCode 是 playwright-cli 那条路的产物，而默认
 * 后端现在是进程内 —— 上一条用例开出来的会话 playwright-cli 根本看不见（`-s=` 找不到会话，
 * 直接报错）。所以这里按 opts.backend pin 一条 CLI 会话来当环境，验完就关；顺带把「opts.backend
 * 能压过默认后端」这条选择链也钉住了。 */
test('smoke：合并动作片段在真机上带回动作后的快照', async (t) => {
  if (!cliOk) return t.skip('playwright-cli 不可用（这一条要真的 spawn CLI）');
  const opened = await driver.open(SESSION_CLI, serverBase + '/demo/mailbox.html', { browser: BROWSER, backend: 'cli' });
  assert.ok(opened.ok, 'CLI 会话 open 失败：' + (opened.error || ''));
  assert.strictEqual(opened.backend, 'cli', '这一条必须跑在 CLI 后端上');
  const TOKEN = 'jevsmoke-token-1';
  const { quoteArg, mergedActCode, codeValue } = driver._test;
  const cli = (args) => {
    /* --json 与 driver 的 run() 一致：不加拿到的是 "### Result" 文本形态，不是 JSON */
    const line = ['playwright-cli', '-s=' + SESSION_CLI].concat(args, ['--json']).map(quoteArg).join(' ');
    const r = childProcess.spawnSync(line, { shell: true, encoding: 'utf8', timeout: 60000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return String(r.stdout || '').trim();
  };

  const before = await driver.snapshot(SESSION_CLI);
  const subject = (before.snapshot.match(/listitem "邮件 \d+：([^"]+)"/) || [])[1];
  const archive = parseSnapshotRefs(before.snapshot).find((r) => /button "归档"/.test(r.label));
  assert.ok(subject && archive, '需要一封可归档的邮件');

  const set = JSON.parse(cli(['eval', "() => { window.name = '" + TOKEN + "'; }"]) || '{}');
  assert.ok(!set.isError, '设置 window.name 失败：' + JSON.stringify(set));

  const file = path.join(ROOT, 'data', 'smoke-act-code.js');
  fs.writeFileSync(file, mergedActCode(TOKEN, 'click', archive.ref, ''), 'utf8');
  const raw = JSON.parse(cli(['run-code', '--filename=' + file]) || '{}');
  fs.unlinkSync(file);
  assert.ok(!raw.isError, 'run-code 失败：' + JSON.stringify(raw).slice(0, 300));

  const v = codeValue(raw.result) || {};
  assert.ok(!v.actError, '动作不该失败：' + v.actError);
  assert.match(String(v.snapshot || ''), /\[ref=/, '合并命令必须把动作后的快照交回来');
  assert.doesNotMatch(String(v.snapshot || ''), new RegExp('listitem "邮件 \\d+：' + subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    '交回来的必须是动作之后的页面');

  await driver.close(SESSION_CLI);
});

test('smoke：screenshot 返回 dataURL；close 关闭会话', async (t) => {
  if (!engineOk) return t.skip('playwright-cli 不可用');
  const shot = await driver.screenshot(SESSION, 'smoke-final');
  assert.ok(shot.ok && shot.dataUrl.startsWith('data:image/png;base64,'));
  assert.ok(shot.dataUrl.length > 5000, '截图 base64 体积异常');

  const closed = await driver.close(SESSION);
  assert.ok(closed.ok);
});
test('smoke：白名单从 HTTP 层拒绝（act 直接拒绝 eval / close 命令）', async (t) => {
  if (!engineOk) return t.skip('playwright-cli 不可用');
  const bad1 = await driver.act(SESSION, 'eval', null, '1+1');
  assert.ok(!bad1.ok && /白名单/.test(bad1.error));
  const bad2 = await driver.act(SESSION, 'cookie-set', null, 'a=b');
  assert.ok(!bad2.ok);
  /* 清理可能残留的会话 */
  await driver.close(SESSION).catch(() => {});
  fs.readdirSync(path.join(ROOT, 'data')).forEach((f) => {
    if (/^smoke-final/.test(f)) fs.unlinkSync(path.join(ROOT, 'data', f));
  });
});
