/* ref-funnel 纯逻辑测试：触发阈值、裁剪与兜底、关键词排序、祖先上下文、
 * 批次收敛、确定性、边界（全部无 DOM；密集用例用 resume.html 真实快照夹具） */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const Funnel = require(path.join(ROOT, 'public', 'js', 'ref-funnel.js'));
const AutoCore = require(path.join(ROOT, 'public', 'js', 'auto-core.js'));

/* resume.html 真实快照：393 个 ref —— 「394 个候选 ref」报错现场的原始输入 */
const RESUME_SNAPSHOT = require(path.join(ROOT, 'tests', 'fixtures', 'resume-snapshot.js'));
/* orders.html 真实快照：392 个 ref，行没有 aria 名字（信息在 cell 上） */
const ORDERS_SNAPSHOT = require(path.join(ROOT, 'tests', 'fixtures', 'orders-snapshot.js'));
/* demo 内置任务的真实目标 */
const RESUME_GOAL = '给符合条件的候选人（高级前端 + React 与 TypeScript + 期望薪资不超过 35K）发出面试邀请';
const ORDERS_GOAL = '在订单列表中找到商品为 AirPods Pro（苹果降噪耳机）且状态是「已付款待发货」的那一笔订单，点击该行的「发货」按钮，把它标记为发货';

/* 从真实快照里定位「某行的发货按钮」：行（row）文本同时含两个关键词 */
function shipButtonRefOfRow(snapshot, a, b) {
  const lines = String(snapshot).split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*- row\b/.test(lines[i])) continue;
    let end = i + 1;
    while (end < lines.length && !/^\s*- row\b/.test(lines[end])) end++;
    const block = lines.slice(i, end).join(' ');
    if (block.indexOf(a) === -1 || block.indexOf(b) === -1) continue;
    const m = block.match(/button "发货" \[ref=([A-Za-z0-9_-]+)\]/);
    if (m) return m[1];
  }
  return '';
}
/* 唯一合格候选人 周一鸣（32K · 高级前端 · React + TypeScript）的「邀请面试」按钮 */
const TARGET_REF = 'e172';
/* 明显不相关的候选人（UI 设计师）的「邀请面试」按钮，用作排序对照 */
const IRRELEVANT_REF = 'e366';

/* 小快照（15 个 ref，远低于阈值） */
const SMALL_SNAPSHOT = [
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
  '    - textbox "备注" [ref=e15]',
].join('\n');

/* 合成密集快照：rowCount 行候选人卡片，每行 2 个 ref（article + 按钮）；
 * pad = 末尾额外补的独立 ref 数，用于精确构造阈值边界 */
function denseSnapshot(rowCount, targetRow, targetLabel, pad) {
  const lines = [
    '- generic [active] [ref=e1]:',
    '  - banner [ref=e2]:',
    '    - searchbox "搜索" [ref=e3]',
    '  - main [ref=e4]:',
    '    - list "候选人列表" [ref=e5]:',
  ];
  let ref = 6;
  for (let i = 1; i <= rowCount; i++) {
    const label = (i === targetRow) ? targetLabel : ('候选人 ' + i + '：普通开发 Java 期望 40K');
    lines.push('      - listitem "' + label + '" [ref=e' + (ref++) + ']:');
    lines.push('        - button "发出面试邀请" [ref=e' + (ref++) + '] [cursor=pointer]');
  }
  for (let k = 0; k < (pad || 0); k++) {
    lines.push('    - paragraph "占位 ' + k + '" [ref=e' + (ref++) + ']');
  }
  return lines.join('\n');
}

const keys = (criteria) => Object.keys(criteria);

/* ---------- 触发阈值：小页面零回归 ---------- */

test('ref 数未超过阈值时：输出与 buildRefCriteria 逐字节一致（零回归）', () => {
  const out = Funnel.buildBoundedRefCriteria(SMALL_SNAPSHOT, { goal: '归档对账单', limit: 80, batch: 1, maxTranches: 3 });
  assert.strictEqual(out.meta.trimmed, false);
  assert.strictEqual(out.meta.totalRefs, 13);
  assert.strictEqual(JSON.stringify(out.criteria), JSON.stringify(AutoCore.refCriteria(SMALL_SNAPSHOT)));
});

