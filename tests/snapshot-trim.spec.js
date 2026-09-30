/* snapshot-trim 纯逻辑测试：三刀快照裁剪（体积预算 / 零回归 / ref 一致性）
 *
 * 事故链条：快照随 state 全量发给 Jev，超上游上下文窗口即整轮终止
 * （会话 r-0928-1625-cyom：GitHub 仓库页快照 131KB / 1899 行 → 约 50,800 input
 * tokens → {"detail":{"error_type":"max_tokens_exceeded"}}，重试必然同样失败）。
 * 实测边界：请求 83KB / 28,175 tokens 成功，97KB / 32,698 tokens 失败。
 *
 * 这个文件盯死三件事：
 *   ① 没超预算时**逐字节零回归**（同一字符串，不是内容相等）
 *   ② 裁后 ref ⊆ 原 ref，且候选问题里的 ref 必须在裁后快照里找得到
 *   ③ 保留下拉框的 ref 时，它的 option 名单必须完整（否则静默回退变量池）
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const SnapshotTrim = require(path.join(ROOT, 'public', 'js', 'snapshot-trim.js'));
const AutoCore = require(path.join(ROOT, 'public', 'js', 'auto-core.js'));

const ORDERS = require(path.join(ROOT, 'tests', 'fixtures', 'orders-snapshot.js'));
const RESUME = require(path.join(ROOT, 'tests', 'fixtures', 'resume-snapshot.js'));
/* 中文 + 订单号密集的表格页（614 个 ref）：tokens/byte 实测 0.424，并行召回的候选描述重达 30KB。
 * 默认预算这条线就是被它顶下来的，见下面「默认预算」那组测试。 */
const COMPLEX = require(path.join(ROOT, 'tests', 'fixtures', 'orders-complex-snapshot.js'));
const COMPLEX_GOAL = '客服接到一位金卡会员的催单：这笔订单买的是 AirPods Pro 2 正品耳机，'
  + '已经付款但仓库还没安排出库。请把这一笔订单标记为已发货，其余订单一律保持原样。'
  + '注意别发错——保护套、耳塞这类配件，以及 AirPods 4 等其它型号，都不是这位会员买的那个。';

const bytes = (s) => Buffer.byteLength(String(s), 'utf8');
const refKeys = (t) => Object.keys(AutoCore.refCriteria(t)).sort();
const GOAL = '在订单列表里找到买家留言要求 25 号前送到的那一单，展开它的详情';

/* ---------- 零回归 ---------- */

test('truncate：没超预算时原样返回同一个字符串（逐字节零回归）', () => {
  const r = SnapshotTrim.truncate({ snapshot: ORDERS, goal: GOAL, budgetBytes: 1000000 });
  assert.strictEqual(r.text, ORDERS, '没超预算却改动了内容');
  assert.strictEqual(r.meta.trimmed, false);
  assert.deepStrictEqual(r.meta.rungs, [], '没超预算却动了刀');
  assert.strictEqual(r.meta.before, bytes(ORDERS));
  assert.strictEqual(r.meta.totalRefs, 392);
});

test('truncate：空快照与非字符串输入原样返回，不抛', () => {
  [['', ''], [null, ''], [undefined, '']].forEach(([input, want]) => {
    const r = SnapshotTrim.truncate({ snapshot: input, goal: GOAL, budgetBytes: 1000 });
    assert.strictEqual(r.text, want, '输入 ' + JSON.stringify(input) + ' 被改动');
    assert.strictEqual(r.meta.trimmed, false);
  });
});

/* ---------- 预算 ---------- */

test('truncate：超预算必进预算（orders 全量，预算压到 4000 字节）', () => {
  const r = SnapshotTrim.truncate({ snapshot: ORDERS, goal: GOAL, budgetBytes: 4000 });
  assert.ok(bytes(r.text) <= 4000, '仍超预算：' + bytes(r.text));
  assert.strictEqual(r.meta.trimmed, true);
  assert.ok(r.meta.rungs.length > 0, '裁了却没记下用了哪几刀');
  assert.strictEqual(r.meta.before, bytes(ORDERS));
  assert.strictEqual(r.meta.after, bytes(r.text));
});

