/* ===================== 参数题候选 · 并行召回（ref-recall） =====================
 * 背景：Auto 模式的「参数」题把快照里每个 ref 变成一个选项，撞上 Jev 接口 255 choices
 * 硬上限（实测 resume.html 393 个）。ref-funnel.js 的解法是「工程侧确定性排序 → 有损裁剪
 * → 「其他」兜底补问」；本模块是另一条路：**不排序、不丢元素**，把快照按 size 切成 K 批
 * 并行交给 Jev，各批取概率前 topN 召回，合并成一个候选集，再请 Jev 做**一次最终决策**。
 *
 * 分工（与设计一致）：
 *   - 工程负责切批与合并（确定性、纯逻辑、可 fixture 锁）
 *   - Jev 负责两件分类任务：① 每批内按概率排出最像目标的 topN（召回）
 *                          ② 在合并后的候选集里做最终选择（决策）
 *
 * 概率的正确用法：接口回的 probabilities 是**本批内归一**的分布，跨批不可比 —— 所以它
 * 只被用来做**批内召回排序**，绝不参与跨批比较、也绝不当作最终答案。最终结果永远来自
 * 合并后那一次 Jev 调用。
 *
 * 纯逻辑无 DOM：浏览器挂 window.RefRecall，Node 走 module.exports（node:test 使用）。
 * ref 解析与候选描述复用 util.js（同一实现保证浏览器与测试行为一致）。
 */
