/* snapshot-diff 纯逻辑测试：相邻快照的结构化差分（全部无 DOM；用真实录制快照夹具）
 *
 * 事故链条（会话 r-0929-1918-7yw4 第 5~10 步）：agent 连点同一个「赞同」按钮六次。
 * playwright 的 aria 快照 ref 是**快照内的临时句柄** —— playwright-core 的 computeAriaRef
 * 在角色或可读名字变化时重新签发：
 *   if (!ariaRef || ariaRef.role !== ariaNode.role || ariaRef.name !== ariaNode.name) { …新号… }
 * 于是一次只改了自己文案的点击（已赞同 488 → 赞同 487）让元素看起来是全新的：
 *   decisionSig / failedRefs / 已完成步骤 全部按 ref 认元素 → 认不出；
 *   detectStall 按快照逐字节比较 → 每次都「变了」，从不报警；
 *   上一步结果 恒为「成功」—— 模型手里没有一条线索。
 *
 * 本文件盯死四件事：
 *   ① 只改了自己名字的一击 = 恰好 1 处改动，且就是被点的那一行
 *   ② 「内容变了」与「ref 被重写」是两个互相独立的信号（jwac：1 行内容 + 440 行重写）
 *   ③ 归一只剥 [active]（焦点噪声），语义状态（[disabled]/[selected]/[expanded]…）必须留着
 *   ④ 模型可见文本只陈述观测，不解释、不归因、不放行号
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SnapDiff = require(path.join(ROOT, 'public', 'js', 'snapshot-diff.js'));

const TOGGLE = require(path.join(ROOT, 'tests', 'fixtures', 'zhihu-toggle-pair.js'));
const RENUMBER = require(path.join(ROOT, 'tests', 'fixtures', 'jwac-ref-renumber-pair.js'));
const RESUME = require(path.join(ROOT, 'tests', 'fixtures', 'resume-snapshot.js'));
const ORDERS = require(path.join(ROOT, 'tests', 'fixtures', 'orders-snapshot.js'));

function utf8(s) { return Buffer.byteLength(String(s), 'utf8'); }

/* ---------- 夹具自校验：录制数据变了就立刻响 ---------- */

test('夹具自校验：zhihu toggle 对的形状没走样', () => {
  const e = TOGGLE.expect;
  assert.strictEqual(TOGGLE.prev.split('\n').length, e.prevLines);
  assert.strictEqual(TOGGLE.cur.split('\n').length, e.curLines);
  assert.strictEqual(e.actedLine, 206);
  assert.deepStrictEqual(e.changedInPrev, [206], '这一对只该有 1 处改动');
  assert.strictEqual(e.refRewritten, 0, '这一对里 ref 只在被改的那一行上换了号');
  assert.strictEqual(TOGGLE.prevTrimmed, false, '两侧都没被裁剪，差分才可信');
  assert.strictEqual(TOGGLE.curTrimmed, false);
  assert.match(TOGGLE.prev.split('\n')[e.actedLine], new RegExp('\\[ref=' + TOGGLE.actedRef + '\\]'));
  assert.match(TOGGLE.prev.split('\n')[e.actedLine], /已赞同 488/);
  assert.match(TOGGLE.cur.split('\n')[e.actedLine], /赞同 487/);
});

test('夹具自校验：jwac ref 重写对的形状没走样', () => {
  const e = RENUMBER.expect;
  assert.strictEqual(RENUMBER.prev.split('\n').length, e.prevLines);
  assert.deepStrictEqual(e.changedInPrev, [660]);
  assert.deepStrictEqual(e.changedInCur, [660]);
  assert.strictEqual(e.refRewritten, 440, '内容只改 1 行，ref 编号却被换掉 440 行 —— 本对的全部意义');
  assert.strictEqual(RENUMBER.prevTrimmed, false);
  assert.strictEqual(RENUMBER.curTrimmed, false);
});

/* ---------- ① 核心原语：只改了自己名字的一击 ---------- */