test('阈值是 250：正好 250 个 ref 不裁，251 个才裁', () => {
  const at250 = Funnel.buildBoundedRefCriteria(denseSnapshot(122, 0, '', 1), { goal: '', limit: 80, batch: 1, maxTranches: 3 });
  assert.strictEqual(at250.meta.totalRefs, 250);
  assert.strictEqual(at250.meta.trimmed, false);

  const at251 = Funnel.buildBoundedRefCriteria(denseSnapshot(122, 0, '', 2), { goal: '', limit: 80, batch: 1, maxTranches: 3 });
  assert.strictEqual(at251.meta.totalRefs, 251);
  assert.strictEqual(at251.meta.trimmed, true);
});

/* ---------- 裁剪与兜底 ---------- */

test('裁剪后：选项数 = limit + 其他（「无需元素」已下线），且 meta 记录折叠数量', () => {
  const snap = denseSnapshot(200, 0, '');          // 405 个 ref
  const out = Funnel.buildBoundedRefCriteria(snap, { goal: '找候选人', limit: 80, batch: 1, maxTranches: 3 });
  const ks = keys(out.criteria);
  assert.strictEqual(out.meta.totalRefs, 405);
  assert.strictEqual(out.meta.trimmed, true);
  assert.strictEqual(ks.length, 80 + 1);
  assert.strictEqual(out.criteria['无需元素'], undefined, '「无需元素」兜底项已下线');
  assert.ok(out.criteria['其他'], '还有未列出的候选时必须给兜底项');
  assert.strictEqual(out.meta.folded, 405 - 80);
  assert.match(out.criteria['其他'], /325/);
});

test('最后一批不附「其他」项（避免无限展开）', () => {
  const snap = denseSnapshot(200, 0, '');
  const last = Funnel.buildBoundedRefCriteria(snap, { goal: '', limit: 80, batch: 3, maxTranches: 3 });
  assert.strictEqual(last.criteria['其他'], undefined);
  assert.strictEqual(last.meta.hiddenMore, 405 - 240);
  assert.strictEqual(last.criteria['无需元素'], undefined);
});

test('maxTranches = 0 时完全不附「其他」项', () => {
  const out = Funnel.buildBoundedRefCriteria(denseSnapshot(200, 0, ''), { goal: '', limit: 80, batch: 1, maxTranches: 0 });
  assert.strictEqual(out.criteria['其他'], undefined);
});

test('批次不重叠：第 2 批给的是第 81–160 名，且与第 1 批无交集', () => {
  const snap = denseSnapshot(200, 0, '');
  const b1 = Funnel.buildBoundedRefCriteria(snap, { goal: '', limit: 80, batch: 1, maxTranches: 3 });
  const b2 = Funnel.buildBoundedRefCriteria(snap, { goal: '', limit: 80, batch: 2, maxTranches: 3 });
  const refs1 = keys(b1.criteria).filter((k) => /^e\d+$/.test(k));
  const refs2 = keys(b2.criteria).filter((k) => /^e\d+$/.test(k));
  assert.strictEqual(refs1.length, 80);
  assert.strictEqual(refs2.length, 80);
  assert.strictEqual(refs1.filter((r) => refs2.indexOf(r) !== -1).length, 0);
  assert.deepStrictEqual(b1.meta.top.map((x) => x.ref), refs1);
  assert.deepStrictEqual(b2.meta.top.map((x) => x.ref), refs2);
});

test('确定性：同一输入两次调用结果逐字节一致', () => {
  const opts = { goal: RESUME_GOAL, limit: 80, batch: 1, maxTranches: 3 };
  const a = Funnel.buildBoundedRefCriteria(RESUME_SNAPSHOT, opts);
  const b = Funnel.buildBoundedRefCriteria(RESUME_SNAPSHOT, opts);
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
});

/* ---------- 真实页面：resume.html（394 个候选的报错现场） ---------- */

test('真实 resume.html：唯一合格候选人的按钮必进第一批', () => {
  const out = Funnel.buildBoundedRefCriteria(RESUME_SNAPSHOT, { goal: RESUME_GOAL, limit: 80, batch: 1, maxTranches: 3 });
  const ks = keys(out.criteria);
  assert.strictEqual(out.meta.totalRefs, 393);
  assert.ok(ks.indexOf(TARGET_REF) !== -1, '目标 e172 必须在第一批里，否则 Jev 看不到它');
  assert.ok(ks.indexOf('其他') !== -1);
});

