/* ref-recall 单测：并行召回的切批与合并（纯逻辑，确定性）
 * 用真实快照夹具（resume.html 393 ref / orders.html 392 ref），与 ref-funnel.spec.js 同一批样本 ——
 * 两条算法路线跑在同一份真实输入上，谁都不会因为「只在合成样本上成立」而漏掉回归。
 *
 * 切批规则（产品定的）：一页 ref 按 size 切成**前段 + 其余**：
 *   前段 = 首轮「参数」题的候选；其余按 size 切 K 批交给并行召回。
 * 于是「并行召回不包含首轮看过的那部分」是切法自带的性质，不靠事后剔除。 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const Recall = require(path.join(ROOT, 'public', 'js', 'ref-recall.js'));
const Funnel = require(path.join(ROOT, 'public', 'js', 'ref-funnel.js'));
const Context = require(path.join(ROOT, 'public', 'js', 'ref-context.js'));
const U = require(path.join(ROOT, 'public', 'js', 'util.js'));

const RESUME_SNAPSHOT = require(path.join(ROOT, 'tests', 'fixtures', 'resume-snapshot.js'));
const ORDERS_SNAPSHOT = require(path.join(ROOT, 'tests', 'fixtures', 'orders-snapshot.js'));
/* 真机响应信封（会话 r-0928-1954-4dgf，469 个 ref 的客服工作台，两批召回）——
 * 「传错一层」事故的物证，见下面的信封回归测试 */
const ENVELOPES_1954 = require(path.join(ROOT, 'tests', 'fixtures', 'jev-recall-envelopes-1954.js'));
const SMALL_SNAPSHOT = '- button "归档" [ref=e1]\n- button "删除" [ref=e2]\n- generic: 对账单\n';

const allRefsOf = (snapshot) => U.parseSnapshotRefs(snapshot).map((r) => r.ref);
const batchRefs = (plan) => plan.batches.reduce((acc, b) => acc.concat(b.refs.map((r) => r.ref)), []);

/* 造一份「按批作答」的样本：probs 里的键就是该批候选，非 0 概率的按降序排 */
function answerFor(criteria, picks) {
  const probabilities = {};
  picks.forEach(([ref, p]) => { probabilities[ref] = p; });
  return { type: 'choice', choice: picks.length ? picks[0][0] : null, probabilities, confidence: 0.8 };
}

test('切批（用户举例）：400 个 ref / size 200 → 首轮 200 个，并行召回 1 批 200 个', () => {
  const refs = [];
  for (let i = 1; i <= 400; i++) refs.push(`- button "b${i}" [ref=e${i}]`);
  const plan = Recall.planBatches(refs.join('\n'), { size: 200, topN: 15 });

  assert.strictEqual(plan.meta.totalRefs, 400);
  assert.strictEqual(plan.meta.firstSize, 200, '首轮「参数」候选 = 前 200 个');
  assert.strictEqual(plan.meta.size, 200);
  assert.strictEqual(plan.meta.batches, 1, '其余 200 个正好一批 → 只有一个并行召回');
  assert.strictEqual(plan.meta.parallel, true);
  assert.deepStrictEqual(plan.batches[0].refs.map((r) => r.ref).slice(0, 2), ['e201', 'e202']);
  assert.strictEqual(Object.keys(plan.batches[0].criteria).length, 200);
});

test('切批：前段与召回段不重叠、合起来正好是全部 ref（不丢元素、不重复）', () => {
  const plan = Recall.planBatches(RESUME_SNAPSHOT, { size: 80, topN: 15 });
  assert.strictEqual(plan.meta.totalRefs, 393);
  assert.strictEqual(plan.meta.firstSize, 80);
  assert.deepStrictEqual(plan.batches.map((b) => b.refs.length), [80, 80, 80, 73], '其余 313 个按 80 切 4 批');

  const first = plan.first.refs.map((r) => r.ref);
  const rest = batchRefs(plan);
  assert.strictEqual(first.length + rest.length, 393);
  assert.strictEqual(new Set(first.concat(rest)).size, 393, '合起来不重不漏');
  /* 「并行召回的 ref 集合不包含首轮 Jev 预测的那部分」← 这条由切法保证 */
  const overlap = first.filter((r) => rest.includes(r));
  assert.deepStrictEqual(overlap, [], '首轮看过的那一段不得进入召回范围');
  assert.deepStrictEqual(first.concat(rest), allRefsOf(RESUME_SNAPSHOT), '切批顺序 = 快照顺序');
});