test('diff：只改了自己名字的一击 → local，且改动行就是被点的那一行', () => {
  const r = SnapDiff.diff({ prev: TOGGLE.prev, cur: TOGGLE.cur, actedRef: TOGGLE.actedRef });
  assert.strictEqual(r.kind, 'local');
  assert.deepStrictEqual(r.changedInPrev, [TOGGLE.expect.actedLine]);
  assert.deepStrictEqual(r.changedInCur, [TOGGLE.expect.actedLine]);
  assert.strictEqual(r.renamed.length, 1, '同一行的 1:1 改写要配成一对，而不是「删 1 行 + 加 1 行」');
  assert.strictEqual(r.renamed[0].nameChanged, true);
  assert.strictEqual(r.renamed[0].newRef, 'f1e1138', '新 ref 必须能取到 —— 那是模型下一步要用的句柄');
  assert.strictEqual(r.chased, true);
  assert.strictEqual(r.refRewritten, 0);
});

/* ---------- ② 回执：只陈述观测 ---------- */

test('receipt：只改了自己名字的一击 → 观测口径的原文对，含新旧两个 ref', () => {
  const r = SnapDiff.diff({ prev: TOGGLE.prev, cur: TOGGLE.cur, actedRef: TOGGLE.actedRef });
  const s = SnapDiff.receipt({ base: '成功', diff: r });
  assert.strictEqual(s,
    '成功 · 快照有 1 处变化\n'
    + '上一步操作所在那一处被改写：'
    + '- button "已赞同 488" [active] [ref=f1e1137] → - button "赞同 487" [active] [ref=f1e1138]');
  /* 观察口径：不做身份断言、不做因果断言、不加解释 */
  assert.doesNotMatch(s, /同一个元素|因为|所以|说明|意味着|页面没有变化/);
  /* 不放行号：内部 0-based 与人读 1-based 混用是 off-by-one 事故源，模型也用不上 */
  assert.doesNotMatch(s, /第 ?\d+ ?行/);
  /* 旧 ref 接回「已完成步骤」，新 ref 是下一步的句柄 —— 两个都不能被截断掉 */
  assert.ok(s.includes('f1e1137'), '旧 ref 必须在（模型靠它接回历史）');
  assert.ok(s.includes('f1e1138'), '新 ref 必须在（模型下一步要用）');
});

test('receipt：ref 重写是与任意分支叠加的子句（jwac：1 处内容变化 + 440 行重写）', () => {
  const r = SnapDiff.diff({ prev: RENUMBER.prev, cur: RENUMBER.cur, actedRef: RENUMBER.actedRef });
  assert.strictEqual(r.kind, 'local');
  assert.strictEqual(r.refRewritten, 440);
  assert.strictEqual(r.chased, false, '上一步点的「查询」不在改动行里');
  assert.strictEqual(SnapDiff.receipt({ base: '成功', diff: r }),
    '成功 · 快照有 1 处变化；另有 440 行的 ref 编号与上一步不同');
});

/* ---------- ③ 归一化口径：语义状态必须留着 ---------- */

test('归一化：点提交 → 按钮变灰 不能被抹成「无变化」', () => {
  const prev = '- generic [ref=e1]:\n  - button "提交" [ref=e2] [cursor=pointer]';
  const cur = '- generic [ref=e1]:\n  - button "提交" [disabled] [ref=e2] [cursor=pointer]';
  const r = SnapDiff.diff({ prev: prev, cur: cur, actedRef: 'e2' });
  assert.strictEqual(r.kind, 'local', '[disabled] 是语义状态，剥掉就会把真实变化说成没变化');
  assert.deepStrictEqual(r.changedInCur, [1]);
  assert.strictEqual(SnapDiff.receipt({ base: '成功', diff: r }),
    '成功 · 快照有 1 处变化\n'
    + '上一步操作所在那一处被改写：'
    + '- button "提交" [ref=e2] [cursor=pointer] → - button "提交" [disabled] [ref=e2] [cursor=pointer]');
});

test('归一化：只有焦点（[active]）移动 → 判为无变化', () => {
  const prev = '- generic [ref=e1]:\n  - button "查询" [ref=e2] [cursor=pointer]';
  const cur = '- generic [ref=e1]:\n  - button "查询" [active] [ref=e2] [cursor=pointer]';
  const r = SnapDiff.diff({ prev: prev, cur: cur });
  assert.strictEqual(r.kind, 'unchanged');
  assert.strictEqual(SnapDiff.receipt({ base: '成功', diff: r }), '成功 · 页面快照内容无变化');
});