(function () {
  'use strict';

  var U = (typeof window !== 'undefined')
    ? { parseSnapshotRefs: window.parseSnapshotRefs }
    : require('./util.js');
  /* 候选描述与定位提示复用 ref-context.js（与 ref-funnel 同一份实现）：
   * 「（在「候选人 周一鸣（高级前端工程师）」内）」是模型区分同名按钮的唯一判据，
   * 并行召回若不带它，合并后那 4 个 `button "邀请面试"` 在最终决策里根本没法区分 */
  var Ctx = (typeof window !== 'undefined') ? window.RefContext : require('./ref-context.js');

  var DEFAULT_SIZE = 200;    /* 每批元素数：K = ceil(总 ref / size) */
  var DEFAULT_TOPN = 15;     /* 每批召回条数（只做召回，标签名不叫「答案」） */
  var MERGE_MAX = 250;       /* 合并后候选上限：接口硬上限 255 留 5 个余量 */
  var SIZE_MIN = 10;
  var SIZE_MAX = 250;
  var RECALL_Q = '参数';      /* 召回批次与最终决策都只问这一道题（剥信封时按它取名） */

  function clampInt(v, lo, hi, dflt) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) n = dflt;
    if (n < lo) n = lo;
    if (n > hi) n = hi;
    return n;
  }

  function criteriaFor(refs, hints) {
    var h = hints || {};
    var out = Object.create(null);
    refs.forEach(function (r) {
      out[r.ref] = Ctx.criterionText({ label: r.label, interactive: r.interactive, ancestor: h[r.ref] });
    });
    return out;
  }

  /* ---------------- 切批 ----------------
   * 一页 ref 按 size 切成前后两段，**确定性、不排序、不丢元素**：
   *   首段（前 size 个）= 首轮「参数」题的候选 —— 首轮仍是三道题（动作/参数/未完成），
   *                          参数只给这一段，既不超过接口上限，也不必先排一遍序
   *   其余（第 size 个之后）= 并行召回要覆盖的部分，再按 size 切 K 批
   * 于是「并行召回的 ref 集合不包含首轮 Jev 看过的那部分」是**切法自带的性质**，
   * 不靠事后剔除；400 个 ref / size 200 → 首轮 200、召回 1 批 200。
   * 按快照顺序连续切：同一张卡片 / 同一表格行的元素天然落在同一批里，
   * 祖先上下文不会被批次边界切断，同输入同切法（fixture 锁得住）。
   * total ≤ size 时没有召回批次，调用方走原有的单次调用路径（零额外请求）。 */
  function planBatches(snapshot, opts) {
    var o = opts || {};
    var size = clampInt(o.size, SIZE_MIN, SIZE_MAX, DEFAULT_SIZE);
    /* 召回数不能超过一批的容量，否则「每批取 topN」是空话 */
    var topN = clampInt(o.topN, 1, size, Math.min(DEFAULT_TOPN, size));
    var refs = U.parseSnapshotRefs(snapshot);
    var firstRefs = refs.slice(0, size);
    var rest = refs.slice(size);
    /* 候选描述与整页定位提示**惰性算、全程只算一次**：hintsOf 要 parseSnapshotTree +
     * contextBounds 全量遍历，criteriaFor 再逐 ref 拼字符串 —— 而元素不超过一批
     * （refs ≤ size，绝大多数演示页）时没有召回批次，调用方（recallPlan）只看
     * meta.parallel 就返回 null 走单次调用，plan.first / plan.labels 一个都不读，
     * 这两份白算的东西随后还会被 paramCriteria / refCriteria 按同一套逻辑再算一遍。
     * 惰性用 getter 实现：对外可读性逐字不变（读 plan.first.criteria / plan.labels
     * 拿到的还是同一份值，且每个对象只算一次）。 */
    var labels = null;
    function labelsOnce() {
      if (labels === null) labels = criteriaFor(refs, Ctx.hintsOf(snapshot));
      return labels;
    }
    function subsetOf(list) {
      var l = labelsOnce();
      var out = Object.create(null);
      list.forEach(function (r) { out[r.ref] = l[r.ref]; });
      return out;
    }
    /* 召回批次：只有真存在批次时才走到 subsetOf —— 循环体为空时 labels 一次都不算 */
    var batches = [];
    for (var i = 0; i < rest.length; i += size) {
      var slice = rest.slice(i, i + size);
      batches.push({ index: batches.length + 1, refs: slice, criteria: subsetOf(slice) });
    }

    var firstCriteria = null;
    var first = { refs: firstRefs };   /* 首轮「参数」候选 */
    Object.defineProperty(first, 'criteria', {
      enumerable: true, configurable: true,
      get: function () {
        if (firstCriteria === null) firstCriteria = subsetOf(firstRefs);
        return firstCriteria;
      },
    });

    var out = {
      first: first,
      batches: batches,                                          /* 并行召回的批次 */
      meta: {
        algorithm: 'parallel',
        totalRefs: refs.length,
        size: size,
        topN: topN,
        firstSize: firstRefs.length,
        batches: batches.length,
        parallel: batches.length > 0,
      },
    };
    /* ref → 描述（合并时按它回填，跨批一致）：同样惰性，只有并行召回真跑起来才被读 */
    Object.defineProperty(out, 'labels', {
      enumerable: true, configurable: true, get: labelsOnce,
    });
    return out;
  }

  /* ---------------- 剥掉响应信封，拿到内层「作答」 ----------------
   * 真机响应是两层：{ model, answers: { 参数: { type, choice, probabilities } } }。
   * 纯逻辑只认内层那一层，可是调用方手里往往是**整封信**（callJev 回的 data）。
   * 这里统一剥一次，且**刻意容忍两种形状**——因为这个传错一层的 bug 已经真实付过代价：
   * 调用方把信封喂进来，内层永远读不到 choice / probabilities，于是每一批都召回 0 个，
   * 最终候选只剩首轮那一个（会话 r-0928-1954-4dgf：469 个 ref、2 批"召回"全空，
   * 面板写「候选 1 个」）。传错一层不会报错、只会静默地什么都没召回，所以让它在这层被吃掉：
   * 调用方传信封或传作答，结果必须相同。
   * 名字对不上时只认「这道题只有一个候选」的情形，不猜多题响应里的哪一道。 */
  function answerOf(x) {
    if (!x || typeof x !== 'object') return null;
    var env = x.answers;
    if (!env || typeof env !== 'object' || Array.isArray(env)) return x;   /* 已经是作答本身 */
    if (env[RECALL_Q] != null) return env[RECALL_Q];
    var keys = Object.keys(env);
    return keys.length === 1 ? env[keys[0]] : null;
  }

  /* ---------------- 单批作答 → 召回条目 ----------------
   * 三条硬规则：
   *   ① 只认「本批候选内」的键 —— 作答落在批外（代理换了顺序 / 回错批）直接丢弃，不问理由
   *   ② 概率 > 0 的项按概率降序取前 N；**作答的 choice 无论如何都排在最前面**（它是模型自己
   *      选的）。三种形态都要覆盖：落在概率分布之外、概率被写成 0、概率很小排在 topN 之外 ——
   *      最后这种最容易被漏：它确实在概率列表里，只是排在后面，被 slice 一刀切掉
   *      （实测：作答的 ref 因此没进最终候选，而 meta 里 choiceInBatch 还是 true，自相矛盾）
   *   ③ 一个概率都没有（旧协议 / 响应被裁剪）→ 仍然只回收 choice 一项，保证召回不空手
   * 排序：作答恒第一；其余概率降序，同概率按候选在快照里的顺序（Object.keys 插入序），确定性。 */
  function pickFromAnswer(criteria, answer, topN) {
    var a = answerOf(answer) || {};
    var probs = a.probabilities || null;
    var out = [];
    var ordered = Object.keys(criteria);
    if (probs) {
      ordered.forEach(function (k, order) {
        var p = Number(probs[k]);
        if (isFinite(p) && p > 0) out.push({ ref: k, p: p, order: order });
      });
      out.sort(function (x, y) { return y.p - x.p || x.order - y.order; });
    }
    var choice = (a.choice == null) ? null : String(a.choice);
    if (choice && criteria[choice]) {
      var at = -1;
      out.forEach(function (x, i) { if (x.ref === choice && at < 0) at = i; });
      if (at >= 0) out.splice(at, 1);        /* 先摘下来：不论它原本排第几，都改排最前 */
      out.unshift({ ref: choice, p: probs ? (Number(probs[choice]) || 0) : 1, order: -1 });
    }
    return out.slice(0, topN);
  }

  /* ---------------- 合并 ----------------
   * 各批召回条目求并集（同一 ref 被多批召回时取最大概率、记最早批次），
   * 排序仍是「概率降序 → 批次 → 快照顺序」；超过 MERGE_MAX 按此序截断并记 clamped。
   * seed：首轮「参数」题在那一段元素里选出的**前 N 个**（默认 topN 个，作答的那个必在其中）。
   * 首轮那一段不在召回范围内，只能由首轮自己的预测代表；带前 N 个而不是只带作答的那一个 ——
   * 首轮的概率分布本身就是一次有效的相关性判断，只留一个会让最终决策没有任何可比较的对手
   * （实测：候选只剩 1 个，那次「决策」是空转）。它们排在候选最前面（用户定的规则）。
   * 返回的 criteria 里**没有**「其他」：并行召回的语义是「候选就在这里，请直接决策」，
   * 不给再次展开的逃生口（那是 ref-funnel 的分批补问路线）。 */
  function mergeBatches(plan, answers, opts) {
    var o = opts || {};
    var topN = clampInt(o.topN, 1, MERGE_MAX, plan.meta.topN || DEFAULT_TOPN);
    var byRef = Object.create(null);
    var order = [];
    var perBatch = [];

    plan.batches.forEach(function (b, i) {
      var ans = answerOf((answers || [])[i]);   /* 传信封或传作答都行，见 answerOf */
      var picks = pickFromAnswer(b.criteria, ans, topN);
      perBatch.push({
        index: b.index,
        size: b.refs.length,
        choice: (ans && ans.choice != null) ? String(ans.choice) : null,
        /* 作答落在本批候选内 = 这一批的召回是「干净」的；落在批外说明这一批没被真正作答 */
        choiceInBatch: Boolean(ans && ans.choice != null && b.criteria[ans.choice]),
        recalled: picks.map(function (x) { return x.ref; }),
      });
      picks.forEach(function (x) {
        var cur = byRef[x.ref];
        if (!cur) {
          byRef[x.ref] = { ref: x.ref, p: x.p, batch: b.index, order: order.length };
          order.push(x.ref);
        } else if (x.p > cur.p) {
          cur.p = x.p;
          cur.batch = b.index;
        }
      });
    });

    var all = order.map(function (r) { return byRef[r]; });
    all.sort(function (a, b) { return b.p - a.p || a.batch - b.batch || a.order - b.order; });

    var criteria = Object.create(null);
    var seeds = [];
    (o.seed || []).forEach(function (r) {
      if (!r || criteria[r] || !plan.labels[r]) return;   /* 只认本页真实 ref */
      criteria[r] = plan.labels[r];
      seeds.push(r);
    });
    /* 种子先占位，召回并集按序截断到「上限 − 种子数」：
     * 两个上限是同一条 255 硬上限，若各算各的（250 个召回 + 15 个种子 = 265），
     * 这一题会被接口直接拒掉 —— 全页候选最多时正好会撞上（size/topN 都调到 250 时） */
    var kept = all.slice(0, Math.max(0, MERGE_MAX - seeds.length));
    kept.forEach(function (x) { criteria[x.ref] = plan.labels[x.ref]; });

    return {
      criteria: criteria,
      meta: {
        algorithm: 'parallel',
        totalRefs: plan.meta.totalRefs,
        size: plan.meta.size,
        topN: topN,
        batches: plan.batches.length,
        seeded: seeds,                 /* 首轮前 N 个带进来的候选（排在最前面） */
        recalled: all.length,          /* 各批召回并集（截断前） */
        merged: Object.keys(criteria).length,   /* 真正给 Jev 做最终决策的候选数 */
        clamped: Math.max(0, all.length - kept.length),
        perBatch: perBatch,
      },
    };
  }

  var RefRecall = {
    DEFAULT_SIZE: DEFAULT_SIZE,
    DEFAULT_TOPN: DEFAULT_TOPN,
    MERGE_MAX: MERGE_MAX,
    criteriaFor: criteriaFor,
    planBatches: planBatches,
    answerOf: answerOf,
    pickFromAnswer: pickFromAnswer,
    mergeBatches: mergeBatches,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = RefRecall;
  if (typeof window !== 'undefined') window.RefRecall = RefRecall;
})();
