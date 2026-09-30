/* ===================== 参数题候选裁剪（ref-funnel） =====================
 * 背景：Auto 模式的「参数」题把快照里每一个 ref 都变成一个选项。密集页面（>250 个 ref）
 * 会撞上 Jev 接口 255 choices 的硬上限，整请求被拒、该步直接判死（实测 resume.html 393 个）。
 *
 * 分工：工程负责把候选收敛到模型判得好的规模，Jev 负责在候选里做决定。
 *   - 只在超限时介入：≤ SOFT_LIMIT 的页面原样透传，行为与裁剪功能上线前逐字节一致
 *   - 排序是确定性的加权和（关键词稀有度 / 可点击优先 / 已失败降权），同分按快照顺序
 *   - 还有候选未列出时附「其他」兜底项，由调用方在同一步内补问下一批
 *     （「无需元素」已下线：与不作用于元素的动作语义打架，被模型误当「本批没有目标」）
 *
 * 纯逻辑无 DOM：浏览器挂 window.RefFunnel，Node 走 module.exports（node:test 使用）。
 * ref 解析复用 util.js（同一实现保证浏览器与测试行为一致）。
 */
(function () {
  'use strict';

  var U = (typeof window !== 'undefined')
    ? { parseSnapshotRefs: window.parseSnapshotRefs, buildRefCriteria: window.buildRefCriteria }
    : require('./util.js');
  /* 上下文树 / 定位提示与「并行召回」路线共用（ref-context.js）——
   * 候选描述是模型区分同名按钮的唯一判据，两条路线各写一份必然漂移 */
  var Ctx = (typeof window !== 'undefined') ? window.RefContext : require('./ref-context.js');

  /* 接口硬上限 255，留 5 个余量给「其他」兜底项 */
  var SOFT_LIMIT = 250;
  var DEFAULT_LIMIT = 80;
  var REF_MORE = '其他';

  /* 打分权重 */
  var W_TERM = 8;          /* 每个命中词的基础分，再乘该词的稀有度权重（1~10） */
  var W_MAX_RARITY = 10;
  var W_CLICKABLE = 20;
  var W_FAILED = -40;

  /* 中文 bigram 的功能字前缀：以它们开头的 bigram 是切词噪声（「把高」「的候」） */
  var STOP_PREFIX = '把的了给将和与或在为请从到对向把就也还都很更只';
  /* 同一张卡片最多占几个候选位：候选要铺开到更多卡片，而不是被前几张卡片刷满。
   * 实测 resume.html：6 张卡片都含「高级前端 + React + TypeScript」时全部同分，
   * 不铺开的话前 80 个槽位被前 4 张卡吃光，真正合格的第 6 张卡（薪资 32K ≤ 35K，
   * 这条数字约束只有 Jev 判得了）反而看不到。4 ≈ 一张卡片里的操作按钮数。 */
  var PER_ANCESTOR_CAP = 4;

  /* 目标 → 词表：英文/数字词（小写、长度 ≥ 2）+ 中文 2-gram（过滤功能字前缀） */
  function extractTerms(goal) {
    var text = String(goal || '');
    var out = [];
    var seen = Object.create(null);
    var push = function (t) {
      if (!t || seen[t]) return;
      seen[t] = 1;
      out.push(t);
    };

    /* 英文 / 数字：按非字母数字切分 */
    text.toLowerCase().split(/[^a-z0-9]+/).forEach(function (w) {
      if (w.length >= 2) push(w);
    });

    /* 中文：每个连续汉字串生成全部 2-gram */
    var runs = text.match(/[一-鿿]+/g) || [];
    runs.forEach(function (run) {
      for (var i = 0; i + 2 <= run.length; i++) {
        var gram = run.slice(i, i + 2);
        if (STOP_PREFIX.indexOf(gram.charAt(0)) !== -1) continue;
        push(gram);
      }
    });
    return out;
  }

  /* ---------------- 上下文树（实现已移到 ref-context.js，两条算法路线共用） ----------------
   * 这里只留别名：树遍历由 ref-context.js 提供，funnel 只负责打分与分批。
   * 短名字让下面的调用点读起来不必处处带 Ctx. 前缀。 */
  var parseSnapshotTree = Ctx.parseSnapshotTree;
  var contextBounds = Ctx.contextBounds;

  /* ---------------- 打分与排序 ---------------- */

  function rankRefs(snapshot, opts) {
    var o = opts || {};
    var refs = U.parseSnapshotRefs(snapshot);
    var tree = parseSnapshotTree(snapshot);
    var bounds = contextBounds(tree);
    var terms = extractTerms(o.goal);
    var avoid = Object.create(null);
    (o.avoidRefs || []).forEach(function (r) { avoid[r] = 1; });

    /* 一轮遍历：算出每个 ref 命中哪些词（同时也是稀有度统计的语料）
     * 匹配文本统一小写 —— 词表里的英文词是小写的，页面里却是 AirPods / React 这种写法，
     * 不统一大小写的话英文词永远命不中（中文不受影响）。
     * 命中 = 「所在块」的命中 ∪ 自身标签的命中；同一块只算一次（块内元素共享块级命中，
     * 于是同一行的元素分数只差「可点击 +20」，按钮稳稳排在静态单元格前面）。 */
    var ctxCache = Object.create(null);
    var hitsOf = function (key, text) {
      if (!(key in ctxCache)) {
        ctxCache[key] = terms.filter(function (t) { return text.indexOf(t) !== -1; });
      }
      return ctxCache[key];
    };
    var matched = refs.map(function (r) {
      var b = bounds[r.ref] || { contextText: '', ancestorName: '', unitLine: -1 };
      var unitKey = (b.unitLine >= 0) ? ('u' + b.unitLine) : ('r' + r.ref);
      var ctxHits = hitsOf(unitKey, b.contextText.toLowerCase());
      var ownHits = hitsOf('l:' + r.ref, r.label.toLowerCase());
      var inCtx = Object.create(null);
      ctxHits.forEach(function (t) { inCtx[t] = 1; });
      ownHits.forEach(function (t) { inCtx[t] = 1; });
      return {
        r: r, ancestor: b.ancestorName, unitLine: b.unitLine,
        hits: terms.filter(function (t) { return inCtx[t]; })
      };
    });

    /* 稀有度：词在越少的候选中出现，越能区分目标（「32K」比「候选人」值钱得多） */
    var count = Object.create(null);
    matched.forEach(function (m) { m.hits.forEach(function (t) { count[t] = (count[t] || 0) + 1; }); });
    var total = refs.length || 1;
    var weightOf = function (t) {
      return 1 + Math.round((W_MAX_RARITY - 1) * (total - count[t]) / total);
    };

    var ranked = matched.map(function (m, idx) {
      var reasons = [];
      var kw = 0;
      m.hits.forEach(function (t) { kw += W_TERM * weightOf(t); });
      if (kw) reasons.push('关键词×' + m.hits.length + ' +' + kw);
      var score = kw;
      if (m.r.interactive) { score += W_CLICKABLE; reasons.push('可点击 +' + W_CLICKABLE); }
      if (avoid[m.r.ref]) { score += W_FAILED; reasons.push('已失败 ' + W_FAILED); }
      var b = bounds[m.r.ref];
      /* 归属组 = 上下文块（同一张卡/同一行算一组，用于铺开）；
       * 没有块时各自成组，不受限制 */
      var group = (b && b.unitLine >= 0) ? ('A' + b.unitLine) : ('S' + m.r.ref);
      return {
        ref: m.r.ref, label: m.r.label, interactive: m.r.interactive,
        ancestor: m.ancestor, score: score, reasons: reasons, group: group, at: idx
      };
    });

    /* 分数降序；同分按快照顺序（稳定、可复现，不加分） */
    ranked.sort(function (a, b) { return b.score - a.score || a.at - b.at; });
    return { ranked: ranked, terms: terms };
  }

  /* 选序：前 limit 个按「同一卡片最多 PER_ANCESTOR_CAP 个」铺开，其余按分数续上。
   * 只约束第一批（召回靠它），后续批次纯粹按分数。 */
  function orderWithDiversity(ranked, limit) {
    var front = [];
    var used = Object.create(null);
    ranked.forEach(function (x) {
      if (front.length < limit && (used[x.group] || 0) < PER_ANCESTOR_CAP) {
        used[x.group] = (used[x.group] || 0) + 1;
        front.push(x);
      }
    });
    var inFront = Object.create(null);
    front.forEach(function (x) { inFront[x.ref] = 1; });
    var tail = [];
    ranked.forEach(function (x) { if (!inFront[x.ref]) tail.push(x); });
    return front.concat(tail);
  }

  /* ---------------- 裁剪后的 criteria ---------------- */

  function buildBoundedRefCriteria(snapshot, opts) {
    var o = opts || {};
    var batch = Math.max(1, parseInt(o.batch, 10) || 1);
    var maxTranches = (o.maxTranches == null) ? 3 : Math.max(0, parseInt(o.maxTranches, 10) || 0);
    var wantLimit = parseInt(o.limit, 10) || DEFAULT_LIMIT;
    var forcedClamp = false;
    if (wantLimit > SOFT_LIMIT) { wantLimit = SOFT_LIMIT; forcedClamp = true; }
    if (wantLimit < 1) wantLimit = 1;

    var all = U.parseSnapshotRefs(snapshot);
    var base = {
      totalRefs: all.length, limit: wantLimit, batch: batch, maxTranches: maxTranches,
      folded: 0, hiddenMore: 0, forcedClamp: forcedClamp, top: []
    };

    /* 未超限：原样透传（零回归） */
    if (all.length <= SOFT_LIMIT) {
      base.trimmed = false;
      return { criteria: U.buildRefCriteria(snapshot), meta: base };
    }

    var order = orderWithDiversity(rankRefs(snapshot, o).ranked, wantLimit);
    var slice = order.slice((batch - 1) * wantLimit, batch * wantLimit);
    base.top = slice;
    base.trimmed = true;
    base.folded = all.length - slice.length;

    var criteria = Object.create(null);
    slice.forEach(function (x) {
      /* 候选描述走共用实现：前缀 + 元素自身标签 + 定位提示。
       * 与并行召回路线（ref-recall）逐字一致 —— 同一个 ref 在两条路线上必须长得一样 */
      criteria[x.ref] = Ctx.criterionText(x);
    });

    var remaining = all.length - batch * wantLimit;
    if (remaining > 0 && batch < maxTranches) {
      base.remaining = remaining;
      criteria[REF_MORE] = '还有 ' + remaining + ' 个候选未列出，选中即自动展开下一批（第 '
        + (batch + 1) + '/' + maxTranches + ' 批）';
    } else if (remaining > 0) {
      base.hiddenMore = remaining;   /* 已到最后一批：不再给兜底项，避免无限展开 */
    }

    return { criteria: criteria, meta: base };
  }

  function isMoreChoice(key) { return key === REF_MORE; }

  var RefFunnel = {
    SOFT_LIMIT: SOFT_LIMIT,
    DEFAULT_LIMIT: DEFAULT_LIMIT,
    REF_MORE: REF_MORE,
    extractTerms: extractTerms,
    rankRefs: rankRefs,
    buildBoundedRefCriteria: buildBoundedRefCriteria,
    isMoreChoice: isMoreChoice,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = RefFunnel;
  if (typeof window !== 'undefined') window.RefFunnel = RefFunnel;
})();
