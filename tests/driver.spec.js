/* browser-driver 单元测试（不起浏览器）：白名单 / 参数校验 / Windows 引号 / argv 组装 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');

const driver = require(path.join(__dirname, '..', 'browser-driver.js'));
const { quoteArg, validateAct, buildArgv, OPS, REF_RE, BROWSERS, parseEnvelope, unwrapResult, uploadPathAllowed, parseWindowSize, buildMaximizedConfig, FULLSCREEN_SNIPPET, RECT_SNIPPET, parseTabs, summarizeError, clipMiddle, MODES, CDP_CHANNELS, PROFILE_DIR, openPlan, validateCdpTarget, tabGuardOk, ownTabRefusal, markOwnTab, tabSelectRefusal, isHttpDiscoveryDead, MODAL_GUARD_RE, MODAL_SAFE_COMMANDS, parseDevToolsPort, sessionState, newTabToken, TAB_MARK_SNIPPET, TAB_READ_SNIPPET, cdpUserDataDirs, channelPortFile, httpEndpointForPort, cdpProbe, parseDevToolsActivePort, wsEndpointForPortPath, probeTcp, cdpAttachConfig, humanCdpProbeError, humanCdpAttachError, cdpProbeHint, httpTargetPort, resolveHttpTarget } = driver._test;

/* ---------- quoteArg：cmd.exe 引号规则 ---------- */

test('quoteArg 纯 ASCII 无特殊字符原样返回', () => {
  assert.strictEqual(quoteArg('click'), 'click');
  assert.strictEqual(quoteArg('e12'), 'e12');
  assert.strictEqual(quoteArg('-s=jevabc123'), '-s=jevabc123');
  assert.strictEqual(quoteArg('https://example.com/a?b=1'), 'https://example.com/a?b=1');
});

test('quoteArg 含空格 / 元字符 / 非 ASCII 时包双引号', () => {
  assert.strictEqual(quoteArg('hello world'), '"hello world"');
  assert.strictEqual(quoteArg('a&b'), '"a&b"');
  assert.strictEqual(quoteArg('a|b'), '"a|b"');
  assert.strictEqual(quoteArg('招商银行'), '"招商银行"');
  assert.strictEqual(quoteArg('9 月对账单'), '"9 月对账单"');
});

test('quoteArg 拒绝双引号、百分号与换行（注入面）', () => {
  assert.throws(() => quoteArg('a"b'), /不允许/);
  assert.throws(() => quoteArg('50%'), /不允许/);
  assert.throws(() => quoteArg('a\nb'), /不允许/);
});

/* ---------- 白名单与参数校验 ---------- */

test('白名单恰好覆盖设计 §7 的 19 个浏览器操作（裁剪后）', () => {
  assert.strictEqual(Object.keys(OPS).length, 19);
  ['click', 'fill', 'type', 'select', 'check', 'uncheck', 'hover',
    'upload', 'press',
    'goto', 'go-back', 'go-forward', 'reload',
    'tab-new', 'tab-select', 'tab-close', 'tab-list', 'dialog-accept', 'dialog-dismiss']
    .forEach((k) => assert.ok(OPS[k], '缺少动作 ' + k));
});

test('白名单外与硬排除的动作一律拒绝（含已裁剪的 8 个，防回潮）', () => {
  ['snapshot', 'screenshot', 'eval', 'console', 'requests', 'find', 'pdf', 'resize',
    'cookie-list', 'cookie-set', 'cookie-delete', 'localstorage-set', 'sessionstorage-list',
    'route', 'unroute', 'network-state-set', 'open', 'close', 'attach', 'detach', 'list',
    'close-all', 'kill-all', 'delete-data', 'install', 'install-browser', 'state-save',
    'state-load', 'show', 'pause-at', 'resume', 'step-over', 'tracing-start', 'video-start',
    'highlight', 'generate-locator', 'run-code', 'request', '任务已完成', '生成输入', '无操作', '',
    'dblclick', 'drop', 'keydown', 'keyup', 'mousemove', 'mousedown', 'mouseup', 'mousewheel']
    .forEach((k) => assert.throws(() => validateAct(k, null, null), /不允许|白名单|未知/, '应拒绝 ' + k));
});

test('需要 ref 的动作缺 ref 时拒绝', () => {
  ['click', 'fill', 'type', 'select', 'check', 'uncheck', 'hover'].forEach((k) => {
    assert.throws(() => validateAct(k, null, null), /ref/, k + ' 应要求 ref');
  });
});

test('ref 形如 e12 / 带下划线；「无需元素」与非法字符拒绝', () => {
  assert.deepStrictEqual(validateAct('click', 'e12', null), { op: 'click', ref: 'e12', text: null });
  assert.ok(REF_RE.test('e_12-A'));
  assert.throws(() => validateAct('click', '无需元素', null), /ref/);
  assert.throws(() => validateAct('click', 'e12;rm', null), /ref/);
});

test('fill/type/select 缺 text 拒绝；dialog-accept 的 text 可省', () => {
  ['fill', 'type', 'select'].forEach((k) => {
    assert.throws(() => validateAct(k, 'e12', null), /文本/, k + ' 应要求 text');
  });
  assert.deepStrictEqual(validateAct('dialog-accept', null, null), { op: 'dialog-accept', ref: null, text: null });
});

test('goto 仅允许 http/https', () => {
  assert.deepStrictEqual(validateAct('goto', null, 'https://a.com'), { op: 'goto', ref: null, text: 'https://a.com' });
  assert.deepStrictEqual(validateAct('goto', null, 'http://b.com'), { op: 'goto', ref: null, text: 'http://b.com' });
  assert.throws(() => validateAct('goto', null, 'ftp://x'), /http/);
  assert.throws(() => validateAct('goto', null, 'javascript:alert(1)'), /http/);
  assert.throws(() => validateAct('goto', null, null), /文本/);
});

test('tab-select / tab-close 只接受非负整数', () => {
  assert.deepStrictEqual(validateAct('tab-select', null, '2'), { op: 'tab-select', ref: null, text: '2' });
  assert.deepStrictEqual(validateAct('tab-select', null, '0'), { op: 'tab-select', ref: null, text: '0' });
  assert.throws(() => validateAct('tab-select', null, 'a'), /整数/);
  assert.throws(() => validateAct('tab-select', null, '-1'), /整数/);
  assert.throws(() => validateAct('tab-select', null, null), /文本/);
  assert.deepStrictEqual(validateAct('tab-close', null, null), { op: 'tab-close', ref: null, text: null });
});

test('无参动作不接受多余参数', () => {
  assert.deepStrictEqual(validateAct('reload', null, null), { op: 'reload', ref: null, text: null });
  assert.throws(() => validateAct('reload', 'e12', null), /ref/);
  assert.throws(() => validateAct('go-back', null, 'x'), /文本/);
});

test('text 拒绝双引号与百分号（引号封装前提）', () => {
  assert.throws(() => validateAct('fill', 'e12', 'a"b'), /不允许/);
  assert.throws(() => validateAct('fill', 'e12', '50%'), /不允许/);
});

/* ---------- argv 组装（对齐 CLI 签名） ---------- */

