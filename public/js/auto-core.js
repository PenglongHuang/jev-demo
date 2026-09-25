/* ===================== playwright-jev-agent · 纯逻辑核心（无 DOM） =====================
 * 设计文档 §6/§7/§8/§11：state 组装、4 道固定问题组装、决策解析、执行规划、
 * 终止判断、历史压缩、LLM prompt 组装与文本清洗。
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

  /* ---------------- 动作集（设计 §7：27 个浏览器操作 + 2 个工程动作） ----------------
   * 描述带分组前缀，帮助 Jev 在 31 个候选里区分用途。 */
  var AUTO_TOOLS = {
    /* 交互（13） */
    /* click 的描述里必须写明「选中 / 点开」也归它 —— 中文语境下「选中这一行 / 选中这一笔」
     * 是最高频的说法，而动作表里恰好有个叫 select 的选项，不划清归属它就会被抢走。 */
    'click': '【交互】点击按钮 / 链接 / 表格行 / 任意元素（要「选中」「点开」某个元素都用它；需配合「参数」选定 ref）',
    'dblclick': '【交互】双击某个元素',
    'fill': '【交互】清空并向输入框/文本域填入文本（文本取自「文本」变量）',
    'type': '【交互】在元素上逐字输入文本（文本取自「文本」变量）',
    /* select 只能作用于原生 <select>：快照里它是 combobox，它下面的 option 没有 ref，
     * 而 driver 打到 playwright 上时非 <select> 会硬抛 "Element is not a <select> element"。
     * 实测事故：模型对 button "发货" 选了 select，白烧一步才自纠 —— 所以描述写成排他式。 */
    'select': '【交互】仅用于原生下拉框（快照里是 combobox "<名字>"，它下面的 option 没有 ref）：在其中选定某个选项（文本 = 选项名）。按钮 / 链接 / 表格行一律用 click，不要用 select',
    'check': '【交互】勾选复选框 / 单选框',
    'uncheck': '【交互】取消勾选',
    'hover': '【交互】鼠标悬停（展开菜单 / 触发浮层）',
    'drop': '【交互】把拖拽中的内容放到某个元素上',
    'upload': '【交互】上传本地文件（文本 = 文件路径）',
    'press': '【交互】按下按键（文本 = 键名：Enter、Escape、ArrowDown…）',
    'keydown': '【交互】按住修饰键（文本 = Shift / Control / Alt）',
    'keyup': '【交互】松开之前按住的修饰键',
    /* 鼠标（4） */
    'mousemove': '【鼠标】移动鼠标（文本 = "x,y" 坐标）',
    'mousedown': '【鼠标】在当前位置按下鼠标',
    'mouseup': '【鼠标】在当前位置松开鼠标',
    'mousewheel': '【鼠标】滚动滚轮（文本 = "横向,纵向" 增量，如 0,-300 向下滚）',
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

  var REF_NONE = '无需元素';
  var TEXT_NONE = '无';
  var SCORE_LEVELS = 5;

  var TEXT_ACTIONS = { fill: 1, type: 1, select: 1, press: 1, keydown: 1, keyup: 1, goto: 1, upload: 1, 'tab-select': 1, 'tab-close': 1, 'dialog-accept': 1, mousemove: 1, mousewheel: 1, 'tab-new': 1 };
  /* 文本可省的动作（与 browser-driver 白名单的 optional 语义一致）：
   * tab-close 缺省关当前页 / tab-new 可不开 URL / dialog-accept 可不带 prompt 输入 */
  var TEXT_OPTIONAL_ACTIONS = { 'tab-close': 1, 'tab-new': 1, 'dialog-accept': 1 };
  var REF_ACTIONS = { click: 1, dblclick: 1, fill: 1, type: 1, select: 1, check: 1, uncheck: 1, hover: 1, drop: 1, '生成输入': 1 };

  function needText(action) { return Boolean(TEXT_ACTIONS[action]); }
  function needRef(action) { return Boolean(REF_ACTIONS[action]); }

  /* ---------------- state 组装（设计 §6：确定性模板，快照全量透传） ---------------- */
  function compressHistory(entries, keep) {
    var k = keep || 8;
    var list = (entries || []).slice();
    if (list.length <= k) return list;
    return ['（更早的 ' + (list.length - k) + ' 步已省略）'].concat(list.slice(-k));
  }

  function buildState(ctx) {
    return {
      '任务目标': String(ctx.goal || ''),
      '当前页面': { 'url': String(ctx.url || ''), '标题': String(ctx.title || '') },
      '已完成步骤': compressHistory(ctx.history || []),
      '上一步结果': ctx.lastResult || '（这是第一步，之前尚无任何操作）',
      '页面快照': String(ctx.snapshot || '')
    };
  }

  /* ---------------- 问题组装（固定 4 道，动态值全部工程注入） ---------------- */
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
    var refs = U.parseSnapshotRefs(o.snapshot);

    if (!trim.on) {
      return {
        criteria: refCriteria(o.snapshot),
        meta: {
          enabled: false, trimmed: false, totalRefs: refs.length,
          limit: trim.limit, batch: batch, maxTranches: trim.maxTranches
        }
      };
    }
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
    var tail = '不需要元素的动作（press / goto / 无操作等）选「无需元素」。';
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

  /* 第二批起的「参数」补问：只问这一题（动作已定，不重发 4 题以免连带动摇动作决策） */
  function buildParamFollowUp(ctx) {
    var o = ctx || {};
    var meta = (o.paramCriteria && o.paramCriteria.meta) || {};
    var limit = parseInt(o.limit, 10) || meta.limit || Funnel.DEFAULT_LIMIT;
    var batch = Math.max(2, parseInt(o.batch, 10) || 2);
    var total = o.totalRefs || meta.totalRefs || 0;
    var from = (batch - 1) * limit + 1;
    var to = Math.min(batch * limit, total);
    var scope = '第 ' + from + '–' + to + ' 个，全页共 ' + total + ' 个';
    var instructions = '已确定的动作是「' + o.action + '」。本批是第 ' + batch + ' 批候选（' + scope + '）。'
      + (o.paramCriteria && o.paramCriteria.criteria && o.paramCriteria.criteria[REF_MORE]
        ? '若目标元素仍不在本批中，请继续选「' + REF_MORE + '」展开下一批。'
        : '这是最后一批候选，请在本批内做出选择。')
      + '不需要元素的动作选「无需元素」。';
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

  /* 「其他」配到不需要元素的动作上时，归一为「无需元素」并给一句说明（不报错、不中断） */
  function normalizeParam(decision) {
    var param = decision && decision.param;
    if (!isRefMore(param)) return { param: param, note: '' };
    if (needRef(decision.action)) return { param: param, note: '' };
    return { param: REF_NONE, note: '动作 ' + decision.action + ' 不需要元素，「' + REF_MORE + '」按「无需元素」处理' };
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
    if (!ref || ref === REF_NONE) return { conflict: false };
    var role = (roles || {})[ref];
    if (!role || !roleBlocks(action, role)) return { conflict: false };
    return {
      conflict: true, ref: ref, role: role, action: action, why: ACTION_ROLE_WHY[action],
      compatible: Object.keys(AUTO_TOOLS).filter(function (k) { return !roleBlocks(k, role); })
    };
  }

  /* 该角色的常规动词：补问时顺带指出来。fill / type / 生成输入 判不了可编辑性、
   * 拦不住（contenteditable 的 div 在快照里是 generic），只能靠这句把模型导向对的动作。 */
  var ROLE_VERB_HINT = {
    'button': '按钮的常规动作是 click（其次 dblclick / hover）',
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

  function buildQuestions(ctx) {
    var snapshot = ctx.snapshot || '';
    var variables = (ctx.variables || []).filter(function (v) { return v && v.name; });
    var param = ctx.param || paramCriteria(ctx);

    var textCriteria = {};
    variables.forEach(function (v) { textCriteria[v.name] = '取值：' + v.value; });
    textCriteria[TEXT_NONE] = '本动作不需要输入文本（点击 / 勾选 / 导航回退 / 生成输入等）';

    return {
      '动作': {
        type: 'choice',
        /* 角色 → 动词的对照必须写在这里：动作题与「参数」同请求同时作答，动作的选择本身
         * 拿不到任何元素信息，只能靠这条对照把「目标元素是 button 就用 click」说死。
         * 措辞直接（官方实测：问得越委婉，一致率越低）。 */
        instructions: '根据页面快照与已完成步骤，下一步应执行哪个动作？'
          + '先按目标元素的角色挑动词（选项描述里已标出角色，如 button "发货"、combobox "订单状态"）：'
          + '按钮 / 链接 / 表格行 / 任意可点元素 → click；输入框 / 文本域 → fill；'
          + '复选框 / 单选框 → check / uncheck；原生下拉框（combobox）→ select；文件 → upload；'
          + '仅滚动 / 仅等待 → 无操作。'
          + '若目标已达成选「任务已完成」；当前页面无法完成任务选「放弃」。',
        criteria: Object.assign({}, AUTO_TOOLS, TERMINAL_TOOLS)
      },
      '参数': {
        type: 'choice',
        instructions: paramInstructions(param),
        criteria: param.criteria || refCriteria(snapshot)
      },
      '文本': {
        type: 'choice',
        /* 举例里刻意不写 select：它会与「动作」题的 select 选项呼应，二次抬高那个词在模型眼里的显著度 */
        instructions: '需要输入文本的动作（fill / type / 下拉框选择 / press / goto / upload 等）应使用哪个变量的值？不需要文本的动作选「无」。',
        criteria: textCriteria
      },
      '未完成': {
        type: 'score',
        instructions: '对「任务目标的未完成程度」打分：0 = 已完成，1 = 尚未开始。以页面快照当前呈现的状态为准。',
        criteria: [
          '0 · 已完成：目标结果已体现在页面上',
          '0.25 · 基本完成：只剩无关紧要的收尾',
          '0.5 · 进行中：关键步骤完成了一半',
          '0.75 · 刚开始：已定位目标但尚未操作',
          '1 · 未开始或远未达成'
        ]
      }
    };
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
      param: (a['参数'] && a['参数'].choice) || REF_NONE,
      text: (a['文本'] && a['文本'].choice) || TEXT_NONE,
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
      if (decision.param === REF_NONE) throw new Error('生成输入需要指定目标输入框的 ref，但 Jev 选择了「无需元素」');
      return { kind: 'llm', ref: decision.param };
    }

    var ref = null;
    if (needRef(action)) {
      if (decision.param === REF_NONE) throw new Error('动作 ' + action + ' 需要作用于具体元素，但 Jev 选择了「无需元素」');
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
  function shortRefLabel(refLabel) {
    var s = String(refLabel || '').replace(/^【[^】]*】\s*/, '');
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
    if (REF_ACTIONS[action] && decision.param !== REF_NONE) {
      out += '【' + decision.param + ' · ' + shortRefLabel(refLabels[decision.param]) + '】';
    }
    var text = resolveText(decision.text, variables);
    if (TEXT_ACTIONS[action] && text != null) out += ' "' + text + '"';
    return out;
  }

  function formatHistoryStep(n, label, ok, err) {
    return n + '. ' + label + (ok ? '成功' : '失败：' + String(err || '').slice(0, 80));
  }

  var AutoCore = {
    AUTO_TOOLS: AUTO_TOOLS,
    TERMINAL_TOOLS: TERMINAL_TOOLS,
    REF_NONE: REF_NONE,
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
    buildActionFollowUp: buildActionFollowUp,
    parseActionAnswer: parseActionAnswer,
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
    formatHistoryStep: formatHistoryStep
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = AutoCore;
  if (typeof window !== 'undefined') window.AutoCore = AutoCore;
})();
