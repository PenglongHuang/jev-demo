/* browser-driver 单元测试（不起浏览器）：白名单 / 参数校验 / Windows 引号 / argv 组装 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const driver = require(path.join(__dirname, '..', 'browser-driver.js'));
const { quoteArg, validateAct, buildArgv, OPS, REF_RE } = driver._test;

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

test('白名单恰好覆盖设计 §7 的 27 个浏览器操作', () => {
  assert.strictEqual(Object.keys(OPS).length, 27);
  ['click', 'dblclick', 'fill', 'type', 'select', 'check', 'uncheck', 'hover', 'drop',
    'upload', 'press', 'keydown', 'keyup', 'mousemove', 'mousedown', 'mouseup', 'mousewheel',
    'goto', 'go-back', 'go-forward', 'reload',
    'tab-new', 'tab-select', 'tab-close', 'tab-list', 'dialog-accept', 'dialog-dismiss']
    .forEach((k) => assert.ok(OPS[k], '缺少动作 ' + k));
});

test('白名单外与硬排除的动作一律拒绝', () => {
  ['snapshot', 'screenshot', 'eval', 'console', 'requests', 'find', 'pdf', 'resize',
    'cookie-list', 'cookie-set', 'cookie-delete', 'localstorage-set', 'sessionstorage-list',
    'route', 'unroute', 'network-state-set', 'open', 'close', 'attach', 'detach', 'list',
    'close-all', 'kill-all', 'delete-data', 'install', 'install-browser', 'state-save',
    'state-load', 'show', 'pause-at', 'resume', 'step-over', 'tracing-start', 'video-start',
    'highlight', 'generate-locator', 'run-code', 'request', '任务已完成', '生成输入', '无操作', '']
    .forEach((k) => assert.throws(() => validateAct(k, null, null), /不允许|白名单|未知/, '应拒绝 ' + k));
});

test('需要 ref 的动作缺 ref 时拒绝', () => {
  ['click', 'dblclick', 'fill', 'type', 'select', 'check', 'uncheck', 'hover', 'drop'].forEach((k) => {
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

test('mousemove / mousewheel 接受 "x,y" 整数对', () => {
  assert.deepStrictEqual(validateAct('mousewheel', null, '0,-120'), { op: 'mousewheel', ref: null, text: '0,-120' });
  assert.deepStrictEqual(validateAct('mousemove', null, '100, 60'), { op: 'mousemove', ref: null, text: '100, 60' });
  assert.throws(() => validateAct('mousemove', null, 'x,y'), /坐标/);
  assert.throws(() => validateAct('mousewheel', null, '120'), /坐标/);
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