/* ---------- ④ 分类：整页替换 / 过大 ---------- */

test('diff：两张互不相干的真实页面 → 整页替换，绝不逐行列', () => {
  const r = SnapDiff.diff({ prev: ORDERS, cur: RESUME });
  assert.strictEqual(r.kind, 'page-replaced');
  assert.ok(r.approxChanged > 0);
  assert.strictEqual(r.changedInCur.length, 0, '整页替换不产出逐行清单');
  assert.strictEqual(SnapDiff.receipt({ base: '成功', diff: r }),
    '成功 · 页面快照内容整体更换（约 ' + r.approxChanged + ' 行不同）');
});

test('diff：中段过大 → too-large，措辞必须与「整页替换」区分开', () => {
  const n = 6000;
  const prev = Array.from({ length: n }, (_, i) => '- text: 行' + i).join('\n');
  const cur = prev.split('\n').map((l, i) => (i >= 1500 && i < 4500 ? l + '（改）' : l)).join('\n');
  const r = SnapDiff.diff({ prev: prev, cur: cur });
  assert.strictEqual(r.kind, 'too-large');
  /* 「部分但巨大」不能说成「整体更换」——那是假话 */
  assert.match(SnapDiff.receipt({ base: '成功', diff: r }), /变化过大/);
  assert.doesNotMatch(SnapDiff.receipt({ base: '成功', diff: r }), /整体更换/);
});

/* ---------- ⑤ digest：排序、截断、如实报未列出数 ---------- */

test('digest：改动多于上限时上一步操作那一处必排第一，字节不越线且如实报未列出数', () => {
  const lines = RESUME.split('\n');
  const idx = lines.findIndex((l) => /button "邀请面试"/.test(l));
  const ref = lines[idx].match(/\[ref=([A-Za-z0-9_-]+)\]/)[1];
  const cur = lines.map((l, i) => {
    if (i === idx) return l.replace('邀请面试', '邀请面试（已邀请）');
    if (i % 20 === 0) return l + '·';
    return l;
  }).join('\n');
  const r = SnapDiff.diff({ prev: RESUME, cur: cur, actedRef: ref });
  assert.ok(r.hunks.length > SnapDiff.MAX_HUNKS_SHOWN, '本用例要真的多到需要截断');
  assert.match(r.digest.split('\n')[1], /上一步操作所在那一处/, '最相关的那一处必须排第一');
  assert.match(r.digest, /另有 \d+ 处未列出/, '截断要如实说');
  assert.ok(SnapDiff.utf8Len(r.digest) <= SnapDiff.DIGEST_BUDGET_BYTES);
  assert.doesNotMatch(r.digest, /第 ?\d+ ?行/, '不放行号');
});

test('确定性：同输入两次调用逐字节一致', () => {
  const a = SnapDiff.diff({ prev: TOGGLE.prev, cur: TOGGLE.cur, actedRef: TOGGLE.actedRef });
  const b = SnapDiff.diff({ prev: TOGGLE.prev, cur: TOGGLE.cur, actedRef: TOGGLE.actedRef });
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
  assert.strictEqual(a.digest, b.digest);
});

/* ---------- ⑨ 端到端回放：把知乎那六步的循环语义跑一遍 ----------
 * 这是最接近真实循环的验证（不起浏览器）：按 auto.js 主循环的顺序
 * 调用 diff → receipt → buildState → detectStall，断言用户/模型看到的东西。 */

function refOnLine(snap, atLine) {
  const l = String(snap).split('\n')[atLine] || '';
  const m = l.match(/\[ref=([A-Za-z0-9_-]+)\]/);
  return m ? m[1] : null;
}