test('truncate：预算极小时也不抛（硬上限兜底）', () => {
  const r = SnapshotTrim.truncate({ snapshot: ORDERS, goal: GOAL, budgetBytes: 300 });
  assert.ok(bytes(r.text) <= 300, '仍超预算：' + bytes(r.text));
  assert.strictEqual(r.meta.trimmed, true);
});

/* ---------- 默认预算：盯住那张真的炸过的页面 ----------
 * 会话 r-0929-0847-jwac step2（orders-complex.html，614 个 ref，快照 47,015 B）：
 * 快照没超当时的默认 60,000 → 铁律一逐字节不裁 → 并行召回的「参数」题带着 200 个表格行
 * 候选（描述 30,395 B，比首轮那 200 个大一倍），请求合计 79,446 B ≈ 33.7K tokens
 * → {"detail":{"error_type":"max_tokens_exceeded"}}；同一步首轮 71,943 B ≈ 30.5K tokens 却是
 * 成功的（实测 usage.input_tokens 30,683）。**被裁过的页面能跑，没被裁的反而炸。**
 * 默认预算降到 45,000 后 names 刀生效（裁短 35 处名字 —— 快照与候选描述同源，裁快照顺带
 * 把题目瘦了：30,395 → 24,885 B），该步最大请求落到 70,585 B ≈ 29.9K tokens。
 *
 * 断言用的是「同页实测成功线的上沿」而不是某个 token 数：任何一次请求越线，这个测试就响。
 * 上限 72,000 B ≈ 30.5K tokens（该页实测成功的最高一档是 30,821 tokens）。 */
test('truncate：默认预算下 orders-complex 的每一次请求都不越同页实测成功线', () => {
  const t = SnapshotTrim.truncate({ snapshot: COMPLEX, goal: COMPLEX_GOAL });
  assert.strictEqual(t.meta.budgetBytes, SnapshotTrim.DEFAULT_BUDGET_BYTES, '这条线必须走默认值');
  assert.strictEqual(t.meta.trimmed, true, '这张页面在默认预算下必须被裁 —— 不裁就是当初那次 max_tokens_exceeded');

  const plan = AutoCore.recallPlan({
    snapshot: t.text,
    paramTrim: { on: true, algorithm: 'parallel', limit: 100, maxTranches: 5, size: 200, topN: 15 },
  });
  assert.ok(plan && plan.meta.batches > 0, '这张页面应当触发并行召回，否则测试失去意义');

  /* state 里除快照以外的部分（目标 / url / 标题 / 历史 / 上一步结果）实测 2,036 B */
  const STATE_OVERHEAD = 2036;
  const CEIL_BYTES = 72000;
  const stateBytes = bytes(t.text) + STATE_OVERHEAD;
  const reqs = [['首轮', AutoCore.buildQuestions({
    snapshot: t.text,
    param: { criteria: plan.first.criteria, meta: Object.assign({}, plan.meta, { first: true }) },
  })]];
  plan.batches.forEach((b, i) => reqs.push(['召回批 ' + b.index, AutoCore.buildRecallQuestions(plan, i + 1)]));

  reqs.forEach(([label, questions]) => {
    const total = stateBytes + bytes(JSON.stringify(questions));
    assert.ok(total <= CEIL_BYTES,
      label + ' 的请求 ' + total + ' B 越过 ' + CEIL_BYTES + ' B 的上限 —— 这正是 max_tokens_exceeded 的来源');
  });
});

/* ---------- ref 一致性（最重的一组） ---------- */

test('truncate：裁后 ref ⊆ 原 ref，且候选问题里的 ref 全部在裁后快照里可见', () => {
  const r = SnapshotTrim.truncate({ snapshot: ORDERS, goal: GOAL, budgetBytes: 6000 });
  const before = new Set(refKeys(ORDERS));
  refKeys(r.text).forEach((k) => assert.ok(before.has(k), '凭空出现 ref：' + k));

  const param = AutoCore.paramCriteria({
    snapshot: r.text, goal: GOAL, avoidRefs: [], paramTrim: { on: true, limit: 100, maxTranches: 5 },
  });
  const questions = AutoCore.buildQuestions({ snapshot: r.text, param });
  const visible = new Set(refKeys(r.text));
  Object.keys(questions['参数'].criteria).forEach((k) => {
    if (k === AutoCore.REF_MORE) return;      /* 「其他」兜底项不是 ref */
    assert.ok(visible.has(k), '候选 ' + k + ' 在裁后快照里找不到');
  });
});