test('切批：元素不超一批时没有召回批次（调用方走单次调用，零额外请求）', () => {
  const plan = Recall.planBatches(SMALL_SNAPSHOT, { size: 80 });
  assert.strictEqual(plan.meta.batches, 0);
  assert.strictEqual(plan.meta.parallel, false);
  assert.strictEqual(Object.keys(plan.first.criteria).length, 2, '首轮候选 = 全部 2 个');
  assert.deepStrictEqual(batchRefs(plan), []);
});

test('参数夹取：size 夹到 10–250，topN 不得超过一批的容量', () => {
  assert.strictEqual(Recall.planBatches(SMALL_SNAPSHOT, { size: 1 }).meta.size, 10);
  assert.strictEqual(Recall.planBatches(SMALL_SNAPSHOT, { size: 999 }).meta.size, 250);
  assert.strictEqual(Recall.planBatches(RESUME_SNAPSHOT, { size: 10, topN: 99 }).meta.topN, 10, 'topN > size 会变成空话');
  assert.strictEqual(Recall.planBatches(RESUME_SNAPSHOT, { size: 80, topN: 0 }).meta.topN, 1);
});

test('候选描述与相关性裁剪路线逐字一致（同一个 ref 在两条路线上长得一样）', () => {
  const plan = Recall.planBatches(RESUME_SNAPSHOT, { size: 80 });
  const f = Funnel.buildBoundedRefCriteria(RESUME_SNAPSHOT, { goal: 'x', limit: 80, batch: 1, maxTranches: 3 });
  const e172 = plan.labels.e172;
  assert.ok(e172, 'e172（唯一合格候选人的邀请按钮）');
  assert.strictEqual(e172, f.criteria.e172, '同一 ref 的描述必须逐字相同（含定位提示）');
  assert.match(e172, /邀请面试/);
  assert.match(e172, /（在「候选人 .+」内）/, '同名按钮必须带卡片定位提示，否则合并后无法区分');
  /* 首轮候选与召回批次里，同一个 ref 的描述也必须一致 */
  const carrier = plan.batches.find((b) => b.criteria.e172) || plan.first;
  assert.strictEqual(carrier.criteria.e172, e172);
});

test('pickFromAnswer：按概率降序取前 N，批外键与 0 概率项都不算「概率召回」', () => {
  const plan = Recall.planBatches(RESUME_SNAPSHOT, { size: 80 });
  const batch = plan.batches[0];
  const keys = Object.keys(batch.criteria);
  const probs = { [keys[3]]: 0.5, [keys[1]]: 0.3, [keys[2]]: 0, e9999: 0.9 };
  /* 没有 choice 时：纯粹按概率排序，批外键（e9999）与 0 概率项（keys[2]）都不算召回 */
  const pure = Recall.pickFromAnswer(batch.criteria, { probabilities: probs }, 15);
  assert.deepStrictEqual(pure.map((x) => x.ref), [keys[3], keys[1]]);
  /* 有 choice 时它恒排最前（模型自己选的），其余仍按概率 */
  const withChoice = Recall.pickFromAnswer(batch.criteria, { choice: keys[0], probabilities: probs }, 15);
  assert.deepStrictEqual(withChoice.map((x) => x.ref), [keys[0], keys[3], keys[1]]);
});

test('pickFromAnswer：没有概率（旧协议）时退回 choice 一项，保证召回不空手', () => {
  const plan = Recall.planBatches(RESUME_SNAPSHOT, { size: 80 });
  const batch = plan.batches[0];
  const key = Object.keys(batch.criteria)[5];
  assert.deepStrictEqual(Recall.pickFromAnswer(batch.criteria, { choice: key }, 15).map((x) => x.ref), [key]);
  /* 作答落在批外 → 这一批没有任何召回，不编造 */
  assert.deepStrictEqual(Recall.pickFromAnswer(batch.criteria, { choice: 'e9999' }, 15), []);
  assert.deepStrictEqual(Recall.pickFromAnswer(batch.criteria, null, 15), []);
});

