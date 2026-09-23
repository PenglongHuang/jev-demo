/* ===================== Auto 浏览器模式 · 前端循环 =====================
 * 设计文档 §2/§9/§10：循环在本页面 JS 中运行；server 只 spawn playwright-cli
 * 和纯透传代理。前端是 state/问题的唯一构造者 —— 步骤卡展示的请求体与真实
 * 发出的 payload 是同一个对象（可见性硬原则）。
 *
 * 依赖：util.js（escapeHtml/pct/toast）、auto-core.js（AutoCore）、app.js（Config）
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
    demoPage: document.getElementById('autoDemoPage'),
    vars: document.getElementById('autoVars'),
    addVar: document.getElementById('autoAddVar'),
    maxSteps: document.getElementById('autoMaxSteps'),
    screenshot: document.getElementById('autoScreenshot'),
    closeBrowser: document.getElementById('autoCloseBrowser'),
    stop: document.getElementById('autoStop'),
    start: document.getElementById('autoStart'),
    flow: document.getElementById('autoFlow'),
    summary: document.getElementById('autoSummary'),
    exportBtn: document.getElementById('autoExport'),
    statusBar: document.getElementById('autoStatus'),
    runPill: document.getElementById('autoRunPill'),
    progress: document.getElementById('autoProgress'),
    elapsed: document.getElementById('autoElapsed'),
    timeline: document.getElementById('autoTimeline'),
    presetCard: document.getElementById('presetCard'),
    mainGrid: document.getElementById('mainGrid'),
    modeSeg: document.getElementById('modeSeg'),
  };

  /* ---------- 状态 ---------- */
  let running = false;
  let abortFlag = false;
  let steps = [];            // 每步完整记录（导出用）
  let history = [];          // 已完成步骤（进 state 的短句）
  let consecutiveFails = 0;
  let unfinishedHistory = [];
  let runCfg = null;
  let startTs = 0;
  let timerId = null;
  let finished = false;

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
  async function probeEngine() {
    els.pill.textContent = '引擎检测中…';
    els.pill.className = 'status-pill';
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      const h = await res.json();
      const d = h.browserDetail || {};
      if (d.available) {
        els.pill.textContent = '✅ 引擎就绪 ' + (d.version || '');
        els.pill.className = 'status-pill ok';
        els.installHint.hidden = true;
        return true;
      }
      const msg = d.reason === 'not-installed' ? '⚠ 引擎未安装' : '⚠ 引擎不可用';
      els.pill.textContent = msg;
      els.pill.className = 'status-pill error';
      els.installHint.hidden = false;
      return false;
    } catch (_) {
      els.pill.textContent = '⚠ 无后端服务';
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

  /* ---------- 概率条（复用 output.js 的视觉，紧凑版） ---------- */
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
      chip.title = '跳到步骤 ' + id;
      chip.onclick = () => {
        const card = document.getElementById('stepcard-' + id);
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
    }
    els.timeline.appendChild(chip);
    return chip;
  }
  function markChip(id, cls) {
    const chip = els.timeline.querySelector('[data-chip="' + id + '"]');
    if (chip) chip.className = 'tl-chip' + (cls ? ' ' + cls : '');
  }

  /* ---------- 步骤卡 ---------- */
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
    const answers = el('div', 'step-answers');
    answers.innerHTML = '<div class="skel-wrap"><div class="skel" style="width:34%"></div><div class="skel" style="width:72%"></div><div class="skel" style="width:52%"></div></div>';
    body.appendChild(answers);
    card.appendChild(body);

    els.flow.appendChild(card);
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return { card, head, title, state, body, answers };
  }

  function decisionHtml(step) {
    const a = (step.response && step.response.answers) || {};
    const d = step.decision || {};
    const line = (k, v, p, extra) =>
      '<div class="ans-line"><span class="ans-k">' + k + '</span><span class="ans-v">' + escapeHtml(v) + (extra ? ' <span class="ans-p">' + escapeHtml(extra) + '</span>' : '') + '</span>' +
      (p != null ? '<span class="ans-p">' + p + '</span>' : '') + '</div>';

    const pOf = (name, key) => {
      const pr = a[name] && a[name].probabilities;
      return pr && pr[key] != null ? pct(pr[key]) : null;
    };
    const unfinished = a['未完成'];
    const unfinishedTxt = unfinished
      ? Number(unfinished.score).toFixed(1) + ' / 4 → 未完成度 ' + (d.unfinished != null ? d.unfinished.toFixed(2) : '—')
      : '—';

    let html = '<div class="step-sub">Jev 决策</div>';
    html += line('动作', d.action || '—', pOf('动作', d.action));
    html += line('参数', d.param || '—', pOf('参数', d.param));
    if (d.text != null) html += line('文本', d.text, pOf('文本', d.text));
    html += line('未完成', unfinishedTxt, '');

    const qNames = ['动作', '参数', '文本', '未完成'];
    const colors = { 动作: 'var(--violet)', 参数: '#7c3aed', 文本: '#0d9268', 未完成: 'var(--amber)' };
    const hits = { 动作: d.action, 参数: d.param, 文本: d.text };
    html += '<details class="step-collapse" style="margin-top:6px"><summary>概率分布明细</summary>';
    qNames.forEach((name) => {
      const ans = a[name];
      if (!ans || !ans.probabilities) return;
      html += '<div class="ans-line" style="margin:4px 0"><span class="ans-k">' + name + '</span></div>';
      html += barsHtml(ans.probabilities, hits[name] != null ? hits[name] : null, colors[name]);
    });
    html += '</details>';
    return html;
  }

  function cmdDisplay(op, ref, text) {
    return 'playwright-cli ' + op + (ref ? ' ' + ref : '') + (text != null ? ' "' + text + '"' : '');
  }

  function execHtml(step) {
    const e = step.exec;
    if (!e) return '';
    let html = '<div class="step-exec"><div class="step-sub">执行</div>';
    if (e.skipped) {
      html += '<div class="exec-line">用户跳过此步（未执行）</div></div>';
      return html;
    }
    if (e.cmd) {
      html += '<div class="exec-line" style="font-family:var(--mono);font-size:12px">' + escapeHtml(e.cmd) +
        (e.elapsedMs != null ? ' <span class="exec-url">· ' + e.elapsedMs + 'ms</span>' : '') + '</div>';
    }
    if (e.ok != null) html += '<div class="exec-line">' + (e.ok ? '✓ 成功' : '✗ 失败') + '</div>';
    if (e.error) html += '<div class="step-err">' + escapeHtml(e.error) + '</div>';
    html += '</div>';
    return html;
  }

  function llmHtml(step) {
    const L = step.llm;
    if (!L) return '';
    let html = '<div class="llm-block"><div class="step-sub">生成输入 · LLM</div>';
    if (L.error) {
      html += '<div class="step-err">' + escapeHtml(L.error) + '</div></div>';
      return html;
    }
    html += '<details class="step-collapse"><summary>Prompt（工程组装，前端可见）</summary>' +
      '<pre class="step-pre">' + escapeHtml(L.messages.map((m) => '[' + m.role + ']\n' + m.content).join('\n\n')) + '</pre></details>';
    html += '<details class="step-collapse"><summary>模型原始响应</summary>' +
      '<pre class="step-pre">' + escapeHtml(JSON.stringify(L.raw, null, 2)) + '</pre></details>';
    if (L.text) html += '<div class="llm-gen">生成文本 → ' + escapeHtml(L.text) + '</div>';
    html += '</div>';
    return html;
  }

  function contextHtml(step) {
    if (!step.payload) return '';
    const stateText = relaxedStringify(step.payload.state);
    const qText = relaxedStringify(step.payload.questions);
    const respText = step.response ? JSON.stringify({
      model: step.response.model, answers: step.response.answers,
      usage: step.response.usage, _latency_ms: step.response._latency_ms,
    }, null, 2) : '（调用失败，无响应）';
    return '<details class="step-collapse"><summary>① 构造的 state（含全量快照，可复制）</summary>' +
      '<pre class="step-pre tall">' + escapeHtml(stateText) + '</pre></details>' +
      '<details class="step-collapse"><summary>② 构造的 4 道问题（criteria 明细）</summary>' +
      '<pre class="step-pre tall">' + escapeHtml(qText) + '</pre></details>' +
      '<details class="step-collapse"><summary>③ 发出的完整请求体（与实际 payload 同一对象）</summary>' +
      '<pre class="step-pre tall">' + escapeHtml(relaxedStringify(step.payload)) + '</pre></details>' +
      '<details class="step-collapse"><summary>④ Jev 原始响应 JSON</summary>' +
      '<pre class="step-pre">' + escapeHtml(respText) + '</pre></details>';
  }

  function updateStepCard(step, nodes) {
    nodes.title.textContent = step.label || '第 ' + step.n + ' 步';
    const e = step.exec;
    if (step.jevError) {
      nodes.state.textContent = 'Jev 调用失败';
      nodes.state.className = 'step-state error';
      nodes.answers.innerHTML = '<div class="step-err">' + escapeHtml(step.jevError) + '</div>';
    } else if (step.decision) {
      nodes.answers.innerHTML = decisionHtml(step);
      animateBars(nodes.answers);
    }
    let execZone = nodes.body.querySelector('.step-exec-slot');
    if (!execZone) {
      execZone = el('div', 'step-exec-slot');
      /* 顺序：决策区 → 执行区 → 上下文折叠区 */
      nodes.body.insertBefore(execZone, nodes.answers.nextSibling);
    }
    execZone.innerHTML = llmHtml(step) + execHtml(step);
    if (step.screenshot && !execZone.querySelector('.step-shot')) {
      const img = document.createElement('img');
      img.src = step.screenshot;
      img.className = 'step-shot';
      img.alt = '第 ' + step.n + ' 步执行后截图';
      img.onclick = () => openLightbox(step.screenshot, img.alt);
      execZone.appendChild(img);
    }
    if (!nodes.body.querySelector('.ctx-slot')) {
      const ctx = el('div', 'ctx-slot');
      ctx.innerHTML = contextHtml(step);
      nodes.body.appendChild(ctx);
    }
    if (e) {
      nodes.state.textContent = e.skipped ? '已跳过' : (e.ok ? '成功' + (e.elapsedMs != null ? ' · ' + e.elapsedMs + 'ms' : '') : '失败');
      nodes.state.className = 'step-state ' + (e.skipped ? 'warn' : e.ok ? 'ok' : 'error');
    } else if (step.terminal) {
      nodes.state.textContent = '终止 · ' + step.terminal;
      nodes.state.className = 'step-state ' + (step.terminal === '任务已完成' ? 'ok' : 'warn');
    }
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

  /* ---------- 截图 ---------- */
  async function takeShot(step, name) {
    const r = await apiJson('/api/browser/screenshot', { name });
    if (r.ok && r.dataUrl) {
      step.screenshot = r.dataUrl;
      return true;
    }
    return false;
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
    if (!goal) return toast('请先填写任务目标');
    if (!/^https?:\/\//i.test(url)) return toast('起始 URL 必须以 http:// 或 https:// 开头');
    if (!Config.current.key.trim()) return toast('请先在右上角「⚙ 配置」填写 Jev 的 API Key');

    const engineOk = await probeEngine();
    if (!engineOk) return toast('浏览器引擎不可用，请先按提示安装 playwright-cli');

    running = true; abortFlag = false; finished = false;
    steps = []; history = []; consecutiveFails = 0; unfinishedHistory = [];
    runCfg = { goal, url, maxSteps, variables: collectVars(), screenshotOn: els.screenshot.checked };

    els.start.disabled = true;
    els.stop.hidden = false;
    els.statusBar.hidden = false;
    els.runPill.className = 'status-pill busy';
    els.runPill.textContent = '运行中';
    els.timeline.hidden = false;
    els.timeline.innerHTML = '';
    els.flow.innerHTML = '';
    els.summary.textContent = '';
    els.exportBtn.hidden = true;
    setProgress(0);
    startTimer();

    try {
      await runLoop();
    } finally {
      running = false;
      stopTimer();
      els.start.disabled = false;
      els.stop.hidden = true;
      els.runPill.className = 'status-pill';
      els.runPill.textContent = '已结束';
    }
  }

  function finishRun(t) {
    if (finished) return;
    finished = true;
    const banner = el('div', 'run-banner ' + (t.done ? 'ok' : (t.level === 'error' ? 'error' : 'warn')));
    banner.innerHTML = (t.done ? '🏁 ' : '⏹ ') + '<b>' + escapeHtml(t.reason) + '</b>' +
      '<span style="margin-left:10px;color:inherit;opacity:.75">共 ' + steps.length + ' 步 · 用时 ' + Math.round((Date.now() - startTs) / 1000) + 's</span>';
    els.flow.insertBefore(banner, els.flow.firstChild);
    els.summary.textContent = steps.length + ' 步 · ' + t.reason;
    els.exportBtn.hidden = false;
    toast(t.reason);
  }

  async function runLoop() {
    /* 打开浏览器 */
    addChip('open · ' + shortUrl(runCfg.url), 'current', null).dataset.chip = 'open';
    const opened = await apiJson('/api/browser/open', { url: runCfg.url, browser: 'msedge' });
    markChip('open', opened.ok ? 'ok' : 'error');
    if (!opened.ok) {
      finishRun({ done: false, reason: '打开浏览器失败：' + opened.error, level: 'error' });
      return;
    }

    let lastResult = '';
    for (let n = 1; n <= runCfg.maxSteps; n++) {
      if (abortFlag) { finishRun({ done: false, reason: '用户中止' }); return; }
      setProgress(n);

      /* ① 快照 */
      const snap = await apiJson('/api/browser/snapshot', {});
      if (!snap.ok || typeof snap.snapshot !== 'string') {
        finishRun({ done: false, reason: '获取页面快照失败：' + ((snap && snap.error) || '无快照内容'), level: 'error' });
        return;
      }
      /* ② 当前页信息（工程自动执行） */
      const info = await apiJson('/api/browser/page-info', {});
      const pageInfo = info.ok ? { url: info.url, title: info.title } : { url: runCfg.url, title: '' };

      /* ③④ 组装 state + 问题（前端是唯一构造者）并调用 Jev */
      const refLabels = AutoCore.refCriteria(snap.snapshot);
      const state = AutoCore.buildState({
        goal: runCfg.goal, url: pageInfo.url, title: pageInfo.title,
        history, lastResult, snapshot: snap.snapshot,
      });
      const questions = AutoCore.buildQuestions({ snapshot: snap.snapshot, variables: runCfg.variables });
      const payload = { state, model: Config.current.model, questions };

      const step = {
        n, label: '第 ' + n + ' 步', decision: null, payload, response: null, jevError: null,
        exec: null, llm: null, screenshot: null, terminal: null,
        pageInfo, snapshot: snap.snapshot, historyLine: null, generatedText: null,
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
        finishRun({ done: false, reason: jev.error, level: 'error' });
        return;
      }
      step.response = jev.data;

      /* ⑤ 决策解析 */
      try {
        step.decision = AutoCore.parseDecision(jev.data.answers || {});
      } catch (e) {
        step.exec = { ok: false, error: '决策解析失败：' + ((e && e.message) || String(e)), cmd: null };
      }

      if (step.decision) {
        step.label = AutoCore.describeDecision(step.decision, refLabels, runCfg.variables);
        unfinishedHistory.push(step.decision.unfinished);
        chip.textContent = n + ' · ' + step.label;
      } else {
        chip.textContent = n + ' · 决策异常';
      }
      updateStepCard(step, nodes);

      /* 终止动作：截图留证后收尾 */
      if (step.decision && AutoCore.TERMINAL_TOOLS[step.decision.action]) {
        step.terminal = step.decision.action;
        step.label = step.decision.action;
        if (runCfg.screenshotOn) { await takeShot(step, 'step-' + n + '-final'); }
        updateStepCard(step, nodes);
        markChip(n, step.terminal === '任务已完成' ? 'ok' : 'error');
        history.push(AutoCore.formatHistoryStep(n, step.label, step.terminal === '任务已完成', null));
        finishRun({ done: step.terminal === '任务已完成', reason: 'Jev 判定：' + step.terminal });
        return;
      }

      /* ⑦ 单步确认 */
      if (cadence() === 'single') {
        const choice = await awaitConfirm(nodes.card);
        if (choice === 'abort') { abortFlag = true; markChip(n, 'pending'); step.exec = { skipped: true }; updateStepCard(step, nodes); finishRun({ done: false, reason: '用户中止' }); return; }
        if (choice === 'skip') {
          step.exec = { skipped: true };
          step.historyLine = n + '. ' + step.label + ' · 用户跳过';
          history.push(step.historyLine);
          lastResult = '用户跳过（未执行）';
          markChip(n, 'pending');
          updateStepCard(step, nodes);
          continue;
        }
      }

      /* ⑧ 执行 */
      if (step.decision) {
        const r = await executeDecision(step, step.decision, refLabels);
        if (r.terminal) { /* 上文已处理 terminal 路径，此处不会到 */ }
      }
      const ok = Boolean(step.exec && step.exec.ok);
      const noop = step.decision && step.decision.action === '无操作';

      /* ⑨ 截图 */
      if (runCfg.screenshotOn && !noop) {
        await takeShot(step, 'step-' + n);
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

      /* ⑪ 终止判断 */
      const t = AutoCore.shouldTerminate({
        steps: n, maxSteps: runCfg.maxSteps,
        unfinishedHistory, consecutiveFails, aborted: abortFlag,
      });
      if (t) { finishRun(t); return; }

      await sleep(STEP_GAP_MS);
    }
    finishRun({ done: false, reason: '达到步数上限（' + runCfg.maxSteps + '）' });
  }

  /* ---------- 导出 ---------- */
  function exportRun() {
    if (!steps.length) return toast('还没有可导出的运行记录');
    const record = {
      exportedAt: new Date().toISOString(),
      goal: runCfg && runCfg.goal,
      startUrl: runCfg && runCfg.url,
      variables: runCfg ? runCfg.variables : [],
      maxSteps: runCfg && runCfg.maxSteps,
      screenshotOn: runCfg && runCfg.screenshotOn,
      jevModel: Config.current.model,
      llmModel: Config.llm.configured() ? Config.llm.get().model : null,
      summary: els.summary.textContent,
      steps: steps.map((s) => ({
        n: s.n,
        label: s.label,
        pageInfo: s.pageInfo,
        decision: s.decision,
        request: s.payload,
        response: s.response,
        jevError: s.jevError,
        exec: s.exec,
        llm: s.llm ? { messages: s.llm.messages, response: s.llm.raw, text: s.llm.text, error: s.llm.error } : null,
        screenshot: s.screenshot || null,
        historyLine: s.historyLine,
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
    Array.from(els.modeSeg.querySelectorAll('.seg-btn')).forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
    els.panel.hidden = mode !== 'auto';
    els.presetCard.hidden = mode === 'auto';
    els.mainGrid.hidden = mode === 'auto';
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
    els.exportBtn.onclick = exportRun;
    els.demoPage.onclick = () => {
      els.url.value = location.origin + '/demo/mailbox.html';
      if (!els.goal.value.trim()) {
        els.goal.value = '在收件箱里找到招商银行信用卡中心发来的 9 月电子对账单邮件，点击那一行的「归档」按钮';
      }
      if (!els.vars.children.length) addVarRow('回车', 'Enter');
      toast('已填入内置演示页（离线可完整演示）');
    };
  }

  function init() {
    renderVars();
    bindEvents();
    probeEngine();
  }

  return { init: init };
})();

Auto.init();
