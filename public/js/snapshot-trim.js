/* ===================== 快照裁剪（snapshot-trim） =====================
 * 背景：快照随 state 全量发给 Jev，超上游上下文窗口即整轮终止。
 * 实测（会话 r-0928-1625-cyom）：GitHub 仓库页快照 131KB / 1899 行 → 请求约 50,800
 * input tokens → {"detail":{"error_type":"max_tokens_exceeded"}}。重试用的是同一个
 * payload，尺寸分毫未变 → 确定性失败，白等 5.4 秒后整轮终止。
 * 实测边界（拿上游返回的真实 usage 校准，tokens/byte ≈ 0.338）：
 *   请求  83KB / 28,175 tokens → 成功
 *   请求  97KB / 32,698 tokens → 失败
 * 即上游窗口在 32K 附近；预算取 24,000 tokens 留足余量。
 *
 * 三刀，按「损耗从小到大」排，串成流水线，够用就停（meta.rungs 记下实际用了几刀）：
 *   ① url   —— /url 行只留「主机 + 末段路径」。链接文字与 ref 一个字不动。
 *   ② names —— 父节点引号里的名字**已经被子节点逐条复述**时，把名字裁短
 *              （不是删掉：名字同时是候选描述里的身份信息，删了模型认不出这行是哪条）。
 *   ③ rank  —— 预算驱动：按 ref-funnel 的反相关性排序保留前 N 个 ref，外加它们各自
 *              的**祖先链**（不留就成了一堆孤儿行，模型看不出层级）与全部 heading；
 *              被省略的块里再摘录最多 K 行「次优元素」（带 ref，能被点），其余压成一行标记。
 *
 * 铁律一：没超预算 → 原样返回**同一个字符串**（逐字节零回归，不是「内容相等」）。
 *         实测 130 个真实页面里 128 个走这条路。
 * 铁律二：只在超预算时动手。小页面本来就跑得好，不要去碰它。
 * 铁律三：带 [ref=] 的行是原子的 —— 要么整行留、要么整行丢，**永不改字**。
 *         playwright 在元素名含「冒号+空格」时会把整个标量用单引号包起来
 *         （实测 `- 'link "fix: harden ..." [ref=f2e657]'`），按「第一个冒号」切分会被打歪。
 *         所以缩略只对「无 ref 的确定叶子」和「引号内的名字」动手。
 *
 * 为什么在取快照那一刻裁、而不是在别处：state 与 questions 都从同一份快照派生。
 * 只裁一次，ref 编号 / 候选 / 树形 / 截图标注 / 落地记录天然一致；
 * 事后再裁就会出现「问题里的 ref 不在快照里」那类老 bug。
 *
 * 纯逻辑无 DOM：浏览器挂 window.SnapshotTrim，Node 走 module.exports（node:test 使用）。
 * ref 解析复用 util.js，打分复用 ref-funnel.rankRefs（**不另写一份打分器**），
 * 树形复用 ref-context.parseSnapshotTree。
 */