test('pickFromAnswer：作答的 choice 落在概率分布之外（或概率为 0）也必须被召回', () => {
  /* 实测事故：真机响应里 choice 不在 probabilities 的键里，只认 p>0 会让整批召回清空，
   * 于是「所有批次都召回 0 个」→ 退回裁剪候选 → 那一份带「其他」→ 连烧三步 */
  const plan = Recall.planBatches(RESUME_SNAPSHOT, { size: 80 });
  const batch = plan.batches[0];
  const keys = Object.keys(batch.criteria);
  const outside = Recall.pickFromAnswer(batch.criteria,
    { choice: keys[7], probabilities: { [keys[1]]: 0.4, [keys[2]]: 0.3 } }, 15);
  assert.strictEqual(outside[0].ref, keys[7], 'choice 不在分布里 → 排最前收进来');
  assert.deepStrictEqual(outside.map((x) => x.ref), [keys[7], keys[1], keys[2]]);
  const zero = Recall.pickFromAnswer(batch.criteria,
    { choice: keys[9], probabilities: { [keys[9]]: 0, [keys[3]]: 0.5 } }, 15);
  assert.strictEqual(zero[0].ref, keys[9], 'choice 概率为 0 → 仍然收进来（模型自己选的）');
  /* 概率全 0 也不能空手 */
  const allZero = Recall.pickFromAnswer(batch.criteria,
    { choice: keys[4], probabilities: { [keys[4]]: 0, [keys[5]]: 0 } }, 15);
  assert.deepStrictEqual(allZero.map((x) => x.ref), [keys[4]]);
});

test('合并：各批召回求并集、去重取最大概率、不超过 250，且不含「其他」兜底项', () => {
  const plan = Recall.planBatches(RESUME_SNAPSHOT, { size: 80, topN: 15 });
  /* 每批用它**自己**的候选键作答（拿别批的键作答会被「批外键丢弃」规则滤掉 —— 那条规则本身有单测） */
  const k = (i) => Object.keys(plan.batches[i].criteria);
  const answers = [
    answerFor(plan.batches[0].criteria, [[k(0)[0], 0.5], [k(0)[1], 0.4], [k(0)[2], 0.3]]),
    /* 第 2 批整批失败（null）：不贡献任何候选，也不影响其它批 */
    null,
    answerFor(plan.batches[2].criteria, [[k(2)[0], 0.6], [k(2)[1], 0.2], [k(2)[2], 0.1]]),
    answerFor(plan.batches[3].criteria, [[k(3)[0], 0.9]]),
  ];
  const merged = Recall.mergeBatches(plan, answers, {});

  assert.strictEqual(merged.meta.recalled, 7, '3 + 0 + 3 + 1');
  assert.strictEqual(merged.meta.merged, 7);
  assert.strictEqual(merged.meta.clamped, 0);
  assert.strictEqual(merged.meta.perBatch.length, 4);
  assert.deepStrictEqual(merged.meta.perBatch[1].recalled, [], '失败批次记空，不伪造召回');
  assert.strictEqual(merged.criteria['其他'], undefined, '并行召回不提供「其他」：候选就在这里，直接决策');
  assert.strictEqual(Object.keys(merged.criteria)[0], k(3)[0], '概率最高的排最前');
  assert.strictEqual(Object.keys(merged.criteria).length, 7);
  assert.strictEqual(merged.criteria[k(2)[0]], plan.batches[2].criteria[k(2)[0]], '合并后描述与批内一致');
});

test('合并：首轮预测（seed）排在候选最前面 —— 它所在那一段不在召回范围里，只能由它代表', () => {
  const plan = Recall.planBatches(RESUME_SNAPSHOT, { size: 80, topN: 15 });
  const seed = plan.first.refs[3].ref;
  const answers = plan.batches.map((b) => answerFor(b.criteria,
    Object.keys(b.criteria).slice(0, 2).map((k, i) => [k, 0.9 - i / 10])));
  const merged = Recall.mergeBatches(plan, answers, { seed: [seed] });
  assert.deepStrictEqual(merged.meta.seeded, [seed]);
  assert.strictEqual(Object.keys(merged.criteria)[0], seed, '首轮预测排最前（最终决策先看到它）');
  assert.strictEqual(merged.meta.merged, 1 + plan.batches.length * 2, '候选 = 首轮预测 + 各批召回');
  /* seed 不是本页真实 ref（模型乱答）→ 丢弃，不编造候选 */
  const bad = Recall.mergeBatches(plan, answers, { seed: ['e99999'] });
  assert.deepStrictEqual(bad.meta.seeded, []);
  assert.strictEqual(bad.criteria.e99999, undefined);
});

