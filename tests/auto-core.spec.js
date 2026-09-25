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
});

test('buildState：首步无上一步结果时给出占位说明', () => {
  const st = AutoCore.buildState({ goal: 'g', url: 'u', title: 't', history: [], lastResult: '', snapshot: 's' });
  assert.match(st['上一步结果'], /第一步|尚无/);
});

/* ---------- buildQuestions ---------- */

test('buildQuestions：固定 4 道，动作 29+2、参数来自快照、文本来自变量池、未完成 5 级', () => {
  const qs = AutoCore.buildQuestions({
    snapshot: SAMPLE_SNAPSHOT,
    variables: [{ name: '关键词', value: '招商银行' }, { name: '回车', value: 'Enter' }],
  });
  assert.deepStrictEqual(Object.keys(qs), ['动作', '参数', '文本', '未完成']);

  const tools = qs['动作'].criteria;
  assert.strictEqual(Object.keys(tools).length, 31);   // 27 浏览器操作 + 2 工程 + 2 终止
  ['click', 'fill', 'goto', 'tab-list', 'dialog-accept', '生成输入', '无操作', '任务已完成', '放弃']
    .forEach((k) => assert.ok(tools[k], '动作缺少 ' + k));
  assert.ok(tools['生成输入'].includes('生成'));
  assert.ok(!('snapshot' in tools) && !('eval' in tools) && !('cookie-set' in tools));

  const params = qs['参数'].criteria;
  assert.ok(params.e10.includes('【可交互】'));
  assert.ok(params.e10.includes('归档'));
  assert.strictEqual(params['无需元素'].length > 0, true);

  const texts = qs['文本'].criteria;
  assert.strictEqual(texts['关键词'], '取值：招商银行');
  assert.strictEqual(texts['回车'], '取值：Enter');
  assert.ok(texts['无']);

  assert.strictEqual(qs['未完成'].type, 'score');
  assert.strictEqual(qs['未完成'].criteria.length, 5);
  [qs['动作'], qs['参数'], qs['文本']].forEach((q) => assert.strictEqual(q.type, 'choice'));
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

test('文本题 instructions：不再列举 select（避免二次抬高它的显著性）', () => {
  const qs = AutoCore.buildQuestions({ snapshot: SAMPLE_SNAPSHOT, variables: [] });
  assert.ok(!qs['文本'].instructions.includes('select'),
    '「文本」题的举例里出现 select 会让它在动作题里更显眼');
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

test('checkActionRole：放行 fill / 未知角色 / 无需元素（宁可漏报，不误报白问一次）', () => {
  const roles = { e10: 'button' };
  assert.strictEqual(AutoCore.checkActionRole({ action: 'fill', param: 'e10' }, roles).conflict, false);
  assert.strictEqual(AutoCore.checkActionRole({ action: 'type', param: 'e10' }, roles).conflict, false);
  assert.strictEqual(AutoCore.checkActionRole({ action: '生成输入', param: 'e10' }, roles).conflict, false);
  assert.strictEqual(AutoCore.checkActionRole({ action: 'select', param: 'e99' }, roles).conflict, false);
  assert.strictEqual(AutoCore.checkActionRole({ action: 'select', param: '无需元素' }, roles).conflict, false);
  assert.strictEqual(AutoCore.checkActionRole({ action: '任务已完成', param: '无需元素' }, roles).conflict, false);
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

test('parseDecision：choice 三道 + score 归一化到 0~1', () => {
  const d = AutoCore.parseDecision({
    动作: { type: 'choice', choice: 'fill', probabilities: { fill: 0.8 } },
    参数: { type: 'choice', choice: 'e3', probabilities: { e3: 0.7 } },
    文本: { type: 'choice', choice: '关键词', probabilities: { 关键词: 0.9 } },
    未完成: { type: 'score', score: 3, probabilities: {} },
  });
  assert.strictEqual(d.action, 'fill');
  assert.strictEqual(d.param, 'e3');
  assert.strictEqual(d.text, '关键词');
  assert.strictEqual(d.unfinished, 0.75);
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
  assert.throws(() => AutoCore.parseDecision(Object.assign({}, ok, { 未完成: { score: 5 } })), /未完成/);   // 超出 0~4
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
    AutoCore.planExecution({ action: 'goto', param: '无需元素', text: '关键词' }, VARS),
    { kind: 'act', op: 'goto', ref: null, text: '招商银行' });
  assert.deepStrictEqual(
    AutoCore.planExecution({ action: 'press', param: '无需元素', text: '回车' }, VARS),
    { kind: 'act', op: 'press', ref: null, text: 'Enter' });
});

test('planExecution：工程动作与终止动作', () => {
  assert.deepStrictEqual(AutoCore.planExecution({ action: '无操作', param: '无需元素', text: '无' }, VARS), { kind: 'noop' });
  assert.deepStrictEqual(AutoCore.planExecution({ action: '生成输入', param: 'e3', text: '无' }, VARS), { kind: 'llm', ref: 'e3' });
  assert.deepStrictEqual(AutoCore.planExecution({ action: '任务已完成', param: '无需元素', text: '无' }, VARS), { kind: 'terminal', action: '任务已完成' });
});

test('planExecution：可选文本动作（tab-close/tab-new/dialog-accept）选「无」是合法无参形态', () => {
  assert.deepStrictEqual(AutoCore.planExecution({ action: 'dialog-accept', param: '无需元素', text: '无' }, VARS), { kind: 'act', op: 'dialog-accept', ref: null, text: null });
  assert.deepStrictEqual(AutoCore.planExecution({ action: 'tab-close', param: '无需元素', text: '无' }, VARS), { kind: 'act', op: 'tab-close', ref: null, text: null });
  assert.deepStrictEqual(AutoCore.planExecution({ action: 'tab-new', param: '无需元素', text: '无' }, VARS), { kind: 'act', op: 'tab-new', ref: null, text: null });
  /* 带文本同样合法 */
  assert.deepStrictEqual(AutoCore.planExecution({ action: 'dialog-accept', param: '无需元素', text: '好的' }, VARS), { kind: 'act', op: 'dialog-accept', ref: null, text: '好的' });
});

test('planExecution：矛盾决策抛错（需 ref 却选无需元素 / 需文本却选无）', () => {
  assert.throws(() => AutoCore.planExecution({ action: 'click', param: '无需元素', text: '无' }, VARS), /无需元素/);
  assert.throws(() => AutoCore.planExecution({ action: 'fill', param: 'e3', text: '无' }, VARS), /文本/);
  assert.throws(() => AutoCore.planExecution({ action: '生成输入', param: '无需元素', text: '无' }, VARS), /无需元素/);
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
  assert.strictEqual(   // 错误摘要截断到 80 字符（原文 81 字符，末尾句号被截掉）
    AutoCore.formatHistoryStep(3, 'fill【e3】', false, err),
    '3. fill【e3】失败：' + err.slice(0, 80));
});

test('describeDecision：时间线/历史用的短标签', () => {
  assert.strictEqual(AutoCore.describeDecision({ action: 'click', param: 'e10', text: '无' }, SAMPLE_REFS, VARS), 'click【e10 · 归档】');
  assert.strictEqual(AutoCore.describeDecision({ action: '生成输入', param: 'e3', text: '无' }, SAMPLE_REFS, VARS), '生成输入【e3 · 搜索邮件】');
  assert.strictEqual(AutoCore.describeDecision({ action: '任务已完成', param: '无需元素', text: '无' }, SAMPLE_REFS, VARS), '任务已完成');
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
  assert.strictEqual(Object.keys(qs['参数'].criteria).length, 82);   // 80 + 无需元素 + 其他
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
  assert.ok(!/折叠/.test(qs['参数'].instructions));
});

test('开关关掉时：即使超限也走全量（恢复裁剪功能上线前的行为）', () => {
  const pc = AutoCore.paramCriteria({ snapshot: RESUME_SNAPSHOT, goal: RESUME_GOAL, paramTrim: { on: false, limit: 80, maxTranches: 3 } });
  const qs = AutoCore.buildQuestions({ snapshot: RESUME_SNAPSHOT, variables: [], param: pc });
  assert.strictEqual(pc.meta.trimmed, false);
  assert.strictEqual(pc.meta.enabled, false);
  assert.strictEqual(Object.keys(qs['参数'].criteria).length, 394);
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
  assert.strictEqual(AutoCore.isRefMore('无需元素'), false);
  assert.match(AutoCore.describeDecision({ action: 'click', param: '其他', text: '无' }, {}, VARS), /展开下一批/);
});

test('normalizeParam：动作不需要元素时，「其他」归一为「无需元素」并给出说明', () => {
  const noRef = AutoCore.normalizeParam({ action: 'press', param: '其他' });
  assert.strictEqual(noRef.param, '无需元素');
  assert.match(noRef.note, /不需要元素/);
  const needRef = AutoCore.normalizeParam({ action: 'click', param: '其他' });
  assert.strictEqual(needRef.param, '其他');
  assert.strictEqual(needRef.note, '');
  const normal = AutoCore.normalizeParam({ action: 'click', param: 'e12' });
  assert.strictEqual(normal.param, 'e12');
  assert.strictEqual(normal.note, '');
});

test('parseParamAnswer：补问只回「参数」一题，不要求「动作」「未完成」', () => {
  assert.strictEqual(AutoCore.parseParamAnswer({ 参数: { type: 'choice', choice: 'e172' } }), 'e172');
  assert.strictEqual(AutoCore.parseParamAnswer({ 参数: { type: 'choice', choice: '无需元素' } }), '无需元素');
  assert.throws(() => AutoCore.parseParamAnswer({}), /参数/);
  assert.throws(() => AutoCore.parseParamAnswer({ 参数: {} }), /参数/);
});