(function () {
  'use strict';

  var U = (typeof window !== 'undefined')
    ? { parseSnapshotRefs: window.parseSnapshotRefs, clipMiddle: window.clipMiddle }
    : require('./util.js');
  var clipMiddle = U.clipMiddle;
  var Funnel = (typeof window !== 'undefined') ? window.RefFunnel : require('./ref-funnel.js');
  var Ctx = (typeof window !== 'undefined') ? window.RefContext : require('./ref-context.js');

  /* 快照体积预算（UTF-8 字节）。初版推导（在英文页面上校准）：
   *   上游窗口 ~32K tokens；已知成功 83KB / 28,175 tokens，已知失败 97KB / 32,698 tokens。
   *   总请求预算取 76KB − questions 允许量 16KB → 快照留 60KB。
   * 这两个前提在中文 + 订单号密集的页面上同时失效（实测会话 r-0929-0847-jwac step2）：
   *   ① tokens/byte 不是 0.338 而是 **0.424**（CJK 与数字更吃 token）
   *   ② questions 不是 13~15KB 而是 **30KB** —— 并行召回的候选描述带元素名 + 祖先提示，
   *      表格区的单位成本是导航区的 1.6 倍，那个 16KB 是「相关性裁剪」路线的规模
   * 于是那一步：快照 47,015B 没超 60KB → 铁律一逐字节不裁 → 请求 79,446B ≈ 33.7K tokens
   * → {"detail":{"error_type":"max_tokens_exceeded"}}；而同一步的首轮 71,943B ≈ 30.5K tokens
   * 成功（实测 usage.input_tokens 30,683）。**「被裁过的页面能跑，没被裁的反而炸」**。
   *
   * 默认值取 45,000：它让这一类页面落进 names 刀（实测 step2 裁短 35 处名字：快照
   * 47,015→42,889B，questions 30,395→24,885B —— 候选描述与快照同源，裁快照顺带裁了题目），
   * 该步最大请求 79,446→70,585B ≈ 29.9K tokens，低于同页实测成功线（30,562~30,821）。
   * 全语料 20 次 max_tokens_exceeded 的记录重算后，最大请求都是 70,585B。
   *
   * 残留缺口（刻意记下，别再踩）：questions 仍然没有进入这个预算 —— 快照刚好卡在 45,000
   * 以下、而候选描述很重的页面仍可能越界（那要靠「切批按候选描述字节」来管，不是这个常量）。
   * 代价：45~60KB 之间的页面从此会被裁（rank 档可能丢元素），这是拿「少几个候选」换「不炸整轮」。 */
  var DEFAULT_BUDGET_BYTES = 45000;

  /* 第③刀的降档序列：每档重渲染一次（打分只做一次），进预算就停。
   * 首档给 400（而不是 250）：预算宽裕时能多留住可点的元素 —— 实测 GitHub 仓库页
   * N=250 时 48KB、N=400 时 58KB，都进预算，但后者多留住 150 个元素。
   * 这些元素虽不进候选名单（funnel 上限 250），但模型能在快照里看到、也能直接点名动作。 */
  var KEEP_STEPS = [400, 250, 150, 80, 40, 20, 8];
  /* 每个省略块摘录几行「次优元素」。行数太多会把预算吃回去（GitHub 那页 112 个块） */
  var SLIM_PER_BLOCK = 3;
  /* 摘录行的缩略长度 */
  var SLIM_CHARS = 60;
  /* 重复父名裁到多长。身份信息通常在名字开头（订单号），clipMiddle 两头都留 */
  var NAME_KEEP_CHARS = 48;
  /* 名字短于它就不值得判「重复」 */
  var MIN_NAME_LEN = 12;
  /* 子节点文字对父名的三字组覆盖率超过它才认定「父名是复述」 */
  var COVER_RATIO = 0.9;
  /* /url 末段最长留多少 */
  var URL_KEEP_CHARS = 60;
  /* 缩短不足这么多字符就不动它（免得把小 URL 改得更长） */
  var URL_MIN_SAVE = 12;
  /* 下拉框选项名单最多保留多少个；超了就一个都不留（**不许留一半**：
   * selectOptionNames 读到残缺名单会对着它报「没有这个选项」，比读不到更糟） */
  var OPTION_KEEP_CAP = 60;

  /* 严格形状：`- role "名字" [attrs]:`。
   * 名字里带冒号时 playwright 会用单引号包整段，那种形状**故意不匹配** —— 放过它，
   * 宁可少省一点也不要把行拆歪（见铁律三）。 */
  var STRICT_NAMED = /^(\s*-\s+)([a-z][a-z0-9]*)(\s+"[^"]*")((?:\s+\[[^\]]*\])*)(:\s*)?$/;
  var REF_RE = /\[ref=([A-Za-z0-9_-]+)\]/;
  var URL_LINE = /^(\s*-\s+\/url:\s*)(\S.*?)\s*$/;
  var TYPE_RE = /^\s*-\s+([^\s:\[]+)/;

  var utf8Len = (function () {
    if (typeof Buffer !== 'undefined' && Buffer.byteLength) {
      return function (s) { return Buffer.byteLength(String(s), 'utf8'); };
    }
    if (typeof TextEncoder !== 'undefined') {
      var enc = new TextEncoder();
      return function (s) { return enc.encode(String(s)).length; };
    }
    return function (s) { return String(s).length; };
  })();

  function indentOf(line) { return line.match(/^ */)[0].length; }
  function typeOf(line) { var m = TYPE_RE.exec(line); return m ? m[1] : null; }
  function norm(s) { return String(s).replace(/\s+/g, '').toLowerCase(); }

  /* 只缩略「引号内的名字」或「冒号后的值」，**绝不碰 [ref=]** —— ref 在行里是原子的。
   * 实测形状：`- link "docker-compose.build.yml, (File)" [ref=f2e638] [cursor=pointer]:` */
  function clipQuoted(line, max) {
    var s = String(line);
    var a = s.indexOf('"');
    var b = s.lastIndexOf('"');
    if (a !== -1 && b > a && b - a - 1 > max) {
      return s.slice(0, a + 1) + clipMiddle(s.slice(a + 1, b), max) + s.slice(b);
    }
    var i = s.indexOf(': ');
    if (i !== -1 && !REF_RE.test(s) && s.length - i - 2 > max) {
      return s.slice(0, i + 2) + clipMiddle(s.slice(i + 2), max);
    }
    return s;
  }

  /* 三字组覆盖率：父名有多少比例能在子节点文字里找到连续三字组 */
  function coverage(name, blob) {
    if (name.length < 3) return 0;
    var hit = 0;
    var total = 0;
    for (var i = 0; i + 3 <= name.length; i++) {
      total++;
      if (blob.indexOf(name.substr(i, 3)) !== -1) hit++;
    }
    return total ? hit / total : 0;
  }

  /* 子节点「说了什么」：带引号的名字，或「: 值」尾巴（表格单元格这类无引号名字的走后者）。
   * 两者只取其一 —— 严格形状的行里，`:\s+` 会命中名字内部的冒号，混进去会把覆盖率抬高。 */
  function childTextOf(line) {
    var m = STRICT_NAMED.exec(line);
    if (m) return m[3];
    var v = line.match(/:\s+(.+)$/);
    return v ? v[1] : '';
  }

  /* ---------------- 第①刀：/url 行只留主机 + 末段路径 ----------------
   * 整行删掉会丢掉「这个链接指向哪」——实测 `- link "Sign in"` 的 /url 才说明它登录后
   * 去机票页，`- link "v4.0.3"` 的 /url 才说明那是 commit 页不是 release 页。
   * 保留主机 + 末段既留住「这是什么页」，又省掉长路径与追踪参数（实测省 29.8%）。 */
  function shortUrl(value) {
    var v = String(value);
    var pathPart = v.split(/[?#]/)[0];
    var segs = pathPart.split('/').filter(Boolean);
    var tail = segs.length ? clipMiddle(segs[segs.length - 1], URL_KEEP_CHARS) : '';
    var hm = pathPart.match(/^[a-z][a-z0-9+.-]*:\/\/([^/]+)/i);
    if (hm) return hm[1] + '/…' + (tail ? '/' + tail : '');
    if (tail) return '…/' + tail;
    return v;
  }

  function slimUrls(text) {
    var lines = String(text).split('\n');
    var hits = 0;
    for (var i = 0; i < lines.length; i++) {
      var m = URL_LINE.exec(lines[i]);
      if (!m) continue;
      var short = shortUrl(m[2]);
      if (short.length + URL_MIN_SAVE > m[2].length) continue;
      lines[i] = m[1] + short;
      hits++;
    }
    return { text: lines.join('\n'), hits: hits };
  }

  /* ---------------- 第②刀：裁短「被子节点复述」的父名 ----------------
   * 快照里一个很蠢的现象：表格单元格把自己下面的文字拼成一句话写进引号名字里，
   * 然后子节点又逐条再说一遍（orders-complex 实测 106 处，占该页 22% 字节）。
   * 裁短而不是删除：名字同时是候选描述里的身份信息（criterionText 用它区分同名元素），
   * 删了模型就认不出这行是哪一条。裁到 48 字符后订单号 / 状态这些身份信息都还在。 */
  function clipDupNames(text) {
    var lines = String(text).split('\n');
    var tree = Ctx.parseSnapshotTree(text);
    var hits = 0;
    for (var i = 0; i < lines.length; i++) {
      var m = STRICT_NAMED.exec(lines[i]);
      if (!m) continue;
      var name = m[3].slice(1, -1);
      if (name.length < MIN_NAME_LEN) continue;
      var end = tree.endOf[i];
      if (end <= i + 1) continue;                       /* 叶子：名字就是内容，不能动 */
      var blob = '';
      for (var j = i + 1; j < end; j++) {
        if (tree.depthOf[j] === tree.depthOf[i] + 1) blob += childTextOf(lines[j]);
      }
      blob = norm(blob);
      if (!blob) continue;
      if (coverage(norm(name), blob) <= COVER_RATIO) continue;
      var clipped = clipMiddle(name, NAME_KEEP_CHARS);
      if (clipped === name) continue;
      lines[i] = m[1] + m[2] + ' "' + clipped + '"' + m[4] + (m[5] === undefined ? '' : m[5]);
      hits++;
    }
    return { text: lines.join('\n'), hits: hits };
  }

  /* ---------------- 第③刀：预算驱动 + 相关性排序 ---------------- */

  /* 打分准备：与「保多少」无关的重活只算一次，结果交给 renderPlan 逐档渲染。
   * 一次截断要在 KEEP_STEPS 上逐档试，而每档用的树、排名、ref→行号、父链、标题标记
   * 全都与 keepN 无关 —— 实测 614 个 ref 的页面单次 rankRefs 就要 12ms，逐档重算会把
   * 一次截断从个位数毫秒推到上百毫秒。打分失败返回 null（调用方退回上一刀的结果）。 */
  function rankPlan(text, goal) {
    var lines = String(text).split('\n');
    var tailNl = /\n$/.test(text);
    if (tailNl) lines = text.replace(/\n$/, '').split('\n');
    var n = lines.length;
    var tree = Ctx.parseSnapshotTree(text);

    var ranked;
    try {
      ranked = Funnel.rankRefs(text, { goal: goal }).ranked;
    } catch (e) {
      return null;
    }

    /* ref → 行号；同一遍正则顺手留下「每行的 ref」，省略块挑摘录候选时不必再扫一遍 */
    var lineOfRef = Object.create(null);
    var refOf = new Array(n);
    for (var i = 0; i < n; i++) {
      var rm = REF_RE.exec(lines[i]);
      refOf[i] = rm ? rm[1] : null;
      if (rm && lineOfRef[rm[1]] === undefined) lineOfRef[rm[1]] = i;
    }

    /* 父链：快照是缩进树，只留叶子会变成一堆孤儿行，模型看不出层级 */
    var parentOf = new Array(n);
    var stack = [];
    for (var k = 0; k < n; k++) {
      while (stack.length && tree.depthOf[k] <= tree.depthOf[stack[stack.length - 1]]) stack.pop();
      parentOf[k] = stack.length ? stack[stack.length - 1] : -1;
      stack.push(k);
    }

    /* 行类型与 ref 分数同样与 keepN 无关，先算好 */
    var isHeading = new Array(n);
    var isOption = new Array(n);
    for (var h = 0; h < n; h++) {
      var tp = typeOf(lines[h]);
      isHeading[h] = tp === 'heading';
      isOption[h] = tp === 'option';
    }
    var scoreOf = Object.create(null);
    ranked.forEach(function (x) { scoreOf[x.ref] = x.score; });

    return {
      lines: lines, n: n, tailNl: tailNl, endOf: tree.endOf,
      ranked: ranked, lineOfRef: lineOfRef, refOf: refOf, parentOf: parentOf,
      isHeading: isHeading, isOption: isOption, scoreOf: scoreOf,
    };
  }

  /* 按 keepN 渲染一次，返回渲染结果与统计。keep 每档新建：上一档的标记绝不能漏进下一档。 */
  function renderPlan(p, keepN, allowSlim) {
    var lines = p.lines;
    var n = p.n;
    var parentOf = p.parentOf;
    var endOf = p.endOf;
    var ranked = p.ranked;
    var lineOfRef = p.lineOfRef;
    var refOf = p.refOf;
    var scoreOf = p.scoreOf;

    var keep = new Array(n);
    var markUp = function (idx) {
      var x = idx;
      while (x >= 0 && !keep[x]) { keep[x] = true; x = parentOf[x]; }
    };

    var keptRefs = 0;
    for (var r = 0; r < ranked.length && keptRefs < keepN; r++) {
      var idx = lineOfRef[ranked[r].ref];
      if (idx === undefined) continue;
      keptRefs++;
      markUp(idx);
    }

    /* 标题无条件保留：模型靠它知道页面有哪几块 */
    for (var h = 0; h < n; h++) {
      if (p.isHeading[h]) markUp(h);
    }

    /* 下拉框的 option 名单是钉子：ref 被保留时名单必须**完整**一起保留。
     * 名单太长（> OPTION_KEEP_CAP）就一个都不留 —— 留一半比不留更糟，
     * selectOptionNames 会拿着残缺名单报「没有这个选项」。
     *
     * 必须 markUp 而不是只置自己：option 行被保留、它的祖先（combobox / 容器行）却被省略时，
     * 这行就成了**悬空行** —— 缩进还在，但界碑没了。selectOptionNames 是按「缩进 > ref 行」
     * 往后扫的，悬空的 option 会被上一棵子树认领（实测 e15 的名单从 6 个变成 12 个，
     * 掺进了别的下拉框的选项）。markUp 把祖先链一路补上，界碑就回来了。
     * 补链可能保下更靠前的 combobox，它的选项也得跟着钉 —— 所以循环到稳定。 */
    var nailPass = function () {
      var changed = false;
      for (var s2 = 0; s2 < n; s2++) {
        if (!keep[s2]) continue;
        var opts = [];
        for (var t = s2 + 1; t < endOf[s2]; t++) {
          if (p.isOption[t]) opts.push(t);
        }
        if (!opts.length || opts.length > OPTION_KEEP_CAP) continue;
        for (var q = 0; q < opts.length; q++) {
          if (!keep[opts[q]]) { markUp(opts[q]); changed = true; }
        }
      }
      return changed;
    };
    for (var pass = 0; pass < 4 && nailPass(); pass++) { /* 补链会引入新的 combobox，钉到稳定 */ }

    var out = [];
    var elidedLines = 0;
    var slimLines = 0;
    var i2 = 0;
    while (i2 < n) {
      if (keep[i2]) { out.push(lines[i2]); i2++; continue; }
      var j2 = i2;
      while (j2 < n && !keep[j2]) j2++;

      /* 省略块里摘录「次优元素」：已经没进前 N 名、但仍在打分表里的那些。
       * 摘录行必须带 ref —— 不带 ref 的摘录是纯装饰，模型点不了。 */
      var cands = [];
      if (allowSlim) {
        for (var c = i2; c < j2; c++) {
          var cref = refOf[c];
          if (cref && scoreOf[cref] !== undefined) cands.push({ i: c, s: scoreOf[cref] });
        }
        cands.sort(function (a, b) { return b.s - a.s || a.i - b.i; });
        cands = cands.slice(0, SLIM_PER_BLOCK);
      }
      var chosen = Object.create(null);
      cands.forEach(function (x) { chosen[x.i] = 1; });
      var hidden = (j2 - i2) - cands.length;
      var ind = indentOf(lines[i2]);
      var pad = new Array(ind + 1).join(' ');
      if (hidden > 0) {
        out.push(pad + '- text: （此处省略 ' + hidden + ' 行'
          + (cands.length ? '，摘录其中 ' + cands.length + ' 项' : '') + '）');
      }
      cands.sort(function (a, b) { return a.i - b.i; });
      cands.forEach(function (x) {
        out.push(pad + clipQuoted(lines[x.i], SLIM_CHARS).trim());
        slimLines++;
      });
      elidedLines += hidden;
      i2 = j2;
    }

    return {
      text: out.join('\n') + (p.tailNl ? '\n' : ''),
      keptRefs: keptRefs,
      elidedLines: elidedLines,
      slimLines: slimLines,
    };
  }

  /* 硬上限兜底：上面的档位都走完还超预算时，按行截到预算内。
   * 会破坏树形，但「发一个必然被上游拒绝的请求」是更差的结果 —— 那等于整轮终止。
   * 走到这里意味着页面几乎没有 ref（纯正文页），rungs 里有 'cap' 可查。 */
  function hardCap(text, budget) {
    var lines = String(text).split('\n');
    var out = [];
    var used = 0;
    for (var i = 0; i < lines.length; i++) {
      var b = utf8Len(lines[i]) + 1;
      if (used + b > budget - 80) {
        out.push('- text: （此处省略 ' + (lines.length - i) + ' 行：已达体积上限）');
        return { text: out.join('\n') + '\n', elidedLines: lines.length - i };
      }
      out.push(lines[i]);
      used += b;
    }
    return { text: out.join('\n') + '\n', elidedLines: 0 };
  }

  /* ---------------- 对外 ---------------- */

  function truncate(ctx) {
    var o = ctx || {};
    var snapshot = String(o.snapshot == null ? '' : o.snapshot);
    var goal = String(o.goal == null ? '' : o.goal);
    var budget = parseInt(o.budgetBytes, 10);
    if (!(budget > 0)) budget = DEFAULT_BUDGET_BYTES;

    var meta = {
      trimmed: false, before: utf8Len(snapshot), after: utf8Len(snapshot),
      rungs: [], totalRefs: 0, keptRefs: 0, elidedLines: 0, slimLines: 0,
      urlSlimmed: 0, namesClipped: 0, budgetBytes: budget, keepN: null
    };

    if (!snapshot) return { text: snapshot, meta: meta };
    meta.totalRefs = U.parseSnapshotRefs(snapshot).length;

    /* 铁律一：没超预算，逐字节原样返回 */
    if (meta.before <= budget) return { text: snapshot, meta: meta };

    var finish = function (text, extra) {
      if (extra) { for (var k in extra) if (extra[k] != null) meta[k] = extra[k]; }
      meta.trimmed = true;
      meta.after = utf8Len(text);
      return { text: text, meta: meta };
    };

    var text = snapshot;

    var r1 = slimUrls(text);
    if (r1.hits) { text = r1.text; meta.rungs.push('url'); meta.urlSlimmed = r1.hits; }
    if (utf8Len(text) <= budget) return finish(text);

    var r2 = clipDupNames(text);
    if (r2.hits) { text = r2.text; meta.rungs.push('names'); meta.namesClipped = r2.hits; }
    if (utf8Len(text) <= budget) return finish(text);

    meta.rungs.push('rank');
    var plan = rankPlan(text, goal);
    if (plan) {
      for (var s = 0; s < KEEP_STEPS.length; s++) {
        var allowSlim = s < KEEP_STEPS.length - 1;   /* 最后一档不再摘录，只留骨架 */
        var r = renderPlan(plan, KEEP_STEPS[s], allowSlim);
        if (utf8Len(r.text) <= budget) {
          return finish(r.text, {
            keepN: KEEP_STEPS[s], keptRefs: r.keptRefs,
            elidedLines: r.elidedLines, slimLines: r.slimLines,
          });
        }
      }
    }

    /* 档位都走完还超：硬上限兜底（纯正文页会走到这里） */
    meta.rungs.push('cap');
    var capped = hardCap(text, budget);
    return finish(capped.text, { elidedLines: capped.elidedLines, keptRefs: 0 });
  }

  var SnapshotTrim = {
    DEFAULT_BUDGET_BYTES: DEFAULT_BUDGET_BYTES,
    KEEP_STEPS: KEEP_STEPS,
    truncate: truncate,
    _test: {
      slimUrls: slimUrls,
      clipDupNames: clipDupNames,
      clipQuoted: clipQuoted,
      shortUrl: shortUrl,
      keepByRank: function (text, goal, keepN, allowSlim) {
        var p = rankPlan(text, goal);
        return p ? renderPlan(p, keepN, allowSlim) : null;
      },
      rankPlan: rankPlan,
      renderPlan: renderPlan,
      hardCap: hardCap,
      utf8Len: utf8Len,
      coverage: coverage,
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SnapshotTrim;
  if (typeof window !== 'undefined') window.SnapshotTrim = SnapshotTrim;
})();