test('合并：召回并集超过 250 时按序截断并记 clamped（绝不发会被接口拒的请求）', () => {
  const refs = [];
  for (let i = 1; i <= 800; i++) refs.push(`- button "b${i}" [ref=e${i}]`);
  const plan = Recall.planBatches(refs.join('\n'), { size: 250, topN: 250 });
  assert.strictEqual(plan.meta.batches, 3, '前 250 + 其余 550 切 3 批');
  const answers = plan.batches.map((b) => answerFor(b.criteria,
    Object.keys(b.criteria).map((k, i) => [k, 1 - i / 1000])));
  const merged = Recall.mergeBatches(plan, answers, {});
  assert.strictEqual(merged.meta.recalled, 550);
  assert.strictEqual(merged.meta.merged, Recall.MERGE_MAX);
  assert.strictEqual(merged.meta.clamped, 550 - Recall.MERGE_MAX);
});

test('确定性：同一份输入两次调用逐字节相同（可被 fixture 锁住，步骤卡展示 = 实际发出）', () => {
  const run = () => {
    const plan = Recall.planBatches(ORDERS_SNAPSHOT, { size: 200, topN: 15 });
    const answers = plan.batches.map((b) => {
      const keys = Object.keys(b.criteria);
      return answerFor(b.criteria, keys.slice(0, 5).map((k, i) => [k, 1 - i / 100]));
    });
    const m = Recall.mergeBatches(plan, answers, { seed: [plan.first.refs[1].ref] });
    return JSON.stringify({
      first: plan.first.criteria, batches: plan.batches.map((b) => b.criteria),
      merged: m.criteria, meta: m.meta,
    });
  };
  assert.strictEqual(run(), run());
});

test('召回阶段不吞真答案：目标批次给出高概率时，合并结果里必定有它', () => {
  const plan = Recall.planBatches(RESUME_SNAPSHOT, { size: 80, topN: 15 });
  /* 真答案 e172 落在召回段的某一批里（首轮那一段没有它） */
  const target = plan.batches.findIndex((b) => b.criteria.e172);
  assert.ok(target >= 0, 'e172 必须在召回范围内');
  const answers = plan.batches.map((b, i) => {
    /* 噪声键要排除真答案，否则同一个键被写两遍、后写的概率覆盖前者（样本构造坑，不是实现坑） */
    const keys = Object.keys(b.criteria).filter((k) => k !== 'e172');
    if (i === target) return answerFor(b.criteria, [['e172', 0.62]].concat(keys.slice(0, 14).map((k, j) => [k, 0.2 - j / 100])));
    return answerFor(b.criteria, keys.slice(0, 15).map((k, j) => [k, 0.1 - j / 1000]));
  });
  const merged = Recall.mergeBatches(plan, answers, {});
  assert.ok(merged.criteria.e172, 'e172 必须在最终候选里');
  assert.strictEqual(Object.keys(merged.criteria)[0], 'e172', '概率最高的排最前，最终决策先看到它');
});

test('pickFromAnswer：作答的 ref 恒在召回清单第一位 —— 概率很小（排 topN 之外）也不例外', () => {
  /* 实测缺陷：choice 的 p 是「小正数」时，它确实在概率列表里，只是排在后面，
   * 被 slice(0, topN) 一刀切掉 —— 于是 meta 里 choiceInBatch=true 而 recalled 里没有它，
   * 模型自己选的元素压根没进最终候选（15 个种子/召回里全是别的） */
  const plan = Recall.planBatches(RESUME_SNAPSHOT, { size: 80, topN: 15 });
  const batch = plan.batches[0];
  const keys = Object.keys(batch.criteria);
  const probabilities = {};
  keys.slice(0, 15).forEach((k, i) => { probabilities[k] = 0.9 - i / 100; });   /* 前 15 个吃满 */
  probabilities[keys[30]] = 0.002;                                            /* 作答：小正数，排第 16 */
  const ans = { choice: keys[30], probabilities: probabilities };
  const picks = Recall.pickFromAnswer(batch.criteria, ans, 15);
  assert.strictEqual(picks.length, 15);
  assert.strictEqual(picks[0].ref, keys[30], '作答的 ref 必须排第一位（它就是模型的选择）');
  assert.ok(picks.some((x) => x.ref === keys[30]));
  /* 与 meta 自洽：choiceInBatch 为真 ⇒ recalled 里一定有它 */
  const merged = Recall.mergeBatches(plan, plan.batches.map((b, i) => (i === 0 ? ans
    : answerFor(b.criteria, [['e9999', 0.9]]))), {});
  assert.strictEqual(merged.meta.perBatch[0].choiceInBatch, true);
  assert.ok(merged.meta.perBatch[0].recalled.includes(keys[30]), 'choiceInBatch=true 时 recalled 必须含它');
  assert.strictEqual(merged.meta.perBatch[0].recalled.length, 15);
  /* 概率更小的作答也照样第一（不会被尾部候选顶掉） */
  const tiny = Recall.pickFromAnswer(batch.criteria, { choice: keys[40], probabilities: { [keys[0]]: 0.99 } }, 15);
  assert.strictEqual(tiny[0].ref, keys[40]);
});

