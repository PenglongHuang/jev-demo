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

test('planExecution：矛盾决策抛错（需 ref 却选无需元素 / 需文本却选无）', () => {
  assert.throws(() => AutoCore.planExecution({ action: 'click', param: '无需元素', text: '无' }, VARS), /无需元素/);
  assert.throws(() => AutoCore.planExecution({ action: 'fill', param: 'e3', text: '无' }, VARS), /文本/);
  assert.throws(() => AutoCore.planExecution({ action: '生成输入', param: '无需元素', text: '无' }, VARS), /无需元素/);
});

/* ---------- shouldTerminate ---------- */

test('shouldTerminate：未完成度连续两轮 <0.2 判完成', () => {
  assert.deepStrictEqual(
    AutoCore.shouldTerminate({ steps: 3, maxSteps: 15, unfinishedHistory: [0.8, 0.19, 0.15], consecutiveFails: 0 }),
    { done: true, reason: '任务完成（Jev 连续两轮判定未完成度 < 0.2）' });
  assert.strictEqual(
    AutoCore.shouldTerminate({ steps: 3, maxSteps: 15, unfinishedHistory: [0.19, 0.25], consecutiveFails: 0 }), null);
  assert.strictEqual(
    AutoCore.shouldTerminate({ steps: 1, maxSteps: 15, unfinishedHistory: [0.1], consecutiveFails: 0 }), null);
});

test('shouldTerminate：步数上限 / 连续失败 / 用户中止', () => {
  assert.deepStrictEqual(
    AutoCore.shouldTerminate({ steps: 15, maxSteps: 15, unfinishedHistory: [0.5], consecutiveFails: 0 }),
    { done: false, reason: '达到步数上限（15）' });
  assert.deepStrictEqual(
    AutoCore.shouldTerminate({ steps: 5, maxSteps: 15, unfinishedHistory: [0.5], consecutiveFails: 3 }),
    { done: false, reason: '连续 3 步执行失败' });
  assert.deepStrictEqual(
    AutoCore.shouldTerminate({ steps: 2, maxSteps: 15, unfinishedHistory: [0.5], consecutiveFails: 0, aborted: true }),
    { done: false, reason: '用户中止' });
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
