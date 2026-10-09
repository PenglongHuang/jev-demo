/* ===================== 快照差分（snapshot-diff） =====================
 * 事故链条（会话 r-0929-1918-7yw4 第 5~10 步）：agent 连点同一个「赞同」按钮六次，
 * 13 步预算烧掉 6 步。原因是 playwright 的 aria 快照 ref 是**快照内的临时句柄** ——
 * playwright-core 的 computeAriaRef 在角色或可读名字变化时重新签发：
 *   if (!ariaRef || ariaRef.role !== ariaNode.role || ariaRef.name !== ariaNode.name) { …新号… }
 * 于是一次只改了自己文案的点击（已赞同 488 → 赞同 487）让元素看起来是全新的：
 *   decisionSig / failedRefs / 已完成步骤 全部按 ref 认元素 → 认不出；
 *   detectStall 按快照逐字节比较 → 每次都「变了」，从不报警；
 *   上一步结果 恒为「成功」—— 模型手里没有一条线索。
 *
 * 为什么不做「元素身份函数」：结构指纹（role + 祖先锚 + 兄弟锚 + 序号、排除自身名字）
 * 在真实密集页上必然塌缩 —— resume.html 的 16 个 `button "邀请面试"` 会归成一组，
 * zhihu 553 个 ref 只有 435 个不同指纹。元素本来就无法从快照**静态地**区分；
 * 能区分的是**变化**：哪一行变了。所以原语是「两份相邻快照的归一化行差分」。
 *
 * 归一化只做三件事，且**行数一定不变**（行号是其他一切信号的坐标系）：
 *   ① [ref=...] → [ref]   —— playwright 每步重排句柄（jwac 2→3 有 440 行）
 *   ② 剥掉 [active]        —— document.activeElement（焦点），纯采样噪声
 *   ③ 压空白 + trim
 * **刻意不剥** [selected] / [disabled] / [pressed] / [expanded] / [checked]：那是**语义状态**，
 * 「点提交 → 按钮变灰」「点行 → 该行选中」只体现在它们身上，剥掉就被抹成「无变化」
 * （合成用例实测：`button "提交"` → `button "提交" [disabled]` 全剥下是 -0/+0）。
 * 也**刻意不**挖空引号里的名字 —— 名字变化正是本模块要抓的信号。
 *
 * 输出只陈述**观测**，不做身份断言、不做因果断言（「是同一个元素」「因为你点了」都不写）：
 * 解释权归模型 —— 回执里带着新旧两个 ref，模型自己就能把 [ref=f1e1137] 和
 * 「已完成步骤」里那条 `5. click【f1e1137 · 已赞同 488】成功` 接上。
 *
 * 纯逻辑无 DOM：浏览器挂 window.SnapshotDiff，Node 走 module.exports（node:test 使用）。
 */