test('truncate：裁后文本经 refCriteria / refRoles / paramCriteria / buildQuestions / buildState 全部正常', () => {
  const r = SnapshotTrim.truncate({ snapshot: RESUME, goal: '给第 3 位候选人发邀请面试', budgetBytes: 5000 });
  assert.ok(Object.keys(AutoCore.refCriteria(r.text)).length > 0, '裁后一个 ref 都不剩');
  assert.doesNotThrow(() => AutoCore.refRoles(r.text));
  const param = AutoCore.paramCriteria({
    snapshot: r.text, goal: '给第 3 位候选人发邀请面试', avoidRefs: [], paramTrim: { on: true, limit: 100, maxTranches: 5 },
  });
  assert.doesNotThrow(() => AutoCore.buildQuestions({ snapshot: r.text, param }));
  const state = AutoCore.buildState({ goal: 'x', url: 'u', title: 't', snapshot: r.text, history: [], tabs: null });
  assert.strictEqual(state['页面快照'], r.text);
});

test('truncate：同输入同输出（detectStall 靠跨步字符串比较，必须可复现）', () => {
  const a = SnapshotTrim.truncate({ snapshot: ORDERS, goal: GOAL, budgetBytes: 6000 });
  const b = SnapshotTrim.truncate({ snapshot: ORDERS, goal: GOAL, budgetBytes: 6000 });
  assert.strictEqual(a.text, b.text);
  assert.deepStrictEqual(a.meta, b.meta);
});

/* ---------- 下拉框的 option 名单是钉子 ----------
 * selectOptionNames 按缩进扫 ref 行之后的 option 行；名单读不到就放行（宁可漏报），
 * 但**读到一半最糟** —— 会对着残缺名单报「没有这个选项」。所以只允许「完整」或「空」。 */
function optionNamesUnder(text, ref) {
  const lines = String(text).split('\n');
  const at = lines.findIndex((l) => l.indexOf('[ref=' + ref + ']') !== -1);
  if (at === -1) return null;
  const ind = lines[at].match(/^ */)[0].length;
  const out = [];
  for (let j = at + 1; j < lines.length; j++) {
    if (lines[j].match(/^ */)[0].length <= ind) break;
    const m = lines[j].match(/- option "([^"]*)"/);
    if (m) out.push(m[1]);
  }
  return out;
}

test('truncate：保留下拉框的 ref 时，option 名单必须完整（不许只留一半）', () => {
  const combos = ORDERS.split('\n')
    .filter((l) => /- combobox/.test(l))
    .map((l) => (l.match(/\[ref=([A-Za-z0-9_-]+)\]/) || [])[1])
    .filter(Boolean);
  assert.ok(combos.length > 0, 'fixture 里没有 combobox，测试失去意义');

  [5000, 8000, 12000].forEach((budget) => {
    const r = SnapshotTrim.truncate({ snapshot: ORDERS, goal: GOAL, budgetBytes: budget });
    combos.forEach((ref) => {
      const after = optionNamesUnder(r.text, ref);
      if (after === null) return;                       /* ref 被整条裁掉：不管 */
      const before = optionNamesUnder(ORDERS, ref) || [];
      assert.ok(after.length === 0 || after.length === before.length,
        '预算 ' + budget + '：' + ref + ' 的选项只剩 ' + after.length + '/' + before.length + ' 个');
    });
  });
});

/* ---------- 三刀各自的形状 ---------- */

