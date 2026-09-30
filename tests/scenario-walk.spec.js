/* 内置演示场景走查：SCENARIOS（public/js/auto.js）的三个多步任务目标里引用了
 * 页面的具体事实（李婉宁 / 周一鸣 / 刘畅 / 王小明的订单号……）。目标文案是给
 * Jev 读的提示词，改演示页数据时很容易忘记同步 —— 本组用例按目标的动作序列
 * 逐步真实执行一遍，把「每个动作都有 ref 可点、终态与文案宣称的一致」钉死。
 * playwright-cli 不可用（未安装 / 无浏览器）时整组跳过，不算失败。 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const driver = require(path.join(ROOT, 'browser-driver.js'));
const { parseSnapshotRefs } = require(path.join(ROOT, 'public', 'js', 'util.js'));
const { startServer } = require('./helpers/server.js');

const SESSION = 'jevwalk' + Date.now().toString(36);
const BROWSER = process.env.JEVDEMO_BROWSER || 'chrome';
let serverBase = null;
let serverChild = null;
let engineOk = false;
let snap = '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function snapFresh() {
  const r = await driver.snapshot(SESSION);
  assert.ok(r.ok, 'snapshot 失败：' + r.error);
  snap = r.snapshot;
  return snap;
}
async function act(cmd, ref, text) {
  const r = await driver.act(SESSION, cmd, ref, text);
  assert.ok(r.ok, cmd + ' 失败：' + (r.error || ''));
  await sleep(350);
  return snapFresh();
}
/* 按 label 正则找 ref；from 限定「该 ref 之后」（行内定位用） */
function refOf(re, from) {
  const refs = parseSnapshotRefs(snap);
  const start = from ? refs.findIndex((r) => r.ref === from) + 1 : 0;
  const hit = refs.slice(start < 0 ? 0 : start).find((r) => re.test(r.label));
  assert.ok(hit, '快照里找不到：' + re);
  return hit.ref;
}
/* 数收件箱行数。**必须容忍 YAML 的行内引号**：playwright-cli 的快照是 YAML，
 * 元素名里含「冒号+空格」（如「Re: 周五评审会材料确认」）时整行会被包成
 * - 'listitem "邮件 2：…"'，行首就不再是裸的 `- listitem`。原先的正则漏掉这一行，
 * 于是 18 封被数成 17 封 —— 页面是对的，数错了。 */