(function () {
  'use strict';

  var U = (typeof window !== 'undefined')
    ? { clipMiddle: window.clipMiddle }
    : require('./util.js');
  var clipMiddle = U.clipMiddle;

  /* 逐行差分时中间段的最大规模：超过就不做精确差分，只报统计。
   * 实测真实局部改动的中间段只有 1×1（知乎/jwac），最大的一个是 HF 下拉展开的 826×793
   * ≈ 65 万格 / 20ms —— 所以帽子给到 70 万格，**把实测到的最坏情况盖在里面**。
   * 再大就是「上千行都变了」，精确 hunk 列表既付不起、模型也读不懂，只报统计。 */
  var DIFF_CELL_CAP = 700000;
  var MAX_DIFF_LINES = 4000;
  /* 「整页替换」的判据：抽 64 个等距位置比对，匹配率低于它才算整页换掉。
   *
   * 为什么不用「公共前后缀跨度」：那个判据会把**零散小改**误判成整页替换 ——
   * 每 20 行改一个字符、改满全页时前缀与后缀都接近 0，跨度判据立刻说「整页更换」，
   * 于是 700 行里 35 处小改的清单被整条丢掉（本模块的测试就是这么撞出来的）。
   * 抽样比对只有 64 次字符串比较，却能把这两种情形分开：
   *   导航换页    → 抽样几乎全不匹配 → 整页替换
   *   零散小改    → 抽样大多匹配   → 走精确差分，改动逐条列出 */
  var PAGE_REPLACE_ANCHOR = 0.20;
  var SAMPLE_POINTS = 64;

  /* 「本步变化」正文预算与条数上限。实测 digest 体积：改名类 78 B、无进展类 130 B、
   * 65 处改动类约 750 B，所以 800 B + 6 条对真实用例都是够的（CJK 一行约 240 B 时
   * 实际只能列 3 条左右 —— 由字节帽而不是条数帽说了算，这是刻意的）。 */
  var DIGEST_BUDGET_BYTES = 800;
  var MAX_HUNKS_SHOWN = 6;
  var TAIL_RESERVE_BYTES = 48;

  /* 回执里那一处改动的可见长度（**字符**，先剥掉缩进再算）。
   * 剥缩进是必须的：快照里深层元素带 20+ 空格缩进，不剥会把预算全吃在空白上，
   * 60 字符处正好把行尾的 ref 截断 —— 而新旧两个 ref 正是模型最需要的东西。
   * 用 clipMiddle（两头留）而非 slice：ref 在行尾，切尾等于切掉句柄。 */
  var HUNK_LINE_CHARS = 60;
  var RECEIPT_MAX_BYTES = 300;
  /* 重写多少行以上才值得写进回执（少了不值当，多了才是「你的旧 ref 全失效了」） */
  var REF_REWRITE_NOTABLE = 20;

  var REF_RE = /\[ref=[A-Za-z0-9_-]+\]/g;
  var REF_ID_RE = /\[ref=([A-Za-z0-9_-]+)\]/;
  /* 只剥焦点标记。语义状态（[disabled]/[selected]/…）一律留着，见文件头说明 */
  var FOCUS_RE = /\[active\]/g;

  function utf8Len(s) {
    if (typeof Buffer !== 'undefined' && Buffer.byteLength) return Buffer.byteLength(String(s), 'utf8');
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(s)).length;
    return String(s).length;
  }

  /* 归一化：**行数不变**。返回数组，与原文下标一一对应 */
  function normalize(text) {
    return String(text == null ? '' : text).split('\n').map(function (l) {
      return l.replace(REF_RE, '[ref]').replace(FOCUS_RE, '').replace(/\s+/g, ' ').trim();
    });
  }

  /* 形状：剥掉**所有**方括号属性（含 ref 与状态标记）、挖空引号里的名字、挖空「: 尾巴」、压空白。
   * 于是「同一行的 1:1 改写」可被确认（改名前后形状不变），而不变的角色 token 是唯一的判据 ——
   * `button "发货"` 与 `link "下一页"` 形状不同，不会被配对。
   * 形状不同就老实记成 del + add（jwac 的 `- status` → `- status: 查询完成…` 走这条）。
   * 配对结果只用于**渲染** `旧 → 新`（原文逐字呈现，不隐藏任何差异），不承担身份语义。 */
  function shapeOf(line) {
    return String(line)
      .replace(/\[[^\]]*\]/g, '')
      .replace(/"[^"]*"/g, '""')
      .replace(/:\s.*$/, ':')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function nameOf(line) {
    var m = String(line).match(/"([^"]*)"/);
    return m ? m[1] : '';
  }

  function refOf(line) {
    var m = String(line).match(REF_ID_RE);
    return m ? m[1] : null;
  }

  /* 剪公共前后缀后对中段做 LCS 差分（DP 为 O(n·m)，受 DIFF_CELL_CAP 约束）。
   * 返回 { pairs: [[i,j]…同构对], changedInPrev, changedInCur }（下标均为原文 0-based） */
  function lcsDiff(a, b, lo) {
    var n = a.length, m = b.length, dp = [];
    for (var i = 0; i <= n; i++) dp.push(new Int32Array(m + 1));
    for (i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    var pairs = [], changedInPrev = [], changedInCur = [];
    i = 0; var j2 = 0;
    while (i < n && j2 < m) {
      if (a[i] === b[j2]) { pairs.push([lo + i, lo + j2]); i++; j2++; }
      else if (dp[i + 1][j2] >= dp[i][j2 + 1]) { changedInPrev.push(lo + i); i++; }
      else { changedInCur.push(lo + j2); j2++; }
    }
    while (i < n) { changedInPrev.push(lo + i); i++; }
    while (j2 < m) { changedInCur.push(lo + j2); j2++; }
    return { pairs: pairs, changedInPrev: changedInPrev, changedInCur: changedInCur };
  }

  /* 在「del 段紧跟 add 段」的片段里按下标 1:1 配对，只保留形状相等的一对 ——
   * 目的是把「同一行被改写」渲染成一行 `旧 → 新`，而不是「删 1 行 + 加 1 行」两行。
   * 它**不承担任何身份语义**（我们不说「这是同一个元素」）。 */
  function pairRenamed(A, B, changedInPrev, changedInCur) {
    var out = [];
    var setA = Object.create(null), setB = Object.create(null);
    changedInPrev.forEach(function (i) { setA[i] = 1; });
    changedInCur.forEach(function (i) { setB[i] = 1; });
    var usedB = Object.create(null);
    changedInPrev.forEach(function (ia) {
      var shaped = shapeOf(A[ia]);
      for (var k = 0; k < changedInCur.length; k++) {
        var ib = changedInCur[k];
        if (usedB[ib]) continue;
        if (shapeOf(B[ib]) !== shaped) continue;
        usedB[ib] = 1;
        out.push({
          a: ia, b: ib,
          nameChanged: nameOf(A[ia]) !== nameOf(B[ib]),
          valueChanged: A[ia].replace(/^.*?:\s*/, '') !== B[ib].replace(/^.*?:\s*/, ''),
          oldLine: A[ia], newLine: B[ib], newRef: refOf(B[ib]),
        });
        break;
      }
    });
    return out;
  }

  /* ref 的三件事必须分开，语义完全不同：
   *   refRewritten —— 归一化后**内容一字未改**，ref 编号却被换掉。这是「你手里的旧 ref
   *                    全部失效」，与页面内容无关（jwac 2→3：内容只改 1 行，却重排 440 个）。
   *   refMoved     —— 编号还在、落到了别的行（正常恒 0）。
   *   refDropped   —— prev 的 ref 在 cur 里彻底消失（元素或它所在子树被销毁）。
   * 只在**配对成功**的行上计 refRewritten，所以改名行不会混进来。 */
  function refStats(A, B, pairs) {
    var at = Object.create(null), inCur = Object.create(null);
    A.forEach(function (l) { var r = refOf(l); if (r && at[r] === undefined) at[r] = 0; });
    var prevLineOf = Object.create(null), curLineOf = Object.create(null);
    for (var i = 0; i < A.length; i++) { var ra = refOf(A[i]); if (ra && prevLineOf[ra] === undefined) prevLineOf[ra] = i; }
    for (var j = 0; j < B.length; j++) { var rb = refOf(B[j]); if (rb && curLineOf[rb] === undefined) curLineOf[rb] = j; }
    pairs.forEach(function (p) { at[A[p[0]]] = 1; });
    var rewritten = 0;
    pairs.forEach(function (p) {
      var ra = refOf(A[p[0]]), rb = refOf(B[p[1]]);
      if (ra && rb && ra !== rb) rewritten++;
    });
    var moved = 0, dropped = 0;
    Object.keys(prevLineOf).forEach(function (r) {
      if (!(r in curLineOf)) { dropped++; return; }
      if (prevLineOf[r] !== curLineOf[r]) moved++;
    });
    return { refRewritten: rewritten, refMoved: moved, refDropped: dropped };
  }

  /* 等距抽样比对的匹配率（0~1）。只做字符串比较，不做任何差分 ——
   * 用途只有一个：在花 DP 的钱之前，先判断这两张快照是不是「基本同一页」。 */
  function sampledMatchRatio(NA, NB) {
    var n = Math.min(NA.length, NB.length);
    if (!n) return 0;
    var points = Math.min(SAMPLE_POINTS, n);
    var hit = 0;
    for (var k = 0; k < points; k++) {
      var i = points === 1 ? 0 : Math.floor(k * (n - 1) / (points - 1));
      if (NA[i] === NB[i]) hit++;
    }
    return hit / points;
  }

  /* ctx = { prev, cur, goal, actedRef, reliable }
   *   prev ：上一步**看到**的快照（已裁）；cur：本步看到的快照（已裁）—— 两侧须同一裁剪空间 */
  function diff(ctx) {
    var o = ctx || {};
    var prevText = String(o.prev == null ? '' : o.prev);
    var curText = String(o.cur == null ? '' : o.cur);
    var base = {
      ok: true, reliable: o.reliable !== false, kind: 'unchanged',
      prevLines: 0, curLines: 0,
      changedInPrev: [], changedInCur: [], added: [], removed: [], renamed: [],
      refRewritten: 0, refMoved: 0, refDropped: 0,
      actedLine: null, chased: false, approxChanged: 0,
    };
    if (!prevText) { return Object.assign({}, base, { ok: false, kind: 'no-prev' }); }

    var A = prevText.split('\n'), B = curText.split('\n');
    var NA = normalize(prevText), NB = normalize(curText);
    base.prevLines = A.length;
    base.curLines = B.length;

    var actedLine = o.actedRef ? A.findIndex(function (l) { return l.indexOf('[ref=' + o.actedRef + ']') >= 0; }) : -1;
    base.actedLine = actedLine >= 0 ? actedLine : null;

    /* ① 归一化后整体相等 → unchanged（refRewritten 仍要算 —— 那是另一个信号）。
     * 全部行都是「配对成功」的行，所以把全部下标当 pairs 传进去：这样 refRewritten
     * 才能数出「内容一字未改、句柄却被换掉」的那些行（jwac 那 440 行的语义）。 */
    var equal = NA.length === NB.length && NA.every(function (x, i) { return x === NB[i]; });
    if (equal) {
      var allPairs = [];
      for (var q = 0; q < NA.length; q++) allPairs.push([q, q]);
      var st0 = refStats(A, B, allPairs);
      base.refRewritten = st0.refRewritten;
      base.refMoved = st0.refMoved;
      base.refDropped = st0.refDropped;
      return base;
    }

    /* ② 抽样判断「整页替换」；中段过大则只报统计 */
    var matchRatio = sampledMatchRatio(NA, NB);
    if (matchRatio < PAGE_REPLACE_ANCHOR) {
      return Object.assign({}, base, {
        kind: 'page-replaced',
        approxChanged: Math.max(NA.length, NB.length),
      });
    }
    var lo = 0, hi = NA.length, hb = NB.length;
    while (lo < hi && lo < hb && NA[lo] === NB[lo]) lo++;
    while (hi > lo && hb > lo && NA[hi - 1] === NB[hb - 1]) { hi--; hb--; }
    var midA = NA.slice(lo, hi), midB = NB.slice(lo, hb);
    if (midA.length + midB.length > MAX_DIFF_LINES
        || midA.length * midB.length > DIFF_CELL_CAP) {
      /* 不给行数：「零散小改」走到这里时中段几乎是整页，报出来的数会把
       * 「改了几处」夸大成「整页都变了」——宁可不给数，也不给个假数。 */
      return Object.assign({}, base, { kind: 'too-large' });
    }

    /* ③ 精确差分。**配对集合必须包含剪掉的公共前后缀** —— 那些行内容相同、
     * 但 ref 可能全被重写过（jwac 的 440 行正落在那里），只把小段的 pairs 交出去
     * 会让 refRewritten 恒为 0。改动行只可能在小段里，所以 changedIn* 仍取 d 的。 */
    var d = lcsDiff(midA, midB, lo);
    var pairs = [];
    for (var p0 = 0; p0 < lo; p0++) pairs.push([p0, p0]);
    pairs = pairs.concat(d.pairs);
    for (var p1 = 0; p1 < NA.length - hi; p1++) pairs.push([hi + p1, hb + p1]);

    var st = refStats(A, B, pairs);
    var renamed = pairRenamed(A, B, d.changedInPrev, d.changedInCur);
    var renamedA = Object.create(null), renamedB = Object.create(null);
    renamed.forEach(function (x) { renamedA[x.a] = 1; renamedB[x.b] = 1; });
    var added = d.changedInCur.filter(function (i) { return !renamedB[i]; });
    var removed = d.changedInPrev.filter(function (i) { return !renamedA[i]; });
    var result = Object.assign({}, base, {
      kind: 'local',
      changedInPrev: d.changedInPrev,
      changedInCur: d.changedInCur,
      added: added,
      removed: removed,
      renamed: renamed,
      refRewritten: st.refRewritten,
      refMoved: st.refMoved,
      refDropped: st.refDropped,
      chased: base.actedLine !== null && d.changedInPrev.indexOf(base.actedLine) >= 0,
    });
    result.hunks = buildHunks(result, A, B);
    result.digest = digestOf(result);
    return result;
  }

  /* 「几处变化」的唯一口径（回执与清单共用，避免两处各算一份而漂移）：
   * 取两侧改动行数的较大者 —— 纯删除时 changedInCur 是 0，只报它就会说成「0 处变化」。 */
  function changeCount(r) {
    return Math.max((r.changedInCur || []).length, (r.changedInPrev || []).length);
  }

  function buildHunks(r, A, B) {
    var out = [];
    r.renamed.forEach(function (x) {
      out.push({
        type: 'rewrite', a: x.a, b: x.b, line: x.a,
        text: renderLine(x.oldLine) + ' → ' + renderLine(x.newLine),
        hasRef: Boolean(x.newRef),
      });
    });
    r.added.forEach(function (i) {
      out.push({ type: 'add', a: null, b: i, line: i, text: renderLine(B[i]), hasRef: Boolean(refOf(B[i])) });
    });
    r.removed.forEach(function (i) {
      out.push({ type: 'del', a: i, b: null, line: i, text: renderLine(A[i]), hasRef: Boolean(refOf(A[i])) });
    });
    return out;
  }

  /* 打分：把「模型最需要知道的那一处」排到第一篇 —— 它是读第一行就行动的。
   * 行号升序兜底，保证同输入同输出。 */
  function scoreHunk(h, actedLine) {
    var s = 0;
    var at = h.a == null ? h.b : h.a;
    if (h.type === 'rewrite' && h.a === actedLine) s += 100;
    else if (actedLine !== null && at === actedLine) s += 80;
    if (h.type === 'rewrite') s += 40;
    if (actedLine !== null) {
      var dist = Math.abs(at - actedLine);
      if (dist <= 5) s += 20;
      else if (dist <= 30) s += 8;
    }
    if (h.hasRef) s += 12;
    return s;
  }

  function hunkLabel(h, actedLine) {
    if (h.type === 'rewrite') {
      return h.a === actedLine ? '上一步操作所在那一处被改写：' : '改写：';
    }
    return h.type === 'add' ? '新增：' : '移除：';
  }

  /* 「本步变化」：只在真有变化时产出（无变化返回 ''，字段就不会出现 —— 稀缺才有信号）。
   * 整页替换 / 过大只给一句结论，**绝不逐行列**（上千行的清单只会把 state 烧光）。 */
  function digestOf(r) {
    if (!r || !r.ok || !r.reliable) return '';
    if (r.kind === 'unchanged') return '';
    if (r.kind === 'page-replaced') {
      return '页面快照内容整体更换（约 ' + r.approxChanged + ' 行不同）';
    }
    if (r.kind === 'too-large') {
      return '页面快照变化过大（约 ' + r.approxChanged + ' 行不同），未逐行列';
    }
    var hs = r.hunks || [];
    if (!hs.length) return '';
    var head = '页面变化 ' + changeCount(r) + ' 处';
    var out = [head];
    var used = utf8Len(head) + 1;
    var ranked = hs.slice().sort(function (a, b) {
      return scoreHunk(b, r.actedLine) - scoreHunk(a, r.actedLine) || a.line - b.line;
    });
    var shown = 0;
    for (var i = 0; i < ranked.length; i++) {
      if (shown >= MAX_HUNKS_SHOWN) break;
      var line = '· ' + hunkLabel(ranked[i], r.actedLine) + ranked[i].text;
      var b = utf8Len(line) + 1;
      /* 先给末尾那行「另有 N 处未列出」留位，否则最后一处会被挤掉 */
      if (used + b > DIGEST_BUDGET_BYTES - TAIL_RESERVE_BYTES) break;
      out.push(line);
      used += b;
      shown++;
    }
    var hidden = ranked.length - shown;
    if (hidden > 0) out.push('（另有 ' + hidden + ' 处未列出）');
    var text = out.join('\n');
    /* 硬兜底：clipMiddle 是字符口径，这里是**字节**口径，最后再校一次 */
    while (utf8Len(text) > DIGEST_BUDGET_BYTES && out.length > 1) {
      out.splice(out.length - 2, 1);
      text = out.join('\n');
    }
    return utf8Len(text) > DIGEST_BUDGET_BYTES ? '' : text;
  }

  /* ref → 行号（**0-based 内部索引**，与 diff 的 actedLine / changedIn* 同一坐标系）。
   * 找不到返回 null，绝不猜 —— 猜错会让「追自己改过的元素」误报。 */
  function lineOfRef(text, ref) {
    if (!ref) return null;
    var A = String(text == null ? '' : text).split('\n');
    var needle = '[ref=' + String(ref) + ']';
    for (var i = 0; i < A.length; i++) {
      if (A[i].indexOf(needle) >= 0) return i;
    }
    return null;
  }

  /* 「这一行是不是上一步动作改动过的行」。接线侧用它判「本步在追自己改过的元素」。
   * 不可信 / 无上一步 / 整页替换 / 过大时一律 false —— 宁可漏报，不可误报。 */
  function isChanged(r, line) {
    if (!r || !r.ok || !r.reliable || r.kind !== 'local' || line == null) return false;
    return (r.changedInCur || []).indexOf(line) >= 0
      || (r.changedInPrev || []).indexOf(line) >= 0;
  }

  /* 回执里一行的可见形态：剥掉缩进再 clipMiddle 到 HUNK_LINE_CHARS。
   * 只做缩略、不做任何改写 —— 原文逐字，模型要能拿它和快照里的行对上。 */
  function renderLine(line) {
    return clipMiddle(String(line).replace(/^\s+/, ''), HUNK_LINE_CHARS);
  }

  /* 上一步操作所在那一处、且被配对成 1:1 改写的那一对。
   * 配不上（纯增/纯删）时返回 null —— 那时不编措辞，明细交给「本步变化」清单，
   * 回执只报总数。 */
  function actedPairOf(r) {
    if (!r || r.actedLine === null) return null;
    for (var i = 0; i < r.renamed.length; i++) {
      if (r.renamed[i].a === r.actedLine) return r.renamed[i];
    }
    return null;
  }

  /* 回执：升级「上一步结果」—— 模型唯一信任的那个字段。
   *
   * **只陈述观测**：不做身份断言（不写「是同一个元素」）、不做因果断言（不写「因为你点了」）、
   * 不放行号（内部 0-based 与人读 1-based 混用就是 off-by-one 事故源，模型也用不上）。
   * 解释权归模型：原文对里旧 ref 让它接回「已完成步骤」那一行，新 ref 是它下一步的句柄。
   *
   * opts = { base, diff }。base 由调用方给（'成功' / '成功（生成并填入：…）'）：
   *   · diff 缺失 / !ok / !reliable → 一字不改返回 base（宁可不说，也不能说假话）
   *   · 其余 → base + ' · ' + 观测 */
  function receipt(opts) {
    var o = opts || {};
    var baseStr = String(o.base == null ? '' : o.base);
    var r = o.diff;
    if (!r || !r.ok || !r.reliable) return baseStr;

    /* 「ref 编号被重写」是**可与任意分支叠加的子句**，不是某个分支的文案：
     * jwac 2→3 落在 local 分支（1 处内容改写 + 440 行重写），写成 unchanged 专属文案
     * 就会把 440 这个最关键的信号丢掉 —— 而那个会话正是这条信号存在的理由。 */
    var clause = r.refRewritten >= REF_REWRITE_NOTABLE
      ? '；另有 ' + r.refRewritten + ' 行的 ref 编号与上一步不同' : '';
    var head;
    var pair = null;
    if (r.kind === 'unchanged') {
      head = baseStr + ' · 页面快照内容无变化' + clause;
    } else if (r.kind === 'page-replaced') {
      head = baseStr + ' · 页面快照内容整体更换（约 ' + r.approxChanged + ' 行不同）' + clause;
    } else if (r.kind === 'too-large') {
      /* 「部分但巨大」不能说成「整体更换」——那是假话 */
      head = baseStr + ' · 页面快照变化过大（约 ' + r.approxChanged + ' 行不同），未逐行列' + clause;
    } else {
      head = baseStr + ' · 快照有 ' + changeCount(r) + ' 处变化' + clause;
      pair = actedPairOf(r);
    }

    var out = head;
    if (pair) {
      out = head + '\n上一步操作所在那一处被改写：'
        + renderLine(pair.oldLine) + ' → ' + renderLine(pair.newLine);
    }
    if (utf8Len(out) <= RECEIPT_MAX_BYTES) return out;
    /* 超预算：先丢掉那一对原文（最贵），还超就退回 base —— 不说胜过说半截 */
    if (utf8Len(head) <= RECEIPT_MAX_BYTES) return head;
    return baseStr;
  }

  var SnapshotDiff = {
    DIFF_CELL_CAP: DIFF_CELL_CAP,
    MAX_DIFF_LINES: MAX_DIFF_LINES,
    PAGE_REPLACE_ANCHOR: PAGE_REPLACE_ANCHOR,
    HUNK_LINE_CHARS: HUNK_LINE_CHARS,
    RECEIPT_MAX_BYTES: RECEIPT_MAX_BYTES,
    REF_REWRITE_NOTABLE: REF_REWRITE_NOTABLE,
    DIGEST_BUDGET_BYTES: DIGEST_BUDGET_BYTES,
    MAX_HUNKS_SHOWN: MAX_HUNKS_SHOWN,
    diff: diff,
    receipt: receipt,
    digestOf: digestOf,
    changeCount: changeCount,
    normalize: normalize,
    shapeOf: shapeOf,
    renderLine: renderLine,
    actedPairOf: actedPairOf,
    lineOfRef: lineOfRef,
    isChanged: isChanged,
    utf8Len: utf8Len,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SnapshotDiff;
  if (typeof window !== 'undefined') window.SnapshotDiff = SnapshotDiff;
})();
