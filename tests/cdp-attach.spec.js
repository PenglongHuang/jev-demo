/* CDP 直连验收：真的起一个**临时身份**的浏览器（自有 user-data-dir + 调试端口），
 * 让 driver 以 cdp 模式 attach 上去，逐条验证四面安全承诺：
 *
 *   1) 只在我们自己 tab-new 出来的标签页里操作（不去 goto 用户已开的那一个）；
 *      你原有的标签页不许 tab-select 选过去，切到自己的新 Tab 后守卫仍认它
 *   2) 窗口几何一律不碰（resize / fullscreen 拒绝执行）
 *   3) 用户关掉专用标签页 → 守卫立刻发现并停手，绝不在相邻（用户的）页面上继续
 *   4) close 只断开连接，**浏览器进程仍然活着**
 *
 * 用的是我们自己拉起的临时 profile，不碰任何人日常浏览器的数据。
 * 找不到 Chrome/Edge 可执行文件、或 playwright-cli 不可用时整组跳过。 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const driver = require(path.join(ROOT, 'browser-driver.js'));
const { startServer } = require('./helpers/server.js');
const { parseDevToolsPort } = driver._test;
const { parseSnapshotRefs } = require(path.join(ROOT, 'public', 'js', 'util.js'));

const SESSION = 'jevcdp' + Date.now().toString(36);
const START_TAB = 'about:blank';   /* 用户「本来就开着」的标签页 —— 全程都不该被导航 */