test('buildArgv 按各命令的参数顺序组装', () => {
  assert.deepStrictEqual(buildArgv('click', 'e12', null), ['click', 'e12']);
  assert.deepStrictEqual(buildArgv('fill', 'e12', '招商银行'), ['fill', 'e12', '招商银行']);
  assert.deepStrictEqual(buildArgv('select', 'e5', '未读'), ['select', 'e5', '未读']);
  assert.deepStrictEqual(buildArgv('press', null, 'Enter'), ['press', 'Enter']);
  assert.deepStrictEqual(buildArgv('goto', null, 'https://a.com'), ['goto', 'https://a.com']);
  assert.deepStrictEqual(buildArgv('tab-select', null, '1'), ['tab-select', '1']);
  assert.deepStrictEqual(buildArgv('tab-new', null, null), ['tab-new']);
  assert.deepStrictEqual(buildArgv('dialog-accept', null, '好的'), ['dialog-accept', '好的']);
  assert.deepStrictEqual(buildArgv('dialog-dismiss', null, null), ['dialog-dismiss']);
  assert.deepStrictEqual(buildArgv('go-back', null, null), ['go-back']);
});

/* ---------- --json 包裹解析（snapshot 直接输出 {snapshot} 对象，须解包） ---------- */

test('parseEnvelope：result 包裹 / isError / snapshot 直出对象 / 空对象 / 空输出', () => {
  assert.deepStrictEqual(
    parseEnvelope({ code: 0, stdout: JSON.stringify({ result: '- 0: (current) [T](u)' }), stderr: '' }),
    { ok: true, result: '- 0: (current) [T](u)' });
  assert.deepStrictEqual(
    parseEnvelope({ code: 0, stdout: JSON.stringify({ isError: true, error: 'Error: Ref e999 not found' }), stderr: '' }),
    { ok: false, error: 'Error: Ref e999 not found' });
  /* snapshot --json 实测直接输出 {snapshot: "..."}（带缩进的多行 JSON） */
  assert.deepStrictEqual(
    parseEnvelope({ code: 0, stdout: '{\n  "snapshot": "- generic [ref=e1]:"\n}', stderr: '' }),
    { ok: true, result: '- generic [ref=e1]:' });
  assert.deepStrictEqual(
    parseEnvelope({ code: 0, stdout: '{}', stderr: '' }),
    { ok: true, result: '' });
  assert.deepStrictEqual(parseEnvelope({ code: 0, stdout: '', stderr: '' }), { ok: true, result: '' });
  assert.ok(!parseEnvelope({ code: 1, stdout: '', stderr: 'boom' }).ok);
  assert.strictEqual(unwrapResult(undefined), '');
  assert.strictEqual(unwrapResult(null), '');
});

/* ---------- summarizeError：失败摘要不得吞掉遮挡根因（会话 r-0926-0046-qrys） ---------- */

test('summarizeError：保留行尾的 intercepts pointer events（旧版 slice(0,500) 会切掉它）', () => {
  /* 真实形状：元素标签很长，根因短语在行尾，整段远超 500 字符 */
  const raw = "\u001b[2mTimeoutError: Timeout 5000ms exceeded.\u001b[22m\n" +
    "Call log:\n" +
    "\u001b[2m  - waiting for locator('aria-ref=f2e496')\u001b[22m\n" +
    '\u001b[2m    - locator resolved to <button type="button" class="Button Button--plain">…</button>\u001b[22m\n' +
    '\u001b[2m  - attempting click action\u001b[22m\n' +
    '\u001b[2m    - waiting for element to be visible, enabled and stable\u001b[22m\n' +
    '\u001b[2m    - element is visible, enabled and stable\u001b[22m\n' +
    '\u001b[2m    - scrolling into view if needed\u001b[22m\n' +
    '\u001b[2m    - done scrolling\u001b[22m\n' +
    '\u001b[2m    - <form class="nova-abc123" data-a="' + 'x'.repeat(400) + '">…</form> intercepts pointer events\u001b[22m';
  const out = summarizeError(raw);
  assert.ok(raw.length > 500, '夹具须长于旧的 500 字符截断线，实际 ' + raw.length);
  assert.match(out, /intercepts pointer events/, '根因短语必须留在摘要里');
  assert.match(out, /^TimeoutError: Timeout 5000ms exceeded\./, '首行须保留');
  assert.ok(!/\u001b/.test(out), 'ANSI 转义须清除');
  assert.ok(out.length <= 420, '摘要应有长度上限，实际 ' + out.length);
});

test('summarizeError：无根因行时保留首行 + 末尾上下文，不吃掉信息', () => {
  assert.strictEqual(summarizeError('Error: Ref e999 not found'), 'Error: Ref e999 not found');
  assert.strictEqual(summarizeError(''), '');
  assert.strictEqual(summarizeError(null), '');
  assert.strictEqual(summarizeError('第一行\n第二行'), '第一行 | 第二行');
});

test('clipMiddle：短行原样，长行折叠中段（保住行尾的根因短语）', () => {
  assert.strictEqual(clipMiddle('abc', 10), 'abc');
  const long = 'H'.repeat(100) + 'TAIL';
  const out = clipMiddle(long, 40);
  assert.ok(out.startsWith('H'.repeat(18)), '保留头部');
  assert.ok(out.endsWith('TAIL'), '尾部必须完整保留');
  assert.ok(out.includes('…'), '中段以省略号标记');
  assert.strictEqual(out.length, 40);
});

/* ---------- parseTabs：tab-list 全行解析（state「标签页」字段的数据源） ---------- */

test('parseTabs：多行输出逐行解析并标出当前 Tab', () => {
  assert.deepStrictEqual(parseTabs(
    '- 0: (current) [百度一下，你就知道](https://www.baidu.com/s?wd=jev)\n' +
    '- 1: [jev_百度搜索](https://www.baidu.com/s?wd=jev&pn=10)\n'), [
    { index: 0, current: true, title: '百度一下，你就知道', url: 'https://www.baidu.com/s?wd=jev' },
    { index: 1, current: false, title: 'jev_百度搜索', url: 'https://www.baidu.com/s?wd=jev&pn=10' },
  ]);
});

test('parseTabs：跳过杂行，URL 锚定行尾（括号不被截断）；空输入 → 空数组', () => {
  assert.deepStrictEqual(parseTabs('Hooks:\n- 2: [A](http://a/(x))\n日志行'), [
    { index: 2, current: false, title: 'A', url: 'http://a/(x)' },
  ]);
  assert.deepStrictEqual(parseTabs(''), []);
  assert.deepStrictEqual(parseTabs(null), []);
});

test('parseTabs：标题含 ] 也要解析出来（失配会让当前页 url/title 全空）', () => {
  assert.deepStrictEqual(parseTabs(
    '- 0: (current) [PDF] 报告 — 收件箱](https://x.com/a)\n' +
    '- 1: [图]xx 与 [说明]yy](https://q.com/z)\n'), [
    { index: 0, current: true, title: 'PDF] 报告 — 收件箱', url: 'https://x.com/a' },
    { index: 1, current: false, title: '图]xx 与 [说明]yy', url: 'https://q.com/z' },
  ]);
});

/* ---------- upload 路径沙箱（防任意本地文件外泄） ---------- */

