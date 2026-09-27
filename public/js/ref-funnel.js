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
  /* 上下文最长取多少字符。订单行这类块含买家留言/地址，动辄两三千字；
   * 太短会把块尾部（商品、状态）截掉，同一块里的元素就会因为这块截断而分数不公 */
  var CONTEXT_CAP = 3000;
  /* 祖先名字超过这个长度就不当定位提示（没信息量） */
  var ANCESTOR_HINT_CAP = 40;
  /* 同一张卡片最多占几个候选位：候选要铺开到更多卡片，而不是被前几张卡片刷满。
   * 实测 resume.html：6 张卡片都含「高级前端 + React + TypeScript」时全部同分，
   * 不铺开的话前 80 个槽位被前 4 张卡吃光，真正合格的第 6 张卡（薪资 32K ≤ 35K，
   * 这条数字约束只有 Jev 判得了）反而看不到。4 ≈ 一张卡片里的操作按钮数。 */
  var PER_ANCESTOR_CAP = 4;
  /* 上下文块的尺寸上限（行数）：块一旦超过它就不再当「卡片/行」看，继续往外走也只会更大。
   * 卡片 ~22 行、表格行 ~10 行都在这条线以内 */
  var GROUP_MAX_LINES = 60;
  /* 没有任何可用祖先块时（极扁页面）退化用的窗口半径 */
  var WINDOW_LINES = 15;

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

  /* ---------------- 快照缩进树：算每个 ref 的「最近带名字祖先」及其整块文本 ----------------
   * 为什么需要它：真实页面里同名按钮到处都是（resume.html 每张卡片都有「邀请面试」），
   * 区分候选人的信息（姓名、技能、期望薪资）在卡片容器及其兄弟节点上。
   * 只看元素自身标签，几百个同名按钮会全部同分，裁剪照样切掉目标。
   */
  function parseSnapshotTree(snapshot) {
    var lines = String(snapshot || '').split('\n');
    var depthOf = lines.map(function (l) {
      var m = l.match(/^\s*/);
      return Math.floor(m[0].length / 2);
    });

    /* 每行的块结束位置（不含）：下一个深度 ≤ 自己的行 */
    var endOf = new Array(lines.length);
    var stack = [];
    for (var i = 0; i < lines.length; i++) {
      while (stack.length && depthOf[i] <= depthOf[stack[stack.length - 1]]) {
        endOf[stack.pop()] = i;
      }
      stack.push(i);
    }
    while (stack.length) endOf[stack.pop()] = lines.length;

    /* 带名字的行（- role "名字"）才有资格当定位锚点 */
    var nameOf = lines.map(function (l) {
      var m = l.match(/^\s*-?\s*([a-z]+)\s+"([^"]*)"/);
      if (!m) return null;
      if (/\/url|\[ref=/.test(l) && /^\s*-\s*\//.test(l)) return null;
      return m[2];
    });

    return { lines: lines, depthOf: depthOf, endOf: endOf, nameOf: nameOf };
  }

  /* 每个 ref → { contextText, ancestorName, unitLine }（不含自身标签，自身标签由调用方补）
   *
   * 上下文取「**最后一个没超尺寸的外层块**」：从元素往上走，只要块行数 ≤ GROUP_MAX_LINES
   * 就继续往上，直到外层的块太大为止。于是
   *   resume.html：按钮 → 无名 generic → article「候选人 周一鸣（…）」← 取卡片这一层（22 行）
   *   orders.html：按钮 → 无名 cell → row ← 取行这一层（23 行，行没有 aria 名字但仍是块）
   * 两个真实密集页靠这条规则拿到「卡片/行级」上下文；改成只取最近的*带名字*祖先会在表格页上
   * 退化成整张表 → 全表元素同分 → 目标掉到第 216 名（实测）。
   */
  function contextBounds(tree) {
    var out = Object.create(null);
    var stack = [];
    for (var i = 0; i < tree.lines.length; i++) {
      /* 先弹栈：不比本行深的兄弟/更深的行不是祖先，必须弹掉再找
       * （曾经在查完祖先才弹，结果把同层的上一个按钮当成了祖先） */
      while (stack.length && tree.depthOf[i] <= tree.depthOf[stack[stack.length - 1]]) stack.pop();
      var refMatch = tree.lines[i].match(/\[ref=([A-Za-z0-9_-]+)\]/);
      if (refMatch) {
        /* 由深到浅，取最后一个仍然 ≤ GROUP_MAX_LINES 的块；一旦超了就停（更外层只会更大） */
        var unit = -1;
        for (var s = stack.length - 1; s >= 0; s--) {
          if (tree.endOf[stack[s]] - stack[s] > GROUP_MAX_LINES) break;
          unit = stack[s];
        }
        /* 定位提示要落到元素自己那一层：块里最近的有名字祖先。
         * 块本身可能是个装了好几张卡片的无名网格，这时块的名字（第一个带引号的名字）
         * 属于第一张卡，会把同块其它卡片的同名按钮全顶替掉。
         * stack 按行号递增，所以从深到浅扫到块边界为止即可。 */
        var hintLine = -1;
        for (var h = stack.length - 1; h >= 0; h--) {
          if (unit >= 0 && stack[h] < unit) break;
          if (tree.nameOf[stack[h]]) { hintLine = stack[h]; break; }
        }
        var text;
        if (unit >= 0) {
          text = tree.lines.slice(unit, tree.endOf[unit]).join(' ');
        } else {
          /* 连上一层都过大（块都没有的极扁页面）：退化成元素周围的窗口 */
          text = tree.lines.slice(Math.max(0, i - WINDOW_LINES), Math.min(tree.lines.length, i + WINDOW_LINES + 1)).join(' ');
        }
        if (text.length > CONTEXT_CAP) text = text.slice(0, CONTEXT_CAP);
        var name = (hintLine >= 0)
          ? tree.nameOf[hintLine]
          : firstQuotedName(tree, unit >= 0 ? unit : i);
        out[refMatch[1]] = { contextText: text, ancestorName: name, unitLine: unit };
      }
      stack.push(i);
    }
    return out;
  }

  /* 块自己没有名字时（表格行、无 aria-label 的卡片），用块内第一个带引号的名字当线索 ——
   * 订单行会给出「订单号 SO-2026…」这类能区分同一批同名按钮的信息 */
  function firstQuotedName(tree, lineIdx) {
    if (lineIdx < 0) return '';
    var end = Math.min(tree.endOf[lineIdx], lineIdx + 8);
    for (var i = lineIdx; i < end; i++) {
      if (tree.nameOf[i]) return tree.nameOf[i];
    }
    return '';
  }

  function shortName(label) {
    var m = String(label || '').match(/"([^"]*)"/);
    var s = m ? m[1] : String(label || '');
    s = s.replace(/\s+/g, ' ').trim();
    return s.length > ANCESTOR_HINT_CAP ? s.slice(0, ANCESTOR_HINT_CAP) + '…' : s;
  }

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
      var hint = (x.ancestor && x.label.indexOf(x.ancestor) === -1)
        ? '（在「' + shortName(x.ancestor) + '」内）' : '';
      criteria[x.ref] = (x.interactive ? '【可交互】' : '【容器/静态】') + ' ' + x.label + hint;
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
    _test: { parseSnapshotTree: parseSnapshotTree, contextBounds: contextBounds, shortName: shortName }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = RefFunnel;
  if (typeof window !== 'undefined') window.RefFunnel = RefFunnel;
})();