function browserCandidates() {
  const e = process.env;
  const win = [
    path.join(e.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(e.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(e['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(e['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(e.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  const mac = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  const lin = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge'];
  return (process.platform === 'win32' ? win : process.platform === 'darwin' ? mac : lin).filter((p) => p && fs.existsSync(p));
}

let serverChild = null;
let serverBase = null;
let chromeChild = null;
let profileDir = null;
let endpoint = null;
let engineOk = false;
let skipReason = '';

test.before(async () => {
  const st = await driver.status();
  engineOk = Boolean(st.available);
  if (!engineOk) { skipReason = 'playwright-cli 不可用'; return; }

  const exe = browserCandidates()[0];
  if (!exe) { skipReason = '找不到 Chrome / Edge 可执行文件'; return; }

  /* 静态页服务（起点 URL 必须是 http(s)，driver 会挡掉 about:blank） */
  const srv = startServer(35000);
  serverChild = srv.child;
  serverBase = srv.base;
  await srv.wait();

  /* 临时身份的浏览器：自有 user-data-dir（Chrome 136+ 只对默认目录禁用远程调试），
   * 端口交 0 让系统分配，实际端口由它自己写进 DevToolsActivePort —— 正好复用
   * driver 里那个解析函数。端点用 http 形态：ws://host:port/devtools/browser（去掉 UUID
   * 路径）会被 Chrome 回 404，http 形态则由 Playwright 走 /json/version 自己发现端点。 */
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-cdp-'));
  chromeChild = spawn(exe, [
    '--remote-debugging-port=0',
    '--user-data-dir=' + profileDir,
    '--no-first-run', '--no-default-browser-check',
    START_TAB,
  ], { stdio: 'ignore', windowsHide: true });

  const portFile = path.join(profileDir, 'DevToolsActivePort');
  for (let i = 0; i < 100; i++) {
    try {
      const p = parseDevToolsPort(fs.readFileSync(portFile, 'utf8'));
      if (p) { endpoint = 'http://127.0.0.1:' + p; break; }
    } catch (_) { /* 还没写出来 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!endpoint) skipReason = '临时浏览器没写出 DevToolsActivePort';
});

test.after(async () => {
  await driver.close(SESSION).catch(() => {});
  if (chromeChild && chromeChild.exitCode === null) chromeChild.kill();
  if (serverChild) serverChild.kill();
  if (profileDir) { try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (_) { /* 占用中就算了 */ } }
});

const openCdp = () => driver.open(SESSION, serverBase + '/demo/mailbox.html', { mode: 'cdp', cdp: endpoint });

test('cdp：attach 后只操作新建的专用标签页，用户原有的标签页原样不动', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const opened = await openCdp();
  assert.ok(opened.ok, 'cdp open 失败：' + (opened.error || ''));
  assert.strictEqual(opened.mode, 'cdp');
  assert.strictEqual(opened.attached, true);
  t.diagnostic('attach 成功：' + endpoint);

  const info = await driver.pageInfo(SESSION);
  assert.ok(info.ok, 'pageInfo 失败：' + (info.error || ''));
  assert.strictEqual(info.tabs.length, 2, '应有两个标签页：用户原有的 + 我们的专用页');
  assert.match(info.url, /\/demo\/mailbox\.html/, '当前标签页必须是我们的专用页');
  /* 用户原来那个（第一个创建的）必须还在，且仍是 about:blank —— 没被 goto 走 */
  assert.strictEqual(info.tabs[0].url, START_TAB, '用户原有标签页不得被导航走');

  const snap = await driver.snapshot(SESSION);
  assert.ok(snap.ok && /收件箱/.test(snap.snapshot), '专用页应已加载演示邮箱');
});

/* 快路径（run-code 合并命令）自己取的那份「动作之后」快照，必须有真机断言。
 * 这是这次改动收益最大的一条：快路径绕开了 CLI 的动作命令，工件一点都没有，快照只能
 * 在命令里自己等稳定、自己取。这里验两件事 —— 交回来了，且内容是**动作之后**的页面。
 * 没有这条断言的话，把它改成 snapshot: null 整个单元测试仍然全绿。 */
test('cdp：快路径动作把「动作之后」的快照交回来（真机）', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const home = await driver.act(SESSION, 'goto', null, serverBase + '/demo/mailbox.html');
  assert.ok(home.ok, 'goto 回邮箱页失败：' + (home.error || ''));

  const before = await driver.snapshot(SESSION);
  assert.ok(before.ok, '前置快照失败：' + (before.error || ''));
  const subject = (String(before.snapshot).match(/listitem "邮件 \d+：([^"]+)"/) || [])[1];
  const archive = parseSnapshotRefs(before.snapshot).find((r) => /button "归档"/.test(r.label));
  assert.ok(subject && archive, '需要一封可归档的邮件（subject=' + subject + '）');
  const ref = archive.ref;

  /* click 属于 MERGED_ACTIONS：这一条走的就是 run-code 快路径 */
  const clicked = await driver.act(SESSION, 'click', ref, null);
  assert.ok(clicked.ok, '快路径 click 失败：' + (clicked.error || ''));
  assert.strictEqual(typeof clicked.snapshot, 'string',
    '快路径必须把动作后的快照交回来（命令里自己等稳定 + 自己取）');
  assert.match(clicked.snapshot, /\[ref=/, '交回来的要能当快照用（下游全按 ref 行解析）');
  assert.doesNotMatch(clicked.snapshot, new RegExp('listitem "邮件 \\d+：' + subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    '必须是**动作之后**的页面：被归档的那封不该还在');
});

test('cdp：窗口类动作拒绝执行（不改用户的窗口与视口）', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const rz = await driver.resize(SESSION, 1024, 768);
  assert.ok(!rz.ok && /CDP/.test(rz.error), 'resize 必须被拒：' + JSON.stringify(rz));
  const f = await driver.fullscreen(SESSION);
  assert.ok(!f.ok && /CDP/.test(f.error), 'fullscreen 必须被拒：' + JSON.stringify(f));
  /* 被拒之后会话仍然可用 */
  const info = await driver.pageInfo(SESSION);
  assert.ok(info.ok && /mailbox/.test(info.url));
});

test('cdp：切标签页的两条规矩 —— 不许选你原有的页，选了自己的新 Tab 守卫仍认', async (t) => {
  if (skipReason) return t.skip(skipReason);

  /* ① 用户原有的标签页（index 0，attach 前就在了）不许选过去：那是人家的页面 */
  const denied = await driver.act(SESSION, 'tab-select', null, '0');
  assert.ok(!denied.ok, '切到用户原有标签页必须被拒：' + JSON.stringify(denied));
  assert.match(denied.error, /你自己的页面|不在本次运行/, '要说清为什么拒：' + denied.error);
  const still = await driver.pageInfo(SESSION);
  assert.ok(still.ok && /mailbox/.test(still.url), '被拒之后仍停在我们的专用页：' + JSON.stringify(still));

  /* ② 我们自己动作开出来的新标签页：允许切过去，且切完守卫必须仍认它 ——
   * 新 Tab 是全新的浏览上下文（window.name 为空），驱动若不重新打标记，
   * 下一步的快照就会被判成「切走了」而误杀整轮运行。 */
  const made = await driver.act(SESSION, 'tab-new', null, serverBase + '/demo/orders.html');
  assert.ok(made.ok, 'tab-new 失败：' + (made.error || ''));
  const afterNew = await driver.pageInfo(SESSION);
  assert.ok(afterNew.ok, '切到自己的新 Tab 后守卫不得误判：' + JSON.stringify(afterNew));
  assert.match(afterNew.url, /\/demo\/orders\.html/, '当前页应是我们刚开的那一个');

  /* ③ 再切回专用页：tab-select 之后同样要重新打标记（这就是「多 Tab 场景」的正常路径） */
  const back = await driver.act(SESSION, 'tab-select', null, '1');
  assert.ok(back.ok, '切回自己的标签页失败：' + (back.error || ''));
  const afterBack = await driver.pageInfo(SESSION);
  assert.ok(afterBack.ok && /mailbox/.test(afterBack.url), '切回后仍应认得这一页：' + JSON.stringify(afterBack));

  /* ④ 收尾：关掉多出来的那个 Tab，把状态还原成两个标签页（后面的用例依赖这个初始态） */
  const trimmed = await driver.act(SESSION, 'tab-close', null, '2');
  assert.ok(trimmed.ok, '关掉多出来的 Tab 失败：' + (trimmed.error || ''));
  const final = await driver.pageInfo(SESSION);
  assert.ok(final.ok && final.tabs.length === 2, '应还原为两个标签页：' + JSON.stringify(final));
});

test('cdp：原生弹窗期间守卫不算「标签页丢了」，弹窗处理完还能继续', async (t) => {
  if (skipReason) return t.skip(skipReason);

  /* 在一个新建的专用标签页里跑这段：被切到后台再切回来的标签页会被 Chrome 节流，
   * Playwright 的「stable」等待（要两帧 rAF）会一直不满足而超时 —— 那是测试环境的
   * 遮挡造成的，与我们验的守卫行为无关。产品里模型操作的也正是这种新建页。 */
  const made = await driver.act(SESSION, 'tab-new', null, serverBase + '/demo/mailbox.html');
  assert.ok(made.ok, 'tab-new 失败：' + (made.error || ''));

  /* 点出原生 confirm：演示邮箱的「删除」按钮（e2e 的 S5 走的就是这条路径） */
  const before = await driver.snapshot(SESSION);
  assert.ok(before.ok, '前置快照失败：' + (before.error || ''));
  const line = String(before.snapshot).split('\n')
    .map((l) => l.trim()).find((l) => /^-\s*button "删除"/.test(l)) || '';
  const ref = (line.match(/ref=(e\d+)/) || [])[1];
  assert.ok(ref, '快照里应能找到「删除」按钮，实际相关行：' +
    String(before.snapshot).split('\n').filter((l) => /删除/.test(l)).slice(0, 2).join(' / '));
  const pos = await driver.rect(SESSION, ref);
  t.diagnostic('删除按钮 ' + ref + ' 位置：' + JSON.stringify(pos.ok ? pos : pos.error));
  const clicked = await driver.act(SESSION, 'click', ref, null);
  assert.ok(clicked.ok, '点「删除」应弹出 confirm：' + (clicked.error || '') + '（' + ref + ' 位置 ' + JSON.stringify(pos.rect || pos.error) + '）');

  /* 弹窗挂着时：快照/页面信息必须回「弹窗态」，**绝不能**回「专用标签页已不在」——
   * 后者会让整轮运行在弹窗这一步被打断（前端靠 modal state 这句进「弹窗步」，
   * 而且守卫若拦在 dialog-accept 前面，弹窗永远关不掉）。 */
  const snap = await driver.snapshot(SESSION);
  assert.ok(!snap.ok, '弹窗期间快照本就不可用');
  assert.ok(!snap.lostTab, '弹窗态绝不能判成「标签页丢了」：' + JSON.stringify(snap).slice(0, 200));
  assert.match(snap.error, /modal state/i, '要让前端认得出是弹窗态：' + snap.error);
  const info = await driver.pageInfo(SESSION);
  assert.ok(!info.lostTab, '弹窗期间 pageInfo 也不得判「标签页丢了」：' + JSON.stringify(info).slice(0, 200));

  /* 弹窗处理类动作必须能发出去 */
  const dis = await driver.act(SESSION, 'dialog-dismiss', null, null);
  assert.ok(dis.ok, 'dialog-dismiss 必须能执行：' + (dis.error || ''));

  /* 弹窗没了，守卫恢复常态：还是我们自己那一页，快照也回来了 */
  const after = await driver.pageInfo(SESSION);
  assert.ok(after.ok && /mailbox/.test(after.url), '弹窗处理后应恢复正常：' + JSON.stringify(after));
  const snap2 = await driver.snapshot(SESSION);
  assert.ok(snap2.ok, '快照应恢复：' + (snap2.error || ''));

  /* 收尾：切回原来那个专用页、关掉这个多出来的 Tab（后面的用例依赖两个标签页的初始态） */
  const back = await driver.act(SESSION, 'tab-select', null, '1');
  assert.ok(back.ok, '切回原专用页失败：' + (back.error || ''));
  const trimmed = await driver.act(SESSION, 'tab-close', null, '2');
  assert.ok(trimmed.ok, '关掉多出来的 Tab 失败：' + (trimmed.error || ''));
  const final = await driver.pageInfo(SESSION);
  assert.ok(final.ok && final.tabs.length === 2, '应还原为两个标签页：' + JSON.stringify(final));
});

test('cdp：用户关掉专用标签页后守卫发现并停手（不在相邻页面上继续）', async (t) => {
  if (skipReason) return t.skip(skipReason);
  /* 模拟用户手动关掉我们的标签页：tab-close 无参 = 关当前页。
   * 关掉之后 playwright-cli 会把当前标签页挪到相邻那个 —— 也就是用户自己的页面。 */
  const closed = await driver.act(SESSION, 'tab-close', null, null);
  assert.ok(closed.ok, 'tab-close 失败：' + (closed.error || ''));

  const info = await driver.pageInfo(SESSION);
  assert.ok(!info.ok, '守卫必须发现专用标签页没了：' + JSON.stringify(info));
  assert.strictEqual(info.lostTab, true);
  assert.match(info.error, /专用标签页/);
});

test('cdp：close 只断开连接，浏览器进程仍然活着', async (t) => {
  if (skipReason) return t.skip(skipReason);
  assert.ok(chromeChild.exitCode === null, '前置：浏览器应当在运行');

  const closed = await driver.close(SESSION);
  assert.ok(closed.ok);
  assert.strictEqual(closed.attached, true, 'close 应当如实报告这是附身会话');

  /* 给进程一点时间；它不该因为我们断开连接就退出 */
  await new Promise((r) => setTimeout(r, 800));
  assert.strictEqual(chromeChild.exitCode, null, '断开连接不得关掉用户的浏览器进程');
});