test('uploadPathAllowed：仅 data/ 目录内放行', () => {
  const dir = path.join(__dirname, '..', 'data');
  assert.strictEqual(uploadPathAllowed(dir, 'uploads/a.png'), true);
  assert.strictEqual(uploadPathAllowed(dir, path.join(dir, 'a.png')), true);
  assert.strictEqual(uploadPathAllowed(dir, './a.png'), true);
  assert.strictEqual(uploadPathAllowed(dir, 'C:\\Users\\v\\.ssh\\id_rsa'), false, '绝对路径逃逸应拒绝');
  assert.strictEqual(uploadPathAllowed(dir, '..\\..\\secret.txt'), false, '相对路径穿越应拒绝');
  assert.strictEqual(uploadPathAllowed(dir, '/etc/passwd'), false);
  assert.strictEqual(uploadPathAllowed(dir, 'file:///C:/Windows/win.ini'), false);
});

/* ---------- 浏览器内核白名单与窗口尺寸校验 ---------- */

test('BROWSERS 白名单只含 chrome / msedge；parseWindowSize 收敛到 200~10000 整数', () => {
  assert.deepStrictEqual(Object.keys(BROWSERS).sort(), ['chrome', 'msedge']);
  assert.deepStrictEqual(parseWindowSize(1920, 1080), { w: 1920, h: 1080 });
  assert.deepStrictEqual(parseWindowSize('1366', '768'), { w: 1366, h: 768 });   // 页面传来的是字符串
  assert.strictEqual(parseWindowSize(199.9, 800), null);
  assert.strictEqual(parseWindowSize(100, 800), null);
  assert.strictEqual(parseWindowSize(1920, 10001), null);
  assert.strictEqual(parseWindowSize('abc', 800), null);
  assert.strictEqual(parseWindowSize(null, undefined), null);
});

test('buildMaximizedConfig：chromium 原生最大化（args + viewport:null，无 position —— 与最大化互斥）', () => {
  assert.deepStrictEqual(buildMaximizedConfig(), {
    browser: {
      launchOptions: { args: ['--start-maximized'] },
      contextOptions: { viewport: null },
    },
  });
});

