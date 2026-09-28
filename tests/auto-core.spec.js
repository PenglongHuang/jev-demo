/* auto-core 纯逻辑测试：state/问题组装、决策解析、执行规划、终止判断、
 * 历史压缩、LLM prompt、文本清洗（全部无 DOM，真实快照样本） */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const vm = require('vm');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const AutoCore = require(path.join(ROOT, 'public', 'js', 'auto-core.js'));

/* 真实形状的快照样本（与 playwright-cli snapshot --raw 输出同构，含干扰项） */
const SAMPLE_SNAPSHOT = [
  '- generic [active] [ref=e1]:',
  '  - banner [ref=e2]:',
  '    - searchbox "搜索邮件" [ref=e3]',
  '    - button "写信" [ref=e4] [cursor=pointer]',
  '  - main [ref=e5]:',
  '    - heading "收件箱" [level=1] [ref=e6]',
  '    - list "邮件列表（按时间倒序）" [ref=e7]:',
  '      - listitem "邮件 1：招商银行信用卡中心 · 您的 9 月电子对账单已生成" [ref=e8]:',
  '        - link "您的 9 月电子对账单已生成" [ref=e9] [cursor=pointer]:',
  '          - /url: /mail/read/2400',
  '        - button "归档" [ref=e10] [cursor=pointer]',
  '      - listitem "邮件 2：灵犀云市场 · 限时优惠" [ref=e11]:',
  '        - button "归档" [ref=e12] [cursor=pointer]',
  '      - listitem "邮件 3：招商银行信用卡中心 · 您的 8 月电子对账单已生成" [ref=e13]:',
  '        - button "归档" [ref=e14] [cursor=pointer]',
  '    - textbox "备注" [ref=e15]',
].join('\n');

const SAMPLE_REFS = AutoCore.refCriteria(SAMPLE_SNAPSHOT);

/* ---------- ref 解析与 util.js 保持一致 ---------- */

test('ref 解析与 public/js/util.js 的实现逐项一致（浏览器/Node 同一份行为）', () => {
  const code = fs.readFileSync(path.join(ROOT, 'public', 'js', 'util.js'), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(code + '\nthis.__x = { parseSnapshotRefs: parseSnapshotRefs, buildRefCriteria: buildRefCriteria };', sandbox);
  /* vm 跨 realm 原型不同，deepStrictEqual 不可用，按 JSON 规范化后对拍 */
  assert.strictEqual(
    JSON.stringify(AutoCore.refCriteria(SAMPLE_SNAPSHOT)),
    JSON.stringify(sandbox.__x.buildRefCriteria(SAMPLE_SNAPSHOT)));
});

/* ---------- buildState ---------- */

test('buildState：模板字段齐全，快照全量透传，历史默认取 8 条', () => {
  const history = Array.from({ length: 12 }, (_, i) => (i + 1) + '. click【e' + (i + 1) + '】成功');
  const st = AutoCore.buildState({
    goal: '归档对账单', url: 'http://localhost:3000/demo/mailbox.html', title: '灵犀邮箱 · 收件箱',
    history, lastResult: '成功', snapshot: SAMPLE_SNAPSHOT,
  });
  assert.strictEqual(st['任务目标'], '归档对账单');
  assert.strictEqual(st['当前页面'].url, 'http://localhost:3000/demo/mailbox.html');
  assert.strictEqual(st['当前页面'].标题, '灵犀邮箱 · 收件箱');
  assert.strictEqual(st['页面快照'], SAMPLE_SNAPSHOT);
  assert.strictEqual(st['已完成步骤'].length, 9);           // 聚合 1 条 + 最近 8 条
  assert.match(st['已完成步骤'][0], /更早的 4 步已省略/);
  assert.strictEqual(st['已完成步骤'][9 - 1], '12. click【e12】成功');
  assert.strictEqual(st['上一步结果'], '成功');
  /* 未传 tabs 时退化为「当前页单行」（老调用方零回归） */
  assert.deepStrictEqual(st['标签页'],
    ['【当前】Tab 0：灵犀邮箱 · 收件箱 — http://localhost:3000/demo/mailbox.html']);
});

test('buildState：多标签页逐个列出并提示切换动词；单 Tab 不加提示', () => {
  const tabs = [
    { index: 0, current: true, title: '百度一下，你就知道', url: 'https://www.baidu.com/' },
    { index: 1, current: false, title: 'jev_百度搜索', url: 'https://www.baidu.com/s?wd=jev' },
  ];
  const multi = AutoCore.buildState({
    goal: 'g', url: tabs[0].url, title: tabs[0].title, history: [], lastResult: '成功', snapshot: 's', tabs,
  });
  assert.deepStrictEqual(multi['标签页'].slice(0, 2), [
    '【当前】Tab 0：百度一下，你就知道 — https://www.baidu.com/',
    'Tab 1：jev_百度搜索 — https://www.baidu.com/s?wd=jev',
  ]);
  assert.match(multi['标签页'][2], /tab-select/, '多 Tab 必须提示切换动词');
  assert.match(multi['标签页'][2], /tab-close/);

  const single = AutoCore.buildState({
    goal: 'g', url: 'u', title: 't', history: [], lastResult: '', snapshot: 's', tabs: [tabs[0]],
  });
  assert.strictEqual(single['标签页'].length, 1, '单 Tab 不附加切换提示');
});

test('buildState：首步无上一步结果时给出占位说明', () => {
  const st = AutoCore.buildState({ goal: 'g', url: 'u', title: 't', history: [], lastResult: '', snapshot: 's' });
  assert.match(st['上一步结果'], /第一步|尚无/);
});

/* ---------- buildQuestions ---------- */

test('buildQuestions：固定 3 道，动作 19+2+2、参数来自快照、未完成 2 级（文本已移入补问）', () => {
  const qs = AutoCore.buildQuestions({
    snapshot: SAMPLE_SNAPSHOT,
    variables: [{ name: '关键词', value: '招商银行' }, { name: '回车', value: 'Enter' }],
  });
  assert.deepStrictEqual(Object.keys(qs), ['动作', '参数', '未完成']);
  assert.ok(!qs['文本'], '「文本」不再随首轮作答：候选依赖已定动作，构造不出来');

  const tools = qs['动作'].criteria;
  assert.strictEqual(Object.keys(tools).length, 23);   // 19 浏览器操作 + 2 工程 + 2 终止
  ['click', 'fill', 'goto', 'tab-list', 'dialog-accept', '生成输入', '无操作', '任务已完成', '放弃']
    .forEach((k) => assert.ok(tools[k], '动作缺少 ' + k));
  /* 裁掉的 8 个不得回潮 */
  ['dblclick', 'drop', 'keydown', 'keyup', 'mousemove', 'mousedown', 'mouseup', 'mousewheel']
    .forEach((k) => assert.ok(!tools[k], '动作不应再有 ' + k));
  assert.ok(tools['生成输入'].includes('生成'));
  assert.ok(!('snapshot' in tools) && !('eval' in tools) && !('cookie-set' in tools));

  const params = qs['参数'].criteria;
  assert.ok(params.e10.includes('【可交互】'));
  assert.ok(params.e10.includes('归档'));
  assert.strictEqual(params['无需元素'], undefined, '「无需元素」兜底项已下线：参数题只放真实 ref');

  assert.strictEqual(qs['未完成'].type, 'score');
  assert.strictEqual(AutoCore.SCORE_LEVELS, 2);
  /* 漂移守卫：级数与图例行数一旦不一致，score 归一化的分母就错了
   * （图例 2 行、分母还按 4 算 → score 0.97 被压成未完成 24%）。 */
  assert.strictEqual(qs['未完成'].criteria.length, AutoCore.SCORE_LEVELS,
    '未完成 criteria 行数必须与 SCORE_LEVELS 一致');
  [qs['动作'], qs['参数']].forEach((q) => assert.strictEqual(q.type, 'choice'));
});

/* ---------- 措辞防混淆：select 事故回归（orders 场景，模型对 button "发货" 选了 select） ----------
 * 事故链条：动作题与元素完全解耦 + `select` 与选择题的「选中」同形 → 模型把「选中这一行」
 * 映射成了 select，打到浏览器上才被 `Element is not a <select> element` 拦下。
 * 下面三条钉住的是「措辞必须承担排他义务」，不是具体字面 —— 改文案可以，改掉排他性不行。 */

test('动作词表：select 限定为原生下拉框，并把其余场景指回 click', () => {
  const tools = AutoCore.AUTO_TOOLS;
  assert.match(tools.select, /仅|只/, 'select 必须写明适用范围是排他的');
  assert.match(tools.select, /下拉框/);
  assert.match(tools.select, /click/, 'select 必须把非下拉框场景指回 click');
  assert.match(tools.click, /选中|点开/, 'click 必须承担「选中/点开某个元素」的语义，否则会被 select 抢走');
});

test('动作题 instructions：给出角色 → 动词对照', () => {
  const qs = AutoCore.buildQuestions({ snapshot: SAMPLE_SNAPSHOT, variables: [] });
  const acts = qs['动作'].instructions;
  assert.match(acts, /角色/);
  assert.match(acts, /click/);
  assert.match(acts, /按钮/);
  assert.match(acts, /下拉框/);
});

test('动作题 instructions：滚动指到 press + 键名补问，等待指到无操作', () => {
  const qs = AutoCore.buildQuestions({ snapshot: SAMPLE_SNAPSHOT, variables: [] });
  const acts = qs['动作'].instructions;
  assert.match(acts, /press/);
  assert.match(acts, /PageDown/);
  assert.match(acts, /无操作/);
});

/* ---------- 动作 × 元素角色兼容性：不兼容就不发命令，同一步内补问「动作」 ----------
 * 只登记「物理上不可能」的组合（select 非下拉框、check 非勾选框），其余一律放行：
 * 可编辑性判不了（contenteditable 的 div 在快照里是 generic），按角色拦会误报。 */

test('refRoles：从快照解析出每个 ref 的角色', () => {
  const roles = AutoCore.refRoles(SAMPLE_SNAPSHOT);
  assert.strictEqual(roles.e10, 'button');
  assert.strictEqual(roles.e3, 'searchbox');
  assert.strictEqual(roles.e8, 'listitem');
});

test('checkActionRole：select 只能配下拉框，配 button 判冲突并给出兼容动作', () => {
  const roles = { e10: 'button', e15: 'combobox' };
  const bad = AutoCore.checkActionRole({ action: 'select', param: 'e10' }, roles);
  assert.strictEqual(bad.conflict, true);
  assert.strictEqual(bad.role, 'button');
  assert.strictEqual(bad.action, 'select');
  assert.match(bad.why, /下拉框/);
  assert.ok(!bad.compatible.includes('select'));
  assert.ok(bad.compatible.includes('click'));
  assert.strictEqual(AutoCore.checkActionRole({ action: 'select', param: 'e15' }, roles).conflict, false);
});

test('checkActionRole：check / uncheck 只认勾选框类角色，click 不受限', () => {
  const roles = { e10: 'button', e20: 'checkbox', e21: 'switch' };
  assert.strictEqual(AutoCore.checkActionRole({ action: 'check', param: 'e10' }, roles).conflict, true);
  assert.match(AutoCore.checkActionRole({ action: 'uncheck', param: 'e10' }, roles).why, /复选框|单选框/);
  assert.strictEqual(AutoCore.checkActionRole({ action: 'check', param: 'e20' }, roles).conflict, false);
  assert.strictEqual(AutoCore.checkActionRole({ action: 'uncheck', param: 'e21' }, roles).conflict, false);
  assert.strictEqual(AutoCore.checkActionRole({ action: 'click', param: 'e10' }, roles).conflict, false);
});

test('checkActionRole：放行 fill / 未知角色 / 未选元素（宁可漏报，不误报白问一次）', () => {
  const roles = { e10: 'button' };
  assert.strictEqual(AutoCore.checkActionRole({ action: 'fill', param: 'e10' }, roles).conflict, false);
  assert.strictEqual(AutoCore.checkActionRole({ action: 'type', param: 'e10' }, roles).conflict, false);
  assert.strictEqual(AutoCore.checkActionRole({ action: '生成输入', param: 'e10' }, roles).conflict, false);
  assert.strictEqual(AutoCore.checkActionRole({ action: 'select', param: 'e99' }, roles).conflict, false);
  assert.strictEqual(AutoCore.checkActionRole({ action: 'select', param: null }, roles).conflict, false);
  assert.strictEqual(AutoCore.checkActionRole({ action: '任务已完成', param: null }, roles).conflict, false);
});

test('buildActionFollowUp：只问「动作」，候选去掉该元素上不可能的动作，且不带终止态', () => {
  const c = AutoCore.checkActionRole({ action: 'select', param: 'e10' }, { e10: 'button' });
  const qs = AutoCore.buildActionFollowUp(c);
  assert.deepStrictEqual(Object.keys(qs), ['动作']);
  assert.strictEqual(qs['动作'].type, 'choice');
  assert.ok(!qs['动作'].criteria.select);
  assert.ok(!qs['动作'].criteria.check);
  assert.ok(qs['动作'].criteria.click);
  assert.ok(!qs['动作'].criteria['任务已完成'], '补问不带终止态：终止要走主循环那条通道');
  assert.match(qs['动作'].instructions, /e10/);
  assert.match(qs['动作'].instructions, /button/);
  assert.match(qs['动作'].instructions, /select/);
  assert.match(qs['动作'].instructions, /click/, '补问要顺带把该角色的常规动词指出来（fill 这类判不了可编辑性的动作拦不住）');
});

test('parseActionAnswer：取「动作」选项；缺失抛错', () => {
  assert.strictEqual(AutoCore.parseActionAnswer({ 动作: { choice: 'click' } }), 'click');
  assert.throws(() => AutoCore.parseActionAnswer({}), /动作/);
});

/* auto.js 只在浏览器里跑，Node 测试碰不到它 —— 少导出一个成员，报错要等到用户点开始才出现。
 * 这条把「auto.js 提到的每个 AutoCore.xxx 都必须真的导出」变成可在 CI 里跑的断言。 */
test('auto.js 里出现的 AutoCore.xxx 全部有导出', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'auto.js'), 'utf8');
  const used = new Set();
  const re = /AutoCore\.([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(src))) used.add(m[1]);
  const missing = [...used].filter((k) => !(k in AutoCore));
  assert.deepStrictEqual(missing, [], 'auto.js 调了未导出的 AutoCore 成员：' + missing.join(','));
});