test('回放：连点同一个赞六次 → 回执给出原文对，第 3 步起报「追自己改过的行」', () => {
  const AutoCore = require(path.join(ROOT, 'public', 'js', 'auto-core.js'));
  const A = TOGGLE.prev, B = TOGGLE.cur;
  /* 交替链：已赞同 488 ↔ 赞同 487，ref 每次都被重发（真实会话就是这样） */
  const chain = [A, B, A, B, A, B, A];

  /* 种子 = 真实会话的第 5 步：它在 OLD 快照上点了 f1e1137（「已赞同 488」）。
   * 有了这一步，第 1 次迭代才等价于真实的第 6 步（回执要说出「你点的那处被改写了」）。 */
  const steps = [{
    decision: { action: 'click', param: TOGGLE.actedRef, text: null },
    snapshot: A, chasedOwnChange: false, chasedLine: null,
  }];
  const receipts = [], notices = [], digests = [];

  for (let i = 1; i < chain.length; i++) {
    const prevSnap = chain[i - 1], curSnap = chain[i];
    const prevStep = steps[steps.length - 1] || null;

    /* ①c 差分（与 auto.js 同位同参） */
    const d = SnapDiff.diff({
      prev: prevSnap, cur: curSnap,
      actedRef: prevStep && prevStep.decision.param,
    });

    /* ③④ 停滞检测：用的是「本轮之前」的步骤（与 auto.js 一致） */
    const stall = AutoCore.detectStall(steps, curSnap, []);

    /* ⑧ 本步选哪一行：模拟模型追着自己刚改的那一处继续点 */
    const line = d.changedInCur[0];
    const pickRef = refOnLine(curSnap, line);
    const chased = SnapDiff.isChanged(d, line);

    /* ③④ state 组装（与 auto.js 同序：回执先算，再进 buildState） */
    const state = AutoCore.buildState({
      goal: 'g', url: 'u', title: 't', history: [], snapshot: curSnap,
      lastResult: SnapDiff.receipt({ base: '成功', diff: d }),
      lastChange: d.digest, stallNotice: stall.notice,
    });
    receipts.push(state['上一步结果']);
    notices.push(state['停滞提示'] || null);
    digests.push(state['本步变化'] || null);

    steps.push({
      decision: { action: 'click', param: pickRef, text: null },
      snapshot: curSnap, chasedOwnChange: chased, chasedLine: chased ? line : null,
    });
  }

  /* 回执：第 6 步起必须给出那一处的旧→新原文，且新旧两个 ref 都在（旧接历史、新是句柄） */
  assert.match(receipts[0], /上一步操作所在那一处被改写/);
  assert.ok(receipts[0].includes('f1e1137'), '旧 ref 必须在');
  assert.ok(receipts[0].includes('f1e1138'), '新 ref 必须在');
  assert.doesNotMatch(receipts[0], /同一个元素|因为|页面没有变化/);
  assert.match(receipts[0], /已赞同 488/);
  assert.match(receipts[0], /赞同 487/);

  /* 本步变化：与回执同源，逐条列出 */
  assert.match(digests[0], /页面变化 1 处/);

  /* 停滞提示：STALL_MIN=2，第 3 步起才出；必须点出「追自己改过的行」并下死命令 */
  assert.strictEqual(notices[0], null);
  assert.strictEqual(notices[1], null);
  assert.match(notices[2], /上一步动作刚改动过的行/);
  assert.match(notices[notices.length - 1], /必须换一个/);

  /* 步序断言：本步变化 必须排在 页面快照 之后、停滞提示 之前 */
  const keys = Object.keys(AutoCore.buildState({
    goal: 'g', url: 'u', title: 't', history: [], snapshot: 's',
    lastChange: '页面变化 1 处', stallNotice: '停',
  }));
  assert.deepStrictEqual(keys, ['任务目标', '当前页面', '标签页', '已完成步骤', '上一步结果', '页面快照', '本步变化', '停滞提示']);
});