test('全屏片段：走 CDP setWindowBounds，且不含 quoteArg 拒绝的字符', () => {
  assert.match(FULLSCREEN_SNIPPET, /Browser\.setWindowBounds/);
  assert.match(FULLSCREEN_SNIPPET, /windowState: 'fullscreen'/);
  assert.match(FULLSCREEN_SNIPPET, /^async page =>/);
  assert.doesNotMatch(FULLSCREEN_SNIPPET, /["%\r\n]/, '片段必须能安全通过 Windows cmd 引号封装');
  assert.strictEqual(quoteArg(FULLSCREEN_SNIPPET).startsWith('"'), true);   // 含空格等 → 需包引号
});

/* ---------- RECT_SNIPPET：操作前读元素矩形（标注用） ---------- */

test('读位置片段：能安全通过 cmd 引号封装，且同时回读视口尺寸', () => {
  assert.match(RECT_SNIPPET, /^el => \{/);
  assert.doesNotMatch(RECT_SNIPPET, /["%\r\n]/, '片段必须能安全通过 Windows cmd 引号封装');
  assert.strictEqual(quoteArg(RECT_SNIPPET).startsWith('"'), true);   // 含空格 → 需包引号
  assert.match(RECT_SNIPPET, /getBoundingClientRect/);
  /* 视口宽度必须与矩形同一时刻读到：截图是设备像素、矩形是 CSS 像素，
   * 换算比例只能由这两个数算出来（DPR 随窗口方案变，不能假设 1:1） */
  assert.match(RECT_SNIPPET, /window\.innerWidth/);
  assert.match(RECT_SNIPPET, /window\.innerHeight/);
  /* 只读，不得改动页面 —— 标注只画在图上，被驱动页面里不留任何痕迹 */
  assert.ok(!/append|remove|insert|innerHTML|style\./.test(RECT_SNIPPET), '读位置片段必须是只读的');
});

test('rect：ref 形状非法时直接拒绝（不进 argv）', async () => {
  const bad = await driver.rect('nosession', 'e12;rm');
  assert.ok(!bad.ok && /ref/.test(bad.error), '带命令分隔符的 ref 必须被拒：' + JSON.stringify(bad));
  assert.ok(!(await driver.rect('nosession', '')).ok);
  assert.ok(!(await driver.rect('nosession', '无需元素')).ok);
  assert.ok(!(await driver.rect('nosession', null)).ok);
});

/* ---------- 三种浏览器模式：isolated（默认）/ persistent / cdp ----------
 * 模式是**连接方式**，不是 Jev 能触发的动作 —— 它只挂在 open() 的选项上，
 * 不进 OPS 白名单（attach 仍在硬拒绝名单里）。 */

test('MODES 恰好三档：isolated / persistent / cdp（默认 isolated）', () => {
  assert.deepStrictEqual(Object.keys(MODES).sort(), ['cdp', 'isolated', 'persistent']);
  assert.strictEqual(typeof PROFILE_DIR, 'string');
  assert.ok(PROFILE_DIR.length > 0);
});

test('openPlan：isolated 保持既有 argv（open + --browser + --headed）', () => {
  const p = openPlan({ mode: 'isolated', url: 'https://a.com', browser: 'chrome' });
  assert.deepStrictEqual(p.commands, [['open', 'https://a.com', '--browser', 'chrome', '--headed']]);
  assert.strictEqual(p.config, null, '不开最大化时不写 config 文件');
  assert.strictEqual(p.mode, 'isolated');
  assert.strictEqual(p.browser, 'chrome');
});

test('openPlan：缺省 mode 等同 isolated（老调用方零改动）', () => {
  assert.deepStrictEqual(openPlan({ url: 'https://a.com', browser: 'msedge' }).commands,
    [['open', 'https://a.com', '--browser', 'msedge', '--headed']]);
});

test('openPlan：isolated/persistent 带最大化时给出同款 config（args + viewport:null）', () => {
  const a = openPlan({ mode: 'isolated', url: 'https://a.com', browser: 'chrome', maximize: true, native: true });
  assert.deepStrictEqual(a.config, {
    browser: {
      launchOptions: { args: ['--start-maximized', '--force-device-scale-factor=1', '--high-dpi-support=1'] },
      contextOptions: { viewport: null },
    },
  });
  /* 这些参数要么进 config 文件、要么（将来）上命令行 —— 一律不得含 cmd 会展开的字符 */
  a.config.browser.launchOptions.args.forEach((s) => {
    assert.doesNotMatch(s, /["%\r\n]/, '启动参数不得含 cmd 展开字符：' + s);
  });
});

test('openPlan：persistent 追加 --profile <dataDir>/browser-profile（绝不落在 data/ 之外）', () => {
  const profileDir = path.join(__dirname, '..', 'data');
  const p = openPlan({ mode: 'persistent', url: 'https://a.com', browser: 'chrome', profileDir, maximize: true });
  assert.deepStrictEqual(p.commands, [['open', 'https://a.com', '--browser', 'chrome', '--headed',
    '--profile', path.join(profileDir, PROFILE_DIR)]]);
  assert.ok(p.commands[0].includes('--profile'));
  assert.strictEqual(p.config.browser.launchOptions.args[0], '--start-maximized', '持久 profile 仍是我们自己起的窗口，最大化照旧');
});

test('openPlan：persistent 缺 profileDir 直接抛错（不猜路径）', () => {
  assert.throws(() => openPlan({ mode: 'persistent', url: 'https://a.com', browser: 'chrome' }), /profile|profileDir|目录/i);
});

test('openPlan：cdp 不启动浏览器 —— attach 打头，没有 --browser/--headed/--profile', () => {
  const p = openPlan({ mode: 'cdp', url: 'https://a.com', browser: 'chrome' });
  assert.deepStrictEqual(p.commands, [['attach', '--cdp=chrome'], ['tab-new', 'https://a.com']]);
  assert.strictEqual(p.config, null, 'CDP 模式没有 launch 可言，不写启动参数');
  assert.strictEqual(p.attached, true);
});

test('openPlan：cdp 的手填端点优先于内核名；内核名仍决定自动探测哪个浏览器', () => {
  assert.deepStrictEqual(
    openPlan({ mode: 'cdp', url: 'https://a.com', browser: 'chrome', cdp: 'ws://127.0.0.1:9222/devtools/browser/ab' }).commands,
    [['attach', '--cdp=ws://127.0.0.1:9222/devtools/browser/ab'], ['tab-new', 'https://a.com']]);
  assert.deepStrictEqual(openPlan({ mode: 'cdp', url: 'https://a.com', browser: 'msedge' }).commands,
    [['attach', '--cdp=msedge'], ['tab-new', 'https://a.com']]);
});

test('openPlan：cdp 的 tab-new 用独立标签页承接目标 URL（绝不复用用户已开的标签）', () => {
  const p = openPlan({ mode: 'cdp', url: 'https://mail.example.com', browser: 'chrome' });
  assert.strictEqual(p.commands[0][0], 'attach');
  assert.deepStrictEqual(p.commands[1], ['tab-new', 'https://mail.example.com']);
  assert.ok(!p.commands.some((c) => c[0] === 'goto'), 'attach 后不得直接 goto —— 那会导航用户当前标签页');
});

test('openPlan：非法 mode 抛错，不做静默降级', () => {
  ['', null, undefined, 'CDP', 'attach', 'isolated ', 'persistent2', 42].forEach((m) => {
    assert.throws(() => openPlan({ mode: m, url: 'https://a.com', browser: 'chrome' }), /模式|mode/i, '应拒绝 ' + JSON.stringify(m));
  });
});

test('validateCdpTarget：认内核名与 ws/http 端点，拒绝注入字符与超长', () => {
  assert.strictEqual(validateCdpTarget('chrome'), 'chrome');
  assert.strictEqual(validateCdpTarget('msedge'), 'msedge');
  assert.strictEqual(validateCdpTarget('ws://127.0.0.1:9222/devtools/browser/ab-c'), 'ws://127.0.0.1:9222/devtools/browser/ab-c');
  assert.strictEqual(validateCdpTarget('http://localhost:9222'), 'http://localhost:9222');
  assert.ok(CDP_CHANNELS.includes('chrome') && CDP_CHANNELS.includes('msedge'));
  assert.throws(() => validateCdpTarget(''), /CDP|目标/);
  assert.throws(() => validateCdpTarget(null), /CDP|目标/);
  assert.throws(() => validateCdpTarget('a"b'), /不允许/);
  assert.throws(() => validateCdpTarget('a%b'), /不允许/);
  assert.throws(() => validateCdpTarget('a\nb'), /不允许/);
  assert.throws(() => validateCdpTarget('ftp://x'), /CDP|http|端点/);
  assert.throws(() => validateCdpTarget('ws://' + 'a'.repeat(400)), /长|CDP/);
});

test('validateCdpTarget 的输出必须能安全通过 cmd 引号封装（--cdp= 拼在同一个参数里）', () => {
  ['chrome', 'msedge', 'ws://127.0.0.1:9222/devtools/browser/ab-c'].forEach((t) => {
    assert.doesNotThrow(() => quoteArg('--cdp=' + validateCdpTarget(t)), '应可安全拼进命令行：' + t);
  });
});

test('tabGuardOk：只认自己那枚标签页标记（空白/引号包裹不算）', () => {
  assert.strictEqual(tabGuardOk('jevabc-1', 'jevabc-1'), true);
  assert.strictEqual(tabGuardOk('jevabc-1', '"jevabc-1"'), true);
  assert.strictEqual(tabGuardOk('jevabc-1', ' jevabc-1 \n'), true);
  assert.strictEqual(tabGuardOk('jevabc-1', ''), false, '取不到标记 = 已不在我们的标签页');
  assert.strictEqual(tabGuardOk('jevabc-1', 'undefined'), false);
  assert.strictEqual(tabGuardOk('jevabc-1', 'jevabc-2'), false);
  assert.strictEqual(tabGuardOk('jevabc-1', null), false);
});

test('parseDevToolsPort：解析 Chrome 默认 profile 里的 DevToolsActivePort 文件', () => {
  assert.strictEqual(parseDevToolsPort('9222\n/devtools/browser/abc-123\n'), 9222);
  assert.strictEqual(parseDevToolsPort('1234\n'), 1234);
  assert.strictEqual(parseDevToolsPort(''), null);
  assert.strictEqual(parseDevToolsPort(null), null);
  assert.strictEqual(parseDevToolsPort('not-a-port'), null);
  assert.strictEqual(parseDevToolsPort('99999'), null, '越界端口不算');
});

test('标签页标记：用 window.name（跨导航存活），片段可安全通过 cmd 引号封装', () => {
  const token = newTabToken('jev1a2b3c');
  assert.match(token, /^[A-Za-z0-9_-]+$/, '标记只能含安全字符，直接进命令行');
  assert.notStrictEqual(newTabToken('jev1a2b3c'), token, '每次运行标记唯一');
  const set = TAB_MARK_SNIPPET(token);
  assert.match(set, /window\.name/, '必须用 window.name —— JS 变量过导航即失效');
  assert.doesNotMatch(set, /["%\r\n]/, '片段必须能安全通过 Windows cmd 引号封装');
  assert.strictEqual(quoteArg(set).startsWith('"'), true);
  assert.match(set, new RegExp(token));
  assert.doesNotMatch(TAB_READ_SNIPPET, /["%\r\n]/, '读取片段同样要能安全进命令行');
  assert.match(TAB_READ_SNIPPET, /window\.name/);
  assert.ok(!/localStorage|sessionStorage/.test(set + TAB_READ_SNIPPET), '不得往用户站点里写任何持久存储');
});

/* ---------- CDP 守卫：只在自己的标签页里动手 ---------- */

test('tabSelectRefusal：attach 之前就开着的标签页不许选（那是用户的页面）', () => {
  const pre = ['https://mail.example.com/', 'https://x.com/a'];
  assert.ok(tabSelectRefusal(pre, 'https://mail.example.com/'), '命中原有标签页必须拒');
  assert.strictEqual(tabSelectRefusal(pre, 'https://new.example.com/'), null,
    '我们自己的点击开出来的新标签页要放行');
  assert.strictEqual(tabSelectRefusal(pre, ''), null, '读不到 url 就不拦（拿不到基线别乱拒）');
  assert.strictEqual(tabSelectRefusal([], 'https://mail.example.com/'), null);
  assert.strictEqual(tabSelectRefusal(null, 'https://mail.example.com/'), null);
});

test('ownTabRefusal：非 cdp / 无 token 的会话直接放行（不发任何命令）', async () => {
  assert.strictEqual(await ownTabRefusal('no-such-session'), null);
  sessionState.set('iso-guard', { mode: 'isolated' });
  sessionState.set('cdp-guard-no-token', { mode: 'cdp' });
  try {
    assert.strictEqual(await ownTabRefusal('iso-guard'), null, '独立实例没有「别人的标签页」这回事');
    assert.strictEqual(await ownTabRefusal('cdp-guard-no-token'), null, '还没标记专用标签页时不拦');
  } finally {
    sessionState.delete('iso-guard');
    sessionState.delete('cdp-guard-no-token');
  }
});

test('isHttpDiscoveryDead：只认 404 这条死路，403（授权没点）绝不重试', () => {
  assert.strictEqual(isHttpDiscoveryDead('Unexpected status 404'), true);
  assert.strictEqual(isHttpDiscoveryDead('This does not look like a DevTools server, try ws://'), true);
  assert.strictEqual(isHttpDiscoveryDead('403 Forbidden'), false,
    '403 是授权没点：重试会把那条维持弹窗的连接打掉');
  assert.strictEqual(isHttpDiscoveryDead('connection rejected: 403'), false);
  assert.strictEqual(isHttpDiscoveryDead('ECONNREFUSED 127.0.0.1:9222'), false,
    '端口没人听不重试 —— 那会白等一次 attach 超时');
});

/* 原生弹窗（confirm/alert）占住渲染主线程时，浏览器侧 JS 工具全部被拒 ——
 * 实测 CLI 原话就是下面这句。守卫必须认出它，否则会把它当成「标签页被关了」，
 * 在弹窗这一步把整轮运行打断（连 dialog-accept 都发不出去）。 */
test('弹窗态的认法与放行名单：读类与弹窗处理类放行，标签页类必须住手', () => {
  assert.ok(MODAL_GUARD_RE.test('Error: Tool "browser_evaluate" does not handle the modal state.'), '实测原文要能匹上');
  assert.ok(!MODAL_GUARD_RE.test('TimeoutError: Timeout 5000ms exceeded.'), '普通超时不算弹窗态');
  assert.ok(!MODAL_GUARD_RE.test('Error: browser has been closed'), '标签页没了也不算弹窗态');
  ['snapshot', 'page-info', 'screenshot', 'rect', 'dialog-accept', 'dialog-dismiss']
    .forEach((c) => assert.ok(MODAL_SAFE_COMMANDS[c], '弹窗期间应放行：' + c));
  ['tab-close', 'tab-select', 'tab-new', 'click', 'fill', 'goto', 'reload', 'press']
    .forEach((c) => assert.ok(!MODAL_SAFE_COMMANDS[c],
      '弹窗期间这类命令会真执行、又判不了归属，必须住手：' + c));
});

/* ---------- 窗口类工程动作：CDP 模式下必须住手 ----------
 * 附身的是用户真实浏览器：resize 会改他的视口，fullscreen 会把他窗口顶到全屏。 */

test('resize / fullscreen 在 cdp 会话上拒绝执行（不碰用户窗口）', async () => {
  sessionState.set('cdp-sess', { mode: 'cdp', tabToken: 't1' });
  const r = await driver.resize('cdp-sess', 1024, 768);
  assert.ok(!r.ok, 'resize 必须被拒：' + JSON.stringify(r));
  assert.match(r.error, /CDP|外部|窗口/);
  const f = await driver.fullscreen('cdp-sess');
  assert.ok(!f.ok, 'fullscreen 必须被拒：' + JSON.stringify(f));
  assert.match(f.error, /CDP|外部|窗口/);
  sessionState.delete('cdp-sess');
});

test('resize 仍照旧校验尺寸；非 cdp 会话不受影响（先校验、后执行）', async () => {
  sessionState.set('iso-sess', { mode: 'isolated' });
  const bad = await driver.resize('iso-sess', 100, 100);
  assert.ok(!bad.ok && /尺寸|200/.test(bad.error), '非法尺寸仍是尺寸错误：' + JSON.stringify(bad));
  sessionState.delete('iso-sess');
});

/* ---------- CDP 预检：读默认 user data dir 里的 DevToolsActivePort ----------
 * 失败率最高的一步是「浏览器压根没开调试端口」，UI 要能事先说清楚。 */

test('cdpUserDataDirs：按平台给出 chrome / msedge 的 DevToolsActivePort 候选路径', () => {
  const win = cdpUserDataDirs('win32', { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' });
  assert.deepStrictEqual(win.map((d) => d.channel), ['chrome', 'msedge']);
  win.forEach((d) => {
    assert.ok(d.file.endsWith('DevToolsActivePort'), d.file + ' 应指向端口文件');
    assert.ok(d.file.startsWith('C:\\Users\\x\\AppData\\Local'), d.file + ' 应落在 LOCALAPPDATA 下');
  });
  assert.match(win[0].file, /Google[\\/]Chrome[\\/]User Data[\\/]DevToolsActivePort$/);
  assert.match(win[1].file, /Microsoft[\\/]Edge[\\/]User Data[\\/]DevToolsActivePort$/);

  const mac = cdpUserDataDirs('darwin', { HOME: '/Users/x' });
  assert.match(mac[0].file, /Library\/Application Support\/Google\/Chrome\/DevToolsActivePort$/);
  const lin = cdpUserDataDirs('linux', { HOME: '/home/x' });
  assert.match(lin[0].file, /\.config\/google-chrome\/DevToolsActivePort$/);
  assert.deepStrictEqual(cdpUserDataDirs('win32', {}), [], '拿不到环境根目录就不猜路径');
});

/* 端点形态：必须是 http://host:port，不能是 ws://host:port/devtools/browser。
 * 后者是「浏览器级 ws 端点去掉了 UUID 路径」的样子，Chrome 直接回 404 ——
 * 实测（本机 Chrome + 临时 profile + 调试端口）：ws://127.0.0.1:<port>/devtools/browser
 * → 404 Not Found，而 http://127.0.0.1:<port> 由 Playwright 走 /json/version 发现端点，
 * 一次成功。用 127.0.0.1 而不是 localhost：Chrome 只绑 IPv4，Node 解析 localhost 可能先试
 * ::1，造成「探得到却连不上」。 */
test('httpEndpointForPort / channelPortFile：自己探测出的端点用 http（ws 无 UUID 路径会 404）', () => {
  assert.strictEqual(httpEndpointForPort(9222), 'http://127.0.0.1:9222');
  assert.strictEqual(httpEndpointForPort('4741'), 'http://127.0.0.1:4741');
  assert.strictEqual(httpEndpointForPort(0), null);
  assert.strictEqual(httpEndpointForPort(70000), null);
  assert.strictEqual(httpEndpointForPort(null), null);
  assert.strictEqual(httpEndpointForPort('abc'), null);
  assert.ok(!/\/devtools\/browser/.test(httpEndpointForPort(9222)), '不得拼上 UUID 之外的路径');

  const env = { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' };
  assert.match(channelPortFile('chrome', 'win32', env), /Google[\\/]Chrome[\\/]User Data[\\/]DevToolsActivePort$/);
  assert.match(channelPortFile('msedge', 'win32', env), /Microsoft[\\/]Edge[\\/]User Data[\\/]DevToolsActivePort$/);
  assert.strictEqual(channelPortFile('chrome', 'linux', {}), null, '没有 HOME 就不猜');
  assert.strictEqual(channelPortFile('firefox', 'win32', env), null, '不认识的内核不给路径');
});

/* ---------- CDP 预检：只看端口文件 + 探一次 TCP，**绝不做 ws 握手** ----------
 * 端口文件是磁盘残留物（浏览器异常退出会留下陈旧端口），所以要探活；但探活只能用
 * TCP 连接：**ws 握手会触发 Chrome 144+ 的「允许远程调试？」弹窗**，而弹窗只由那条
 * 挂着的连接维持 —— 探一下就断开，等于把用户正要点的弹窗打掉（浏览器插件 browser-harness
 * 的注释原话：重试会立刻造出新弹窗，把一次授权变成无限弹窗）。
 * 另外 Chrome 147+ 在默认 profile 上**关掉了 /json/* HTTP 发现**（404 是正常的），
 * 权威端点就是端口文件第二行那条 ws 路径。 */

function tempPortFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-probe-'));
  const file = path.join(dir, 'DevToolsActivePort');
  fs.writeFileSync(file, content);
  return { channel: 'chrome', file: file, dir: dir };
}

test('probeTcp：端口在听就是活的，没人听就是 unreachable', async () => {
  const srv = net.createServer(() => {});
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    assert.deepStrictEqual(await probeTcp(port), { ok: true });
    assert.deepStrictEqual(await probeTcp(1), { ok: false, reason: 'unreachable' });
  } finally { srv.close(); }
});

test('cdpProbe：端口文件 + 端口在听 → 可用，端点是文件里那条带 UUID 的 ws 路径', async () => {
  const srv = net.createServer(() => {});
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const r = await cdpProbe([tempPortFile(port + '\n/devtools/browser/abc-123\n')]);
    assert.strictEqual(r.available, true);
    assert.strictEqual(r.reason, null);
    assert.strictEqual(r.channel, 'chrome');
    assert.strictEqual(r.endpoint, 'ws://127.0.0.1:' + port + '/devtools/browser/abc-123');
    assert.match(r.hint, /chrome:\/\/inspect|remote-debugging/);
  } finally { srv.close(); }
});

test('cdpProbe：文件里的端口没人听（陈旧残留）→ 不可用，reason=unreachable', async () => {
  const r = await cdpProbe([tempPortFile('1\n/devtools/browser/x')]);
  assert.strictEqual(r.available, false);
  assert.strictEqual(r.reason, 'unreachable');
  assert.strictEqual(r.endpoint, null);
});

test('cdpProbe：文件里只有端口、没有 ws 路径 → 退回 http 端点形态', async () => {
  const srv = net.createServer(() => {});
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const r = await cdpProbe([tempPortFile(String(port) + '\n')]);
    assert.strictEqual(r.available, true);
    assert.strictEqual(r.endpoint, 'http://127.0.0.1:' + port);
  } finally { srv.close(); }
});

test('cdpProbe：没有端口文件 → 不可用（reason=no-port-file），提示做法', async () => {
  const r = await cdpProbe([{ channel: 'chrome', file: path.join(os.tmpdir(), 'jev-no-such-port-file') }]);
  assert.strictEqual(r.available, false);
  assert.strictEqual(r.reason, 'no-port-file');
  assert.match(r.hint, /chrome:\/\/inspect|remote-debugging/);
});

/* Chrome 144+ 对**每次浏览器运行**都要一次「允许远程调试」的授权：勾选框勾过也不算。 */
test('humanCdpProbeError / cdpAttachConfig：授权没点、以及连法本身', () => {
  /* 预检的 reason 只有「没端口文件」和「端口没人听」两条（探活只做 TCP connect，
   * 不做握手 —— 会打掉用户正要点的授权弹窗，所以探不出「拒绝 DevTools」）。
   * 「授权没点」的文案在 attach 阶段：403 那条。 */
  assert.match(humanCdpProbeError('chrome', { reason: 'no-port-file' }), /没探到|chrome:\/\/inspect/);
  assert.match(humanCdpProbeError('chrome', { reason: 'unreachable' }), /连不上|已经关了/);
  assert.match(humanCdpAttachError('403 Forbidden'), /允许|permission|chrome:\/\/inspect/,
    '授权的下一步只能从 attach 的 403 里给');

  /* 连法本身：cdpTimeout 必须为 0（不超时）—— 挂着的连接才是维持 Chrome 弹窗的东西，
   * 超时会把它打掉，用户就没得点了 */
  assert.deepStrictEqual(cdpAttachConfig(), { browser: { cdpTimeout: 0 } });
  assert.ok(cdpAttachConfig().browser.cdpTimeout === 0, '必须是「不超时」，不能是某个大数字');
});

/* 端口文件两行的解析（端点的来源） */
test('parseDevToolsActivePort / wsEndpointForPortPath：两行都要，拼出带 UUID 的 ws 端点', () => {
  assert.deepStrictEqual(parseDevToolsActivePort('9222\n/devtools/browser/abc-123\n'),
    { port: 9222, wsPath: '/devtools/browser/abc-123' });
  assert.deepStrictEqual(parseDevToolsActivePort('9222\n'), { port: 9222, wsPath: null });
  assert.strictEqual(parseDevToolsActivePort('not-a-port\n/devtools/browser/x'), null);
  assert.strictEqual(parseDevToolsActivePort(''), null);
  assert.strictEqual(wsEndpointForPortPath(9222, '/devtools/browser/abc-123'),
    'ws://127.0.0.1:9222/devtools/browser/abc-123');
  assert.strictEqual(wsEndpointForPortPath(9222, null), null, '没有路径就不能拼 —— 少了 UUID 的 ws 地址会被 404');
  assert.strictEqual(wsEndpointForPortPath(9222, '/devtools/browser/'), null);
  assert.strictEqual(wsEndpointForPortPath(9222, '/etc/passwd'), null, '只认 DevTools 那一种形态');
  assert.strictEqual(wsEndpointForPortPath(0, '/devtools/browser/x'), null);
});

test('humanCdpAttachError：403 要翻译成「去点允许」，而不是丢一句 WebSocket error', () => {
  const raw = 'WebSocket error: ws://127.0.0.1:9222/devtools/browser/x 403 Forbidden\nConnection rejected';
  const msg = humanCdpAttachError(raw);
  assert.match(msg, /允许远程调试/);
  assert.match(msg, /chrome:\/\/inspect/);
  assert.match(msg, /取消再重新勾|没看到弹框/, '没弹框时要知道取消再勾一次');
  assert.match(msg, /重试/, '要明说别反复重试（重试会把弹框打掉）');
  const other = humanCdpAttachError('boom');
  assert.match(other, /boom/);
});

/* http 形态端点：**非默认 profile 能用（走 /json 发现），默认 profile 一律 404**。
 * 实测事故：用户端点框里留着占位符教的那个 http://127.0.0.1:9222，attach 1 秒就死在
 * 「This does not look like a DevTools server, try connecting via ws://.」——
 * 而当时的报错提示还在教他去点「允许远程调试」，方向完全错。 */
test('httpTargetPort：只从 http(s) 端点里取端口，ws / 内核名 / 没写端口一律 null', () => {
  assert.strictEqual(httpTargetPort('http://127.0.0.1:9222'), 9222);
  assert.strictEqual(httpTargetPort('http://localhost:9222/json/version'), 9222);
  assert.strictEqual(httpTargetPort('https://127.0.0.1:4741'), 4741);
  assert.strictEqual(httpTargetPort('ws://127.0.0.1:9222/devtools/browser/x'), null);
  assert.strictEqual(httpTargetPort('chrome'), null);
  assert.strictEqual(httpTargetPort('http://127.0.0.1'), null, '没写端口的是 80，不是调试端口');
  assert.strictEqual(httpTargetPort('http://例.子:9222'), 9222, '端口照取（本地端口文件对不上就不会换）');
});

test('resolveHttpTarget：http 端点能在端口文件里对上端口 → 换成那条 ws（默认 profile 只有 ws 能用）', () => {
  const hit = resolveHttpTarget('http://127.0.0.1:4741', [tempPortFile('4741\n/devtools/browser/abc-123\n')]);
  assert.strictEqual(hit, 'ws://127.0.0.1:4741/devtools/browser/abc-123');
  /* 端口对不上（比如那是**远程**浏览器，或另一个非默认 profile）= 不换，原样交给 attach */
  assert.strictEqual(resolveHttpTarget('http://127.0.0.1:9999', [tempPortFile('4741\n/devtools/browser/abc-123\n')]), null);
  assert.strictEqual(resolveHttpTarget('http://se.ver:4741', [tempPortFile('4741\n/devtools/browser/abc-123\n')]), null,
    '非本机地址绝不能被本地端口文件劫持');
  assert.strictEqual(resolveHttpTarget('ws://127.0.0.1:4741/devtools/browser/x', [tempPortFile('4741\n/devtools/browser/abc-123\n')]), null,
    '本来就是 ws 的不动');
  assert.strictEqual(resolveHttpTarget('http://127.0.0.1:4741', [tempPortFile('4741\n')]), null,
    '文件里没有 ws 路径（老格式）就换不了');
});

test('humanCdpAttachError：http 形态的 404 要说清「填 http 没用」，不是叫他去点允许', () => {  const raw = 'B:\\npm\\global\\node_modules\\@playwright\\cli\\node_modules\\playwright-core\\lib\\tools\\cli-client\\session.js:172 | '
    + 'Unexpected status 404 when connecting to http://127.0.0.1:9222/json/version/.\n'
    + 'This does not look like a DevTools server, try connecting via ws://.';
  const msg = humanCdpAttachError(raw);
  assert.match(msg, /ws:\/\//, '要给出可用的形态');
  assert.match(msg, /DevToolsActivePort/);
  assert.match(msg, /留空/, '最省事的做法是留空自动探测');
  assert.ok(!/点「允许/.test(msg), '这个错因与授权无关，不能再教他去点允许');
});

/* 提示文案里那条「或者自己带 --remote-debugging-port=9222 启动」是错的：
 * Chrome 136+ 在默认 profile 上**忽略**这个参数（实测带了反而完全不绑端口），
 * 而默认 profile 才是带登录态的那个。留着它只会把人带沟里。 */
test('cdpProbeHint：不再教人带 --remote-debugging-port 启动，而是指向勾选框 + 两条可用形态', () => {
  const hint = cdpProbeHint();
  assert.ok(!/或者自己带\s*--remote-debugging-port/.test(hint), '这条建议在默认 profile 上无效，不能再推荐');
  assert.match(hint, /别\*\*给它加|忽略/, '要主动说明为什么别加这个参数（加了会被忽略）');
  assert.match(hint, /chrome:\/\/inspect/);
  assert.match(hint, /DevToolsActivePort/, '端点从哪来要说清');
  assert.match(hint, /留空/);
});

/* ---------- http 形态端点在 open() 里就被换成 ws（实测事故的回归） ----------
 * 用户端点框里留着 http://127.0.0.1:9222（早先的占位符就是这么教的），attach 1 秒死在
 * 「This does not look like a DevTools server, try connecting via ws://.」—— Chrome 147+
 * 在默认 profile 上关掉了 /json 发现。
 * 这里在 PATH 最前面放一个假的 playwright-cli，把**实际发给 CLI 的 argv** 记下来：
 * 比"看报错文案"可靠得多，也不需要真浏览器、不会有授权弹窗。 */
/* 假 playwright-cli + 一份临时端口文件（端口 4741 + uuid）：走真实的 open()，
 * 只把「端口文件从哪来」换掉（LOCALAPPDATA 指向临时目录里的默认 profile 位置）。
 * 返回实际发给 CLI 的 attach 行 —— 比"看报错文案"可靠得多，也不需要真浏览器。 */
function cdpSwapHarness(payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-fakecli-'));
  const argvFile = path.join(dir, 'argv.txt');
  const json = JSON.stringify(payload);
  fs.writeFileSync(path.join(dir, 'playwright-cli.cmd'),
    '@echo off\r\necho %* >> "' + argvFile + '"\r\necho ' + json + '\r\nexit /b 0\r\n');
  fs.writeFileSync(path.join(dir, 'playwright-cli'),
    '#!/bin/sh\necho "$@" >> "' + argvFile.replace(/\\/g, '/') + '"\necho \'' + json + '\'\nexit 0\n');
  fs.chmodSync(path.join(dir, 'playwright-cli'), 0o755);

  const oldPath = process.env.PATH;
  const oldLocal = process.env.LOCALAPPDATA;
  process.env.PATH = dir + path.delimiter + oldPath;
  process.env.LOCALAPPDATA = path.join(dir, 'appdata');
  const profile = path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data');
  fs.mkdirSync(profile, { recursive: true });
  fs.copyFileSync(tempPortFile('4741\n/devtools/browser/fake-uuid\n').file,
    path.join(profile, 'DevToolsActivePort'));

  return {
    attaches: () => fs.readFileSync(argvFile, 'utf8').split(/\r?\n/).filter((l) => /attach/.test(l)),
    restore: () => {
      process.env.PATH = oldPath;
      if (oldLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = oldLocal;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/* 手填的 http 端点：**先按用户填的试**（端口文件是磁盘残留物，可能属于另一个浏览器，
 * 静默换掉会把一个本来能连的端点变成连不上的），只有 404 那条死路才回退到 ws。 */
test('open(cdp)：手填的 http 端点先原样发给 CLI，不静默替换', async () => {
  const h = cdpSwapHarness({ isError: true, error: 'connect ECONNREFUSED' });
  const sess = 'jevswap' + Date.now().toString(36);
  try {
    const r = await driver.open(sess, 'http://127.0.0.1:3000/demo/mailbox.html', { mode: 'cdp', cdp: 'http://127.0.0.1:4741' });
    assert.ok(!r.ok, '假 CLI 一定失败（我们只看它收到了什么）');
    const attaches = h.attaches();
    assert.strictEqual(attaches.length, 1, '端口没人听这种错不该重试（会白等一次 attach 超时）：' + JSON.stringify(attaches));
    assert.match(attaches[0], /--cdp=http:\/\/127\.0\.0\.1:4741/, '第一条必须是用户填的那个：' + attaches[0]);
  } finally {
    h.restore();
    await driver.close(sess).catch(() => {});
  }
});

test('open(cdp)：http 端点回 404（默认 profile 的 /json 发现被关）→ 回退到端口文件里那条 ws', async () => {
  const h = cdpSwapHarness({ isError: true, error: 'This does not look like a DevTools server, try connecting via ws://.' });
  const sess = 'jevswap' + Date.now().toString(36);
  try {
    const r = await driver.open(sess, 'http://127.0.0.1:3000/demo/mailbox.html', { mode: 'cdp', cdp: 'http://127.0.0.1:4741' });
    assert.ok(!r.ok);
    const attaches = h.attaches();
    assert.strictEqual(attaches.length, 2, '404 后应当回退重试一次：' + JSON.stringify(attaches));
    assert.match(attaches[0], /--cdp=http:\/\/127\.0\.0\.1:4741/, '先试用户填的');
    assert.match(attaches[1], /--cdp=ws:\/\/127\.0\.0\.1:4741\/devtools\/browser\/fake-uuid/, '回退到端口文件那条：' + attaches[1]);
  } finally {
    h.restore();
    await driver.close(sess).catch(() => {});
  }
});

test('open(cdp)：403（授权没点）只发一条 attach —— 重试会把授权弹窗打掉', async () => {
  const h = cdpSwapHarness({ isError: true, error: '403 Forbidden' });
  const sess = 'jevswap' + Date.now().toString(36);
  try {
    const r = await driver.open(sess, 'http://127.0.0.1:3000/demo/mailbox.html', { mode: 'cdp', cdp: 'http://127.0.0.1:4741' });
    assert.ok(!r.ok);
    assert.match(r.error, /允许|permission/i, '要指到那个授权弹框：' + r.error);
    assert.strictEqual(h.attaches().length, 1, '403 绝不能重试：' + JSON.stringify(h.attaches()));
  } finally {
    h.restore();
    await driver.close(sess).catch(() => {});
  }
});

/* ---------- 步骤截图：css 档偶发超时 → 重试一次 ----------
 * 为什么需要重试：playwright-cli 的 screenshot 默认走 css 档，实测在 dpr 为小数等情形下会撞
 * CLI 的 5s 动作超时（同一命令隔一会儿重试往往就过）。这张图是标注与人眼复核的唯一凭据，
 * 丢一次整步就没图了。真浏览器跑不出「第一次超时、第二次成功」这种时序，所以用假 CLI。 */

/* 有状态假 CLI：按调用序号回不同的 JSON；收到成功回包且带 --filename 时把 1x1 PNG 写到
 * cwd（= driver.dataDir），让 driver 那条「读文件 → dataURL」的路真的走通 —— 于是
 * 「重试之后这一步确实拿到图」也能被断言，而不是只数调用次数。 */
function fakeShotHarness(seq) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-fakeshot-'));
  const argvFile = path.join(dir, 'argv.txt');
  fs.writeFileSync(path.join(dir, 'seq.json'), JSON.stringify(seq));
  fs.writeFileSync(path.join(dir, 'stub.js'), [
    'const fs = require("fs"), path = require("path");',
    'const args = process.argv.slice(2);',
    'fs.appendFileSync(path.join(__dirname, "argv.txt"), args.join(" ") + "\\n");',
    'const n = fs.readFileSync(path.join(__dirname, "argv.txt"), "utf8").trim().split(/\\r?\\n/).filter(Boolean).length;',
    'const seq = JSON.parse(fs.readFileSync(path.join(__dirname, "seq.json"), "utf8"));',
    'const reply = seq[Math.min(n - 1, seq.length - 1)];',
    'if (!reply.isError) {',
    '  const fi = args.indexOf("--filename");',
    '  if (fi >= 0) {',
    '    const name = String(args[fi + 1]).replace(/[^A-Za-z0-9_.-]/g, "");',
    '    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";',
    '    fs.writeFileSync(path.resolve(process.cwd(), name), Buffer.from(png, "base64"));',
    '  }',
    '}',
    'process.stdout.write(JSON.stringify(reply) + "\\n");',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'playwright-cli.cmd'), '@echo off\r\nnode "%~dp0stub.js" %*\r\n');
  fs.writeFileSync(path.join(dir, 'playwright-cli'), '#!/bin/sh\nexec node "$(dirname "$0")/stub.js" "$@"\n');
  fs.chmodSync(path.join(dir, 'playwright-cli'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = dir + path.delimiter + oldPath;
  const lines = () => { try { return fs.readFileSync(argvFile, 'utf8').split(/\r?\n/).filter(Boolean); } catch (_) { return []; } };
  return {
    shots: () => lines().filter((l) => /screenshot/.test(l)),
    restore: () => { process.env.PATH = oldPath; fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
const SHOT_TIMEOUT_ERR = { isError: true, error: 'TimeoutError: Timeout 5000ms exceeded.\nCall log:\n - taking page screenshot' };

test('截图超时（CLI 5s）重试一次，第二次成功则这一步确实拿到图', async () => {
  const h = fakeShotHarness([SHOT_TIMEOUT_ERR, { result: '- [Screenshot of viewport](./x.png)' }]);
  const sess = 'jevshot' + Date.now().toString(36);
  const name = 'e2e-shot-retry-' + Date.now().toString(36);
  try {
    const r = await driver.screenshot(sess, name);
    assert.strictEqual(h.shots().length, 2, '超时应重试一次，实际调用：' + JSON.stringify(h.shots()));
    assert.strictEqual(r.ok, true, '重试成功后应有图：' + JSON.stringify(r));
    assert.match(String(r.dataUrl), /^data:image\/png;base64,/, 'dataURL 前缀不对：' + String(r.dataUrl).slice(0, 40));
  } finally {
    h.restore();
    try { fs.unlinkSync(path.join(driver.dataDir, name + '.png')); } catch (_) { /* 没写出来就算了 */ }
  }
});

test('截图非超时失败不重试（丢标签页/弹窗这类失败重试没意义，白等一个超时周期）', async () => {
  const h = fakeShotHarness([{ isError: true, error: '专用标签页已不在（被关闭或被切走）' }]);
  const sess = 'jevshot' + Date.now().toString(36);
  try {
    const r = await driver.screenshot(sess, 'e2e-shot-noretry');
    assert.strictEqual(h.shots().length, 1, '只该试一次：' + JSON.stringify(h.shots()));
    assert.strictEqual(r.ok, false);
    assert.match(String(r.error), /标签页已不在/);
  } finally { h.restore(); }
});

test('两次都超时：如实返回失败，不无限重试', async () => {
  const h = fakeShotHarness([SHOT_TIMEOUT_ERR]);
  const sess = 'jevshot' + Date.now().toString(36);
  try {
    const r = await driver.screenshot(sess, 'e2e-shot-always-timeout');
    assert.strictEqual(h.shots().length, 2, '最多两次：' + JSON.stringify(h.shots()));
    assert.strictEqual(r.ok, false);
    assert.match(String(r.error), /Timeout/i, '得把超时原因带回去：' + String(r.error));
  } finally { h.restore(); }
});