/* ---------- parseDecision ---------- */

test('parseDecision：首轮两道 choice + score 归一化，text 恒为 null（旧上游多回的文本答案被忽略）', () => {
  const mk = (score) => ({
    动作: { type: 'choice', choice: 'fill', probabilities: { fill: 0.8 } },
    参数: { type: 'choice', choice: 'e3', probabilities: { e3: 0.7 } },
    文本: { type: 'choice', choice: '关键词', probabilities: { 关键词: 0.9 } },
    未完成: { type: 'score', score, probabilities: {} },
  });
  const d = AutoCore.parseDecision(mk(1));
  assert.strictEqual(d.action, 'fill');
  assert.strictEqual(d.param, 'e3');
  assert.strictEqual(d.text, null, '文本改由动作落定后的补问写入，首轮答案一律不消费');
  assert.strictEqual(d.unfinished, 1, '2 级量表归一化分母是 1：score 原样即未完成度');
  /* 加权均值是连续值：0.97（97% 压在「进行中」）必须保持 0.97，
   * 不得再被 4 除压扁成 0.2425（实测事故的展示失真来源） */
  assert.strictEqual(AutoCore.parseDecision(mk(0.97)).unfinished, 0.97);
  assert.strictEqual(AutoCore.parseDecision(mk(0)).unfinished, 0);
});

test('parseDecision：未知动作抛错（记失败步骤由上层处理）', () => {
  assert.throws(() => AutoCore.parseDecision({
    动作: { type: 'choice', choice: 'cookie-set' }, 参数: { choice: 'e1' }, 文本: { choice: '无' }, 未完成: { score: 0 },
  }), /动作/);
});

