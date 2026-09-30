/* 并行召回 · 全链路（无浏览器）
 * 走真实链路：首轮三道题（参数只给前 size 个）→ 动作需要元素 → 并行召回其余 →
 * 合并（首轮前 N 个作 seed）→ 最终一次「参数」决策。
 * 上游是 tests/e2e/mock-server.js 的 oracle（它逐请求校验问题构造契约），
 * 所以这一条覆盖了四件事：切批正确、触发条件正确、召回把目标捞回来、最终决策落在候选集内。
 * 不需要浏览器，`npm test` 就能跑 —— E2E 那套要真浏览器，本文件是它的快速替身。 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AutoCore = require(path.join(ROOT, 'public', 'js', 'auto-core.js'));
const { startMocks } = require(path.join(ROOT, 'tests', 'e2e', 'mock-server.js'));

/* oracle 的目标：goal 命中「订单状态」分支 → 目标 ref = 订单状态下拉框（e15）。
 * 夹具里「已付款待发货」本就是 selected，oracle 会直接判「任务已完成」而拿不到 ref ——
 * 去掉这个标记，让三步（首轮 / 召回 / 决策）都有 ref 可对账。 */
const GOAL = '在「订单状态」下拉框选择「已付款待发货」';
const SNAPSHOT = require(path.join(ROOT, 'tests', 'fixtures', 'orders-snapshot.js')).replace(/\[selected\]/g, '');

