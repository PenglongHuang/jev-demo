/* ===================== Auto 浏览器模式 · 纯逻辑核心（无 DOM） =====================
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

  /* ---------------- 动作集（设计 §7：27 个浏览器操作 + 2 个工程动作） ----------------
   * 描述带分组前缀，帮助 Jev 在 31 个候选里区分用途。 */
  var AUTO_TOOLS = {
    /* 交互（13） */
    'click': '【交互】点击某个元素（需配合「参数」选定 ref）',
    'dblclick': '【交互】双击某个元素',
    'fill': '【交互】清空并向输入框/文本域填入文本（文本取自「文本」变量）',
    'type': '【交互】在元素上逐字输入文本（文本取自「文本」变量）',
    'select': '【交互】在下拉框中选择选项（文本 = 选项名）',
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

  function buildQuestions(ctx) {
    var snapshot = ctx.snapshot || '';
    var variables = (ctx.variables || []).filter(function (v) { return v && v.name; });

    var textCriteria = {};
    variables.forEach(function (v) { textCriteria[v.name] = '取值：' + v.value; });
    textCriteria[TEXT_NONE] = '本动作不需要输入文本（点击 / 勾选 / 导航回退 / 生成输入等）';

    return {
      '动作': {
        type: 'choice',
        instructions: '根据页面快照与已完成步骤，下一步应执行哪个动作？若目标已达成选「任务已完成」；当前页面无法完成任务选「放弃」。',
        criteria: Object.assign({}, AUTO_TOOLS, TERMINAL_TOOLS)
      },
      '参数': {
        type: 'choice',
        instructions: '该动作应作用于快照中的哪个元素？选项由当前快照自动解析，【可交互】为可操作元素。不需要元素的动作（press / goto / 无操作等）选「无需元素」。',
        criteria: refCriteria(snapshot)
      },
      '文本': {
        type: 'choice',
        instructions: '需要输入文本的动作（fill / type / select / press / goto / upload 等）应使用哪个变量的值？不需要文本的动作选「无」。',
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
    return {
      action: action,
      param: (a['参数'] && a['参数'].choice) || REF_NONE,
      text: (a['文本'] && a['文本'].choice) || TEXT_NONE,
      unfinished: Number(a['未完成'] && a['未完成'].score || 0) / (SCORE_LEVELS - 1)
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
      if (text == null) throw new Error('动作 ' + action + ' 需要文本，但 Jev 在「文本」题选择了「无」');
    }
    return { kind: 'act', op: action, ref: ref, text: text };
  }

  /* ---------------- 终止判断（设计 §11） ---------------- */
  function shouldTerminate(s) {
    if (s.aborted) return { done: false, reason: '用户中止' };
    var h = s.unfinishedHistory || [];
    if (h.length >= 2 && h[h.length - 1] < 0.2 && h[h.length - 2] < 0.2) {
      return { done: true, reason: '任务完成（Jev 连续两轮判定未完成度 < 0.2）' };
    }
    if (s.steps >= s.maxSteps) return { done: false, reason: '达到步数上限（' + s.maxSteps + '）' };
    if (s.consecutiveFails >= 3) return { done: false, reason: '连续 3 步执行失败' };
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
    TEXT_NONE: TEXT_NONE,
    SCORE_LEVELS: SCORE_LEVELS,
    needText: needText,
    needRef: needRef,
    refCriteria: refCriteria,
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