test('slimUrls：/url 只留主机 + 末段，链接行一个字不动', () => {
  const src = [
    '- link "Sign in" [ref=e85] [cursor=pointer]:',
    '  - /url: https://accounts.google.com/ServiceLogin?service=searchandassistant&passive=1209600&continue=https://www.google.com/travel/flights&hl=en',
    '- link "文件" [ref=e90] [cursor=pointer]:',
    '  - /url: /OpenByteInc/QuantDinger/blob/main/docker-compose.build.yml',
  ].join('\n');
  const r = SnapshotTrim._test.slimUrls(src);
  assert.strictEqual(r.hits, 2);
  assert.match(r.text, /- \/url: accounts\.google\.com\/…\/ServiceLogin/);
  assert.match(r.text, /- \/url: …\/docker-compose\.build\.yml/);
  assert.match(r.text, /- link "Sign in" \[ref=e85\] \[cursor=pointer\]:/);
  assert.ok(r.text.indexOf('searchandassistant') === -1);
});

test('clipDupNames：父节点名字被字节点复述时裁短，ref 与子节点一字不动', () => {
  /* 真实形状（orders-complex）：cell 的名字就是下面 5 个子节点的拼接 */
  const src = [
    '- cell "ORD-20260922-5229 下单时间 2026-09-22 21:47 微信小程序 · 微信支付 交易号 4200918307514553 仓库 北京仓" [ref=e385]:',
    '  - button "ORD-20260922-5229" [ref=e386] [cursor=pointer]',
    '  - generic [ref=e387]: 下单时间 2026-09-22 21:47',
    '  - generic [ref=e388]: 微信小程序 · 微信支付',
    '  - generic [ref=e389]: 交易号 4200918307514553',
    '  - generic [ref=e390]: 仓库 北京仓',
  ].join('\n');
  const r = SnapshotTrim._test.clipDupNames(src);
  assert.strictEqual(r.hits, 1);
  assert.match(r.text, /\[ref=e385\]/, 'ref 被裁掉了');
  assert.ok(r.text.indexOf('交易号 4200918307514553 仓库') === -1, '重复的名字没被裁短');
  assert.match(r.text, /- generic \[ref=e387\]: 下单时间 2026-09-22 21:47/, '子节点被动过');
  assert.match(r.text, /- button "ORD-20260922-5229" \[ref=e386\] \[cursor=pointer\]/, '子节点被动过');
  assert.ok(r.text.indexOf('ORD-20260922-5229') !== -1, '身份信息（订单号）被裁掉了');
  assert.ok(r.text.indexOf('北京仓') !== -1, '名字尾部信息被整段丢掉');
});

test('clipDupNames：名字未被字节点复述时不裁（不能误伤）', () => {
  const src = [
    '- article "候选人 周一鸣（高级前端工程师）" [ref=e10]:',
    '  - button "邀请面试" [ref=e11] [cursor=pointer]',
    '  - button "查看简历" [ref=e12] [cursor=pointer]',
  ].join('\n');
  const r = SnapshotTrim._test.clipDupNames(src);
  assert.strictEqual(r.hits, 0);
  assert.strictEqual(r.text, src);
});

test('clipQuoted：缩略绝不切掉 [ref=]（ref 在行里是原子的）', () => {
  const line = '            - link "docker-compose.build.yml, (File)" [ref=f2e638] [cursor=pointer]:';
  const out = SnapshotTrim._test.clipQuoted(line, 20);
  assert.match(out, /\[ref=f2e638\]/);
  assert.ok(out.length < line.length);
});