test('parseDecision：缺失/非法「未完成」分值一律抛错（绝不默认 0 = 已完成）', () => {
  const ok = { 动作: { choice: 'click' }, 参数: { choice: 'e10' }, 文本: { choice: '无' } };
  assert.throws(() => AutoCore.parseDecision(ok), /未完成/);                       // 整题缺失
  assert.throws(() => AutoCore.parseDecision(Object.assign({}, ok, { 未完成: {} })), /未完成/);            // score 缺失
  assert.throws(() => AutoCore.parseDecision(Object.assign({}, ok, { 未完成: { score: null } })), /未完成/); // null
  assert.throws(() => AutoCore.parseDecision(Object.assign({}, ok, { 未完成: { score: '2' } })), /未完成/);  // 字符串
  assert.throws(() => AutoCore.parseDecision(Object.assign({}, ok, { 未完成: { score: 3 } })), /未完成/, '旧 5 级量表的分值在 2 级量表下非法');  // 超出 0~1
  assert.throws(() => AutoCore.parseDecision(Object.assign({}, ok, { 未完成: { score: -1 } })), /未完成/);
});

/* ---------- planExecution ---------- */

const VARS = [{ name: '关键词', value: '招商银行' }, { name: '回车', value: 'Enter' }];

test('planExecution：常规动作映射到 op/ref/text', () => {
  assert.deepStrictEqual(
    AutoCore.planExecution({ action: 'click', param: 'e10', text: '无' }, VARS),
    { kind: 'act', op: 'click', ref: 'e10', text: null });
  assert.deepStrictEqual(
    AutoCore.planExecution({ action: 'fill', param: 'e3', text: '关键词' }, VARS),
    { kind: 'act', op: 'fill', ref: 'e3', text: '招商银行' });
  assert.deepStrictEqual(
    AutoCore.planExecution({ action: 'goto', param: null, text: '关键词' }, VARS),
    { kind: 'act', op: 'goto', ref: null, text: '招商银行' });
  assert.deepStrictEqual(
    AutoCore.planExecution({ action: 'press', param: null, text: '回车' }, VARS),
    { kind: 'act', op: 'press', ref: null, text: 'Enter' });
  /* 不作用于元素的动作随手选了参数也不消费（「无需元素」下线后的替代语义） */
  assert.deepStrictEqual(
    AutoCore.planExecution({ action: 'goto', param: 'e10', text: '关键词' }, VARS),
    { kind: 'act', op: 'goto', ref: null, text: '招商银行' });
});

test('planExecution：工程动作与终止动作', () => {
  assert.deepStrictEqual(AutoCore.planExecution({ action: '无操作', param: null, text: '无' }, VARS), { kind: 'noop' });
  assert.deepStrictEqual(AutoCore.planExecution({ action: '生成输入', param: 'e3', text: '无' }, VARS), { kind: 'llm', ref: 'e3' });
  assert.deepStrictEqual(AutoCore.planExecution({ action: '任务已完成', param: null, text: '无' }, VARS), { kind: 'terminal', action: '任务已完成' });
});

test('planExecution：可选文本动作（tab-close/tab-new/dialog-accept）选「无」是合法无参形态', () => {
  assert.deepStrictEqual(AutoCore.planExecution({ action: 'dialog-accept', param: null, text: '无' }, VARS), { kind: 'act', op: 'dialog-accept', ref: null, text: null });
  assert.deepStrictEqual(AutoCore.planExecution({ action: 'tab-close', param: null, text: '无' }, VARS), { kind: 'act', op: 'tab-close', ref: null, text: null });
  assert.deepStrictEqual(AutoCore.planExecution({ action: 'tab-new', param: null, text: '无' }, VARS), { kind: 'act', op: 'tab-new', ref: null, text: null });
  /* 带文本同样合法 */
  assert.deepStrictEqual(AutoCore.planExecution({ action: 'dialog-accept', param: null, text: '好的' }, VARS), { kind: 'act', op: 'dialog-accept', ref: null, text: '好的' });
});

test('planExecution：矛盾决策抛错（需 ref 却未选元素 / 需文本却选无）', () => {
  assert.throws(() => AutoCore.planExecution({ action: 'click', param: null, text: '无' }, VARS), /未.*选定元素/);
  assert.throws(() => AutoCore.planExecution({ action: 'fill', param: 'e3', text: '无' }, VARS), /文本/);
  assert.throws(() => AutoCore.planExecution({ action: '生成输入', param: null, text: '无' }, VARS), /未.*选定元素/);
});

/* ---------- shouldTerminate ---------- */

test('shouldTerminate：未完成度连续两轮 <0.2 判完成', () => {
  assert.deepStrictEqual(
    AutoCore.shouldTerminate({ steps: 3, maxSteps: 15, unfinishedHistory: [0.8, 0.19, 0.15], consecutiveFails: 0 }),
    { done: true, state: 'done', reason: '任务完成（Jev 连续两轮判定未完成度 < 0.2）' });
  assert.strictEqual(
    AutoCore.shouldTerminate({ steps: 3, maxSteps: 15, unfinishedHistory: [0.19, 0.25], consecutiveFails: 0 }), null);
  assert.strictEqual(
    AutoCore.shouldTerminate({ steps: 1, maxSteps: 15, unfinishedHistory: [0.1], consecutiveFails: 0 }), null);
});

test('shouldTerminate：步数上限 / 连续失败 / 用户中止', () => {
  assert.deepStrictEqual(
    AutoCore.shouldTerminate({ steps: 15, maxSteps: 15, unfinishedHistory: [0.5], consecutiveFails: 0 }),
    { done: false, state: 'limit', reason: '达到步数上限（15）' });
  assert.deepStrictEqual(
    AutoCore.shouldTerminate({ steps: 5, maxSteps: 15, unfinishedHistory: [0.5], consecutiveFails: 3 }),
    { done: false, state: 'fails', reason: '连续 3 步执行失败' });
  assert.deepStrictEqual(
    AutoCore.shouldTerminate({ steps: 2, maxSteps: 15, unfinishedHistory: [0.5], consecutiveFails: 0, aborted: true }),
    { done: false, state: 'aborted', reason: '用户中止' });
});

/* ---------- LLM prompt ---------- */

