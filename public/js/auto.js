/* ===================== playwright-jev-agent · 前端循环 =====================
 * 设计文档 §2/§9/§10：循环在本页面 JS 中运行；server 只 spawn playwright-cli
 * 和纯透传代理。前端是 state/问题的唯一构造者 —— 步骤卡展示的请求体与真实
 * 发出的 payload 是同一个对象（可见性硬原则）。
 *
 * 展示层：左侧会话树（会话 → 步骤 → 模型调用）+ 右侧三视图详情（会话/步骤/行动，
 * 跟随最新步骤），概率分布、输入 state、各道问题（首轮 3 道 + 按需补问）均为结构化渲染
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
    browserMode: document.getElementById('autoBrowserMode'),
    cdpField: document.getElementById('autoCdpField'),
    cdpTarget: document.getElementById('autoCdpTarget'),
    cdpWarn: document.getElementById('autoCdpWarn'),
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
    sessDd: document.getElementById('autoSessDd'),
    sessBtn: document.getElementById('autoSessBtn'),
    /* Wave 0 冻结骨架：面板本身才是「开合开关」，#autoSessList 只是可滚的列表本体 */
    sessPanel: document.getElementById('autoSessPanel'),
    sessFilter: document.getElementById('sessFilter'),
    sessList: document.getElementById('autoSessList'),
    sessFoot: document.getElementById('sessFoot'),
    preflight: document.getElementById('autoPreflight'),
    presetCard: document.getElementById('presetCard'),
    mainGrid: document.getElementById('mainGrid'),
    apiSpec: document.getElementById('apiSpec'),
    modeSeg: document.getElementById('modeSeg'),
    editTask: document.getElementById('autoEditTask'),
    summaryBody: document.getElementById('taskSummaryBody'),
    errBar: document.getElementById('autoErrorBar'),
    errTitle: document.getElementById('autoErrorTitle'),
    errBody: document.getElementById('autoErrorBody'),
    errCopy: document.getElementById('autoErrorCopy'),
    errClose: document.getElementById('autoErrorClose'),
    taskModal: document.getElementById('taskModal'),
    taskModalClose: document.getElementById('taskModalClose'),
    taskCancel: document.getElementById('taskCancel'),
    taskSave: document.getElementById('taskSave'),
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

  /* ---------- 会话落盘（设计 §5） ---------- */
  let runId = null;            // 本轮会话 id（start 时生成）
  let runStartedAt = null;
  let saveTimer = null;
  let saveChain = Promise.resolve();  // 保存串行链：final PUT 严格晚于在途的节流保存
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
        const r = await apiJson('/api/runs/' + runId, record, { method: 'PUT' });
        if (!r.ok) throw new Error(apiErrText(r));
        saveFailedOnce = false;
        if (final) refreshRunsList();
      } catch (e) {
        console.warn('[auto] saveRun failed:', e);
        if (!saveFailedOnce) { toast('运行记录保存失败（不影响运行）：' + (e && e.message ? e.message : e)); saveFailedOnce = true; }
      }
    };
    if (final) { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } saveChain = saveChain.then(doSave); return saveChain; }
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; saveChain = saveChain.then(doSave); }, 500);
  }

  async function refreshRunsList() {
    const d = await apiJson('/api/runs', null, { cache: 'no-store' });
    runsList = (d && d.runs) || [];
    renderSessDd();
  }

  const END_LABEL = { running: '运行中' };
  /* live=true：页面上还跑着的会话（「运行中」）；live=false：列表里的落盘记录 ——
   * running 只说明落盘停在半路（刷新/关页），标「中断」 */
  function sessItemState(m, live) {
    if (m.endState === 'running') return live ? END_LABEL.running : '中断';
    return (END_STATES[m.endState] || END_STATES.error).label;
  }

  /* 时间戳 → MM-DD HH:mm（会话列表与删除确认共用；解析不出来就留空，不显示 Invalid Date） */
  function fmtWhen(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const p = (n) => (n < 10 ? '0' + n : String(n));
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* 全量条目：会话根（本页这一轮）+ 全部落盘记录。与过滤无关 —— 过滤只作用于渲染。
   * 拆开是因为过滤词一变就要按同一份数据重排，不能每次都去重算「当前会话」这条。 */
  function sessEntries() {
    const out = [];
    if (runId) {
      out.push({
        isCur: view.sess === 'current', canDel: false,
        m: {
          id: runId, goal: runCfg && runCfg.goal, startedAt: runStartedAt,
          endState: running ? 'running' : (els.runPill.dataset.state || 'error'),
          stepCount: steps.length,
        },
      });
    }
    runsList.filter((m) => m.id !== runId).forEach((m) => {
      out.push({ m, isCur: view.sess === m.id, canDel: true });
    });
    return out;
  }

  function mkSessItem(m, isCur, canDel) {
    const row = el('div', 'sess-item' + (isCur ? ' cur' : ''));
    const pick = el('button', 'pick');
    pick.type = 'button';
    pick.innerHTML = '<span class="sid"></span><span class="sg"></span><span class="st"></span>';
    pick.querySelector('.sid').textContent = m.id || '—';
    pick.querySelector('.sg').textContent = shortStr(m.goal || '（无目标）', 30);
    pick.querySelector('.st').textContent = sessItemState(m, isCur) + ' · ' + (m.stepCount || 0) + ' 步';
    pick.title = m.goal || '';
    pick.onclick = () => { els.sessPanel.hidden = true; openSession(isCur ? 'current' : m.id); };
    row.appendChild(pick);
    if (canDel) {
      const del = el('button', 'sess-del', '✕');
      del.type = 'button'; del.title = '删除该会话记录';
      del.onclick = async (e) => {
        e.stopPropagation();
        /* 自绘确认（原生 confirm 塞不下「11 步 · 任务已完成 · 09-26 23:06」这类上下文） */
        const ok = await confirmDialog({
          title: '删除会话 ' + m.id + '？',
          text: (m.stepCount || 0) + ' 步 · ' + sessItemState(m, false)
            + (fmtWhen(m.startedAt) ? ' · ' + fmtWhen(m.startedAt) : '')
            + (m.goal ? ' · ' + shortStr(m.goal, 24) : ''),
          okText: '删除',
        });
        if (!ok) return;
        const r = await apiJson('/api/runs/' + m.id, null, { method: 'DELETE' });
        /* 早先这里完全不看响应：删失败（服务在跑但磁盘写不进去）会静默无提示，
         * 用户以为删掉了、刷新一下又回来了 */
        if (!r.ok) toast('删除失败：' + apiErrText(r));
        if (view.sess === m.id) openSession('current');
        else refreshRunsList();
      };
      row.appendChild(del);
    }
    els.sessList.appendChild(row);
  }

  /* 只有「按当前过滤词渲染」这一半：过滤词一变就重跑，不重新拉数据 */
  function renderSessList() {
    if (!els.sessList) return;
    const q = (els.sessFilter ? els.sessFilter.value : '').trim().toLowerCase();
    els.sessList.innerHTML = '';
    const items = sessEntries().filter(({ m }) => !q
      || String(m.id || '').toLowerCase().indexOf(q) !== -1
      || String(m.goal || '').toLowerCase().indexOf(q) !== -1);
    if (!items.length) {
      els.sessList.appendChild(el('div', 'sess-empty', q ? '无匹配会话' : '暂无会话记录'));
      return;
    }
    items.forEach(({ m, isCur, canDel }) => mkSessItem(m, isCur, canDel));
  }

  /* ---------- 记录清理（条目 8 的前端半边）：面板底部工具条 ---------- */
  const RETENTION_DAYS = 30;
  function staleRuns() {
    const cut = Date.now() - RETENTION_DAYS * 86400000;
    return runsList.filter((m) => {
      const t = m.startedAt ? Date.parse(m.startedAt) : NaN;
      return !isNaN(t) && t < cut;
    });
  }
  /* 与列表同刷：列表每次重建都会换掉 runsList 的渲染结果，计数留在旧 DOM 里会过期 */
  function renderSessFoot() {
    if (!els.sessFoot) return;
    const stale = staleRuns();
    els.sessFoot.innerHTML = '';
    const btn = el('button', 'chip', '🧹 清理 30 天前');
    btn.type = 'button';
    btn.disabled = !stale.length;
    btn.title = stale.length
      ? '删除 ' + stale.length + ' 条 ' + RETENTION_DAYS + ' 天前的会话记录（不可撤销）'
      : '没有 ' + RETENTION_DAYS + ' 天前的会话记录';
    btn.onclick = () => cleanStaleRuns(stale);
    els.sessFoot.appendChild(btn);
    if (!stale.length) els.sessFoot.appendChild(el('span', 'foot-note', '暂无可清理记录'));
  }

  async function cleanStaleRuns(stale) {
    if (!stale.length) return;
    const n = stale.length;
    const ok = await confirmDialog({
      title: '清理 ' + RETENTION_DAYS + ' 天前的会话记录？',
      text: '将删除 ' + n + ' 条会话记录（不可撤销）',
      okText: '删除',
    });
    if (!ok) return;
    const before = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString();
    let removed = n;
    const r = await apiJson('/api/runs?before=' + encodeURIComponent(before), null, { method: 'DELETE' });
    if (!r.ok) { toast('清理失败：' + apiErrText(r)); return; }
    /* 服务端回的 deleted 是权威计数（本地列表可能比磁盘旧），拿不到才退回本地算的 N */
    if (typeof r.deleted === 'number') removed = r.deleted;
    toast(removed ? '已清理 ' + removed + ' 条' : '没有需要清理的记录');
    /* 正在看的那条可能刚被清掉：退回当前会话，别让详情停在一条不存在的记录上 */
    const cur = view.sess === 'current' ? null : viewRecord && viewRecord.meta;
    if (cur && stale.some((m) => m.id === cur.id)) { await refreshRunsList(); openSession('current'); return; }
    refreshRunsList();
  }

  function renderSessDd() {
    const meta = view.sess === 'current'
      ? { id: runId, goal: runCfg && runCfg.goal }
      : (viewRecord && viewRecord.meta);
    els.sessBtn.textContent = meta && meta.id
      ? '会话 ' + meta.id + (meta.goal ? ' · ' + shortStr(meta.goal, 12) : '')
      : '会话 —';
    renderSessList();
    renderSessFoot();
    updateExportBtn();   /* 导出跟随「你正在看的会话」，视图一变就跟着变 */
  }

  async function openSession(which) {
    if (which === 'current') {
      view.sess = 'current'; viewRecord = null;
      renderSessDd(); renderFlow();
      return;
    }
    const r = await apiJson('/api/runs/' + which, null, { cache: 'no-store' });
    if (!r.ok) {
      toast('历史会话读取失败：' + apiErrText(r));
      refreshRunsList();
      return;
    }
    viewRecord = hydrateRecord(r);
    view.sess = which; view.type = 'session'; view.follow = false;
    renderSessDd(); renderFlow();
  }

  /* 树视图状态：sess='current' 看本页运行，否则为历史会话 id；type= session|step|action */
  const view = { sess: 'current', type: 'session', n: 0, i: 0, follow: true };
  let viewRecord = null;     // 历史会话记录（已 hydrate 成运行时形状）
  let runsList = [];         // GET /api/runs 列表（下拉数据源）

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

  /* ---------- 树视图数据访问器 ---------- */
  function viewedSteps() { return view.sess === 'current' ? steps : (viewRecord ? viewRecord.steps : []); }
  function viewedVars() {
    if (view.sess === 'current') return (runCfg && runCfg.variables) || [];
    return (viewRecord && viewRecord.meta && viewRecord.meta.variables) || [];
  }
  function hydrateRecord(rec) {
    /* 落盘形状（request / llm.response）→ 运行时形状（payload / llm.raw），
     * 让全部现有渲染函数（decisionSummaryHtml 等）对历史会话零改动可用 */
    return {
      meta: rec.meta,
      steps: (rec.steps || []).map((s) => Object.assign({}, s, {
        payload: s.payload || s.request || null,
        followUps: (s.followUps || []).map((r) => Object.assign({}, r, { payload: r.payload || r.request || null })),
        llm: s.llm ? { messages: s.llm.messages, raw: s.llm.response, text: s.llm.text, error: s.llm.error } : null,
      })),
    };
  }

  /* ---------- 环境探测（设计 §4） ---------- */
  /* .warnbar 的显示由 class `show` 控制（CSS: `.warnbar{display:none}` /
   * `.warnbar.show{display:block}`）—— 只翻 hidden 属性是看不见的。
   * 两处警示条都走这里，免得再漏一个。 */
  function setWarnbar(node, on) {
    if (!node) return;
    node.hidden = !on;
    node.classList.toggle('show', on);
  }

  /* ---------- 错误条：让报错留在页面上、能被复制 ----------
   * 以前出错只发一条 2.2 秒的 toast，看完就没了，想搜/想贴只能靠肉眼抄 —— 报错文案往往是
   * 「拿去搜 / 贴给同事」的东西，所以摊在页面里，整段可选中，另配一键复制。
   * 运行中的小提示（已更新、全屏未生效…）仍走 toast，别把页面刷成报错墙。 */
  const ERR_COPY_IDLE = '⧉ 复制';
  function showErr(title, text) {
    if (!els.errBar) return;
    els.errTitle.textContent = title || '✗ 出错';
    els.errBody.textContent = String(text == null ? '' : text);
    els.errCopy.textContent = ERR_COPY_IDLE;
    setWarnbar(els.errBar, true);
    /* 报错条在页面顶部，而用户可能正滚在运行流水里 —— 带进视野，否则等于没提示 */
    try { els.errBar.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) { /* 老浏览器 */ }
  }
  function hideErr() {
    if (els.errBar) setWarnbar(els.errBar, false);
  }
  function copyErr() {
    const text = els.errBody.textContent || '';
    const done = (ok) => {
      els.errCopy.textContent = ok ? '✓ 已复制' : '已选中，Ctrl+C';
      setTimeout(() => { els.errCopy.textContent = ERR_COPY_IDLE; }, 1600);
    };
    const selectAll = () => {                       /* 兜底：把文本选上，用户自己 Ctrl+C */
      try {
        const range = document.createRange();
        range.selectNodeContents(els.errBody);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        done(false);
      } catch (_) { done(false); }
    };
    /* navigator.clipboard 只在安全上下文可用（localhost / https 都算）；
     * 被策略拒了也别静默失败 —— 退回到「选中文本」这条路。 */
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => done(true), selectAll);
    } else {
      selectAll();
    }
  }
  if (els.errCopy) els.errCopy.addEventListener('click', copyErr);
  if (els.errClose) els.errClose.addEventListener('click', hideErr);

  /* 引擎探测结论（probeEngine 写、renderPreflight 读）：以前这个结论只写进顶栏胶囊，
   * 「开跑前检查」就没得读 —— 用户只能点开始之后才被告知引擎不可用。 */
  let engineProbe = { known: false, ok: false, text: '检测中…' };

  async function probeEngine() {
    const ok = await probeEngineRaw();
    engineProbe = { known: true, ok: ok, text: els.pill.textContent };
    renderPreflight();
    return ok;
  }

  /* 状态用顶栏胶囊的圆点表达（颜色跟着 .ok / .error 走），文案里不再带 ✅⚠ */
  async function probeEngineRaw() {
    els.pill.textContent = '引擎检测中…';
    els.pill.className = 'status-pill';
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      const h = await res.json();
      const d = h.browserDetail || {};
      if (d.available) {
        els.pill.textContent = '引擎就绪 ' + (d.version || '');
        els.pill.className = 'status-pill ok';
        setWarnbar(els.installHint, false);
        return true;
      }
      const msg = d.reason === 'not-installed' ? '引擎未安装' : '引擎不可用';
      els.pill.textContent = msg;
      els.pill.className = 'status-pill error';
      setWarnbar(els.installHint, true);
      return false;
    } catch (_) {
      els.pill.textContent = '无后端服务';
      els.pill.className = 'status-pill error';
      setWarnbar(els.installHint, false);   /* 后端问题由顶部 warnbar 负责，不重复 */
      return false;
    }
  }

  /* ---------- 开跑前检查（条目 6） ----------
   * 三个前置条件（引擎 / Jev Key / 任务目标 / 起始 URL）原本散在三处：引擎在顶栏、
   * Key 要点了开始才校验、目标与 URL 在表单里 —— 用户能一路填到最后才被告知缺 Key。
   * 这里只做「提前告知」：**绝不用它去 disable #autoStart** —— 「配置不合法也能点开始，
   * 然后把原因摊进 #autoErrorBar」是已验收的契约（tests/e2e/run.js 的 S8）。 */
  /* full：胶囊里放不下时的完整值（进 title，鼠标悬停仍能看到整条 URL） */
  function pfItem(name, ok, detail, full) {
    const n = el('div', 'pf-item ' + (ok ? 'ok' : 'bad'));
    n.appendChild(el('b', null, name));
    n.appendChild(document.createTextNode(' ' + detail));
    n.title = name + '：' + (full || detail);
    return n;
  }

  /* #autoPreflight 是 role="status" aria-live="polite" 的 live region：整块重建一次，
   * 读屏就把四格全部重播一遍 —— 挂在 input 上会让用户每敲一个字符都被播报四格。
   * 所以按「状态签名」短路：只有真正有变化（引擎结论变了 / 某格 ok↔bad 翻牌）才重建，
   * 否则连 DOM 都不碰，live region 自然不播报。 */
  let pfSig = null;
  let pfUrlNode = null;   /* 起始 URL 那一格：title 里带完整 URL，签名不变时也要保持新鲜 */

  function renderPreflight() {
    if (!els.preflight) return;
    const goalOk = Boolean(els.goal.value.trim());
    const urlVal = els.url.value.trim();
    const urlOk = /^https?:\/\//i.test(urlVal);
    const keyOk = Boolean(Config.current.key && Config.current.key.trim());
    /* 签名只含「会改变胶囊文字与配色」的东西。刻意不含 URL 原文：在 http:// 之后接着
     * 敲字符时它每键都变，把它算进签名等于每键重建一次 live region（正是要灭掉的毛病）。
     * 完整 URL 走 title（改属性不会触发 live region 播报）。 */
    const sig = [
      engineProbe.known ? (engineProbe.ok ? 'ok' : 'bad:' + engineProbe.text) : 'wait',
      keyOk ? 'ok' : 'bad',
      goalOk ? 'ok' : 'bad',
      urlOk ? 'ok' : (urlVal ? 'bad' : 'empty'),
    ].join('|');
    if (sig === pfSig) {
      if (pfUrlNode) pfUrlNode.title = '起始 URL：' + (urlVal || '未填写');
      return;
    }
    pfSig = sig;
    const items = [
      pfItem('引擎', engineProbe.known && engineProbe.ok,
        !engineProbe.known ? '检测中…' : (engineProbe.ok ? '就绪' : engineProbe.text)),
      pfItem('Jev Key', keyOk, keyOk ? '已填写' : '未配置（点右上角「⚙ 配置」填写）'),
      pfItem('任务目标', goalOk, goalOk ? '已填写' : '未填写'),
      /* 这一格只说结论（已填 / 不是 http(s) 地址），整条 URL 留在 title：胶囊里塞不下，
       * 也不该把 URL 原文当正文 —— 那会让「输入中」变成每次都变化的正文。 */
      pfItem('起始 URL', urlOk, urlOk ? '已填写' : (urlVal ? '不是 http(s) 地址' : '未填写'), urlVal),
    ];
    pfUrlNode = items[3];
    els.preflight.innerHTML = '';
    items.forEach((n) => els.preflight.appendChild(n));
  }

  /* 文本框在 input 上的触发：尾部节流，别让连续输入期间反复重算 */
  let pfTimer = null;
  function schedulePreflight() {
    if (pfTimer) clearTimeout(pfTimer);
    pfTimer = setTimeout(() => { pfTimer = null; renderPreflight(); }, 350);
  }

  /* ---------- 「关闭浏览器」的可点性（条目 10） ----------
   * **这个按钮永不禁用。** 页内状态刷新即丢：`runBrowserOpen` 归 false，而 cdp-probe 只认
   * 用户自己默认 profile 里的调试端口 —— isolated / persistent 起的那只浏览器刷新后其实
   * 还开着，此时禁用等于把用户**唯一**能关掉那个残留窗口的入口堵死，title 上那句
   * 「当前没有开着的浏览器」也一样是谎（我们并不知道）。所以：不说谎的那一半交给服务端
   * —— POST /api/browser/close 真没开时返回 {ok:true, closed:false, message:'当前没有开着的
   * 浏览器（无需关闭）'}，前端原样转述（见 els.closeBrowser.onclick）。
   * 这里只做 title：措辞一律不断言「有没有开着」，只用「若已开」这种条件句。 */
  let runBrowserOpen = false;
  let cdpBrowserOpen = false;

  function updateCloseBtn() {
    if (!els.closeBrowser) return;
    els.closeBrowser.disabled = false;
    if (els.browserMode.value === 'cdp' && cdpBrowserOpen) {
      els.closeBrowser.title = '断开与浏览器的连接（CDP 直连不会关掉你自己的窗口）';
      return;
    }
    els.closeBrowser.title = (running || runBrowserOpen)
      ? '关闭本轮使用的浏览器（运行中关闭会让本轮运行失败）'
      : '关闭本轮使用的浏览器（若已开）';
  }

  async function refreshBrowserState() {
    const r = await apiJson('/api/browser/cdp-probe');
    /* 只有 cdp 直连模式下探到的那个调试端口才代表「有我们能管的浏览器」：
     * isolated / persistent 跑的是我们自己起的实例（由 runBrowserOpen 记着），
     * 用户自己开着调试端口的浏览器不是我们的东西，不该凭它改写按钮措辞。
     * 这是**有意的**判断，不是漏判：cdp-probe 只看用户默认 profile 里的
     * DevToolsActivePort，与「本轮浏览器是否还开着」是两件事。 */
    cdpBrowserOpen = Boolean(r && r.ok && r.available) && els.browserMode.value === 'cdp';
    updateCloseBtn();
  }

  /* ---------- 变量池 ---------- */
  function addVarRow(name, value) {
    const row = el('div', 'var-row');
    const nameInp = el('input'); nameInp.placeholder = '变量名（如 关键词 / Enter键）'; nameInp.value = name || '';
    const valInp = el('input'); valInp.placeholder = '取值（如 招商银行）'; valInp.value = value || '';
    const del = el('button', 'row-del', '×'); del.type = 'button'; del.title = '删除变量'; del.setAttribute('aria-label', '删除变量');
    /* 删变量也要能撤销（与删问题同一套 5 秒安全网）：一行里可能刚手打完一长串取值 */
    del.onclick = () => {
      const nm = nameInp.value.trim() || '未命名';
      removeWithUndo(row, '已删除变量「' + nm + '」');
    };
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
    renderPreflight();   /* 目标/URL 是被程序写进去的，不会触发 input 事件 —— 检查条得手动跟上 */
    if (!quiet) toast('已填入「' + s.name + '」场景（离线可完整演示）');
  }

  /* ---------- 任务配置：外层就地编辑 + 运行参数弹窗 ----------
   * 任务目标 / 起始 URL / 输入变量就在外层表单里，随时可改（applyScenario 也写它们）；
   * 弹窗只管运行参数（步数 / 节奏 / 内核 / 模式 / 窗口 / 截图），取消时用快照回滚这几个，
   * **不碰**外层那三个 —— 不然"取消"会把用户在页面上刚敲的目标一起抹掉。
   * 数据源始终是输入框本身（id 没动，auto.js 其余部分照旧读 .value）。 */
  let formSnapshot = null;

  /* 浏览器模式：连接方式，与内核正交（详见 browser-driver.js 顶部「浏览器模式」）
   *   isolated   — 每次全新实例，profile 不落盘（默认，最收敛）
   *   persistent — 我们自己的窗口 + 落盘 profile（登录一次长期复用）
   *   cdp        — attach 到你已开调试端口的浏览器，复用其真实登录态，
   *                窗口尺寸/全屏一律不碰（那是你的窗口）
   * 这两项存 localStorage：cdp 是「我先做了一次调试端口设置」的刻意选择，
   * 刷新页面就丢会很难受。键名沿用 app.js 的 jev- 前缀约定。 */
  const MODE_KEY = 'jev-auto-browser-mode';
  const CDP_KEY = 'jev-auto-cdp-target';

  /* 合法模式的唯一来源是 #autoBrowserMode 里的真实 option（index.html）——
   * 早先这里和 server 各硬编码了一份 ['isolated','persistent','cdp']，加模式要记得改三处。
   * 前端这份的意义只在于「localStorage 里的脏值不要用」，所以按 DOM 校验最省心。 */
  function validModes() {
    return els.browserMode ? Array.from(els.browserMode.options).map((o) => o.value) : [];
  }

  function readStoredMode() {
    try {
      const m = localStorage.getItem(MODE_KEY);
      return validModes().includes(m) ? m : 'isolated';
    } catch (_) { return 'isolated'; }   /* 隐私模式等读不到：回到最收敛的默认 */
  }

  /* 全部输入（含外层三字段）—— 场景载入、配置读写、校验都用这一份 */
  function readForm() {
    return {
      goal: els.goal.value,
      url: els.url.value,
      vars: collectVars(),
      maxSteps: els.maxSteps.value,
      cadence: cadence(),
      browser: els.browser.value,
      mode: els.browserMode.value,
      cdp: els.cdpTarget.value.trim(),
      screen: els.screen.value,
      screenshot: els.screenshot.checked,
    };
  }
  /* 运行参数：弹窗里那几个。取消弹窗只回滚这一份。 */
  function readRunParams() {
    return {
      maxSteps: els.maxSteps.value,
      cadence: cadence(),
      browser: els.browser.value,
      mode: els.browserMode.value,
      cdp: els.cdpTarget.value.trim(),
      screen: els.screen.value,
      screenshot: els.screenshot.checked,
    };
  }
  function writeRunParams(c) {
    if (!c) return;
    els.maxSteps.value = c.maxSteps;
    const radio = document.querySelector('input[name="autoCadence"][value="' + c.cadence + '"]');
    if (radio) radio.checked = true;
    els.browser.value = c.browser;
    els.browserMode.value = c.mode;
    els.cdpTarget.value = c.cdp || '';
    els.screen.value = c.screen;
    els.screenshot.checked = c.screenshot;
    refreshModeFields();
  }

  /* 模式相关的界面反应：cdp 才显示端点输入与风险提示；窗口尺寸在 cdp 下无意义
   * （我们不会去改用户的窗口），所以把那一栏禁用掉，而不是让它看起来还能选。 */
  function refreshModeFields() {
    const cdp = els.browserMode.value === 'cdp';
    els.cdpField.hidden = !cdp;
    setWarnbar(els.cdpWarn, cdp);
    els.screen.disabled = cdp;
    if (cdp) probeCdp();
    renderPreflight();   /* 模式/端点变了，开跑前检查跟着重算（cdp 的起始 URL 也可能被改） */
  }

  /* CDP 预检：问一次后端「有没有开着调试端口、且真的在讲 DevTools」。
   * 结果写进端点输入框的 placeholder 与警示条 —— 探到了就把端点摆出来（可留空直接用），
   * 没探到就按原因说清楚下一步，而不是等 run 失败了再翻译报错。
   * 端点示例用 127.0.0.1：Chrome 只绑 IPv4，写 localhost 可能先解析到 ::1 而连不上。 */
  let cdpProbeToken = 0;
  async function probeCdp() {
    const mine = ++cdpProbeToken;
    const r = await apiJson('/api/browser/cdp-probe');
    if (mine !== cdpProbeToken || els.browserMode.value !== 'cdp') return;   /* 期间切走了 */
    const title = els.cdpWarn.querySelector('.title');
    if (r && r.ok && r.available) {
      els.cdpTarget.placeholder = '留空则自动探测：' + r.channel + ' @ ' + r.endpoint;
      /* 只说「端口在监听」：预检只做一次 TCP 连接（不做握手 —— 那会打掉你正要点的
       * 「允许远程调试」弹窗），所以它证明不了对面真在讲 DevTools。残留的调试端口
       * 也长这样，断言「已探到 chrome」会把人引到一个永远不会出现的弹框前面。 */
      title.textContent = '⚠ CDP 直连会操作用你正在使用的浏览器（' + r.channel + ' 的调试端口在监听）'
        + '—— 点「开始」后若浏览器弹出「允许远程调试」，请点允许';
      return;
    }
    els.cdpTarget.placeholder = '留空即可；手填要 ws://127.0.0.1:9222/devtools/browser/<uuid>（http 形态在默认 profile 上会 404）';
    /* reason 只有这两条（外加服务端侧的 no-driver / error，见 browser-driver.js 的 cdpProbe）：
     * 「端口在监听但拒绝 DevTools」探不出来，那种情况由 attach 阶段的 403/404 翻译负责 */
    const why = r && r.reason;
    if (why === 'unreachable') {
      title.textContent = '⚠ 记着调试端口，但连不上（那个浏览器多半已经关了）—— 重开一次，或手填端点';
    } else {
      title.textContent = '⚠ 没探到开着调试端口的浏览器 —— 先按下面的做法开一下，或手填端点';
    }
  }

  function modeLabel() {
    return modeLabelOf(els.browserMode.value);
  }

  /* 模式的中文名（记录详情里也要用 —— 那份 meta 是历史数据，不能读当前表单） */
  function modeLabelOf(m) {
    if (m === 'cdp') return 'CDP 直连（复用我的浏览器）';
    if (m === 'persistent') return '持久登录（专用 profile）';
    return '独立实例';
  }

  /* 窗口尺寸取选项当前文案 —— primeScreenOptions() 开机时会把它改成本机真实分辨率，
   * 硬编码映射会立刻过期。去掉尾部括号说明后作为摘要值。
   * cdp 模式不碰用户窗口，摘要里就别再报窗口尺寸了（那会承诺一件不会发生的事）。 */
  function screenLabel() {
    if (els.browserMode.value === 'cdp') return '不改动你的窗口';
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

  /* 外层摘要：主字段已经就地可编辑，这里只剩「一句话讲清现在会怎么跑」的运行参数，
   * 加上「什么都没填」时的引导。URL 一改场景高亮就跟着变，所以它也在这里刷。 */
  function renderSummary() {
    const f = readForm();
    els.summaryBody.innerHTML = '';
    renderScenarios();   /* 场景高亮跟着 URL 走，和摘要同源同刷 */

    if (!f.goal.trim() && !f.url.trim()) {
      const p = el('div', 'ts-empty');
      /* 与 index.html、renderFlow() 同一条约束：空态文案**不得复述控件文案**
       * （这里是第三处副本，禁用词表见 tests/e2e/run.js 的 S9.3 / S9.3b 探针；
       * 评论里刻意不抄那几个词，免得被任何按字符串扫描的实现误伤）。
       * 此处尤其危险 —— #taskSummary 在 DOM 里位于开始按钮之前，findLabel 取 refs[0]，
       * 这段静态文本会抢在真按钮前面被点到（S8）。 */
      p.innerHTML = '在上面填好<b>任务目标</b>与<b>起始 URL</b>（或点一个演示场景），然后点下面的开始按钮。';
      els.summaryBody.appendChild(p);
      return;
    }

    tsRow('运行参数', '', [
      f.maxSteps + ' 步',
      f.cadence === 'single' ? '单步确认' : '连续自动',
      f.browser === 'msedge' ? 'Edge' : 'Chrome',
      modeLabel(),
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

  let lastFocus = null;   /* 关闭后把焦点还给「⚙ 运行参数」 */

  function openTaskModal() {
    formSnapshot = readRunParams();   /* 只快照弹窗里那几个，外层字段不受取消影响 */
    lastFocus = document.activeElement;
    hideErr();                        /* 上一次的报错别跟新一次编辑混在一起 */
    els.taskModal.hidden = false;
    setTimeout(() => els.maxSteps.focus(), 50);
  }
  function closeTaskModal() {
    els.taskModal.hidden = true;
    formSnapshot = null;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    lastFocus = null;
  }
  function cancelTaskModal() {
    writeRunParams(formSnapshot);   /* 必须回滚后再置空快照 */
    closeTaskModal();
  }
  function saveTaskModal() {
    renderSummary();
    /* cdp 是刻意选的外部浏览器，和端点一起记住（刷新后不用重挑） */
    try {
      localStorage.setItem(MODE_KEY, els.browserMode.value);
      localStorage.setItem(CDP_KEY, els.cdpTarget.value.trim());
    } catch (_) { /* 隐私模式等写不进去：不影响运行 */ }
    closeTaskModal();
    toast('运行参数已更新');
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
  /* ---------- 统一的后端调用 ----------
   * 永远返回对象而不是抛错，调用方只看 .ok。多数端点回的是 {ok,...} 信封，
   * 但 GET /api/runs/:id 直接回记录本体（没有 ok），所以这里按 HTTP 状态回填一次，
   * 调用方不必为它破例。
   * opt.method 缺省按有没有 body 推断（PUT/DELETE 这类必须显式给）；
   * opt.cache 用于 GET 的 no-store。 */
  function errText(e) {
    if (!e) return '';
    /* server 的 error 有两种形状：{message} 对象（err()）与纯字符串（NO_DRIVER 分支） */
    return typeof e === 'string' ? e : (e.message || JSON.stringify(e));
  }
  function apiErrText(r) { return errText(r && r.error) || ('HTTP ' + ((r && r.status) || '失败')); }

  async function apiJson(path, body, opt) {
    const o = opt || {};
    try {
      const res = await fetch(path, {
        method: o.method || (body ? 'POST' : 'GET'),
        headers: Object.assign({ 'Content-Type': 'application/json' }, o.headers || {}),
        cache: o.cache,
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch (_) { /* 走 HTTP 状态分支 */ }
      if (data) {
        if (data.ok === undefined) data.ok = res.ok;
        data.status = res.status;
        return data;
      }
      return { ok: false, status: res.status, error: 'HTTP ' + res.status + '：' + text.slice(0, 200) };
    } catch (e) {
      return { ok: false, status: 0, error: '连不上本地服务：' + (e && e.message ? e.message : String(e)) };
    }
  }

  /* ---------- 概率条（与 Demo 的答案渲染同视觉） ---------- */
  function barsHtml(probs, hitKey, color) {
    const entries = Object.keys(probs || {})
      .map((k) => ({ k, p: Number(probs[k]) || 0 }))
      .sort((a, b) => b.p - a.p);
    const TOP = 4;   /* 常显前 4 项：分布区压高度，其余进「展开全部」（原 6 行太高） */
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

  /* ---------- 选择与主渲染（会话树 + 右侧详情） ---------- */
  function select(type, n, i, user) {
    view.type = type;
    if (n != null) view.n = n;
    if (i != null) view.i = i;
    if (user) view.follow = false;
    renderFlow();
  }

  /* 主入口：树 + 详情一次重建（≤50 步 × ≤6 行动 ≈ 300 节点，innerHTML 重建可接受） */
  function renderFlow() {
    const list = viewedSteps();
    if (!list.length) {
      /* 空态文案与 index.html 中 #autoFlow 的 .out-empty **逐字一致**：同一句话有两份
       * （这里 + index.html），改一处必须改另一处。禁用字串（打开浏览器并开始 / 运行参数 /
       * 关闭浏览器 / 中止）会让 S8 的 findLabel(/打开浏览器并开始/) 在无障碍快照里先撞上
       * 这段静态文本、点到非控件上 —— S9.3 就是这条的回归护栏。刻意不抽公共常量：
       * 新增全局名字超出 Wave 0 冻结范围。 */
      els.flow.innerHTML = '<div class="out-empty"><div class="big" aria-hidden="true">▶</div>'
        + '还没有步骤。先在上方「任务配置」里填好任务目标与起始 URL（或直接点一个演示场景），然后点下面的开始按钮。</div>';
      return;
    }
    if (view.follow && view.sess === 'current') {
      view.type = 'step';
      view.n = list[list.length - 1].n;
    }
    if (!list.some((s) => s.n === view.n)) { view.type = 'session'; }
    if (view.type === 'action') {
      const st = list.find((s) => s.n === view.n);
      const acts = st ? AutoCore.actionsOf(st) : [];
      if (view.i >= acts.length) view.type = 'step';
    }
    const treeScroll = document.getElementById('flowTree');
    const keepTop = treeScroll ? treeScroll.scrollTop : 0;
    const bodyScroll = document.getElementById('fdBody');
    const keepBody = bodyScroll ? bodyScroll.scrollTop : 0;
    const openMap = {};
    document.querySelectorAll('#fdBody details[data-dk]').forEach((d) => { openMap[d.dataset.dk] = d.open; });
    els.flow.innerHTML = '<div class="flow-main">'
      + '<div class="flow-tree" id="flowTree" role="tree" aria-label="会话结构"></div>'
      + '<div class="flow-detail"><div class="fd-head" id="fdHead"></div>'
      + '<div class="fd-body" id="fdBody"></div></div></div>';
    buildTree();
    renderDetail();
    const t2 = document.getElementById('flowTree');
    if (t2) t2.scrollTop = keepTop;
    const b2 = document.getElementById('fdBody');
    if (b2) b2.scrollTop = keepBody;
    /* 跟随模式才把选中节点夹回树视口：纯纵向（只写 scrollTop，绝不动横向，也不滚页面）；
     * 用户手动翻树（follow=false）时永不打扰 */
    if (view.follow && view.sess === 'current' && t2) {
      const selNode = t2.querySelector('.tn.sel');
      if (selNode) {
        const top = selNode.getBoundingClientRect().top - t2.getBoundingClientRect().top + t2.scrollTop;
        const above = top - 8;
        const below = top + selNode.offsetHeight + 8 - t2.clientHeight;
        if (above < t2.scrollTop) t2.scrollTop = Math.max(0, above);
        else if (below > t2.scrollTop) t2.scrollTop = below;
      }
    }
    document.querySelectorAll('#fdBody details[data-dk]').forEach((d) => { if (openMap[d.dataset.dk] != null) d.open = openMap[d.dataset.dk]; });
  }

  function stepDot(st) {
    if (st.terminal) return 'term';
    const e = st.exec;
    if (!e) return (view.sess === 'current' && running && steps.length && steps[steps.length - 1] === st) ? 'run' : 'mute';
    if (e.skipped) return 'mute';
    return e.ok ? 'ok' : 'err';
  }

  function buildTree() {
    const tree = document.getElementById('flowTree');
    const meta = view.sess === 'current'
      ? { id: runId, goal: runCfg && runCfg.goal }
      : (viewRecord && viewRecord.meta);
    const list = viewedSteps();
    const mk = (key, cls, html) => {
      const b = el('button', 'tn' + (cls ? ' ' + cls : ''));
      b.type = 'button'; b.setAttribute('role', 'treeitem'); b.dataset.key = key;
      if (cls && cls.includes(' sel')) b.setAttribute('aria-selected', 'true');
      b.innerHTML = html;
      b.onclick = () => {
        if (key === 'sess') select('session', null, null, true);
        else if (key[0] === 's') select('step', Number(key.slice(2)), null, true);
        else { const p = key.slice(2).split(':'); select('action', Number(p[0]), Number(p[1]), true); }
      };
      return b;
    };
    const sel = (on) => (on ? ' sel' : '');   /* 选中态只进 class，key 保持纯净可解析 */
    /* 会话根标记：空心 indigo 圆环（容器语义），运行中转琥珀脉冲 —— 不与步骤状态实心点混色 */
    const sessRunning = view.sess === 'current' ? running : (meta && meta.endState) === 'running';
    tree.appendChild(mk('sess', 'sess-row' + sel(view.type === 'session'),
      '<span class="dot root' + (sessRunning ? ' run' : '') + '"></span>'
      + '<span class="lb">会话 <span class="mono">' + escapeHtml(meta && meta.id || '—') + '</span> · ' + escapeHtml(shortStr((meta && meta.goal) || '', 14)) + '</span>'));
    list.forEach((st) => {
      const acts = AutoCore.actionsOf(st);
      /* 子行只在「本步有多次模型调用」时才出现：11 步的会话原本挂 11 条只写着
       * 「Jev 首轮 · 3 题」的低信息量子行（1 会话 + 11 步骤 + 11 行动 = 23 行），
       * 单次调用是常态，它不提供任何可比较的信息。has-acts 的 ::before 就是给子行
       * 引出的那段导轨，没有子行时必须一并去掉，否则步骤行下面悬着一截断线。
       * 判定必须是 > 1：单行动步骤的树节点仍是 .tn.kid（e2e 的 clickTreeNode 按文字找它）。 */
      tree.appendChild(mk('s:' + st.n, 'kid' + (acts.length > 1 ? ' has-acts' : '') + sel(view.type === 'step' && view.n === st.n),
        '<span class="dot ' + stepDot(st) + '"></span>'
        /* 命令段（click 【e48 · …】）走等宽小字号，与中文 sans 区分；CJK 自动回退 */
        + '<span class="lb"><b>步骤 ' + st.n + '</b> · <span class="mono">' + escapeHtml(st.label || '决策中…') + '</span></span>'
        /* 耗时右对齐固定宽（无值占位）：右侧自成一条安静的数据列，标签区不随耗时跳动 */
        + '<span class="dur">' + (st.exec && st.exec.elapsedMs != null ? st.exec.elapsedMs + 'ms' : '') + '</span>'));
      if (acts.length <= 1) return;   /* 单次调用：步骤行自己就是这条调用，不另起子行 */
      acts.forEach((a, i) => {
        /* 末个行动标 last：导轨截止到行中线，与父步骤形成肘形收口 */
        tree.appendChild(mk('a:' + st.n + ':' + i, 'act-kid' + (i === acts.length - 1 ? ' last' : '') + sel(view.type === 'action' && view.n === st.n && view.i === i),
          '<span class="k ' + (a.kind === 'llm' ? 'llm' : 'jev') + '">' + (a.kind === 'llm' ? 'LLM' : 'JEV') + '</span>'
          + '<span class="lb">' + escapeHtml(a.title) + '</span>'
          + '<span class="dot ' + AutoCore.actionStatus(a) + '"></span>'));
      });
    });
    if (view.sess === 'current' && !view.follow && steps.length > 1) {
      const f = el('button', 'tn follow-btn');
      f.type = 'button'; f.textContent = '→ 跟随最新';
      f.onclick = () => { view.follow = true; renderFlow(); };
      tree.appendChild(f);
    }
  }
  function shortStr(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }

  /* ---------- 右侧详情：会话 / 步骤 / 行动 三视图 ---------- */
  function renderDetail() {
    const head = document.getElementById('fdHead');
    const body = document.getElementById('fdBody');
    const list = viewedSteps();
    if (view.type === 'session') {
      head.innerHTML = sessionHeadHtml();
      body.innerHTML = sessionViewHtml();
      body.querySelectorAll('tr[data-go]').forEach((tr) => { tr.onclick = () => select('step', Number(tr.dataset.go.slice(2)), null, true); });
      return;
    }
    const st = list.find((s) => s.n === view.n);
    if (!st) { view.type = 'session'; renderDetail(); return; }
    if (view.type === 'step') {
      head.innerHTML = '<span class="crumb">会话 ▸ 步骤</span><h2>步骤 ' + st.n + ' · ' + escapeHtml(st.label || '决策中…') + '</h2>' + stepBadgeHtml(st)
        + '<span class="stepnav" style="margin-left:auto">'
        + '<button type="button" id="fdPrev"' + (st.n <= 1 ? ' disabled' : '') + '>‹ 上一步</button>'
        + '<button type="button" id="fdNext"' + (st.n >= list.length ? ' disabled' : '') + '>下一步 ›</button></span>';
      body.innerHTML = stepViewHtml(st, list);
      const p = document.getElementById('fdPrev'), nx = document.getElementById('fdNext');
      if (p) p.onclick = () => select('step', st.n - 1, null, true);
      if (nx) nx.onclick = () => select('step', st.n + 1, null, true);
      /* 本步行动卡片跳转 */
      body.querySelectorAll('.acard').forEach((b) => {
        const p2 = b.dataset.go.slice(2).split(':');
        b.onclick = () => select('action', Number(p2[0]), Number(p2[1]), true);
      });
      const shot = body.querySelector('.step-shot');
      if (shot) shot.onclick = () => openLightbox(shot.src, shot.alt);   /* E2E 契约：.step-shot + data-anno 原样 */
    } else {
      const acts = AutoCore.actionsOf(st);
      const a = acts[view.i] || acts[0];
      view.i = acts.indexOf(a);
      head.innerHTML = '<span class="crumb">会话 ▸ 步骤 ' + st.n + ' ▸ 行动 ' + (view.i + 1) + '/' + acts.length + '</span>'
        + '<h2>' + escapeHtml(a.title) + '</h2>'
        + '<span class="fd-tag ' + (a.kind === 'llm' ? 'llm' : 'jev') + '">' + (a.kind === 'llm' ? '生成模型' : 'Jev') + '</span>';
      body.innerHTML = actionViewHtml(st, a);
      animateBars(body);
    }
  }

  function stepBadgeHtml(st) {
    const e = st.exec;
    if (st.terminal) return '<span class="fd-state term">终止 · ' + escapeHtml(st.terminal) + '</span>';
    if (!e) return '<span class="fd-state run">进行中…</span>';
    if (e.skipped) return '<span class="fd-state warn">已跳过</span>';
    return '<span class="fd-state ' + (e.ok ? 'ok' : 'err') + '">' + (e.ok ? '✓ 成功' : '✗ 失败') + (e.elapsedMs != null ? ' · ' + e.elapsedMs + 'ms' : '') + '</span>';
  }

  function sessionHeadHtml() {
    const meta = view.sess === 'current'
      ? { id: runId, goal: runCfg && runCfg.goal, endState: running ? 'running' : (els.runPill.dataset.state || '') }
      : (viewRecord && viewRecord.meta);
    const st = meta.endState === 'running' ? { label: '运行中', tone: 'run' }
      : ((END_STATES[meta.endState] || END_STATES.error));
    return '<span class="crumb">会话</span><h2>' + escapeHtml(meta.id || '—') + ' · ' + escapeHtml(shortStr(meta.goal || '', 18)) + '</h2>'
      + '<span class="fd-state ' + (st.tone === 'done' ? 'ok' : st.tone === 'error' ? 'err' : 'warn') + '">' + st.label + '</span>';
  }

  function sessionViewHtml() {
    const meta = view.sess === 'current'
      ? { goal: runCfg.goal, startUrl: runCfg.url, variables: runCfg.variables, maxSteps: runCfg.maxSteps,
          browser: runCfg.browserUsed || runCfg.browser, mode: runCfg.mode, cdp: runCfg.cdp || null, screenshotOn: runCfg.screenshotOn,
          jevModel: Config.current.model,
          llmModel: Config.llm.configured() ? Config.llm.get().model : null }
      : viewRecord.meta;
    const list = viewedSteps();
    const vars = (meta.variables || []).map((v) => '<span class="dec-chip"><i>' + escapeHtml(v.name) + '</i>' + escapeHtml(v.value) + '</span>').join('') || '<span class="muted">（无）</span>';
    return '<div class="fd-kv"><div class="fd-kv-k">任务目标</div><div class="fd-kv-v">' + escapeHtml(meta.goal || '') + '</div></div>'
      + '<div class="fd-kv"><div class="fd-kv-k">起始 URL</div><div class="fd-kv-v mono">' + escapeHtml(meta.startUrl || '') + '</div></div>'
      + '<div class="fd-kv"><div class="fd-kv-k">浏览器</div><div class="fd-kv-v">' + escapeHtml((meta.browser || '—') + ' · ' + modeLabelOf(meta.mode) + (meta.cdp ? ' · ' + meta.cdp : '')) + '</div></div>'
      + '<div class="fd-kv"><div class="fd-kv-k">输入变量</div><div class="fd-kv-v">' + vars + '</div></div>'
      + '<div class="fd-kv"><div class="fd-kv-k">模型</div><div class="fd-kv-v mono">' + escapeHtml((meta.jevModel || '—') + (meta.llmModel ? ' · 生成 ' + meta.llmModel : '')) + '</div></div>'
      + '<div class="sec-t" style="margin-top:6px">步骤总览（点击行查看详情）</div>'
      + '<table class="ov"><thead><tr><th>#</th><th>步骤</th><th>动作</th><th>状态</th><th>用时</th><th>行动</th></tr></thead><tbody>'
      + list.map((s) => {
        const d = s.decision || {};
        const nAct = AutoCore.actionsOf(s).length;
        return '<tr data-go="s:' + s.n + '"><td class="mono">' + s.n + '</td><td>' + escapeHtml(s.label || '…') + '</td>'
          + '<td class="mono">' + escapeHtml(d.action || '—') + (d.param ? ' ' + escapeHtml(d.param) : '') + '</td>'
          + '<td>' + (s.exec ? (s.exec.skipped ? '跳过' : (s.exec.ok ? '成功' : '失败')) : (s.terminal ? '终止' : '…')) + '</td>'
          + '<td class="mono">' + (s.exec && s.exec.elapsedMs != null ? s.exec.elapsedMs + 'ms' : '—') + '</td>'
          + '<td class="mono">' + nAct + '</td></tr>';
      }).join('')
      + '</tbody></table>';
  }

  function stepViewHtml(st, list) {
    let html = execHtml(st);
    if (st.pageInfo) {
      html += '<div class="fd-kv"><div class="fd-kv-k">页面环境</div><div class="fd-kv-v">'
        + '<span class="mono-chip">' + escapeHtml(st.pageInfo.url || '') + '</span>'
        + (st.pageInfo.title ? '<span class="page-title">' + escapeHtml(st.pageInfo.title) + '</span>' : '') + '</div></div>';
    }
    if (st.annoError) html += '<div class="exec-line"><span class="exec-url">未标注：' + escapeHtml(st.annoError) + '</span></div>';
    html += shotHtml(st);
    if (st.decision && st.response && !st.jevError) {
      html += '<div class="sec"><div class="sec-head">本轮输出 · 决策摘要</div>' + decisionSummaryHtml(st) + '</div>';
    }
    /* 行动列表 */
    const acts = AutoCore.actionsOf(st);
    html += '<div class="sec-t">本步行动 · ' + acts.length + ' 次模型调用</div><div class="alist">'
      + acts.map((a, i) => '<button type="button" class="acard" data-go="a:' + st.n + ':' + i + '">'
        + '<span class="k ' + (a.kind === 'llm' ? 'llm' : 'jev') + '">' + (a.kind === 'llm' ? 'LLM' : 'JEV') + '</span>'
        + '<span class="t">' + escapeHtml(a.title) + '</span>'
        + '<span class="m">' + escapeHtml(actionBrief(a)) + ' ›</span></button>').join('')
      + '</div>';
    return html;
  }

  function actionBrief(a) {
    if (a.error) return '失败';
    if (a.kind === 'main') return a.response ? '已响应' : '请求中…';
    if (a.kind === 'llm') return a.text ? '生成 ' + shortStr(a.text, 12) : '…';
    return (a.param || a.action || a.text) ? '命中 ' + shortStr(a.param || a.action || a.text, 14) : '请求中…';
  }

  function shotHtml(st) {
    if (!st.screenshot) {
      const dialog = st.payload && st.payload.questions && st.payload.questions['动作'] && !st.payload.questions['参数'];
      return dialog ? '<div class="muted" style="font-size:12px">弹窗步不截图（modal state 下 screenshot 被拒，且没有可标注元素）</div>' : '';
    }
    const a = st.anno && st.anno.box;
    return '<div class="shot-slot"><img class="step-shot" src="' + st.screenshot + '" alt="第 ' + st.n + ' 步操作前的页面'
      + (a ? '（已标注被操作元素）' : '') + '"'
      + (a ? ' data-anno="' + [a.x, a.y, a.w, a.h, st.anno.badge.x, st.anno.badge.y].join(',') + '"' : '') + ' /></div>';
  }

  function actionViewHtml(st, a) {
    if (a.kind === 'llm') return llmHtml(st);
    if (a.kind === 'main') {
      let html = '';
      if (st.trim && st.trim.trimmed && st.payload && st.payload.questions && st.payload.questions['参数']) {
        html += '<div class="trim-note">' + escapeHtml(trimSummary(st)) + '</div>';
      }
      /* 右侧一屏多块：输入/输出/原始报文各自成块带块头（.sec 面板），不再糊成一片 */
      if (st.decision && st.response && !st.jevError) {
        html += '<div class="sec"><div class="sec-head">本轮输出 · 决策与概率分布</div>' + decisionDetailsHtml(st) + '</div>';
      }
      if (a.error) html += '<div class="step-err">' + escapeHtml(a.error) + '</div>';
      html += stateSectionHtml(a.payload.state);
      html += questionsSectionHtml(a.payload, st);
      html += trimDetailHtml(st);
      html += '<div class="sec"><div class="sec-head">原始报文</div>'
        + rawBlock('① 发送的请求体（与真实请求同一对象）', relaxedStringify(a.payload))
        + (a.response
          ? rawBlock('② Jev 响应', JSON.stringify({ model: a.response.model, answers: a.response.answers, usage: a.response.usage, _latency_ms: a.response._latency_ms }, null, 2))
          : rawBlock('② Jev 响应', '（调用失败，无响应）'))
        + '</div>';
      return html;
    }
    /* 补问行动：结论行 + 问题块 + 作答概率分布 + 原始报文 —— 与首轮卡同构 */
    return followUpViewHtml(st, a, 'fu:' + st.n + ':' + view.i);
  }

  function rawBlock(label, text) {
    return '<div class="raw-label">' + escapeHtml(label) + '</div><pre class="step-pre tall">' + escapeHtml(text) + '</pre>';
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

  /* ============ 决策区：摘要常显 + 明细折叠 ============ */
  /* 补问的记录种类 → 它回传的题名（三类补问各只回一题） */
  const FOLLOWUP_Q = { param: '参数', action: '动作', text: '文本' };
  const Q_COLOR = { 动作: 'var(--violet)', 参数: '#7c3aed', 文本: '#0d9268' };

  /* ref chip 标签：「键 · 短文本」。与 auto-core.shortRefLabel **有意不同**：那个是嵌进
   * 时间线句子的短语（剥前缀 + 优先取引号内文本 + 截断 14），这里是详情区的独立 chip
   * （保留键名、截断 24）。共用的只有「剥掉【可交互】前缀」这一步。 */
  function refChipLabel(key, refLabels) {
    if (!refLabels || !refLabels[key]) return key;
    const clean = AutoCore.stripRefPrefix(refLabels[key]);
    return key + ' · ' + (clean.length > 24 ? clean.slice(0, 24) + '…' : clean);
  }
  /* 变量名 → 取值（查不到就原样显示名字：选项名 / 键名本来就不是变量，按字面值直传） */
  function varLabelOf(name) {
    const v = viewedVars().find((x) => x.name === name);
    return v ? v.value : name;
  }

  /* 单张作答卡：题名 + 选中值 + 置信度 + 概率条。首轮网格与补问卡共用 ——
   * 补问单题响应里的 probabilities 此前只躺在裸 JSON 里没人解析。 */
  function choiceCardHtml(name, ans, chosenLabel, note) {
    const x = ans || {};
    const chosen = chosenLabel != null ? chosenLabel : (x.choice != null ? String(x.choice) : '—');
    return '<div class="qcard">' +
      '<div class="qcard-head"><span class="qcard-name">' + name + '</span>' +
      '<span class="qcard-chosen">' + escapeHtml(chosen) + '</span>' +
      (typeof x.confidence === 'number' ? '<span class="qcard-conf">置信度 ' + pct(x.confidence) + '</span>' : '') + '</div>' +
      (x.probabilities ? barsHtml(x.probabilities, x.choice, Q_COLOR[name]) : '<div class="muted" style="font-size:12px">无概率数据</div>') +
      (note ? '<div class="muted" style="font-size:12px">' + escapeHtml(note) + '</div>' : '') +
      '</div>';
  }

  function decisionSummaryHtml(step) {
    const a = (step.response && step.response.answers) || {};
    const d = step.decision || {};
    const refLabels = step.refLabels || {};
    const shortRef = (key) => refChipLabel(key, refLabels);
    const chip = (k, v, cls) => '<span class="dec-chip ' + (cls || '') + '"><i>' + k + '</i>' + escapeHtml(v) + '</span>';
    /* 复合置信度：本轮作答的各选择题 confidence 的最小值（首轮 动作/参数 + 已落定补问
     * 的作答题）。旧版只显示动作题 —— 文本题 47% 的摇摆会被 82% 的动作置信度盖住。 */
    const confOf = (ans) => (ans && typeof ans.confidence === 'number') ? ans.confidence : null;
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
      (d.text != null && d.text !== AutoCore.TEXT_NONE ? chip('文本', varLabelOf(d.text)) : '');
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
    /* 参数若是补问回合定下来的，本轮的「参数」概率分布里没有它 —— 不能拿第一批的
     * 概率条去解释第二批复问的答案，改成指向那次补问行动 */
    const followUpRec = (step.followUps || []).find((r) => r.param && r.param === d.param);
    /* 本网格只呈现首轮这一次调用的作答：「文本」已移入补问，它的答案与概率分布
     * 在同一步的「文本补问」行动视图里（那里与本网格同构）。 */
    const chosenLabel = {
      动作: d.action || '—',
      参数: d.param ? refChipLabel(d.param, refLabels) + (followUpRec ? '（第 ' + followUpRec.batch + ' 批补问）' : '') : '—',
    };
    let html = '<div class="qgrid">';
    ['动作', '参数'].forEach((name) => {
      html += choiceCardHtml(name, a[name], chosenLabel[name],
        (name === '参数' && followUpRec)
          ? '本行选项由第 ' + followUpRec.batch + ' 批补问确定，该题概率见「参数补问」行动' : '');
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
    html += '<details class="step-collapse" data-dk="llm-p"><summary>Prompt（工程组装，前端可见）</summary>' +
      '<pre class="step-pre">' + escapeHtml(L.messages.map((m) => '[' + m.role + ']\n' + m.content).join('\n\n')) + '</pre></details>';
    html += '<details class="step-collapse" data-dk="llm-r"><summary>模型原始响应</summary>' +
      '<pre class="step-pre">' + escapeHtml(JSON.stringify(L.raw, null, 2)) + '</pre></details>';
    html += '</div>';
    return html;
  }

  /* ============ 输入区（结构化 state + 首轮 3 道问题，建卡时一次性渲染） ============ */
  function snapshotDetailsHtml(snap) {
    const text = String(snap || '');
    const lines = text ? text.split('\n').length : 0;
    const refs = Object.keys(AutoCore.refCriteria(text)).length;
    return '<details class="snap-details" data-dk="snap"><summary>accessibility 快照 · ' + lines + ' 行 · ' + refs + ' 个元素（点开查看）</summary>' +
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
    if (name === '文本') {
      /* 取值候选：变量 / 下拉框真实选项名 / 键名 / 标签页序号。首轮没有这一题 ——
       * 只有「文本」补问卡渲染它，此前没有分支会掉进下面的量表分叉渲染成空块。 */
      const chips = Object.keys(crit).map((k) =>
        '<span class="crit-chip' + (k === AutoCore.TEXT_NONE ? ' violet' : '') + '" title="' + escapeHtml(crit[k]) + '">' + escapeHtml(k) + '</span>').join('');
      return '<div class="crit-cloud">' + chips + '</div>';
    }
    /* 未完成：等级量表（行数随 auto-core 的 SCORE_LEVELS 走） */
    const levels = Array.isArray(crit) ? crit : [];
    return '<div class="scale-row">' + levels.map((c, i) =>
      '<div class="scale-cell" title="' + escapeHtml(c) + '"><span class="scale-no">' + i + '</span><span class="scale-txt">' + escapeHtml(c) + '</span></div>').join('') +
      '</div>';
  }

  /* 问题块：首轮与补问共用同一套渲染（payload 是「这一轮发出去的那份」）——
   * 补问只含一道题，标题就把题数写成 1。 */
  function questionsSectionHtml(payload, step) {
    const qs = (payload && payload.questions) || {};
    const ORDER = ['动作', '参数', '文本', '未完成'];   // 首轮 3 道（文本已移入补问）；弹窗步只有「动作」1 道
    const meta = {
      动作: Object.keys(qs['动作'] && qs['动作'].criteria || {}).length + ' 个候选',
      参数: Object.keys(qs['参数'] && qs['参数'].criteria || {}).length + ' 个候选 ref',
      文本: Object.keys(qs['文本'] && qs['文本'].criteria || {}).length + ' 个候选',
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

  /* 补问行动视图：与首轮卡同构 ——
   *   结论行（已选定 X / 已改为 X / 命中 e5 / 失败：…）
   *   问题块（本轮输入 · 1 道问题：instructions + 候选）
   *   作答卡（本轮输出 · 作答与概率分布：选中值 + 置信度 + 概率条）
   *   原始报文（折叠）
   * 改版前这里只有两块裸 JSON：同一类「一次 Jev 调用」在 UI 上有两套渲染标准 ——
   * 单题响应里的 probabilities 明明在，却只有首轮那张网格在渲染。 */
  function followUpViewHtml(st, a, dk) {
    const qname = FOLLOWUP_Q[a.kind] || '参数';
    const settled = Boolean(a.param || a.action || a.text || a.error);
    const hit = a.kind === 'action'
      ? (a.action ? '已改为 ' + a.action : (a.error ? '失败：' + a.error : '未返回'))
      : a.kind === 'text'
        ? (a.text ? '已选定 ' + a.text : (a.error ? '失败：' + a.error : '未返回'))
        : (a.param ? '命中 ' + a.param : (a.error ? '失败：' + a.error : '未命中'));
    const ans = (a.response && a.response.answers && a.response.answers[qname]) || null;

    let html = '<div class="fu-hit' + (a.error ? ' bad' : (settled ? '' : ' pend')) + '">' + escapeHtml(hit) + '</div>';
    /* 不重复 state：补问发的是与本步首轮同一份 state */
    html += questionsSectionHtml(a.payload, st);
    if (ans) {
      html += '<div class="sec"><div class="sec-head">本轮输出 · 作答与概率分布</div><div class="qgrid">'
        + choiceCardHtml(qname, ans, a.kind === 'param' && a.param ? refChipLabel(a.param, st.refLabels)
          : (a.kind === 'text' && a.text ? varLabelOf(a.text) : null), '')
        + '</div></div>';
    }
    if (a.error) html += '<div class="step-err">' + escapeHtml(a.error) + '</div>';
    html += '<div class="sec"><div class="sec-head">原始报文</div>' +
      '<details class="req-details" data-dk="' + dk + '"' + (settled ? '' : ' open') + '>' +
      '<summary>① 发送的请求体（仅「' + escapeHtml(qname) + '」一题）· ② Jev 响应</summary>' +
      '<div class="req-inner">' +
      rawBlock('① 发送的请求体', relaxedStringify(a.payload || null)) +
      rawBlock('② Jev 响应', a.response ? JSON.stringify(a.response, null, 2) : '（调用失败，无响应）') +
      '</div></details></div>';
    return html;
  }

  /* 每次步骤对象变化后调用：渲染合并到下一帧（同一帧多次 touch 只重建一次），并节流落盘。
   * 用户交互路径（select / 跟随按钮 / 会话切换）仍走同步 renderFlow，不经过此合并。 */
  let renderQueued = false;
  function touch() {
    saveRun(false);
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; renderFlow(); });
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

  /* ---------- 单步确认（挂 #fdConfirm：autoFlow 的兄弟容器，树/详情重建不影响它） ---------- */
  function awaitConfirm(step) {
    return new Promise((resolve) => {
      if (view.sess !== 'current' || view.type !== 'step' || view.n !== step.n) select('step', step.n, null, false);
      const host = document.getElementById('fdConfirm');
      if (!host) return resolve('run');   /* 视图异常时保守执行 */
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
      host.appendChild(bar);
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

  /* ---------- 追问的公共骨架 ----------
   * 三处补问（参数批次 / 动作冲突 / 文本）走的是同一套流程：建请求 → 记一条 followUps
   * → 发 → 校验答案落在候选里 → 交给各自的 apply 落定。此前三处各写一遍这 12 行，
   * 连「Jev 返回了不在候选里的…」都在各自漂移；现在只有这一份。
   * opt = { qname 题名（同时是 rec 上要校验的那道题）, noun 报错里的名词（缺省同 qname）,
   *         parse 从 answers 取答案, apply 落定并返回是否成功 } */
  function parseErrText(e) { return (e && e.message) || String(e); }

  async function askFollowUp(step, rec, questions, opt) {
    const payload = { state: step.payload.state, model: Config.current.model, questions };
    rec.payload = payload;
    step.followUps.push(rec);
    touch();

    const jev = await callJev(payload);
    if (!jev.ok) { rec.error = jev.error; return false; }
    rec.response = jev.data;

    let value;
    try { value = opt.parse(jev.data.answers || {}); }
    catch (e) { rec.error = '决策解析失败：' + parseErrText(e); return false; }
    if (!questions[opt.qname].criteria[value]) {
      rec.error = 'Jev 返回了不在候选里的' + (opt.noun || opt.qname) + '：' + value;
      return false;
    }
    return opt.apply(value);
  }

  /* ---------- 候选裁剪：Jev 选了「其他」时补问下一批 ----------
   * 只补问「参数」一题（动作已定，不重发整组问题以免连带动摇动作决策），
   * 每一步最多展开 maxTranches 批；每批的请求/响应都留在步骤卡里。 */
  async function resolveMoreBatches(step) {
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
      const rec = { kind: 'param', batch, payload: null, response: null, error: null, param: null };
      const done = await askFollowUp(step, rec, questions, {
        qname: '参数', noun: '元素', parse: AutoCore.parseParamAnswer,
        apply: (param) => {
          rec.param = param;
          if (!AutoCore.isRefMore(param)) {
            step.decision = Object.assign({}, step.decision, { param: param });
            return true;
          }
          if (batch === trim.maxTranches) { rec.error = '本批仍选了「其他」，但已是最后一批'; }
          return false;   /* 没落定：继续展开下一批（已是最后一批时循环自然结束） */
        },
      });
      if (done) return true;
    }
    return false;
  }

  /* ---------- 动作 × 元素角色不兼容：同一步内补问「动作」 ----------
   * 实测事故：模型对 button "发货" 选了 select，命令打到 playwright 才被
   * "Element is not a <select> element" 拦下，白烧一步。现在这一类"物理上不可能"的组合
   * 在发命令前就被拦下，只补问「动作」一题（候选已去掉该元素上不可能的动作，且不带终止态 ——
   * 终止只能走主循环那条通道）。补问的请求/响应同样留在步骤卡里。
   * 与 resolveMoreBatches 的分工：那个改「参数」，这个改「动作」。 */
  async function resolveActionConflict(step, conflict, refRoles) {
    const questions = AutoCore.buildActionFollowUp(conflict);
    const rec = {
      kind: 'action', payload: null, response: null, error: null, action: null,
      from: conflict.action, role: conflict.role, ref: conflict.ref, why: conflict.why,
    };
    return askFollowUp(step, rec, questions, {
      qname: '动作', parse: AutoCore.parseActionAnswer,
      apply: (action) => {
        rec.action = action;
        /* 补问后仍不兼容（例如又选了另一个该元素上不可能的动作）：不发命令，记失败步 */
        const next = Object.assign({}, step.decision, { action });
        if (AutoCore.checkActionRole(next, refRoles).conflict) {
          rec.error = '补问后仍选了不兼容的动作：' + action;
          return false;
        }
        step.decision = next;
        return true;
      },
    });
  }

  /* ---------- 文本补问：动作 + 参数落定后，同一步内补问「文本」一题 ----------
   * 文本不再随首轮作答（因子化 4 题拼出过 select 下拉框 "王小明" 的嵌合决策）：
   * 现在候选只服务已确定的动作 —— select 给下拉框真实选项名、press 给变量 ∪ 键名、
   * 其余给变量池，可选文本动作附「无」。builder 返回 null（无需文本 / 零候选）
   * 时不发请求，调用方据此记确定性失败步。
   * 与前两个补问的分工：param 改「参数」、action 改「动作」、这个补「文本」。 */
  async function resolveTextFollowUp(step, refLabels) {
    const questions = AutoCore.buildTextFollowUp({
      action: step.decision.action, param: step.decision.param,
      snapshot: step.snapshot, variables: runCfg.variables,
      refLabel: refLabels[step.decision.param] || '',
      tabs: step.pageInfo && Array.isArray(step.pageInfo.tabs) ? step.pageInfo.tabs : null,
    });
    if (!questions) return false;   // 无需文本不会进来；零候选 = 配置性缺失，由调用方记失败步

    /* 注意字段名：补问渲染用 r.action 判断「动作补问已落定」，text 记录的动作只是
     * 上下文 —— 建记录时就填 action 会让详情在补问飞行中渲染一次「未返回」后
     * 再也不刷新。上下文用独立的 forAction。 */
    const rec = { kind: 'text', payload: null, response: null, error: null, text: null, forAction: step.decision.action };
    return askFollowUp(step, rec, questions, {
      qname: '文本', parse: AutoCore.parseTextAnswer,
      apply: (text) => {
        rec.text = text;
        step.decision = Object.assign({}, step.decision, { text });
        return true;
      },
    });
  }

  /* ---------- 截图（操作前，带元素标注） ----------
   * 图来自 server 的 screenshot（动作前拍），标注在这里用 canvas 画到图上 ——
   * 被驱动的浏览器窗口里不留任何痕迹，标注只存在于可视化页面展示的这张图里。
   * 几何换算（CSS 像素 → 图像像素）由 anno.js 负责，**比例不用画布尺寸反推**：
   * driver 调 screenshot 时不带 --hires（css 档），2026-09-28 真机实测图内容与 CSS 像素
   * 严格 1:1；画布尺寸 = 视口宽 / 页面缩放，是画布比例不是内容比例，拿它换算会在页面
   * 缩放不是 100% 时整片偏移（详见 anno.js 文件头 3）。r.viewport 仍进记录（排查用），
   * 但不参与换算。 */
  const SHOT_SCALE_CSS = 1;
  async function takeShot(step, name, ref) {
    const r = await apiJson('/api/browser/screenshot', { name, ref: ref || null });
    /* 守卫拦下（专用标签页没了）：连图都不要取 —— 当前页可能是用户自己的页面 */
    if (r.lostTab) return false;
    if (!r.ok || !r.dataUrl) return false;
    if (!r.rect || !r.viewport || !window.Anno) {
      step.screenshot = r.dataUrl;              /* 无元素可标（goto / press / 终止帧）就显示原图 */
      step.anno = null;
      return true;
    }
    const composed = await Anno.compose(r.dataUrl, r.rect, SHOT_SCALE_CSS, step.n);
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
   * 可以直接用 decision.param（与 planExecution 的 ref 同源）。
   * 判定必须走 isRefParam（refLabels = 当前快照解析出的全量 ref 表）：曾用
   * /^e[A-Za-z0-9_-]+$/ 猜形状，切到第 N 个标签页后 playwright 把 ref 前缀变成 fN
   * （e496 → f2e496），正则全部失配 → 这里静默返回 null，「被操作元素」的标注框
   * 从切标签页之后每一步都消失，且不报任何错。 */
  function assignRef(decision, refLabels) {
    if (!decision) return null;
    if (AutoCore.TERMINAL_TOOLS[decision.action] || decision.action === '无操作') return null;
    return AutoCore.isRefParam(decision.param, refLabels) ? decision.param : null;
  }

  /* ---------- 执行决策 ---------- */
  async function executeDecision(step, decision, refLabels) {
    /* 终止动作：调用方在 ⑦ 就拦下并 return 了，正常流程到不了这里。
     * 留这道保险是为了将来多一个调用方时，终止动作不会被当成浏览器命令发出去。 */
    if (AutoCore.TERMINAL_TOOLS[decision.action]) {
      step.terminal = decision.action;
      return;
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
        L.error = '生成模型调用失败：' + parseErrText(e);
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
      step.exec = { cmd: cmdDisplay('fill', decision.param, L.text), elapsedMs: Date.now() - t0, ok: Boolean(act.ok), error: act.ok ? null : act.error, lostTab: Boolean(act.lostTab) };
      if (act.ok) step.generatedText = L.text;
      return {};
    }
    /* 常规动作 */
    let plan;
    try {
      plan = AutoCore.planExecution(decision, runCfg.variables);
    } catch (e) {
      step.exec = { ok: false, error: parseErrText(e), cmd: null };
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
      /* 专用标签页没了（driver 的守卫拦下）：这不是「这一步失败」，是整轮该停 ——
       * 交给调用方收尾，别让它变成一条可重试的失败喂回给模型 */
      lostTab: Boolean(act.lostTab),
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
    if (invalid) return showErr('✗ 任务配置不完整', invalid + '\n\n在上面补好「任务目标」与「起始 URL」再点开始。');
    if (!Config.current.key.trim()) return showErr('✗ 缺少 API Key', '请先在右上角「⚙ 配置」填写 Jev 的 API Key。');

    /* 同步占坑（设计 §11：同会话仅一个循环）：必须在任何 await 之前，
     * 否则 probeEngine 的网络间隙内双击会并发两个 runLoop */
    running = true;
    els.start.disabled = true;
    els.editTask.disabled = true;   /* 运行中锁配置，避免改到一半参数与 runCfg 不一致 */
    updateModeSegLock();            /* 中止口不能被 modeSeg 藏掉（见 updateModeSegLock） */

    let engineOk = false;
    try {
      engineOk = await probeEngine();
    } finally {
      if (!engineOk) {
        running = false;
        els.start.disabled = false;
        els.editTask.disabled = false;
        updateModeSegLock();
      }
    }
    if (!engineOk) return showErr('✗ 浏览器引擎不可用', 'playwright-jev-agent 需要全局安装 playwright-cli：npm i -g @playwright/cli（装好后刷新本页）。');

    /* CDP 直连的前置条件先说清楚：没探到开着调试端口的浏览器、又没手填端点，
     * 那 run 一定死在第一步 —— 与其等 attach 报错，不如现在告诉用户怎么做。
     * 提示原文（做法就在里面）整段摊进错误条：那是要照着做的步骤，得能选中、能复制。
     * 另外：端点框里若留着 http:// 形态（早先的占位符就是这么教的），探到了就就地换成
     * 那条 ws —— Chrome 147+ 在默认 profile 上关了 /json 发现，http 形态 attach 必 404。 */
    const mode = els.browserMode.value;
    let cdpTarget = els.cdpTarget.value.trim();
    if (mode === 'cdp') {
      const probe = await apiJson('/api/browser/cdp-probe');
      const usable = !!(probe && probe.ok && probe.available);
      if (!cdpTarget && !usable) {
        running = false;
        els.start.disabled = false;
        els.editTask.disabled = false;
        updateModeSegLock();
        return showErr('✗ CDP 直连没探到可用的浏览器',
          '浏览器已开着调试端口、且端点框留空时才能自动探测。\n\n' + ((probe && probe.hint) || '没探到开着调试端口的浏览器。'));
      }
      if (cdpTarget && /^https?:\/\//i.test(cdpTarget) && usable && /^wss?:\/\//i.test(probe.endpoint || '')) {
        cdpTarget = probe.endpoint;
        els.cdpTarget.value = cdpTarget;            /* 框里显示的就是真正要用的那条，别骗人 */
        toast('http 端点在这台浏览器上会 404，已换成探测到的 ws 端点');
      }
    }

    abortFlag = false; finished = false;
    steps = []; history = []; consecutiveFails = 0; unfinishedHistory = [];
    Object.assign(view, { sess: 'current', type: 'session', n: 0, i: 0, follow: true });
    failedRefs = Object.create(null); refPageUrl = '';
    const plan = windowPlan();
    runCfg = {
      goal, url, maxSteps, variables: collectVars(), screenshotOn: els.screenshot.checked,
      browser: els.browser.value, mode, cdp: cdpTarget, window: plan,
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
    renderFlow();
    updateExportBtn();
    setProgress(0);
    startTimer();
    hideErr();   /* 新的一轮把上一轮的错误条收起来：留着会让人以为又错了 */

    try {
      await runLoop();
    } finally {
      running = false;
      stopTimer();
      els.start.disabled = false;
      els.editTask.disabled = false;
      els.stop.hidden = true;
      updateModeSegLock();
      /* 一轮结束：浏览器可能还开着（isolated 模式不自动关），重新判一次「关闭」是否可点 */
      refreshBrowserState();
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
    updateExportBtn();
    saveRun(true);
    /* 出错类结束原因摊在错误条里（可复制、能搜），其余状态一句话 toast 就够 */
    if (t.state === 'error' || t.state === 'fails' || t.state === 'giveup') {
      showErr('✗ ' + s.label, (t.reason || s.label) + '\n\n本次会话：' + (runId || '—')
        /* 导出按钮只在真有步骤时才出现，别指向一个不存在的按钮 */
        + (steps.length ? '（点「⬇ 导出运行记录」可拿到完整过程）' : ''));
    } else {
      toast(t.reason || s.label);
    }
  }

  async function runLoop() {
    /* 打开浏览器（内核与模式可选；窗口方案随请求带给 server：全屏=原生最大化，固定尺寸=resize）。
     * 先静默关闭残留会话：上轮结束后浏览器可能还开着，已开会话上再 open 会报错；
     * 顺带保证每轮拿到全新的内存态页面（如演示邮箱）。
     * **cdp 模式例外**：那里的「允许远程调试」授权是按连接给的，关掉就得让你重点一次；
     * 复用自己的连接由 driver 处理（模式串了它会自己拆），所以这里不关。 */
    if (runCfg.mode !== 'cdp') await apiJson('/api/browser/close', {});
    const opened = await apiJson('/api/browser/open', Object.assign(
      { url: runCfg.url, browser: runCfg.browser, mode: runCfg.mode, cdp: runCfg.cdp }, runCfg.window));
    if (!opened.ok) {
      finishRun({ done: false, state: 'error', reason: '打开浏览器失败：' + opened.error });
      return;
    }
    /* cdp 不碰用户窗口，也就没有「全屏未生效 / 尺寸调整失败」可言 */
    if (!opened.windowSkipped) {
      if (opened.fullscreen === false) toast('全屏未生效（已退化为最大化窗口）：' + (opened.fullscreenError || ''));
      else if (opened.resized === false) toast('窗口尺寸调整失败：' + (opened.resizeError || ''));
    }
    /* 手填的 http 端点 404 后回退到了端口文件里那条 ws（见 openCdp）：说一声 ——
     * 端点是被换过的，别让人以为跑的是他填的那个 */
    if (opened.swappedFrom) {
      toast('手填的端点回 404（http 形态在默认 profile 上必 404），已自动改用 ' + opened.target);
    }
    runCfg.browserUsed = opened.browser;
    runCfg.fullscreenUsed = opened.fullscreen === true;
    runBrowserOpen = true;   /* 浏览器确实开着了（cdp 直连的那个也算「有开着的」）*/
    updateCloseBtn();

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
        /* CDP 守卫拦下（专用标签页被关/被切走）：这不是快照故障，是本轮该停。
         * 必须判在 isModalSnapshotError 之前，否则会被归成「获取页面快照失败」，
         * 结束原因里看不到真正的原因。 */
        if (snap.lostTab) {
          finishRun({ done: false, state: 'error', reason: snap.error || '专用标签页已不在（CDP 守卫停手）' });
          return;
        }
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
      /* ② 当前页信息 + 全部标签页（工程自动执行；弹窗期间 tab-list 同样可能被拒，
       * 复用上一步的页面信息）。tabs 会让 state 多出「标签页」字段 —— target=_blank
       * 的点击会开新 Tab 而快照不变，没有这个字段模型只会原地反复点（实测事故） */
      let pageInfo;
      let tabNote = '';
      if (dialogMode) {
        const prev = steps[steps.length - 1];
        pageInfo = prev ? prev.pageInfo : { url: runCfg.url, title: '', tabs: null };
      } else {
        const info = await apiJson('/api/browser/page-info', {});
        /* CDP 直连的守卫：driver 每步确认「当前标签页还是我们自己那一个」。
         * 你手动关掉专用标签页后，playwright-cli 会把当前标签页挪到相邻页面 —— 那是
         * 你自己的页面，宁可停手也不能在上面接着点。
         * 结束原因直接用 driver 那句（它自带根因与下一步）：这里再拼前缀会出现
         * 「专用标签页已不在：页面卡在原生弹窗上：…」这种自相矛盾的话。 */
        if (!info.ok && info.lostTab) {
          finishRun({ done: false, state: 'error', reason: info.error || '专用标签页已不在（CDP 守卫停手）' });
          return;
        }
        pageInfo = info.ok
          ? { url: info.url, title: info.title, tabs: Array.isArray(info.tabs) ? info.tabs : null }
          : { url: runCfg.url, title: '', tabs: null };
        /* Tab 数量在上一步之后变多了 → 很可能是上一步的点击开了新 Tab。
         * 这条事实属于「上一步结果」，放进 state 让模型下一轮就能看到 */
        const prevInfo = steps.length ? steps[steps.length - 1].pageInfo : null;
        const prevTabs = prevInfo && Array.isArray(prevInfo.tabs) ? prevInfo.tabs : null;
        if (prevTabs && pageInfo.tabs && pageInfo.tabs.length > prevTabs.length) {
          tabNote = '注意：标签页从 ' + prevTabs.length + ' 个变成 ' + pageInfo.tabs.length
            + ' 个 —— 上一步的点击很可能打开了新 Tab，而当前仍停在原页面。'
            + '若目标内容在新 Tab，请用 tab-select 切换过去（序号见「标签页」）。';
        }
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
        history, lastResult: tabNote ? (lastResult + '\n' + tabNote) : lastResult,
        snapshot: snapText, tabs: pageInfo.tabs,
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
        n, label: null, decision: null, payload, response: null, jevError: null,
        exec: null, llm: null, screenshot: null, terminal: null,
        pageInfo, snapshot: snapText, refLabels, historyLine: null, generatedText: null,
        trim: param.meta, followUps: [], trimNote: null,
      };
      steps.push(step);
      touch();   /* 主调用期间树即出现本步 'run' 脉冲骨架，与状态条同步 */

      const jev = await callJev(payload);
      if (!jev.ok) {
        step.jevError = jev.error;
        step.label = 'Jev 调用失败';   /* 错误终步在树里不能永远显示「决策中…」 */
        touch();
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
        step.exec = { ok: false, error: '决策解析失败：' + parseErrText(e), cmd: null };
        step.label = '决策解析失败';   /* label 初始为 null，此路径不经过 ⑤b-⑤d 的赋值 */
      }

      if (step.decision) {
        step.label = dialogMode
          ? '处理弹窗 · ' + step.decision.action
          : AutoCore.describeDecision(step.decision, refLabels, runCfg.variables);
        /* 弹窗步没有「未完成」题，不参与完成度收敛（两连 <0.2 提前终止的判定） */
        if (step.decision.unfinished != null) unfinishedHistory.push(step.decision.unfinished);
      }
      touch();

      /* ⑤b 参数归一 + 候选裁剪的兜底项「其他」：同一步内补问下一批（最多 maxTranches 批）。
       * 「无需元素」下线后，不作用于元素的动作（goto / press / 标签页…）即便选了参数，
       * 也在这里剥掉 —— 决策记录、时间线标签、后续补问都不再消费它 */
      if (step.decision) {
        const norm = AutoCore.normalizeParam(step.decision);
        if (norm.param !== step.decision.param) {
          step.decision = Object.assign({}, step.decision, { param: norm.param });
          /* label 在 ⑤ 是按**归一前**的原始参数算的。这里剥掉参数（「其他」配到不需要
           * 元素的动作上等）后必须重算 —— 否则「其他 · 展开下一批」这种哨兵文案会留在
           * 时间线上，读起来像真的在展开候选批次（实测事故：dialog-dismiss 步骤）。 */
          step.label = AutoCore.describeDecision(step.decision, refLabels, runCfg.variables);
        }
        if (norm.note) {
          step.trimNote = norm.note;
        } else if (AutoCore.isRefMore(step.decision.param)) {
          if (!param.meta.trimmed) {
            /* 没启用裁剪时候选里根本没有「其他」，这是无效答案，不能拿它去补问 */
            step.exhausted = true;
            step.exec = { ok: false, error: 'Jev 选了候选里没有的「其他」（当前页面未触发候选裁剪）', cmd: null };
            step.label = step.decision.action + '【' + AutoCore.REF_MORE + ' · 无效选项】';
          } else if (await resolveMoreBatches(step)) {
            step.label = AutoCore.describeDecision(step.decision, refLabels, runCfg.variables);
          } else {
            /* 失败原因取补问记录里的真实原因（Jev 调用失败 / 解析失败 / 答案不在候选里…） */
            const last = step.followUps[step.followUps.length - 1] || {};
            step.exhausted = true;
            step.exec = { ok: false, error: last.error || '候选已展开到最后一批仍未命中目标元素', cmd: null };
            step.label = step.decision.action + '【' + AutoCore.REF_MORE + ' · 补问未命中】';
          }
        }
        touch();
      }

      /* ⑤c 动作 × 元素角色不兼容（如 select 配 button）：同一步内补问「动作」，
       * 补不回来就记失败步 —— 两种情况都不把命令发给浏览器 */
      if (step.decision && !step.exhausted) {
        const conflict = AutoCore.checkActionRole(step.decision, refRoles);
        if (conflict.conflict) {
          const fixed = await resolveActionConflict(step, conflict, refRoles);
          if (fixed) {
            step.label = AutoCore.describeDecision(step.decision, refLabels, runCfg.variables);
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
          }
          touch();
        }
      }

      /* ⑤d 文本补问：动作 + 参数都落定后才问「文本」（候选按动作分型 —— select 是
       * 真实选项名，杜绝「在订单状态下拉框选王小明」那类嵌合决策）。
       * 弹窗步跳过：dialog-accept 的 prompt 文本本就不可达，弹窗步也没有文本通道。
       * 构造不出候选（必填动作零候选）或 Jev 答错 → 记失败步，命令不发。 */
      if (step.decision && !step.exhausted && !dialogMode
        && AutoCore.needText(step.decision.action)
        && !AutoCore.TERMINAL_TOOLS[step.decision.action]) {
        const textOk = await resolveTextFollowUp(step, refLabels);
        if (textOk) {
          step.label = AutoCore.describeDecision(step.decision, refLabels, runCfg.variables);
        } else {
          const last = step.followUps.length ? step.followUps[step.followUps.length - 1] : null;
          step.exhausted = true;
          step.exec = {
            ok: false, cmd: null,
            error: (last && last.error) || ('动作 ' + step.decision.action + ' 需要文本，但没有可问的候选（变量池为空'
              + (step.decision.action === 'select' ? ' 且未能读出该下拉框的选项名单'
                : step.decision.action === 'tab-select' ? ' 且未能读到标签页列表' : '') + '）'),
          };
          /* 命令从未发出，元素本身没问题 —— 与 ⑤c 同理不背 failedRefs 的降权 */
          step.refNotTried = true;
          step.label = step.decision.action + '【缺少文本取值】';
        }
        touch();
      }

      /* ⑦ 单步确认（设计 §10/§11：单步确认是安全阀，终止判定同样要过门） */
      if (cadence() === 'single') {
        const choice = await awaitConfirm(step);
        if (choice === 'abort') { abortFlag = true; step.exec = { skipped: true }; touch(); finishRun({ done: false, state: 'aborted', reason: '用户中止' }); return; }
        if (choice === 'skip') {
          step.exec = { skipped: true };
          step.historyLine = n + '. ' + step.label + ' · 用户跳过';
          history.push(step.historyLine);
          lastResult = '用户跳过（未执行）';
          touch();
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
        touch();
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
        await takeShot(step, 'step-' + n, assignRef(step.decision, refLabels));
      }

      /* ⑨ 执行 */
      if (step.decision && !step.exhausted) {
        await executeDecision(step, step.decision, refLabels);
      }
      /* 守卫在 act 里拦下（专用标签页没了）：整轮到此为止 —— 别把「在别人页面上动手」
       * 记成一步可重试的失败，那只会诱导模型继续试 */
      if (step.exec && step.exec.lostTab) {
        finishRun({ done: false, state: 'error', reason: step.exec.error || '专用标签页已不在（CDP 守卫停手）' });
        return;
      }
      const ok = Boolean(step.exec && step.exec.ok);
      /* 失败记忆的键必须是「当前快照里真实存在的 ref」：曾用 /^e[A-Za-z0-9_-]+$/ 猜形状，
       * 切到第 N 个标签页后 playwright 把 ref 前缀变成 fN（e496 → f2e496），正则全部失配，
       * failedRefs 静默失效 —— 实测会话 r-0926-0046-qrys 就此重复点被遮挡元素到终止。 */
      if (!ok && !noop && !step.refNotTried && step.decision
          && AutoCore.isRefParam(step.decision.param, refLabels)) {
        failedRefs[step.decision.param] = 1;
      }

      /* ⑩ 历史与失败计数 */
      step.historyLine = AutoCore.formatHistoryStep(n, step.label, ok, step.exec && step.exec.error);
      history.push(step.historyLine);
      lastResult = ok
        ? (step.generatedText ? '成功（生成并填入：' + step.generatedText.slice(0, 60) + '）' : '成功')
        /* 与 historyLine 同一份摘要：这里的 slice(0,120) 会把排在末尾的遮挡根因再切一次，
         * 「上一步结果」是模型下一轮唯一的失败线索，不能只剩「超时」 */
        : '失败：' + AutoCore.briefError(step.exec && step.exec.error);
      consecutiveFails = (ok || noop || (step.exec && step.exec.skipped)) ? 0 : consecutiveFails + 1;

      touch();

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
  /* 导出按钮跟随「你正在看的会话」：
   *   当前会话 —— 维持旧行为（跑完才出现，导出模块级的当前 steps）
   *   历史会话 —— 有步骤就出现，文案带上会话 id（验收看的就是导出的那一条） */
  const EXPORT_CUR = '⬇ 导出运行记录';
  function updateExportBtn() {
    if (!els.exportBtn) return;
    if (view.sess !== 'current') {
      const rec = viewRecord;
      const n = rec && rec.steps ? rec.steps.length : 0;
      els.exportBtn.hidden = !n;
      els.exportBtn.textContent = '⬇ 导出该会话记录 ' + ((rec && rec.meta && rec.meta.id) || '');
      els.exportBtn.title = '下载该会话的完整 JSON 记录（每一步的请求体、响应、执行与截图）';
      return;
    }
    els.exportBtn.hidden = !(steps.length && finished);
    els.exportBtn.textContent = EXPORT_CUR;
    els.exportBtn.title = '下载本次运行的完整 JSON 记录（每一步的请求体、响应、执行与截图）';
  }

  function downloadJson(name, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  /* 与落盘同一格式（AutoCore.buildRunRecord → { meta, steps }），文件即会话记录 */
  function exportRun() {
    /* 历史会话：viewRecord 已经是 hydrate 过的 {meta, steps}，直接落盘形状导出，
     * 不重跑 buildRunRecord（那是「正在跑的这一轮」的构造器，会读 runCfg） */
    if (view.sess !== 'current') {
      const rec = viewRecord;
      if (!rec || !(rec.steps || []).length) return toast('这条会话没有可导出的步骤');
      const id = (rec.meta && rec.meta.id) || 'session';
      downloadJson('jev-auto-run-' + id + '.json', {
        meta: rec.meta, steps: rec.steps, exportedAt: new Date().toISOString(),
      });
      toast('已导出会话记录 ' + id + '（' + rec.steps.length + ' 步）');
      return;
    }
    if (!steps.length || !runCfg || !runId) return toast('还没有可导出的运行记录');
    const record = AutoCore.buildRunRecord({
      id: runId, runCfg,
      jevModel: Config.current.model,
      llmModel: Config.llm.configured() ? Config.llm.get().model : null,
      startedAt: runStartedAt, endedAt: new Date().toISOString(),
      endState: els.runPill.dataset.state || 'error', endReason: endReasonText,
      exportedAt: new Date().toISOString(),
      steps,
    });
    downloadJson('jev-auto-run-' + runId + '.json', record);
    toast('已导出运行记录（' + steps.length + ' 步）');
  }

  /* ---------- 模式切换 ---------- */
  /* 运行中锁死模式切换：switchMode 会把整个 #autoPanel 藏起来，而「■ 中止」就在面板里 ——
   * 切到 Demo 就等于把中止口从用户手底下抽走。直接禁用比「点了再弹错误条」清楚。 */
  function updateModeSegLock() {
    if (!els.modeSeg) return;
    Array.from(els.modeSeg.querySelectorAll('.seg-btn')).forEach((b) => {
      b.disabled = running;
      b.title = running ? '运行中不能切换模式，先点「■ 中止」' : '';
    });
  }

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
      /* 只说 server 说的那一句：cdp 是「已断开连接（你的浏览器仍在运行）」、本来就没开着
       * 是「当前没有开着的浏览器（无需关闭）」—— 无条件报「浏览器已关闭」是谎话 */
      if (r && r.message) toast(r.message);
      else if (r && r.ok) toast(r.attached ? '已断开连接' : '浏览器已关闭');
      else toast('关闭失败：' + ((r && r.error) || ''));
      /* 关成功了（含「本来就没开」）才把「本轮浏览器开着」这条记忆清掉：失败了就还得留着，
       * 否则 title 会退回「（若已开）」而在我们明明知道它没关掉时说含糊话 */
      if (r && r.ok) runBrowserOpen = false;
      updateCloseBtn();
      refreshBrowserState();   /* cdp 模式下「断开」不等于「关了」—— 重探一次再定 title 措辞 */
    };
    els.addVar.onclick = () => addVarRow('', '');
    els.browserMode.onchange = refreshModeFields;
    /* 外层三个字段是「唯一数据源」，点开始直接读它们 —— 但场景高亮、运行参数摘要、
     * 以及开跑前检查（目标/URL 两格）得跟着刷新。检查条走**尾部节流**：它是 live region，
     * 每键重建会把四格重播一遍（见 renderPreflight 的签名短路）。 */
    els.url.addEventListener('input', () => { renderSummary(); schedulePreflight(); });
    els.goal.addEventListener('input', () => { renderSummary(); schedulePreflight(); });
    /* 配置弹窗保存后「Jev Key」那一格要立刻翻牌。不动 app.js：在其 click 之后补一次
     * 重渲染（setTimeout 0 保证排在 app.js 的保存逻辑之后，读到的是新值） */
    const cfgSave = document.getElementById('configSave');
    if (cfgSave) cfgSave.addEventListener('click', () => setTimeout(renderPreflight, 0));
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
      trapTab(e, els.taskModal);
    });
    els.exportBtn.onclick = exportRun;
    /* 会话下拉：开合 + 点外收起；打开时拉最新列表、清掉上次的过滤词并把焦点交给过滤框 ——
     * 开合对象是 #autoSessPanel（列表本体只是它内部可滚的那一截，toggle 它永远不显示） */
    els.sessBtn.onclick = (e) => {
      e.stopPropagation();
      const willOpen = els.sessPanel.hidden;
      els.sessPanel.hidden = !willOpen;
      if (!willOpen) return;
      els.sessFilter.value = '';
      els.sessFilter.focus();
      refreshRunsList();
    };
    els.sessFilter.addEventListener('input', renderSessList);
    document.addEventListener('click', (e) => {
      if (!els.sessDd.contains(e.target)) els.sessPanel.hidden = true;
    });
    /* 键盘 ←→ 在当前视图的步骤列表间移动（历史会话视图同样生效；
     * 输入控件聚焦、或编辑弹窗打开时不抢按键） */
    document.addEventListener('keydown', (e) => {
      if (els.panel.hidden || !steps.length || !els.taskModal.hidden) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const t = e.target;
      if (t && /^(input|textarea|select)$/i.test(t.tagName)) return;
      const list = viewedSteps(); if (!list.length) return;
      select('step', Math.max(1, Math.min(list.length, view.n + (e.key === 'ArrowRight' ? 1 : -1))), null, true);
      e.preventDefault();
    });
  }

  function init() {
    renderVars();
    primeScreenOptions();
    /* 记住过浏览器模式/端点就恢复它们（cdp 是要先做调试端口设置的刻意选择，
     * 刷新页面就丢会很难受）；没存过则维持 HTML 里的默认值 isolated。 */
    els.browserMode.value = readStoredMode();
    try { els.cdpTarget.value = localStorage.getItem(CDP_KEY) || ''; } catch (_) { /* 读不到就算了 */ }
    refreshModeFields();
    /* 默认走一个场景：别让用户面对空白表单开场 */
    if (!els.goal.value.trim() && !els.url.value.trim() && SCENARIOS.length) {
      applyScenario(SCENARIOS[0].id, true);
    }
    renderSummary();
    renderPreflight();
    bindEvents();
    updateModeSegLock();
    updateCloseBtn();       /* 先落一个「空闲」的默认态，随后 refreshBrowserState 再按探测结果校正 */
    probeEngine();          /* 完成后自己会再刷一次检查条（引擎那一格） */
    refreshBrowserState();  /* 决定「关闭浏览器」开局是否可点（空闲时应为不可点） */
    refreshRunsList();
  }

  return { init: init };
})();

Auto.init();