test('真实 resume.html：合格候选人排在明显不相关的候选人之前', () => {
  const out = Funnel.buildBoundedRefCriteria(RESUME_SNAPSHOT, { goal: RESUME_GOAL, limit: 80, batch: 1, maxTranches: 3 });
  const ranked = out.meta.top.map((x) => x.ref);
  const atTarget = ranked.indexOf(TARGET_REF);
  const atIrrelevant = ranked.indexOf(IRRELEVANT_REF);
  assert.ok(atTarget !== -1, '目标必须在榜内');
  assert.ok(atIrrelevant === -1 || atTarget < atIrrelevant,
    '目标是高级前端 + React + TypeScript，必须排在 UI 设计师之前（目标第 ' + atTarget + ' 名）');
});

test('真实 resume.html：卡片内同名按钮靠祖先上下文区分开（不是全部同分）', () => {
  const out = Funnel.buildBoundedRefCriteria(RESUME_SNAPSHOT, { goal: RESUME_GOAL, limit: 80, batch: 1, maxTranches: 3 });
  const byRef = {};
  out.meta.top.forEach((x) => { byRef[x.ref] = x; });
  assert.ok(byRef[TARGET_REF], '目标按钮应在第一批中');
  assert.ok(byRef[TARGET_REF].score > 0, '目标按钮应有正分');
  const scores = out.meta.top.map((x) => x.score);
  assert.ok(new Set(scores).size > 1, '不能让所有候选同分 —— 那样排序退化成页面顺序');
});

test('真实 resume.html：选项描述带上所在卡片，Jev 才分得清同名按钮', () => {
  const out = Funnel.buildBoundedRefCriteria(RESUME_SNAPSHOT, { goal: RESUME_GOAL, limit: 80, batch: 1, maxTranches: 3 });
  const desc = out.criteria[TARGET_REF];
  assert.match(desc, /【可交互】/);
  assert.match(desc, /周一鸣/, '描述里应出现候选人的卡片信息，收到：' + desc);
});

/* ---------- 真实 orders.html：行没有 aria 名字（表格页） ---------- */

test('真实 orders.html：目标订单行的「发货」按钮排在第一批前列', () => {
  const target = shipButtonRefOfRow(ORDERS_SNAPSHOT, 'AirPods Pro', '已付款待发货');
  assert.ok(target, '夹具里应能找到目标行（AirPods Pro + 已付款待发货）');
  const out = Funnel.buildBoundedRefCriteria(ORDERS_SNAPSHOT, { goal: ORDERS_GOAL, limit: 80, batch: 1, maxTranches: 3 });
  assert.strictEqual(out.meta.totalRefs, 392);
  const ranked = out.meta.top.map((x) => x.ref);
  const at = ranked.indexOf(target);
  assert.ok(at !== -1, '目标 ' + target + ' 必须在第一批里（行没有名字时，上下文要取到「行」这一层）');
  /* 只是「挤进 80 个」不够 —— 目标行是唯一命中「AirPods Pro + 已付款待发货」的，
   * 应当排到很前面，否则 15 个同名「发货」按钮里 Jev 还是要靠猜 */
  assert.ok(at < 10, '目标行应排到第一批前 10 名，实际第 ' + (at + 1) + ' 名');
});

test('真实 orders.html：行的上下文取到整行，目标行排在其它订单行之前', () => {
  const target = shipButtonRefOfRow(ORDERS_SNAPSHOT, 'AirPods Pro', '已付款待发货');
  const other = shipButtonRefOfRow(ORDERS_SNAPSHOT, 'FreeBuds', '待付款');
  assert.ok(other && other !== target, '夹具里应能找到对照行（FreeBuds + 待付款）');
  const out = Funnel.buildBoundedRefCriteria(ORDERS_SNAPSHOT, { goal: ORDERS_GOAL, limit: 80, batch: 1, maxTranches: 3 });
  const ranked = out.meta.top.map((x) => x.ref);
  const atTarget = ranked.indexOf(target);
  const atOther = ranked.indexOf(other);
  assert.ok(atTarget !== -1, '目标必须在榜内');
  assert.ok(atOther === -1 || atTarget < atOther,
    '目标行（AirPods Pro + 已付款待发货）应排在无关行之前（目标第 ' + atTarget + ' 名，对照第 ' + atOther + ' 名）');
});