test('buildLlmMessages：system 固定、user 模板注入全部上下文', () => {
  const m = AutoCore.buildLlmMessages({
    goal: '搜索出招商银行相关的邮件',
    url: 'http://x/inbox', title: '灵犀邮箱 · 收件箱',
    refLabel: '【可交互】 searchbox "搜索邮件"',
    snapshot: SAMPLE_SNAPSHOT, ref: 'e3',
    recentSteps: ['1. goto "http://x/inbox" 成功'],
  });
  assert.strictEqual(m.messages[0].role, 'system');
  assert.match(m.messages[0].content, /只输出文本本身/);
  assert.strictEqual(m.temperature, 0.3);
  assert.strictEqual(m.max_tokens, 200);
  const u = m.messages[1].content;
  assert.match(u, /搜索出招商银行相关的邮件/);
  assert.match(u, /搜索邮件/);
  assert.match(u, /短语|正文/);          // 字段类型启发提示
  assert.match(u, /goto "http:\/\/x\/inbox"/);  // 最近步骤
  /* 上下文 = ref 行 ±10 行：e3 在第 3 行（下标 2）→ 窗口 0..12 行，邮件 2 纳入、邮件 3 排除 */
  assert.match(u, /listitem "邮件 2/);
  assert.doesNotMatch(u, /listitem "邮件 3/);
});

test('extractRefContext：找不到 ref 时回退前 20 行', () => {
  const ctx = AutoCore.extractRefContext(SAMPLE_SNAPSHOT, 'e999');
  assert.ok(ctx.split('\n').length <= 20);
  assert.match(ctx, /generic \[active\]/);
});

/* ---------- sanitizeLlmText ---------- */

test('sanitizeLlmText：剥引号、去禁字符、压空白、截断', () => {
  assert.strictEqual(AutoCore.sanitizeLlmText('"招商银行"\n'), '招商银行');
  assert.strictEqual(AutoCore.sanitizeLlmText('“招商银行”'), '招商银行');
  assert.strictEqual(AutoCore.sanitizeLlmText('  9 月 对账单  '), '9 月 对账单');
  assert.strictEqual(AutoCore.sanitizeLlmText('a"b%c'), 'abc');
  assert.ok(AutoCore.sanitizeLlmText('x'.repeat(800)).length <= 500);
  assert.strictEqual(AutoCore.sanitizeLlmText('第一行\n第二行'), '第一行 第二行');
});

/* ---------- 展示辅助 ---------- */

test('formatHistoryStep：成功/失败两种形态', () => {
  assert.strictEqual(AutoCore.formatHistoryStep(2, 'click【e10 · 归档】', true, null), '2. click【e10 · 归档】成功');
  const err = 'Error: Ref e3 not found in the current page snapshot. Try capturing new snapshot.';
  assert.strictEqual(   // 短错误完整保留（旧版一刀切 80 字符会把末尾句号切掉）
    AutoCore.formatHistoryStep(3, 'fill【e3】', false, err),
    '3. fill【e3】失败：' + err);
});

test('briefError：保留 Playwright 的遮挡根因（会话 r-0926-0046-qrys 的失败形态）', () => {
  /* 根因在日志行尾，前面是长元素标签；按字符截断只会留下「超时」 */
  const raw = [
    'TimeoutError: Timeout 5000ms exceeded.',
    'Call log:',
    "  - waiting for locator('aria-ref=f2e496')",
    '    - locator resolved to <button type="button" class="Button Button--plain">…</button>',
    '  - attempting click action',
    '    - waiting for element to be visible, enabled and stable',
    '    - element is visible, enabled and stable',
    '    - scrolling into view if needed',
    '    - done scrolling',
    '    - <form class="nova-abc123" data-x="' + 'y'.repeat(200) + '">…</form> intercepts pointer events',
  ].join('\n');
  const brief = AutoCore.briefError(raw);
  assert.match(brief, /intercepts pointer events/);
  assert.match(brief, /^TimeoutError: Timeout 5000ms exceeded\./);
  /* ANSI 转义必须清掉，且总体长度有上限 */
  assert.ok(brief.length <= 300, '摘要应有长度上限，实际 ' + brief.length);
});

test('briefError：驱动层已折叠的「首行 | 根因」形态原样识别', () => {
  const brief = AutoCore.briefError('TimeoutError: Timeout 5000ms exceeded. | - <div class="mask">…</div> intercepts pointer events');
  assert.strictEqual(brief, 'TimeoutError: Timeout 5000ms exceeded. ｜ - <div class="mask">…</div> intercepts pointer events');
});

test('briefError：无根因时保留首行，不用「未知错误」兜掉真实原因', () => {
  assert.strictEqual(AutoCore.briefError('Error: Ref e3 not found in the current page snapshot.'), 'Error: Ref e3 not found in the current page snapshot.');
  assert.strictEqual(AutoCore.briefError(''), '未知错误');
  assert.strictEqual(AutoCore.briefError(null), '未知错误');
});

test('isRefParam：按快照真实 ref 表判定，兼容 fN 前缀（会话 r-0926-0046-qrys 的根 bug）', () => {
  /* 切到第二个标签页后 ref 从 e496 变成 f2e496 —— 旧正则 /^e[A-Za-z0-9_-]+$/ 失配，
   * failedRefs 静默失效；改为查快照解析出的 ref 表 */
  const refLabels = { f2e1: '', f2e496: '', f2e730: '' };
  assert.strictEqual(AutoCore.isRefParam('f2e496', refLabels), true, 'fN 前缀 ref 必须被认可');
  assert.strictEqual(AutoCore.isRefParam('e496', refLabels), false, '不在本例快照里的 ref 不应认可');
  assert.strictEqual(AutoCore.isRefParam('其他', refLabels), false, '兜底项「其他」不是 ref');
  assert.strictEqual(AutoCore.isRefParam('', refLabels), false);
  assert.strictEqual(AutoCore.isRefParam(null, refLabels), false);
  assert.strictEqual(AutoCore.isRefParam('f2e1', null), false);
});

test('describeDecision：时间线/历史用的短标签', () => {
  assert.strictEqual(AutoCore.describeDecision({ action: 'click', param: 'e10', text: '无' }, SAMPLE_REFS, VARS), 'click【e10 · 归档】');
  assert.strictEqual(AutoCore.describeDecision({ action: '生成输入', param: 'e3', text: '无' }, SAMPLE_REFS, VARS), '生成输入【e3 · 搜索邮件】');
  assert.strictEqual(AutoCore.describeDecision({ action: '任务已完成', param: null, text: '无' }, SAMPLE_REFS, VARS), '任务已完成');
});

/* ---------- 参数题候选裁剪（ref-funnel 接线） ---------- */

/* resume.html 真实快照：393 个 ref，「参数」题不裁剪会得到 394 个选项 —— 接口硬上限 255 */
const RESUME_SNAPSHOT = require(path.join(ROOT, 'tests', 'fixtures', 'resume-snapshot.js'));
const RESUME_GOAL = '给符合条件的候选人（高级前端 + React 与 TypeScript + 期望薪资不超过 35K）发出面试邀请';
const TRIM = { on: true, limit: 80, maxTranches: 3 };
const refKeys = (criteria) => Object.keys(criteria).filter((k) => /^e\d+$/.test(k));

test('超限时「参数」题被裁剪：选项不超上限、带兜底项、instructions 说明折叠', () => {
  const pc = AutoCore.paramCriteria({ snapshot: RESUME_SNAPSHOT, goal: RESUME_GOAL, paramTrim: TRIM });
  const qs = AutoCore.buildQuestions({ snapshot: RESUME_SNAPSHOT, variables: [], param: pc });

  assert.strictEqual(pc.meta.trimmed, true);
  assert.strictEqual(pc.meta.totalRefs, 393);
  assert.strictEqual(Object.keys(qs['参数'].criteria).length, 81);   // 80 + 其他（「无需元素」已下线）
  assert.ok(qs['参数'].criteria['其他'], '必须有兜底项');
  assert.ok(refKeys(qs['参数'].criteria).indexOf('e172') !== -1, '合格候选人的按钮要在第一批里');
  assert.match(qs['参数'].instructions, /折叠|批/);
  assert.match(qs['参数'].instructions, /其他/);
});

test('未超限时零回归：「参数」题与旧行为逐字节一致，instructions 不提折叠', () => {
  const pc = AutoCore.paramCriteria({ snapshot: SAMPLE_SNAPSHOT, goal: '归档对账单', paramTrim: TRIM });
  const qs = AutoCore.buildQuestions({ snapshot: SAMPLE_SNAPSHOT, variables: [], param: pc });
  assert.strictEqual(pc.meta.trimmed, false);
  assert.strictEqual(JSON.stringify(qs['参数'].criteria), JSON.stringify(AutoCore.refCriteria(SAMPLE_SNAPSHOT)));
  assert.strictEqual(qs['参数'].criteria['其他'], undefined);
  assert.strictEqual(qs['参数'].criteria['无需元素'], undefined);
  assert.ok(!/折叠/.test(qs['参数'].instructions));
});

test('开关关掉时：即使超限也走全量（恢复裁剪功能上线前的行为）', () => {
  const pc = AutoCore.paramCriteria({ snapshot: RESUME_SNAPSHOT, goal: RESUME_GOAL, paramTrim: { on: false, limit: 80, maxTranches: 3 } });
  const qs = AutoCore.buildQuestions({ snapshot: RESUME_SNAPSHOT, variables: [], param: pc });
  assert.strictEqual(pc.meta.trimmed, false);
  assert.strictEqual(pc.meta.enabled, false);
  assert.strictEqual(Object.keys(qs['参数'].criteria).length, 393);
});

test('缺省（没传 paramTrim）时按默认开着处理', () => {
  const pc = AutoCore.paramCriteria({ snapshot: RESUME_SNAPSHOT, goal: RESUME_GOAL });
  assert.strictEqual(pc.meta.trimmed, true);
  assert.strictEqual(pc.meta.limit, 80);
});

test('buildParamFollowUp：只含「参数」一题，instructions 带已定动作与批次', () => {
  const pc2 = AutoCore.paramCriteria({ snapshot: RESUME_SNAPSHOT, goal: RESUME_GOAL, paramTrim: TRIM, batch: 2 });
  const q = AutoCore.buildParamFollowUp({
    paramCriteria: pc2, action: 'click', batch: 2, totalRefs: 393, limit: 80, maxTranches: 3,
  });
  assert.deepStrictEqual(Object.keys(q), ['参数']);
  assert.strictEqual(q['参数'].type, 'choice');
  assert.match(q['参数'].instructions, /click/);
  assert.match(q['参数'].instructions, /第 2 批/);
  assert.match(q['参数'].instructions, /81/);
  assert.ok(q['参数'].criteria['其他'], '第二批之后还有候选，仍要给兜底项');
});

test('buildParamFollowUp：最后一批不附兜底项，并提示在本批内做出选择', () => {
  const pc3 = AutoCore.paramCriteria({ snapshot: RESUME_SNAPSHOT, goal: RESUME_GOAL, paramTrim: TRIM, batch: 3 });
  const q = AutoCore.buildParamFollowUp({ paramCriteria: pc3, action: 'click', batch: 3, totalRefs: 393, limit: 80, maxTranches: 3 });
  assert.strictEqual(q['参数'].criteria['其他'], undefined);
  assert.match(q['参数'].instructions, /最后一批/);
});

test('isRefMore / describeDecision：认得兜底项', () => {
  assert.strictEqual(AutoCore.isRefMore('其他'), true);
  assert.strictEqual(AutoCore.isRefMore('e172'), false);
  assert.strictEqual(AutoCore.isRefMore(null), false);
  assert.match(AutoCore.describeDecision({ action: 'click', param: '其他', text: '无' }, {}, VARS), /展开下一批/);
});

test('normalizeParam：动作不需要元素时参数一律剥掉；需要元素时原样透传', () => {
  /* 「其他」配到不需要元素的动作：归一为空并给说明（不报错、不展开下一批） */
  const noRefMore = AutoCore.normalizeParam({ action: 'press', param: '其他' });
  assert.strictEqual(noRefMore.param, null);
  assert.match(noRefMore.note, /不需要作用于元素/);
  /* 随手选了真实 ref（「无需元素」下线后参数题必答）：静默剥掉，不产生噪音说明 */
  const noRefJunk = AutoCore.normalizeParam({ action: 'goto', param: 'e12' });
  assert.strictEqual(noRefJunk.param, null);
  assert.strictEqual(noRefJunk.note, '');
  /* 答案缺失：同样归一为空 */
  assert.strictEqual(AutoCore.normalizeParam({ action: '无操作', param: null }).param, null);
  /* 需要元素的动作：原样透传，「其他」留给调用方展开下一批 */
  const needRef = AutoCore.normalizeParam({ action: 'click', param: '其他' });
  assert.strictEqual(needRef.param, '其他');
  assert.strictEqual(needRef.note, '');
  const normal = AutoCore.normalizeParam({ action: 'click', param: 'e12' });
  assert.strictEqual(normal.param, 'e12');
  assert.strictEqual(normal.note, '');
});

test('parseParamAnswer：补问只回「参数」一题，不要求「动作」「未完成」', () => {
  assert.strictEqual(AutoCore.parseParamAnswer({ 参数: { type: 'choice', choice: 'e172' } }), 'e172');
  assert.throws(() => AutoCore.parseParamAnswer({}), /参数/);
  assert.throws(() => AutoCore.parseParamAnswer({ 参数: {} }), /参数/);
});

/* ---------- 原生弹窗（modal state）：快照被拒 → 弹窗步 ---------- */

test('isModalSnapshotError：只认 modal state 拒绝，不误伤其它快照失败', () => {
  assert.strictEqual(AutoCore.isModalSnapshotError('Tool "browser_snapshot" does not handle the modal state'), true);
  assert.strictEqual(AutoCore.isModalSnapshotError('Error: page crashed'), false);
  assert.strictEqual(AutoCore.isModalSnapshotError('获取快照超时'), false);
  assert.strictEqual(AutoCore.isModalSnapshotError(''), false);
  assert.strictEqual(AutoCore.isModalSnapshotError(null), false);
});

test('buildDialogQuestions：单道「动作」题，候选只有接受/取消弹窗（描述与 23 候选同源）', () => {
  const qs = AutoCore.buildDialogQuestions();
  assert.deepStrictEqual(Object.keys(qs), ['动作']);
  assert.strictEqual(qs['动作'].type, 'choice');
  assert.deepStrictEqual(Object.keys(qs['动作'].criteria), ['dialog-accept', 'dialog-dismiss']);
  assert.match(qs['动作'].instructions, /对话框|弹窗/);
  assert.strictEqual(qs['动作'].criteria['dialog-accept'], AutoCore.AUTO_TOOLS['dialog-accept']);
  assert.strictEqual(qs['动作'].criteria['dialog-dismiss'], AutoCore.AUTO_TOOLS['dialog-dismiss']);
});

test('DIALOG_SNAPSHOT_NOTE：说明文本里不能混进 ref（弹窗步不该有可点元素候选）', () => {
  assert.ok(!/\[ref=/.test(AutoCore.DIALOG_SNAPSHOT_NOTE));
  assert.match(AutoCore.DIALOG_SNAPSHOT_NOTE, /对话框/);
});

test('planExecution：弹窗决策走 act、无 ref、文本可省（与 driver 白名单 optional 一致）', () => {
  assert.deepStrictEqual(
    AutoCore.planExecution({ action: 'dialog-accept', param: null, text: null }, []),
    { kind: 'act', op: 'dialog-accept', ref: null, text: null });
  assert.deepStrictEqual(
    AutoCore.planExecution({ action: 'dialog-dismiss', param: null, text: '无' }, []),
    { kind: 'act', op: 'dialog-dismiss', ref: null, text: null });
});

test('checkActionRole：弹窗动作不参与角色兼容校验（无元素可言）', () => {
  assert.deepStrictEqual(
    AutoCore.checkActionRole({ action: 'dialog-accept', param: null }, { e10: 'button' }),
    { conflict: false });
});

test('parseActionAnswer 可解析弹窗步答案（形状与动作补问同一族）', () => {
  assert.strictEqual(AutoCore.parseActionAnswer({ 动作: { type: 'choice', choice: 'dialog-accept' } }), 'dialog-accept');
});

/* ---------- select 选项预检：目标选项不在下拉框名单内 → 发命令前拦下 ---------- */

const ORDERS_SNAPSHOT = require(path.join(ROOT, 'tests', 'fixtures', 'orders-snapshot.js'));
const ORDERS = ORDERS_SNAPSHOT.SNAPSHOT || String(ORDERS_SNAPSHOT);

test('selectOptionNames：读到 combobox 子树的全部选项名（真实订单页快照）', () => {
  assert.deepStrictEqual(AutoCore.selectOptionNames(ORDERS, 'e15'),
    ['全部状态', '已付款待发货', '待付款', '已发货', '已签收', '已取消']);
});

test('checkSelectOption：选项存在 → 放行；不存在 → 拦下并给可选清单与纠偏提示', () => {
  assert.deepStrictEqual(AutoCore.checkSelectOption(ORDERS, 'e15', '已付款待发货'), { conflict: false });
  const bad = AutoCore.checkSelectOption(ORDERS, 'e15', '王小明');
  assert.strictEqual(bad.conflict, true);
  assert.match(bad.error, /订单状态/);
  assert.match(bad.error, /王小明/);
  assert.match(bad.error, /已付款待发货/);
  assert.match(bad.error, /fill|搜索框/);
});

test('checkSelectOption：读不到选项名单一律放行（宁可漏报，交回浏览器判定）', () => {
  /* ref 不在快照里 */
  assert.deepStrictEqual(AutoCore.checkSelectOption(ORDERS, 'e999', '随便什么'), { conflict: false });
  /* ref 是按钮（无 option 子节点） */
  const btn = AutoCore.checkSelectOption(SAMPLE_SNAPSHOT, 'e10', '王小明');
  assert.deepStrictEqual(btn, { conflict: false });
  /* 文本两侧空白不影响命中 */
  assert.deepStrictEqual(AutoCore.checkSelectOption(ORDERS, 'e15', ' 已发货 '), { conflict: false });
});

/* ---------- 文本补问：动作落定后才问，候选按动作分型 ----------
 * 结构性修复的锚点：旧 4 题制里「文本」与「动作」同请求作答，模型在「搜索王小明」
 * 与「切换发货状态」两个子目标间摇摆，拼出 select e15 "王小明"（选项不存在）。
 * 现在候选只在动作确定之后构造 —— select 直接给该下拉框的真实选项名，
 * 「在订单状态下拉框选王小明」从候选层面就不可能出现。 */

const ORDERS_VARS = [
  { name: '买家', value: '王小明' },
  { name: '待发货状态', value: '已付款待发货' },
];

test('buildTextFollowUp · select：候选 = 该下拉框的全部真实选项名，变量池不混入', () => {
  const q = AutoCore.buildTextFollowUp({
    action: 'select', param: 'e15', snapshot: ORDERS, variables: ORDERS_VARS,
    refLabel: '【可交互】 combobox "订单状态"',
  });
  assert.deepStrictEqual(Object.keys(q), ['文本']);
  assert.deepStrictEqual(Object.keys(q['文本'].criteria),
    ['全部状态', '已付款待发货', '待付款', '已发货', '已签收', '已取消']);
  /* 变量池里的「王小明」「已付款待发货」绝不作为变量混进 select 候选 ——
   * 两个来源语义不同，混了就又回到旧题的摇摆面 */
  assert.strictEqual(q['文本'].criteria['买家'], undefined);
  assert.match(q['文本'].instructions, /select/);
  assert.match(q['文本'].instructions, /e15/);
  assert.match(q['文本'].instructions, /订单状态/);
  assert.match(q['文本'].instructions, /真实选项|必须从中选择/);
});

test('buildTextFollowUp · select 读不到名单：退回变量池兜底，instructions 说明', () => {
  const q = AutoCore.buildTextFollowUp({
    action: 'select', param: 'e999', snapshot: ORDERS, variables: ORDERS_VARS, refLabel: '',
  });
  assert.deepStrictEqual(Object.keys(q['文本'].criteria), ['买家', '待发货状态']);
  assert.strictEqual(q['文本'].criteria['买家'], '取值：王小明');
  assert.match(q['文本'].instructions, /变量池/);
});

test('buildTextFollowUp · press：变量 ∪ 常用键名，撞名时变量优先', () => {
  const vars = [{ name: 'Enter', value: 'Return' }, { name: '翻页键', value: 'PageDown' }];
  const q = AutoCore.buildTextFollowUp({
    action: 'press', param: null, snapshot: '', variables: vars, refLabel: '',
  });
  const keys = Object.keys(q['文本'].criteria);
  assert.ok(keys.includes('Enter') && keys.includes('Escape') && keys.includes('PageDown'));
  assert.ok(AutoCore.COMMON_KEY_NAMES.every((k) => keys.includes(k)), '常用键名全部在候选');
  assert.strictEqual(keys.filter((k) => AutoCore.COMMON_KEY_NAMES.includes(k)).length,
    AutoCore.COMMON_KEY_NAMES.length, 'Enter 撞名只出现一次（变量版，键名版让位）');
  assert.strictEqual(q['文本'].criteria['Enter'], '取值：Return', '撞名时变量优先（用户显式意图）');
  assert.strictEqual(q['文本'].criteria['翻页键'], '取值：PageDown');
  assert.strictEqual(q['文本'].criteria['Escape'].startsWith('键名：'), true);
});

test('buildTextFollowUp · tab-select：候选 = 真实标签页序号（工程自动注入），变量池不混入', () => {
  /* 实测事故：候选来自变量池，模型选了「关键词」→ 拼出 tab-select "jev"，
   * 被 driver 硬校验拦下（文本必须是非负整数）。序号只能由工程侧注入。 */
  const q = AutoCore.buildTextFollowUp({
    action: 'tab-select', param: null, snapshot: '', variables: ORDERS_VARS, refLabel: '',
    tabs: [
      { index: 0, current: false, title: '百度一下，你就知道', url: 'https://www.baidu.com/' },
      { index: 1, current: true, title: 'jev_百度搜索', url: 'https://www.baidu.com/s?wd=jev' },
    ],
  });
  assert.deepStrictEqual(Object.keys(q['文本'].criteria), ['0', '1'], '候选只有真实 Tab 序号');
  assert.match(q['文本'].criteria['1'], /【当前】/);
  assert.match(q['文本'].criteria['1'], /jev_百度搜索/);
  assert.strictEqual(q['文本'].criteria['买家'], undefined, '变量池绝不混入：tab-select 只认序号');
  assert.match(q['文本'].instructions, /tab-select/);
  assert.match(q['文本'].instructions, /序号/);
  assert.match(q['文本'].instructions, /必须从中选择/);
});

test('buildTextFollowUp · tab-select：读不到标签页列表 → null（宁记失败步也不让变量池瞎猜）', () => {
  assert.strictEqual(AutoCore.buildTextFollowUp({
    action: 'tab-select', param: null, snapshot: '', variables: ORDERS_VARS, refLabel: '', tabs: [],
  }), null);
  assert.strictEqual(AutoCore.buildTextFollowUp({
    action: 'tab-select', param: null, snapshot: '', variables: ORDERS_VARS, refLabel: '',
  }), null);
});

test('buildTextFollowUp · tab-close：候选 = 序号 + 「无」（缺省关当前 Tab），不再给变量池', () => {
  const q = AutoCore.buildTextFollowUp({
    action: 'tab-close', param: null, snapshot: '', variables: ORDERS_VARS, refLabel: '',
    tabs: [{ index: 0, current: true, title: 'A', url: 'http://a' }, { index: 1, current: false, title: 'B', url: 'http://b' }],
  });
  assert.deepStrictEqual(Object.keys(q['文本'].criteria), ['0', '1', '无']);
  assert.strictEqual(q['文本'].criteria['买家'], undefined);
  assert.match(q['文本'].instructions, /关闭当前 Tab/);
});

test('buildTextFollowUp · fill：候选 = 变量池，instructions 带已定动作与目标元素', () => {
  const q = AutoCore.buildTextFollowUp({
    action: 'fill', param: 'e14', snapshot: ORDERS, variables: ORDERS_VARS,
    refLabel: '【可交互】 searchbox "搜索订单号 / 买家昵称 / 收件人手机号"',
  });
  assert.deepStrictEqual(Object.keys(q['文本'].criteria), ['买家', '待发货状态']);
  assert.strictEqual(q['文本'].criteria['买家'], '取值：王小明');
  assert.match(q['文本'].instructions, /fill/);
  assert.match(q['文本'].instructions, /e14/);
  assert.match(q['文本'].instructions, /搜索订单号/);
  assert.strictEqual(q['文本'].criteria['无'], undefined, 'fill 必填文本，不给「无」');
});

test('buildTextFollowUp · 可选文本动作附「无」，必填动作不附', () => {
  const opt = AutoCore.buildTextFollowUp({
    action: 'tab-close', param: null, snapshot: '', variables: ORDERS_VARS, refLabel: '',
    tabs: [{ index: 0, current: true, title: 'A', url: 'http://a' }],
  });
  assert.strictEqual(opt['文本'].criteria['无'], '本动作不需要输入文本');
  const req = AutoCore.buildTextFollowUp({
    action: 'fill', param: 'e14', snapshot: ORDERS, variables: ORDERS_VARS, refLabel: '',
  });
  assert.strictEqual(req['文本'].criteria['无'], undefined);
});

test('buildTextFollowUp · 零候选与无需文本：返回 null（builder 不抛错，调用方记失败步）', () => {
  /* 必填动作 + 空变量池 → 无从问起 */
  assert.strictEqual(AutoCore.buildTextFollowUp({
    action: 'fill', param: 'e3', snapshot: SAMPLE_SNAPSHOT, variables: [], refLabel: '',
  }), null);
  /* select + 读不到名单 + 空变量池 → 同上 */
  assert.strictEqual(AutoCore.buildTextFollowUp({
    action: 'select', param: 'e999', snapshot: ORDERS, variables: [], refLabel: '',
  }), null);
  /* 可选动作只剩「无」一项 → 没有可问的，也不问 */
  assert.strictEqual(AutoCore.buildTextFollowUp({
    action: 'tab-close', param: null, snapshot: '', variables: [], refLabel: '',
  }), null);
  /* 不需要文本的动作 → null（主循环用它当门闩） */
  assert.strictEqual(AutoCore.buildTextFollowUp({
    action: 'click', param: 'e10', snapshot: SAMPLE_SNAPSHOT, variables: ORDERS_VARS, refLabel: '',
  }), null);
  assert.strictEqual(AutoCore.buildTextFollowUp({ action: '任务已完成', param: null, snapshot: '', variables: [], refLabel: '' }), null);
});

test('parseTextAnswer：取「文本」选项；缺失抛错', () => {
  assert.strictEqual(AutoCore.parseTextAnswer({ 文本: { type: 'choice', choice: '已付款待发货' } }), '已付款待发货');
  assert.strictEqual(AutoCore.parseTextAnswer({ 文本: { type: 'choice', choice: '无' } }), '无');
  assert.throws(() => AutoCore.parseTextAnswer({}), /文本/);
  assert.throws(() => AutoCore.parseTextAnswer({ 文本: {} }), /文本/);
});

test('文本补问 → 执行规划衔接：选项名 / 键名不在变量池时按字面值直传', () => {
  /* select 补问选中的选项名（非变量） → resolveText 字面值兜底 → 命令文本即选项名 */
  assert.deepStrictEqual(
    AutoCore.planExecution({ action: 'select', param: 'e15', text: '已付款待发货' }, ORDERS_VARS),
    { kind: 'act', op: 'select', ref: 'e15', text: '已付款待发货' });
  /* press 补问选中的纯键名（非变量） → 字面值直传 */
  assert.deepStrictEqual(
    AutoCore.planExecution({ action: 'press', param: null, text: 'PageDown' }, []),
    { kind: 'act', op: 'press', ref: null, text: 'PageDown' });
  /* tab-select 补问选中的序号（字符串）→ 原样直传（driver 侧仍做非负整数硬校验） */
  assert.deepStrictEqual(
    AutoCore.planExecution({ action: 'tab-select', param: null, text: '1' }, []),
    { kind: 'act', op: 'tab-select', ref: null, text: '1' });
  /* 变量名被选中 → 取变量的值 */
  assert.deepStrictEqual(
    AutoCore.planExecution({ action: 'fill', param: 'e14', text: '买家' }, ORDERS_VARS),
    { kind: 'act', op: 'fill', ref: 'e14', text: '王小明' });
  /* 可选动作选「无」→ 无参形态合法 */
  assert.deepStrictEqual(
    AutoCore.planExecution({ action: 'tab-close', param: null, text: '无' }, []),
    { kind: 'act', op: 'tab-close', ref: null, text: null });
});

/* ===================== actionsOf / buildRunRecord / newRunId ===================== */

test('actionsOf：首轮 + 三类补问 + LLM 的顺序、标题与字段归一', () => {
  const step = {
    n: 4, payload: { state: {}, model: 'jev-latest', questions: { 动作: {}, 参数: {}, 未完成: {} } },
    response: { answers: {} },
    followUps: [
      { kind: 'param', batch: 2, payload: { questions: { 参数: {} } }, response: { answers: {} }, param: 'e14' },
      { kind: 'action', payload: { questions: { 动作: {} } }, response: null, error: null, action: null, from: 'select', role: 'button', ref: 'e31' },
      { kind: 'text', payload: { questions: { 文本: {} } }, response: { answers: {} }, text: '招商银行', forAction: 'fill' },
    ],
    llm: { messages: [{ role: 'user', content: 'p' }], raw: { choices: [] }, text: '招商银行', error: null },
  };
  const acts = AutoCore.actionsOf(step);
  assert.strictEqual(acts.length, 5);
  assert.deepStrictEqual(
    acts.map((a) => a.kind),
    ['main', 'param', 'action', 'text', 'llm']
  );
  assert.strictEqual(acts[0].title, 'Jev 首轮 · 3 题');
  /* 补问标题与首轮同形状：种类 · 题数 · 上下文（补问恒为 1 题） */
  assert.strictEqual(acts[1].title, '参数补问 · 1 题 · 第 2 批');
  assert.strictEqual(acts[2].title, '动作补问 · 1 题 · 「select」与角色 button 冲突');
  assert.strictEqual(acts[2].from, 'select');
  assert.strictEqual(acts[3].title, '文本补问 · 1 题 · fill');
  assert.strictEqual(acts[3].forAction, 'fill');
  assert.strictEqual(acts[4].title, 'LLM 生成输入');
  assert.strictEqual(acts[4].text, '招商银行');
  assert.strictEqual(acts[4].payload, null);          // LLM 的输入在 messages，不在 payload
  /* 空输入 / 无任何模型调用的步骤 → 空流水（不是异常） */
  assert.deepStrictEqual(AutoCore.actionsOf(null), []);
  assert.deepStrictEqual(AutoCore.actionsOf({}), []);
});

test('actionsOf：弹窗步 1 题标题；序列化形状（request 字段）同样可读', () => {
  const dialogStep = {
    payload: { state: {}, questions: { 动作: { type: 'choice', criteria: { 'dialog-accept': '' } } } },
    response: { answers: {} },
  };
  assert.strictEqual(AutoCore.actionsOf(dialogStep)[0].title, 'Jev 弹窗步 · 1 题');

  /* 落盘记录的字段名是 request；actionsOf 必须两头兼容（live: payload / 落盘: request） */
  const diskStep = {
    request: { state: {}, questions: { 动作: {}, 参数: {}, 未完成: {} } },
    response: { answers: {} },
    followUps: [{ kind: 'param', batch: 2, request: { questions: { 参数: {} } }, response: { answers: {} }, param: 'e9' }],
    llm: { messages: [], response: { choices: [] }, text: 'x' },
  };
  const acts = AutoCore.actionsOf(diskStep);
  assert.strictEqual(acts.length, 3);
  assert.strictEqual(acts[0].payload, diskStep.request);
  assert.strictEqual(acts[1].payload, diskStep.followUps[0].request);
  assert.strictEqual(acts[2].response, diskStep.llm.response);
});

test('actionStatus：落定=ok、出错=error、在途=pending', () => {
  assert.strictEqual(AutoCore.actionStatus({ kind: 'main', response: {} }), 'ok');
  assert.strictEqual(AutoCore.actionStatus({ kind: 'main', response: null, error: null }), 'pending');
  assert.strictEqual(AutoCore.actionStatus({ kind: 'param', param: 'e9' }), 'ok');
  assert.strictEqual(AutoCore.actionStatus({ kind: 'action', action: 'click' }), 'ok');
  assert.strictEqual(AutoCore.actionStatus({ kind: 'text', text: 'x' }), 'ok');
  assert.strictEqual(AutoCore.actionStatus({ kind: 'param', error: 'x' }), 'error');
  assert.strictEqual(AutoCore.actionStatus({ kind: 'llm', text: '招商银行' }), 'ok');
  assert.strictEqual(AutoCore.actionStatus({ kind: 'llm', error: 'no cfg' }), 'error');
  /* main 行动带 jevError（经 actionsOf 映射到 error）→ error */
  const failed = AutoCore.actionsOf({ payload: { questions: {} }, response: null, jevError: 'boom' })[0];
  assert.strictEqual(failed.error, 'boom');
  assert.strictEqual(AutoCore.actionStatus(failed), 'error');
});

test('newRunId：形状 r-MMDD-HHmm-xxxx，与 server 端 RUN_ID_RE 一致', () => {
  const id = AutoCore.newRunId(new Date(2026, 8, 25, 19, 12));
  assert.match(id, /^r-[0-9]{4}-[0-9]{4}-[a-z0-9]{4}$/);
  assert.ok(id.startsWith('r-0925-1912-'));
});

test('buildRunRecord：meta 汇总正确、steps 序列化含 request/followUps/anno', () => {
  const runCfg = {
    goal: 'g', url: 'http://x/', variables: [{ name: 'k', value: 'v' }], maxSteps: 15,
    screenshotOn: true, browser: 'chrome', browserUsed: 'chrome', window: { windowMode: 'max' },
    paramTrim: { on: true },
  };
  const steps = [
    { n: 1, label: 'l1', pageInfo: { url: 'u', title: 't' }, snapshot: 'S', refLabels: { e1: 'x' },
      decision: { action: 'click', param: 'e1' }, payload: { state: {}, questions: {} }, response: { answers: {} },
      exec: { ok: true, cmd: 'playwright-cli click e1', elapsedMs: 5 }, anno: null, screenshot: 'data:image/png;base64,AAA',
      historyLine: '1. l1', trim: null, trimNote: null, followUps: [] },
    { n: 2, label: 'l2', pageInfo: { url: 'u', title: 't' }, snapshot: '', refLabels: {},
      decision: { action: '生成输入', param: 'e2' }, payload: { state: {}, questions: {} }, response: { answers: {} },
      exec: { ok: true }, anno: null, screenshot: null, historyLine: '2. l2', trim: null, trimNote: null,
      followUps: [{ kind: 'param', batch: 2, payload: { questions: {} }, response: { answers: {} }, param: 'e9' }],
      llm: { messages: [{ role: 'user', content: 'p' }], raw: { id: 'x' }, text: 'v', error: null } },
    /* 终结步：exec 为 null、terminal 是动作名 —— 不序列化的话回放会把「已完成」渲染成进行中 */
    { n: 3, label: '任务已完成', pageInfo: { url: 'u', title: 't' }, snapshot: '', refLabels: {},
      decision: { action: '任务已完成', param: '无需元素' }, payload: { state: {}, questions: {} }, response: { answers: {} },
      exec: null, terminal: '任务已完成', anno: null, screenshot: null, historyLine: '3. 任务已完成',
      trim: null, trimNote: null, followUps: [] },
  ];
  const rec = AutoCore.buildRunRecord({
    id: 'r-0925-1912-ab12', runCfg, jevModel: 'jev-latest', llmModel: 'm-llm',
    startedAt: '2026-09-25T11:12:00.000Z', endState: 'done', endReason: 'Jev 判定：任务已完成', steps,
  });
  assert.strictEqual(rec.meta.id, 'r-0925-1912-ab12');
  assert.strictEqual(rec.meta.stepCount, 3);
  assert.strictEqual(rec.meta.jevCalls, 4);   /* 3 次首轮 + 1 次参数补问 */
  assert.strictEqual(rec.meta.llmCalls, 1);
  assert.strictEqual(rec.meta.endState, 'done');
  /* 模式与 CDP 端点要落盘：一次 http 形态端点的失败排查全靠它（记录里没有就只能靠猜） */
  assert.strictEqual(rec.meta.mode, 'isolated', 'runCfg 没写 mode 时按默认的独立实例记');
  assert.strictEqual(rec.meta.cdp, null);
  const cdpRec = AutoCore.buildRunRecord({ id: 'r-x', runCfg: Object.assign({}, runCfg, { mode: 'cdp', cdp: 'ws://127.0.0.1:9222/devtools/browser/abc' }), jevModel: 'j', llmModel: null, startedAt: 't' });
  assert.strictEqual(cdpRec.meta.mode, 'cdp');
  assert.strictEqual(cdpRec.meta.cdp, 'ws://127.0.0.1:9222/devtools/browser/abc');
  assert.strictEqual(rec.steps[1].request.state, steps[1].payload.state);   /* payload → request */
  assert.strictEqual(rec.steps[1].llm.response, steps[1].llm.raw);
  assert.strictEqual(rec.steps[1].followUps[0].request, steps[1].followUps[0].payload);
  assert.strictEqual(rec.steps[2].terminal, '任务已完成');   /* 终结步动作名必须随记录落盘 */
  /* 空 steps + 未传 endState → running / 0（进行中快照） */
  const empty = AutoCore.buildRunRecord({ id: 'r-0925-1912-ab12', runCfg, jevModel: 'j', llmModel: 'l', startedAt: 't' });
  assert.strictEqual(empty.meta.endState, 'running');
  assert.strictEqual(empty.meta.stepCount, 0);
});

/* ---------- 耗时视图（spec 2026-09-28 §4 §5） ---------- */

/* live 形状：payload + response + followUps + llm.raw + ms/jevMs 由埋点写入 */
const LIVE_STEP = {
  n: 5, ms: 9950, jevMs: 3200,
  payload: { questions: { 动作: {}, 参数: {}, 未完成: {} } },
  response: { answers: {} },
  followUps: [{ kind: 'text', request: { questions: { 文本: {} } }, response: {}, ms: 3300, forAction: 'fill' }],
  llm: { messages: [], raw: {}, text: '王小明', ms: 1200 },
  exec: { ok: true, cmd: 'playwright-cli fill e14 "王小明"', elapsedMs: 1386 },
};

test('durationView：live 步骤 —— 两个耗时、Jev 合计（首轮 + 全部补问，不含生成输入）', () => {
  const d = AutoCore.durationView(LIVE_STEP);
  assert.equal(d.stepMs, 9950);
  assert.equal(d.jevMs, 6500);          /* 3200 + 3300，llm 的 1200 不算 */
  assert.equal(d.jevCalls, 2);
  assert.equal(d.jevMeasured, 2);
  assert.equal(d.llmMs, 1200);
  assert.equal(d.actMs, 1386);
  assert.equal(d.jevPct, 65);           /* 6500 / 9950 */
  assert.equal(d.otherMs, 864);         /* 9950 - 6500 - 1386 - 1200（四段：其它已扣除生成输入） */
});

test('durationView：落盘形状（request/response/llm.response）与 live 同解', () => {
  const rec = {
    n: 5, ms: 9950, jevMs: 3200,
    request: { questions: { 动作: {} } }, response: { answers: {} },
    followUps: [{ kind: 'text', request: { questions: { 文本: {} } }, response: {}, ms: 3300 }],
    llm: { messages: [], response: {}, text: '王小明', ms: 1200 },
    exec: { ok: true, elapsedMs: 1386 },
  };
  assert.deepEqual(AutoCore.durationView(rec), AutoCore.durationView(LIVE_STEP));
});

test('durationView：老记录（无 ms 字段）→ null，绝不 NaN、绝不 0', () => {
  const old = {
    n: 1, request: { questions: { 动作: {}, 参数: {}, 未完成: {} } }, response: {},
    followUps: [], exec: { ok: true, elapsedMs: 1609 },
  };
  const d = AutoCore.durationView(old);
  assert.equal(d.stepMs, null);
  assert.equal(d.jevMs, null);
  assert.equal(d.jevCalls, 1);          /* 调用次数仍可数出来 */
  assert.equal(d.jevMeasured, 0);
  assert.equal(d.jevPct, null);
  assert.equal(d.otherMs, null);
  assert.equal(d.actMs, 1609);          /* 动作耗时老记录本来就有 */
});

test('durationView：部分补问缺 ms —— jevMs 只累加测到的，jevMeasured 如实报数', () => {
  const half = {
    n: 3, ms: 8000, jevMs: 3000,
    payload: { questions: { 动作: {} } }, response: {},
    followUps: [{ kind: 'text', request: { questions: { 文本: {} } }, response: {} }],
  };
  const d = AutoCore.durationView(half);
  assert.equal(d.jevMs, 3000);
  assert.equal(d.jevCalls, 2);
  assert.equal(d.jevMeasured, 1);
});

test('durationView：时钟回拨导致负值 → 钳 0 且带 skew 说明', () => {
  const d = AutoCore.durationView({ n: 1, ms: -50, jevMs: 100, payload: { questions: { 动作: {} } }, response: {} });
  assert.equal(d.stepMs, 0);
  assert.match(d.skew, /计时为负/);
});

test('formatMs：毫秒/秒/空值', () => {
  assert.equal(AutoCore.formatMs(820), '820ms');
  assert.equal(AutoCore.formatMs(9950), '9.9s');
  assert.equal(AutoCore.formatMs(63900), '63.9s');
  assert.equal(AutoCore.formatMs(0), '0ms');
  assert.equal(AutoCore.formatMs(null), '—');
  assert.equal(AutoCore.formatMs(undefined), '—');
  assert.equal(AutoCore.formatMs(NaN), '—');
});

test('stepDurationLine：副行文案 —— 正常 / 老记录 / 无调用 / 跑动中', () => {
  assert.equal(AutoCore.stepDurationLine(LIVE_STEP), 'Jev 6.5s · 2 次调用 · 占 65%');
  assert.equal(AutoCore.stepDurationLine({ n: 1, request: { questions: { 动作: {} } }, response: {} }),
    '该记录无耗时数据');
  assert.equal(AutoCore.stepDurationLine({ n: 1 }), '');
  /* 跑动中：Jev 还没返回，此时说「该记录无耗时数据」是错的（记录正在写）*/
  assert.equal(AutoCore.stepDurationLine({ n: 2, payload: { questions: { 动作: {} } } }, { live: true }), 'Jev 计时中…');
  assert.equal(AutoCore.stepDurationLine(LIVE_STEP, { live: true }), 'Jev 6.5s · 2 次调用 · 占 65%');
});

test('actionsOf：把 ms 透出到每个行动（主调用 / 补问 / 生成输入）', () => {
  const acts = AutoCore.actionsOf(LIVE_STEP);
  assert.deepEqual(acts.map((a) => a.ms), [3200, 3300, 1200]);
});

test('stepDurationLine：部分补问缺 ms 时说明测到几次', () => {
  const half = {
    n: 3, ms: 8000, jevMs: 3000,
    payload: { questions: { 动作: {} } }, response: {},
    followUps: [{ kind: 'text', request: { questions: { 文本: {} } }, response: {} }],
  };
  assert.equal(AutoCore.stepDurationLine(half), 'Jev 3.0s · 2 次调用（1 次未计时） · 占 38%');
});
