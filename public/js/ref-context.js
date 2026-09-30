/* ===================== 快照上下文树（ref-context） =====================
 * 「参数」题的两条算法路线（ref-funnel 的相关性裁剪、ref-recall 的并行召回）共用这一段：
 * 从快照缩进树给每个 ref 找一块**上下文块**（同一张卡片 / 同一表格行），产出
 *   ① 候选描述里的定位提示（`（在「候选人 周一鸣（高级前端工程师）」内）`）
 *   ② 打分用的块文本（ref-funnel 的关键词命中语料）
 *
 * 为什么必须共用：候选描述是模型区分同名按钮的**唯一判据**（resume.html 全页 16 个
 * `button "邀请面试"`）。两条路线各写一份格式，漂移一次就会让其中一条路线上的模型
 * 分不清卡片 —— 所以参照系（块怎么选、提示怎么截）只在这里定义一次。
 *
 * 纯逻辑无依赖、无 DOM：浏览器挂 window.RefContext，Node 走 module.exports。
 */
(function () {
  'use strict';

  /* 上下文最长取多少字符。订单行这类块含买家留言/地址，动辄两三千字；
   * 太短会把块尾部（商品、状态）截掉，同一块里的元素就会因为这块截断而分数不公 */
  var CONTEXT_CAP = 3000;
  /* 祖先名字超过这个长度就不当定位提示（没信息量） */
  var ANCESTOR_HINT_CAP = 40;
  /* 上下文块的尺寸上限（行数）：块一旦超过它就不再当「卡片/行」看，继续往外走也只会更大。
   * 卡片 ~22 行、表格行 ~10 行都在这条线以内 */
  var GROUP_MAX_LINES = 60;
  /* 没有任何可用祖先块时（极扁页面）退化用的窗口半径 */
  var WINDOW_LINES = 15;

  /* ---------------- 缩进树 ----------------
   * 真实页面里同名按钮到处都是（resume.html 每张卡片都有「邀请面试」），
   * 区分候选人的信息（姓名、技能、期望薪资）在卡片容器及其兄弟节点上。
   * 只看元素自身标签，几百个同名按钮会全部同分 / 全部长得一样。 */
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
        /* 同一个 ref 出现两次（真快照不会有，手工/裁剪样本可能有）时按**第一次**那行算：
         * util.parseSnapshotRefs 的标签也是首次优先，两边取同一行才不会出现
         * 「标签是 A 的名字、提示是 B 的所在」这种自相矛盾的候选描述 */
        if (!(refMatch[1] in out)) {
          out[refMatch[1]] = { contextText: text, ancestorName: name, unitLine: unit };
        }
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

  /* ---------------- 对外：两条路线共用的两个契约 ---------------- */

  /* ref → 定位提示（祖先名字）。没有可用祖先的 ref 不出现在结果里 */
  function hintsOf(snapshot) {
    var bounds = contextBounds(parseSnapshotTree(snapshot));
    var out = Object.create(null);
    Object.keys(bounds).forEach(function (r) {
      if (bounds[r].ancestorName) out[r] = bounds[r].ancestorName;
    });
    return out;
  }

  /* 单条候选描述：`【可交互】 button "邀请面试"（在「候选人 周一鸣（高级前端工程师）」内）`
   * 前缀标记可操作性、label 是元素自身、括号里是定位提示。
   * 自身标签里已经含祖先名字时不重复追加（同名会被念两遍，白占 token）。 */
  function criterionText(x) {
    var o = x || {};
    var label = String(o.label == null ? '' : o.label);
    var hint = (o.ancestor && label.indexOf(o.ancestor) === -1)
      ? '（在「' + shortName(o.ancestor) + '」内）' : '';
    return (o.interactive ? '【可交互】' : '【容器/静态】') + ' ' + label + hint;
  }

  var RefContext = {
    CONTEXT_CAP: CONTEXT_CAP,
    ANCESTOR_HINT_CAP: ANCESTOR_HINT_CAP,
    GROUP_MAX_LINES: GROUP_MAX_LINES,
    WINDOW_LINES: WINDOW_LINES,
    parseSnapshotTree: parseSnapshotTree,
    contextBounds: contextBounds,
    firstQuotedName: firstQuotedName,
    shortName: shortName,
    hintsOf: hintsOf,
    criterionText: criterionText,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = RefContext;
  if (typeof window !== 'undefined') window.RefContext = RefContext;
})();