test('truncate：省略块里的摘录行必须带 ref（不带 ref 的摘录是纯装饰）', () => {
  const r = SnapshotTrim.truncate({ snapshot: ORDERS, goal: GOAL, budgetBytes: 8000 });
  const out = r.text.split('\n');
  assert.ok(r.meta.slimLines > 0, '这一档应当有摘录行，测试失去意义');
  out.forEach((l, i) => {
    if (!/此处省略/.test(l)) return;
    const ind = l.match(/^ */)[0].length;
    for (let j = i + 1; j < out.length; j++) {
      const jind = out[j].match(/^ */)[0].length;
      if (jind !== ind) break;
      assert.match(out[j], /\[ref=/, '摘录行不带 ref：' + out[j]);
    }
  });
});

/* ---------- 落盘记录 ----------
 * 落盘的 snapshot 是**裁后**文本，所以必须把「裁了多少」一并记下 ——
 * 否则导出记录里看不出某一步看到的是不是完整页面。 */
test('buildRunRecord：每步带裁剪账，run 级带配置（导出后能判断这步看的是不是完整页面）', () => {
  const trimMeta = {
    trimmed: true, before: 130979, after: 49257, rungs: ['url', 'rank'],
    totalRefs: 1380, keptRefs: 667, elidedLines: 1232, slimLines: 186,
    urlSlimmed: 304, namesClipped: 0, budgetBytes: 60000, keepN: 400,
  };
  const rec = AutoCore.buildRunRecord({
    id: 'r-0000-0000-test',
    runCfg: { goal: 'x', snapshotTrim: { on: true, budgetBytes: 60000 } },
    steps: [
      { n: 1, snapshot: 'trimmed text', snapshotTrim: trimMeta },
      { n: 2, snapshot: 'small page' },
    ],
  });
  assert.deepStrictEqual(rec.steps[0].snapshotTrim, trimMeta);
  assert.strictEqual(rec.steps[1].snapshotTrim, null, '没裁的步记 null（而不是 undefined）');
  assert.deepStrictEqual(rec.meta.snapshotTrim, { on: true, budgetBytes: 60000 });
});

test('truncate：没裁的步 snapshotTrim 为 null，裁过的 meta 能自证（before > budget ≥ after）', () => {
  const untouched = SnapshotTrim.truncate({ snapshot: ORDERS, goal: GOAL, budgetBytes: 1000000 });
  assert.strictEqual(untouched.meta.trimmed, false);

  const trimmed = SnapshotTrim.truncate({ snapshot: ORDERS, goal: GOAL, budgetBytes: 8000 });
  const m = trimmed.meta;
  assert.ok(m.before > m.budgetBytes, 'before 应当超过预算，否则不该裁');
  assert.ok(m.after <= m.budgetBytes, 'after 应当落在预算内');
  assert.ok(m.keptRefs > 0 && m.keptRefs <= m.totalRefs, 'keptRefs 必须是 (0, totalRefs]');
  assert.ok(m.rungs.indexOf('rank') !== -1);
});

/* ---------- 真实语料回归 ----------
 * data/runs 是 gitignore 的运行记录（116MB），默认不跑：设 JEV_CORPUS=1 才读。
 * 断言的是上线前实测的那条线：≤预算的页面零回归，>预算的页面必进预算。 */
test('truncate：真实语料回归（JEV_CORPUS=1 才跑）', {
  skip: process.env.JEV_CORPUS ? false : '未设 JEV_CORPUS=1',
}, () => {
  const dir = path.join(ROOT, 'data', 'runs');
  if (!fs.existsSync(dir)) return;                 /* 目录不存在：静默通过 */
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const seen = new Set();
  const snaps = [];
  const BUDGET = SnapshotTrim.DEFAULT_BUDGET_BYTES;
  files.forEach((f) => {
    const full = path.join(dir, f);
    if (fs.statSync(full).size > 8 * 1024 * 1024) return;   /* 超大记录跳过，控制耗时 */
    let rec;
    try { rec = JSON.parse(fs.readFileSync(full, 'utf8')); } catch (_) { return; }
    (rec.steps || []).forEach((s) => {
      const snap = String(s.snapshot || '');
      if (bytes(snap) < 3000) return;
      const key = bytes(snap) + ':' + snap.slice(0, 120);
      if (seen.has(key)) return;
      seen.add(key);
      snaps.push({ snap, goal: (rec.meta && rec.meta.goal) || '' });
    });
  });
  assert.ok(snaps.length > 20, '语料样本太少（' + snaps.length + '），回归失去意义');

  let over = 0;
  snaps.forEach(({ snap, goal }) => {
    const r = SnapshotTrim.truncate({ snapshot: snap, goal, budgetBytes: BUDGET });
    if (bytes(snap) <= BUDGET) {
      assert.strictEqual(r.text, snap, '未超预算却被改动（' + bytes(snap) + ' B）');
    } else {
      over++;
      assert.ok(bytes(r.text) <= BUDGET, '超预算页裁完仍超：' + bytes(r.text) + ' > ' + BUDGET);
    }
  });
  assert.ok(over > 0, '语料里没有超预算页，K3 未被覆盖');
  console.log('    语料 ' + snaps.length + ' 页，其中超预算 ' + over + ' 页');
});
