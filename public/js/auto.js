/* ===================== playwright-jev-agent · 前端循环 =====================
 * 设计文档 §2/§9/§10：循环在本页面 JS 中运行；server 只 spawn playwright-cli
 * 和纯透传代理。前端是 state/问题的唯一构造者 —— 步骤卡展示的请求体与真实
 * 发出的 payload 是同一个对象（可见性硬原则）。
 *
 * 展示层：步骤以轮播卡片呈现（‹ › 切换 / ←→ 键 / 时间线跳转 / 跟随最新），
 * 卡片内概率分布、输入 state、各道问题（首轮 3 道 + 按需补问）均为结构化渲染
 * （非 JSON 倾倒），原始报文折叠保留可复制。
 *
 * 依赖：util.js（escapeHtml/pct/toast/relaxedStringify）、auto-core.js（AutoCore）、app.js（Config）
 */
const Auto = (() => {
  'use strict';

  /* ---------- DOM ---------- */
  const els = {
    panel: document.getElementById('autoPanel'),
    pill: document.getElementById('browserPill'),
    installHint: document.getElementById('autoInstallHint'),
    goal: document.getElementById('autoGoal'),
    url: document.getElementById('autoUrl'),
    scenarios: document.getElementById('autoScenarios'),
    vars: document.getElementById('autoVars'),
    addVar: document.getElementById('autoAddVar'),
    browser: document.getElementById('autoBrowser'),
    screen: document.getElementById('autoScreen'),
    maxSteps: document.getElementById('autoMaxSteps'),
    screenshot: document.getElementById('autoScreenshot'),
    closeBrowser: document.getElementById('autoCloseBrowser'),
    stop: document.getElementById('autoStop'),
    start: document.getElementById('autoStart'),
    flow: document.getElementById('autoFlow'),
    exportBtn: document.getElementById('autoExport'),
    statusBar: document.getElementById('autoStatus'),
    runPill: document.getElementById('autoRunPill'),
    progress: document.getElementById('autoProgress'),
    elapsed: document.getElementById('autoElapsed'),
    timeline: document.getElementById('autoTimeline'),
    presetCard: document.getElementById('presetCard'),
    mainGrid: document.getElementById('mainGrid'),
    apiSpec: document.getElementById('apiSpec'),
    modeSeg: document.getElementById('modeSeg'),
    editTask: document.getElementById('autoEditTask'),
    summaryBody: document.getElementById('taskSummaryBody'),
    taskModal: document.getElementById('taskModal'),
    taskModalClose: document.getElementById('taskModalClose'),
    taskCancel: document.getElementById('taskCancel'),
    taskSave: document.getElementById('taskSave'),
    taskError: document.getElementById('taskError'),
  };

  /* ---------- 状态 ---------- */
  let running = false;
  let abortFlag = false;
  let steps = [];            // 每步完整记录（导出用）
  let history = [];          // 已完成步骤（进 state 的短句）
  let consecutiveFails = 0;
  let unfinishedHistory = [];
  let runCfg = null;
  /* 本页内执行失败过的 ref：ref 跨快照稳定（实测同页前后两次快照 74 个同名元素全部不变），
   * 记下来给下一轮的候选排序降权，避免反复点同一个点不动的元素。
   * 放在模块级是因为补问逻辑（resolveMoreBatches）也要读它。 */
  let failedRefs = Object.create(null);
  let refPageUrl = '';
  let startTs = 0;
  let timerId = null;
  let finished = false;
  let endText = '';          // 结束结论（导出记录用；展示只走状态条）

  /* ---------- 会话落盘（设计 §5） ---------- */
  let runId = null;            // 本轮会话 id（start 时生成）
  let runStartedAt = null;
  let saveTimer = null;
  let saveFailedOnce = false;
  let endReasonText = '';

  /* 500ms 尾随节流；final=true 立即落盘并刷新会话列表 */
  function saveRun(final) {
    if (!runId || !runCfg) return;
    const doSave = async () => {
      try {
        const record = AutoCore.buildRunRecord({
          id: runId, runCfg,
          jevModel: Config.current.model,
          llmModel: Config.llm.configured() ? Config.llm.get().model : null,
          startedAt: runStartedAt,
          endedAt: final ? new Date().toISOString() : null,
          endState: final ? (els.runPill.dataset.state || 'error') : 'running',
          endReason: final ? endReasonText : null,
          steps,
        });
        const r = await fetch('/api/runs/' + runId, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(record),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        saveFailedOnce = false;
        if (final) refreshRunsList();
      } catch (e) {
        if (!saveFailedOnce) { toast('运行记录保存失败（不影响运行）：' + (e && e.message ? e.message : e)); saveFailedOnce = true; }
      }
    };
    if (final) { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } return doSave(); }
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; doSave(); }, 500);
  }

  async function refreshRunsList() { /* Task 5 实装（拉 GET /api/runs） */ }

  /* 轮播状态 */
  const view = { idx: 0, follow: true };
  const stage = {};          // wrap/track/counter/prev/next/follow

  const STEP_GAP_MS = 800;   // 步间间隔（设计 §11）

  /* ---------- 小工具 ---------- */
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function cadence() {
    const c = document.querySelector('input[name="autoCadence"]:checked');
    return c ? c.value : 'single';
  }
  function shortUrl(u) { return String(u || '').replace(/^https?:\/\//, '').slice(0, 40); }

  /* ---------- 环境探测（设计 §4） ---------- */
  /* 状态用顶栏胶囊的圆点表达（颜色跟着 .ok / .error 走），文案里不再带 ✅⚠ */
  async function probeEngine() {
    els.pill.textContent = '引擎检测中…';
    els.pill.className = 'status-pill';
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      const h = await res.json();
      const d = h.browserDetail || {};
      if (d.available) {
        els.pill.textContent = '引擎就绪 ' + (d.version || '');
        els.pill.className = 'status-pill ok';
        els.installHint.hidden = true;
        return true;
      }
      const msg = d.reason === 'not-installed' ? '引擎未安装' : '引擎不可用';
      els.pill.textContent = msg;
      els.pill.className = 'status-pill error';
      els.installHint.hidden = false;
      return false;
    } catch (_) {
      els.pill.textContent = '无后端服务';
      els.pill.className = 'status-pill error';
      els.installHint.hidden = true;   /* 后端问题由顶部 warnbar 负责，不重复 */
      return false;
    }
  }

  /* ---------- 变量池 ---------- */
  function addVarRow(name, value) {
    const row = el('div', 'var-row');
    const nameInp = el('input'); nameInp.placeholder = '变量名（如 关键词 / Enter键）'; nameInp.value = name || '';
    const valInp = el('input'); valInp.placeholder = '取值（如 招商银行）'; valInp.value = value || '';
    const del = el('button', 'row-del', '×'); del.type = 'button'; del.title = '删除变量'; del.setAttribute('aria-label', '删除变量');
    del.onclick = () => row.remove();
    row.appendChild(nameInp); row.appendChild(valInp); row.appendChild(del);
    els.vars.appendChild(row);
    return row;
  }
  function collectVars() {
    return Array.from(els.vars.querySelectorAll('.var-row'))
      .map((r) => ({ name: r.children[0].value.trim(), value: r.children[1].value.trim() }))
      .filter((v) => v.name && v.value);
  }
  function renderVars() {
    if (!els.vars.children.length) addVarRow('', '');
  }

  /* ---------- 内置演示场景 ----------
   * 每个场景 = 一个可离线跑通的内置页面 + 配套的任务目标与变量，与 Demo 模式的
   * 浏览器类预设同一批设定（同干扰项）。在外层选中即写进表单并刷新摘要，不必开弹窗。 */
  const SCENARIOS = [
    {
      id: 'mailbox', icon: '📦', name: '邮箱收件箱', path: '/demo/mailbox.html',
      goal: '整理邮箱，按顺序完成：① 给发件人李婉宁、主题「Re: 周五评审会材料确认」的邮件点星标（点该行的「未标星」按钮）；② 打开左侧「星标邮件」文件夹，确认这封邮件在列表里；③ 回到「收件箱」；④ 在顶部搜索框输入「招商银行」过滤邮件；⑤ 把最新的「您的 9 月电子对账单已生成」归档；⑥ 把「您的 8 月电子对账单已生成」删除，并在浏览器弹出的确认框中选择接受。全部完成后，过滤状态下的收件箱应剩 3 封招商银行相关邮件。',
      vars: [{ name: '关键词', value: '招商银行' }],
    },
    {
      id: 'resume', icon: '📄', name: '简历筛选', path: '/demo/resume.html',
      goal: '邀约两位候选人并复核：① 在「投递岗位」下拉框选择「高级前端工程师」；② 在过滤后的列表中找出技能同时包含 React 和 TypeScript、期望薪资不超过 35K 的唯一候选人（注意李强期望 38K 已超限），点击其卡片上的「邀请面试」；③ 把「投递岗位」切回「全部岗位」；④ 在全列表中找出另一位同样满足 React + TypeScript 且薪资 ≤35K 的候选人（投的是前端工程师岗），也点击「邀请面试」；⑤ 点击左侧「已邀请面试」快捷筛选，确认列表里恰好只有这两位；⑥ 回到「全部候选人」。完成标志：统计栏显示「已邀请 2 位」。',
      vars: [{ name: '岗位', value: '高级前端工程师' }, { name: '全部岗位', value: '全部岗位' }, { name: '薪资上限', value: '35K' }],
    },
    {
      id: 'orders', icon: '🧾', name: '订单后台', path: '/demo/orders.html',
      goal: '两笔发货并复核（严格按 ①→⑤ 顺序逐步执行，不要跳步、不要合并）：① 在「订单状态」下拉框选择「已付款待发货」；② 找到商品为 AirPods Pro 2（USB-C 国行）且买家是王小明的那笔订单，点击该行的「发货」；③ 再找到商品为「AirPods Pro 2 保护套」、买家张伟的待发货订单，点击「发货」；④ 把「订单状态」切到「已发货」；⑤ 在顶部搜索框（提示文字为「搜索订单号 / 买家昵称 / 收件人手机号」的键盘输入框，不是「订单状态」下拉框）填入「王小明」，确认第 ② 步那笔订单（金额 ¥1,899）已出现在已发货列表。其余 AirPods 订单（AirPods 4、港版等干扰项）保持原状不动。',
      vars: [{ name: '商品', value: 'AirPods Pro 2' }, { name: '买家', value: '王小明' }, { name: '待发货状态', value: '已付款待发货' }, { name: '已发货状态', value: '已发货' }],
    },
  ];

  /* 选中态直接由「当前 URL 是否落在某个场景页」推出，不另存状态 ——
   * 用户手改了 URL 就自然取消高亮，不会出现选择器与表单说的不是一回事 */
  function activeScenarioId() {
    const u = els.url.value.trim();
    const hit = SCENARIOS.find((s) => u.endsWith(s.path));
    return hit ? hit.id : '';
  }

  function renderScenarios() {
    const active = activeScenarioId();
    els.scenarios.innerHTML = '';
    SCENARIOS.forEach((s) => {
      const b = el('button', 'chip' + (s.id === active ? ' active' : ''), s.icon + ' ' + s.name);
      b.type = 'button';
      b.title = s.goal;
      b.onclick = () => applyScenario(s.id);
      els.scenarios.appendChild(b);
    });
  }

  function applyScenario(id, quiet) {
    const s = SCENARIOS.find((x) => x.id === id);
    if (!s) return;
    els.url.value = location.origin + s.path;
    els.goal.value = s.goal;
    els.vars.innerHTML = '';   /* 顺带清掉遗留的空变量行 */
    (s.vars.length ? s.vars : [{ name: '', value: '' }]).forEach((v) => addVarRow(v.name, v.value));
    renderSummary();
    if (!quiet) toast('已填入「' + s.name + '」场景（离线可完整演示）');
  }

  /* ---------- 任务配置：只读摘要 + 编辑弹窗 ----------
   * 唯一数据源始终是弹窗里的那些输入框（id 没动，auto.js 其余部分照旧读 .value），
   * 摘要只是它的投影。取消/✕/Esc/切模式一律用快照回滚，避免「摘要与实际值不一致」。 */
  let formSnapshot = null;

  function readForm() {
    return {
      goal: els.goal.value,
      url: els.url.value,
      vars: collectVars(),
      maxSteps: els.maxSteps.value,
      cadence: cadence(),
      browser: els.browser.value,
      screen: els.screen.value,
      screenshot: els.screenshot.checked,
    };
  }
  function writeForm(c) {
    if (!c) return;
    els.goal.value = c.goal;
    els.url.value = c.url;
    els.vars.innerHTML = '';
    (c.vars.length ? c.vars : [{ name: '', value: '' }]).forEach((v) => addVarRow(v.name, v.value));
    els.maxSteps.value = c.maxSteps;
    const radio = document.querySelector('input[name="autoCadence"][value="' + c.cadence + '"]');
    if (radio) radio.checked = true;
    els.browser.value = c.browser;
    els.screen.value = c.screen;
    els.screenshot.checked = c.screenshot;
  }

  /* 窗口尺寸取选项当前文案 —— primeScreenOptions() 开机时会把它改成本机真实分辨率，
   * 硬编码映射会立刻过期。去掉尾部括号说明后作为摘要值。 */
  function screenLabel() {
    const o = els.screen.options[els.screen.selectedIndex];
    const t = (o ? o.textContent : '').replace(/（[^）]*）/g, '').trim();
    return t || els.screen.value;
  }

  function tsRow(label, cls, content) {
    const r = el('div', 'ts-row');
    r.appendChild(el('div', 'ts-label', label));
    const v = el('div', 'ts-value' + (cls ? ' ' + cls : ''));
    if (typeof content === 'string') v.textContent = content; else v.appendChild(content);
    r.appendChild(v);
    els.summaryBody.appendChild(r);
    return v;
  }

  function renderSummary() {
    const f = readForm();
    els.summaryBody.innerHTML = '';
    renderScenarios();   /* 场景高亮跟着 URL 走，和摘要同源同刷 */

    if (!f.goal.trim() && !f.url.trim()) {
      const p = el('div', 'ts-empty');
      p.innerHTML = '尚未配置任务 —— 点右上「✎ 编辑配置」填写<b>任务目标</b>与<b>起始 URL</b>。';
      els.summaryBody.appendChild(p);
      return;
    }

    const goal = tsRow('任务目标', 'clamp2', f.goal.trim() || '（未填写）');
    if (f.goal.trim()) goal.title = f.goal.trim();

    const url = tsRow('起始 URL', 'mono', f.url.trim() ? shortUrl(f.url.trim()) : '（未填写）');
    if (f.url.trim()) url.title = f.url.trim();

    const varsWrap = el('span');
    if (f.vars.length) {
      f.vars.forEach((v) => varsWrap.appendChild(el('span', 'ts-var', v.name + '=' + v.value)));
    } else {
      varsWrap.textContent = '（无）';
    }
    tsRow('输入变量', '', varsWrap);

    tsRow('运行参数', '', [
      f.maxSteps + ' 步',
      f.cadence === 'single' ? '单步确认' : '连续自动',
      f.browser === 'msedge' ? 'Edge' : 'Chrome',
      screenLabel(),
      f.screenshot ? '每步截图' : '不截图',
    ].join(' · '));
  }

  /* 与 start() 共用同一份规则，避免两处漂移 */
  function validateForm() {
    const f = readForm();
    if (!f.goal.trim()) return '请先填写任务目标';
    if (!/^https?:\/\//i.test(f.url.trim())) return '起始 URL 必须以 http:// 或 https:// 开头';
    return '';
  }

  let lastFocus = null;   /* 关闭后把焦点还给「✎ 编辑配置」 */

  function openTaskModal() {
    formSnapshot = readForm();
    lastFocus = document.activeElement;
    els.taskError.hidden = true;
    els.taskError.textContent = '';
    els.taskModal.hidden = false;
    setTimeout(() => els.goal.focus(), 50);
  }
  function closeTaskModal() {
    els.taskModal.hidden = true;
    formSnapshot = null;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    lastFocus = null;
  }
  function cancelTaskModal() {
    writeForm(formSnapshot);   /* 必须回滚后再置空快照 */
    closeTaskModal();
  }
  function saveTaskModal() {
    const invalid = validateForm();
    if (invalid) {
      els.taskError.textContent = invalid;
      els.taskError.hidden = false;
      els.taskError.focus();
      return;
    }
    renderSummary();
    closeTaskModal();
    toast('任务配置已更新');
  }

  /* ---------- 浏览器 / 窗口尺寸选项 ----------
   * max  → 最大化：窗口铺满屏幕（保留浏览器工具栏、任务栏照常）★默认
   * full → 真全屏：CDP fullscreen，盖住任务栏、无工具栏
   * size → 指定页面视口尺寸（resize 模拟，不改窗口）
   * native=true 时追加 --force-device-scale-factor=1 按物理像素渲染：
   * 1920×1080 屏 + 系统 125% 缩放，默认视口只有 1536×864（CSS 像素 =
   * 物理 ÷ 1.25），强制 100% 后就是 1920 宽的那套原生数值。
   * width/height 一并上报，服务端既用于 size 档 resize，也用于开窗后校验。 */
  function windowPlan() {
    const v = els.screen.value;
    const dpr = window.devicePixelRatio || 1;
    const native = v !== 'maxScaled' && v !== 'fullScaled';
    if (v === 'max' || v === 'maxScaled') {
      /* 校验参考：原生按物理像素的工作区（整屏减任务栏），跟随缩放则按 CSS 工作区 */
      return {
        windowMode: 'max', native,
        width: Math.round(window.screen.availWidth * (native ? dpr : 1)),
        height: Math.round(window.screen.availHeight * (native ? dpr : 1)),
      };
    }
    if (v === 'full' || v === 'fullScaled') {
      return {
        windowMode: 'full', native,
        width: Math.round(window.screen.width * (native ? dpr : 1)),
        height: Math.round(window.screen.height * (native ? dpr : 1)),
      };
    }
    const m = v.split('x');
    return { windowMode: 'size', width: Number(m[0]), height: Number(m[1]) };
  }

  /* 选项文案写成这台机器的真实数值（用户最认 1920×1080 这种数字） */
  function primeScreenOptions() {
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(window.screen.width * dpr);
    const ph = Math.round(window.screen.height * dpr);
    const set = (val, text) => {
      const o = els.screen.querySelector('option[value="' + val + '"]');
      if (o) o.textContent = text;
    };
    set('max', '占满屏幕 · 原生 ' + pw + ' × ' + ph + '（忽略系统缩放）');
    set('maxScaled', '占满屏幕 · 跟随系统缩放（' + window.screen.availWidth + ' × ' + window.screen.availHeight + '）');
    if (dpr !== 1) set('full', '全屏 · 无边框，盖住任务栏');
  }

  /* ---------- API 封装（本模式只服务同源后端） ---------- */
  async function apiJson(path, body, extraHeaders) {
    try {
      const res = await fetch(path, {
        method: body ? 'POST' : 'GET',
        headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}),
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch (_) { /* 走 HTTP 状态分支 */ }
      if (data) return data;
      return { ok: false, error: 'HTTP ' + res.status + '：' + text.slice(0, 200) };
    } catch (e) {
      return { ok: false, error: '连不上本地服务：' + (e && e.message ? e.message : String(e)) };
    }
  }

  /* ---------- 概率条（与 Demo 的答案渲染同视觉） ---------- */
  function barsHtml(probs, hitKey, color) {
    const entries = Object.keys(probs || {})
      .map((k) => ({ k, p: Number(probs[k]) || 0 }))
      .sort((a, b) => b.p - a.p);
    const TOP = 6;
    const row = (e) => {
      const hit = e.k === hitKey;
      return '<div class="bar-row' + (hit ? ' hit' : '') + '">' +
        '<span class="bar-label" title="' + escapeHtml(e.k) + '">' + escapeHtml(e.k) + '</span>' +
        '<span class="bar-track"><span class="bar-fill" style="width:0%;background:' + (hit || hitKey == null ? color : '#cdd1d8') + '" data-w="' + Math.max(0, Math.min(1, e.p)) * 100 + '"></span></span>' +
        '<span class="bar-val">' + pct(e.p) + '</span></div>';
    };
    let html = '<div class="bars">' + entries.slice(0, TOP).map(row).join('') + '</div>';
    if (entries.length > TOP) {
      html += '<details class="step-collapse" style="margin-top:4px"><summary>展开全部 ' + entries.length + ' 项</summary>' +
        '<div class="bars">' + entries.slice(TOP).map(row).join('') + '</div></details>';
    }
    return html;
  }
  function animateBars(root) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      root.querySelectorAll('.bar-fill[data-w]').forEach((n) => {
        n.style.width = n.dataset.w + '%';
        n.removeAttribute('data-w');
      });
    }));
  }

  /* ---------- 时间线 ---------- */
  function addChip(label, cls, id) {
    const chip = el('button', 'tl-chip' + (cls ? ' ' + cls : ''), label);
    chip.type = 'button';
    chip.setAttribute('role', 'listitem');
    if (id != null) {
      chip.title = '查看第 ' + id + ' 步卡片';
      chip.onclick = () => gotoStep(id - 1, true);
    }
    els.timeline.appendChild(chip);
    return chip;
  }
  function markChip(id, cls) {
    const chip = els.timeline.querySelector('[data-chip="' + id + '"]');
    if (chip) chip.className = 'tl-chip' + (cls ? ' ' + cls : '');
  }

  /* ---------- 轮播 ---------- */
  function buildStage() {
    els.flow.innerHTML = '';
    view.idx = 0; view.follow = true;
    stage.wrap = el('div', 'stage-wrap');
    stage.wrap.tabIndex = 0;
    const nav = el('div', 'stage-nav');
    stage.prev = el('button', 'stage-btn', '‹');
    stage.prev.type = 'button'; stage.prev.title = '上一步（←）'; stage.prev.setAttribute('aria-label', '上一步');
    stage.prev.onclick = () => gotoStep(view.idx - 1, true);
    stage.counter = el('div', 'stage-counter', '暂无步骤');
    stage.follow = el('button', 'stage-follow', '→ 最新');
    stage.follow.type = 'button'; stage.follow.title = '跳到最新步骤';
    stage.follow.onclick = () => { view.follow = true; gotoStep(steps.length - 1, false); };
    stage.next = el('button', 'stage-btn', '›');
    stage.next.type = 'button'; stage.next.title = '下一步（→）'; stage.next.setAttribute('aria-label', '下一步');
    stage.next.onclick = () => gotoStep(view.idx + 1, true);
    nav.appendChild(stage.prev); nav.appendChild(stage.counter); nav.appendChild(stage.follow); nav.appendChild(stage.next);
    stage.viewport = el('div', 'stage-viewport');
    stage.track = el('div', 'stage-track');
    stage.viewport.appendChild(stage.track);
    stage.wrap.appendChild(nav); stage.wrap.appendChild(stage.viewport);
    els.flow.appendChild(stage.wrap);
    updateNav();
  }
  function gotoStep(i, user) {
    const n = steps.length;
    if (!n || !stage.track) return;
    i = Math.max(0, Math.min(n - 1, i));
    view.idx = i;
    if (user) view.follow = i === n - 1;
    stage.track.style.transform = 'translateX(' + (-i * 100) + '%)';
    updateNav();
  }
  function updateNav() {
    const n = steps.length;
    stage.prev.disabled = view.idx <= 0;
    stage.next.disabled = n === 0 || view.idx >= n - 1;
    stage.follow.classList.toggle('show', n > 0 && view.idx < n - 1);
    /* 只报位置；步骤名由卡片头承担，避免同一句话在导航行与卡片头各说一遍 */
    stage.counter.textContent = n ? '步骤 ' + (view.idx + 1) + ' / ' + n : '暂无步骤';
    stage.counter.title = stage.counter.textContent;
  }

  /* ---------- 步骤卡 ----------
   * 信息分层（用户关注主体优先）：
   *  ① 页面实时情况：执行后截图，卡片主体、通栏展示、点击放大
   *  ② Jev 决策：摘要行常显（动作/参数/文本 + 复合置信度 + 未完成量表 + 执行命令），
   *     概率分布明细默认折叠
   *  ③ Jev 请求信息（输入 state + 首轮 3 道问题 + 补问 + 输出）：默认折叠 */
  function newStepCard(step) {
    const card = el('article', 'step-card');
    card.id = 'stepcard-' + step.n;
    const head = el('div', 'step-head');
    head.appendChild(el('span', 'step-no', '第 ' + step.n + ' 步'));
    const title = el('span', 'step-title', 'Jev 决策中…');
    head.appendChild(title);
    const state = el('span', 'step-state', '');
    head.appendChild(state);
    card.appendChild(head);

    const body = el('div', 'step-body');
    const shotSlot = el('div', 'shot-slot');          // ① 截图主体
    body.appendChild(shotSlot);
    const decision = el('div', 'step-decision');      // ② 决策摘要 + 折叠明细
    decision.innerHTML = '<div class="skel-wrap"><div class="skel" style="width:34%"></div><div class="skel" style="width:58%"></div></div>';
    body.appendChild(decision);
    const execZone = el('div', 'step-exec-slot');     // ②执行命令行 / LLM 区
    body.appendChild(execZone);
    const ctx = el('div', 'ctx-slot');                // ③ 请求信息（折叠）
    ctx.innerHTML = contextHtml(step);                // payload 在建卡前已就绪，一次性渲染
    body.appendChild(ctx);
    card.appendChild(body);

    stage.track.appendChild(card);
    if (view.follow) gotoStep(steps.length - 1, false);
    else updateNav();
    return { card, head, title, state, body, shotSlot, decision, execZone, ctx, ctxRev: ctxRevision(step) };
  }

  /* ============ 决策区：摘要常显 + 明细折叠 ============ */
  /* 未完成量表满分（score 范围 0~SCORE_MAX，API 按级数-1 加权）—— 与 auto-core 的
   * SCORE_LEVELS 联动，图例缩过级数后这里不再写死 4 */
  const SCORE_MAX = AutoCore.SCORE_LEVELS - 1;
  function meterHtml(score, unfinished, mini) {
    const ticks = [];
    for (let k = 1; k <= SCORE_MAX; k++) ticks.push(k);
    const segs = ticks.map((k) => '<span class="meter-seg' + (score >= k ? ' on' : '') + '"></span>').join('');
    const tone = unfinished <= 0.2 ? 'good' : (unfinished >= 0.6 ? 'bad' : 'mid');
    const meter = '<div class="meter ' + tone + (mini ? ' mini' : '') + '">' + segs + '</div>';
    if (mini) return meter;
    return meter +
      '<div class="meter-note">score ' + score + ' / ' + SCORE_MAX + ' · 未完成度 <b>' + pct(unfinished) + '</b></div>' +
      '<div class="meter-scale"><span>0 已完成</span><span>' + SCORE_MAX + ' 未完成</span></div>';
  }

  function decisionSummaryHtml(step) {
    const a = (step.response && step.response.answers) || {};
    const d = step.decision || {};
    const refLabels = step.refLabels || {};
    const varOf = (name) => {
      const v = (runCfg && runCfg.variables || []).find((x) => x.name === name);
      return v ? v.value : name;
    };
    /* 短标签：剥掉「【可交互】」前缀并截断（「无需元素」的说明很长，只显示裸键） */
    const shortRef = (key) => {
      if (key === '无需元素' || !refLabels[key]) return key;
      const clean = refLabels[key].replace(/^【[^】]*】\s*/, '');
      return key + ' · ' + (clean.length > 24 ? clean.slice(0, 24) + '…' : clean);
    };
    const chip = (k, v, cls) => '<span class="dec-chip ' + (cls || '') + '"><i>' + k + '</i>' + escapeHtml(v) + '</span>';
    /* 复合置信度：本轮作答的各选择题 confidence 的最小值（首轮 动作/参数 + 已落定补问
     * 的作答题）。旧版只显示动作题 —— 文本题 47% 的摇摆会被 82% 的动作置信度盖住。 */
    const confOf = (ans) => (ans && typeof ans.confidence === 'number') ? ans.confidence : null;
    const FOLLOWUP_Q = { param: '参数', action: '动作', text: '文本' };
    const confs = [];
    [a['动作'], a['参数']].forEach((ans) => { const c = confOf(ans); if (c != null) confs.push(c); });
    (step.followUps || []).forEach((r) => {
      if (!(r.param || r.action || r.text)) return;   // 未落定 / 失败的补问没有参与决策
      const c = confOf(r.response && r.response.answers && r.response.answers[FOLLOWUP_Q[r.kind]]);
      if (c != null) confs.push(c);
    });
    const confVal = confs.length ? Math.min.apply(null, confs) : null;
    const conf = confVal != null
      ? '<span class="dec-conf" title="各选择题置信度的最低值（动作 / 参数 / 已落定的补问）">置信度 ' + pct(confVal) + '</span>' : '';

    let html = '<div class="dec-sum">' +
      chip('动作', d.action || '—', 'act') +
      (d.param ? chip('参数', shortRef(d.param)) : '') +
      (d.text != null && d.text !== '无' ? chip('文本', varOf(d.text)) : '');
    const u = a['未完成'];
    if (d.unfinished != null && u && u.score != null) {
      html += '<span class="dec-meter" title="score ' + u.score + ' / ' + SCORE_MAX + ' · 未完成度 ' + pct(d.unfinished) + '">' +
        meterHtml(u.score, d.unfinished, true) + '<b>' + u.score + '/' + SCORE_MAX + '</b></span>';
    }
    html += conf + '</div>';
    return html;
  }

  function decisionDetailsHtml(step) {
    const a = (step.response && step.response.answers) || {};
    const d = step.decision || {};
    const refLabels = step.refLabels || {};
    const varOf = (name) => {
      const v = (runCfg && runCfg.variables || []).find((x) => x.name === name);
      return v ? v.value : name;
    };
    const color = { 动作: 'var(--violet)', 参数: '#7c3aed', 文本: '#0d9268' };
    const hit = { 动作: d.action, 参数: d.param, 文本: d.text };
    /* 参数若是补问回合定下来的，本轮的「参数」概率分布里没有它 —— 不能拿第一批的
     * 概率条去解释第二批复问的答案，改成指向下方的补问记录 */
    const followUpRec = (step.followUps || []).find((r) => r.param && r.param === d.param);
    /* 文本已移出首轮：它的答案与概率来自同一步的「文本」补问记录 */
    const textRec = (step.followUps || []).find((r) => r.kind === 'text');
    const shortRef = (key) => {
      if (key === '无需元素' || !refLabels[key]) return key;
      const clean = refLabels[key].replace(/^【[^】]*】\s*/, '');
      return key + ' · ' + (clean.length > 24 ? clean.slice(0, 24) + '…' : clean);
    };
    const chosenLabel = {
      动作: d.action || '—',
      参数: d.param ? shortRef(d.param) + (followUpRec ? '（第 ' + followUpRec.batch + ' 批补问）' : '') : '—',
      文本: d.text === '无' ? '无' : (d.text ? varOf(d.text) : '—'),
    };
    const confBadge = (ans) => {
      const c = ans && typeof ans.confidence === 'number' ? ans.confidence : null;
      return c != null ? '<span class="qcard-conf">置信度 ' + pct(c) + '</span>' : '';
    };
    let html = '<div class="qgrid">';
    ['动作', '参数', '文本'].forEach((name) => {
      const ans = (name === '文本' && textRec && textRec.response && textRec.response.answers)
        ? (textRec.response.answers['文本'] || {})
        : (a[name] || {});
      const fromParamFollowUp = (name === '参数' && followUpRec);
      const fromTextFollowUp = (name === '文本' && textRec);
      /* 补问回合定下的 ref 不在本轮概率分布里，别错误高亮别项 */
      const mark = (hit[name] != null && ans.probabilities && ans.probabilities[hit[name]] != null) ? hit[name] : null;
      const followUpNote = fromParamFollowUp
        ? '本行选项由第 ' + followUpRec.batch + ' 批补问确定，该题概率见下方「参数补问」记录'
        : '本行选项由「文本」补问确定，该题概率见下方「文本补问」记录';
      html += '<div class="qcard">' +
        '<div class="qcard-head"><span class="qcard-name">' + name + '</span>' +
        '<span class="qcard-chosen">' + escapeHtml(chosenLabel[name]) + '</span>' + confBadge(ans) + '</div>' +
        (ans.probabilities ? barsHtml(ans.probabilities, mark, color[name]) : '<div class="muted" style="font-size:12px">无概率数据</div>') +
        ((fromParamFollowUp || fromTextFollowUp) ? '<div class="muted" style="font-size:12px">' + followUpNote + '</div>' : '') +
        '</div>';
    });
    const u = a['未完成'] || {};
    html += '<div class="qcard">' +
      '<div class="qcard-head"><span class="qcard-name">未完成</span><span class="qcard-chosen score">' +
      (u.score != null ? 'score ' + u.score + ' / ' + SCORE_MAX : '—') + '</span></div>' +
      (d.unfinished != null ? meterHtml(u.score != null ? u.score : 0, d.unfinished) : '') +
      '</div>';
    html += '</div>';
    return html;
  }

  function decisionHtml(step) {
    /* 题数按 payload 实际内容算：首轮 3 道（弹窗步 1 道），补问每次 +1 */
    const n = Object.keys((step.payload && step.payload.questions) || {}).length;
    const fu = (step.followUps || []).filter((r) => r.kind !== 'text' || r.text || r.error).length;
    return decisionSummaryHtml(step) +
      '<details class="step-collapse prob-details"><summary>概率分布明细（' + n + ' 道问题' + (fu ? ' + ' + fu + ' 次补问' : '') + '）</summary>' +
      decisionDetailsHtml(step) + '</details>';
  }

  /* ============ 执行区 / LLM 区 ============ */
  function cmdDisplay(op, ref, text) {
    return 'playwright-cli ' + op + (ref ? ' ' + ref : '') + (text != null ? ' "' + text + '"' : '');
  }

  function execHtml(step) {
    const e = step.exec;
    if (!e) return '';
    if (e.skipped) return '<div class="exec-line">用户跳过此步（未执行）</div>';
    let html = '';
    if (e.cmd) {
      html += '<div class="cmd-line"><code>' + escapeHtml(e.cmd) + '</code>' +
        (e.elapsedMs != null ? '<span class="exec-url">· ' + e.elapsedMs + 'ms</span>' : '') +
        (e.ok != null ? '<span class="exec-verdict ' + (e.ok ? 'ok' : 'bad') + '">' + (e.ok ? '✓ 成功' : '✗ 失败') + '</span>' : '') +
        '</div>';
    } else if (e.ok != null) {
      html += '<div class="exec-line">' + (e.ok ? '✓ 成功' : '✗ 失败') + '</div>';
    }
    if (e.error) html += '<div class="step-err">' + escapeHtml(e.error) + '</div>';
    /* 标注失败不推翻这一步，只挂一句说明（图退回未标注的原图） */
    if (step.annoError) {
      html += '<div class="exec-line"><span class="exec-url">未标注：' + escapeHtml(step.annoError) + '</span></div>';
    }
    return html;
  }

  function llmHtml(step) {
    const L = step.llm;
    if (!L) return '';
    let html = '<div class="llm-block"><div class="sec-head violet">生成输入 · LLM</div>';
    if (L.error) return html + '<div class="step-err">' + escapeHtml(L.error) + '</div></div>';
    if (L.text) html += '<div class="llm-gen">生成文本 → ' + escapeHtml(L.text) + '</div>';
    html += '<details class="step-collapse"><summary>Prompt（工程组装，前端可见）</summary>' +
      '<pre class="step-pre">' + escapeHtml(L.messages.map((m) => '[' + m.role + ']\n' + m.content).join('\n\n')) + '</pre></details>';
    html += '<details class="step-collapse"><summary>模型原始响应</summary>' +
      '<pre class="step-pre">' + escapeHtml(JSON.stringify(L.raw, null, 2)) + '</pre></details>';
    html += '</div>';
    return html;
  }

  /* ============ 输入区（结构化 state + 首轮 3 道问题，建卡时一次性渲染） ============ */
  function snapshotDetailsHtml(snap) {
    const text = String(snap || '');
    const lines = text ? text.split('\n').length : 0;
    const refs = Object.keys(AutoCore.refCriteria(text)).length;
    return '<details class="snap-details"><summary>accessibility 快照 · ' + lines + ' 行 · ' + refs + ' 个元素（点开查看）</summary>' +
      '<pre class="step-pre tall">' + escapeHtml(text) + '</pre></details>';
  }

  function stateSectionHtml(state) {
    const page = state['当前页面'] || {};
    const hist = Array.isArray(state['已完成步骤']) ? state['已完成步骤'] : [];
    const lastResult = String(state['上一步结果'] || '');
    const lastCls = /^成功/.test(lastResult) ? ' ok-text' : /^失败/.test(lastResult) ? ' bad-text' : '';
    return '<div class="sec"><div class="sec-head">本轮输入 · state</div><div class="kv-list">' +
      '<div class="kv"><div class="kv-k">任务目标</div><div class="kv-v"><span class="goal-text">' + escapeHtml(state['任务目标'] || '') + '</span></div></div>' +
      '<div class="kv"><div class="kv-k">当前页面</div><div class="kv-v"><span class="mono-chip">' + escapeHtml(page.url || '') + '</span>' +
      (page['标题'] ? '<span class="page-title">' + escapeHtml(page['标题']) + '</span>' : '') + '</div></div>' +
      '<div class="kv"><div class="kv-k">上一步结果</div><div class="kv-v' + lastCls + '">' + escapeHtml(lastResult) + '</div></div>' +
      '<div class="kv"><div class="kv-k">已完成步骤</div><div class="kv-v">' +
      (hist.length ? '<ol class="hist-list">' + hist.map((h) => '<li>' + escapeHtml(h) + '</li>').join('') + '</ol>' : '<span class="muted">（第一步，暂无）</span>') +
      '</div></div>' +
      '<div class="kv"><div class="kv-k">页面快照</div><div class="kv-v">' + snapshotDetailsHtml(state['页面快照']) + '</div></div>' +
      '</div></div>';
  }

  function criteriaAreaHtml(name, q, step) {
    const crit = q.criteria;
    if (name === '动作') {
      const terminal = AutoCore.TERMINAL_TOOLS || {};
      const chips = Object.keys(crit).map((k) => {
        let tone = '';
        if (terminal[k]) tone = k === '任务已完成' ? ' good' : ' warn';
        else if (k === '生成输入' || k === '无操作') tone = ' violet';
        return '<span class="crit-chip' + tone + '" title="' + escapeHtml(crit[k]) + '">' + escapeHtml(k) + '</span>';
      }).join('');
      return '<div class="crit-cloud">' + chips + '</div>';
    }
    if (name === '参数') {
      const refLabels = step.refLabels || {};
      const rows = Object.keys(crit).map((ref) =>
        '<div class="ref-row"><span class="ref-id">' + escapeHtml(ref) + '</span>' +
        '<span class="ref-label" title="' + escapeHtml(crit[ref]) + '">' + escapeHtml(refLabels[ref] || crit[ref]) + '</span></div>').join('');
      return '<div class="ref-scroll">' + rows + '</div>';
    }
    /* 未完成：等级量表（行数随 auto-core 的 SCORE_LEVELS 走） */
    const levels = Array.isArray(crit) ? crit : [];
    return '<div class="scale-row">' + levels.map((c, i) =>
      '<div class="scale-cell" title="' + escapeHtml(c) + '"><span class="scale-no">' + i + '</span><span class="scale-txt">' + escapeHtml(c) + '</span></div>').join('') +
      '</div>';
  }

  function questionsSectionHtml(step) {
    const qs = (step.payload && step.payload.questions) || {};
    const ORDER = ['动作', '参数', '未完成'];   // 首轮 3 道；弹窗步只有「动作」1 道
    const meta = {
      动作: Object.keys(qs['动作'] && qs['动作'].criteria || {}).length + ' 个候选',
      参数: Object.keys(qs['参数'] && qs['参数'].criteria || {}).length + ' 个候选 ref',
      未完成: ((qs['未完成'] && qs['未完成'].criteria || []).length || AutoCore.SCORE_LEVELS) + ' 级分值',
    };
    const present = ORDER.filter((name) => qs[name]);
    let html = '<div class="sec"><div class="sec-head">本轮输入 · ' + present.length + ' 道问题</div><div class="qlist">';
    present.forEach((name) => {
      const q = qs[name];
      html += '<div class="qblock">' +
        '<div class="qblock-head"><span class="qblock-name">' + name + '</span>' +
        '<span class="type-badge">' + escapeHtml(q.type || '') + '</span>' +
        '<span class="qblock-meta">' + escapeHtml(meta[name] || '') + '</span></div>' +
        (q.instructions ? '<div class="qblock-inst" title="' + escapeHtml(q.instructions) + '">' + escapeHtml(q.instructions) + '</div>' : '') +
        criteriaAreaHtml(name, q, step) +
        '</div>';
    });
    html += '</div></div>';
    return html;
  }

  function rawDetailsHtml(step) {
    const reqText = relaxedStringify(step.payload);
    const respText = step.response ? JSON.stringify({
      model: step.response.model, answers: step.response.answers,
      usage: step.response.usage, _latency_ms: step.response._latency_ms,
    }, null, 2) : '（调用失败，无响应）';
    return '<details class="raw-details"><summary>原始报文（与真实请求同一对象，可复制）</summary>' +
      '<div class="raw-label">① 请求体</div><pre class="step-pre tall">' + escapeHtml(reqText) + '</pre>' +
      '<div class="raw-label">② Jev 响应</div><pre class="step-pre tall">' + escapeHtml(respText) + '</pre>' +
      '</details>';
  }

  /* ③ 请求信息：外层统一折叠（输入 state + 首轮问题 + 补问记录 + 原始报文） */
  /* 参数题候选裁剪的摘要：让人一眼看出「本来多少个、给了 Jev 多少个、为什么」 */
  function trimSummary(step) {
    const m = step.trim;
    if (!m || !m.trimmed) return '';
    const head = '本批 ' + m.top.length + ' 个 / 全页 ' + m.totalRefs + ' 个';
    const why = [];
    why.push('关键词命中');
    why.push('可点击优先');
    why.push('已失败降权');
    let s = '候选已折叠：' + head + '（' + why.join(' · ') + '）';
    if (m.folded) s += '，已折叠 ' + (m.folded) + ' 个';
    if (step.payload && step.payload.questions && step.payload.questions['参数']
      && step.payload.questions['参数'].criteria['其他']) s += ' + 「其他」兜底';
    if (m.hiddenMore) s += '（已到最后一批）';
    return s;
  }

  function trimDetailHtml(step) {
    const m = step.trim;
    if (!m || !m.trimmed) return '';
    const rows = (m.top || []).map((x) =>
      '<div class="ref-row scored"><span class="ref-id">' + escapeHtml(x.ref) + '</span>' +
      '<span class="ref-score">' + escapeHtml(String(x.score)) + '</span>' +
      '<span class="ref-label" title="' + escapeHtml(x.reasons.join(' · ')) + '">' +
      escapeHtml(x.label) + (x.ancestor ? '（' + escapeHtml(x.ancestor) + '）' : '') + '</span></div>').join('');
    return '<div class="sec"><div class="sec-head">候选裁剪明细（分数 = 关键词稀有度 + 可点击 + 已失败）</div>' +
      '<div class="ref-scroll">' + rows + '</div></div>';
  }

  /* 补问记录：两类共用同一张卡 ——
   *   kind='param'  候选裁剪展开下一批（「其他」）
   *   kind='action' 动作与元素角色不兼容，重新问「动作」
   * 结果落定前默认展开（用户能看见"正在补问"），落定后收起。 */
  function followUpDetails(title, requestLabel, rec, hit, settled) {
    return '<details class="req-details"' + (settled ? '' : ' open') + '>' +
      '<summary>' + title + '（' + escapeHtml(hit) + '）</summary>' +
      '<div class="req-inner">' +
      '<div class="raw-label">① 发送的请求体（仅「' + requestLabel + '」一题）</div>' +
      '<pre class="step-pre tall">' + escapeHtml(relaxedStringify(rec.payload)) + '</pre>' +
      (rec.response ? '<div class="raw-label">② Jev 响应</div>' +
        '<pre class="step-pre tall">' + escapeHtml(JSON.stringify(rec.response, null, 2)) + '</pre>' : '') +
      '</div></details>';
  }

  /* 补问记录：三类共用同一张卡 ——
   *   kind='param'  候选裁剪展开下一批（「其他」）
   *   kind='action' 动作与元素角色不兼容，重新问「动作」
   *   kind='text'   动作落定后的「文本」（select 给真实选项名 / press 给键名） */
  function followUpsHtml(step) {
    const list = step.followUps || [];
    if (!list.length && !step.trimNote) return '';
    let html = '';
    if (step.trimNote) {
      html += '<div class="sec"><div class="sec-head">候选兜底项</div><div class="qblock-inst">' +
        escapeHtml(step.trimNote) + '</div></div>';
    }
    list.forEach((r) => {
      if (r.kind === 'action') {
        const hit = r.action ? ('已改为 ' + r.action) : (r.error ? '失败：' + r.error : '未返回');
        html += followUpDetails(
          '动作补问 · 「' + escapeHtml(String(r.from || '')) + '」与元素角色 '
            + escapeHtml(String(r.role || '')) + ' 不兼容',
          '动作', r, hit, Boolean(r.action || r.error));
        return;
      }
      if (r.kind === 'text') {
        const hit = r.text ? ('已选定 ' + r.text) : (r.error ? '失败：' + r.error : '未返回');
        html += followUpDetails(
          '文本补问 · 动作「' + escapeHtml(String(r.forAction || '')) + '」确定后的取值',
          '文本', r, hit, Boolean(r.text || r.error));
        return;
      }
      const hit = r.param ? ('命中 ' + r.param) : (r.error ? '失败：' + r.error : '未命中');
      html += followUpDetails('参数补问 · 第 ' + r.batch + ' 批', '参数', r, hit, Boolean(r.param || r.error));
    });
    return html;
  }

  function contextHtml(step) {
    if (!step.payload) return '';
    return '<details class="req-details"><summary>Jev 请求信息（输入 state · 首轮问题 · 补问 · 输出答案）</summary>' +
      '<div class="req-inner">' +
      (trimSummary(step) ? '<div class="trim-note">' + escapeHtml(trimSummary(step)) + '</div>' : '') +
      stateSectionHtml(step.payload.state) +
      questionsSectionHtml(step) +
      trimDetailHtml(step) +
      followUpsHtml(step) +
      rawDetailsHtml(step) +
      '</div></details>';
  }

  /* 请求信息区的「版本号」：补问/兜底说明是建卡之后才产生的，
   * 靠它决定要不要重渲染（否则步骤卡里承诺的补问记录永远不显示）。
   * 必须把「已落定的记录数」也算进来：补问记录在发请求前就 push 了，
   * 只看 length 的话，拿到响应后不会重渲染，屏幕上永远停在「未命中、无响应」。 */
  function ctxRevision(step) {
    const list = step.followUps || [];
    const settled = list.filter((r) => r.param || r.action || r.text || r.error).length;
    return list.length + '.' + settled + '|' + (step.trimNote ? '1' : '0') + '|' + (step.exhausted ? '1' : '0');
  }

  function updateStepCard(step, nodes) {
    nodes.title.textContent = step.label || '第 ' + step.n + ' 步';
    const rev = ctxRevision(step);
    if (nodes.ctx && nodes.ctxRev !== rev) {
      const prev = nodes.ctx.querySelector('details.req-details');
      const wasOpen = prev ? prev.open : false;
      nodes.ctx.innerHTML = contextHtml(step);
      nodes.ctxRev = rev;
      const now = nodes.ctx.querySelector('details.req-details');
      if (now) now.open = wasOpen;      // 重渲染不打断用户已展开的阅读状态
    }
    const e = step.exec;
    if (step.jevError) {
      nodes.state.textContent = 'Jev 调用失败';
      nodes.state.className = 'step-state error';
      nodes.decision.innerHTML = '<div class="step-err">' + escapeHtml(step.jevError) + '</div>';
    } else if (step.decision) {
      nodes.decision.innerHTML = decisionHtml(step);
      animateBars(nodes.decision);
    }
    nodes.execZone.innerHTML = llmHtml(step) + execHtml(step);
    /* ① 截图主体：通栏大图，到达即挂载 */
    if (step.screenshot && !nodes.shotSlot.querySelector('.step-shot')) {
      const img = document.createElement('img');
      img.src = step.screenshot;
      img.className = 'step-shot';
      img.alt = '第 ' + step.n + ' 步操作前的页面' + (step.anno && step.anno.box ? '（已标注被操作元素）' : '');
      /* 标注几何落在 data-* 上：E2E 直接采这些坐标的像素，证明「标注真的在人看到的那张图上」 */
      if (step.anno && step.anno.box) {
        img.dataset.anno = [step.anno.box.x, step.anno.box.y, step.anno.box.w, step.anno.box.h,
          step.anno.badge.x, step.anno.badge.y].join(',');
      }
      img.onclick = () => openLightbox(step.screenshot, img.alt);
      nodes.shotSlot.appendChild(img);
    }
    if (e) {
      nodes.state.textContent = e.skipped ? '已跳过' : (e.ok ? '成功' + (e.elapsedMs != null ? ' · ' + e.elapsedMs + 'ms' : '') : '失败');
      nodes.state.className = 'step-state ' + (e.skipped ? 'warn' : e.ok ? 'ok' : 'error');
    } else if (step.terminal) {
      /* 标题已写明 Jev 判定的动作（如「任务已完成」），状态位只需说明「这是终止帧」 */
      nodes.state.textContent = '终止';
      nodes.state.className = 'step-state ' + (step.terminal === '任务已完成' ? 'ok' : 'warn');
    }
    updateNav();
  }

  /* ---------- 灯箱 ---------- */
  function openLightbox(dataUrl, alt) {
    const ov = el('div', 'shot-overlay');
    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = alt || '截图放大';
    ov.appendChild(img);
    ov.onclick = () => ov.remove();
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { ov.remove(); document.removeEventListener('keydown', esc); }
    });
    document.body.appendChild(ov);
  }

  /* ---------- 单步确认 ---------- */
  function awaitConfirm(card) {
    return new Promise((resolve) => {
      const bar = el('div', 'confirm-bar');
      const mk = (label, cls, val) => {
        const b = el('button', cls, label);
        b.type = 'button';
        b.onclick = () => { bar.remove(); resolve(val); };
        return b;
      };
      bar.appendChild(mk('▶ 执行本步', 'btn-ghost', 'run'));
      bar.appendChild(mk('⏭ 跳过', 'btn-ghost', 'skip'));
      bar.appendChild(mk('■ 中止循环', 'btn-ghost danger', 'abort'));
      card.querySelector('.step-body').appendChild(bar);
      bar.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  /* ---------- 生成模型调用（OpenAI 兼容响应，无 ok 字段，按 HTTP + error 判定） ---------- */
  async function callLlm(body, llmCfg) {
    const res = await fetch('/api/llm', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Llm-Base': llmCfg.base,
        'X-Llm-Key': llmCfg.key,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) { /* 下方统一报错 */ }
    if (!res.ok || !data || data.error) {
      const m = (data && data.error && (data.error.message || data.error)) || text.slice(0, 200) || ('HTTP ' + res.status);
      throw new Error(typeof m === 'string' ? m : JSON.stringify(m));
    }
    return data;
  }

  /* ---------- Jev 调用（失败重试一次） ---------- */
  async function callJev(payload) {
    const attempt = async () => {
      const res = await fetch('/api/systemone', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Typesafe-Key': Config.current.key.trim(),
          'X-Endpoint': Config.current.endpoint,
        },
        body: JSON.stringify(payload),   // 与步骤卡展示的是同一对象序列化
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch (_) { /* 下方统一报错 */ }
      if (!res.ok || !data || !data.answers) {
        const m = (data && data.error && (data.error.message || data.error)) || text.slice(0, 200) || ('HTTP ' + res.status);
        throw new Error(typeof m === 'string' ? m : JSON.stringify(m));
      }
      return data;
    };
    try { return { ok: true, data: await attempt() }; }
    catch (e1) {
      toast('Jev 调用失败，重试一次…');
      await sleep(600);
      try { return { ok: true, data: await attempt() }; }
      catch (e2) { return { ok: false, error: 'Jev 调用失败（已重试）：' + (e2 && e2.message ? e2.message : String(e2)) }; }
    }
  }

  /* ---------- 候选裁剪：Jev 选了「其他」时补问下一批 ----------
   * 只补问「参数」一题（动作已定，不重发整组问题以免连带动摇动作决策），
   * 每一步最多展开 maxTranches 批；每批的请求/响应都留在步骤卡里。 */
  async function resolveMoreBatches(step, nodes, chip) {
    const trim = AutoCore.normalizeTrim(runCfg.paramTrim);
    for (let batch = 2; batch <= trim.maxTranches; batch++) {
      const pc = AutoCore.paramCriteria({
        snapshot: step.snapshot, goal: runCfg.goal,
        avoidRefs: Object.keys(failedRefs), paramTrim: runCfg.paramTrim, batch,
      });
      const questions = AutoCore.buildParamFollowUp({
        paramCriteria: pc, action: step.decision.action, batch,
        totalRefs: pc.meta.totalRefs, limit: pc.meta.limit,
      });
      const payload = { state: step.payload.state, model: Config.current.model, questions };
      const rec = { kind: 'param', batch, payload, response: null, error: null, param: null };
      step.followUps.push(rec);
      chip.textContent = step.n + ' · 展开第 ' + batch + ' 批候选';
      updateStepCard(step, nodes);

      const jev = await callJev(payload);
      if (!jev.ok) { rec.error = jev.error; return false; }
      rec.response = jev.data;

      let param;
      try { param = AutoCore.parseParamAnswer(jev.data.answers || {}); }
      catch (e) { rec.error = '决策解析失败：' + ((e && e.message) || String(e)); return false; }
      if (!pc.criteria[param]) { rec.error = 'Jev 返回了不在候选里的元素：' + param; return false; }
      rec.param = param;

      if (!AutoCore.isRefMore(param)) {
        step.decision = Object.assign({}, step.decision, { param: param });
        return true;
      }
      if (batch === trim.maxTranches) { rec.error = '本批仍选了「其他」，但已是最后一批'; }
    }
    return false;
  }

  /* ---------- 动作 × 元素角色不兼容：同一步内补问「动作」 ----------
   * 实测事故：模型对 button "发货" 选了 select，命令打到 playwright 才被
   * "Element is not a <select> element" 拦下，白烧一步。现在这一类"物理上不可能"的组合
   * 在发命令前就被拦下，只补问「动作」一题（候选已去掉该元素上不可能的动作，且不带终止态 ——
   * 终止只能走主循环那条通道）。补问的请求/响应同样留在步骤卡里。
   * 与 resolveMoreBatches 的分工：那个改「参数」，这个改「动作」。 */
  async function resolveActionConflict(step, nodes, chip, conflict, refRoles) {
    const questions = AutoCore.buildActionFollowUp(conflict);
    const payload = { state: step.payload.state, model: Config.current.model, questions };
    const rec = {
      kind: 'action', payload, response: null, error: null, action: null,
      from: conflict.action, role: conflict.role, ref: conflict.ref, why: conflict.why,
    };
    step.followUps.push(rec);
    chip.textContent = step.n + ' · 动作与元素（' + conflict.role + '）不兼容，补问动作';
    updateStepCard(step, nodes);

    const jev = await callJev(payload);
    if (!jev.ok) { rec.error = jev.error; return false; }
    rec.response = jev.data;

    let action;
    try { action = AutoCore.parseActionAnswer(jev.data.answers || {}); }
    catch (e) { rec.error = '决策解析失败：' + ((e && e.message) || String(e)); return false; }
    if (!questions['动作'].criteria[action]) { rec.error = 'Jev 返回了不在候选里的动作：' + action; return false; }
    rec.action = action;

    /* 补问后仍不兼容（例如又选了另一个该元素上不可能的动作）：不发命令，记失败步 */
    const next = Object.assign({}, step.decision, { action });
    const again = AutoCore.checkActionRole(next, refRoles);
    if (again.conflict) { rec.error = '补问后仍选了不兼容的动作：' + action; return false; }
    step.decision = next;
    return true;
  }

  /* ---------- 文本补问：动作 + 参数落定后，同一步内补问「文本」一题 ----------
   * 文本不再随首轮作答（因子化 4 题拼出过 select 下拉框 "王小明" 的嵌合决策）：
   * 现在候选只服务已确定的动作 —— select 给下拉框真实选项名、press 给变量 ∪ 键名、
   * 其余给变量池，可选文本动作附「无」。builder 返回 null（无需文本 / 零候选）
   * 时不发请求，调用方据此记确定性失败步。
   * 与前两个补问的分工：param 改「参数」、action 改「动作」、这个补「文本」。 */
  async function resolveTextFollowUp(step, nodes, chip, refLabels) {
    const questions = AutoCore.buildTextFollowUp({
      action: step.decision.action, param: step.decision.param,
      snapshot: step.snapshot, variables: runCfg.variables,
      refLabel: refLabels[step.decision.param] || '',
    });
    if (!questions) return false;   // 无需文本不会进来；零候选 = 配置性缺失，由调用方记失败步

    const payload = { state: step.payload.state, model: Config.current.model, questions };
    /* 注意字段名：ctxRevision 用 r.action 判断「动作补问已落定」，text 记录的动作只是
     * 上下文 —— 建记录时就填 action 会让卡片在补问飞行中渲染一次「未返回」后
     * 再也不刷新（revision 不再变化）。上下文用独立的 forAction。 */
    const rec = { kind: 'text', payload, response: null, error: null, text: null, forAction: step.decision.action };
    step.followUps.push(rec);
    chip.textContent = step.n + ' · 补问文本（动作 ' + step.decision.action + ' 已定）';
    updateStepCard(step, nodes);

    const jev = await callJev(payload);
    if (!jev.ok) { rec.error = jev.error; return false; }
    rec.response = jev.data;

    let text;
    try { text = AutoCore.parseTextAnswer(jev.data.answers || {}); }
    catch (e) { rec.error = '决策解析失败：' + ((e && e.message) || String(e)); return false; }
    if (!questions['文本'].criteria[text]) { rec.error = 'Jev 返回了不在候选里的文本：' + text; return false; }
    rec.text = text;

    step.decision = Object.assign({}, step.decision, { text });
    return true;
  }

  /* ---------- 截图（操作前，带元素标注） ----------
   * 图来自 server 的 screenshot（动作前拍），标注在这里用 canvas 画到图上 ——
   * 被驱动的浏览器窗口里不留任何痕迹，标注只存在于可视化页面展示的这张图里。
   * 几何换算（CSS 像素 → 图像像素）由 anno.js 负责：截图是设备像素、元素矩形是 CSS
   * 像素，差一个 deviceScaleFactor，而那由窗口方案决定、不能假设 1:1。 */
  async function takeShot(step, name, ref) {
    const r = await apiJson('/api/browser/screenshot', { name, ref: ref || null });
    if (!r.ok || !r.dataUrl) return false;
    if (!r.rect || !r.viewport || !window.Anno) {
      step.screenshot = r.dataUrl;              /* 无元素可标（goto / press / 终止帧）就显示原图 */
      step.anno = null;
      return true;
    }
    const composed = await Anno.compose(r.dataUrl, r.rect, r.viewport, step.n);
    step.screenshot = composed.dataUrl;
    if (composed.box) {
      const b = composed.box;
      /* 几何落进 step.anno 与 img 的 data-*：导出记录里有据可查，E2E 也据此在
       * 「人看到的那张图」上取样，证明标注真的画进去了（页面里没有任何痕迹） */
      step.anno = {
        ref: ref,
        rect: r.rect,
        viewport: r.viewport,
        box: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) },
        badge: { x: Math.round(b.center.x), y: Math.round(b.center.y) },
      };
    } else {
      step.anno = { ref: ref, error: composed.error };
      step.annoError = composed.error;
    }
    return true;
  }

  /* 本步要操作的元素的 ref（用于标注）：终止动作与「无操作」没有目标，返回 null。
   * 「生成输入」的目标是 decision.param，其余动作走 planExecution，但这里只需要 ref，
   * 可以直接用 decision.param（与 planExecution 的 ref 同源）。 */
  function assignRef(decision) {
    if (!decision) return null;
    if (AutoCore.TERMINAL_TOOLS[decision.action] || decision.action === '无操作') return null;
    return /^e[A-Za-z0-9_-]+$/.test(String(decision.param || '')) ? decision.param : null;
  }

  /* ---------- 执行决策 ---------- */
  async function executeDecision(step, decision, refLabels) {
    /* 终止动作 */
    if (AutoCore.TERMINAL_TOOLS[decision.action]) {
      step.terminal = decision.action;
      return { terminal: decision.action };
    }
    /* 无操作 */
    if (decision.action === '无操作') {
      step.exec = { ok: true, elapsedMs: 0, cmd: null };
      return {};
    }
    /* 生成输入：LLM 单步闭环 */
    if (decision.action === '生成输入') {
      const L = { messages: null, raw: null, text: null, error: null };
      step.llm = L;
      if (!Config.llm.configured()) {
        L.error = '未配置生成模型：请点右上角「⚙ 配置」填写「生成模型」槽位（Base URL / API Key / 模型名）';
        step.exec = { ok: false, error: L.error, elapsedMs: 0, cmd: null };
        return {};
      }
      const m = AutoCore.buildLlmMessages({
        goal: runCfg.goal,
        url: step.pageInfo.url || runCfg.url,
        title: step.pageInfo.title,
        refLabel: refLabels[decision.param] || decision.param,
        snapshot: step.snapshot,
        ref: decision.param,
        recentSteps: history,
      });
      L.messages = m.messages;
      const llmCfg = Config.llm.get();
      let r;
      try {
        r = await callLlm({ model: llmCfg.model, messages: m.messages, temperature: m.temperature, max_tokens: m.max_tokens }, llmCfg);
      } catch (e) {
        L.error = '生成模型调用失败：' + ((e && e.message) || String(e));
        step.exec = { ok: false, error: L.error, elapsedMs: 0, cmd: null };
        return {};
      }
      L.raw = r;
      const content = r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content;
      if (!content) { L.error = '生成模型响应中没有文本内容'; step.exec = { ok: false, error: L.error, cmd: null }; return {}; }
      L.text = AutoCore.sanitizeLlmText(content);
      if (!L.text) { L.error = '生成文本清洗后为空'; step.exec = { ok: false, error: L.error, cmd: null }; return {}; }
      /* 用生成文本 fill 到目标 ref */
      const t0 = Date.now();
      const act = await apiJson('/api/browser/act', { command: 'fill', ref: decision.param, text: L.text });
      step.exec = { cmd: cmdDisplay('fill', decision.param, L.text), elapsedMs: Date.now() - t0, ok: Boolean(act.ok), error: act.ok ? null : act.error };
      if (act.ok) step.generatedText = L.text;
      return {};
    }
    /* 常规动作 */
    let plan;
    try {
      plan = AutoCore.planExecution(decision, runCfg.variables);
    } catch (e) {
      step.exec = { ok: false, error: (e && e.message) || String(e), cmd: null };
      return {};
    }
    /* select 选项预检：目标选项不在下拉框名单内就不发命令（实测事故：把「搜索
     * 王小明」规划成「订单状态下拉框选“王小明”」，浏览器报 option not found 后
     * 模型连续重复同一错误组合）。报错带可选清单与纠偏提示，喂给下一轮决策。 */
    if (plan.op === 'select' && plan.text != null) {
      const chk = AutoCore.checkSelectOption(step.snapshot, plan.ref, plan.text);
      if (chk.conflict) {
        step.exec = { cmd: cmdDisplay(plan.op, plan.ref, plan.text), elapsedMs: 0, ok: false, error: chk.error };
        return {};
      }
    }
    const t0 = Date.now();
    const act = await apiJson('/api/browser/act', { command: plan.op, ref: plan.ref, text: plan.text });
    step.exec = {
      cmd: cmdDisplay(plan.op, plan.ref, plan.text),
      elapsedMs: Date.now() - t0,
      ok: Boolean(act.ok),
      error: act.ok ? null : act.error,
    };
    return {};
  }

  /* ---------- 状态条 / 计时 ---------- */
  function setProgress(n) {
    els.progress.textContent = '第 ' + n + ' / ' + runCfg.maxSteps + ' 步';
    els.progress.title = '';   /* 清上一轮结束原因，免得悬停看到过期解释 */
  }
  function startTimer() {
    startTs = Date.now();
    timerId = setInterval(() => {
      els.elapsed.textContent = Math.round((Date.now() - startTs) / 1000) + 's';
    }, 1000);
  }
  function stopTimer() {
    if (timerId) clearInterval(timerId);
    timerId = null;
  }

  /* ---------- 主循环 ---------- */
  async function start() {
    if (running) return toast('已有循环在运行');
    const goal = els.goal.value.trim();
    const url = els.url.value.trim();
    const maxSteps = Math.max(1, Math.min(50, Number(els.maxSteps.value) || 15));
    const invalid = validateForm();
    if (invalid) return toast(invalid);
    if (!Config.current.key.trim()) return toast('请先在右上角「⚙ 配置」填写 Jev 的 API Key');

    /* 同步占坑（设计 §11：同会话仅一个循环）：必须在任何 await 之前，
     * 否则 probeEngine 的网络间隙内双击会并发两个 runLoop */
    running = true;
    els.start.disabled = true;
    els.editTask.disabled = true;   /* 运行中锁配置，避免改到一半参数与 runCfg 不一致 */

    let engineOk = false;
    try {
      engineOk = await probeEngine();
    } finally {
      if (!engineOk) {
        running = false;
        els.start.disabled = false;
        els.editTask.disabled = false;
      }
    }
    if (!engineOk) return toast('浏览器引擎不可用，请先按提示安装 playwright-cli');

    abortFlag = false; finished = false;
    steps = []; history = []; consecutiveFails = 0; unfinishedHistory = [];
    failedRefs = Object.create(null); refPageUrl = '';
    const plan = windowPlan();
    runCfg = {
      goal, url, maxSteps, variables: collectVars(), screenshotOn: els.screenshot.checked,
      browser: els.browser.value, window: plan,
      paramTrim: Config.paramTrim.get(),
    };
    runId = AutoCore.newRunId();
    runStartedAt = new Date().toISOString();
    endReasonText = ''; saveFailedOnce = false;

    els.stop.hidden = false;
    els.statusBar.hidden = false;
    els.runPill.className = 'status-pill busy';
    els.runPill.textContent = '运行中';
    els.runPill.dataset.state = 'running';
    els.timeline.hidden = false;
    els.timeline.innerHTML = '';
    buildStage();
    els.exportBtn.hidden = true;
    setProgress(0);
    startTimer();

    try {
      await runLoop();
    } finally {
      running = false;
      stopTimer();
      els.start.disabled = false;
      els.editTask.disabled = false;
      els.stop.hidden = true;
      /* 兜底：runLoop 抛异常时 finishRun 尚未执行，走同一条结论文案，
       * 不能再像以前那样把 pill 一律改写为「已结束」—— 那会盖掉真正的结论。 */
      if (!finished) finishRun({ done: false, state: 'error', reason: '运行异常中断' });
    }
  }

  /* ---------- 结束态 ----------
   * 展示层唯一出口：状态条（pill = 结论 + 共 N 步 + 用时）。
   * 曾经这里还额外插一条 run-banner、并在标题行写 #autoSummary，三处复述同一件事，
   * 且计时器与 banner 各算一次导致「17s / 用时 18s」同屏打架 —— 已合并到这里。 */
  const END_STATES = {
    done:    { label: '任务已完成',   tone: 'done' },
    aborted: { label: '用户中止',     tone: 'warn' },
    giveup:  { label: 'Jev 放弃任务', tone: 'warn' },
    limit:   { label: '已达步数上限', tone: 'warn' },
    fails:   { label: '连续执行失败', tone: 'warn' },
    error:   { label: '出错',         tone: 'error' },
  };

  function finishRun(t) {
    if (finished) return;
    finished = true;
    stopTimer();                                  /* 停在最终值，与下面读的 elapsed 同源 */
    const s = END_STATES[t.state] || END_STATES.error;
    const secs = Math.round((Date.now() - startTs) / 1000);
    /* 人类可读的结束原因，供落盘 meta.endReason；必须在 const s 之后（TDZ） */
    endReasonText = t.reason || s.label;
    els.runPill.className = 'status-pill ' + s.tone;
    els.runPill.textContent = s.label;
    els.runPill.dataset.state = t.state || 'error';
    els.progress.textContent = '共 ' + steps.length + ' 步';
    els.progress.title = t.reason || '';
    els.elapsed.textContent = secs + 's';
    endText = steps.length + ' 步 · ' + s.label;
    els.exportBtn.hidden = false;
    saveRun(true);
    toast(t.reason || s.label);
  }

  async function runLoop() {
    /* 打开浏览器（内核可选；窗口方案随请求带给 server：全屏=原生最大化，固定尺寸=resize）。
     * 先静默关闭残留会话：上轮结束后浏览器可能还开着，已开会话上再 open 会报错；
     * 顺带保证每轮拿到全新的内存态页面（如演示邮箱）。 */
    await apiJson('/api/browser/close', {});
    addChip('open · ' + shortUrl(runCfg.url), 'current', null).dataset.chip = 'open';
    const opened = await apiJson('/api/browser/open', Object.assign(
      { url: runCfg.url, browser: runCfg.browser }, runCfg.window));
    markChip('open', opened.ok ? 'ok' : 'error');
    if (!opened.ok) {
      finishRun({ done: false, state: 'error', reason: '打开浏览器失败：' + opened.error });
      return;
    }
    if (opened.fullscreen === false) toast('全屏未生效（已退化为最大化窗口）：' + (opened.fullscreenError || ''));
    else if (opened.resized === false) toast('窗口尺寸调整失败：' + (opened.resizeError || ''));
    runCfg.browserUsed = opened.browser;
    runCfg.fullscreenUsed = opened.fullscreen === true;

    let lastResult = '';
    for (let n = 1; n <= runCfg.maxSteps; n++) {
      if (abortFlag) { finishRun({ done: false, state: 'aborted', reason: '用户中止' }); return; }
      setProgress(n);

      /* ① 快照 —— 原生弹窗（modal state）期间 snapshot 会被 playwright 拒绝，
       * 这不是故障：转成「弹窗步」，只问 Jev 一道「动作」（接受 / 取消弹窗），
       * 处理完弹窗下一轮就能正常快照（实测：mailbox 删除触发 confirm 即走这条路径） */
      const snap = await apiJson('/api/browser/snapshot', {});
      let dialogMode = false;
      let snapText = '';
      if (!snap.ok || typeof snap.snapshot !== 'string') {
        const snapErr = String((snap && snap.error) || '无快照内容');
        if (!AutoCore.isModalSnapshotError(snapErr)) {
          finishRun({ done: false, state: 'error', reason: '获取页面快照失败：' + snapErr });
          return;
        }
        dialogMode = true;
        snapText = AutoCore.DIALOG_SNAPSHOT_NOTE;
      } else {
        snapText = snap.snapshot;
      }
      /* ② 当前页信息（工程自动执行；弹窗期间 tab-list 同样可能被拒，复用上一步的页面信息） */
      let pageInfo;
      if (dialogMode) {
        const prev = steps[steps.length - 1];
        pageInfo = prev ? prev.pageInfo : { url: runCfg.url, title: '' };
      } else {
        const info = await apiJson('/api/browser/page-info', {});
        pageInfo = info.ok ? { url: info.url, title: info.title } : { url: runCfg.url, title: '' };
      }

      /* ③④ 组装 state + 问题（前端是唯一构造者）并调用 Jev */
      if (pageInfo.url !== refPageUrl) {
        /* 跳转后 ref 编号会重排，失败记忆只在同一页面内有效 */
        refPageUrl = pageInfo.url;
        Object.keys(failedRefs).forEach((k) => { delete failedRefs[k]; });
      }
      const refLabels = dialogMode ? {} : AutoCore.refCriteria(snapText);   // 展示用：始终是全量 ref
      const refRoles = dialogMode ? {} : AutoCore.refRoles(snapText);       // 动作 × 角色兼容性校验用
      const state = AutoCore.buildState({
        goal: runCfg.goal, url: pageInfo.url, title: pageInfo.title,
        history, lastResult, snapshot: snapText,
      });
      /* 「参数」题候选：≤250 个 ref 原样透传，超限才按相关性裁剪（高级参数可关）；
       * 弹窗步没有快照，只问一道「动作」（dialog-accept / dialog-dismiss） */
      let param = { criteria: {}, meta: { trimmed: false } };
      let questions;
      if (dialogMode) {
        questions = AutoCore.buildDialogQuestions();
      } else {
        param = AutoCore.paramCriteria({
          snapshot: snapText, goal: runCfg.goal,
          avoidRefs: Object.keys(failedRefs), paramTrim: runCfg.paramTrim,
        });
        questions = AutoCore.buildQuestions({ snapshot: snapText, param });
      }
      const payload = { state, model: Config.current.model, questions };

      const step = {
        n, label: '第 ' + n + ' 步', decision: null, payload, response: null, jevError: null,
        exec: null, llm: null, screenshot: null, terminal: null, annotated: null,
        pageInfo, snapshot: snapText, refLabels, historyLine: null, generatedText: null,
        trim: param.meta, followUps: [], trimNote: null,
      };
      steps.push(step);
      const nodes = newStepCard(step);
      const chip = addChip(n + ' · …', 'current', n);
      chip.dataset.chip = String(n);
      chip.textContent = n + ' · 决策中';

      const jev = await callJev(payload);
      if (!jev.ok) {
        step.jevError = jev.error;
        chip.textContent = n + ' · Jev 失败'; markChip(n, 'error');
        updateStepCard(step, nodes);
        finishRun({ done: false, state: 'error', reason: jev.error });
        return;
      }
      step.response = jev.data;

      /* ⑤ 决策解析（弹窗步只有一道「动作」题，形状与动作补问同一族） */
      try {
        if (dialogMode) {
          const action = AutoCore.parseActionAnswer(jev.data.answers || {});
          if (!questions['动作'].criteria[action]) throw new Error('Jev 返回了非弹窗处理动作：' + action);
          step.decision = { action: action, param: null, text: null, unfinished: null };
        } else {
          step.decision = AutoCore.parseDecision(jev.data.answers || {});
        }
      } catch (e) {
        step.exec = { ok: false, error: '决策解析失败：' + ((e && e.message) || String(e)), cmd: null };
      }

      if (step.decision) {
        step.label = dialogMode
          ? '处理弹窗 · ' + step.decision.action
          : AutoCore.describeDecision(step.decision, refLabels, runCfg.variables);
        /* 弹窗步没有「未完成」题，不参与完成度收敛（两连 <0.2 提前终止的判定） */
        if (step.decision.unfinished != null) unfinishedHistory.push(step.decision.unfinished);
        chip.textContent = n + ' · ' + step.label;
      } else {
        chip.textContent = n + ' · 决策异常';
      }
      updateStepCard(step, nodes);

      /* ⑤b 候选裁剪的兜底项「其他」：同一步内补问下一批（最多 maxTranches 批） */
      if (step.decision) {
        const norm = AutoCore.normalizeParam(step.decision);
        if (norm.note) {
          step.decision = Object.assign({}, step.decision, { param: norm.param });
          step.trimNote = norm.note;
        } else if (AutoCore.isRefMore(step.decision.param)) {
          if (!param.meta.trimmed) {
            /* 没启用裁剪时候选里根本没有「其他」，这是无效答案，不能拿它去补问 */
            step.exhausted = true;
            step.exec = { ok: false, error: 'Jev 选了候选里没有的「其他」（当前页面未触发候选裁剪）', cmd: null };
            step.label = step.decision.action + '【' + AutoCore.REF_MORE + ' · 无效选项】';
            chip.textContent = n + ' · ' + step.label;
          } else if (await resolveMoreBatches(step, nodes, chip)) {
            step.label = AutoCore.describeDecision(step.decision, refLabels, runCfg.variables);
            chip.textContent = n + ' · ' + step.label;
          } else {
            /* 失败原因取补问记录里的真实原因（Jev 调用失败 / 解析失败 / 答案不在候选里…） */
            const last = step.followUps[step.followUps.length - 1] || {};
            step.exhausted = true;
            step.exec = { ok: false, error: last.error || '候选已展开到最后一批仍未命中目标元素', cmd: null };
            step.label = step.decision.action + '【' + AutoCore.REF_MORE + ' · 补问未命中】';
            chip.textContent = n + ' · ' + step.label;
          }
        }
        updateStepCard(step, nodes);
      }

      /* ⑤c 动作 × 元素角色不兼容（如 select 配 button）：同一步内补问「动作」，
       * 补不回来就记失败步 —— 两种情况都不把命令发给浏览器 */
      if (step.decision && !step.exhausted) {
        const conflict = AutoCore.checkActionRole(step.decision, refRoles);
        if (conflict.conflict) {
          const fixed = await resolveActionConflict(step, nodes, chip, conflict, refRoles);
          if (fixed) {
            step.label = AutoCore.describeDecision(step.decision, refLabels, runCfg.variables);
            chip.textContent = n + ' · ' + step.label;
          } else {
            const last = step.followUps[step.followUps.length - 1] || {};
            step.exhausted = true;
            step.exec = {
              ok: false, cmd: null,
              error: last.error || ('动作 ' + conflict.action + ' 与元素角色 ' + conflict.role + ' 不兼容'),
            };
            /* 这条命令从没发出去过，元素本身没问题 —— 别让它背 failedRefs 的降权
             * （那会把真正的目标挤出候选首批，逼出多余的补问） */
            step.refNotTried = true;
            step.label = step.decision.action + '【与元素角色不兼容】';
            chip.textContent = n + ' · ' + step.label;
          }
          updateStepCard(step, nodes);
        }
      }

      /* ⑤d 文本补问：动作 + 参数都落定后才问「文本」（候选按动作分型 —— select 是
       * 真实选项名，杜绝「在订单状态下拉框选王小明」那类嵌合决策）。
       * 弹窗步跳过：dialog-accept 的 prompt 文本本就不可达，弹窗步也没有文本通道。
       * 构造不出候选（必填动作零候选）或 Jev 答错 → 记失败步，命令不发。 */
      if (step.decision && !step.exhausted && !dialogMode
        && AutoCore.needText(step.decision.action)
        && !AutoCore.TERMINAL_TOOLS[step.decision.action]) {
        const textOk = await resolveTextFollowUp(step, nodes, chip, refLabels);
        if (textOk) {
          step.label = AutoCore.describeDecision(step.decision, refLabels, runCfg.variables);
          chip.textContent = n + ' · ' + step.label;
        } else {
          const last = step.followUps.length ? step.followUps[step.followUps.length - 1] : null;
          step.exhausted = true;
          step.exec = {
            ok: false, cmd: null,
            error: (last && last.error) || ('动作 ' + step.decision.action + ' 需要文本，但没有可问的候选（变量池为空'
              + (step.decision.action === 'select' ? ' 且未能读出该下拉框的选项名单' : '') + '）'),
          };
          /* 命令从未发出，元素本身没问题 —— 与 ⑤c 同理不背 failedRefs 的降权 */
          step.refNotTried = true;
          step.label = step.decision.action + '【缺少文本取值】';
          chip.textContent = n + ' · ' + step.label;
        }
        updateStepCard(step, nodes);
      }

      /* ⑦ 单步确认（设计 §10/§11：单步确认是安全阀，终止判定同样要过门） */
      if (cadence() === 'single') {
        const choice = await awaitConfirm(nodes.card);
        if (choice === 'abort') { abortFlag = true; markChip(n, 'pending'); step.exec = { skipped: true }; updateStepCard(step, nodes); finishRun({ done: false, state: 'aborted', reason: '用户中止' }); return; }
        if (choice === 'skip') {
          step.exec = { skipped: true };
          step.historyLine = n + '. ' + step.label + ' · 用户跳过';
          history.push(step.historyLine);
          lastResult = '用户跳过（未执行）';
          markChip(n, 'pending');
          updateStepCard(step, nodes);
          saveRun(false);
          continue;
        }
      }

      /* 终止动作：截图留证后收尾（放在确认门之后，单步模式下用户可选择跳过）
       * 终止判定不是「一步操作」，所以在时间线上不留 chip（结论由状态条承担）；
       * 卡片保留 —— 它的最终页面截图是完成证据。 */
      if (step.decision && AutoCore.TERMINAL_TOOLS[step.decision.action]) {
        const doneTerminal = step.decision.action === '任务已完成';
        step.terminal = step.decision.action;
        step.label = step.decision.action;
        if (runCfg.screenshotOn) { await takeShot(step, 'step-' + n + '-final'); }
        updateStepCard(step, nodes);
        chip.remove();
        history.push(AutoCore.formatHistoryStep(n, step.label, doneTerminal, null));
        finishRun({
          done: doneTerminal,
          state: doneTerminal ? 'done' : 'giveup',
          reason: 'Jev 判定：' + step.terminal,
        });
        return;
      }

      /* ⑧ 操作前截图 + 标注
       * 位置与截图都取自动作之前：元素此刻必定还在、位置唯一确定。放到动作后取位置的话，
       * 演示页「归档」「发货」点完就重渲染、ref 立刻失效，一条都标不出来，而且删行会让
       * 后续行往上顶、环落到相邻行上（两种毛病都是实测过的）。标注画在图上，页面不留痕迹。 */
      const noop = step.decision && step.decision.action === '无操作';
      /* 弹窗步不截图：modal state 下 screenshot 同样被拒，且没有页面元素可标 */
      if (runCfg.screenshotOn && !noop && !dialogMode) {
        await takeShot(step, 'step-' + n, assignRef(step.decision));
      }

      /* ⑨ 执行 */
      if (step.decision && !step.exhausted) {
        const r = await executeDecision(step, step.decision, refLabels);
        if (r.terminal) { /* 上文已处理 terminal 路径，此处不会到 */ }
      }
      const ok = Boolean(step.exec && step.exec.ok);
      if (!ok && !noop && !step.refNotTried && step.decision && /^e[A-Za-z0-9_-]+$/.test(String(step.decision.param || ''))) {
        failedRefs[step.decision.param] = 1;
      }

      /* ⑩ 历史与失败计数 */
      step.historyLine = AutoCore.formatHistoryStep(n, step.label, ok, step.exec && step.exec.error);
      history.push(step.historyLine);
      lastResult = ok
        ? (step.generatedText ? '成功（生成并填入：' + step.generatedText.slice(0, 60) + '）' : '成功')
        : '失败：' + String((step.exec && step.exec.error) || '未知错误').slice(0, 120);
      consecutiveFails = (ok || noop || (step.exec && step.exec.skipped)) ? 0 : consecutiveFails + 1;

      markChip(n, ok ? 'ok' : 'error');
      updateStepCard(step, nodes);
      saveRun(false);

      /* ⑪ 终止判断 */
      const t = AutoCore.shouldTerminate({
        steps: n, maxSteps: runCfg.maxSteps,
        unfinishedHistory, consecutiveFails, aborted: abortFlag,
      });
      if (t) { finishRun(t); return; }

      await sleep(STEP_GAP_MS);
    }
    finishRun({ done: false, state: 'limit', reason: '达到步数上限（' + runCfg.maxSteps + '）' });
  }

  /* ---------- 导出 ---------- */
  function exportRun() {
    if (!steps.length) return toast('还没有可导出的运行记录');
    const record = {
      exportedAt: new Date().toISOString(),
      goal: runCfg && runCfg.goal,
      startUrl: runCfg && runCfg.url,
      browser: runCfg && runCfg.browserUsed,
      window: runCfg ? runCfg.window : null,
      variables: runCfg ? runCfg.variables : [],
      maxSteps: runCfg && runCfg.maxSteps,
      screenshotOn: runCfg && runCfg.screenshotOn,
      paramTrim: runCfg ? AutoCore.normalizeTrim(runCfg.paramTrim) : null,
      jevModel: Config.current.model,
      llmModel: Config.llm.configured() ? Config.llm.get().model : null,
      summary: endText,
      steps: steps.map((s) => ({
        n: s.n,
        label: s.label,
        pageInfo: s.pageInfo,
        decision: s.decision,
        request: s.payload,
        response: s.response,
        jevError: s.jevError,
        exec: s.exec,
        anno: s.anno || null,
        llm: s.llm ? { messages: s.llm.messages, response: s.llm.raw, text: s.llm.text, error: s.llm.error } : null,
        screenshot: s.screenshot || null,
        historyLine: s.historyLine,
        trim: s.trim || null,
        trimNote: s.trimNote || null,
        followUps: (s.followUps || []).map((r) => ({
          kind: r.kind || 'param', request: r.payload, response: r.response,
          batch: r.batch, param: r.param, action: r.action, text: r.text,
          forAction: r.forAction,
          from: r.from, role: r.role, ref: r.ref,
          why: r.why, error: r.error,
        })),
      })),
    };
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const blob = new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'jev-auto-run-' + ts + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('已导出运行记录（' + steps.length + ' 步）');
  }

  /* ---------- 模式切换 ---------- */
  function switchMode(mode) {
    cancelTaskModal();   /* 切走时丢弃未保存的编辑，杜绝「摘要与弹窗输入不一致」 */
    Array.from(els.modeSeg.querySelectorAll('.seg-btn')).forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
    els.panel.hidden = mode !== 'auto';
    els.presetCard.hidden = mode === 'auto';
    els.mainGrid.hidden = mode === 'auto';
    if (els.apiSpec) els.apiSpec.hidden = mode === 'auto';
    /* 引擎状态常驻顶栏，但它只对 auto 模式有意义 —— Demo 模式下收起，别当噪声 */
    els.pill.hidden = mode !== 'auto';
    if (mode === 'auto') probeEngine();
  }

  /* ---------- 事件与初始化 ---------- */
  function bindEvents() {
    els.modeSeg.querySelectorAll('.seg-btn').forEach((b) => {
      b.addEventListener('click', () => switchMode(b.dataset.mode));
    });
    els.start.onclick = start;
    els.stop.onclick = () => { abortFlag = true; toast('将在当前步骤后中止…'); };
    els.closeBrowser.onclick = async () => {
      const r = await apiJson('/api/browser/close', {});
      toast(r.ok ? '浏览器已关闭' : '关闭失败：' + (r.error || ''));
    };
    els.addVar.onclick = () => addVarRow('', '');
    els.editTask.onclick = openTaskModal;
    els.taskModalClose.onclick = cancelTaskModal;
    els.taskCancel.onclick = cancelTaskModal;
    els.taskSave.onclick = saveTaskModal;
    els.taskModal.addEventListener('click', (e) => { if (e.target === els.taskModal) cancelTaskModal(); });
    /* 弹窗内：Esc 取消、Ctrl/⌘+Enter 保存、Tab 圈在弹窗里不外溢 */
    els.taskModal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { cancelTaskModal(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); saveTaskModal(); return; }
      if (e.key !== 'Tab') return;
      const nodes = Array.from(els.taskModal.querySelectorAll(
        'button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )).filter((n) => !n.disabled && n.offsetParent !== null);
      if (!nodes.length) return;
      const first = nodes[0]; const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    els.exportBtn.onclick = exportRun;
    /* 轮播键盘切换（输入控件聚焦、或编辑弹窗打开时不抢按键） */
    document.addEventListener('keydown', (e) => {
      if (els.panel.hidden || !steps.length || !els.taskModal.hidden) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const t = e.target;
      if (t && /^(input|textarea|select)$/i.test(t.tagName)) return;
      gotoStep(view.idx + (e.key === 'ArrowRight' ? 1 : -1), true);
      e.preventDefault();
    });
  }

  function init() {
    renderVars();
    primeScreenOptions();
    /* 默认走一个场景：别让用户面对空白表单开场 */
    if (!els.goal.value.trim() && !els.url.value.trim() && SCENARIOS.length) {
      applyScenario(SCENARIOS[0].id, true);
    }
    renderSummary();
    bindEvents();
    probeEngine();
  }

  return { init: init };
})();

Auto.init();