test('共用契约：hintsOf 与 criterionText 的输出和 funnel 内部一致', () => {
  const hints = Context.hintsOf(RESUME_SNAPSHOT);
  assert.match(hints.e172, /候选人 .+/, 'e172 的定位提示来自所在卡片');
  assert.strictEqual(Context.criterionText({ label: 'button "邀请面试"', interactive: true, ancestor: hints.e172 }),
    '【可交互】 button "邀请面试"（在「' + Context.shortName(hints.e172) + '」内）');
  /* 自身标签已含祖先名时不重复追加 */
  const dup = Context.criterionText({ label: 'article "候选人 周一鸣"', interactive: false, ancestor: '候选人 周一鸣' });
  assert.strictEqual(dup, '【容器/静态】 article "候选人 周一鸣"');
});

/* =============== 真机响应信封（事故回归） ===============
 * 事故：调用方把 callJev 的整封信（{model, answers:{参数:…}}）喂进纯逻辑，
 * 纯逻辑只认内层作答 → 每批都召回 0 个 → 最终候选只剩首轮那一个（面板写「候选 1 个」）。
 * 契约从此是「信封与作答两种形状都收」：下面的样本就是那次会话的真实响应。 */

/* 用真实响应的概率键当作该批候选，手工拼一个 plan（等价于快照切出来的那一批） */
function planFromEnvelopes(envs, topN) {
  const batches = envs.map((e, i) => {
    const crit = Object.create(null);
    Object.keys(e.answers['参数'].probabilities).forEach((k) => { crit[k] = '【可交互】 button "发货" [批 ' + (i + 1) + ']'; });
    const refs = Object.keys(crit).map((r) => ({ ref: r, label: crit[r], interactive: true }));
    return { index: i + 1, refs: refs, criteria: crit };
  });
  const labels = Object.create(null);
  batches.forEach((b) => Object.keys(b.criteria).forEach((k) => { labels[k] = b.criteria[k]; }));
  return { labels: labels, first: { refs: [], criteria: Object.create(null) }, batches: batches,
    meta: { algorithm: 'parallel', totalRefs: 469, size: 200, topN: topN || 15, firstSize: 200, batches: batches.length, parallel: true } };
}

test('answerOf：整封信与内层作答等价（事故的直接回归）', () => {
  const env = ENVELOPES_1954[0];
  const inner = env.answers['参数'];
  assert.strictEqual(Recall.answerOf(env), inner, '信封 → 内层作答');
  assert.strictEqual(Recall.answerOf(inner), inner, '已经是作答 → 原样返回（幂等）');
  assert.strictEqual(Recall.answerOf(null), null);
  /* 名不对但只有一道题 → 认它；多题且名不对 → 不猜，返回 null */
  assert.strictEqual(Recall.answerOf({ answers: { '动作': inner } }), inner);
  assert.strictEqual(Recall.answerOf({ answers: { '动作': inner, '参数': inner } }), inner);
  assert.strictEqual(Recall.answerOf({ answers: { a: inner, b: inner } }), null);
});

