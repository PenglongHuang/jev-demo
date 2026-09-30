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
  assert.strictEqual(Object.keys(tools).length, 21);   // 19 浏览器操作 + 1 工程 + 1 终止
  ['click', 'fill', 'goto', 'tab-list', 'dialog-accept', '生成输入', '任务已完成']
    .forEach((k) => assert.ok(tools[k], '动作缺少 ' + k));
  /* 「放弃」已下线：它是模型随时可选的免死金牌，「当前页面做不到」多半只是这一步没选对 */
  assert.ok(!tools['放弃'], '动作不应再有「放弃」');
  /* 裁掉的 8 个不得回潮 */
  ['dblclick', 'drop', 'keydown', 'keyup', 'mousemove', 'mousedown', 'mouseup', 'mousewheel']
    .forEach((k) => assert.ok(!tools[k], '动作不应再有 ' + k));
  /* 「无操作」已下线：它是「等待页面自身变化」的合法空转出口，实测导致模型
   * fill 完聊天框连选 3 步等回复（会话 r-0928-1530-r1uy）。不许以任何名字回潮。 */
  ['无操作', '等待', 'noop'].forEach((k) => assert.ok(!tools[k], '空转动作不得回潮：' + k));
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

test('动作题 instructions：滚动指到 press + 键名补问；无空转选项，fill 之后要提交', () => {
  const qs = AutoCore.buildQuestions({ snapshot: SAMPLE_SNAPSHOT, variables: [] });
  const acts = qs['动作'].instructions;
  assert.match(acts, /press/);
  assert.match(acts, /PageDown/);
  assert.ok(!/无操作/.test(acts), '「无操作」已下线，instructions 里不得再出现');
  /* fill 不提交是这次事故的根因，instructions 必须把后续动作写死 */
  assert.match(acts, /fill[^。]*不提交|只写入/);
  assert.match(acts, /click|press/);
});

