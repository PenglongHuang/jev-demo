/* ===================== playwright-jev-agent · 纯逻辑核心（无 DOM） =====================
 * 设计文档 §6/§7/§8/§11：state 组装、3 道固定问题组装与按需补问（参数批次 / 动作 / 文本）、
 * 决策解析、执行规划、终止判断、历史压缩、LLM prompt 组装与文本清洗。
 * 浏览器：以全局 AutoCore 暴露（auto.js 使用）；Node：module.exports（node:test 使用）。
 * ref 解析复用 util.js（同一实现保证浏览器/测试行为一致）。
 */
(function () {
  'use strict';

  var U = (typeof window !== 'undefined')
    ? { parseSnapshotRefs: window.parseSnapshotRefs, buildRefCriteria: window.buildRefCriteria, clipMiddle: window.clipMiddle }
    : require('./util.js');
  var clipMiddle = U.clipMiddle;
  var Funnel = (typeof window !== 'undefined')
    ? window.RefFunnel
    : require('./ref-funnel.js');
  /* 并行召回（另一条「参数」题候选路线，见 ref-recall.js）：本文件只做接线，
   * 切批与合并的确定性逻辑全部在那边，可被 node:test 直接锁住 */
  var Recall = (typeof window !== 'undefined')
    ? window.RefRecall
    : require('./ref-recall.js');

  /* ---------------- 动作集（设计 §7：19 个浏览器操作 + 1 个工程动作） ----------------
   * 描述带分组前缀，帮助 Jev 在 21 个候选里区分用途。
   * 裁掉的 8 个（dblclick/drop/keydown/keyup/mousemove/mousedown/mouseup/mousewheel）：
   * a11y 快照驱动下坐标鼠标类不可达（没有 x,y 概念），修饰键与拖拽在本项目场景里无入口，
   * 纯属干扰项（实测事故里模型在 31 候选里摇摆）。
   * 下线的「无操作」：它是「等待页面自身变化」的合法空转出口，而页面不会自己变化 ——
   * 实测会话 r-0928-1530-r1uy 里模型对聊天框 fill 完连选 3 步「无操作」等回复，
   * 一直等到步数上限。去掉后每一步都必须推进任务；真需要等（异步加载）由下一个
   * 真实动作或 press/reload 承担。 */
  var AUTO_TOOLS = {
    /* 交互（9） */
    /* click 的描述里必须写明「选中 / 点开」也归它 —— 中文语境下「选中这一行 / 选中这一笔」
     * 是最高频的说法，而动作表里恰好有个叫 select 的选项，不划清归属它就会被抢走。 */
    'click': '【交互】点击按钮 / 链接 / 表格行 / 任意元素（要「选中」「点开」某个元素都用它；需配合「参数」选定 ref）',
    /* fill 的两条硬事实必须写进描述，缺一条就会出事故（实测 r-0928-1530-r1uy）：
     *   ①清空 —— 是整体替换，不是追加（要追加用 type）；
     *   ②不提交 —— 只写值，页面不会有任何变化。模型正是把 fill 当成了「发送消息」，
     *     填完就停下等回复。所以描述里要直接把后续动作指出来。 */
    'fill': '【交互】先清空输入框 / 文本域里的原有内容，再一次性写入新文本（整体替换，不是追加；文本经动作确定后的「文本」补问选定）。它只负责写入：填完后页面不会有任何变化，搜索框 / 聊天框 / 表单填完通常还要再 click 提交按钮或 press 回车',
    'type': '【交互】在元素上逐字输入文本（文本经动作确定后的「文本」补问选定）',
    /* select 只能作用于原生 <select>：快照里它是 combobox，它下面的 option 没有 ref，
     * 而 driver 打到 playwright 上时非 <select> 会硬抛 "Element is not a <select> element"。
     * 实测事故：模型对 button "发货" 选了 select，白烧一步才自纠 —— 所以描述写成排他式。 */
    'select': '【交互】仅用于原生下拉框（快照里是 combobox "<名字>"，它下面的 option 没有 ref）：在其中选定某个选项（选项名在「文本」补问的候选里，来自该下拉框的真实选项）。按钮 / 链接 / 表格行一律用 click，不要用 select',
    'check': '【交互】勾选复选框 / 单选框',
    'uncheck': '【交互】取消勾选',
    'hover': '【交互】鼠标悬停（展开菜单 / 触发浮层）',
    'upload': '【交互】上传本地文件（文本 = 文件路径）',
    'press': '【交互】按下按键（键名在动作确定后的「文本」补问里选，常用 PageDown / PageUp / Enter）',
    /* 导航（4） */
    'goto': '【导航】打开网址（文本 = http/https URL，取自变量）',
    'go-back': '【导航】后退到上一页',
    'go-forward': '【导航】前进到下一页',
    'reload': '【导航】重新加载当前页',
    /* 标签页（4） */
    'tab-new': '【标签页】新开一个标签页（文本 = 可选 URL）',
    'tab-select': '【标签页】切换到指定标签页（文本 = 序号，从 0 开始）',
    'tab-close': '【标签页】关闭指定标签页（文本 = 序号；缺省关闭当前页）',
    'tab-list': '【标签页】列出全部标签页（结果会并入下一步骤的上下文）',
    /* 弹窗（2） */
    'dialog-accept': '【弹窗】接受 alert / confirm 弹窗（文本 = 可选 prompt 输入）',
    'dialog-dismiss': '【弹窗】取消 / 关闭弹窗',
    /* 工程（1） */
    '生成输入': '【工程】调用生成模型（LLM）为「参数」指定的输入框生成合适文本并填入（搜索词、邮件主题、正文等）'
  };

  /* 终止态（与动作同题呈现，命中即结束循环）。
   * 「放弃」已下线：它给模型一张随时可用的免死金牌，而「当前页面做不到」多半只是
   * 「这一步还没选对」—— mock 侧就撞过同一件事（对快照未就绪回「放弃」，一次可自愈的
   * 等待直接变成整轮 giveup，见 tests/e2e/mock-server.js 的 RE_OBSERVE）。
   * 现在模型只有「任务已完成」一个出口；真做不完交给工程守卫收尾（步数上限 / 连续失败），
   * 结论的归因反而更诚实。 */
  var TERMINAL_TOOLS = {
    '任务已完成': '目标已达成，停止循环'
  };

  /* 「无需元素」兜底项已下线：它与「不作用于元素的动作」语义打架，密集页分批候选里
   * 被模型误读成「本批没有目标元素」（实测百度结果页连续 3 步选它 → 校验失败终止）。
   * 现在参数题只放真实 ref；不作用于元素的动作选了参数也不消费（normalizeParam 剥掉）。 */
  var TEXT_NONE = '无';
  /* 「未完成」量表级数 —— 必须与 buildQuestions 里「未完成」criteria 的行数一致：
   * API 的 score = 等级下标加权均值，范围 0 ~ 级数-1；归一化除以 (级数-1)。
   * 图例缩到 2 级（0 已完成 / 1 进行中）后这里若还是 5，score 0.97 会被压成
   * 未完成 24%（实测事故：模型明明判 97% 未完成，展示却贴近 20% 的完成线）。 */
  var SCORE_LEVELS = 2;

  var TEXT_ACTIONS = { fill: 1, type: 1, select: 1, press: 1, goto: 1, upload: 1, 'tab-select': 1, 'tab-close': 1, 'dialog-accept': 1, 'tab-new': 1 };
  /* 文本可省的动作（与 browser-driver 白名单的 optional 语义一致）：
   * tab-close 缺省关当前页 / tab-new 可不开 URL / dialog-accept 可不带 prompt 输入 */
  var TEXT_OPTIONAL_ACTIONS = { 'tab-close': 1, 'tab-new': 1, 'dialog-accept': 1 };
  var REF_ACTIONS = { click: 1, fill: 1, type: 1, select: 1, check: 1, uncheck: 1, hover: 1, '生成输入': 1 };

  function needText(action) { return Boolean(TEXT_ACTIONS[action]); }
  function needRef(action) { return Boolean(REF_ACTIONS[action]); }

  /* ---------------- state 组装（设计 §6：确定性模板，快照全量透传） ---------------- */
  function compressHistory(entries, keep) {
    var k = keep || 8;
    var list = (entries || []).slice();
    if (list.length <= k) return list;
    return ['（更早的 ' + (list.length - k) + ' 步已省略）'].concat(list.slice(-k));
  }

  /* 「标签页」字段：逐行列出每个 Tab（当前 Tab 带【当前】标记），多个 Tab 时
   * 追加切换动词提示。快照/截图只覆盖当前 Tab —— 不写明这一点，模型看到
   * 「点击成功但页面没变」只会反复重试（实测百度 target=_blank 事故） */
  function formatTabs(tabs) {
    var list = (tabs || []).map(function (t) {
      return (t.current ? '【当前】' : '') + 'Tab ' + t.index + '：' + (t.title || '（无标题）') + ' — ' + (t.url || '');
    });
    if ((tabs || []).length > 1) {
      list.push('注意：页面快照与截图只覆盖【当前】Tab。点击链接常会开新 Tab（页面看起来没变）——'
        + '若目标内容在别的 Tab，用 tab-select 切换（序号见上），tab-close 可关闭多余 Tab。');
    }
    return list;
  }

  function buildState(ctx) {
    var tabs = Array.isArray(ctx.tabs) && ctx.tabs.length ? ctx.tabs
      : [{ index: 0, current: true, title: String(ctx.title || ''), url: String(ctx.url || '') }];
    var out = {
      '任务目标': String(ctx.goal || ''),
      '当前页面': { 'url': String(ctx.url || ''), '标题': String(ctx.title || '') },
      '标签页': formatTabs(tabs),
      '已完成步骤': compressHistory(ctx.history || []),
      '上一步结果': ctx.lastResult || '（这是第一步，之前尚无任何操作）',
    };
    out['页面快照'] = String(ctx.snapshot || '');
    /* 「本步变化」= 本步与上一步看到的快照之间的行级差异，与「上一步结果」同源（同一份
     * snapshot-diff 结果）但分工不同：回执只说**与上一步操作那一处**有关的一句观测，
     * 这里只列**改了什么行**。二者刻意允许重复 —— 回执在模型唯一信任的字段里且位置靠前，
     * 清单给人看更完整；合计仍在字节预算内（见 snapshot-diff 的常量）。
     * 只在真有变化时出现：与「停滞提示」同一条原则 —— 稀缺才有信号。
     * 位置紧贴快照之后（与「停滞提示」同一条理由：那是模型的最近注意力位）。 */
    if (ctx.lastChange) out['本步变化'] = String(ctx.lastChange);
    /* 「停滞提示」只在检出重复 / 停滞时出现。常驻字段不行：页面正常时不带信息量，
     * 每轮白烧 token，而且常驻的警告会被模型当背景噪音自动忽略 —— 稀缺才有信号。
     * 排在末尾是刻意的：紧跟在几千 token 的快照之后，是模型的最近注意力位置。 */
    if (ctx.stallNotice) out['停滞提示'] = String(ctx.stallNotice);
    return out;
  }

  /* ---------------- 停滞检测（重复同一动作 / 页面快照连续未变） ----------------
   * 触发场景（实测会话 r-0928-1530-r1uy）：对聊天框 fill「jev 是什么」之后，模型连选
   * 3 步空转等页面变化 —— fill 不提交，页面永远不会变，而「上一步结果」始终是「成功」，
   * 没有任何信号告诉它「你这两步等于没动」。
   * 这里只产出**反馈**（写进 state 的「停滞提示」），不参与终止判定：同一动作连做 N 次
   * 本身可能完全合理（连续翻页、连点同一「下一页」），据此终止会误杀正常任务。
   * 硬闸门仍是 shouldTerminate 的 maxSteps 与 consecutiveFails。 */
  var STALL_MIN = 2;   /* 连续 2 步同动作 / 未变化即开始提示，此时模型正要迈出第 3 步 */

  /* 决策指纹：动作 + 参数 + 最终文本。文本走 resolveText（变量名 → 真实值），
   * 否则「关键词」「招商银行」两个名字会被当成两次不同的操作。
   *
   * opts.selfChanged：这一步操作的那一行，正是上一步动作改动过的行。此时把 param 归约成
   * 哨兵 —— 元素自己改了名字（点赞 → 已赞）playwright 就重发 ref，六次点同一个按钮会被
   * 记成六个不同的动作，重复检测永远不触发（实测会话 r-0929-1918-7yw4 第 5~10 步）。
   * 归约之后那六步得到同一个指纹。
   *
   * 第三参缺省时**逐字节等价**于旧行为（既有调用方与断言不受影响）。
   * 已知的误报形状：若上一步改了 5 行、模型这 5 步各点其中不同的一行，也会被归成一个
   * 签名。语义上仍属「在操作自己的改动」，可接受，但别把它当成新 bug。 */
  var SELF_CHANGED = '<自己改过的那个元素>';

  function decisionSig(decision, variables, opts) {
    var d = decision || {};
    var text = resolveText(d.text, variables);
    var param = (opts && opts.selfChanged) ? SELF_CHANGED
      : (d.param == null ? '' : String(d.param));
    return [d.action, param, text == null ? '' : String(text)].join('\u0001');
  }

  /* prevSteps：已跑完的步骤（每项带 decision / snapshot / chasedOwnChange）；snapshot：本轮快照。
   * 返回 { repeatCount, noChangeStreak, selfChurnStreak, notice }，notice 为 null 表示不注入。 */
  function detectStall(prevSteps, snapshot, variables) {
    var prev = (prevSteps || []).filter(function (s) { return s && s.decision; });
    if (!prev.length) return { repeatCount: 0, noChangeStreak: 0, selfChurnStreak: 0, notice: null };

    var last = prev[prev.length - 1];
    var sigOpts = function (s) { return { selfChanged: Boolean(s && s.chasedOwnChange) }; };
    var sig = decisionSig(last.decision, variables, sigOpts(last));
    var repeatCount = 1;
    for (var i = prev.length - 2; i >= 0; i--) {
      if (decisionSig(prev[i].decision, variables, sigOpts(prev[i])) !== sig) break;
      repeatCount++;
    }
    /* 快照与「本轮」比：相等说明上一步跑完页面没变，连续相等就是连续空转。
     * 跳转 / ref 重排 / 内容渲染都会让快照不等，天然打断连续计数。 */
    var cur = String(snapshot == null ? '' : snapshot);
    var noChangeStreak = 0;
    for (var j = prev.length - 1; j >= 0; j--) {
      var s = prev[j].snapshot;
      if (s == null || String(s) !== cur) break;
      noChangeStreak++;
    }
    /* 第三类空转，与前两个计数**正交**：连续在「自己上一步改过的那一行」上做动作。
     * 逐字节比较抓不到它（快照确实每次都变了 —— 只是变的是那一行自己），
     * 未归约的指纹也抓不到（ref 每步都是新的）。 */
    var selfChurnStreak = 0;
    for (var k = prev.length - 1; k >= 0; k--) {
      if (!prev[k].chasedOwnChange) break;
      selfChurnStreak++;
    }

    var parts = [];
    if (repeatCount >= STALL_MIN) {
      parts.push('动作「' + last.decision.action + '」（参数与文本完全相同）已连续执行 ' + repeatCount + ' 步');
    }
    if (noChangeStreak >= STALL_MIN) {
      parts.push('页面快照已连续 ' + noChangeStreak + ' 步没有变化');
    }
    if (selfChurnStreak >= STALL_MIN) {
      /* 只陈述观测到的两个事实，不解释、不归因 —— 解释权归模型 */
      parts.push('已连续 ' + selfChurnStreak + ' 步：本步要操作的那一行，正是上一步动作刚改动过的行');
    }
    if (!parts.length) return { repeatCount: repeatCount, noChangeStreak: noChangeStreak, selfChurnStreak: selfChurnStreak, notice: null };

    var hard = repeatCount > STALL_MIN || noChangeStreak > STALL_MIN || selfChurnStreak > STALL_MIN;
    var notice = parts.join('；') + '。' + (hard
      ? '重复同一动作不会有任何进展，必须换一个：换动作（例如输入框只写入、不会自己提交，那就改用 click 点「搜索 / 发送」按钮或 press 回车）、'
        + '换「参数」里的元素、换文本取值；还不行就换入口 —— 用页面上的搜索框 / 菜单 / 分页绕到目标那儿，别停在原地。'
      : '先判断上一步是否真的生效（输入框 fill 只写入、不会自己提交是常见原因）：'
        + '若无进展，请更换动作或更换「参数」里的元素，不要继续重复同一步。');
    return { repeatCount: repeatCount, noChangeStreak: noChangeStreak, selfChurnStreak: selfChurnStreak, notice: notice };
  }

  /* ---------------- 问题组装（固定 3 道，动态值全部工程注入） ---------------- */
  function refCriteria(snapshot) {
    return U.buildRefCriteria(snapshot);
  }

  var REF_MORE = Funnel.REF_MORE;

  /* ---------------- 「参数」题候选算法（高级参数可选，两条路线并存） ----------------
   *   parallel —— 并行召回（**默认**）：快照按 size 切 K 批并行问 Jev，各批取概率前 topN，
   *               合并成一个候选集，再请 Jev 做一次最终决策。工程侧不排序、不丢元素。
   *   ranked   —— 相关性裁剪：确定性加权排序取前 limit，附「其他」兜底项补问下一批。
   * 两者只在「候选怎么来」上不同；落定之后的执行、校验、展示完全共用。 */
  var ALGORITHMS = ['parallel', 'ranked'];

  /* 配置缺省 = 默认开着 + 默认并行召回（与界面默认一致；关掉必须显式传 on:false） */
  function normalizeTrim(paramTrim) {
    var t = paramTrim || {};
    var size = Math.min(250, Math.max(10, parseInt(t.size, 10) || Recall.DEFAULT_SIZE));
    return {
      on: t.on !== false,
      algorithm: ALGORITHMS.indexOf(t.algorithm) === -1 ? 'parallel' : t.algorithm,
      limit: parseInt(t.limit, 10) || Funnel.DEFAULT_LIMIT,
      maxTranches: (t.maxTranches == null) ? 3 : Math.max(0, parseInt(t.maxTranches, 10) || 0),
      size: size,
      /* 每批召回条数不能超过一批的容量，否则「每批取前 topN」是句空话 */
      topN: Math.min(size, Math.max(1, parseInt(t.topN, 10) || Recall.DEFAULT_TOPN))
    };
  }

  /* 「参数」题 criteria：≤250 个 ref 的页面原样透传；超限才走 ref-funnel 裁剪。
   * meta 单独返回给调用方（步骤卡展示用），不会混进请求体。 */
  function paramCriteria(ctx) {
    var o = ctx || {};
    var trim = normalizeTrim(o.paramTrim);
    var batch = Math.max(1, parseInt(o.batch, 10) || 1);

    if (!trim.on) {
      return {
        criteria: refCriteria(o.snapshot),
        meta: {
          enabled: false, trimmed: false, totalRefs: U.parseSnapshotRefs(o.snapshot).length,
          limit: trim.limit, batch: batch, maxTranches: trim.maxTranches
        }
      };
    }
    /* trim 路径不在这里数 ref：buildBoundedRefCriteria 自己解析一次并回填 meta.totalRefs。
     * 早先这里无条件先解析一遍，默认（trim 开）路径下结果直接被丢掉 —— 大页面白扫一次全量快照。 */
    var out = Funnel.buildBoundedRefCriteria(o.snapshot, {
      goal: o.goal, avoidRefs: o.avoidRefs, limit: trim.limit, batch: batch, maxTranches: trim.maxTranches
    });
    out.meta.enabled = true;
    return out;
  }

  /* ---------------- 并行召回（algorithm = parallel） ----------------
   * 触发条件：裁剪开着 + 元素数超过一批（K > 1）。K === 1 或裁剪关闭时返回 null ——
   * 调用方据此走原有的单次调用路径（小页面零额外请求、零回归）。 */
  function recallPlan(ctx) {
    var o = ctx || {};
    var trim = normalizeTrim(o.paramTrim);
    if (!trim.on) return null;
    /* 选中的是相关性裁剪时**必须**返回 null：否则两条路线会同时生效，
     * 「其他」兜底与并行召回搅在一起，谁也说不清候选是怎么来的 */
    if (trim.algorithm !== 'parallel') return null;
    var plan = Recall.planBatches(o.snapshot, { size: trim.size, topN: trim.topN });
    return plan.meta.parallel ? plan : null;
  }

  /* 召回批次题：**只问「参数」一题**。
   * 不问动作 / 未完成 —— 召回只关心元素的概率分布，动作与整体决策仍由最后那次全套 3 题的
   * 调用决定。这样 K 批之间不需要投票、决策只有一处，可解释也可复现。
   * instructions 明说「不需要判断目标是否在本批中」：本批里可能根本没有目标，
   * 让模型去判「有没有」只会得到一堆犹豫的低概率，反而毁掉召回排序。 */
  function buildRecallQuestions(plan, batchIndex) {
    var b = plan.batches[batchIndex - 1];
    var instructions = '本题只问元素，不涉及动作。以下是当前页面第 ' + b.index + '/' + plan.meta.batches
      + ' 批元素（本批 ' + b.refs.length + ' 个，全页共 ' + plan.meta.totalRefs + ' 个）。'
      + '请选出其中与任务目标最相关的元素，并按把握程度给出概率分布：'
      + '本批每个候选都要有概率（哪怕很小），不需要判断目标是否在本批中，只在本批内排序即可。';
    return { '参数': { type: 'choice', instructions: instructions, criteria: b.criteria } };
  }

  /* ---------------- 历史会话：落盘形状 → 运行时形状 ----------------
   * 落盘用 request / llm.response，运行时（渲染层）认 payload / llm.raw。这层映射
   * 原先写在 auto.js 的 IIFE 里，node 侧看不见，于是**「落盘 → 重新载入 → 面板」这条
   * 边界一直没测试面**：并行召回的候选键（合并候选清单）、「参数决策」行动的候选数
   * 都是在这条边界上丢的（用户看到的就是「面板与实际数据不匹配」）。
   * 搬进纯逻辑层，可被 node:test 直接往返对账。 */
  function hydrateRecord(rec) {
    var r0 = rec || {};
    return {
      meta: r0.meta,
      steps: (r0.steps || []).map(function (s) {
        return Object.assign({}, s, {
          payload: s.payload || s.request || null,
          followUps: (s.followUps || []).map(function (r) {
            return Object.assign({}, r, {
              payload: r.payload || r.request || null,
              /* 老记录没存候选数：从并行召回的候选键数补回来，别让标题写成「候选 ? 个」。
               * 连候选键都没有（更老的记录）→ 保持 null 写「?」：报 0 个是假话 */
              candidates: (r.candidates != null) ? r.candidates
                : (((r.kind || 'param') === 'pick' && s.recall && (s.recall.candidates || []).length)
                  ? s.recall.candidates.length : null),
            });
          }),
          /* 并行召回的批次同样要 request → payload 归一，否则历史会话里召回批次的
           * 请求体渲染不出来（渲染层只认 payload）。
           * sharedState：落盘时省掉了与本步首轮重复的那份 state（见 buildRunRecord），
           * 这里挂回去 —— UI 的「① 发送的请求体」才与当时真发出去的一致 */
          recall: s.recall ? Object.assign({}, s.recall, {
            /* 落盘只存候选键（candidates），这里按 refLabels 复原成 key→描述 的映射：
             * 召回卡片的「合并后的候选」清单靠它渲染，缺了就整段消失（老记录如实为空） */
            criteria: (s.recall.criteria && Object.keys(s.recall.criteria).length) ? s.recall.criteria
              : (s.recall.candidates || []).reduce(function (m, k) {
                m[k] = (s.refLabels || {})[k] || ''; return m;
              }, Object.create(null)),
            batches: (s.recall.batches || []).map(function (r) {
              var p = r.payload || r.request || null;
              var main = s.payload || s.request || null;
              var full = (p && r.sharedState && main && main.state) ? Object.assign({}, p, { state: main.state }) : p;
              var out = Object.assign({}, r, { payload: full });
              delete out.sharedState;
              return out;
            }),
          }) : null,
          llm: s.llm ? { messages: s.llm.messages, raw: s.llm.response, text: s.llm.text, error: s.llm.error, ms: numOrNull(s.llm.ms) } : null,
        });
      }),
    };
  }

  /* 各批召回 → 合并成一个最终候选集（纯逻辑在 ref-recall.js，这里只是接线）。
   * 传进来的是 callJev 的 data（信封）还是内层作答都可以 —— 剥壳在 ref-recall.answerOf。 */
  function mergeRecall(plan, answers, opts) {
    return Recall.mergeBatches(plan, answers || [], opts || {});
  }

  /* 首轮「参数」作答 → 最终决策要带上的种子候选（用户定的规则：
   * 最终候选 = **首轮那一段里选出的前 topN 个** + K 批并行召回的合并结果）。
   * 为什么不是只带作答的那一个：首轮那次概率分布本身就是一次有效的相关性排序，
   * 只留一个等于把它的信息全丢掉，最终决策面对的是一个没有对手的候选集
   * （实测会话 r-0928-1954-4dgf：469 个 ref / 2 批召回，候选只剩 1 个，那一步是空转）。
   * 作答的那个 ref 由 pickFromAnswer 保证恒在（哪怕概率为 0 / 落在分布之外）。 */
  function recallSeeds(ctx) {
    var o = ctx || {};
    var plan = o.plan;
    if (!plan || !plan.first) return [];
    var topN = (plan.meta && plan.meta.topN) || Recall.DEFAULT_TOPN;
    return Recall.pickFromAnswer(plan.first.criteria, o.answer, topN).map(function (x) { return x.ref; });
  }

  /* 值得再花一轮并行召回去定位的动作：**要在大量元素里挑一个**的那几个。
   *   - 终止态 / 导航类（goto / press / 标签页…）不作用于元素，本来就轮不到召回
   *   - 「生成输入」按产品决定**不触发**（它的目标是输入框，首轮那次「参数」作答就是它的定位）
   * 其余需要元素的动作（click / fill / type / select / check / uncheck / hover）才触发。 */
  var RECALL_ACTIONS = { click: 1, fill: 1, type: 1, select: 1, check: 1, uncheck: 1, hover: 1 };

  /* 并行召回的触发判定：**页面元素超过一批** 且 **首轮动作是需要定位的动作**。
   * 抽成纯函数是为了让这条规则可断言（单测直接打这两个条件），也免得调用方
   * 把「要不要召回」的判据写散 —— 动作不需要元素时一个召回请求都不该发：
   * 那是「先判动作、再决定要不要召回」的全部意义。 */
  function shouldRecall(plan, decision) {
    return Boolean(plan && decision && RECALL_ACTIONS[decision.action]);
  }

  /* 去掉「其他」兜底项：并行召回这条路线没有它 —— 候选就是召回结果，没有「还有下一批」。
   * 只剔这一个键，别动顺序（最终候选的先后有意义：首轮种子在最前）。
   * 抽出来是因为**候选集合必须与计数、落盘、面板说的是同一份**：
   * 曾经只在发给 Jev 的那一份上剔（buildRecallPickQuestions 里），于是退回裁剪候选时
   * 面板/记录写「候选 81 个」、实际发出 80 个，还多渲染一行空的「其他」（面板与实际不符）。 */
  function dropRefMore(criteria) {
    var out = Object.create(null);
    Object.keys(criteria || {}).forEach(function (k) {
      if (k !== REF_MORE) out[k] = criteria[k];
    });
    return out;
  }

  /* 并行召回一条都没命中时的兜底候选：退回相关性裁剪那一份。
   * 两条必须同时成立，否则又是「面板与实际不符」：
   *   ① 剔掉「其他」—— 这条路线没有兜底项（语义是「展开下一批」，在这里会变成一个合法的元素名）
   *   ② meta.merged 按**剔过之后**的份数报，落盘/面板/真正发出的题目才对得上（曾经报 81、实发 80）
   * 抽成纯函数就是为了让这条路径有测试面：老实现写在 auto.js 的 IIFE 里，node 侧看不见。 */
  function recallFallback(ctx) {
    var o = ctx || {};
    var fb = paramCriteria({
      snapshot: o.snapshot, goal: o.goal, avoidRefs: o.avoidRefs, paramTrim: o.paramTrim,
    });
    var criteria = dropRefMore(fb.criteria);
    return {
      criteria: criteria,
      meta: Object.assign({}, o.mergedMeta || {}, { fallback: true, merged: Object.keys(criteria).length }),
    };
  }

  /* 召回之后那一次「参数」决策题（并行召回的收口）。
   * 候选 = 首轮前 topN 个（种子，作答的那个必在其中）+ K 批召回的合并结果 ——
   * 首轮那一段不在召回范围内，只能由它自己的预测代表（用户定的规则）。
   * 与 ref-funnel 的批次补问同形（单题 choice），
   * 区别是候选已全部列出、没有「下一批」可展开 —— 措辞必须写死这一点。 */
  function buildRecallPickQuestions(ctx) {
    var o = ctx || {};
    var meta = o.meta || {};
    var seeded = (meta.seeded || []).length;
    /* 候选里**绝不能有「其他」**：那是「相关性裁剪」路线的兜底项（语义是「展开下一批」），
     * 到了这条路线就成了一个合法的「元素名」——实测事故：召回无结果时退回裁剪候选，
     * 那一份带着「其他」，Jev 选了它，于是 decision.param = 「其他」，
     * 命令打到浏览器直接报「fill 需要合法 ref（形如 e12），收到：其他」，连烧三步。
     * 这里再防御性剔一次：上游（resolveRecall 的兜底）已经剔过，双保险不嫌多 */
    var criteria = dropRefMore(o.criteria);
    var from = meta.fallback
      /* 召回整段没结果、退回裁剪候选这一次：别把它说成「并行召回的合并结果」（那是另一条路线） */
      ? '并行召回无结果时退回的相关性裁剪候选'
      : seeded
        ? '首轮在该段元素里选出的 ' + seeded + ' 个 + ' + meta.batches + ' 批并行召回的合并结果'
        : meta.batches + ' 批并行召回的合并结果';
    var instructions = '已确定的动作是「' + o.action + '」。候选 = ' + from + '，共 '
      + Object.keys(criteria).length + ' 个（全页共 ' + meta.totalRefs + ' 个），已全部列出，'
      + '请在其中选定该动作要操作的唯一元素。';
    return { '参数': { type: 'choice', instructions: instructions, criteria: criteria } };
  }

  function paramInstructions(param) {
    var meta = (param && param.meta) || {};
    var criteria = (param && param.criteria) || {};
    var head = '该动作应作用于快照中的哪个元素？';
    var tail = '若你决定的动作不作用于任何元素（press / goto / 前进后退 / 刷新 / 标签页 / 弹窗 / 终止），'
      + '「参数」不会被使用，任选一项即可。';
    /* 并行召回：候选既不是「全量」也不是「折叠剩余」——是 K 批召回合并出来的。
     * 措辞要说清来源、说清已全部列出（不给「还有下一批」的暗示：这条路线没有兜底项） */
    if (meta.algorithm === 'parallel' && meta.first) {
      /* 首轮那一次：候选只有本页前 size 个元素（其余留给第二轮的并行召回）。
       * 必须说清楚「本段没有就在本段里挑最接近的」——否则模型会以为候选缺失而乱选 */
      var rest = Math.max(0, meta.totalRefs - meta.firstSize);
      return head + '候选是当前页面前 ' + meta.firstSize + ' 个元素（全页共 ' + meta.totalRefs + ' 个）。'
        + '若目标元素在本段里，直接选中它；若本段里没有，就选出本段中最接近的那一个 ——'
        + '下一步会按需并行召回其余 ' + rest + ' 个元素再核对一次。' + tail;
    }
    if (meta.algorithm === 'parallel') {
      return head + '候选由并行召回合并而来：共 ' + meta.merged + ' 个（' + meta.batches
        + ' 批 × 每批按概率取前 ' + meta.topN + '，全页共 ' + meta.totalRefs + ' 个），'
        + '已全部列出，请直接在其中选定本步要操作的元素。' + tail;
    }
    if (!meta.trimmed) {
      return head + '选项由当前快照自动解析，【可交互】为可操作元素。' + tail;
    }
    var shown = meta.top.length;
    var scope = '本批 ' + shown + ' 个，全页共 ' + meta.totalRefs + ' 个';
    if (criteria[REF_MORE]) {
      return head + '候选已按与任务目标的相关性折叠：' + scope
        + '。若目标元素不在本批中，请选「' + REF_MORE + '」展开下一批。' + tail;
    }
    if (meta.hiddenMore) {
      return head + '候选已按与任务目标的相关性折叠，这是最后一批（' + scope + '），'
        + '请在本批内做出选择。' + tail;
    }
    return head + '候选已按与任务目标的相关性折叠：' + scope + '，已全部列出。' + tail;
  }

  /* 第二批起的「参数」补问：只问这一题（动作已定，不重发整组问题以免连带动摇动作决策） */
  function buildParamFollowUp(ctx) {
    var o = ctx || {};
    var meta = (o.paramCriteria && o.paramCriteria.meta) || {};
    var limit = parseInt(o.limit, 10) || meta.limit || Funnel.DEFAULT_LIMIT;
    var batch = Math.max(2, parseInt(o.batch, 10) || 2);
    var total = o.totalRefs || meta.totalRefs || 0;
    var from = (batch - 1) * limit + 1;
    var to = Math.min(batch * limit, total);
    var scope = '第 ' + from + '–' + to + ' 个，全页共 ' + total + ' 个';
    /* 补问只发生在「动作需要元素且首轮选了『其他』」的路径上（normalizeParam 已把
     * 不需要元素的动作拦下），这里不再提「无需元素」—— 候选里也没有它 */
    var instructions = '已确定的动作是「' + o.action + '」。本批是第 ' + batch + ' 批候选（' + scope + '）。'
      + (o.paramCriteria && o.paramCriteria.criteria && o.paramCriteria.criteria[REF_MORE]
        ? '若目标元素仍不在本批中，请继续选「' + REF_MORE + '」展开下一批。'
        : '这是最后一批候选，请在本批内做出选择。');
    return {
      '参数': { type: 'choice', instructions: instructions, criteria: o.paramCriteria.criteria }
    };
  }

  function isRefMore(param) { return Funnel.isMoreChoice(param); }

  /* 补问只回一道「参数」题，不能走 parseDecision（那要求「动作」「未完成」齐全） */
  function parseParamAnswer(answers) {
    var a = answers || {};
    var param = a['参数'] && a['参数'].choice;
    if (!param) throw new Error('Jev 未返回「参数」选项');
    return String(param);
  }

  /* 动作不需要元素时，参数一律剥掉（不传给浏览器、不进时间线标签）：
   * 「无需元素」下线后模型仍必须回答参数题，随手选的 ref 由这里静默忽略；
   * 「其他」配到这类动作上时同样归一为空并给一句说明（不报错、不中断、也不展开下一批） */
  function normalizeParam(decision) {
    var d = decision || {};
    if (needRef(d.action)) return { param: d.param || null, note: '' };
    if (!d.param) return { param: null, note: '' };
    if (isRefMore(d.param)) {
      return { param: null, note: '动作 ' + d.action + ' 不需要作用于元素，「' + REF_MORE + '」按未选参数处理' };
    }
    return { param: null, note: '' };
  }

  /* ---------------- 动作 × 元素角色兼容性 ----------------
   * 只登记**物理上不可能**的组合，其余一律放行。证据取自 playwright 注入脚本本身：
   *   select        —— selectOptions 首行就是 `element.nodeName.toLowerCase() !== 'select'` → 抛
   *                    "Element is not a <select> element"；原生 <select> 在快照里是 combobox
   *                    （单选）/ listbox（多选或 size>1），它下面的 option 根本没有 ref。
   *   check/uncheck —— getChecked 只认 input[type=checkbox|radio] 或 kAriaCheckedRoles 里的角色
   *                    （下面的 K_ARIA_CHECKED_ROLES），其余一律抛 "Not a checkbox or radio button"。
   * 故意不登记 fill / type / 生成输入：可编辑性判不了 —— contenteditable 的 div 在快照里是
   * generic，按角色拦会误报（白问一次，还可能动摇模型的正确决策）。宁可漏报，交回给浏览器报错。
   * 已知盲区：<label> 包着 <select> 时 selectOptions 会 follow-label 重定位成功，而 label 在快照里
   * 不是 combobox → 这里会误报一次补问。代价有界（一次 Jev 调用、不发命令），换来的是实测到的
   * 「模型对 button "发货" 选了 select」被拦在浏览器之外。 */
  var K_ARIA_CHECKED_ROLES = ['checkbox', 'menuitemcheckbox', 'option', 'radio', 'switch', 'menuitemradio', 'treeitem'];
  var ACTION_ROLE_ALLOW = {
    'select': ['combobox', 'listbox'],
    'check': K_ARIA_CHECKED_ROLES,
    'uncheck': K_ARIA_CHECKED_ROLES
  };
  var ACTION_ROLE_WHY = {
    'select': 'select 只能作用于原生下拉框（快照里是 combobox / listbox）',
    'check': 'check 只能作用于复选框 / 单选框',
    'uncheck': 'uncheck 只能作用于复选框 / 单选框'
  };

  /* ref → role（快照里的角色只是提示，判断规则全部集中在下面这张表） */
  function refRoles(snapshot) {
    var out = Object.create(null);
    U.parseSnapshotRefs(snapshot).forEach(function (r) { out[r.ref] = r.role; });
    return out;
  }

  function roleBlocks(action, role) {
    var allow = ACTION_ROLE_ALLOW[action];
    return Boolean(allow) && allow.indexOf(role) === -1;
  }

  /* 冲突时返回 { conflict:true, ref, role, action, why, compatible }；
   * compatible = 该元素上仍可执行的动作（终止态不在里面）。 */
  function checkActionRole(decision, roles) {
    var d = decision || {};
    var action = d.action;
    if (!ACTION_ROLE_ALLOW[action] || !needRef(action)) return { conflict: false };
    var ref = d.param;
    if (!ref) return { conflict: false };
    var role = (roles || {})[ref];
    if (!role || !roleBlocks(action, role)) return { conflict: false };
    return {
      conflict: true, ref: ref, role: role, action: action, why: ACTION_ROLE_WHY[action],
      compatible: Object.keys(AUTO_TOOLS).filter(function (k) { return !roleBlocks(k, role); })
    };
  }

  /* ---------------- select 选项预检 ----------------
   * 动作 × 角色校验管住了「select 配 button」，但 select 配 combobox 也可能错在
   * 选项层：Jev 想搜索「王小明」，却规划成「在“订单状态”下拉框里选“王小明”这个
   * 选项」——选项不存在，命令打到浏览器必抛 option not found，且真实模型实测会
   * 连续重复同一错误组合。快照里 combobox 子树自带 option 名单（option 无 ref 但
   * 有名字），这里确定性预检：选项不在名单内就不发命令，报错直接给出可选清单与
   * 纠偏提示（想输入文本请改用 fill + 搜索框），作为下一轮的强信号。
   * 读不到选项名单（快照形态变化 / ref 不是下拉框）则放行 —— 宁可漏报。 */
  function leadingSpaces(line) {
    var m = String(line).match(/^ */);
    return m ? m[0].length : 0;
  }

  function selectOptionNames(snapshot, ref) {
    var lines = String(snapshot || '').split('\n');
    var at = -1;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf('[ref=' + ref + ']') !== -1) { at = i; break; }
    }
    if (at === -1) return null;
    var headIndent = leadingSpaces(lines[at]);
    var out = [];
    for (var j = at + 1; j < lines.length; j++) {
      if (leadingSpaces(lines[j]) <= headIndent) break;
      var m = lines[j].match(/- option "([^"]*)"/);
      if (m) out.push(m[1]);
    }
    return out.length ? out : null;
  }

  function checkSelectOption(snapshot, ref, text) {
    if (!ref || text == null) return { conflict: false };
    var options = selectOptionNames(snapshot, ref);
    if (!options) return { conflict: false };
    var t = String(text).trim();
    for (var i = 0; i < options.length; i++) {
      if (String(options[i]).trim() === t) return { conflict: false };
    }
    var line = String(snapshot || '').split('\n').filter(function (l) { return l.indexOf('[ref=' + ref + ']') !== -1; })[0] || '';
    var name = (line.match(/"([^"]*)"/) || [])[1] || ref;
    return {
      conflict: true, ref: ref, text: t, options: options,
      error: '下拉框「' + name + '」（' + ref + '）没有「' + t + '」这个选项，可选：' + options.join(' / ')
        + '。若本意是切换该下拉框的选项，请在下一轮的「文本」补问里改选正确的选项名；'
        + '若本意是把文本输入到输入框（如按买家搜索），动作应选 fill（或「生成输入」），并把「参数」改成对应的搜索框'
    };
  }

  /* 该角色的常规动词：补问时顺带指出来。fill / type / 生成输入 判不了可编辑性、
   * 拦不住（contenteditable 的 div 在快照里是 generic），只能靠这句把模型导向对的动作。 */
  var ROLE_VERB_HINT = {
    'button': '按钮的常规动作是 click（其次 hover）',
    'link': '链接的常规动作是 click',
    'row': '表格行本身通常不可点，真正的操作按钮在行内 —— 应 click 行内的那个按钮',
    'cell': '单元格本身通常不可点，操作按钮在同一个单元格或同一行内',
    'checkbox': '复选框用 check / uncheck',
    'menuitemcheckbox': '勾选式菜单项用 check / uncheck',
    'radio': '单选框用 check',
    'switch': '开关用 check / uncheck',
    'combobox': '原生下拉框用 select',
    'listbox': '多选列表用 select',
    'textbox': '输入框 / 文本域用 fill（需要逐字输入时用 type）',
    'searchbox': '搜索框用 fill（需要逐字输入时用 type）',
    'spinbutton': '数字输入用 fill',
    'tab': '标签页用 click'
  };

  /* 不兼容时的补问：只问「动作」一题（形状对齐 buildParamFollowUp）。
   * 刻意不带终止态 —— 终止只走主循环那条通道，补问里放它等于开了个旁路。 */
  function buildActionFollowUp(conflict) {
    var c = conflict || {};
    var criteria = {};
    (c.compatible || []).forEach(function (k) { if (AUTO_TOOLS[k]) criteria[k] = AUTO_TOOLS[k]; });
    var hint = ROLE_VERB_HINT[c.role];
    var instructions = '已确定元素 ' + c.ref + '（角色 ' + (c.role || '未知') + '）。'
      + '你在「动作」题选的「' + c.action + '」在该元素上无法执行：' + (c.why || '动作与元素类型不匹配') + '。'
      + (hint ? hint + '。' : '')
      + '请重新选择动作（本列表已去掉该元素上不可能执行的动作）。';
    return { '动作': { type: 'choice', instructions: instructions, criteria: criteria } };
  }

  /* 补问只回一道「动作」题；答案是否在候选里由调用方校验（同 parseParamAnswer 的分工） */
  function parseActionAnswer(answers) {
    var a = answers || {};
    var action = a['动作'] && a['动作'].choice;
    if (!action) throw new Error('Jev 未返回「动作」选项');
    return String(action);
  }

  /* ---------------- 文本补问（动作确定后才问，候选按动作分型） ----------------
   * 旧设计里「文本」与「动作」「参数」同请求作答：三题因子化各选各的，没有联合
   * 一致性约束 —— 实测事故（订单场景第 ⑤ 步）里模型在「搜索王小明」与「切换
   * 发货状态」两个子目标间摇摆，拼出 select e15 "王小明"（选项不存在）的嵌合
   * 决策。现在文本题延后：动作 + 参数落定后，候选只服务这个已确定的动作 ——
   * select 给下拉框的真实选项名（结构性消灭「选项不存在」这类错误），
   * press 给变量池 ∪ 常用键名，其余文本动作给变量池。 */
  var COMMON_KEY_NAMES = ['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', 'Space', 'Delete', 'Backspace'];
  var KEY_HINTS = {
    'Enter': '确认 / 提交 / 打开选中项',
    'Escape': '关闭浮层 / 取消',
    'Tab': '焦点移到下一个控件',
    'ArrowDown': '下移一项（下拉 / 列表）',
    'ArrowUp': '上移一项',
    'PageDown': '向下翻一页（滚动页面）',
    'PageUp': '向上翻一页',
    'Home': '跳到开头',
    'End': '跳到末尾',
    'Space': '空格（勾选 / 滚动一屏）',
    'Delete': '删除',
    'Backspace': '退格删除'
  };

  /* 变量池 → criteria（「取值：xxx」与旧文本题同构，Jev 见过的形状不变） */
  function variableTextCriteria(variables) {
    var out = {};
    (variables || []).forEach(function (v) {
      if (v && v.name && v.value != null && !out[v.name]) out[v.name] = '取值：' + v.value;
    });
    return out;
  }

  /* 返回 { '文本': {…} } 单题；无需文本 / 必填动作零候选 → null（builder 不抛错，
   * 调用方据此记确定性失败步，别把「构造不出来」当成运行时异常） */
  function buildTextFollowUp(ctx) {
    var o = ctx || {};
    var action = o.action;
    if (!needText(action)) return null;

    var variables = (o.variables || []).filter(function (v) { return v && v.name; });
    var criteria = {};
    var optionListNote = '';
    if (action === 'select') {
      /* 选项名直出（不与变量池混选：两个来源的语义不同，混了就又回到旧题的摇摆面） */
      var names = selectOptionNames(o.snapshot, o.param);
      if (names) {
        names.forEach(function (n) { criteria[n] = '该下拉框的选项'; });
        optionListNote = '候选就是该下拉框当前的真实选项，必须从中选择。';
      } else {
        /* 读不到名单（快照形态变化 / ref 已失效）：退回变量池兜底，宁可漏拦不可拦死 */
        criteria = variableTextCriteria(variables);
        optionListNote = '未能从快照读出该下拉框的选项名单，候选退回变量池。';
      }
    } else if (action === 'press') {
      criteria = variableTextCriteria(variables);
      COMMON_KEY_NAMES.forEach(function (k) {
        if (!criteria[k]) criteria[k] = '键名：' + (KEY_HINTS[k] || k);   // 变量与键名撞名时变量优先（用户显式意图）
      });
    } else if (action === 'tab-select' || action === 'tab-close') {
      /* 序号直出（不与变量池混选）：driver 硬校验这两个动作的文本必须是非负整数
       * （标签页序号），候选给成关键词/变量只会拼出 tab-select "jev" 这种必败命令
       * （实测事故）。tabs 由主循环每轮从 page-info 带回 —— 工程自动注入，
       * 模型只能从真实打开的 Tab 里挑。 */
      var tabList = (o.tabs || []).filter(function (t) { return t && typeof t.index === 'number'; });
      tabList.forEach(function (t) {
        criteria[String(t.index)] = (t.current ? '【当前】' : '') + 'Tab ' + t.index + '：'
          + (t.title || '（无标题）') + ' — ' + (t.url || '');
      });
      if (action === 'tab-select' && !tabList.length) {
        /* 读不到标签页列表：拼不出合法序号，宁记失败步也不让变量池瞎猜 */
        return null;
      }
      if (action === 'tab-select') optionListNote = '候选就是当前打开的全部标签页序号，必须从中选择。';
    } else {
      criteria = variableTextCriteria(variables);
    }
    if (TEXT_OPTIONAL_ACTIONS[action]) criteria[TEXT_NONE] = '本动作不需要输入文本';

    /* 零候选 → null：必填动作（fill/press…）无值可选、可选动作只剩「无」一项 ——
     * 都无从问起，调用方据此记确定性失败步 */
    var keys = Object.keys(criteria);
    if (!keys.length || (TEXT_OPTIONAL_ACTIONS[action] && keys.length === 1 && keys[0] === TEXT_NONE)) return null;

    var target = '';
    if (o.refLabel) target = '，目标元素 ' + o.param + '「' + stripRefPrefix(o.refLabel) + '」';
    else if (o.param) target = '，目标元素 ' + o.param;
    var instructions = '已确定动作 ' + action + target + '。'
      + (action === 'select'
        ? '这个动作的文本就是要选定的选项名。' + optionListNote
        : action === 'press'
          ? '请选出要按下的键（变量优先，其次常用键名）。'
          : action === 'tab-select'
            ? '这个动作的文本是要切换到的标签页序号。' + optionListNote
            : action === 'tab-close'
              ? '这个动作的文本是要关闭的标签页序号；选「无」则不传序号、关闭当前 Tab。'
              : '该动作需要输入文本，请选出应使用的值。')
      + (TEXT_OPTIONAL_ACTIONS[action] && action !== 'tab-close' ? '本动作也可以不带文本，不需要就选「无」。' : '');
    return { '文本': { type: 'choice', instructions: instructions, criteria: criteria } };
  }

  /* 补问只回一道「文本」题（形状与 parseParamAnswer 一致，分工也一致） */
  function parseTextAnswer(answers) {
    var a = answers || {};
    var text = a['文本'] && a['文本'].choice;
    if (!text) throw new Error('Jev 未返回「文本」选项');
    return String(text);
  }

  /* ---------------- 原生弹窗（modal state）----------------
   * 页面触发 confirm/alert/prompt 后，playwright 的工具会拒绝执行并报
   * "does not handle the modal state" —— 这不是故障，是页面被对话框阻塞。
   * 主循环把这种快照失败转成「弹窗步」：快照换成一句说明文本，只问一道
   * 「动作」题（形状与补问一致，单题形态合法），Jev 决定接受还是取消；
   * 处理完弹窗，下一轮即恢复正常快照。修复前这里直接以 error 终止整个运行。 */
  var DIALOG_SNAPSHOT_NOTE = '（页面正被浏览器原生对话框 confirm/alert/prompt 阻塞，快照不可用，页面冻结在弹窗出现前的状态；本轮只需决定如何处理弹窗）';

  function isModalSnapshotError(errText) {
    return /modal state/i.test(String(errText || ''));
  }

  /* 快照携带器：「上一步动作顺带带回的快照，顶替下一步的 snapshot」这件事的全部判据。
   *
   * 为什么抽成这个对象：这段逻辑本来散在 auto.js 的循环里（一个模块级变量 + 三处清零点），
   * 而 auto.js 没有任何单测能到达 —— 接错线不会报错，只会让模型看着上一页做决策。
   * 抽出来之后，规则只有三条，且每条都有断言盯着：
   *   ① 只有**成功**的动作、且带回的是**非空字符串**，才收下（失败/空/没有 → 一律清空，
   *      不许让上上次的快照留下来冒充这次的）；
   *   ② 取走即清（take）—— 快照只能被紧接着的那一步用掉，隔步复用等于拿两步之前的页面；
   *   ③ reset() 用于开跑（上一轮的快照绝不能跨轮生效：这一轮的浏览器是刚 open 的）。
   * 这三条合起来保证的不变量是：**用来当页面依据的那份快照，永远来自紧邻的上一次动作。 */
  function makeSnapshotCarrier() {
    var pending = null;
    return {
      accept: function (act) {
        pending = (act && act.ok && typeof act.snapshot === 'string' && act.snapshot) ? act.snapshot : null;
        return pending;
      },
      take: function () {
        var v = pending;
        pending = null;
        return v;
      },
      reset: function () {
        pending = null;
      },
      peek: function () {   /* 只给测试与排查看，不参与流程 */
        return pending;
      },
    };
  }

  function buildDialogQuestions() {
    return {
      '动作': {
        type: 'choice',
        instructions: '上一步操作触发了浏览器原生对话框（confirm 确认框 / alert 提示框 / prompt 输入框），页面被阻塞、快照不可用。'
          + '请决定如何处理这个对话框：按任务目标对确认框选择「dialog-accept（接受）」或「dialog-dismiss（取消）」，alert 只能接受。'
          + '处理完弹窗页面才会恢复，之后的步骤再继续操作页面本身。',
        criteria: { 'dialog-accept': AUTO_TOOLS['dialog-accept'], 'dialog-dismiss': AUTO_TOOLS['dialog-dismiss'] }
      }
    };
  }

  function buildQuestions(ctx) {
    var snapshot = ctx.snapshot || '';
    var param = ctx.param || paramCriteria(ctx);
    var paramCriteriaMap = param.criteria || refCriteria(snapshot);

    var out = {
      '动作': {
        type: 'choice',
        /* 角色 → 动词的对照必须写在这里：动作题与「参数」同请求同时作答，动作的选择本身
         * 拿不到任何元素信息，只能靠这条对照把「目标元素是 button 就用 click」说死。
         * 措辞直接（官方实测：问得越委婉，一致率越低）。 */
        instructions: '根据页面快照与已完成步骤，下一步应执行哪个动作？'
          + '先按目标元素的角色挑动词（选项描述里已标出角色，如 button "发货"、combobox "订单状态"）：'
          + '按钮 / 链接 / 表格行 / 任意可点元素 → click；输入框 / 文本域 → fill；'
          + '复选框 / 单选框 → check / uncheck；原生下拉框（combobox）→ select；文件 → upload；'
          + '滚动页面 → press（键名在动作确定后的「文本」补问里选，常用 PageDown / PageUp）。'
          /* 「无操作」下线后必须把「不能空转」说死，否则模型会去找别的等价出口 */
          + '本动作集里没有「等待 / 空转」选项，页面不会自己变化 —— 每一步都必须推进任务：'
          + 'fill 只写入、不提交，填完搜索框 / 聊天框后下一步要再选 click 点「搜索 / 发送」按钮或 press 回车。'
          + '若目标已达成选「任务已完成」—— 这是唯一的终止态，页面做不到就换动作 / 换元素继续推。',
        criteria: Object.assign({}, AUTO_TOOLS, TERMINAL_TOOLS)
      }
    };
    /* 零 ref 页面（空白页 / 极简页）没有参数候选 —— 空选项的 choice 题会被接口拒，
     * 直接不发这题；parseDecision 容忍参数答案缺失（null），需要元素的动作由
     * planExecution 抛出带说明的失败步 */
    if (Object.keys(paramCriteriaMap).length) {
      out['参数'] = {
        type: 'choice',
        instructions: paramInstructions(param),
        criteria: paramCriteriaMap
      };
    }
    out['未完成'] = {
      type: 'score',
      instructions: '对「任务目标的未完成程度」打分：0 = 已完成，1 = 未完成。以页面快照和当前状态为准。',
      criteria: [
        '0 · 已完成：目标结果已体现在页面上',
        '1 · 进行中：关键步骤进行中，仍未完成'
      ]
    };
    return out;
  }

  /* ---------------- 单选项题：工程直出 100% 分布 ----------------
   * 候选恰好 1 个的 choice 题，答案已经确定（不论模型怎么想都只能选它），概率分布必然
   * 退化成单点。发出去只有成本没有信息：
   *   ① 单选项题的作答没有判别信息 —— 真机实测里模型偶尔会回一个概率不落在唯一候选上的
   *      分布，pickFromAnswer 的「作答落在批外直接丢弃」规则会把整批召回清空；
   *   ② 并行召回那 K 批各是一次调用，单候选批次是纯粹的确定性浪费
   *      （size=200 时 201 个 ref 的页面，最后一批就只有 1 个元素）；
   *   ③ 面板上多一条「模型以 100% 选中了唯一的那个」，读起来像一次决策。
   * 所以这类题在**发请求之前**被剥出来，由工程给出与 Jev 作答同构的答案。
   *
   * 判定只看 type + 候选数：score 题（「未完成」量表）不参与 —— 量表级数不可退化成 1 项；
   * 零候选的题也不参与（那不是「唯一」，是空题，交给既有的「不发这题」处理）。
   * 哨兵值（「其他」/「无」）作为唯一候选时照剥：语义与「Jev 以 100% 选中它」一致，
   * 下游对这两个值的处理（isRefMore / TEXT_NONE）一个字都不用动。
   *
   * 返回 { ask 剥后剩下的题, local 题名→**合成答案**, stripped 题名→**原题**, keys 被剥的题名 }。
   * ask 题数为 0 = 整份 payload 都被剥空，调用方据此**整个请求都不发**。
   * `local` 与 `stripped` 是两样东西，**不能互相顶替**：
   *   local    给下游解析与落盘用（choice / probabilities / local 标记）
   *   stripped 给展示用（面板的问题块要 criteria 与 instructions 才能列出候选与说明）
   * 曾经只返回 local、调用方把它当题目传下去 —— 面板对着 undefined 调 Object.keys，
   * 详情体整个空掉（E2E S11 实测：Uncaught TypeError: Cannot convert undefined or null to object）。
   * 不改动入参：ask / stripped 里都是原引用（只读，调用方不写它）。 */
  function splitSingleChoice(questions) {
    var src = questions || {};
    var ask = {};
    var local = {};
    var stripped = {};
    var keys = [];
    Object.keys(src).forEach(function (name) {
      var q = src[name];
      var cands = (q && q.type === 'choice' && q.criteria) ? Object.keys(q.criteria) : [];
      if (cands.length !== 1) { ask[name] = q; return; }
      var only = cands[0];
      var probs = {};
      probs[only] = 1;
      /* 合成答案刻意**不带 confidence**：那个字段的语义是「模型给的分布形状」，
       * 工程不该伪造一个模型没给过的数。展示层的复合置信度只认 number（confOf），
       * 因此天然跳过它 —— 这一条不用额外接线，但它是刻意留白不是漏写。 */
      local[name] = { type: 'choice', choice: only, probabilities: probs, local: true };
      stripped[name] = q;
      keys.push(name);
    });
    return { ask: ask, local: local, stripped: stripped, keys: keys };
  }

  /* ---------------- 决策解析 ---------------- */
  function parseDecision(answers) {
    var a = answers || {};
    var action = a['动作'] && a['动作'].choice;
    if (!action || (!AUTO_TOOLS[action] && !TERMINAL_TOOLS[action])) {
      throw new Error('Jev 返回了未知动作：' + JSON.stringify(String(action)));
    }
    /* 「未完成」缺失或非法时按解析失败处理（记失败步骤交给 Jev 自纠），
     * 绝不能默认 0 —— 那等于把缺字段当成「任务已完成」，两轮后假成功终止 */
    var rawScore = a['未完成'] && a['未完成'].score;
    if (typeof rawScore !== 'number' || !isFinite(rawScore) || rawScore < 0 || rawScore > SCORE_LEVELS - 1) {
      throw new Error('Jev 未返回有效的「未完成」分值（score 应为 0~' + (SCORE_LEVELS - 1) + ' 的数）');
    }
    return {
      action: action,
      /* 参数答案缺失（零 ref 页没问 / 上游没回）按 null 处理：需要元素的动作
       * 在 planExecution 抛错，不需要元素的静默放行 */
      param: (a['参数'] && a['参数'].choice) || null,
      /* 文本不再随首轮作答（动作感知的候选没法提前构造）—— 需要文本的动作
       * 在动作+参数落定后走 buildTextFollowUp 补问。容错：旧上游多回的「文本」
       * 答案直接忽略，不在这里消费。 */
      text: null,
      unfinished: rawScore / (SCORE_LEVELS - 1)
    };
  }

  /* ---------------- 执行规划：Jev 决策 → driver 动作 ---------------- */
  function resolveText(textChoice, variables) {
    if (textChoice == null || textChoice === TEXT_NONE) return null;
    for (var i = 0; i < (variables || []).length; i++) {
      if (variables[i].name === textChoice) return String(variables[i].value);
    }
    return String(textChoice);   // 不在变量池时按字面值兜底
  }

  function planExecution(decision, variables) {
    var action = decision.action;

    if (TERMINAL_TOOLS[action]) return { kind: 'terminal', action: action };

    if (action === '生成输入') {
      if (!decision.param) throw new Error('生成输入需要指定目标输入框的 ref，但 Jev 未在「参数」题选定元素');
      return { kind: 'llm', ref: decision.param };
    }

    var ref = null;
    if (needRef(action)) {
      if (!decision.param) throw new Error('动作 ' + action + ' 需要作用于具体元素，但 Jev 未在「参数」题选定元素');
      ref = decision.param;
    }
    var text = null;
    if (needText(action)) {
      text = resolveText(decision.text, variables);
      /* 必填文本动作选了「无」是矛盾决策；可选文本动作（tab-close/tab-new/
       * dialog-accept）无文本是合法的无参形态，与 driver 白名单 optional 一致 */
      if (text == null && !TEXT_OPTIONAL_ACTIONS[action]) {
        throw new Error('动作 ' + action + ' 需要文本，但 Jev 在「文本」题选择了「无」');
      }
    }
    return { kind: 'act', op: action, ref: ref, text: text };
  }

  /* ---------------- 终止判断（设计 §11） ----------------
   * 返回值带两套字段，职责分开：
   *   state —— 机器可读的结束原因（done/aborted/limit/fails）。展示层与 E2E 只认它，
   *            不要去解析 reason 里的中文，否则改文案就会连带炸测试。
   *   reason —— 给人看的完整句子，用于导出记录与 toast。 */
  function shouldTerminate(s) {
    if (s.aborted) return { done: false, state: 'aborted', reason: '用户中止' };
    var h = s.unfinishedHistory || [];
    if (h.length >= 2 && h[h.length - 1] < 0.2 && h[h.length - 2] < 0.2) {
      return { done: true, state: 'done', reason: '任务完成（Jev 连续两轮判定未完成度 < 0.2）' };
    }
    if (s.steps >= s.maxSteps) return { done: false, state: 'limit', reason: '达到步数上限（' + s.maxSteps + '）' };
    if (s.consecutiveFails >= 3) return { done: false, state: 'fails', reason: '连续 3 步执行失败' };
    return null;
  }

  /* ---------------- LLM 生成输入（设计 §8：工程组装 prompt，前端可见） ---------------- */
  var LLM_SYSTEM_PROMPT = [
    '你是浏览器自动化任务的文本生成器。根据任务目标与目标输入框的上下文，生成应输入到该字段的文本。',
    '只输出文本本身：不要引号、不要解释、不要任何前后缀。',
    '与任务目标使用相同的语言。',
    '搜索框输出简短关键词（通常 2-8 个字）；邮箱、网址、日期等字段遵循其格式；正文 / 备注类字段输出一至两句自然的完整句子。'
  ].join('');

  function fieldHint(refLabel) {
    if (/textarea/i.test(refLabel)) return '多行正文';
    if (/searchbox|textbox|spinbutton/i.test(refLabel)) return '简短短语';
    return '简短短语';
  }

  function extractRefContext(snapshot, ref, radius) {
    var r = radius || 10;
    var lines = String(snapshot || '').split('\n');
    var at = -1;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf('[ref=' + ref + ']') !== -1) { at = i; break; }
    }
    var slice;
    if (at === -1) slice = lines.slice(0, 20);
    else slice = lines.slice(Math.max(0, at - r), Math.min(lines.length, at + r + 1));
    return slice.join('\n');
  }

  function buildLlmMessages(ctx) {
    var refLabel = ctx.refLabel || '';
    var user = [
      '任务目标：' + ctx.goal,
      '当前页面：' + ctx.url + ' · ' + ctx.title,
      '目标字段：' + refLabel + '（期望输出：' + fieldHint(refLabel) + '）',
      '字段周边内容（快照节选）：',
      extractRefContext(ctx.snapshot, ctx.ref, 10),
      '最近步骤：',
      (ctx.recentSteps || []).slice(-5).join('\n') || '（尚无步骤）'
    ].join('\n');
    return {
      messages: [
        { role: 'system', content: LLM_SYSTEM_PROMPT },
        { role: 'user', content: user }
      ],
      temperature: 0.3,
      max_tokens: 200
    };
  }

  /* 生成文本清洗：剥包裹引号 → 删 shell 禁字符（" %）→ 换行压空格 → 截断 */
  function sanitizeLlmText(raw) {
    var t = String(raw == null ? '' : raw).trim();
    var pairs = [['"', '"'], ['“', '”'], ['「', '」'], ['『', '』'], ["'", "'"]];
    for (var round = 0; round < 2; round++) {
      for (var i = 0; i < pairs.length; i++) {
        if (t.length >= 2 && t.charAt(0) === pairs[i][0] && t.charAt(t.length - 1) === pairs[i][1]) {
          t = t.slice(1, -1).trim();
        }
      }
    }
    t = t.replace(/[\r\n\t]+/g, ' ').replace(/["%]/g, '').replace(/ {2,}/g, ' ').trim();
    return t.slice(0, 500);
  }

  /* ---------------- 展示辅助（时间线 / 历史） ---------------- */
  /* ref 标签剥掉「【可交互】」这类前缀。候选标签的形态只有这里这一种，
   * 时间线 / 详情 chip / 补问说明三处共用同一条正则 —— 早先各写一遍。 */
  function stripRefPrefix(refLabel) {
    return String(refLabel || '').replace(/^【[^】]*】\s*/, '');
  }

  /* ref 标签 → 短文本：剥前缀后，带引号名字的（如 button "提交"）只取引号里的部分，
   * 都没有就截断。auto.js 的 refChipLabel 是另一个展示面（「键 · 文本」且截断更长），
   * 两者格式**有意不同**：这里是时间线里嵌进句子的短语，那里是详情区的独立 chip。 */
  function shortRefLabel(refLabel) {
    var s = stripRefPrefix(refLabel);
    var m = s.match(/"([^"]+)"/);
    if (m) return m[1];
    return s.slice(0, 14) || '（无描述）';
  }

  function describeDecision(decision, refLabels, variables) {
    var action = decision.action;
    if (TERMINAL_TOOLS[action]) return action;
    if (isRefMore(decision.param)) return action + '【' + REF_MORE + ' · 展开下一批】';
    if (action === '生成输入') return '生成输入【' + decision.param + ' · ' + shortRefLabel(refLabels[decision.param]) + '】';
    var out = action;
    if (REF_ACTIONS[action] && decision.param) {
      out += '【' + decision.param + ' · ' + shortRefLabel(refLabels[decision.param]) + '】';
    }
    var text = resolveText(decision.text, variables);
    if (TEXT_ACTIONS[action] && text != null) out += ' "' + text + '"';
    return out;
  }

  /* Playwright actionability 失败的根因（被什么挡住 / 不可见 / 不稳）写在日志行尾，
   * 摘要必须把它带上：只截前 80 字符的话，模型看到的永远只是「Timeout 5000ms exceeded」，
   * 推不出「要先清掉遮挡物再点」，于是重复点同一元素直到终止
   * （实测会话 r-0926-0046-qrys：步骤 5-7 三次相同 click，每次 5s 超时）。 */
  var ERR_ROOT_RE = /intercepts pointer events|subtree intercepts|not visible|not stable|outside of the viewport|element is not (enabled|attached|visible)|命令超时/;

  function briefError(err) {
    var s = String(err == null ? '' : err).replace(/\u001b\[[0-9;]*m/g, '').trim();
    if (!s) return '未知错误';
    /* 驱动层已把摘要拼成「首行 | 根因行」；老格式/别处构造的错误可能仍是多行原文 */
    var segs = s.split(/\s*\|\s*|[\r\n]+/).map(function (x) { return x.trim(); }).filter(Boolean);
    if (!segs.length) return '未知错误';
    var root = null;
    for (var i = 0; i < segs.length; i++) {
      if (ERR_ROOT_RE.test(segs[i])) { root = segs[i]; break; }
    }
    /* 逐段折叠而不是截拼接后的整串 —— 后者会把排在末尾的根因段整个切掉 */
    var head = clipMiddle(segs[0], 120);
    if (!root || root === segs[0]) return head;
    return head + ' ｜ ' + clipMiddle(root, 160);
  }

  /* note：可选的第 5 参，只追加一句**观测**（如「（本行是上一步动作改动过的行）」）。
   * 原样追加、不插分隔符 —— 分隔形式由调用方决定（note 自带全角括号即可）。
   * 给的是「已完成步骤」这条通道 —— 模型回看历史时唯一能看到的地方。不给则逐字节不变。 */
  function formatHistoryStep(n, label, ok, err, note) {
    return n + '. ' + label + (ok ? '成功' : '失败：' + briefError(err)) + (note ? String(note) : '');
  }

  /* 哪些动作的结果**不体现在 a11y 快照里**：滚动位置与 hover 浮层都在快照之外。
   * 对它们说「页面快照无变化」是假话 —— 模型会以为自己的动作没生效而重试
   * （长列表页上滚动是高频动作）。ArrowUp / ArrowDown **不算**：它们改列表选中项，
   * 那是快照里看得见的真变化。 */
  var SCROLL_KEYS = { PageDown: 1, PageUp: 1, Home: 1, End: 1, Space: 1 };
  var OPAQUE_ACTIONS = { hover: 1 };

  function isOpaqueAction(decision, variables) {
    var d = decision || {};
    if (OPAQUE_ACTIONS[d.action]) return true;
    if (d.action !== 'press') return false;
    var key = resolveText(d.text, variables);
    return Boolean(key && SCROLL_KEYS[String(key).trim()]);
  }

  /* param 是否为当前快照里真实存在的 ref。
   * 不能用 /^e\d+$/ 这类正则猜 ref 形状：切到第 N 个标签页后 playwright 会给 ref 加 fN 前缀
   * （e496 → f2e496），正则失配会让失败记忆静默失效 —— 实测会话 r-0926-0046-qrys 第 5-7 步
   * 重复点同一个被遮挡元素，failedRefs 一条都没记上（连 -40 降权都没发生过）。
   * refLabels 是当前快照解析出的全量 ref 表，天然覆盖任何前缀。 */
  function isRefParam(param, refLabels) {
    var s = String(param == null ? '' : param).trim();
    if (!s || !refLabels) return false;
    return Object.prototype.hasOwnProperty.call(refLabels, s);
  }

  /* ===================== 运行记录归一（会话树 / 落盘共用） =====================
   * live 步骤与落盘步骤字段名不同（payload/request、llm.raw/llm.response），
   * actionsOf 两头兼容，是「树 = 模型调用流水」的唯一权威来源。 */
  function actionsOf(step) {
    const s = step || {};
    const out = [];
    const recall = s.recall || null;
    const rbs = (recall && recall.batches) || [];
    const mainPayload = s.payload || s.request || null;
    /* 并行召回在行动列表里是**一个**动作（K 批是它的内部明细，不是 K 个动作）：
     * 时间线上「首轮 → 并行召回 → 参数决策 → …」一眼读完。
     * calls = K 用于耗时统计（durationView 只读 actionsOf，漏掉就把 K 次说成 1 次） */
    /* 召回在首轮之前还是之后：新记录带 afterMain 标记（第二轮召回，当前流程）；
     * 老记录没有这个字段，用「首轮有没有「参数」题」反推（那时的首轮不带参数）。
     * 位置也要对，否则时间线读起来像倒放。 */
    const recallAfterMain = recall
      ? (recall.afterMain != null ? Boolean(recall.afterMain)
        : Boolean(mainPayload && mainPayload.questions && !mainPayload.questions['参数']))
      : false;
    if (rbs.length && !recallAfterMain) out.push(recallAction());
    /* 函数声明（不是 const 箭头）：上面那行要在它定义之前调用它 —— 声明会提升，const 不会 */
    function recallAction() {
      /* K 批是**并发**发的（resolveRecall 用 Promise.all）：这一步的墙钟是**最慢的那一批**，
       * 不是各批之和。累加等于把并行的 K 次说成串行 —— 实测 2 批各 ~1.1s 时，
       * 步耗时里凭空多出 1.1s，还会把 otherMs（步耗时 − Jev − 动作 − 输入）挤成 0，
       * 界面上「并行召回」看着比整步还慢。缺 ms 的批次只影响 measured，不参与取最大。 */
      const msArr = rbs.map((r) => numOrNull(r.ms)).filter((m) => m != null);
      const measured = msArr.length;
      const maxMs = measured ? Math.max.apply(null, msArr) : null;
      return {
        kind: 'recall',
        title: '并行召回 · ' + rbs.length + ' 批 × ' + ((recall.meta && recall.meta.size) || '?') + ' 个',
        payload: null, response: null, error: null,
        /* 单候选批被工程直出（没发出去）：批次仍要列在卡里（候选与答案要看得到），
         * 但不能算进 calls —— 它没有产生 Jev 调用，也不该占「几次未计时」的名额 */
        calls: rbs.filter((r) => !r.local).length,
        batches: rbs, meta: recall.meta || null, merged: recall.merged || null,
        mergedKeys: Object.keys(recall.criteria || {}),
        ms: maxMs,
        measured: measured,   /* 有计时的批次个数：durationView 按它报「几次未计时」 */
      };
    }
    if (mainPayload) {
      const n = Object.keys(mainPayload.questions || {}).length;
      const localQ = s.localQuestions || null;
      const localN = localQ ? Object.keys(localQ).length : 0;
      /* 靠题数推断的这两条分支必须先排除「本次有工程直出的题」：被剥掉的单选项会从
       * questions 里消失，于是题数不再能独立判路线 —— 剥掉单选项「参数」后 n 恰好也是 2，
       * noParam 会为真，首轮被写成「Jev 首轮 · 2 题（动作 + 未完成）」，而那句话的既定含义是
       * 「超限页首轮，元素交给并行召回」。那是**另一条**路线，读记录的人会去找一个不存在的设计。 */
      const dialog = !localN && n === 1 && mainPayload.questions['动作'] && !mainPayload.questions['参数'];
      /* 超限页的首轮不带「参数」（元素交给并行召回）：那不是残缺请求，是设计 */
      const noParam = !localN && n === 2 && mainPayload.questions['动作'] && mainPayload.questions['未完成'] && !mainPayload.questions['参数'];
      out.push({
        kind: 'main',
        title: localN ? 'Jev 首轮 · ' + n + ' 题（其中 ' + localN + ' 题工程直出）'
          : dialog ? 'Jev 弹窗步 · 1 题'
            : noParam ? 'Jev 首轮 · 2 题（动作 + 未完成）'
              : 'Jev 首轮 · ' + n + ' 题',
        payload: mainPayload, response: s.response || null, error: s.jevError || null,
        ms: numOrNull(s.jevMs),
        local: Boolean(s.local), localQuestions: localQ,
      });
    }
    /* 首轮不带「参数」= 第二轮召回发生在它之后（当前流程）；带「参数」= 老流程（召回在前）。
     * 两种记录都要排对，否则时间线读起来像倒放。 */
    /* 第二轮召回（当前流程）：排在「首轮」之后、「参数决策」之前 */
    if (rbs.length && recallAfterMain) out.push(recallAction());
    (s.followUps || []).forEach((r) => {
      const k = r.kind || 'param';
      const p = r.payload || r.request || null;
      /* 与首轮同一形状：种类 · 题数 · 上下文。补问按构造恒为单题，题数仍从
       * payload 数出来 —— 老记录可能没有 payload，那时退回 1。 */
      const qp = (p && p.questions) || null;
      const n = qp ? Object.keys(qp).length : 1;
      const titles = {
        param: '参数补问 · ' + n + ' 题 · 第 ' + r.batch + ' 批',
        pick: '参数决策 · ' + n + ' 题 · 候选 ' + (r.candidates != null ? r.candidates : '?') + ' 个（并行召回合并）',
        action: '动作补问 · ' + n + ' 题 · 「' + (r.from || '') + '」与角色 ' + (r.role || '') + ' 冲突',
        text: '文本补问 · ' + n + ' 题 · ' + (r.forAction || ''),
      };
      const localQ = r.localQuestions || null;
      const localN = localQ ? Object.keys(localQ).length : 0;
      out.push({
        kind: k,
        /* 整份请求都没发出去（单选项）：标题必须说清它是工程给的 —— 补问恒为单题，
         * 写「1 题」看起来就像真问过 Jev 一次 */
        title: r.local ? '工程直出 · ' + localN + ' 题（单选项，未调用 Jev）' : (titles[k] || '补问'),
        payload: p, response: r.response || null, error: r.error || null,
        batch: r.batch != null ? r.batch : null, param: r.param || null, action: r.action || null,
        text: r.text || null, forAction: r.forAction || null, from: r.from || null,
        role: r.role || null, ref: r.ref || null, why: r.why || null,
        candidates: r.candidates != null ? r.candidates : null,
        ms: numOrNull(r.ms),
        local: Boolean(r.local), localQuestions: localQ,
      });
    });
    const L = s.llm;
    if (L) {
      out.push({
        kind: 'llm', title: 'LLM 生成输入',
        payload: null, messages: L.messages || null, response: L.raw || L.response || null,
        text: L.text || null, error: L.error || null, ms: numOrNull(L.ms),
      });
    }
    return out;
  }

  /* 行动状态：落定（param/action/text/生成文本 或 main 拿到响应）=ok；error=error；其余=pending */
  function actionStatus(a) {
    if (a.error) return 'error';
    if (a.kind === 'main') return a.response ? 'ok' : 'pending';
    if (a.kind === 'llm') return a.text ? 'ok' : 'pending';
    /* 并行召回：判「有没有拿到响应」——整批都没召回元素不算失败（目标本就不在这批里）；
     * 但**整批都调用失败**是失败：以前这种状态在树上一直转圈（永远 pending） */
    if (a.kind === 'recall') {
      const bs = a.batches || [];
      if (bs.length && bs.every((b) => b.error)) return 'error';
      return bs.some((b) => b.response && !b.error) ? 'ok' : 'pending';
    }
    return (a.param || a.action || a.text) ? 'ok' : 'pending';
  }

  /* ===================== 耗时视图（spec 2026-09-28 §4 §5） =====================
   * 两个耗时的唯一权威：live step（payload / llm.raw）与落盘步骤（request /
   * llm.response）两种形状都吃 —— 与 actionsOf 同一套归一（耗时也只从 actionsOf
   * 的行动上读，不另开一条路径）。
   * 字段缺失一律 null，绝不返回 NaN 或 0：0 是「测到了，就是 0ms」，
   * 与「这条记录没测过」必须能分辨（老记录全靠这个区分）。
   * 「生成输入」的 LLM 调用不计入 Jev（那是生成模型，不是 Jev），单列 llmMs。 */
  function numOrNull(v) {
    return typeof v === 'number' && isFinite(v) ? v : null;
  }

  /* 系统休眠 / NTP 回拨会让 Date.now() 差值变负：钳 0，并让调用方知道发生过 */
  const SKEW_NOTE = '计时为负（系统时钟调整过？已按 0 显示）';

  function durationView(step) {
    const s = step || {};
    let jevMs = null, jevCalls = 0, jevMeasured = 0, recallBatches = 0, recallMeasured = 0;
    actionsOf(s).forEach((a) => {
      if (a.kind === 'llm') return;
      /* 工程直出的题没发出去（整份请求都没发）：没有调用、没有耗时 —— 不能靠
       * calls: 0 表达这件事，下面那行的缺省把 0 归一成 1 */
      if (a.local) return;
      /* 一个行动可能含多次调用（并行召回 = K 批），按 calls 记；缺省 1 */
      const calls = (a.calls != null && a.calls > 0) ? a.calls : 1;
      jevCalls += calls;
      if (a.kind === 'recall') recallBatches += calls;
      const m = numOrNull(a.ms);
      if (m == null) return;
      /* 测到几次算几次：召回那 K 批各自算一次（行动上的 measured 由 actionsOf 数好）。
       * 不这么记，2 批召回会被算成「1 次测到、1 次未计时」，悬停文案就撒谎了。 */
      const meas = (a.measured != null ? a.measured : 1);
      jevMeasured += meas;
      if (a.kind === 'recall') recallMeasured += meas;
      jevMs = (jevMs == null ? 0 : jevMs) + Math.max(0, m);
    });
    const rawStepMs = numOrNull(s.ms);
    const stepMs = rawStepMs == null ? null : Math.max(0, rawStepMs);
    const actMs = numOrNull(s.exec && s.exec.elapsedMs);
    const llmMs = numOrNull(s.llm && s.llm.ms);
    const skew = (rawStepMs != null && rawStepMs < 0) || (jevMs != null && jevMs < 0) ? SKEW_NOTE : null;
    /* 其它 = 步耗时 − Jev − 动作 − 生成输入；负数（补问耗时重叠等异常）钳 0 */
    let otherMs = null;
    if (stepMs != null) {
      otherMs = Math.max(0, stepMs - (jevMs || 0) - (actMs || 0) - (llmMs || 0));
    }
    return {
      stepMs: stepMs, jevMs: jevMs, actMs: actMs, llmMs: llmMs, otherMs: otherMs,
      jevCalls: jevCalls, jevMeasured: jevMeasured, recallBatches: recallBatches,
      recallMeasured: recallMeasured,
      jevPct: (stepMs != null && stepMs > 0 && jevMs != null) ? Math.round(jevMs / stepMs * 100) : null,
      skew: skew,
    };
  }

  /* 820ms / 9.9s / 63.9s / —（null 与 NaN 一律 '—'，不留 NaN 给界面） */
  function formatMs(ms) {
    const m = numOrNull(ms);
    if (m == null) return '—';
    return m < 1000 ? Math.round(m) + 'ms' : (m / 1000).toFixed(1) + 's';
  }

  /* 树上步骤行右侧的 Jev 文案。**压到纯数字宽度**：树宽 320px，右列每多占 10px 都是从左边
   * 两行钳制的标签里抢的 —— E2E S9.9 实测两轮：「该记录无耗时数据」(84px) 与「无耗时记录」
   * (55px) 都把标签挤到第三行被吃掉（客户端 117px 宽、内容 55px 高 vs 37px 可见）。
   * 所以缺数据就写 '—'（与总览表同一约定），跑动中写「计时中」，解释一律进 title。 */
  function stepDurationLine(step, opt) {
    const d = durationView(step);
    if (!d.jevCalls) return '';
    if (d.jevMs == null) return (opt && opt.live) ? '计时中' : '—';
    return 'Jev ' + formatMs(d.jevMs);
  }

  /* 树上的悬停说明：不占宽度，但信息不丢 */
  function stepDurationTitle(step) {
    const d = durationView(step);
    if (!d.jevCalls) return '';
    if (d.jevMs == null) return '本步有 ' + d.jevCalls + ' 次 Jev 调用，但这条记录没有耗时数据';
    const miss = d.jevCalls > d.jevMeasured ? '，其中 ' + (d.jevCalls - d.jevMeasured) + ' 次未计时' : '';
    /* 召回那 K 批是并发的：右列的数字里它们只算了最慢的一批。但**只有真测到才这么写**：
     * 中断 / 自动保存时批次对象已经建好、Promise.all 还没回来（ms 全是 null），
     * 那时说「按最慢一批计入」是凭空许诺，还与同一行的「K 次未计时」自相矛盾
     * （实测 data/runs 里就有这种 running 态记录） */
    const par = (d.recallBatches > 1 && d.recallMeasured > 0)
      ? '，召回 ' + d.recallBatches + ' 批并行、按最慢一批计入' : '';
    return '本步 ' + d.jevCalls + ' 次 Jev 调用（首轮/召回/补问）合计' + par + miss;
  }

  /* 单次调用的 token 用量：Jev 用 input_tokens/output_tokens，OpenAI 兼容接口
   * （「生成输入」那次）用 prompt_tokens/completion_tokens —— 两种都认。
   * 缺 → null。0 是合法值（缓存全命中时 input 可能为 0），不能当缺失。 */
  function usageOf(resp) {
    const u = (resp && resp.usage) || null;
    const pick = (a, b) => {
      const v = u ? (u[a] != null ? u[a] : u[b]) : null;
      return typeof v === 'number' && isFinite(v) ? v : null;
    };
    return { input: pick('input_tokens', 'prompt_tokens'), output: pick('output_tokens', 'completion_tokens') };
  }

  /* 15235 → '15,235'。不做 '15.2k' 那种缩写：这个数是拿来核成本的，要精确。 */
  function formatTokens(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /* 行动详情头部的一行：这次调用的耗时 + 输入/输出 token。
   * 缺什么省什么；全缺（调用失败、既没耗时也没响应）→ 空串，整行不出现。 */
  function actionMetricsLine(a) {
    const x = a || {};
    /* 工程直出（单选项，整份请求没发出去）：这一路根本没有调用，写「耗时 —」会让人
     * 以为测过。这里说的是「没发」这件事本身 —— 它比一个破折号有信息 */
    if (x.local) return '未调用 Jev（单选项 · 工程直出）';
    const u = usageOf(x.response);
    const parts = [];
    if (numOrNull(x.ms) != null) parts.push('耗时 ' + formatMs(x.ms));
    if (u.input != null) parts.push('输入 ' + formatTokens(u.input) + ' tokens');
    if (u.output != null) parts.push('输出 ' + formatTokens(u.output) + ' tokens');
    return parts.join(' · ');
  }

  /* 步骤合计：老记录混排时只累加测到的，并如实报「几步里有几步有数据」。
   * 界面不再显示（2026-09-28 收窄为只展示 Jev），但落盘的 meta.sumStepMs / tailMs 用它，
   * 导出后仍能核对整轮的时间构成。 */
  function sumStepMs(steps) {
    let sumMs = 0, measured = 0;
    (steps || []).forEach((s) => {
      const m = numOrNull(s && s.ms);
      if (m == null) return;
      sumMs += Math.max(0, m);
      measured += 1;
    });
    return { sumMs: sumMs, measured: measured, total: (steps || []).length };
  }

  /* 会话 id：r-MMDD-HHmm-xxxx（与 server 端 RUN_ID_RE 严格一致，防路径穿越校验同一份规则） */
  function newRunId(d) {
    const t = d || new Date();
    const p2 = (x) => String(x).padStart(2, '0');
    return 'r-' + p2(t.getMonth() + 1) + p2(t.getDate()) + '-' + p2(t.getHours()) + p2(t.getMinutes())
      + '-' + Math.random().toString(36).slice(2, 6);
  }

  /* 落盘/导出统一格式：{ meta, steps }。meta 永远排在 JSON 前部（插入序），
   * 截图 base64 都在 steps 里，列表接口只读索引、不碰这里。 */
  function buildRunRecord(o) {
    const steps = (o.steps || []).map((s) => ({
      n: s.n, label: s.label, pageInfo: s.pageInfo, snapshot: s.snapshot || null,
      refLabels: s.refLabels || null, decision: s.decision || null,
      request: s.payload || null, response: s.response || null, jevError: s.jevError || null,
      ms: numOrNull(s.ms), jevMs: numOrNull(s.jevMs),
      exec: s.exec || null, terminal: s.terminal || null, anno: s.anno || null, annoError: s.annoError || null,
      llm: s.llm ? {
        messages: s.llm.messages, response: s.llm.raw, text: s.llm.text,
        error: s.llm.error, ms: numOrNull(s.llm.ms),
      } : null,
      screenshot: s.screenshot || null, historyLine: s.historyLine || null,
      trim: s.trim || null, trimNote: s.trimNote || null,
      /* 本步快照裁剪的账（null = 没裁）。落盘的 snapshot 是**裁后**文本，
       * 这里记下裁了多少、保住几个 ref，导出后能看出「这步看到的是不是完整页面」 */
      snapshotTrim: s.snapshotTrim || null,
      /* 这一页依据的来源：'action' = 上一步动作顺带带回（省了一次快照调用）/ 'fresh' = 真取。
       * 落盘是为了导出后能核对「到底省没省、哪几步没省」——只写面板不落盘，
       * 重新载入会话就没了。 */
      snapshotFrom: s.snapshotFrom || null,
      /* 本步与上一步看到的快照之间的差分（见 snapshot-diff.js）与「追自己改过的元素」标记。
       * 落盘理由是排障：导出后能独立核对「这一步模型到底看到了什么变化」，
       * 只写面板不落盘的话，重新载入会话就没了 —— 而那正是最需要回看的一步。 */
      diff: s.diff || null,
      chasedOwnChange: Boolean(s.chasedOwnChange),
      chasedLine: s.chasedLine == null ? null : s.chasedLine,
      chasedNote: s.chasedNote || null,
      /* 并行召回：K 批请求/响应逐条落盘（导出后能独立核对「这一步到底发了几次」） */
      recall: s.recall ? {
        meta: s.recall.meta || null,
        failed: s.recall.failed || 0,
        note: s.recall.note || null,
        merged: s.recall.merged || null,
        /* 召回排在首轮之后还是之前。**必须落盘**：老记录的判据是「首轮带不带参数题」，
         * 而新流程首轮就带「参数」（前 size 个）—— 不存这个标记，会话一重新载入
         * 就会按老判据把并行召回排到首轮前面（时间线倒放，实测过） */
        afterMain: (s.recall.afterMain != null) ? Boolean(s.recall.afterMain) : null,
        /* 最终决策实际拿到的候选键（≤250 个）：落盘后能独立核对「这一步给它看了哪些元素」 */
        candidates: Object.keys(s.recall.criteria || {}),
        batches: (s.recall.batches || []).map((r) => ({
          batch: r.batch, size: r.size,
          /* K 批发的是与本步首轮**同一份** state（runRecall 里就是同一个对象）：
           * 落盘不再复制 K 份，只留 questions + sharedState 标记，读回时把
           * step.request.state 挂回去。不这么做，一步 6 次调用各存一份全量快照，
           * 记录会从 ~300KB 涨到 1.6MB（实测），每次节流保存都在搬这份重复数据 */
          request: r.payload ? { model: r.payload.model, questions: r.payload.questions } : null,
          sharedState: Boolean(r.payload && r.payload.state),
          response: r.response, error: r.error || null, recalled: r.recalled || [], ms: numOrNull(r.ms),
          /* 单候选批是工程直出的（没发出去）：落盘要能看出来，否则重新载入会话时
           * 它会被当成一次真调用（面板会说这轮问了 Jev 而 actual 没有） */
          local: Boolean(r.local), localQuestions: r.localQuestions || null,
        })),
      } : null,
      followUps: (s.followUps || []).map((r) => ({
        kind: r.kind || 'param', request: r.payload, response: r.response,
        batch: r.batch != null ? r.batch : null, param: r.param || null, action: r.action || null,
        /* 「参数决策」行动标题要报候选数（「候选 101 个」）。这一项以前没落盘，
         * 于是**会话一重新载入就变成「候选 ? 个」**——落盘与面板对不上的老毛病 */
        candidates: r.candidates != null ? r.candidates : null,
        text: r.text || null, forAction: r.forAction || null, from: r.from || null,
        role: r.role || null, ref: r.ref || null, why: r.why || null, error: r.error || null,
        ms: numOrNull(r.ms),
        /* 单选项补问整份请求都没发（payload 为 null）：与召回批同一口径，落盘要能看出来 */
        local: Boolean(r.local), localQuestions: r.localQuestions || null,
      })),
    }));
    const c = o.runCfg || {};
    /* Jev 调用次数要和新开的并行召回一起对账：漏掉召回批次，
     * 「5 次调用」会被记成 1 次，running 会话的「请求数」也就对不上 mock 侧计数。
     * 工程直出的那几处**没有发出去**，一律不算 —— 否则对账表会虚报调用数。 */
    const jevCalls = steps.reduce((a, s) =>
      a + (s.request && !s.local ? 1 : 0)
        + (s.followUps || []).filter((r) => !r.local).length
        + ((s.recall && s.recall.batches) || []).filter((b) => !b.local).length, 0);
    const llmCalls = steps.filter((s) => s.llm).length;
    /* 对账四件套：wallMs 由调用方给（运行中=当下，结束时=最终值）；tailMs 倒推，
     * 所以「准备 + Σ步 + 收尾 = 墙钟」在记录里恒成立，导出后能独立核对。
     * 缺 timing / 缺 wallMs → 三项都为 null：老记录与「进行中首存」算不出来就不画。 */
    const t = o.timing || {};
    const sumMs = sumStepMs(steps).sumMs;
    const prepMs = numOrNull(t.prepMs);
    const wallMs = numOrNull(t.wallMs);
    const tailMs = (wallMs == null || prepMs == null) ? null : Math.max(0, wallMs - prepMs - sumMs);
    return {
      meta: {
        id: o.id, goal: c.goal, startUrl: c.url,
        browser: c.browserUsed || c.browser, mode: c.mode || 'isolated', cdp: c.cdp || null,
        /* 这轮实际用的驱动后端（inproc / cli）。**必须落盘**：两条后端的每步机械开销
         * 差一个量级（实测 ~1.0s vs ~8.4s），不记下来，「这轮为什么慢」就只能靠猜；
         * 进程内起不来退回 CLI 时这一项记的是**实际生效**的那条（c.backendUsed）。 */
        backend: c.backendUsed || c.backend || null,
        window: c.window || null,
        variables: c.variables || [], maxSteps: c.maxSteps,
        screenshotOn: !!c.screenshotOn, paramTrim: c.paramTrim || null,
      snapshotTrim: c.snapshotTrim || null,
        jevModel: o.jevModel, llmModel: o.llmModel,
        startedAt: o.startedAt, endedAt: o.endedAt || null,
        endState: o.endState || 'running', endReason: o.endReason || null,
        stepCount: steps.length, jevCalls, llmCalls,
        prepMs: prepMs, sumStepMs: sumMs, tailMs: tailMs, wallMs: wallMs,
        exportedAt: o.exportedAt || null,
      },
      steps,
    };
  }

  var AutoCore = {
    AUTO_TOOLS: AUTO_TOOLS,
    TERMINAL_TOOLS: TERMINAL_TOOLS,
    REF_MORE: REF_MORE,
    TEXT_NONE: TEXT_NONE,
    SCORE_LEVELS: SCORE_LEVELS,
    needText: needText,
    needRef: needRef,
    refCriteria: refCriteria,
    paramCriteria: paramCriteria,
    ALGORITHMS: ALGORITHMS,
    recallPlan: recallPlan,
    shouldRecall: shouldRecall,
    buildRecallQuestions: buildRecallQuestions,
    buildRecallPickQuestions: buildRecallPickQuestions,
    recallFallback: recallFallback,
    dropRefMore: dropRefMore,
    mergeRecall: mergeRecall,
    recallSeeds: recallSeeds,
    answerOf: Recall.answerOf,
    hydrateRecord: hydrateRecord,
    buildParamFollowUp: buildParamFollowUp,
    isRefMore: isRefMore,
    parseParamAnswer: parseParamAnswer,
    normalizeParam: normalizeParam,
    normalizeTrim: normalizeTrim,
    paramInstructions: paramInstructions,
    refRoles: refRoles,
    checkActionRole: checkActionRole,
    selectOptionNames: selectOptionNames,
    checkSelectOption: checkSelectOption,
    buildActionFollowUp: buildActionFollowUp,
    parseActionAnswer: parseActionAnswer,
    COMMON_KEY_NAMES: COMMON_KEY_NAMES,
    KEY_HINTS: KEY_HINTS,
    buildTextFollowUp: buildTextFollowUp,
    parseTextAnswer: parseTextAnswer,
    DIALOG_SNAPSHOT_NOTE: DIALOG_SNAPSHOT_NOTE,
    isModalSnapshotError: isModalSnapshotError,
    makeSnapshotCarrier: makeSnapshotCarrier,
    buildDialogQuestions: buildDialogQuestions,
    buildState: buildState,
    detectStall: detectStall,
    decisionSig: decisionSig,
    SELF_CHANGED: SELF_CHANGED,
    isOpaqueAction: isOpaqueAction,
    SCROLL_KEYS: SCROLL_KEYS,
    resolveText: resolveText,
    STALL_MIN: STALL_MIN,
    compressHistory: compressHistory,
    buildQuestions: buildQuestions,
    splitSingleChoice: splitSingleChoice,
    parseDecision: parseDecision,
    planExecution: planExecution,
    shouldTerminate: shouldTerminate,
    buildLlmMessages: buildLlmMessages,
    extractRefContext: extractRefContext,
    sanitizeLlmText: sanitizeLlmText,
    describeDecision: describeDecision,
    stripRefPrefix: stripRefPrefix,
    formatHistoryStep: formatHistoryStep,
    briefError: briefError,
    isRefParam: isRefParam,
    actionsOf: actionsOf,
    actionStatus: actionStatus,
    durationView: durationView,
    formatMs: formatMs,
    stepDurationLine: stepDurationLine,
    stepDurationTitle: stepDurationTitle,
    usageOf: usageOf,
    formatTokens: formatTokens,
    actionMetricsLine: actionMetricsLine,
    sumStepMs: sumStepMs,
    newRunId: newRunId,
    buildRunRecord: buildRunRecord
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = AutoCore;
  if (typeof window !== 'undefined') window.AutoCore = AutoCore;
})();