test('真机信封：每批召回 15 个（事故当时是 0 个），choice 恒在召回里', () => {
  const plan = planFromEnvelopes(ENVELOPES_1954);
  const merged = Recall.mergeBatches(plan, ENVELOPES_1954, {});
  assert.strictEqual(merged.meta.perBatch.length, 2);
  merged.meta.perBatch.forEach((p) => {
    assert.strictEqual(p.recalled.length, 15, '每批按概率取前 15');
    assert.strictEqual(p.choiceInBatch, true, 'choice 必须落在本批候选内（事故时是 false）');
    assert.strictEqual(p.recalled[0], p.choice, 'choice 排最前');
  });
  assert.strictEqual(merged.meta.recalled, 30, '两批各 15 个');
  /* 两批的 choice 都是「发货」按钮 —— 模型当时就看对了地方，是接线把结果丢了 */
  assert.deepStrictEqual(merged.meta.perBatch.map((p) => p.choice), ['e723', 'e970']);
  /* 信封喂进去与「先剥壳再喂」必须逐字节相同：调用方传哪一种都不该有区别 */
  const peeled = Recall.mergeBatches(plan, ENVELOPES_1954.map((e) => Recall.answerOf(e)), {});
  assert.deepStrictEqual(Object.keys(peeled.criteria), Object.keys(merged.criteria));
  assert.deepStrictEqual(peeled.meta.perBatch, merged.meta.perBatch);
});

test('种子（首轮前 N 个）：15 个一起进候选、按概率序排在召回结果之前、去重不重复计数', () => {
  const plan = Recall.planBatches(RESUME_SNAPSHOT, { size: 80, topN: 15 });
  const first = Object.keys(plan.first.criteria);
  /* 首轮作答：分布只给前 20 个（真机也是这样：非零项十几二十个，长尾很小） */
  const answer = { choice: first[0], probabilities: {} };
  first.slice(0, 20).forEach((k, i) => { answer.probabilities[k] = 0.4 - i / 100; });
  const seeds = Recall.pickFromAnswer(plan.first.criteria, answer, 15).map((x) => x.ref);
  assert.strictEqual(seeds.length, 15, '首轮前 15 个进最终候选（不再只带作答的那一个）');
  assert.strictEqual(seeds[0], first[0], '作答的排最前（它概率也最高）');

  const answers = plan.batches.map((b) => answerFor(b.criteria, [['e9999', 0.9]]));   /* 召回全落空 */
  const merged = Recall.mergeBatches(plan, answers, { seed: seeds });
  assert.deepStrictEqual(merged.meta.seeded, seeds);
  assert.deepStrictEqual(Object.keys(merged.criteria), seeds, '召回为空时候选就是首轮前 15 个（不再是 1 个）');

  /* 种子与召回重合时不重复计数 */
  const hit = Object.keys(plan.batches[0].criteria)[0];
  const overlap = Recall.mergeBatches(plan, plan.batches.map((b, i) => answerFor(b.criteria,
    i === 0 ? [[hit, 0.9]] : [['e9999', 0.9]])), { seed: seeds.concat([hit]) });
  assert.strictEqual(overlap.meta.merged, 15 + 1, '重合的 ref 只算一次');
  assert.strictEqual(Object.keys(overlap.criteria).length, 15 + 1);
});

test('上限是「种子 + 召回」共用的那一条 255 硬上限（不是各算 250）', () => {
  const refs = [];
  for (let i = 1; i <= 800; i++) refs.push(`- button "b${i}" [ref=e${i}]`);
  const plan = Recall.planBatches(refs.join('\n'), { size: 250, topN: 250 });
  const answers = plan.batches.map((b) => answerFor(b.criteria,
    Object.keys(b.criteria).map((k, i) => [k, 1 - i / 1000])));
  const seeds = plan.first.refs.slice(0, 15).map((r) => r.ref);
  const merged = Recall.mergeBatches(plan, answers, { seed: seeds });
  assert.strictEqual(Object.keys(merged.criteria).length, Recall.MERGE_MAX, '候选总数封在 250');
  assert.strictEqual(merged.meta.merged, Recall.MERGE_MAX);
  assert.strictEqual(merged.meta.seeded.length, 15);
  assert.strictEqual(merged.meta.recalled, 550, '召回并集仍是 550（截断 235 + 种子 15）');
  assert.strictEqual(merged.meta.clamped, 550 - (Recall.MERGE_MAX - 15));
  assert.ok(Object.keys(merged.criteria).length < 255, '绝不发会被接口拒的请求');
});