function post(port, payload) {
  return fetch('http://127.0.0.1:' + port + '/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  }).then((r) => r.json());
}

test('全链路：首轮 3 题（前 200 个）→ 召回其余 → 合并（带首轮前 N 个种子）→ 最终决策命中目标', async (t) => {
  const mocks = await startMocks();
  t.after(() => mocks.close());

  const state = AutoCore.buildState({
    goal: GOAL, url: 'http://127.0.0.1/orders.html', title: '订单管理',
    snapshot: SNAPSHOT, history: [], lastResult: '',
  });
  const trim = AutoCore.normalizeTrim();
  assert.strictEqual(trim.algorithm, 'parallel', '并行召回必须是默认算法');
  assert.strictEqual(trim.size, 200, '批次大小默认 200');

  /* ① 切批：392 个 ref → 首轮看前 200，其余 192 一批召回 */
  const plan = AutoCore.recallPlan({ snapshot: SNAPSHOT, paramTrim: trim });
  assert.ok(plan, '392 个元素的页面必须走并行召回');
  assert.strictEqual(plan.meta.firstSize, 200);
  assert.strictEqual(plan.meta.batches, 1, '只剩一段 → 只有一个并行召回');

  /* ② 首轮：仍是三道题，「参数」候选只有前 200 个 */
  const round1 = AutoCore.buildQuestions({
    snapshot: SNAPSHOT, variables: [],
    param: { criteria: plan.first.criteria, meta: Object.assign({}, plan.meta, { first: true }) },
  });
  assert.strictEqual(Object.keys(round1).length, 3, '首轮仍是三题');
  assert.strictEqual(Object.keys(round1['参数'].criteria).length, 200);
  const r1 = await post(mocks.sysonePort, { state, model: 'mock-jev', questions: round1 });
  const d1 = { action: r1.answers['动作'].choice, param: (r1.answers['参数'] || {}).choice || null };
  assert.strictEqual(d1.action, 'select');
  assert.strictEqual(AutoCore.shouldRecall(plan, d1), true, '动作需要定位元素 → 触发召回');

  /* ③ 并行召回：K 批，各批只看自己那一段。
   * 这里把**整封响应**（{model, answers:{参数:…}}）收起来原样喂给合并 —— 前端就是这么喂的。
   * 曾经这条测试自己剥了壳（answers['参数']），于是前端少剥一层的事故从测试底下溜过去了。 */
  const responses = [];
  for (let i = 1; i <= plan.meta.batches; i++) {
    responses.push(await post(mocks.sysonePort, {
      state, model: 'mock-jev', questions: AutoCore.buildRecallQuestions(plan, i),
    }));
  }
  /* 首轮那次「参数」作答 → 种子（前 topN 个，作答的那个必在其中） */
  const seeds = AutoCore.recallSeeds({ plan: plan, answer: r1 });
  assert.strictEqual(seeds[0], d1.param, '首轮作答的 ref 排在种子最前');
  assert.ok(seeds.length >= 1 && seeds.length <= plan.meta.topN, '种子数不超过 topN');
  assert.ok(seeds.every((r) => plan.first.criteria[r]), '种子只能来自首轮那一段');

  const merged = AutoCore.mergeRecall(plan, responses, { seed: seeds });
  assert.ok(merged.criteria.e15, '订单状态下拉框必须被召回或被首轮预测带进来');
  assert.deepStrictEqual(merged.meta.seeded, seeds, '首轮前 N 个都进候选');
  assert.strictEqual(Object.keys(merged.criteria)[0], seeds[0], '首轮作答排最前');
  assert.strictEqual(merged.criteria['其他'], undefined, '并行召回没有兜底项');
  merged.meta.perBatch.forEach((p) => {
    assert.strictEqual(p.choiceInBatch, true, '每批的作答都必须落在本批候选内');
    assert.ok(p.recalled.length <= plan.meta.topN, '每批召回数不得超过每批召回数上限');
  });
  assert.ok(merged.meta.recalled > 0, '召回不能是 0（传错一层的静默失败模式）');
  assert.ok(Object.keys(merged.criteria).length < 255, '候选总数不超接口硬上限');

  /* ④ 最终决策：候选 = 首轮预测 + 召回合并，答案必须落在候选集内 */
  const pick = AutoCore.buildRecallPickQuestions({
    criteria: merged.criteria, meta: merged.meta, action: d1.action,
  });
  assert.strictEqual(Object.keys(pick).join(','), '参数', '最终决策只问题「参数」');
  assert.ok(pick['参数'].criteria.e15);
  const r3 = await post(mocks.sysonePort, { state, model: 'mock-jev', questions: pick });
  assert.strictEqual(r3.answers['参数'].choice, 'e15', '最终决策必须命中订单状态下拉框');

  /* ⑤ 契约与计数：首轮 1 + 召回 K + 决策 1 */
  const rep = await mocks.report();
  assert.deepStrictEqual(rep.violations, [], 'mock 逐请求契约校验必须零违规');
  assert.strictEqual(rep.reqCount, 1 + plan.meta.batches + 1);
});

test('触发条件：动作不需要定位元素时，一个召回请求都不发', () => {
  const plan = AutoCore.recallPlan({ snapshot: SNAPSHOT, paramTrim: AutoCore.normalizeTrim() });
  assert.ok(plan, '计划存在（页面元素超一批）');
  /* 这些动作即使页面超限也不该触发召回：终止态 / 导航类 / 生成输入（产品定的） */
  ['任务已完成', 'goto', 'reload', 'go-back', 'go-forward',
    'press', 'tab-list', 'tab-select', 'tab-close', '生成输入'].forEach((a) => {
    assert.strictEqual(AutoCore.shouldRecall(plan, { action: a }), false, a + ' 不该触发并行召回');
  });
  /* 需要定位元素的那几个动作才触发 */
  ['click', 'fill', 'type', 'select', 'check', 'uncheck', 'hover'].forEach((a) => {
    assert.strictEqual(AutoCore.shouldRecall(plan, { action: a }), true, a + ' 应该触发并行召回');
  });
});

test('并行召回的候选一路带定位提示（同名元素在最终决策里仍可分）', async (t) => {
  const mocks = await startMocks();
  t.after(() => mocks.close());
  const resume = require(path.join(ROOT, 'tests', 'fixtures', 'resume-snapshot.js'));
  const plan = AutoCore.recallPlan({ snapshot: resume, paramTrim: AutoCore.normalizeTrim() });
  assert.match(plan.labels.e172, /（在「候选人 .+」内）/, '定位提示由 ref-context 统一产出');
  /* 首轮那一段也要带提示：首轮候选里同样有一堆同名「邀请面试」 */
  const firstInvite = Object.keys(plan.first.criteria).find((r) => /button "邀请面试"/.test(plan.first.criteria[r]));
  assert.ok(firstInvite, '首轮那一段里应有同名「邀请面试」按钮');
  assert.match(plan.first.criteria[firstInvite], /（在「候选人 .+」内）/, '首轮候选同样要能分清卡片');
  /* 召回段的 ref：批内描述与合并后必须逐字一致，否则最终决策无从判断 */
  const inBatch = Object.keys(plan.batches[0].criteria)[0];
  const merged = AutoCore.mergeRecall(plan, plan.batches.map((b) => ({
    choice: Object.keys(b.criteria)[0],
    probabilities: { [Object.keys(b.criteria)[0]]: 0.9 },
  })), { seed: [inBatch] });
  assert.strictEqual(merged.criteria[inBatch], plan.labels[inBatch]);
  assert.match(merged.criteria[inBatch], /（在「候选人 .+」内）/);
});