const countMail = () => (snap.match(/- '?listitem "邮件/g) || []).length;

test.before(async () => {
  const srv = startServer(32000);
  serverChild = srv.child;
  serverBase = srv.base;
  await srv.wait();
  engineOk = Boolean((await driver.status()).available);
});

test.after(async () => {
  if (engineOk) await driver.close(SESSION).catch(() => {});
  if (serverChild) serverChild.kill();
});

/* ---------- 📦 邮箱：标星 → 星标文件夹 → 回收件箱 → 搜索 → 归档 9 月 → 删 8 月 → 接受弹窗 ---------- */

test('场景走查：邮箱收件箱 7 步（含原生 confirm）', async (t) => {
  if (!engineOk) return t.skip('playwright-cli 不可用，跳过场景走查');
  const o = await driver.open(SESSION, serverBase + '/demo/mailbox.html', { browser: BROWSER });
  assert.ok(o.ok, 'open 失败：' + (o.error || ''));
  await snapFresh();

  /* ① 李婉宁行的「未标星」在她名字按钮的前一个 ref（点击后整页重渲染、
   * ref 重新分配，复核一律按 label 重找，不能复用旧 ref） */
  const refs = parseSnapshotRefs(snap);
  const i = refs.findIndex((r) => /button "李婉宁"/.test(r.label));
  const star = refs.slice(0, i).reverse().find((r) => /button "未标星"/.test(r.label));
  assert.ok(star, '李婉宁行找不到未标星按钮');
  await act('click', star.ref);
  const refs2 = parseSnapshotRefs(snap);
  assert.match(refs2[refs2.findIndex((r) => /button "李婉宁"/.test(r.label)) - 1].label, /已标星/);

  /* ② 星标文件夹里有她；③ 回收件箱 18 封 */
  await act('click', refOf(/button "星标邮件/));
  assert.match(snap, /李婉宁[\s\S]*Re: 周五评审会材料确认|Re: 周五评审会材料确认[\s\S]*李婉宁/);
  await act('click', refOf(/button "收件箱/));
  assert.strictEqual(countMail(), 18);

  /* ④ 搜索招商银行 → 5 封 */
  await act('fill', refOf(/searchbox "搜索邮件"/), '招商银行');
  assert.strictEqual(countMail(), 5);

  /* ⑤ 归档 9 月（过滤后第 1 封的第 1 个归档）→ 4 封 */
  await act('click', refOf(/button "归档"/));
  assert.strictEqual(countMail(), 4);

  /* ⑥ 删 8 月（8 月主题按钮之后的第 1 个删除）→ confirm → ⑦ 接受 → 3 封。
   * 弹窗打开期间 snapshot 拒绝工作（modal state），这步不走「动作后即快照」的 act。 */
  let r = await driver.act(SESSION, 'click', refOf(/button "删除"/, refOf(/button "您的 8 月电子对账单已生成（附件）"/)), null);
  assert.ok(r.ok, 'click 删除失败：' + (r.error || ''));
  await sleep(400);
  r = await driver.act(SESSION, 'dialog-accept');
  assert.ok(r.ok, 'dialog-accept 失败：' + (r.error || ''));
  await sleep(350);
  await snapFresh();
  assert.strictEqual(countMail(), 3, '目标宣称的终态：过滤后剩 3 封');
});

/* ---------- 📄 简历：筛岗位 → 邀周一鸣 → 回全部岗位 → 邀刘畅 → 已邀请筛选 → 回全部 ---------- */

test('场景走查：简历筛选 6 步（跨岗位邀约两位）', async (t) => {
  if (!engineOk) return t.skip('playwright-cli 不可用，跳过场景走查');
  const o = await driver.open(SESSION, serverBase + '/demo/resume.html', { browser: BROWSER });
  assert.ok(o.ok, 'open 失败：' + (o.error || ''));
  await snapFresh();

  /* ① 筛高级前端工程师：周一鸣在、刘畅（前端工程师岗）不在 */
  await act('select', refOf(/combobox "投递岗位"/), '高级前端工程师');
  assert.match(snap, /候选人 周一鸣（高级前端工程师）/);
  assert.doesNotMatch(snap, /候选人 刘畅（前端工程师）/);

  /* ② 邀周一鸣（React+TS ≤35K 唯一；李强 38K 是干扰项） */
  await act('click', refOf(/button "邀请面试"/, refOf(/button "周一鸣"/)));
  assert.match(snap, /已邀请 1 位/);

  /* ③ 回全部岗位 → ④ 邀刘畅 */
  await act('select', refOf(/combobox "投递岗位"/), '全部岗位');
  await act('click', refOf(/button "邀请面试"/, refOf(/button "刘畅"/)));
  assert.match(snap, /已邀请 2 位/);

  /* ⑤ 已邀请快捷筛选恰好两位 → ⑥ 回全部 */
  await act('click', refOf(/button "已邀请面试/));
  assert.strictEqual((snap.match(/article "候选人/g) || []).length, 2);
  await act('click', refOf(/button "全部候选人/));
  assert.match(snap, /已邀请 2 位/);
});

/* ---------- 🧾 订单：筛待发货 → 发 AirPods Pro 2 → 发保护套 → 切已发货 → 搜索复核 ---------- */

test('场景走查：订单后台 5 步（两笔发货 + 复核）', async (t) => {
  if (!engineOk) return t.skip('playwright-cli 不可用，跳过场景走查');
  const o = await driver.open(SESSION, serverBase + '/demo/orders.html', { browser: BROWSER });
  assert.ok(o.ok, 'open 失败：' + (o.error || ''));
  await snapFresh();

  /* ① 筛已付款待发货：王小明的 AirPods Pro 2 在列（张伟的 AirPods 4 是干扰项） */
  await act('select', refOf(/combobox "订单状态"/), '已付款待发货');
  assert.match(snap, /ORD-20260921-4884/);

  /* ② 订单号 ref 之后的第 1 个发货按钮 */
  await act('click', refOf(/button "发货"/, refOf(/ORD-20260921-4884/)));

  /* ③ 保护套订单（张伟）发货 */
  await act('click', refOf(/button "发货"/, refOf(/AirPods Pro 2 保护套/)));

  /* ④ 切已发货 → ⑤ 搜索王小明复核（¥1,899 已发货在列） */
  await act('select', refOf(/combobox "订单状态"/), '已发货');
  await act('fill', refOf(/searchbox "搜索订单号/), '王小明');
  assert.match(snap, /ORD-20260921-4884/);
  assert.match(snap, /已发货/);
  assert.match(snap, /1,?899/);
});