test('真实 orders.html：无名行里的按钮，描述也要给出定位线索', () => {
  const target = shipButtonRefOfRow(ORDERS_SNAPSHOT, 'AirPods Pro', '已付款待发货');
  const out = Funnel.buildBoundedRefCriteria(ORDERS_SNAPSHOT, { goal: ORDERS_GOAL, limit: 80, batch: 1, maxTranches: 3 });
  const desc = out.criteria[target];
  assert.ok(desc, '目标按钮应在第一批里');
  assert.notStrictEqual(desc, '【可交互】 button "发货"', '同名按钮必须带上一行的定位线索，收到：' + desc);
});

test('无名行：同一行的元素共享行内关键词分，可点击的排最前', () => {
  const target = shipButtonRefOfRow(ORDERS_SNAPSHOT, 'AirPods Pro', '已付款待发货');
  const ranked = Funnel.rankRefs(ORDERS_SNAPSHOT, { goal: ORDERS_GOAL }).ranked;
  const at = ranked.findIndex((x) => x.ref === target);
  assert.ok(at !== -1);
  const t = ranked[at];
  const rowMate = ranked.find((x) => x.ref !== target && x.ancestor && t.ancestor && x.ancestor === t.ancestor && !x.interactive);
  if (rowMate) {
    assert.ok(t.score > rowMate.score,
      '同行里可点击的按钮应高于静态元素（按钮 ' + t.score + ' vs 同行元素 ' + rowMate.score + '）');
  }
});

/* ---------- 关键词与打分规则 ---------- */

test('extractTerms：中文 bigram + 英文词，过滤功能字前缀', () => {
  const terms = Funnel.extractTerms('把 高级 前端 React 的候选人发出面试邀请');
  assert.ok(terms.indexOf('react') !== -1, '英文词应小写化保留');
  assert.ok(terms.indexOf('高级') !== -1);
  assert.ok(terms.indexOf('前端') !== -1);
  assert.ok(terms.indexOf('把高') === -1, '「把」是功能字，不应产生 bigram');
  assert.ok(terms.indexOf('的候') === -1, '「的」是功能字，不应产生 bigram');
});

test('可点击优先：无关键词命中时可交互元素排在容器前面', () => {
  const snap = denseSnapshot(200, 0, '');
  const out = Funnel.buildBoundedRefCriteria(snap, { goal: '', limit: 80, batch: 1, maxTranches: 3 });
  const interactive = out.meta.top.filter((x) => x.interactive).length;
  assert.ok(interactive >= 60, '前 80 个里可交互元素应占多数，实际 ' + interactive);
});

test('关键词命中让目标元素从页面深处浮到前面', () => {
  /* 目标在第 180 行（远超 80），只有关键词能把它拉进第一批 */
  const snap = denseSnapshot(200, 180, '候选人 王芳：高级前端 React TypeScript 期望 32K');
  const out = Funnel.buildBoundedRefCriteria(snap, { goal: '给高级前端 React TypeScript 期望 32K 的候选人发出面试邀请', limit: 80, batch: 1, maxTranches: 3 });
  const refs = keys(out.criteria).filter((k) => /^e\d+$/.test(k));
  /* 第 180 行对应的 article ref = 6 + (180-1)*2 = 364 */
  assert.ok(refs.indexOf('e364') !== -1, '深处的目标卡片应被关键词拉到第一批，实际前 5 名：' + refs.slice(0, 5).join(','));
});

test('已失败降权：avoidRefs 里的 ref 排到最后', () => {
  const snap = denseSnapshot(200, 0, '');
  const plain = Funnel.buildBoundedRefCriteria(snap, { goal: '', limit: 20, batch: 1, maxTranches: 0 });
  const first = plain.meta.top[0].ref;
  const avoided = Funnel.buildBoundedRefCriteria(snap, { goal: '', limit: 20, batch: 1, maxTranches: 0, avoidRefs: [first] });
  assert.strictEqual(avoided.meta.top.map((x) => x.ref).indexOf(first), -1,
    '被降权的 ' + first + ' 不应再出现在前 20 名里');
});

/* ---------- 边界 ---------- */