test('lineOfRef：给 ref 求它在快照里的行号；找不到给 null（不得猜）', () => {
  const lines = TOGGLE.prev.split('\n');
  assert.strictEqual(SnapDiff.lineOfRef(TOGGLE.prev, TOGGLE.actedRef), TOGGLE.expect.actedLine);
  assert.strictEqual(SnapDiff.lineOfRef(TOGGLE.prev, 'e999999'), null);
  assert.strictEqual(SnapDiff.lineOfRef(TOGGLE.prev, null), null);
  assert.strictEqual(SnapDiff.lineOfRef('', 'e1'), null);
  /* 必须与 diff 的 actedLine 同口径（同一个 0-based 内部索引），否则 chased 判定会错位 */
  assert.match(lines[TOGGLE.expect.actedLine], new RegExp('\\[ref=' + TOGGLE.actedRef + '\\]'));
});

test('isChanged：只回答「这一行是不是上一步动作改动过的行」', () => {
  const r = SnapDiff.diff({ prev: TOGGLE.prev, cur: TOGGLE.cur, actedRef: TOGGLE.actedRef });
  assert.strictEqual(SnapDiff.isChanged(r, TOGGLE.expect.actedLine), true);
  assert.strictEqual(SnapDiff.isChanged(r, TOGGLE.expect.actedLine + 1), false);
  assert.strictEqual(SnapDiff.isChanged(r, 0), false);
  /* 不可信 / 无上一步 / 整页替换时一律 false —— 宁可漏报，不可误报 */
  assert.strictEqual(SnapDiff.isChanged(SnapDiff.diff({ prev: TOGGLE.prev, cur: TOGGLE.cur, reliable: false }), 206), false);
  assert.strictEqual(SnapDiff.isChanged(SnapDiff.diff({ prev: '', cur: 'x' }), 0), false);
  assert.strictEqual(SnapDiff.isChanged(SnapDiff.diff({ prev: ORDERS, cur: RESUME }), 0), false);
  assert.strictEqual(SnapDiff.isChanged(null, 0), false);
});

test('receipt：reliable=false（两侧裁剪档位不同）→ 一字不改退回 base', () => {
  const r = SnapDiff.diff({ prev: TOGGLE.prev, cur: TOGGLE.cur, actedRef: TOGGLE.actedRef, reliable: false });
  assert.strictEqual(r.reliable, false);
  assert.strictEqual(SnapDiff.receipt({ base: '成功', diff: r }), '成功',
    '两侧裁剪档位不同时差分不可信 —— 宁可不说，也不能说假话');
  assert.strictEqual(SnapDiff.receipt({ base: '成功', diff: r }), '成功', '不得出现「无变化」');
  assert.strictEqual(SnapDiff.digestOf(r), '', '不可信时连清单都不出');
});

test('receipt：没有上一步（首步 / 快照缺失）→ 一字不改退回 base', () => {
  const none = SnapDiff.diff({ prev: '', cur: 'x' });
  assert.strictEqual(none.ok, false);
  assert.strictEqual(none.kind, 'no-prev');
  assert.strictEqual(SnapDiff.receipt({ base: '（这是第一步，之前尚无任何操作）', diff: none }),
    '（这是第一步，之前尚无任何操作）');
  assert.strictEqual(SnapDiff.receipt({ base: '成功', diff: null }), '成功');
  assert.strictEqual(SnapDiff.receipt({ base: '失败：命令超时', diff: undefined }), '失败：命令超时');
});

test('resume 页 16 个同名按钮：只改一个就只该认出那一行（结构指纹做不到这件事）', () => {
  const lines = RESUME.split('\n');
  const idx = lines.findIndex((l) => /button "邀请面试"/.test(l));
  assert.ok(idx > 0);
  const ref = lines[idx].match(/\[ref=([A-Za-z0-9_-]+)\]/)[1];
  const sameName = lines.filter((l) => /button "邀请面试"/.test(l)).length;
  assert.ok(sameName >= 16, '本用例的前提是这页有十几个同名按钮，实际 ' + sameName);
  const cur = lines.map((l, i) => (i === idx ? l.replace('邀请面试', '邀请面试（已邀请）') : l)).join('\n');
  const r = SnapDiff.diff({ prev: RESUME, cur: cur, actedRef: ref });
  assert.strictEqual(r.kind, 'local');
  assert.deepStrictEqual(r.changedInCur, [idx], '同名元素靠**位置的变化**区分，不靠身份');
  assert.strictEqual(r.chased, true);
});
