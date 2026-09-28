/* ===================== playwright-jev-agent · 纯逻辑核心（无 DOM） =====================
 * 设计文档 §6/§7/§8/§11：state 组装、3 道固定问题组装与按需补问（参数批次 / 动作 / 文本）、
 * 决策解析、执行规划、终止判断、历史压缩、LLM prompt 组装与文本清洗。
 * 浏览器：以全局 AutoCore 暴露（auto.js 使用）；Node：module.exports（node:test 使用）。
 * ref 解析复用 util.js（同一实现保证浏览器/测试行为一致）。
 */
(function () {
  'use strict';

  var U = (typeof window !== 'undefined')
    ? { parseSnapshotRefs: window.parseSnapshotRefs, buildRefCriteria: window.buildRefCriteria }
    : require('./util.js');
  var Funnel = (typeof window !== 'undefined')
    ? window.RefFunnel
    : require('./ref-funnel.js');

  /* ---------------- 动作集（设计 §7：19 个浏览器操作 + 2 个工程动作） ----------------
   * 描述带分组前缀，帮助 Jev 在 23 个候选里区分用途。
   * 裁掉的 8 个（dblclick/drop/keydown/keyup/mousemove/mousedown/mouseup/mousewheel）：
   * a11y 快照驱动下坐标鼠标类不可达（没有 x,y 概念），修饰键与拖拽在本项目场景里无入口，
   * 纯属干扰项（实测事故里模型在 31 候选里摇摆）。 */
  var AUTO_TOOLS = {
    /* 交互（9） */
    /* click 的描述里必须写明「选中 / 点开」也归它 —— 中文语境下「选中这一行 / 选中这一笔」
     * 是最高频的说法，而动作表里恰好有个叫 select 的选项，不划清归属它就会被抢走。 */
    'click': '【交互】点击按钮 / 链接 / 表格行 / 任意元素（要「选中」「点开」某个元素都用它；需配合「参数」选定 ref）',
    'fill': '【交互】清空并向输入框/文本域填入文本（文本经动作确定后的「文本」补问选定）',
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
    /* 工程（2） */
    '生成输入': '【工程】调用生成模型（LLM）为「参数」指定的输入框生成合适文本并填入（搜索词、邮件主题、正文等）',
    '无操作': '【工程】不执行任何操作，等待页面自身变化（也计一步）'
  };

  /* 终止态（与动作同题呈现，命中即结束循环） */
  var TERMINAL_TOOLS = {
    '任务已完成': '目标已达成，停止循环',
    '放弃': '当前页面无法完成任务，停止并报告'
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
    return {
      '任务目标': String(ctx.goal || ''),
      '当前页面': { 'url': String(ctx.url || ''), '标题': String(ctx.title || '') },
      '标签页': formatTabs(tabs),
      '已完成步骤': compressHistory(ctx.history || []),
      '上一步结果': ctx.lastResult || '（这是第一步，之前尚无任何操作）',
      '页面快照': String(ctx.snapshot || '')
    };
  }

  /* ---------------- 问题组装（固定 3 道，动态值全部工程注入） ---------------- */
  function refCriteria(snapshot) {
    return U.buildRefCriteria(snapshot);
  }

  var REF_MORE = Funnel.REF_MORE;

  /* 裁剪配置缺省 = 默认开着（与界面默认一致；关掉必须显式传 on:false） */
  function normalizeTrim(paramTrim) {
    var t = paramTrim || {};
    return {
      on: t.on !== false,
      limit: parseInt(t.limit, 10) || Funnel.DEFAULT_LIMIT,
      maxTranches: (t.maxTranches == null) ? 3 : Math.max(0, parseInt(t.maxTranches, 10) || 0)
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

  function paramInstructions(param) {
    var meta = (param && param.meta) || {};
    var criteria = (param && param.criteria) || {};
    var head = '该动作应作用于快照中的哪个元素？';
    var tail = '若你决定的动作不作用于任何元素（press / goto / 前进后退 / 刷新 / 标签页 / 弹窗 / 无操作 / 终止），'
      + '「参数」不会被使用，任选一项即可。';
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
          + '滚动页面 → press（键名在动作确定后的「文本」补问里选，常用 PageDown / PageUp）；仅等待页面变化 → 无操作。'
          + '若目标已达成选「任务已完成」；当前页面无法完成任务选「放弃」。',
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
    if (action === '无操作') return { kind: 'noop' };

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
    if (TERMINAL_TOOLS[action] || action === '无操作') return action;
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

  /* 长行折叠中段：根因短语固定在行尾，按长度从头截会把根因切掉（与 browser-driver.js
   * 里的同名 helper 同源；两端是不同运行时，各留一份 4 行实现比让驱动依赖 public/js 便宜） */
  function clipMiddle(line, max) {
    var s = String(line);
    if (s.length <= max) return s;
    var tail = Math.floor(max / 2);
    return s.slice(0, max - tail - 1) + '…' + s.slice(-tail);
  }

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

  function formatHistoryStep(n, label, ok, err) {
    return n + '. ' + label + (ok ? '成功' : '失败：' + briefError(err));
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
    const mainPayload = s.payload || s.request || null;
    if (mainPayload) {
      const n = Object.keys(mainPayload.questions || {}).length;
      const dialog = n === 1 && mainPayload.questions['动作'] && !mainPayload.questions['参数'];
      out.push({
        kind: 'main', title: dialog ? 'Jev 弹窗步 · 1 题' : 'Jev 首轮 · ' + n + ' 题',
        payload: mainPayload, response: s.response || null, error: s.jevError || null,
        ms: numOrNull(s.jevMs),
      });
    }
    (s.followUps || []).forEach((r) => {
      const k = r.kind || 'param';
      const p = r.payload || r.request || null;
      /* 与首轮同一形状：种类 · 题数 · 上下文。补问按构造恒为单题，题数仍从
       * payload 数出来 —— 老记录可能没有 payload，那时退回 1。 */
      const qp = (p && p.questions) || null;
      const n = qp ? Object.keys(qp).length : 1;
      const titles = {
        param: '参数补问 · ' + n + ' 题 · 第 ' + r.batch + ' 批',
        action: '动作补问 · ' + n + ' 题 · 「' + (r.from || '') + '」与角色 ' + (r.role || '') + ' 冲突',
        text: '文本补问 · ' + n + ' 题 · ' + (r.forAction || ''),
      };
      out.push({
        kind: k, title: titles[k] || '补问',
        payload: p, response: r.response || null, error: r.error || null,
        batch: r.batch != null ? r.batch : null, param: r.param || null, action: r.action || null,
        text: r.text || null, forAction: r.forAction || null, from: r.from || null,
        role: r.role || null, ref: r.ref || null, why: r.why || null, ms: numOrNull(r.ms),
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
    let jevMs = null, jevCalls = 0, jevMeasured = 0;
    actionsOf(s).forEach((a) => {
      if (a.kind === 'llm') return;
      jevCalls += 1;
      const m = numOrNull(a.ms);
      if (m == null) return;
      jevMeasured += 1;
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
      jevCalls: jevCalls, jevMeasured: jevMeasured,
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

  /* 树上步骤行的第二行文案。空串 = 这行不该出现（一个 Jev 调用都没有）。
   * opt.live：这一步正在跑 —— Jev 还没返回时说「该记录无耗时数据」是错的（记录正在写）。 */
  function stepDurationLine(step, opt) {
    const d = durationView(step);
    if (!d.jevCalls) return '';
    if (d.jevMs == null) return (opt && opt.live) ? 'Jev 计时中…' : '该记录无耗时数据';
    const miss = d.jevCalls > d.jevMeasured ? '（' + (d.jevCalls - d.jevMeasured) + ' 次未计时）' : '';
    const pct = d.jevPct != null ? ' · 占 ' + d.jevPct + '%' : '';
    return 'Jev ' + formatMs(d.jevMs) + ' · ' + d.jevCalls + ' 次调用' + miss + pct;
  }

  /* 构成条的四段（颜色沿用界面既有 token：Jev 紫 / LLM 绿 / 动作 靛 / 其它 灰）。
   * 比例四舍五入后把差额补进最大的一段，保证和恰好 100 —— 否则条尾会留一条缝。 */
  const SEG_COLORS = { jev: '#7c3aed', llm: '#0d9268', act: '#4f46e5', other: '#cbd0da' };

  function breakdownSegs(d) {
    if (!d || d.stepMs == null || d.stepMs <= 0) return null;
    const parts = [
      { key: 'jev', ms: d.jevMs || 0 }, { key: 'llm', ms: d.llmMs || 0 },
      { key: 'act', ms: d.actMs || 0 }, { key: 'other', ms: d.otherMs || 0 },
    ];
    const total = parts.reduce((a, p) => a + p.ms, 0);
    if (total <= 0) return null;
    const segs = [];
    parts.forEach((p) => {
      if (p.ms <= 0) return;
      segs.push({ key: p.key, n: Math.round(p.ms / total * 100), color: SEG_COLORS[p.key], ms: p.ms });
    });
    if (!segs.length) return null;
    const diff = 100 - segs.reduce((a, s) => a + s.n, 0);
    if (diff) segs[segs.reduce((best, s, i, arr) => (s.n > arr[best].n ? i : best), 0)].n += diff;
    return segs;
  }

  /* 步骤合计：老记录混排时只累加测到的，并如实报「几步里有几步有数据」 */
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

  /* 对账：准备 + Σ步 + 收尾 与墙钟之差。容差 1s（取整与落盘时刻差都在这之内）。
   * 任一分量缺失 → null（老记录算不出来就不画，不显示 0 假装平账）。 */
  function reconcile(o) {
    const wallMs = numOrNull(o && o.wallMs);
    const prepMs = numOrNull(o && o.prepMs);
    const sumMs = numOrNull(o && o.sumStepMs);
    const tailMs = numOrNull(o && o.tailMs);
    if (wallMs == null || prepMs == null || sumMs == null || tailMs == null) return null;
    const calcMs = prepMs + sumMs + tailMs;
    const deltaMs = wallMs - calcMs;
    return {
      prepMs: prepMs, sumStepMs: sumMs, tailMs: tailMs, wallMs: wallMs,
      calcMs: calcMs, deltaMs: deltaMs, ok: Math.abs(deltaMs) <= 1000,
    };
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
      exec: s.exec || null, terminal: s.terminal || null, anno: s.anno || null, annoError: s.annoError || null,
      llm: s.llm ? { messages: s.llm.messages, response: s.llm.raw, text: s.llm.text, error: s.llm.error } : null,
      screenshot: s.screenshot || null, historyLine: s.historyLine || null,
      trim: s.trim || null, trimNote: s.trimNote || null,
      followUps: (s.followUps || []).map((r) => ({
        kind: r.kind || 'param', request: r.payload, response: r.response,
        batch: r.batch != null ? r.batch : null, param: r.param || null, action: r.action || null,
        text: r.text || null, forAction: r.forAction || null, from: r.from || null,
        role: r.role || null, ref: r.ref || null, why: r.why || null, error: r.error || null,
      })),
    }));
    const c = o.runCfg || {};
    const jevCalls = steps.reduce((a, s) => a + (s.request ? 1 : 0) + (s.followUps || []).length, 0);
    const llmCalls = steps.filter((s) => s.llm).length;
    return {
      meta: {
        id: o.id, goal: c.goal, startUrl: c.url,
        browser: c.browserUsed || c.browser, mode: c.mode || 'isolated', cdp: c.cdp || null,
        window: c.window || null,
        variables: c.variables || [], maxSteps: c.maxSteps,
        screenshotOn: !!c.screenshotOn, paramTrim: c.paramTrim || null,
        jevModel: o.jevModel, llmModel: o.llmModel,
        startedAt: o.startedAt, endedAt: o.endedAt || null,
        endState: o.endState || 'running', endReason: o.endReason || null,
        stepCount: steps.length, jevCalls, llmCalls, exportedAt: o.exportedAt || null,
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
    buildDialogQuestions: buildDialogQuestions,
    buildState: buildState,
    compressHistory: compressHistory,
    buildQuestions: buildQuestions,
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
    breakdownSegs: breakdownSegs,
    sumStepMs: sumStepMs,
    reconcile: reconcile,
    newRunId: newRunId,
    buildRunRecord: buildRunRecord
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = AutoCore;
  if (typeof window !== 'undefined') window.AutoCore = AutoCore;
})();