test('快照里没有 ref 时：候选为空（「无需元素」下线后零候选），不裁剪不报错', () => {
  const out = Funnel.buildBoundedRefCriteria('- generic: 空白页', { goal: '随便', limit: 80, batch: 1, maxTranches: 3 });
  assert.deepStrictEqual(keys(out.criteria), []);
  assert.strictEqual(out.meta.trimmed, false);
  assert.strictEqual(out.meta.totalRefs, 0);
});

test('目标为空时：退化为「可点击 + 快照顺序」，仍然完成裁剪', () => {
  const out = Funnel.buildBoundedRefCriteria(denseSnapshot(200, 0, ''), { goal: '', limit: 80, batch: 1, maxTranches: 3 });
  assert.strictEqual(keys(out.criteria).length, 81);
  assert.ok(out.meta.top.every((x) => x.score === (x.interactive ? 20 : 0)));
});

test('上限被设得过大时自动收紧到安全值并记录（绝不发出会被拒的请求）', () => {
  const out = Funnel.buildBoundedRefCriteria(denseSnapshot(200, 0, ''), { goal: '', limit: 999, batch: 1, maxTranches: 3 });
  assert.ok(keys(out.criteria).length <= 255, '选项数必须留在接口硬上限 255 以内，实际 ' + keys(out.criteria).length);
  assert.strictEqual(out.meta.forcedClamp, true);
  assert.strictEqual(out.meta.limit, Funnel.SOFT_LIMIT);
});

test('isMoreChoice：认得兜底项', () => {
  assert.strictEqual(Funnel.isMoreChoice('其他'), true);
  assert.strictEqual(Funnel.isMoreChoice(null), false);
  assert.strictEqual(Funnel.isMoreChoice('e12'), false);
});

/* ---------- 无名容器里放多张卡片 ---------- */

/* 一个没有 aria 名字的容器（网格外层）里放 3 张带名字的卡片，
 * 每张卡一个同名按钮。块级上下文取「容器」是对的（同一区域的元素共享块级分），
 * 但定位提示必须落到各自的卡片上 —— 否则 3 个同名按钮全被描述成第一张卡的名字。 */
function wrapperOfCards() {
  const lines = ['- generic [active] [ref=e1]:', '  - main [ref=e2]:', '    - generic [ref=e3]:'];
  let ref = 4;
  const cards = [];
  for (let i = 1; i <= 3; i++) {
    const art = 'e' + (ref++), head = 'e' + (ref++), btn = 'e' + (ref++);
    lines.push('      - article "候选人 ' + i + ' 的卡片" [ref=' + art + ']:');
    lines.push('        - heading "候选人 ' + i + '" [ref=' + head + ']');
    lines.push('        - button "邀请面试" [ref=' + btn + '] [cursor=pointer]');
    cards.push({ n: i, btn: btn, art: art });
  }
  /* 补足到触发裁剪的规模（> 250 个 ref） */
  lines.push('    - list "填充列表" [ref=e' + (ref++) + ']:');
  for (let i = 0; i < 300; i++) lines.push('      - listitem "填充项 ' + i + '" [ref=e' + (ref++) + ']');
  return { snapshot: lines.join('\n'), cards: cards };
}

test('无名容器里多张卡片：每个同名按钮各带自己卡片的名字，不能被第一张顶替', () => {
  const f = wrapperOfCards();
  const out = Funnel.buildBoundedRefCriteria(f.snapshot, { goal: '给候选人发出面试邀请', limit: 80, batch: 1, maxTranches: 3 });
  f.cards.forEach((c) => {
    const desc = out.criteria[c.btn];
    assert.ok(desc, '第 ' + c.n + ' 张卡的按钮应在第一批里');
    assert.ok(desc.indexOf('候选人 ' + c.n) !== -1,
      '第 ' + c.n + ' 张卡的按钮描述应带自己的卡片名，收到：' + desc);
  });
});

test('同一块内没有带名字的元素时：仍然用块内首个名字当线索（表格行的老行为不变）', () => {
  const target = shipButtonRefOfRow(ORDERS_SNAPSHOT, 'AirPods Pro', '已付款待发货');
  const out = Funnel.buildBoundedRefCriteria(ORDERS_SNAPSHOT, { goal: ORDERS_GOAL, limit: 80, batch: 1, maxTranches: 3 });
  const desc = out.criteria[target];
  assert.match(desc, /ORD-\d{8}/, '订单行的提示应落到行内的订单号上，收到：' + desc);
});
