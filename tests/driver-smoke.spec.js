/* browser-driver 真实 playwright-cli 冒烟：对内置 mailbox 演示页跑
 * open → snapshot → pageInfo → 中文 fill → 精确归档 → 弹窗 → 截图 → close。
 * playwright-cli 不可用（未安装 / 无浏览器）时整组跳过，不算失败。 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const driver = require(path.join(ROOT, 'browser-driver.js'));
const { parseSnapshotRefs } = require(path.join(ROOT, 'public', 'js', 'util.js'));

const SESSION = 'jevsmoke' + Date.now().toString(36);
let serverBase = null;
let serverChild = null;
let engineOk = false;

test.before(async () => {
  /* 起静态服务复用 server.js（随机端口） */
  const port = 31000 + Math.floor(Math.random() * 8000);
  serverBase = 'http://127.0.0.1:' + port;
  serverChild = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(port) }),
    stdio: 'ignore', windowsHide: true,
  });
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(serverBase + '/api/health');
      if (r.ok && (await r.json()).ok) break;
    } catch (_) { /* 尚未监听 */ }
    await new Promise((r) => setTimeout(r, 100));
    if (i === 49) throw new Error('冒烟前置：server 未就绪');
  }
  const st = await driver.status();
  engineOk = Boolean(st.available);
});

test.after(async () => {
  if (engineOk) await driver.close(SESSION).catch(() => {});
  if (serverChild) serverChild.kill();
});

test('smoke：open / snapshot / pageInfo', async (t) => {
  if (!engineOk) return t.skip('playwright-cli 不可用，跳过真实浏览器冒烟');
  const opened = await driver.open(SESSION, serverBase + '/demo/mailbox.html', { browser: 'msedge' });
  assert.ok(opened.ok, 'open 失败：' + (opened.error || ''));

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
