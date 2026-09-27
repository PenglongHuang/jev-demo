/* persistent 模式验收：profile 真的落在 data/browser-profile/（而不是临时目录），
 * 且关掉再开时那个目录**没有被重置** —— 「登录一次长期复用」全靠这两条。
 *
 * 用的是应用自己的 profile 目录（就是用户真正在用的那个，data/ 已 gitignore）：
 * 测试不删它 —— 用户可能已经在这里登过录，删掉等于替他退出登录。
 * 若那个 profile 正被别的窗口占用（Chrome 进程单例），整组跳过。
 *
 * 局限（人工验收一次）：真正的「扫码登录后下次仍是登录态」需要人参与，
 * 自动化只保证承载登录态的目录是同一个、且不被清理。 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const driver = require(path.join(ROOT, 'browser-driver.js'));
const PROFILE_DIR = path.join(ROOT, 'data', driver._test.PROFILE_DIR);
const SENTINEL = path.join(PROFILE_DIR, 'jev-profile-sentinel.txt');
const SESSION = 'jevprof' + Date.now().toString(36);

let serverChild = null;
let serverBase = null;
let engineOk = false;
let skipReason = '';

test.before(async () => {
  const st = await driver.status();
  engineOk = Boolean(st.available);
  if (!engineOk) { skipReason = 'playwright-cli 不可用'; return; }

  const port = 36000 + Math.floor(Math.random() * 20000);
  serverBase = 'http://127.0.0.1:' + port;
  serverChild = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(port) }),
    stdio: 'ignore', windowsHide: true,
  });
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(serverBase + '/api/health'); if (r.ok) break; } catch (_) { /* 未监听 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
});

test.after(async () => {
  await driver.close(SESSION).catch(() => {});
  if (serverChild) serverChild.kill();
});

const openPersistent = () => driver.open(SESSION, serverBase + '/demo/mailbox.html', { mode: 'persistent' });

test('persistent：profile 落在 data/browser-profile/，Chrome 真的用它，且关掉再开不被重置', async (t) => {
  if (skipReason) return t.skip(skipReason);

  const opened = await openPersistent();
  if (!opened.ok && /already in use|占用/i.test(opened.error || '')) {
    return t.skip('持久 profile 正被另一个窗口占用，跳过：' + opened.error);
  }
  assert.ok(opened.ok, 'persistent open 失败：' + (opened.error || ''));
  assert.strictEqual(opened.mode, 'persistent');
  t.diagnostic('profile：' + PROFILE_DIR);

  /* ① 目录必须落在 data/ 下（README 的「备份 data/ 即备份全部数据」靠它成立） */
  assert.ok(fs.existsSync(PROFILE_DIR), 'profile 目录没建出来：' + PROFILE_DIR);
  assert.ok(PROFILE_DIR.startsWith(path.join(ROOT, 'data')), 'profile 必须落在 data/ 内');

  /* ② Chrome 确实把这个目录当自己的 profile 用了（不是起了个临时 profile） */
  const chromeFiles = fs.readdirSync(PROFILE_DIR);
  assert.ok(chromeFiles.some((f) => f === 'Default' || f === 'Local State'),
    'Chrome 没往这个目录写 profile 数据，实际内容：' + JSON.stringify(chromeFiles.slice(0, 12)));

  const snap = await driver.snapshot(SESSION);
  assert.ok(snap.ok && /收件箱/.test(snap.snapshot), '页面应正常加载');

  /* ③ 关掉再开：目录内容不得被重置（登录态就住在这里面） */
  fs.writeFileSync(SENTINEL, 'sentinel');
  const closed = await driver.close(SESSION);
  assert.ok(closed.ok);

  const reopened = await openPersistent();
  if (!reopened.ok && /already in use|占用/i.test(reopened.error || '')) {
    return t.skip('重开时 profile 被占用，跳过：' + reopened.error);
  }
  assert.ok(reopened.ok, '重开失败：' + (reopened.error || ''));
  assert.ok(fs.existsSync(SENTINEL), '重开后 profile 目录被重置了 —— 登录态会跟着一起丢');
  assert.ok(fs.existsSync(path.join(PROFILE_DIR, 'Default')) || fs.existsSync(path.join(PROFILE_DIR, 'Local State')),
    '重开后 Chrome 数据仍在');

  const snap2 = await driver.snapshot(SESSION);
  assert.ok(snap2.ok && /收件箱/.test(snap2.snapshot));
  const closed2 = await driver.close(SESSION);
  assert.ok(closed2.ok);
  assert.strictEqual(closed2.mode, 'persistent');
  try { fs.unlinkSync(SENTINEL); } catch (_) { /* 清掉探针即可，profile 留着 */ }
});