test('动作词表：fill 描述写明「清空 + 整体替换」与「只写入、不提交」', () => {
  const f = AutoCore.AUTO_TOOLS.fill;
  assert.match(f, /清空/, 'fill 的清空语义必须写死（否则被当成 type 的追加语义）');
  assert.match(f, /替换|不是追加/, 'fill 是整体替换');
  assert.match(f, /不提交|不会有任何变化/, 'fill 只写值，必须写明页面不会自己变化');
  assert.match(f, /click|press/, 'fill 描述里要直接指出后续的提交动作');
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

/* ---------- 停滞检测：重复动作 / 快照连续未变的反馈 ----------
 * 事故链条（会话 r-0928-1530-r1uy）：fill 聊天框 → 连选 3 步「无操作」等回复。
 * 现在的对策是**反馈**（state.停滞提示），不是终止 —— 同一动作连做 N 次本身可能合理
 * （连续翻页、连点「下一页」），据此终止会误杀正常任务。 */

const stepOf = (action, param, text, snapshot) => ({ decision: { action, param, text }, snapshot });

test('detectStall：首步或页面有变化时不给提示', () => {
  assert.strictEqual(AutoCore.detectStall([], 'a', VARS).notice, null);
  assert.strictEqual(AutoCore.detectStall(null, 'a', VARS).notice, null);
  const one = [stepOf('click', 'e10', null, 'a')];
  assert.strictEqual(AutoCore.detectStall(one, 'b', VARS).notice, null, '快照变了就该闭嘴');
  /* 单题补问/解析失败的步没有 decision —— 不能被算进连续计数 */
  const noDecision = [{ snapshot: 'a' }, stepOf('click', 'e10', null, 'a')];
  assert.strictEqual(AutoCore.detectStall(noDecision, 'a', VARS).repeatCount, 1);
});

test('detectStall：连续 2 步同一动作 → 软提示；第 3 步 → 硬提示（必须换）', () => {
  const two = [stepOf('click', 'e10', null, 's1'), stepOf('click', 'e10', null, 's2')];
  const soft = AutoCore.detectStall(two, 's3', VARS);
  assert.strictEqual(soft.repeatCount, 2);
  assert.match(soft.notice, /click/);
  assert.match(soft.notice, /连续执行 2 步/);
  assert.ok(!/必须换一个/.test(soft.notice), '2 步只提示，不下死命令');

  const hard = AutoCore.detectStall(two.concat([stepOf('click', 'e10', null, 's3')]), 's4', VARS);
  assert.strictEqual(hard.repeatCount, 3);
  assert.match(hard.notice, /必须换一个/);
  assert.match(hard.notice, /换入口/, '硬提示必须给出「重复不下去怎么办」的出口');
  assert.ok(!/放弃/.test(hard.notice), '「放弃」已下线，硬提示不得再把它写成退路');
});

test('detectStall：指纹含动作 + 参数 + 最终文本，任一不同就不是重复', () => {
  /* 换 ref → 不算重复 */
  const otherRef = [stepOf('click', 'e10', null, 's1'), stepOf('click', 'e11', null, 's2')];
  assert.strictEqual(AutoCore.detectStall(otherRef, 's3', VARS).repeatCount, 1);
  /* 换动作 → 不算重复 */
  const otherAct = [stepOf('click', 'e10', null, 's1'), stepOf('hover', 'e10', null, 's2')];
  assert.strictEqual(AutoCore.detectStall(otherAct, 's3', VARS).repeatCount, 1);
  /* 文本按变量解析后的**真值**比：「关键词」与「招商银行」是同一个值 → 算重复 */
  const alias = [stepOf('fill', 'e3', '关键词', 's1'), stepOf('fill', 'e3', '招商银行', 's2')];
  assert.strictEqual(AutoCore.detectStall(alias, 's3', VARS).repeatCount, 2);
  /* 真的换了词 → 不算重复 */
  const diffText = [stepOf('fill', 'e3', '关键词', 's1'), stepOf('fill', 'e3', '回车', 's2')];
  assert.strictEqual(AutoCore.detectStall(diffText, 's3', VARS).repeatCount, 1);
});

test('detectStall：动作不同但快照连续未变，同样报警', () => {
  const steps = [stepOf('click', 'e10', null, 'same'), stepOf('fill', 'e3', '关键词', 'same')];
  const out = AutoCore.detectStall(steps, 'same', VARS);
  assert.strictEqual(out.noChangeStreak, 2);
  assert.strictEqual(out.repeatCount, 1);
  assert.match(out.notice, /连续 2 步没有变化/);
  assert.match(out.notice, /fill|提交/, '未变化时要提示「fill 不提交」这个高频原因');
});

test('buildState：停滞提示只在有值时出现，且排在末尾（近快照的注意力位）', () => {
  const base = AutoCore.buildState({ goal: 'g', url: 'u', title: 't', history: [], lastResult: '', snapshot: 's' });
  assert.strictEqual(base['停滞提示'], undefined, '无停滞时不得留空占位字段');
  const st = AutoCore.buildState({
    goal: 'g', url: 'u', title: 't', history: [], lastResult: '', snapshot: 's', stallNotice: '停',
  });
  assert.strictEqual(st['停滞提示'], '停');
  assert.strictEqual(Object.keys(st).pop(), '停滞提示');
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
  assert.strictEqual(AutoCore.normalizeParam({ action: 'press', param: null }).param, null);
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

/* ---------- 并行召回（ref-recall 接线） ---------- */

const RECALL = { on: true, algorithm: 'parallel', size: 80, topN: 15 };
const RANKED = { on: true, algorithm: 'ranked', limit: 80, maxTranches: 3 };

test('normalizeTrim：默认算法 = 并行召回；非法值回退缺省', () => {
  const d = AutoCore.normalizeTrim();
  assert.strictEqual(d.algorithm, 'parallel', '并行召回是默认算法');
  assert.strictEqual(d.on, true);
  assert.strictEqual(d.size, 200, '批次大小默认 200');
  assert.strictEqual(d.topN, 15);
  assert.deepStrictEqual(AutoCore.ALGORITHMS, ['parallel', 'ranked']);
  assert.strictEqual(AutoCore.normalizeTrim({ algorithm: '瞎写' }).algorithm, 'parallel');
  assert.strictEqual(AutoCore.normalizeTrim({ algorithm: 'ranked' }).algorithm, 'ranked', '用户显式选择必须尊重');
  assert.strictEqual(AutoCore.normalizeTrim({ size: 5 }).size, 10, '批次大小夹到 10–250');
  assert.strictEqual(AutoCore.normalizeTrim({ size: 999 }).size, 250);
  assert.strictEqual(AutoCore.normalizeTrim({ size: 20, topN: 99 }).topN, 20, '召回数不得超过一批容量');
});

test('recallPlan：默认 200 → 首轮 200 + 其余 193 一批召回；小页面 / 关裁剪 / 选了相关性裁剪都返回 null', () => {
  const plan = AutoCore.recallPlan({ snapshot: RESUME_SNAPSHOT, paramTrim: { on: true, algorithm: 'parallel' } });
  assert.ok(plan, '393 ref 必须走并行召回');
  assert.strictEqual(plan.meta.firstSize, 200, '首轮「参数」候选 = 前 200 个');
  assert.strictEqual(plan.meta.batches, 1, '其余 193 个一批召回（只剩一段）');
  assert.strictEqual(plan.meta.size, 200);
  assert.strictEqual(plan.meta.totalRefs, 393);
  assert.strictEqual(AutoCore.recallPlan({ snapshot: RESUME_SNAPSHOT, paramTrim: RECALL }).meta.batches, 4, '显式 size=80 → 首轮 80 + 召回 4 批');
  assert.strictEqual(AutoCore.recallPlan({ snapshot: SAMPLE_SNAPSHOT, paramTrim: RECALL }), null, '不超一批走单次调用');
  assert.strictEqual(AutoCore.recallPlan({ snapshot: RESUME_SNAPSHOT, paramTrim: { ...RECALL, on: false } }), null, '关掉裁剪 = 全量单次');
  assert.strictEqual(AutoCore.recallPlan({ snapshot: RESUME_SNAPSHOT, paramTrim: RANKED }), null,
    '选了相关性裁剪时并行召回必须让路（否则两条路线同时生效）');
});

test('shouldRecall：只有「超限页 + 动作需要元素」才触发第二轮召回', () => {
  const plan = AutoCore.recallPlan({ snapshot: RESUME_SNAPSHOT, paramTrim: RECALL });
  assert.ok(plan);
  assert.strictEqual(AutoCore.shouldRecall(plan, { action: 'click' }), true);
  ['press', 'goto', 'reload', 'go-back', 'go-forward', 'tab-list', 'tab-select', 'tab-close',
    '任务已完成'].forEach((a) => {
    assert.strictEqual(AutoCore.shouldRecall(plan, { action: a }), false, a + ' 不需要元素，不该发召回请求');
  });
  assert.strictEqual(AutoCore.shouldRecall(null, { action: 'click' }), false, '小页面（K=1）不触发');
  assert.strictEqual(AutoCore.shouldRecall(plan, null), false);
});

test('buildRecallQuestions：只问「参数」一题，候选 = 该批，instructions 说明本批范围', () => {
  const plan = AutoCore.recallPlan({ snapshot: RESUME_SNAPSHOT, paramTrim: RECALL });
  const at = plan.batches.findIndex((b) => b.criteria.e172);
  assert.ok(at >= 0, 'e172（合格候选人的按钮）在召回范围内');
  const q = AutoCore.buildRecallQuestions(plan, at + 1);
  assert.deepStrictEqual(Object.keys(q), ['参数'], '召回批次只问元素，不问动作/未完成');
  assert.strictEqual(q['参数'].type, 'choice');
  assert.strictEqual(Object.keys(q['参数'].criteria).length, plan.batches[at].refs.length);
  assert.ok(q['参数'].criteria.e172);
  assert.strictEqual(q['参数'].criteria['其他'], undefined, '召回批次没有兜底项');
  assert.match(q['参数'].instructions, new RegExp('第 ' + (at + 1) + '/' + plan.meta.batches + ' 批'), '写明第几批 / 共几批');
  assert.match(q['参数'].instructions, /全页共 393 个/);
  assert.match(q['参数'].instructions, /不需要判断目标是否在本批中/, '让模型只在本批内排序，别去判「有没有」');
  assert.ok(!/折叠/.test(q['参数'].instructions));
});

test('mergeRecall：合并各批召回 → 最终候选集，无「其他」且 meta 完整', () => {
  const plan = AutoCore.recallPlan({ snapshot: RESUME_SNAPSHOT, paramTrim: RECALL });
  /* 模拟 K 批作答：每批给自己批内前 4 个非零概率，最后一批整个失败（null） */
  const answers = plan.batches.map((b, i) => {
    if (i === plan.batches.length - 1) return null;
    const probabilities = {};
    Object.keys(b.criteria).slice(0, 4).forEach((k, j) => { probabilities[k] = 0.5 - j / 10; });
    return { type: 'choice', choice: Object.keys(b.criteria)[0], probabilities, confidence: 0.7 };
  });
  const merged = AutoCore.mergeRecall(plan, answers, { seed: [plan.first.refs[0].ref] });
  assert.strictEqual(merged.meta.batches, 4, 'size=80 → 召回 4 批');
  assert.strictEqual(merged.meta.recalled, 12, '4 批里 3 批成功 × 每批 4 个，最后一批失败不贡献');
  assert.strictEqual(merged.meta.merged, 13, '12 个召回 + 1 个首轮预测');
  assert.deepStrictEqual(merged.meta.seeded, [plan.first.refs[0].ref]);
  assert.strictEqual(Object.keys(merged.criteria)[0], plan.first.refs[0].ref, '首轮预测排最前');
  assert.strictEqual(merged.meta.topN, 15);
  assert.strictEqual(merged.criteria['其他'], undefined);
  assert.ok(Object.keys(merged.criteria).every((k) => /^e\d+$/.test(k)), '候选只能是真实 ref');
  assert.strictEqual(merged.meta.perBatch[3].recalled.length, 0, '失败批次如实记空');
});

test('paramInstructions：并行召回的措辞说清来源，不提「折叠 / 其他」', () => {
  const plan = AutoCore.recallPlan({ snapshot: RESUME_SNAPSHOT, paramTrim: RECALL });
  const merged = AutoCore.mergeRecall(plan, plan.batches.map((b) => ({
    choice: Object.keys(b.criteria)[0],
    probabilities: { [Object.keys(b.criteria)[0]]: 0.9 },
  })));
  const qs = AutoCore.buildQuestions({ snapshot: RESUME_SNAPSHOT, variables: [], param: { criteria: merged.criteria, meta: merged.meta } });
  assert.match(qs['参数'].instructions, /并行召回合并而来/);
  assert.match(qs['参数'].instructions, /4 批 × 每批按概率取前 15/, 'size=80 → 召回 4 批');
  assert.match(qs['参数'].instructions, /已全部列出/);
  assert.ok(!/折叠|其他/.test(qs['参数'].instructions), '这条路线没有兜底项，措辞不能暗示还有下一批');
  assert.strictEqual(Object.keys(qs['参数'].criteria).length, 4, '候选 = 合并结果（每批一个），不是全量 393');
});

test('paramInstructions：首轮那一次说清「只给了前 N 个、其余下一步按需召回」', () => {
  const plan = AutoCore.recallPlan({ snapshot: RESUME_SNAPSHOT, paramTrim: RECALL });
  const param = { criteria: plan.first.criteria, meta: Object.assign({}, plan.meta, { first: true }) };
  const qs = AutoCore.buildQuestions({ snapshot: RESUME_SNAPSHOT, variables: [], param });
  assert.match(qs['参数'].instructions, /候选是当前页面前 80 个元素（全页共 393 个）/);
  assert.match(qs['参数'].instructions, /按需并行召回其余 313 个元素/);
  assert.match(qs['参数'].instructions, /就选出本段中最接近的那一个/, '本段没有目标时别乱选，选最接近的');
  assert.strictEqual(Object.keys(qs['参数'].criteria).length, 80, '首轮只给前 size 个');
  assert.ok(!/其他/.test(qs['参数'].instructions));
});

test('buildRecallPickQuestions：最终决策题只含「参数」，说清候选来自合并、已全部列出', () => {
  const q = AutoCore.buildRecallPickQuestions({
    criteria: { e1: '【可交互】 button "a"', e2: '【可交互】 button "b"' },
    meta: { batches: 3, merged: 2, totalRefs: 393, seeded: ['e1'] }, action: 'click',
  });
  assert.deepStrictEqual(Object.keys(q), ['参数']);
  assert.strictEqual(Object.keys(q['参数'].criteria).length, 2);
  assert.match(q['参数'].instructions, /click/);
  assert.match(q['参数'].instructions, /首轮在该段元素里选出的 1 个 \+ 3 批并行召回的合并结果/);
  assert.match(q['参数'].instructions, /已全部列出/);
  assert.ok(!/其他/.test(q['参数'].instructions), '这条路线没有兜底项，措辞不能暗示还有下一批');
  /* 首轮没给出可用预测时，措辞不谎报「首轮选出的」 */
  const q2 = AutoCore.buildRecallPickQuestions({
    criteria: { e1: 'x' }, meta: { batches: 1, merged: 1, totalRefs: 400, seeded: [] }, action: 'click',
  });
  assert.match(q2['参数'].instructions, /候选 = 1 批并行召回的合并结果/);
});

test('buildRecallPickQuestions：「其他」这类兜底键必须被剔除（否则会被当成元素发出去）', () => {
  /* 实测事故：召回无结果时退回裁剪候选，那一份带「其他」；Jev 选了它，
   * decision.param 就成了「其他」，命令报「fill 需要合法 ref」，连烧三步 */
  const q = AutoCore.buildRecallPickQuestions({
    criteria: { e1: '【可交互】 button "a"', 其他: '还有 5 个候选未列出，选中即自动展开下一批' },
    meta: { batches: 1, merged: 2, totalRefs: 400, seeded: [] }, action: 'fill',
  });
  assert.strictEqual(q['参数'].criteria['其他'], undefined, '兜底键不得进最终决策候选');
  assert.deepStrictEqual(Object.keys(q['参数'].criteria), ['e1']);
  assert.match(q['参数'].instructions, /共 1 个/, '措辞里的候选数要按剔除后的算');
  assert.ok(!/其他|下一批/.test(q['参数'].instructions));
  assert.strictEqual(AutoCore.isRefParam('其他', { e1: 'x' }), false, '它本来就不是 ref');
});

test('buildRecallPickQuestions：退回裁剪候选时不得自称「并行召回的合并结果」', () => {
  /* 召回一条都没命中 → 用相关性裁剪的候选兜底；措辞与候选数都要按**实际生效**的那一份说 */
  const q = AutoCore.buildRecallPickQuestions({
    criteria: { e1: '【可交互】 button "a"', e2: '【可交互】 button "b"' },
    meta: { batches: 2, merged: 2, totalRefs: 469, seeded: [], fallback: true }, action: 'click',
  });
  assert.match(q['参数'].instructions, /退回的相关性裁剪候选/);
  assert.ok(!/并行召回的合并结果/.test(q['参数'].instructions), '兜底那一份不能冒充召回结果');
  assert.match(q['参数'].instructions, /共 2 个/);
});

test('recallSeeds：首轮前 topN 个一起进最终候选（不是只带作答的那一个）', () => {
  const plan = AutoCore.recallPlan({ snapshot: RESUME_SNAPSHOT, paramTrim: RECALL });
  const first = Object.keys(plan.first.criteria);
  const answer = { type: 'choice', choice: first[3], probabilities: {} };
  first.slice(0, 20).forEach((k, i) => { answer.probabilities[k] = 0.5 - i / 100; });
  const seeds = AutoCore.recallSeeds({ plan: plan, answer: answer });
  assert.strictEqual(seeds.length, 15, '取前 15 个（topN）');
  /* 作答的 ref 恒排最前（模型自己选的），其余的按首轮概率序 —— 集合仍是首轮概率前 15 个 */
  assert.strictEqual(seeds[0], first[3], '作答的 ref 排最前');
  assert.deepStrictEqual(seeds.slice(1), first.slice(0, 15).filter((r) => r !== first[3]), '其余按首轮概率序');
  assert.deepStrictEqual(seeds.slice().sort(), first.slice(0, 15).sort(), '集合 = 首轮概率前 15 个');
  assert.ok(seeds.every((r) => plan.first.criteria[r]), '种子只来自首轮那一段');
  /* 传整封响应（信封）也行 —— 剥壳在 answerOf 里，调用方不需要知道有两层 */
  assert.deepStrictEqual(AutoCore.recallSeeds({ plan: plan, answer: { answers: { 参数: answer } } }), seeds);
  /* 作答的 ref 概率为 0 也必须在种子里（pickFromAnswer 的硬规则） */
  const zero = AutoCore.recallSeeds({ plan: plan, answer: { choice: first[0], probabilities: { [first[0]]: 0, [first[1]]: 0.2 } } });
  assert.strictEqual(zero[0], first[0]);
  /* 没有作答 / 没有 plan → 空数组，调用方自己决定兜底 */
  assert.deepStrictEqual(AutoCore.recallSeeds({ plan: plan, answer: null }), []);
  assert.deepStrictEqual(AutoCore.recallSeeds({ plan: null, answer: answer }), []);
});

test('answerOf 从 AutoCore 暴露出来（调用方只依赖一处剥壳实现）', () => {
  const inner = { type: 'choice', choice: 'e1', probabilities: { e1: 1 } };
  assert.strictEqual(AutoCore.answerOf({ model: 'jev-1.13.0', answers: { 参数: inner } }), inner);
  assert.strictEqual(AutoCore.answerOf(inner), inner);
});

test('actionsOf：并行召回是一个动作，排在「首轮」之后、「参数决策」之前', () => {
  const step = {
    n: 1, payload: { state: {}, model: 'm', questions: { 动作: {}, 参数: {}, 未完成: {} } }, response: {}, jevMs: 992,
    recall: {
      afterMain: true,
      meta: { algorithm: 'parallel', batches: 2, size: 200, topN: 15, totalRefs: 381, merged: 101 },
      criteria: { e144: {}, e9: {} },
      merged: { merged: 101, recalled: 140, batches: 2 },
      batches: [
        { batch: 1, size: 200, payload: { questions: { 参数: {} } }, response: {}, ms: 1200, recalled: ['e9'] },
        { batch: 2, size: 181, payload: { questions: { 参数: {} } }, response: {}, ms: 1100, recalled: ['e144'] },
      ],
    },
    followUps: [{ kind: 'pick', payload: { questions: { 参数: {} } }, response: {}, param: 'e144', ms: 954, candidates: 101 }],
  };
  const acts = AutoCore.actionsOf(step);
  assert.deepStrictEqual(acts.map((a) => a.kind), ['main', 'recall', 'pick'], '时间线顺序：首轮 → 召回 → 参数决策');
  assert.strictEqual(acts[0].title, 'Jev 首轮 · 3 题', '超限页首轮仍是三道题（参数只给前 200 个）');
  assert.strictEqual(acts[1].title, '并行召回 · 2 批 × 200 个');
  assert.strictEqual(acts[1].calls, 2, '一个动作、两次调用');
  /* K 批是**并发**发出去的（resolveRecall 里 Promise.all）：墙钟只看最慢的那一批。
   * 累加会把并行的 1.2s / 1.1s 说成 2.3s —— 那是「模型净耗时之和」，不是用户等的时间 */
  assert.strictEqual(acts[1].ms, 1200, '召回动作的耗时 = 并行批次里的最大值');
  assert.deepStrictEqual(acts[1].mergedKeys, ['e144', 'e9']);
  assert.strictEqual(acts[2].title, '参数决策 · 1 题 · 候选 101 个（并行召回合并）');
  /* 耗时口径：1 次首轮 + 2 批召回 + 1 次参数决策 = 4 次 Jev 调用；
   * 首轮 → 召回 → 参数决策 三段是串行的，段位之间才累加，召回段内部取最大值 */
  const d = AutoCore.durationView(step);
  assert.strictEqual(d.jevCalls, 4);
  assert.strictEqual(d.jevMs, 992 + 1200 + 954);
  assert.strictEqual(d.jevMeasured, 4, '4 次调用都测到了：召回那 2 批各算一次，不能算成 1 次');
});

test('actionsOf：召回部分批次缺 ms —— 取测到的最慢一批，缺的那批只减 measured', () => {
  const step = {
    n: 2, payload: { questions: { 动作: {}, 未完成: {} } }, response: {}, jevMs: 500,
    recall: {
      afterMain: true,
      meta: { algorithm: 'parallel', batches: 3, size: 200 },
      criteria: {},
      batches: [
        { batch: 1, size: 200, response: {}, ms: 800, recalled: [] },
        { batch: 2, size: 200, response: {}, ms: 1400, recalled: [] },
        { batch: 3, size: 80, response: {}, recalled: [] },   /* 老记录 / 字段丢过 */
      ],
    },
  };
  const rec = AutoCore.actionsOf(step)[1];
  assert.strictEqual(rec.kind, 'recall');
  assert.strictEqual(rec.calls, 3);
  assert.strictEqual(rec.ms, 1400, '只认测到的批次，取其中最大值');
  const d = AutoCore.durationView(step);
  assert.strictEqual(d.jevCalls, 4);
  assert.strictEqual(d.jevMs, 500 + 1400);
  assert.strictEqual(d.jevMeasured, 3, '首轮 1 + 召回测到的 2 批');
});

test('stepDurationTitle：召回并行时不能只说「合计」', () => {
  const step = {
    n: 2, payload: { questions: { 动作: {}, 未完成: {} } }, response: {}, jevMs: 500,
    recall: {
      afterMain: true, meta: { batches: 2, size: 200 }, criteria: {},
      batches: [
        { batch: 1, size: 200, response: {}, ms: 800, recalled: [] },
        { batch: 2, size: 120, response: {}, ms: 1400, recalled: [] },
      ],
    },
    followUps: [{ kind: 'pick', payload: { questions: { 参数: {} } }, response: {}, ms: 300, candidates: 12 }],
  };
  /* 3 次首轮/召回/决策？—— 首轮 1 + 召回 2 批 + 决策 1 = 4 次；召回那 2 批并行，文案要说明白 */
  assert.strictEqual(AutoCore.stepDurationTitle(step),
    '本步 4 次 Jev 调用（首轮/召回/补问）合计，召回 2 批并行、按最慢一批计入');
});

test('stepDurationTitle：批次已建好但一次都没测到（中断/自动保存）时不提「最慢一批」', () => {
  /* 自动保存可能正好落在 Promise.all 还没回来的那一刻：recall.batches 已经建好，
   * 每批的 ms 还是 null。这时说「按最慢一批计入」是凭空许诺，还与同一行的
   * 「3 次未计时」互相打脸（data/runs 里真有这种 running 态记录） */
  const step = {
    n: 3, payload: { questions: { 动作: {}, 未完成: {} } }, response: {}, jevMs: 500,
    recall: {
      afterMain: true, meta: { batches: 3, size: 200 }, criteria: {},
      batches: [
        { batch: 1, size: 200, response: null, ms: null, recalled: [] },
        { batch: 2, size: 200, response: null, ms: null, recalled: [] },
        { batch: 3, size: 80, response: null, ms: null, recalled: [] },
      ],
    },
    followUps: [{ kind: 'pick', payload: { questions: { 参数: {} } }, response: {}, ms: 300, candidates: 5 }],
  };
  const d = AutoCore.durationView(step);
  assert.strictEqual(d.jevMs, 500 + 300, '召回那 3 批一次都没测到，不进合计');
  assert.strictEqual(d.recallBatches, 3);
  assert.strictEqual(d.recallMeasured, 0);
  assert.strictEqual(AutoCore.stepDurationTitle(step),
    '本步 5 次 Jev 调用（首轮/召回/补问）合计，其中 3 次未计时');
});

test('actionsOf：老流程记录（首轮带「参数」）仍把召回排在首轮之前', () => {
  const step = {
    n: 1, payload: { questions: { 动作: {}, 参数: {}, 未完成: {} } }, response: {}, jevMs: 500,
    recall: { meta: { batches: 1, size: 80 }, criteria: {}, batches: [{ batch: 1, size: 80, response: {}, ms: 100, recalled: [] }] },
  };
  assert.deepStrictEqual(AutoCore.actionsOf(step).map((a) => a.kind), ['recall', 'main']);
});

test('两条路线互不干扰：选了相关性裁剪时 paramCriteria 仍是旧行为（含「其他」）', () => {
  const pc = AutoCore.paramCriteria({ snapshot: RESUME_SNAPSHOT, goal: RESUME_GOAL, paramTrim: RANKED });
  assert.strictEqual(pc.meta.trimmed, true);
  assert.ok(pc.criteria['其他'], '相关性裁剪路线的兜底项必须还在');
  const qs = AutoCore.buildQuestions({ snapshot: RESUME_SNAPSHOT, variables: [], param: pc });
  assert.match(qs['参数'].instructions, /折叠/);
});

test('buildRunRecord：召回批次不重复存 state，且 Jev 调用次数把召回算进去', () => {
  const state = { 任务目标: 'x', 页面快照: '- button "a" [ref=e1]' };
  const step = {
    n: 1,
    payload: { state, model: 'm', questions: { 动作: {}, 参数: {}, 未完成: {} } },
    recall: {
      meta: { algorithm: 'parallel', batches: 2, size: 80, topN: 15, totalRefs: 100, merged: 20, clamped: 0, perBatch: [] },
      batches: [
        { batch: 1, size: 80, payload: { state, model: 'm', questions: { 参数: {} } }, response: {}, error: null, recalled: ['e1'], ms: 12 },
        { batch: 2, size: 20, payload: { state, model: 'm', questions: { 参数: {} } }, response: null, error: 'boom', recalled: [], ms: 9 },
      ],
    },
  };
  const rec = AutoCore.buildRunRecord({ id: 'r', runCfg: { goal: 'x' }, steps: [step] });
  const bs = rec.steps[0].recall.batches;
  assert.strictEqual(bs.length, 2);
  /* K 批发的是同一份 state：落盘只留 questions + sharedState 标记（读回时挂回 step.request.state）。
   * 一步 6 次调用各存一份全量快照 → 记录实测从 ~300KB 涨到 1.6MB */
  assert.strictEqual(bs[0].request.state, undefined, '批次请求不得重复存 state');
  assert.strictEqual(bs[0].sharedState, true);
  assert.ok(bs[0].request.questions['参数'], 'questions 必须留着 —— 那才是每批不同的部分');
  assert.ok(rec.steps[0].request.state['页面快照'], '本步首轮的 state 仍在记录里，信息不丢');
  assert.deepStrictEqual(bs[0].recalled, ['e1']);
  assert.strictEqual(bs[1].error, 'boom', '失败批次如实落盘');
  assert.strictEqual(rec.meta.jevCalls, 3, '首轮 1 次 + 召回 2 批（对账口径）');
});

test('落盘 → 重新载入：召回候选键与「参数决策」候选数都要活着回来（往返对账）', () => {
  /* 「面板与实际数据不匹配」的老毛病就出在这条边界上：这层映射原先只活在浏览器里的
   * auto.js，node 侧没有测试面，丢字段丢得无声无息 —— 会话一重新载入，
   * 「参数决策 · 候选 N 个」就成了「候选 ? 个」，召回卡片里的合并候选清单一整段消失 */
  const state = { 任务目标: 'x', 页面快照: '- button "a" [ref=e1]' };
  const refLabels = { e1: '【可交互】 button "发货"', e2: '【可交互】 button "查看"' };
  const step = {
    n: 1, refLabels,
    payload: { state, model: 'm', questions: { 动作: {}, 参数: {}, 未完成: {} } },
    response: {},
    recall: {
      afterMain: true,
      meta: { algorithm: 'parallel', batches: 1, size: 200, topN: 15, totalRefs: 400, merged: 2, seeded: ['e1'] },
      criteria: { e1: refLabels.e1, e2: refLabels.e2 },
      merged: { merged: 2, recalled: 1, batches: 1, seeded: ['e1'] },
      batches: [{ batch: 1, size: 200, payload: { state, model: 'm', questions: { 参数: {} } }, response: {}, error: null, recalled: ['e2'], ms: 12 }],
    },
    followUps: [{ kind: 'pick', payload: { questions: { 参数: {} } }, response: {}, param: 'e1', candidates: 2, ms: 30 }],
  };
  const saved = AutoCore.buildRunRecord({ id: 'r', runCfg: { goal: 'x' }, steps: [step] });
  assert.deepStrictEqual(saved.steps[0].recall.candidates, ['e1', 'e2'], '候选键必须落盘');
  assert.strictEqual(saved.steps[0].followUps[0].candidates, 2, '候选数必须落盘（否则标题写 ?）');

  const back = AutoCore.hydrateRecord(saved).steps[0];
  assert.deepStrictEqual(Object.keys(back.recall.criteria), ['e1', 'e2'], '候选键映射按 refLabels 复原');
  assert.strictEqual(back.recall.criteria.e1, refLabels.e1, '复原出来的描述与当时一致（卡片可读）');
  assert.strictEqual(back.followUps[0].candidates, 2, '候选数往返不丢');
  assert.deepStrictEqual(back.followUps[0].payload, saved.steps[0].followUps[0].request, 'request → payload 归一');
  assert.deepStrictEqual(back.recall.batches[0].payload.state, state, 'sharedState 挂回去，展示 = 当时真发的');
  assert.strictEqual(back.recall.batches[0].sharedState, undefined, '中间标记不留给渲染层');

  /* 老记录（补问没存候选数，但召回候选键还在）：从候选键数补回来，不写「?」 */
  const old = JSON.parse(JSON.stringify(saved));
  delete old.steps[0].followUps[0].candidates;
  const oldBack = AutoCore.hydrateRecord(old).steps[0];
  assert.strictEqual(oldBack.followUps[0].candidates, 2, '老记录也补得回来（从批次候选键数）');

  /* 更老的记录（候选键都没有）：如实为 null / 空 —— 报「候选 0 个」是假话 */
  const older = JSON.parse(JSON.stringify(saved));
  delete older.steps[0].recall.candidates;
  delete older.steps[0].followUps[0].candidates;
  const olderBack = AutoCore.hydrateRecord(older).steps[0];
  assert.strictEqual(olderBack.followUps[0].candidates, null, '重建不出来就写 ?，不编造 0');
  assert.deepStrictEqual(Object.keys(olderBack.recall.criteria), [], '候选键真没了就如实为空');
});

test('落盘 → 重新载入：召回耗时仍是「最慢一批」，不会被读成各批之和', () => {
  /* 这条边界上丢过字段（候选键 / 候选数），耗时也一样要往返对账：
   * 落盘存的是**每批各自**的 ms，读回后由 actionsOf 重新取最大 —— 只要有人改成相加，
   * 重新载入的历史会话就会比实时跑的同一会话更慢，且没人看得出来 */
  const state = { 任务目标: 'x', 页面快照: '- button "a" [ref=e1]' };
  const step = {
    n: 1, payload: { state, model: 'm', questions: { 动作: {}, 未完成: {} } }, response: {},
    recall: {
      afterMain: true,
      meta: { algorithm: 'parallel', batches: 2, size: 200, topN: 15, totalRefs: 381 },
      criteria: { e9: '【可交互】 button "查看"' },
      batches: [
        { batch: 1, size: 200, payload: { state, model: 'm', questions: { 参数: {} } }, response: {}, error: null, recalled: [], ms: 1100 },
        { batch: 2, size: 181, payload: { state, model: 'm', questions: { 参数: {} } }, response: {}, error: null, recalled: [], ms: 1900 },
      ],
    },
    followUps: [{ kind: 'pick', payload: { questions: { 参数: {} } }, response: {}, param: 'e9', candidates: 1, ms: 400 }],
  };
  const back = AutoCore.hydrateRecord(AutoCore.buildRunRecord({ id: 'r', runCfg: { goal: 'x' }, steps: [step] })).steps[0];
  const acts = AutoCore.actionsOf(back);
  assert.deepStrictEqual(acts.map((a) => a.kind), ['main', 'recall', 'pick']);
  assert.strictEqual(acts[1].ms, 1900, '往返后仍是并发批次里的最大值（1100 + 1900 = 3000 是错的）');
  assert.strictEqual(acts[1].calls, 2);
  assert.strictEqual(acts[1].measured, 2);
  assert.strictEqual(AutoCore.durationView(back).jevMs, 1900 + 400, '首轮这次没记 jevMs，只有召回段 + 决策段');
});

test('落盘 → 重新载入：行动顺序不变（并行召回仍排在「首轮」之后）', () => {
  /* 实测缺陷：afterMain 没落盘，重新载入后按老判据（首轮带不带「参数」题）反推 ——
   * 新流程首轮**就带**「参数」（前 size 个），于是判成「召回在前」，
   * 时间线倒放（用户报过的「怎么还是先并行啊？」在重新载入时复活） */
  const state = { 任务目标: 'x', 页面快照: '- button "a" [ref=e1]' };
  const mk = (afterMain) => ({
    n: 1, refLabels: { e1: 'a', e2: 'b' },
    payload: { state, model: 'm', questions: { 动作: {}, 参数: {}, 未完成: {} } },
    response: { answers: {} },
    recall: {
      afterMain: afterMain,
      meta: { algorithm: 'parallel', batches: 1, size: 200, topN: 15, totalRefs: 400, merged: 20 },
      criteria: { e1: 'a', e2: 'b' },
      merged: { merged: 20, recalled: 19, batches: 1, seeded: ['e1'] },
      batches: [{ batch: 1, size: 200, payload: { state, model: 'm', questions: { 参数: {} } }, response: {}, error: null, recalled: ['e2'], ms: 12 }],
    },
    followUps: [{ kind: 'pick', payload: { questions: { 参数: {} } }, response: {}, param: 'e1', candidates: 20, ms: 30 }],
  });
  const kinds = (step) => AutoCore.actionsOf(step).map((a) => a.kind);
  const live = kinds(mk(true));
  assert.deepStrictEqual(live, ['main', 'recall', 'pick'], '当前流程：首轮 → 并行召回 → 参数决策');
  const rec = AutoCore.buildRunRecord({ id: 'r', runCfg: { goal: 'x' }, steps: [mk(true)] });
  assert.strictEqual(rec.steps[0].recall.afterMain, true, 'afterMain 必须落盘');
  assert.deepStrictEqual(kinds(AutoCore.hydrateRecord(rec).steps[0]), live, '重新载入后顺序不变');
  /* 老流程（召回在首轮之前）落盘再读回，也不能被新逻辑翻过来 */
  const oldRec = AutoCore.buildRunRecord({ id: 'r2', runCfg: { goal: 'x' }, steps: [mk(false)] });
  assert.deepStrictEqual(kinds(AutoCore.hydrateRecord(oldRec).steps[0]), ['recall', 'main', 'pick']);
  /* 更老的记录（没有 afterMain 字段）：按老判据 —— **首轮不带「参数」题**的那一版
   * （首轮只问动作+未完成）召回是在首轮之后的 */
  const ancient = AutoCore.buildRunRecord({ id: 'r3', runCfg: { goal: 'x' }, steps: [mk(true)] });
  delete ancient.steps[0].recall.afterMain;
  delete ancient.steps[0].request.questions['参数'];
  assert.deepStrictEqual(kinds(AutoCore.hydrateRecord(ancient).steps[0]), ['main', 'recall', 'pick'], '老记录判据不变');
  /* 首轮带「参数」却没有 afterMain 字段 = 中间那版（召回先发）的记录，仍按「召回在前」渲染 */
  const mid = AutoCore.buildRunRecord({ id: 'r4', runCfg: { goal: 'x' }, steps: [mk(true)] });
  delete mid.steps[0].recall.afterMain;
  assert.deepStrictEqual(kinds(AutoCore.hydrateRecord(mid).steps[0]), ['recall', 'main', 'pick'], '中间版本的历史记录不改写');
});

test('落盘 → 重新载入：llm 耗时也要活着回来（面板不能少一截）', () => {
  const step = {
    n: 1, payload: { state: {}, model: 'm', questions: { 动作: {} } }, response: {},
    llm: { messages: [{ role: 'user', content: 'x' }], raw: { choices: [] }, text: '搜索词', ms: 1234 },
  };
  const saved = AutoCore.buildRunRecord({ id: 'r', runCfg: { goal: 'x' }, steps: [step] });
  assert.strictEqual(saved.steps[0].llm.ms, 1234, 'llm.ms 落盘');
  assert.strictEqual(AutoCore.hydrateRecord(saved).steps[0].llm.ms, 1234, '读回时不能丢（丢了「生成输入」就没耗时）');
});

test('recall 行动：K 批全部失败是 error，不是永远 pending（树上不能一直转圈）', () => {
  const bs = (err) => [{ batch: 1, response: err ? null : {}, error: err }];
  assert.strictEqual(AutoCore.actionStatus({ kind: 'recall', batches: bs('boom') }), 'error');
  assert.strictEqual(AutoCore.actionStatus({ kind: 'recall', batches: bs(null) }), 'ok');
  assert.strictEqual(AutoCore.actionStatus({ kind: 'recall', batches: [{ batch: 1, response: null, error: null }] }), 'pending');
  /* 有的批成功有的失败 → 不算整体失败 */
  assert.strictEqual(AutoCore.actionStatus({ kind: 'recall', batches: [{ batch: 1, response: {}, error: null }, { batch: 2, response: null, error: 'x' }] }), 'ok');
});

test('dropRefMore：只剔「其他」，顺序与其他键原样保留', () => {
  const src = { e1: 'a', 其他: '还有 5 个候选未列出', e2: 'b' };
  const out = AutoCore.dropRefMore(src);
  assert.deepStrictEqual(Object.keys(out), ['e1', 'e2']);
  assert.strictEqual(out.其他, undefined);
  assert.deepStrictEqual(Object.keys(AutoCore.dropRefMore({ e1: 'a' })), ['e1']);
  assert.deepStrictEqual(Object.keys(AutoCore.dropRefMore(null)), []);
});

test('recallFallback：退回裁剪候选时必须剔「其他」，且候选数与实际发出的题目一致', () => {
  /* 实测缺陷：兜底那份带「其他」，面板/记录报 81 个、实际发出 80 个，
   * 面板还会在写着「无「其他」兜底」的区块里多渲染一行空的「其他」 */
  const big = ['- button "发货" [ref=e1]'].concat(
    Array.from({ length: 300 }, (_, i) => '- generic "cell ' + (i + 1) + '" [ref=e' + (i + 10) + ']')).join('\n');
  const fb = AutoCore.recallFallback({
    snapshot: big, goal: '给金卡会员的催单发货',
    paramTrim: AutoCore.normalizeTrim(), mergedMeta: { batches: 2, topN: 15, totalRefs: 301 },
  });
  assert.strictEqual(fb.criteria['其他'], undefined, '兜底候选里不得有「其他」');
  assert.strictEqual(fb.meta.fallback, true, '标记兜底：最终决策题的措辞不能再自称「召回合并结果」');
  assert.strictEqual(fb.meta.merged, Object.keys(fb.criteria).length, '报的份数 = 实际持有的候选数');
  assert.strictEqual(fb.meta.batches, 2, '召回批次信息照旧带上（面板要说清是哪个阶段兜的底）');
  const q = AutoCore.buildRecallPickQuestions({ criteria: fb.criteria, meta: fb.meta, action: 'click' });
  assert.strictEqual(Object.keys(q['参数'].criteria).length, fb.meta.merged, '发出的题目 = 报给面板的那一份');
  assert.match(q['参数'].instructions, /共 \d+ 个/);
  assert.ok(!/其他/.test(q['参数'].instructions));
});

test('hydrateRecord：没有召回的步骤原样通过（老记录零回归）', () => {
  /* 入参是**运行时形状**（payload），落盘才叫 request —— 这条也一并锁住 */
  const step = { n: 1, payload: { state: { 任务目标: 'x' }, model: 'm', questions: { 动作: {} } }, response: {}, recall: null, followUps: [{ kind: 'text', payload: { questions: { 文本: {} } }, text: 'a' }] };
  const saved = AutoCore.buildRunRecord({ id: 'r', runCfg: { goal: 'x' }, steps: [step] });
  const back = AutoCore.hydrateRecord(saved).steps[0];
  assert.strictEqual(back.recall, null);
  assert.strictEqual(back.payload.model, 'm');
  assert.strictEqual(back.followUps[0].payload.questions['文本'] !== undefined, true, 'request → payload 归一');
  assert.strictEqual(back.followUps[0].candidates, null, '非 pick 补问不编造候选数');
});

/* ---------- 快照携带器：动作带回的快照顶替下一步的 snapshot ---------- */

test('makeSnapshotCarrier：只有「成功 + 非空字符串」才收下，其余一律清空', () => {
  const c = AutoCore.makeSnapshotCarrier();
  const SNAP = '- generic [ref=e1]';

  assert.strictEqual(c.accept({ ok: true, snapshot: SNAP }), SNAP, '成功且带回文本 → 收下');
  assert.strictEqual(c.peek(), SNAP);
  /* 失败的动作必须把上一份清掉，不能留着冒充这次的：失败步的下一步要真取一次，
   * 否则失败原因（弹窗 / 被遮挡）会被上一份快照盖掉 */
  assert.strictEqual(c.accept({ ok: false, error: 'x', snapshot: SNAP }), null, '失败 → 清空');
  assert.strictEqual(c.peek(), null);

  c.accept({ ok: true, snapshot: SNAP });
  assert.strictEqual(c.accept({ ok: true }), null, '成功但没带回（fill / check 这类上游不给）→ 清空');
  c.accept({ ok: true, snapshot: SNAP });
  assert.strictEqual(c.accept({ ok: true, snapshot: '' }), null, '空字符串不算数（空页面）');
  c.accept({ ok: true, snapshot: SNAP });
  assert.strictEqual(c.accept({ ok: true, snapshot: 123 }), null, '非字符串不算数');
  c.accept({ ok: true, snapshot: SNAP });
  assert.strictEqual(c.accept(null), null, '没有结果也算没带回');
  assert.strictEqual(c.peek(), null);
});

test('makeSnapshotCarrier：取走即清（隔步绝不复用），reset 用于开跑', () => {
  const c = AutoCore.makeSnapshotCarrier();
  c.accept({ ok: true, snapshot: '- generic [ref=e1]' });
  assert.ok(c.take(), '第一次取得到');
  assert.strictEqual(c.take(), null, '取走即清 —— 快照只能被紧接着的那一步用掉');
  assert.strictEqual(c.peek(), null);

  c.accept({ ok: true, snapshot: '- generic [ref=e2]' });
  c.reset();
  assert.strictEqual(c.take(), null, '开跑 reset 之后，上一轮的快照绝不能跨轮生效');
});

/* ---------- 原生弹窗（modal state）：快照被拒 → 弹窗步 ---------- */

/* ---------- 快照来源（上一步动作顺带带回 / 本步新取）：落盘往返 ---------- */

test('buildRunRecord/hydrateRecord：快照来源往返不丢，老记录如实为 null', () => {
  const mk = (from) => ({ n: 1, label: 'l', snapshot: '- generic [ref=e1]', payload: { state: { 任务目标: 'x' } }, snapshotFrom: from });
  const saved = AutoCore.buildRunRecord({ id: 'r', runCfg: { goal: 'x' }, steps: [mk('action'), mk('fresh')] });
  assert.strictEqual(saved.steps[0].snapshotFrom, 'action', '必须落盘（只写面板的话，重新载入会话就没了）');
  assert.strictEqual(saved.steps[1].snapshotFrom, 'fresh');
  const back = AutoCore.hydrateRecord(saved).steps;
  assert.strictEqual(back[0].snapshotFrom, 'action', '读回与落盘一致');
  assert.strictEqual(back[1].snapshotFrom, 'fresh');
  /* 老记录没有这个字段：如实为 null —— 面板据此不写来源，不许编一句「本步新取」 */
  const old = AutoCore.buildRunRecord({ id: 'r2', runCfg: { goal: 'x' }, steps: [{ n: 1, payload: { state: { 任务目标: 'x' } } }] });
  assert.strictEqual(old.steps[0].snapshotFrom, null);
  assert.strictEqual(AutoCore.hydrateRecord(old).steps[0].snapshotFrom, null);
});

/* ---------- 原生弹窗（modal state）：快照被拒 → 弹窗步 ---------- */

test('isModalSnapshotError：只认 modal state 拒绝，不误伤其它快照失败', () => {
  assert.strictEqual(AutoCore.isModalSnapshotError('Tool "browser_snapshot" does not handle the modal state'), true);
  assert.strictEqual(AutoCore.isModalSnapshotError('Error: page crashed'), false);
  assert.strictEqual(AutoCore.isModalSnapshotError('获取快照超时'), false);
  assert.strictEqual(AutoCore.isModalSnapshotError(''), false);
  assert.strictEqual(AutoCore.isModalSnapshotError(null), false);
});

test('buildDialogQuestions：单道「动作」题，候选只有接受/取消弹窗（描述与 22 候选同源）', () => {
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

test('stepDurationLine：右列压到纯数字宽度 —— 正常 / 老记录 / 无调用 / 跑动中', () => {
  assert.equal(AutoCore.stepDurationLine(LIVE_STEP), 'Jev 6.5s');
  assert.equal(AutoCore.stepDurationLine({ n: 1, request: { questions: { 动作: {} } }, response: {} }), '—');
  assert.equal(AutoCore.stepDurationLine({ n: 1 }), '');
  /* 跑动中：Jev 还没返回，此时写 '—' 是错的（记录正在写）*/
  assert.equal(AutoCore.stepDurationLine({ n: 2, payload: { questions: { 动作: {} } } }, { live: true }), '计时中');
  assert.equal(AutoCore.stepDurationLine(LIVE_STEP, { live: true }), 'Jev 6.5s');
});

test('stepDurationTitle：次数与未计时说明搬到悬停（树宽放不下）', () => {
  /* 三种 Jev 调用都可能出现在一步里：首轮 / 并行召回的批次 / 补问 —— 文案写全，别漏召回 */
  assert.equal(AutoCore.stepDurationTitle(LIVE_STEP), '本步 2 次 Jev 调用（首轮/召回/补问）合计');
  const half = {
    n: 3, ms: 8000, jevMs: 3000,
    payload: { questions: { 动作: {} } }, response: {},
    followUps: [{ kind: 'text', request: { questions: { 文本: {} } }, response: {} }],
  };
  assert.equal(AutoCore.stepDurationTitle(half), '本步 2 次 Jev 调用（首轮/召回/补问）合计，其中 1 次未计时');
  assert.equal(AutoCore.stepDurationTitle({ n: 1, request: { questions: { 动作: {} } }, response: {} }),
    '本步有 1 次 Jev 调用，但这条记录没有耗时数据');
  assert.equal(AutoCore.stepDurationTitle({ n: 1 }), '');
});

test('actionsOf：把 ms 透出到每个行动（主调用 / 补问 / 生成输入）', () => {
  const acts = AutoCore.actionsOf(LIVE_STEP);
  assert.deepEqual(acts.map((a) => a.ms), [3200, 3300, 1200]);
});

test('stepDurationLine：部分补问缺 ms 时树上仍是干净的数字（说明进 title）', () => {
  const half = {
    n: 3, ms: 8000, jevMs: 3000,
    payload: { questions: { 动作: {} } }, response: {},
    followUps: [{ kind: 'text', request: { questions: { 文本: {} } }, response: {} }],
  };
  assert.equal(AutoCore.stepDurationLine(half), 'Jev 3.0s');
});

/* ---------- 行动详情：单次调用的耗时 + 输入/输出 token ---------- */

test('usageOf：Jev 的 input_tokens/output_tokens 与 OpenAI 的 prompt_tokens/completion_tokens 都认', () => {
  assert.deepEqual(AutoCore.usageOf({ usage: { input_tokens: 15235, output_tokens: 1805 } }), { input: 15235, output: 1805 });
  assert.deepEqual(AutoCore.usageOf({ usage: { prompt_tokens: 100, completion_tokens: 20 } }), { input: 100, output: 20 });
  assert.deepEqual(AutoCore.usageOf({ usage: { input_tokens: 5 } }), { input: 5, output: null });
  assert.deepEqual(AutoCore.usageOf({ usage: {} }), { input: null, output: null });
  assert.deepEqual(AutoCore.usageOf({}), { input: null, output: null });
  assert.deepEqual(AutoCore.usageOf(null), { input: null, output: null });
  /* 0 是合法值（缓存全命中时 input 可能为 0），不能被当成「没有」 */
  assert.deepEqual(AutoCore.usageOf({ usage: { input_tokens: 0, output_tokens: 0 } }), { input: 0, output: 0 });
});

test('formatTokens：千分位（成本核算要精确值，不做 15.2k 那种缩写）', () => {
  assert.equal(AutoCore.formatTokens(15235), '15,235');
  assert.equal(AutoCore.formatTokens(80), '80');
  assert.equal(AutoCore.formatTokens(0), '0');
  assert.equal(AutoCore.formatTokens(1234567), '1,234,567');
  assert.equal(AutoCore.formatTokens(null), '—');
});

test('actionMetricsLine：耗时 + 输入/输出 token；缺什么省什么，全缺是空串', () => {
  assert.equal(
    AutoCore.actionMetricsLine({ kind: 'main', ms: 1234, response: { usage: { input_tokens: 15235, output_tokens: 1805 } } }),
    '耗时 1.2s · 输入 15,235 tokens · 输出 1,805 tokens');
  /* 老记录：没有 ms，但响应里有 usage —— token 照样显示 */
  assert.equal(AutoCore.actionMetricsLine({ kind: 'main', response: { usage: { input_tokens: 5, output_tokens: 6 } } }),
    '输入 5 tokens · 输出 6 tokens');
  /* 调用失败：既没响应也没耗时 → 空串，这一行整体不出现 */
  assert.equal(AutoCore.actionMetricsLine({ kind: 'main', error: 'Jev 调用失败' }), '');
  /* 只有耗时 */
  assert.equal(AutoCore.actionMetricsLine({ kind: 'main', ms: 800 }), '耗时 800ms');
  /* 生成输入那次的 OpenAI 形状 */
  assert.equal(AutoCore.actionMetricsLine({ kind: 'llm', ms: 2100, response: { usage: { prompt_tokens: 640, completion_tokens: 12 } } }),
    '耗时 2.1s · 输入 640 tokens · 输出 12 tokens');
});

/* ---------- 步骤合计（界面不再显示，落盘的 meta 用它） ---------- */

test('sumStepMs：总和 + 测到几步（老记录混排）', () => {
  const r = AutoCore.sumStepMs([{ ms: 1000 }, { ms: 2000 }, { exec: { ok: true } }, { ms: 0 }]);
  assert.equal(r.sumMs, 3000);
  assert.equal(r.measured, 3);
  assert.equal(r.total, 4);
});

/* ---------- 落盘格式（spec 2026-09-28 §5） ---------- */

test('buildRunRecord：步骤与补问与 llm 的 ms 落盘；meta 带对账四件套', () => {
  const rec = AutoCore.buildRunRecord({
    id: 'r-0928-1200-abcd', runCfg: { goal: 'g', url: 'u', maxSteps: 3 },
    startedAt: '2026-09-28T04:00:00.000Z', endedAt: '2026-09-28T04:01:07.000Z',
    endState: 'done', timing: { prepMs: 3100, wallMs: 67070 },
    steps: [
      { n: 1, ms: 9950, jevMs: 3200, payload: { questions: { 动作: {} } }, response: {},
        followUps: [{ kind: 'text', payload: { questions: { 文本: {} } }, response: {}, ms: 3300 }],
        llm: { messages: [], raw: {}, text: 'x', ms: 1200 }, exec: { ok: true, elapsedMs: 1386 } },
      { n: 2, exec: { ok: true, elapsedMs: 500 } },   /* 老形状：没测过耗时 */
    ],
  });
  assert.equal(rec.steps[0].ms, 9950);
  assert.equal(rec.steps[0].jevMs, 3200);
  assert.equal(rec.steps[0].followUps[0].ms, 3300);
  assert.equal(rec.steps[0].llm.ms, 1200);
  assert.equal(rec.steps[1].ms, null);            /* 缺 → null（JSON 里是 null，不是丢字段） */
  assert.equal(rec.meta.prepMs, 3100);
  assert.equal(rec.meta.wallMs, 67070);
  assert.equal(rec.meta.sumStepMs, 9950);         /* 只累加测到的 */
  assert.equal(rec.meta.tailMs, 67070 - 3100 - 9950);
});

test('buildRunRecord：没传 timing（老调用方 / 进行中首存）→ 对账四件套为 null，不回归', () => {
  const rec = AutoCore.buildRunRecord({
    id: 'r-x', runCfg: { goal: 'g', url: 'u' }, startedAt: 't',
    steps: [{ n: 1, ms: 500, payload: { questions: { 动作: {} } }, response: {} }],
  });
  assert.equal(rec.meta.prepMs, null);
  assert.equal(rec.meta.wallMs, null);
  assert.equal(rec.meta.tailMs, null);
  assert.equal(rec.meta.sumStepMs, 500);          /* 步耗时照样能合，只是平不了账 */
});
