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
    backend: document.getElementById('autoBackend'),
    cdpField: document.getElementById('autoCdpField'),
    cdpTarget: document.getElementById('autoCdpTarget'),
    cdpWarn: document.getElementById('autoCdpWarn'),
    screen: document.getElementById('autoScreen'),
    maxSteps: document.getElementById('autoMaxSteps'),
    screenshot: document.getElementById('autoScreenshot'),
    pauseFirst: document.getElementById('autoPauseFirst'),
    pauseField: document.getElementById('autoPauseField'),
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
  /* 上一步动作顺带带回的快照（driver 的 act.snapshot）——「直接顶替下一步的 snapshot」。
   * 有它就省掉这一步开头那次 /api/browser/snapshot（cdp 模式下那条还要多一条守卫 eval，
   * 一次进程固定约 0.9s，两次约 1.8s），而且它取自动作之后的「等稳定之后」，比现在
   * 在动作之前拍更贴近模型要判断的那一页。
   * 收不收、什么时候清，规则全在 AutoCore.makeSnapshotCarrier（那边有单测盯着）：
   * 只有动作成功且带回非空字符串才收，取走即清，开跑时 reset。
   * 兜底永远是真取一次 —— 那也是原生弹窗唯一能被发现的地方（snapshot 接口报 modal state
   * 才转得出「弹窗步」）。 */
  const snapshotCarrier = AutoCore.makeSnapshotCarrier();
  let startTs = 0;
  let timerId = null;
  let finished = false;
  /* 耗时三个锚点（spec 2026-09-28 §4）：准备 / 步骤 / 收尾 的分界，
   * 三者与 startTs 一起构成恒等式「准备 + Σ步耗时 + 收尾 = 墙钟」。
   * 墙钟口径必须与顶部那个秒数一致（elapsedMs()）—— 它**扣掉了人工门的等待**
   * （人工登录三分钟不该算进任务耗时）。所以准备也照样扣：prepMs 在循环入口一次算定。 */
  let loopStartTs = 0;         /* 主循环真正开始（准备工作结束）的时刻 */
  let prevStepEndTs = 0;       /* 上一步最后一个动作做完的时刻：步耗时从它起算 */
  let prepMs = null;           /* 准备耗时（已扣除人工门等待），循环入口定下后不再变 */
  let finalWallMs = null;      /* 结束那一刻的墙钟，供落盘与对账条定格 */

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
          /* 对账两件套：运行中墙钟取当下（随时可平账），结束时已由 finishRun 定格。
           * 走 elapsedMs() 与顶部秒数同源（人工门等待不计入）。 */
          timing: {
            prepMs: prepMs,
            wallMs: finalWallMs != null ? finalWallMs : (startTs ? elapsedMs() : null),
          },
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
      renderSessDd(); renderFlow(); syncSessUrl();
      return;
    }
    const r = await apiJson('/api/runs/' + which, null, { cache: 'no-store' });
    if (!r.ok) {
      toast('历史会话读取失败：' + apiErrText(r));
      refreshRunsList();
      return;                    /* 视图没动，地址栏也别动 —— 别把一条读不出来的 id 写进 URL */
    }
    viewRecord = hydrateRecord(r);
    view.sess = which; view.type = 'session'; view.follow = false;
    renderSessDd(); renderFlow(); syncSessUrl();
  }

  /* ---------- URL 里的会话（?sess=<id>） ----------
   * 会话视图做成可分享的：看历史会话时地址栏写 ?sess=<id>，看本页这一轮时把参数清掉
   * （于是默认 URL 与这个功能上线前逐字一致，不带参数的链接行为完全没变）。
   *
   * 用 replaceState 而不是 pushState：本页其它状态切换（模式 / 演示场景 / state 编辑）
   * 一律不进浏览器历史，只给会话开一个例外会让「后退」的行为变得难以预测 —— 后退到底是
   * 回上一个会话还是上一个页面？现在统一是「上一步操作不进历史」，后退永远离开本页。
   *
   * 正在跑的这一轮不进 URL：那是页面自己的活视图，刷新后本页会起一轮新的空会话，
   * 把它当成「可分享的既成记录」分享出去只会误导人（列表里它会被标成「中断」）。 */
  const SESS_PARAM = 'sess';

  function urlSessId() {
    try { return new URL(location.href).searchParams.get(SESS_PARAM) || ''; }
    catch (_) { return ''; }
  }

  /* 把「正在看哪个会话」写回地址栏。写不进去（file:// / 被策略挡）就静默跳过：
   * 地址栏同步是附赠品，会话切换本身不该因为它失败。 */
  function syncSessUrl() {
    try {
      const u = new URL(location.href);
      if (view.sess === 'current') u.searchParams.delete(SESS_PARAM);
      else u.searchParams.set(SESS_PARAM, view.sess);
      const next = u.pathname + u.search + u.hash;
      /* 只在真的变了的时候写：无谓的 replaceState 会把「复制 URL」之外的其它 hash 改动搅乱 */
      if (next !== location.pathname + location.search + location.hash) {
        /* 必须写 window.history：本文件第 73 行有个同名的 `let history = []`（已完成步骤），
         * 裸写 history 会被它遮住，运行时炸出 "replaceState is not a function"。 */
        window.history.replaceState(null, '', next);
      }
    } catch (_) { /* 地址栏不可写：不影响会话切换 */ }
  }

  /* 启动时按 URL 落到那条会话上。列表要先拉回来 —— 一是这里要靠它判断 id 是否真的存在
   * （不然只会得到一句笼统的「读取失败」，看不出是 id 过期还是服务出问题），二是
   * 「本页这一轮」那条要排在下拉列表最前。 */
  async function openSessionFromUrl() {
    const id = urlSessId();
    if (!id || id === 'current') { syncSessUrl(); return; }
    /* 会话树在 auto 面板里：不切过去，深链打开的页面看上去像「什么都没发生」 */
    switchMode('auto');
    try { await refreshRunsList(); } catch (_) { /* 列表拿不到也往下走，交给 openSession 报错 */ }
    if (id !== runId && !runsList.some((m) => m.id === id)) {
      toast('URL 里的会话不存在或已被清理：' + id);
      openSession('current');    /* 顺带把地址栏里这条死 id 清掉 */
      return;
    }
    await openSession(id);
  }

  /* 树视图状态：sess='current' 看本页运行，否则为历史会话 id；type= session|step|action */
  const view = { sess: 'current', type: 'session', n: 0, i: 0, follow: true };
  let viewRecord = null;     // 历史会话记录（已 hydrate 成运行时形状）
  let runsList = [];         // GET /api/runs 列表（下拉数据源）

  /* 步间间隔（设计 §11）。**默认 0**：这一步的页面稳定由动作自带的 settle 负责
   * （动作之后的静默期 + 等动作期间发出的请求 + 取快照，见 browser-driver 的
   * SETTLE_MS / SETTLE_REQ_CAP_MS），紧接的下一步读的也是同一份已稳定的页面，
   * 这里再静默 800ms 纯属白等 —— 8 步就是 6.4s，占整轮墙钟的 8%。
   * 留这个常量而不是删掉：演示要让人眼看清楚时，把它调回几百毫秒即可，
   * 结算口径（settleStepMs 把这段算进上一步）不用动。 */
  const STEP_GAP_MS = 0;

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
    /* 实现在 auto-core（纯逻辑、可被 node:test 往返对账）——
     * 这条「落盘 → 重新载入 → 面板」的边界原先只活在浏览器里，丢字段丢得无声无息 */
    return AutoCore.hydrateRecord(rec);
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
    {
      /* 与上一个「订单后台」场景刻意成对：同一个业务、同一类页面，但那一个把步骤
       * ①→⑤ 写死给模型，这一个只给业务意图 —— 用来观察 Jev 自己能不能把意图拆成
       * 可执行的步骤（泛化能力），也用来验证它在更多字段 / 更复杂筛选下还找不找得准。 */
      id: 'orders-complex', icon: '🧾', name: '订单后台（复杂）', path: '/demo/orders-complex.html',
      goal: '客服接到一位金卡会员的催单：这笔订单买的是 AirPods Pro 2 正品耳机，已经付款但仓库还没安排出库。请把这一笔订单标记为已发货，其余订单一律保持原样。注意别发错——保护套、耳塞这类配件，以及 AirPods 4 等其它型号，都不是这位会员买的那个。',
      vars: [{ name: '会员等级', value: '金卡' }, { name: '商品关键词', value: 'AirPods Pro 2' }],
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
  /* 驱动后端也记住：切回 playwright-cli 通常是「进程内这条在某个站点上出问题」的
   * 刻意选择，刷新就丢会让人反复踩同一个坑。 */
  const BACKEND_KEY = 'jev-auto-backend';

  /* 合法后端同样以 DOM 里的真实 option 为准（与 validModes 同一条理由：
   * localStorage 里的脏值不该用，而权威清单只能有一处） */
  function validBackends() {
    return els.backend ? Array.from(els.backend.options).map((o) => o.value) : ['inproc'];
  }
  function readStoredBackend() {
    try {
      const b = localStorage.getItem(BACKEND_KEY);
      return validBackends().includes(b) ? b : 'inproc';
    } catch (_) { return 'inproc'; }
  }

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
      backend: els.backend.value,
      cdp: els.cdpTarget.value.trim(),
      screen: els.screen.value,
      screenshot: els.screenshot.checked,
      pauseFirst: els.pauseFirst.checked,
    };
  }
  /* 运行参数：弹窗里那几个。取消弹窗只回滚这一份。 */
  function readRunParams() {
    return {
      maxSteps: els.maxSteps.value,
      cadence: cadence(),
      browser: els.browser.value,
      mode: els.browserMode.value,
      backend: els.backend.value,
      cdp: els.cdpTarget.value.trim(),
      screen: els.screen.value,
      screenshot: els.screenshot.checked,
      pauseFirst: els.pauseFirst.checked,
    };
  }
  function writeRunParams(c) {
    if (!c) return;
    els.maxSteps.value = c.maxSteps;
    const radio = document.querySelector('input[name="autoCadence"][value="' + c.cadence + '"]');
    if (radio) radio.checked = true;
    els.browser.value = c.browser;
    els.browserMode.value = c.mode;
    if (validBackends().includes(c.backend)) els.backend.value = c.backend;
    els.cdpTarget.value = c.cdp || '';
    els.screen.value = c.screen;
    els.screenshot.checked = c.screenshot;
    els.pauseFirst.checked = Boolean(c.pauseFirst);
    refreshModeFields();
  }

  /* 模式相关的界面反应：cdp 才显示端点输入与风险提示；窗口尺寸在 cdp 下无意义
   * （我们不会去改用户的窗口），所以把那一栏禁用掉，而不是让它看起来还能选。 */
  function refreshModeFields() {
    const cdp = els.browserMode.value === 'cdp';
    els.cdpField.hidden = !cdp;
    setWarnbar(els.cdpWarn, cdp);
    els.screen.disabled = cdp;
    /* 「开跑后先暂停」在 cdp 下没有意义：那道门是为了让**我们起的**那个干净浏览器先被人工
     * 登录，而 cdp 复用的本来就是你已经登录着的浏览器。留着它只会承诺一件不会发生的事 ——
     * 与上面「窗口尺寸在 cdp 下禁用」同一条理由。 */
    els.pauseField.hidden = cdp;
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
      /* cdp 下这个勾选框是隐藏的（readForm 读到的可能仍是残留的 true），所以这里跟着
       * 一起判模式 —— 摘要不许承诺一件该模式下不会发生的事，与 screenLabel 同一条规矩。 */
      (f.pauseFirst && f.mode !== 'cdp') ? '开跑后先暂停' : '',
    ].filter(Boolean).join(' · '));
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
      localStorage.setItem(BACKEND_KEY, els.backend.value);
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
    /* 正在跑的那一步：只有它跳秒。条件是 stepDot 里判 'run' 的同一套 ——
     * 历史会话（view.sess !== 'current'）的最后一步绝不能显示成还在跑。 */
    const liveStep = (view.sess === 'current' && running && steps.length) ? steps[steps.length - 1] : null;
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
      const live = st === liveStep && running;      /* 只有正在跑的那一步才说得上「计时中」 */
      tree.appendChild(mk('s:' + st.n, 'kid' + (acts.length > 1 ? ' has-acts' : '') + sel(view.type === 'step' && view.n === st.n),
        '<span class="dot ' + stepDot(st) + '"></span>'
        /* 命令段（click 【e48 · …】）走等宽小字号，与中文 sans 区分；CJK 自动回退 */
        + '<span class="lb"><b>步骤 ' + st.n + '</b> · <span class="mono">' + escapeHtml(st.label || '决策中…') + '</span></span>'
        /* 右侧只有 Jev 耗时（这一步各**段** Jev 调用之和：首轮 → 召回 → 补问串行相加；
         * 并行的召回批次算一段，只取最慢那一批，不是 K 批相加）。**只有数字** —— 树宽 320px，
         * 文案一长就把标签挤到第三行被两行钳制吃掉（E2E S9.9 实测）。调用次数进 title 与
         * 步骤详情头部，会话总览表的「行动」列另有次数。步耗时不上树（2026-09-28 收窄）。 */
        + '<span class="dur jev" title="' + escapeHtml(AutoCore.stepDurationTitle(st)) + '">'
        + escapeHtml(AutoCore.stepDurationLine(st, { live: live })) + '</span>'));
      if (acts.length <= 1) return;   /* 单次调用：步骤行自己就是这条调用，不另起子行 */
      acts.forEach((a, i) => {
        /* 末个行动标 last：导轨截止到行中线，与父步骤形成肘形收口 */
        tree.appendChild(mk('a:' + st.n + ':' + i, 'act-kid' + (i === acts.length - 1 ? ' last' : '') + sel(view.type === 'action' && view.n === st.n && view.i === i),
          /* 徽标要说实话：被工程直出的那次**没有调 Jev**，挂「JEV」是假话（同详情头部的 fd-tag） */
          '<span class="k ' + actionKindCls(a) + '">' + actionKindLabel(a) + '</span>'
          + '<span class="lb">' + escapeHtml(a.title) + '</span>'
          /* 每次调用各自的耗时（同属 Jev 耗时，只是拆到每次调用） */
          + '<span class="dur">' + escapeHtml(AutoCore.formatMs(a.ms)) + '</span>'
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
      /* 这次调用的耗时 + 输入/输出 token 直接写在头部（原本只埋在「原始报文」的 JSON 里，
       * 要展开长报文才能看到）。三种行动同构：首轮 / 补问走 Jev，生成输入走生成模型。 */
      const metrics = AutoCore.actionMetricsLine(a);
      /* 钉在「工程直出」的行动上时不能再挂一个「Jev」标签 —— 那一次根本没调 Jev。
       * 类名与树上/行动卡的徽标同源（actionKindCls），文案在这里更长一些 */
      const tagLabel = a.kind === 'llm' ? '生成模型' : (a.local ? '工程直出' : 'Jev');
      head.innerHTML = '<span class="crumb">会话 ▸ 步骤 ' + st.n + ' ▸ 行动 ' + (view.i + 1) + '/' + acts.length + '</span>'
        + '<h2>' + escapeHtml(a.title) + '</h2>'
        + '<span class="fd-tag ' + actionKindCls(a) + '">' + tagLabel + '</span>'
        + (metrics ? '<span class="fd-dur">' + escapeHtml(metrics) + '</span>' : '');
      body.innerHTML = actionViewHtml(st, a);
      animateBars(body);
    }
  }

  function stepBadgeHtml(st) {
    const e = st.exec;
    /* 详情头部只补一个 Jev 合计（含调用次数）。步耗时/其中动作不显示 —— 2026-09-28 收窄为
     * 「只展示 Jev」；单条命令的往返耗时仍在下面命令那一行 · 1239ms 里。 */
    const d = AutoCore.durationView(st);
    const jev = (d.jevMs != null && d.jevCalls)
      ? '<span class="fd-dur">Jev ' + AutoCore.formatMs(d.jevMs) + '（' + d.jevCalls + ' 次调用）</span>' : '';
    if (st.terminal) return '<span class="fd-state term">终止 · ' + escapeHtml(st.terminal) + '</span>';
    if (!e) return '<span class="fd-state run">进行中…</span>' + jev;
    if (e.skipped) return '<span class="fd-state warn">已跳过</span>' + jev;
    return '<span class="fd-state ' + (e.ok ? 'ok' : 'err') + '">' + (e.ok ? '✓ 成功' : '✗ 失败') + (e.elapsedMs != null ? ' · ' + e.elapsedMs + 'ms' : '') + '</span>' + jev;
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
      /* 「用时」列改成 Jev 耗时（含调用次数）：2026-09-28 收窄为只展示 Jev。
       * 单条动作的往返耗时仍在步骤详情的命令那一行。 */
      + '<table class="ov"><thead><tr><th>#</th><th>步骤</th><th>动作</th><th>状态</th><th>Jev 耗时</th><th>行动</th></tr></thead><tbody>'
      + list.map((s) => {
        const dd = s.decision || {};
        const d = AutoCore.durationView(s);
        const nAct = AutoCore.actionsOf(s).length;
        return '<tr data-go="s:' + s.n + '"><td class="mono">' + s.n + '</td><td>' + escapeHtml(s.label || '…') + '</td>'
          + '<td class="mono">' + escapeHtml(dd.action || '—') + (dd.param ? ' ' + escapeHtml(dd.param) : '') + '</td>'
          + '<td>' + (s.exec ? (s.exec.skipped ? '跳过' : (s.exec.ok ? '成功' : '失败')) : (s.terminal ? '终止' : '…')) + '</td>'
          + '<td class="mono jev-num">' + escapeHtml(d.jevCalls ? AutoCore.formatMs(d.jevMs) : '—') + '</td>'
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
    /* 行动列表。计数口径也要说实话：被工程直出的那次**没有调模型**，
     * 一起算进「次模型调用」是假话；没有直出时这一行逐字节不变（老记录与普通步骤不受影响）。 */
    const acts = AutoCore.actionsOf(st);
    const localN = acts.filter((a) => a.local).length;
    const actsLine = (acts.length - localN) + ' 次模型调用'
      + (localN ? ' + ' + localN + ' 次工程直出' : '');
    html += '<div class="sec-t">本步行动 · ' + actsLine + '</div><div class="alist">'
      + acts.map((a, i) => '<button type="button" class="acard" data-go="a:' + st.n + ':' + i + '">'
        + '<span class="k ' + actionKindCls(a) + '">' + actionKindLabel(a) + '</span>'
        + '<span class="t">' + escapeHtml(a.title) + '</span>'
        + '<span class="m">' + escapeHtml(actionBrief(a)) + ' ›</span></button>').join('')
      + '</div>';
    return html;
  }

  /* 行动种类徽标：三种来源分开。
   *   llm    生成模型（生成输入）
   *   local  工程直出（单选项，这一次**没有调 Jev**）—— 与详情头部的 .fd-tag.local 同一口径
   *   jev    真调了 Jev
   * 抽出来是因为它有两个容器（树上的 .tn 与行动卡的 .acard）都要用，
   * 而两处各自写一遍正是徽标漂开的起点。 */
  function actionKindCls(a) {
    return a.kind === 'llm' ? 'llm' : (a.local ? 'local' : 'jev');
  }
  function actionKindLabel(a) {
    return a.kind === 'llm' ? 'LLM' : (a.local ? '工程' : 'JEV');
  }

  function actionBrief(a) {
    if (a.error) return '失败';
    if (a.kind === 'main') return a.response ? '已响应' : '请求中…';
    if (a.kind === 'llm') return a.text ? '生成 ' + shortStr(a.text, 12) : '…';
    if (a.kind === 'recall') {
      const bs = a.batches || [];
      if (!bs.some((b) => b.response || b.error)) return '请求中…';
      const got = bs.reduce((n, b) => n + (b.recalled || []).length, 0);
      const failed = bs.filter((b) => b.error).length;
      return '召回 ' + got + ' 个（合并 ' + ((a.merged && a.merged.merged) || 0) + '）'
        + (failed ? ' · ' + failed + ' 批失败' : '');
    }
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
      const localNames = Object.keys(st.localQuestions || {});
      let html = '';
      if (hasTrimNote(st) && (a.payload.questions['参数'] || localNames.indexOf('参数') >= 0)) {
        html += '<div class="trim-note">' + escapeHtml(trimSummary(st)) + '</div>';
      }
      /* 右侧一屏多块：输入/输出/原始报文各自成块带块头（.sec 面板），不再糊成一片 */
      if (st.decision && st.response && !st.jevError) {
        html += '<div class="sec"><div class="sec-head">本轮输出 · 决策与概率分布</div>' + decisionDetailsHtml(st) + '</div>';
      }
      if (a.error) html += '<div class="step-err">' + escapeHtml(a.error) + '</div>';
      html += stateSectionHtml(a.payload.state, a);
      html += questionsSectionHtml(displayQuestions(a.payload, st.localQuestions), st, { localNames: localNames });
      /* 超限页首轮不带「参数」：候选明细属于「并行召回」那个动作，不在这一格重复展示 */
      if (a.payload.questions && a.payload.questions['参数']) html += trimDetailHtml(st);
      html += '<div class="sec"><div class="sec-head">原始报文</div>'
        /* 被工程直出的题不在这个请求体里（它们没发出去）：说清楚是哪几道，
         * 否则读记录的人会以为「参数」是漏写的 */
        + rawBlock('① 发送的请求体（与真实请求同一对象）'
          + (localNames.length ? '（不含 ' + localNames.join(' / ') + '：单选项，由工程直出，未发出）' : ''), relaxedStringify(a.payload))
        + (a.response
          ? rawBlock('② Jev 响应', JSON.stringify({ model: a.response.model, answers: a.response.answers, usage: a.response.usage, _latency_ms: a.response._latency_ms }, null, 2))
          : rawBlock('② Jev 响应', '（调用失败，无响应）'))
        + '</div>';
      return html;
    }
    /* 并行召回的某一批：与补问卡同构（问题块 / 作答概率 / 原始报文），
     * 但结论行是本批召回了哪些元素 —— 它不是决策，只是候选来源 */
    if (a.kind === 'recall') return recallViewHtml(st, a, 'rc:' + st.n + ':' + view.i);
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
  /* 补问的记录种类 → 它回传的题名（每类补问各只回一题；pick = 并行召回的最终决策） */
  const FOLLOWUP_Q = { param: '参数', action: '动作', text: '文本', pick: '参数' };
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
   * 补问单题响应里的 probabilities 此前只躺在裸 JSON 里没人解析。
   * stale=true：这张卡的概率分布**没有被采纳**（答案被归一剥掉 / 被后续行动改写），
   * 视觉上压暗并标注原因，避免把「模型当时这么说」误读成「本步就是这么决策的」。
   * local=true（答案自带）：候选只有一个、由工程直接给出，**不是模型输出** —— 必须标出来，
   * 否则那条 100% 的概率条看起来就像模型以极高把握做了判断（100% 的单点分布是最容易被
   * 误读的形状）。它也没有 confidence：那个字段的语义是「模型给的分布形状」，工程不伪造。 */
  function choiceCardHtml(name, ans, chosenLabel, note, stale) {
    const x = ans || {};
    const isLocal = Boolean(x.local);
    const chosen = chosenLabel != null ? chosenLabel : (x.choice != null ? String(x.choice) : '—');
    return '<div class="qcard' + (stale ? ' stale' : '') + (isLocal ? ' local' : '') + '">' +
      '<div class="qcard-head"><span class="qcard-name">' + name + '</span>' +
      (isLocal ? '<span class="qcard-local" title="该项只有一个候选，答案已确定：由工程直接给出，没有发给 Jev">工程直出</span>' : '') +
      '<span class="qcard-chosen">' + escapeHtml(chosen) + '</span>' +
      (typeof x.confidence === 'number' ? '<span class="qcard-conf">置信度 ' + pct(x.confidence) + '</span>' : '') + '</div>' +
      (x.probabilities ? barsHtml(x.probabilities, x.choice, Q_COLOR[name]) : '<div class="muted" style="font-size:12px">无概率数据</div>') +
      (isLocal ? '<div class="muted" style="font-size:12px">单选项，由工程直接给出，未经模型判断</div>' : '') +
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
     * 概率条去解释第二批复问的答案，改成指向那次补问行动。
     * **只认「参数批次补问」（kind='param'）**：并行召回的最终决策（kind='pick'）也带
     * param 且与本步 d.param 同值，只按 param 匹配会先命中它 —— 本行的参数会被说成
     * 「第 undefined 批补问确定」（pick 记录没有 batch）、指向一个本步并不存在的
     * 「参数补问」行动，还抢掉下面那个 pick 分支。老记录（无 kind）按 auto-core 的
     * 同一口径默认成 'param'，串行召回 / 旧的补问路径不受影响。 */
    const followUpRec = (step.followUps || []).find(
      (r) => (r.kind || 'param') === 'param' && r.param && r.param === d.param);
    /* 并行召回的最终决策（kind='pick'）：本轮的「参数」分布与本步的元素毫不相干。
     * 召回一条都没命中时会退回相关性裁剪候选（merged.fallback）—— 那种情况不能
     * 说成「并行召回合并候选」，否则又是「面板与实际不符」 */
    const pickRec = (step.followUps || []).find((r) => r.kind === 'pick' && r.param);
    const pickFallback = Boolean(step.recall && step.recall.merged && step.recall.merged.fallback);
    /* 本轮到底有没有拿到「参数」答案：弹窗步与老记录（超限页首轮只问 2 题）都没有。
     * 被工程直出的单选项也算 —— 它只是没走网络，答案照样是本轮给的（payload 里没有它，
     * 所以不能只看 payload.questions，否则这一格会把「工程直出」说成「本轮没有这题」） */
    const askedParam = Boolean(
      (step.payload && step.payload.questions && step.payload.questions['参数'])
      || (a['参数'] && a['参数'].local));
    /* 动作被「动作补问」改过（checkActionRole 拦下后重问）：本轮分布说的是旧动作 */
    const actionRec = (step.followUps || []).filter((r) => r.kind === 'action' && r.action).slice(-1)[0];
    const rawParam = (a['参数'] && a['参数'].choice != null) ? String(a['参数'].choice) : null;

    /* 这一格显示的分布**有没有被采纳**，必须写在卡片上。
     * 面板此前只渲染原始作答的概率条，于是「动作=放弃 / 参数=其他」这类被 ⑤b 归一剥掉、
     * 或被判无效的答案照样以高概率躺在分布里，看起来像真的那么决策了（实测用户报的就是这个）。
     * 采纳情况只有三种：被本轮决策采用 / 被后续行动改写 / 未被采用（附原因）。 */
    const paramNote = followUpRec
      ? '本行选项由第 ' + followUpRec.batch + ' 批补问确定，该题概率见「参数补问」行动'
      : pickRec
        ? '本行答案由「参数决策」行动定下（' + (pickFallback ? '召回无结果，用的是退回的相关性裁剪候选' : '并行召回合并候选') + '），该题概率见该行动'
        : rawParam == null
          ? (askedParam ? '本轮「参数」题没有作答：模型没给出元素'
            : '本轮没有「参数」题（弹窗步 / 老记录形态），元素由并行召回解决')
          : !d.param
            ? '原始作答未被采用' + (step.trimNote ? '：' + step.trimNote
              : (step.exec && step.exec.error ? '：' + step.exec.error : ''))
            : (d.param !== rawParam ? '本轮原始作答是 ' + rawParam + '，已被后续补问改为 ' + d.param : '');
    const actionNote = actionRec
      ? '本轮原始作答是「' + actionRec.from + '」，已由动作补问改为「' + actionRec.action + '」，该题概率见「动作补问」行动'
      : '';

    const chosenLabel = {
      动作: d.action || '—',
      参数: d.param ? refChipLabel(d.param, refLabels) + (followUpRec ? '（第 ' + followUpRec.batch + ' 批补问）' : '') : '—',
    };
    let html = '<div class="qgrid">';
    ['动作', '参数'].forEach((name) => {
      html += choiceCardHtml(name, a[name], chosenLabel[name], name === '参数' ? paramNote : actionNote,
        Boolean(name === '参数' ? (rawParam != null && !d.param && !followUpRec && !pickRec) : actionNote));
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
  function snapshotDetailsHtml(snap, step) {
    const text = String(snap || '');
    const lines = text ? text.split('\n').length : 0;
    const refs = Object.keys(AutoCore.refCriteria(text)).length;
    /* 来源写进 summary：'action' = 上一步动作顺带带回（这一步省掉一次快照调用），
     * 'fresh' = 这一步真取了一次。措辞按「省了什么」说，不按实现说。
     * 老记录没有这个字段（null）→ 不写假话，只留空白。 */
    const from = step && step.snapshotFrom === 'action' ? ' · 来自上一步动作'
      : step && step.snapshotFrom === 'fresh' ? ' · 本步新取' : '';
    return '<details class="snap-details" data-dk="snap"><summary>accessibility 快照 · ' + lines + ' 行 · ' + refs + ' 个元素' + from + '（点开查看）</summary>' +
      '<pre class="step-pre tall">' + escapeHtml(text) + '</pre></details>';
  }

  function stateSectionHtml(state, step) {
    const page = state['当前页面'] || {};
    const hist = Array.isArray(state['已完成步骤']) ? state['已完成步骤'] : [];
    const lastResult = String(state['上一步结果'] || '');
    const lastCls = /^成功/.test(lastResult) ? ' ok-text' : /^失败/.test(lastResult) ? ' bad-text' : '';
    return '<div class="sec"><div class="sec-head">本轮输入 · state</div><div class="kv-list">' +
      '<div class="kv"><div class="kv-k">任务目标</div><div class="kv-v"><span class="goal-text">' + escapeHtml(state['任务目标'] || '') + '</span></div></div>' +
      '<div class="kv"><div class="kv-k">当前页面</div><div class="kv-v"><span class="mono-chip">' + escapeHtml(page.url || '') + '</span>' +
      (page['标题'] ? '<span class="page-title">' + escapeHtml(page['标题']) + '</span>' : '') + '</div></div>' +
      '<div class="kv"><div class="kv-k">上一步结果</div><div class="kv-v' + lastCls + '">' + escapeHtml(lastResult) + '</div></div>' +
      /* 本步变化：只在真有变化时才有（与停滞提示同一条原则）。.kv-v 是 flex，\n 会塌掉，
       * 必须换成 <br> 才看得见多行。 */
      (state['本步变化']
        ? '<div class="kv"><div class="kv-k">本步变化</div><div class="kv-v change-text">'
          + escapeHtml(state['本步变化']).replace(/\n/g, '<br>') + '</div></div>'
        : '') +
      /* 停滞提示只在检出重复 / 快照未变时才有 —— 常驻一行空占位反而让人以为它一直在报警 */
      (state['停滞提示']
        ? '<div class="kv"><div class="kv-k">停滞提示</div><div class="kv-v stall-text">' + escapeHtml(state['停滞提示']) + '</div></div>'
        : '') +
      '<div class="kv"><div class="kv-k">已完成步骤</div><div class="kv-v">' +
      (hist.length ? '<ol class="hist-list">' + hist.map((h) => '<li>' + escapeHtml(h) + '</li>').join('') + '</ol>' : '<span class="muted">（第一步，暂无）</span>') +
      '</div></div>' +
      '<div class="kv"><div class="kv-k">页面快照</div><div class="kv-v">' + snapshotDetailsHtml(state['页面快照'], step) + '</div></div>' +
      '</div></div>';
  }

  function criteriaAreaHtml(name, q, step) {
    const crit = q.criteria;
    if (name === '动作') {
      const terminal = AutoCore.TERMINAL_TOOLS || {};
      const chips = Object.keys(crit).map((k) => {
        let tone = '';
        if (terminal[k]) tone = k === '任务已完成' ? ' good' : ' warn';
        else if (k === '生成输入') tone = ' violet';
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
  /* 展示用的题目集合 = 真发出去的 + 被工程直出的。
   * 「展示的就是发出的」这条原则说的是**不许假装发过**（所以 a.payload 只装真发的那份），
   * 不是把没发的题藏起来 —— 藏起来反而读不懂那个答案是从哪几个候选里来的。
   * 题名重复时以发出的那份为准（同名的题不可能一半发一半不发）。 */
  function displayQuestions(payload, localQuestions) {
    const qs = Object.assign({}, localQuestions || {}, (payload && payload.questions) || {});
    if (!Object.keys(qs).length) return payload;
    return Object.assign({}, payload || {}, { questions: qs });
  }

  /* opt.localNames：被工程直出的题名（这些题**没发出去**）。
   * 全部题都在里面 = 这一块整份请求都没发，标题要标注；只一部分 = 只在该题的块头标，
   * 因为同一块里其余题是真问过 Jev 的。 */
  function questionsSectionHtml(payload, step, opt) {
    const qs = (payload && payload.questions) || {};
    const localNames = (opt && opt.localNames) || [];
    const ORDER = ['动作', '参数', '文本', '未完成'];   // 首轮 3 道（文本已移入补问）；弹窗步只有「动作」1 道
    const meta = {
      动作: Object.keys(qs['动作'] && qs['动作'].criteria || {}).length + ' 个候选',
      参数: Object.keys(qs['参数'] && qs['参数'].criteria || {}).length + ' 个候选 ref',
      文本: Object.keys(qs['文本'] && qs['文本'].criteria || {}).length + ' 个候选',
      未完成: ((qs['未完成'] && qs['未完成'].criteria || []).length || AutoCore.SCORE_LEVELS) + ' 级分值',
    };
    const present = ORDER.filter((name) => qs[name]);
    const allLocal = present.length > 0 && present.every((n) => localNames.indexOf(n) >= 0);
    let html = '<div class="sec"><div class="sec-head">本轮输入 · ' + present.length + ' 道问题'
      + (allLocal ? '（单选项 · 工程直出 · 未调用 Jev）' : '') + '</div><div class="qlist">';
    present.forEach((name) => {
      const q = qs[name];
      html += '<div class="qblock">' +
        '<div class="qblock-head"><span class="qblock-name">' + name + '</span>' +
        (localNames.indexOf(name) >= 0
          ? '<span class="qblock-local" title="该项只有一个候选，答案已确定：由工程直接给出，这道题没有发给 Jev">工程直出</span>'
          : '') +
        '<span class="type-badge">' + escapeHtml(q.type || '') + '</span>' +
        '<span class="qblock-meta">' + escapeHtml(meta[name] || '') + '</span></div>' +
        (q.instructions ? '<div class="qblock-inst" title="' + escapeHtml(q.instructions) + '">' + escapeHtml(q.instructions) + '</div>' : '') +
        criteriaAreaHtml(name, q, step) +
        '</div>';
    });
    html += '</div></div>';
    return html;
  }

  /* 参数题候选的摘要：让人一眼看出「本来多少个、给了 Jev 多少个、为什么」。
   * 两条算法路线各说各的：并行召回讲「几批 → 合并多少」，相关性裁剪讲「折叠/兜底」。 */
  /* 候选摘要：**按传进来的那份 meta 说**（默认 step.trim = 本步主调用那份候选）。
   * 首轮卡说的是首轮那批（前 size 个），并行召回卡说的是合并后的候选 —— 两者不能互相冒充：
   * 曾经 resolveRecall 把合并 meta 写回 step.trim，于是首轮卡一边列出 200 个候选、
   * 一边写「候选 45 个 / 全页 469 个」，还重复渲染了一遍召回明细（面板与实际不符的老毛病）。 */
  function trimSummary(step, meta) {
    const m = meta || step.trim;
    if (!m) return '';
    if (m.algorithm === 'parallel' && m.first) {
      /* 首轮那一次：候选只有本页前 size 个，其余交给第二轮的并行召回。
       * 这一步到底有没有发起召回，卡上要说实话（动作不需要元素时一个请求都没发） */
      const rest = Math.max(0, (m.totalRefs || 0) - (m.firstSize || 0));
      const ran = Boolean(step && step.recall && (step.recall.batches || []).length);
      return '并行召回：首轮候选 = 本页前 ' + m.firstSize + ' 个元素（全页 ' + m.totalRefs + ' 个）'
        + '→ 其余 ' + rest + ' 个' + (ran ? '已由「并行召回」行动核对（见该行动）' : '未发起并行召回');
    }
    if (m.algorithm === 'parallel') {
      /* 合并后那一份。两个入口：① 老记录 —— 早先的构建把合并 meta 写进了 step.trim，
       * 那些会话的「首轮」卡读到的就是它（新记录不再这样，见 resolveRecall）； */
      const per = m.perBatch || [];
      const empty = per.filter((p) => !(p.recalled || []).length).length;
      let s = '并行召回：' + m.batches + ' 批 × 每批前 ' + m.topN + '（每批 ' + m.size + ' 个）→ 候选 '
        + m.merged + ' 个 / 全页 ' + m.totalRefs + ' 个';
      if (m.seeded && m.seeded.length) s += '（含首轮前 ' + m.seeded.length + ' 个）';
      if (m.clamped) s += '，超 250 截断 ' + m.clamped + ' 个';
      if (empty) s += '，' + empty + ' 批无召回';
      return s;
    }
    if (!m.trimmed) return '';
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

  /* 「参数」题候选有没有需要摘要/明细可讲（两条路线任一命中） */
  function hasTrimNote(step) {
    const m = step && step.trim;
    return Boolean(m && (m.trimmed || m.algorithm === 'parallel'));
  }

  function trimDetailHtml(step) {
    const m = step.trim;
    if (!m) return '';
    /* 首轮那份：候选清单就在「本轮输入」的问题块里（chips 全列出），这里不再重复一张表；
     * 逐批召回明细属于「并行召回」行动卡（recallViewHtml） */
    if (m.algorithm === 'parallel') return '';
    if (!m.trimmed) return '';
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
    /* 整份请求没发出去（候选只有一个，工程直出）：payload 是 null（记录里不许有假请求），
     * 题目从 localQuestions 取 —— 那一题的候选与 instructions 仍要看得到 */
    const local = Boolean(a.local);
    const localNames = Object.keys(a.localQuestions || {});

    let html = '<div class="fu-hit' + (a.error ? ' bad' : (settled ? '' : ' pend')) + '">' + escapeHtml(hit) + '</div>';
    /* 不重复 state：补问发的是与本步首轮同一份 state */
    html += questionsSectionHtml(displayQuestions(a.payload, a.localQuestions), st, { localNames: localNames });
    if (ans) {
      html += '<div class="sec"><div class="sec-head">本轮输出 · 作答与概率分布</div><div class="qgrid">'
        + choiceCardHtml(qname, ans, a.kind === 'param' && a.param ? refChipLabel(a.param, st.refLabels)
          : (a.kind === 'text' && a.text ? varLabelOf(a.text) : null), '')
        + '</div></div>';
    }
    if (a.error) html += '<div class="step-err">' + escapeHtml(a.error) + '</div>';
    html += '<div class="sec"><div class="sec-head">原始报文</div>' +
      '<details class="req-details" data-dk="' + dk + '"' + (settled ? '' : ' open') + '>' +
      '<summary>' + (local ? '未调用 Jev（单选项 · 工程直出）· 合成答案'
        : '① 发送的请求体（仅「' + escapeHtml(qname) + '」一题）· ② Jev 响应') + '</summary>' +
      '<div class="req-inner">' +
      rawBlock(local ? '① 未发出（候选只有一个，答案已确定）' : '① 发送的请求体',
        relaxedStringify(a.payload || null)) +
      rawBlock('② ' + (local ? '合成答案（工程给出，非模型输出）' : 'Jev 响应'),
        a.response ? JSON.stringify(a.response, null, 2) : '（调用失败，无响应）') +
      '</div></details></div>';
    return html;
  }

  /* 召回批次视图：结论行（本批召回 N 个）+ 问题块 + 作答与概率分布 + 原始报文。
   * 概率条的说明写给看的人：本批内归一的概率只用于召回排序，不是最终答案 ——
   * 最终决策在合并候选那次调用里做（行动列表里紧跟着的「Jev 首轮」）。 */
  /* 并行召回视图：**一个**动作里装 K 批。
   * 结论行说清「几批、召回多少、合并多少、失败几批」，下面是每批的可折叠明细
   * （候选 / 概率分布 / 召回清单 / 该批原始报文），最后是合并后的候选清单。
   * 每批的请求体都是真发出去的那一份 —— 折叠只是排版，不是省略。 */
  function recallViewHtml(st, a, dk) {
    const bs = a.batches || [];
    const meta = a.meta || {};
    const merged = a.merged || {};
    const topN = meta.topN != null ? meta.topN : '';
    const got = bs.reduce((n, b) => n + (b.recalled || []).length, 0);
    const failed = bs.filter((b) => b.error).length;
    const pend = !bs.some((b) => b.response || b.error);
    /* 召回清单是同一份投影（ref 编号 + 快照里的标签），每批明细与合并结果两处共用 */
    const refRows = (refs) => '<div class="ref-scroll">' + refs.map((r) =>
      '<div class="ref-row"><span class="ref-id">' + escapeHtml(r) + '</span>' +
      '<span class="ref-label">' + escapeHtml(AutoCore.stripRefPrefix((st.refLabels || {})[r] || '')) + '</span></div>').join('') + '</div>';
    const hit = pend ? '请求中…'
      : '并行召回 ' + bs.length + ' 批（每批 ' + (meta.size || '?') + ' 个）→ 召回 ' + got
        + ' 个 → 合并候选 ' + (merged.merged != null ? merged.merged : '?') + ' 个 / 全页 ' + (meta.totalRefs != null ? meta.totalRefs : '?')
        + (merged.seeded && merged.seeded.length ? '（含首轮前 ' + merged.seeded.length + ' 个）' : '')
        + (failed ? '；' + failed + ' 批失败' : '')
        + (merged.clamped ? '；超 250 截断 ' + merged.clamped + ' 个' : '');
    let html = '<div class="fu-hit' + (failed ? ' bad' : (pend ? ' pend' : '')) + '">' + escapeHtml(hit) + '</div>';
    /* 异常/兜底必须写在卡上：召回全空、退回裁剪候选这类事不能只留在落盘记录里。
     * 结论行（上面那行）已经把「几批 / 召回多少 / 合并多少 / 含首轮前 N 个 / 失败几批 / 截断」
     * 说全了，这里不再叠一行摘要 —— 同一件事印两遍，两处措辞迟早会漂开 */
    if (a.note) html += '<div class="step-err">' + escapeHtml(a.note) + '</div>';

    html += '<div class="sec"><div class="sec-head">召回明细 · ' + bs.length + ' 批（每批前 ' + topN + ' 个进最终候选）</div>';
    bs.forEach((b) => {
      const ans = (b.response && b.response.answers && b.response.answers['参数']) || null;
      const local = Boolean(b.local);
      const one = b.error ? '失败：' + b.error
        : !b.response ? '请求中…'
          : local ? '单选项 · 工程直出（未调用 Jev）'
            : (b.recalled || []).length ? '召回 ' + b.recalled.length + ' 个' : '本批无召回';
      html += '<details class="step-collapse"' + (b.error || local ? ' open' : '') + '>' +
        '<summary>第 ' + b.batch + '/' + bs.length + ' 批 · ' + b.size + ' 个候选 · ' + escapeHtml(one)
        + (b.ms != null ? ' · ' + AutoCore.formatMs(b.ms) : '') + '</summary>' +
        '<div class="req-inner">';
      if (ans) {
        /* 单候选批的概率分布不是模型给的：`本批内归一` 那句是给真作答写的，换掉 */
        html += choiceCardHtml('参数', ans, null, local
          ? '本批只有 1 个候选，答案已确定 —— 由工程直接给出，未经模型判断'
          : '本批内归一，只用于召回排序（按概率取前 ' + topN + ' 个）');
        if ((b.recalled || []).length) html += refRows(b.recalled);
      } else if (b.error) {
        html += '<div class="step-err">' + escapeHtml(b.error) + '</div>';
      }
      html += rawBlock(local ? '① 未发出（单选项 · 工程直出）' : '① 发送的请求体（仅「参数」一题）',
        relaxedStringify(b.payload || null))
        + rawBlock('② ' + (local ? '合成答案（工程给出，非模型输出）' : 'Jev 响应'),
          b.response ? JSON.stringify(b.response, null, 2) : '（调用失败，无响应）')
        + '</div></details>';
    });
    html += '</div>';

    /* 合并结果：最终决策这一题的候选就是它。首轮前 N 个排在最前面（它们所在的那一段不在召回范围） */
    const keys = (a.mergedKeys || []).length ? a.mergedKeys : null;
    html += '<div class="sec"><div class="sec-head">' + (merged.fallback
      ? '并行召回无结果 · 退回相关性裁剪的候选（送给「参数决策」那一次）'
      : '合并后的候选 · 首轮前 ' + ((merged.seeded || []).length) + ' 个 + ' + bs.length + ' 批召回（送给「参数决策」那一次）') + '</div>' +
      '<div class="trim-note">' + (merged.fallback
        ? '召回一条都没命中，本步改用相关性裁剪的候选：' + (merged.merged != null ? merged.merged : '?') + ' 个'
        : '合并去重 ' + (merged.recalled != null ? merged.recalled : got) + ' → 候选 '
          + (merged.merged != null ? merged.merged : '?') + ' 个') + '，已全部列出、无「其他」兜底</div>' +
      (keys ? refRows(keys) : '') +
      '</div>';
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
  /* 确认条构造：单步确认与「开跑先暂停」两道门共用这一条 —— 宿主、样式、滚动，
   * 以及「点了就把条子收掉再 resolve」这套生命周期都只有这一份，按钮表由调用方给。
   * 早先这两行是写在 awaitConfirm 里的，第二道门要来了才抽出来：两处各建一条 bar，
   * 按钮布局与收尾时机必然会各自漂移。 */
  function buildConfirmBar(host, specs, resolve) {
    const bar = el('div', 'confirm-bar');
    specs.forEach((s) => {
      const b = el('button', s.cls, s.label);
      b.type = 'button';
      b.onclick = () => { bar.remove(); resolve(s.val); };
      bar.appendChild(b);
    });
    host.appendChild(bar);
    bar.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return bar;
  }

  function awaitConfirm(step) {
    return new Promise((resolve) => {
      if (view.sess !== 'current' || view.type !== 'step' || view.n !== step.n) select('step', step.n, null, false);
      const host = document.getElementById('fdConfirm');
      if (!host) return resolve('run');   /* 视图异常时保守执行 */
      buildConfirmBar(host, [
        { label: '▶ 执行本步', cls: 'btn-ghost', val: 'run' },
        { label: '⏭ 跳过', cls: 'btn-ghost', val: 'skip' },
        { label: '■ 中止循环', cls: 'btn-ghost danger', val: 'abort' },
      ], resolve);
    });
  }

  /* ---------- 开跑后先暂停（人工登录 / 接管）----------
   * 门开在 runLoop 里、浏览器打开之后、**第 1 步快照之前** —— 这就是这道门存在的全部理由：
   * 让「人工操作之后」的页面成为模型的第一次输入。
   * 为什么不能靠既有的单步确认：那边暂停在 ⑦，此时快照早已拍完、模型也已决策完，
   * 人工在那里登录，第 1 步的依据是登录**前**的页面 —— 依据过期，执行下去大概率是错的。
   *
   * 出口有三条，缺一条就会让人卡住（或以为卡住）：
   *   ① 条上的「■ 中止」；
   *   ② 顶部那个一直可见的「■ 中止」——门开着时 for 循环没在跑，没有东西在读 abortFlag，
   *      必须由 gateRelease 放行（见 bindEvents），否则点了毫无反应；
   *   ③ 刷新页面（门随内存态一起消失，浏览器仍开着，交给「关闭浏览器」收拾）。 */
  let gateRelease = null;   /* 门开着时存下自己的收尾函数，供顶部中止按钮放行 */

  function awaitManualGate() {
    return new Promise((resolve) => {
      const host = document.getElementById('fdConfirm');
      /* 宿主不在（视图异常）时**停下来**，与单步确认的处置正好相反：那边放行是「保守执行」，
       * 这边放行等于「跳过人工」—— 这门是安全阀，静默放过去就等于人工没机会登录。 */
      if (!host) return resolve('abort');
      const leave = (val) => {
        const bar = host.querySelector('.confirm-bar');
        if (bar) bar.remove();                    /* 顶部中止那条路没有 onClick 可以自删 */
        if (gateEnteredAt != null) { gateAccumMs += Date.now() - gateEnteredAt; gateEnteredAt = null; }
        gateRelease = null;
        els.runPill.className = 'status-pill busy';
        els.runPill.textContent = '运行中';
        resolve(val);
      };
      gateRelease = leave;
      gateEnteredAt = Date.now();
      /* 只动文案、**不动 data-state**：它是展示层与 E2E 的公共契约，语义是
       * 「非 running = 本轮已结束」。暂停不是结束 —— 改了它，所有轮询终止态的测试
       * 都会把暂停误读成结束（waitEnd 会立刻返回并断言一个还没发生的终态）。 */
      els.runPill.className = 'status-pill warn';
      els.runPill.textContent = '已暂停';
      buildConfirmBar(host, [
        { label: '▶ 已完成，继续', cls: 'btn-ghost', val: 'run' },
        /* 与顶部「■ 中止」文案**故意**一样：两者干的是同一件事（中止本轮）。
         * 写成两个名字反而会让人怀疑它们有区别。 */
        { label: '■ 中止', cls: 'btn-ghost danger', val: 'abort' },
      ], leave);
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

  /* ---------- Jev 调用（失败重试一次） ----------
   * 计时包在**最外层**（spec 2026-09-28 §4）：用户等的是含重试与重试前 600ms sleep 的
   * 这段墙钟，不是成功那一次的净耗时 —— 否则一次失败的调用在界面上是 0ms，
   * 正好把最该看见的慢藏了起来。 */
  async function callJev(payload) {
    const t0 = Date.now();
    const r = await callJevRaw(payload);
    r.ms = Date.now() - t0;
    return r;
  }

  async function callJevRaw(payload) {
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

  /* ---------- 单选项题：工程直出，不走 Jev ----------
   * 候选只剩一个的 choice 题，答案已经确定（判定规则与理由见
   * auto-core.splitSingleChoice 的注释）。这里把它从**发出去的 payload 里剥掉**，
   * 合成一份与 Jev 作答同构的答案（带 local 标记）。
   *
   * 三个调用点（首轮 / 并行召回 K 批 / 四路补问）共用 prepareAsk：
   * 调用方负责把 payload 先挂到记录上（飞行中要看得见发的是哪份题），再 await send()。
   *   payload        实际发出的请求体；null = 整份请求都没发（补问只剩一道单选项时会这样）
   *   local          true = 整份请求都没发
   *   localQuestions 被工程直出的**题目**（题名 → 原题，带 criteria / instructions）——
   *                  面板的问题块要靠它列候选，`split.local` 是答案、没有这些字段，别混用
   * send() 返回 {ok, data, ms, error}：整请求没发时 ms 为 **null**（不是 0 ——
   * 0 是「测到了，就是 0ms」，与「根本没发」必须能分辨，落盘与耗时对账都按这条）。 */
  function localOnlyResponse(localAnswers) {
    /* 整份请求都没发：这里没有模型参与，所以**不伪造 model 字段** —— 假的模型名
     * 会让人以为真问过一次 */
    return { local: true, answers: localAnswers };
  }

  /* Jev 调用 + 把本地合成答案并回 answers（每题自带 local: true，展示层据此标来源） */
  async function callJevWithLocal(payload, localAnswers) {
    const r = await callJev(payload);
    if (!r.ok) return r;
    return {
      ok: true, ms: r.ms,
      data: Object.assign({}, r.data, {
        answers: Object.assign({}, r.data.answers, localAnswers),
      }),
    };
  }

  function prepareAsk(state, questions) {
    const split = AutoCore.splitSingleChoice(questions);
    const asked = Object.keys(split.ask).length > 0;
    /* 展示的就是发出的：questions 存**剥后**那份，被剥掉的题挂在 localQuestions 上 */
    const payload = asked ? { state: state, model: Config.current.model, questions: split.ask } : null;
    return {
      payload: payload,
      local: !asked,
      /* 给展示层的是**题目**（criteria / instructions），不是合成答案 —— 答案在 response.answers 里 */
      localQuestions: Object.keys(split.stripped).length ? split.stripped : null,
      send: function () {
        return asked ? callJevWithLocal(payload, split.local)
          : Promise.resolve({ ok: true, ms: null, data: localOnlyResponse(split.local) });
      },
    };
  }

  /* ---------- 追问的公共骨架 ----------
   * 三处补问（参数批次 / 动作冲突 / 文本）走的是同一套流程：建请求 → 记一条 followUps
   * → 发 → 校验答案落在候选里 → 交给各自的 apply 落定。此前三处各写一遍这 12 行，
   * 连「Jev 返回了不在候选里的…」都在各自漂移；现在只有这一份。
   * opt = { qname 题名（同时是 rec 上要校验的那道题）, noun 报错里的名词（缺省同 qname）,
   *         parse 从 answers 取答案, apply 落定并返回是否成功 }
   * 单选项题（补问恒为单题，所以就是「该题只有一个候选」）在 prepareAsk 里被剥掉，
   * 整份请求都不发 —— 这条路上的 rec 会带 local: true 与 localQuestions。 */
  function parseErrText(e) { return (e && e.message) || String(e); }

  async function askFollowUp(step, rec, questions, opt) {
    const prep = prepareAsk(step.payload.state, questions);
    rec.payload = prep.payload;
    rec.local = prep.local;
    rec.localQuestions = prep.localQuestions;
    step.followUps.push(rec);
    touch();

    const jev = await prep.send();
    rec.ms = jev.ms;
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

  /* ---------- 第二轮 · 并行召回（K 批） + 最终「参数」决策 ----------
   * 触发条件由调用方把关：页面元素超过一批 **且** 首轮动作需要元素。
   * 三件事按顺序做完，才回到主循环：
   *   ① K 批并行问「参数」（每批只看自己那批元素，按概率排出最相关的若干个）
   *   ② 合并各批召回（去重、按概率排序、上限 250）
   *   ③ 用合并后的候选再问一次「参数」——这一次的答案才是本步真正要操作的元素
   * 行动列表里 ①② 是**一个**动作（K 批是它的内部明细），③ 单列一个「参数决策」动作。
   * 全部批次都失败时退回相关性裁剪的候选集，宁可少一次召回也别把整步判死。 */
  async function resolveRecall(step, plan, state) {
    /* 首轮那次「参数」作答：它所在的那一段不在召回范围内，只能由首轮自己的预测代表。
     * 带**前 topN 个**进去（不是只带作答的那一个）——最终候选 = 首轮前 N + K 批召回合并，
     * 这样最终决策才有可比较的对手；作答的那个 ref 由 pickFromAnswer 保证恒在。 */
    const seeds = AutoCore.recallSeeds({ plan: plan, answer: step.response });
    if (!seeds.length && AutoCore.isRefParam(step.decision.param, step.refLabels)) {
      /* 首轮没给概率分布（旧协议）/ 作答落在批外：至少把作答的那一个带上，不带空手入场 */
      seeds.push(step.decision.param);
    }
    const rec = {
      meta: plan.meta, batches: [], merged: null, failed: 0, note: null,
      afterMain: true,   /* 行动列表据此把它排在「首轮」之后（老记录没有这个标记） */
      seed: seeds,
    };
    step.recall = rec;

    /* 先把 K 份 payload 全部建好再并发发出去：每份都是「步骤卡里展示的那个对象」本身。
     * 单 ref 的批次在这里被剥成工程直出（整批不发）—— 该批的候选与合成答案照旧进
     * rec.batches，mergeRecall 对「真作答」与「合成作答」一视同仁。 */
    rec.batches = plan.batches.map((b) => ({
      batch: b.index, size: b.refs.length,
      payload: null, response: null, ms: null, error: null, recalled: [],
      local: false, localQuestions: null,
    }));
    touch();
    await Promise.all(plan.batches.map((b, i) => {
      const prep = prepareAsk(state, AutoCore.buildRecallQuestions(plan, i + 1));
      rec.batches[i].payload = prep.payload;
      rec.batches[i].local = prep.local;
      rec.batches[i].localQuestions = prep.localQuestions;
      return prep.send().then((r) => {
        rec.batches[i].ms = r.ms;
        if (r.ok) rec.batches[i].response = r.data;
        else rec.batches[i].error = r.error;
      });
    }));

    /* 直接喂整封响应（{model, answers:{参数:…}}）—— 剥壳在 ref-recall.answerOf 里做一次。
     * 曾经这里只认「作答」那一层而调用方给的是信封：每一批都召回 0 个，面板写「候选 1 个」
     * （会话 r-0928-1954-4dgf）。契约换成「两种形状都收」，这个坑不会再静默复现。 */
    const merged = AutoCore.mergeRecall(plan, rec.batches.map((b) => b.response), { seed: seeds });
    merged.meta.perBatch.forEach((p, i) => { rec.batches[i].recalled = p.recalled; });
    rec.merged = merged.meta;
    rec.failed = rec.batches.filter((b) => b.error).length;

    /* 一条候选都没召回 → 退回相关性裁剪的候选集（本步照常往下走，不判死） */
    let criteria = merged.criteria;
    let meta = merged.meta;
    if (!Object.keys(criteria).length) {
      const empty = rec.batches.filter((b) => b.response).length > 0;
      rec.note = empty
        ? '并行召回无结果：' + rec.batches.length + ' 批响应里没有可用的作答，本步退回相关性裁剪候选'
        : '并行召回无结果（批次全部失败），本步退回相关性裁剪候选';
      /* 兜底候选的构造在纯逻辑层（剔「其他」+ 按剔后份数报数），这里只接线 */
      const fb = AutoCore.recallFallback({
        snapshot: step.snapshot, goal: runCfg.goal,
        avoidRefs: Object.keys(failedRefs), paramTrim: runCfg.paramTrim,
        mergedMeta: merged.meta,
      });
      criteria = fb.criteria;
      meta = fb.meta;
      rec.merged = meta;
    }
    /* step.trim 保持指向**首轮那份**候选 meta：主卡（首轮）列的就是那一批候选，
     * 摘要与明细必须说同一件事。合并后的 meta 记在 rec.merged / rec.criteria 上，
     * 由「并行召回」卡的结论行自己说（几批 / 召回多少 / 合并多少 / 含首轮前 N 个）。 */
    rec.criteria = criteria;   /* 最终决策实际拿到的候选（行动视图与落盘都要看它） */

    /* 用户在 K 批飞行中按了中止：不再花这一次最终决策的钱（那是一次实打实的付费调用），
     * 让调用方紧接着的 abortFlag 检查把整轮记成「已中止」 */
    if (abortFlag) {
      rec.note = '用户中止，跳过最终「参数」决策';
      return false;
    }

    /* ③ 最终决策：单题「参数」，候选 = 首轮前 N + K 批召回的合并（meta 用实际生效的那一份） */
    const questions = AutoCore.buildRecallPickQuestions({
      criteria: criteria, meta: meta, action: step.decision.action,
    });
    const pickRec = {
      kind: 'pick', payload: null, response: null, error: null, param: null,
      ms: null, candidates: Object.keys(criteria).length, action: step.decision.action,
    };
    return askFollowUp(step, pickRec, questions, {
      qname: '参数', noun: '元素', parse: AutoCore.parseParamAnswer,
      apply: (param) => {
        /* 必须是本页真实 ref —— 「其他」这类兜底键即便混进候选也不是元素，
         * 放它过去就会拿「其他」当 ref 发命令（实测：连烧三步的 fill 报错） */
        if (!AutoCore.isRefParam(param, step.refLabels)) {
          pickRec.error = '最终决策返回的不是本页真实 ref：' + param;
          return false;
        }
        pickRec.param = param;
        step.decision = Object.assign({}, step.decision, { param: param });
        return true;
      },
    });
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

  /* 本步要操作的元素的 ref（用于标注）：终止动作没有目标，返回 null。
   * 「生成输入」的目标是 decision.param，其余动作走 planExecution，但这里只需要 ref，
   * 可以直接用 decision.param（与 planExecution 的 ref 同源）。
   * 判定必须走 isRefParam（refLabels = 当前快照解析出的全量 ref 表）：曾用
   * /^e[A-Za-z0-9_-]+$/ 猜形状，切到第 N 个标签页后 playwright 把 ref 前缀变成 fN
   * （e496 → f2e496），正则全部失配 → 这里静默返回 null，「被操作元素」的标注框
   * 从切标签页之后每一步都消失，且不报任何错。 */
  function assignRef(decision, refLabels) {
    if (!decision) return null;
    if (AutoCore.TERMINAL_TOOLS[decision.action]) return null;
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
      /* 生成输入那次 LLM 的耗时单列（不计入 Jev —— 那是生成模型，不是 Jev），
       * 失败分支也要记：不然这段等待在界面上凭空消失。 */
      const lt0 = Date.now();
      try {
        r = await callLlm({ model: llmCfg.model, messages: m.messages, temperature: m.temperature, max_tokens: m.max_tokens }, llmCfg);
      } catch (e) {
        L.ms = Date.now() - lt0;
        L.error = '生成模型调用失败：' + parseErrText(e);
        step.exec = { ok: false, error: L.error, elapsedMs: 0, cmd: null };
        return {};
      }
      L.ms = Date.now() - lt0;
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
      /* fill 走的是 CLI 的 fill（browser_type 的非 slowly 分支），上游**不给**动作后快照，
       * 所以这里会照实清成空：下一步真取一次（规则在 makeSnapshotCarrier 里）。 */
      snapshotCarrier.accept(act);
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
    /* 动作顺带带回的快照：交给下一步当页面依据（规则见 makeSnapshotCarrier）。
     * 只在动作真的成功、且带回的内容能用时才收 —— 失败步要保持「下一步真取一次」的原样，
     * 否则失败原因（如弹窗、被遮挡）会被上一份快照盖掉。 */
    snapshotCarrier.accept(act);
    return {};
  }

  /* ---------- 状态条 / 计时 ---------- */
  function setProgress(n) {
    els.progress.textContent = '第 ' + n + ' / ' + runCfg.maxSteps + ' 步';
    els.progress.title = '';   /* 清上一轮结束原因，免得悬停看到过期解释 */
  }
  /* 人工暂停的累计耗时：门开着的时候「用时」应当**冻结**，不能把人工登录的三分钟算进
   * 任务耗时里（那会把「这轮跑了多久」这个数毁掉）。tick 与 finishRun 两处都必须读
   * 这一个函数 —— 各写一份 `Date.now() - startTs` 是这类计时最容易长出来的第二处副本，
   * 一改就漏一处。held 让门开着时显示就停在进门那一刻，而不是等门关掉才跳回去。 */
  let gateAccumMs = 0;
  let gateEnteredAt = null;
  function elapsedMs() {
    const held = gateEnteredAt ? (Date.now() - gateEnteredAt) : 0;
    return Date.now() - startTs - gateAccumMs - held;
  }
  function startTimer() {
    startTs = Date.now();
    timerId = setInterval(() => {
      els.elapsed.textContent = Math.round(elapsedMs() / 1000) + 's';
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
    gateAccumMs = 0; gateEnteredAt = null; gateRelease = null;
    /* 耗时锚点同批复位：漏一个，第二轮就会继承上一轮的定格墙钟 / 残留准备时间 */
    loopStartTs = 0; prevStepEndTs = 0; prepMs = null; finalWallMs = null;
    Object.assign(view, { sess: 'current', type: 'session', n: 0, i: 0, follow: true });
    syncSessUrl();   /* 视图回到本页这一轮了，地址栏里那条历史会话 id 就该让位（见 syncSessUrl） */
    failedRefs = Object.create(null); refPageUrl = '';
    /* 上一轮动作留下的快照绝不能跨轮生效：这一轮的浏览器是刚 open 的（或刚 attach 的
     * 另一个标签页），拿旧页面的快照当第 1 步依据正是「依据过期」那类事故。 */
    snapshotCarrier.reset();
    const plan = windowPlan();
    runCfg = {
      goal, url, maxSteps, variables: collectVars(), screenshotOn: els.screenshot.checked,
      browser: els.browser.value, mode, cdp: cdpTarget, window: plan,
      /* 驱动后端（inproc / cli）：与内核、模式都正交，冻结在这一刻 */
      backend: els.backend.value,
      /* 冻结在开跑这一刻：跑起来之后再改弹窗里的勾选框不影响本轮（与其它运行参数同规矩） */
      pauseFirst: els.pauseFirst.checked,
      paramTrim: Config.paramTrim.get(),
      snapshotTrim: Config.snapshotTrim.get(),
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
      /* 门没走完就抛异常的话，条子会留在页面上 —— 一条点不动的僵尸条比没有更糟，
       * 它会让人以为还能点。这里兜底清掉，并把门的状态复位。 */
      const stale = document.querySelector('#fdConfirm .confirm-bar');
      if (stale) stale.remove();
      gateRelease = null;
      gateEnteredAt = null;
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
      /* 异常路径同样要结算本步耗时：抛出时正在跑的那一步没走过 settleStepMs
       * （正常 / 终止 / 跳过 / 中止 / Jev 失败这五条都走过了），那一步在树上会是空白、
       * 差额还会冒充成收尾。已结算的步 ms 非 null，跳过；在步创建之前就返回的路径
       * （中止 / 页丢失守卫）最后一步也早已结算，不会误加。 */
      const curStep = steps.length ? steps[steps.length - 1] : null;
      if (curStep && curStep.ms == null) settleStepMs(curStep);
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
    /* 新会话不再产生 giveup（「放弃」已从动作集下线）；留着只为读旧记录时文案不塌成「出错」 */
    giveup:  { label: 'Jev 放弃任务', tone: 'warn' },
    limit:   { label: '已达步数上限', tone: 'warn' },
    fails:   { label: '连续执行失败', tone: 'warn' },
    error:   { label: '出错',         tone: 'error' },
  };

  /* 结算本步耗时：从**上一步动作结束**起算（而不是本步开始）—— 步间间隔（STEP_GAP_MS，
   * 默认 0）落在上一步结束之后，只有这样归属，「准备 + Σ步耗时 + 收尾 = 墙钟」才成立。
   * 每一条离开本步的路径（正常 / 终止 / 跳过 / 中止 / Jev 失败）都要过这里：
   * 漏一条，那一步在树上就是空白，差额还会冒充成「收尾」。 */
  function settleStepMs(step) {
    const now = Date.now();
    if (step) step.ms = Math.max(0, now - prevStepEndTs);
    prevStepEndTs = now;
  }

  function finishRun(t) {
    if (finished) return;
    finished = true;
    finalWallMs = elapsedMs();   /* 与顶部秒数同源：结束这一刻定格，之后不再随实时钟增长 */
    stopTimer();                                  /* 停在最终值，与下面读的 elapsed 同源 */
    const s = END_STATES[t.state] || END_STATES.error;
    const secs = Math.round(elapsedMs() / 1000);
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
      { url: runCfg.url, browser: runCfg.browser, mode: runCfg.mode, cdp: runCfg.cdp, backend: runCfg.backend }, runCfg.window));
    if (!opened.ok) {
      finishRun({ done: false, state: 'error', reason: '打开浏览器失败：' + opened.error });
      return;
    }
    /* 实际用的是哪条后端：进程内起不来时 driver 会自动退回 playwright-cli 并带
     * backendFallback 说明。**必须说出来** —— 否则用户以为自己跑的是快的那条，
     * 看到整轮慢却找不到原因。落盘 meta 里也记（buildRunRecord）。 */
    runCfg.backendUsed = opened.backend || runCfg.backend;
    if (opened.backendFallback) toast('驱动后端已回退：' + opened.backendFallback);
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
    /* ★ 开跑后先暂停：门必须在第 1 步快照之前（勾选框在运行参数弹窗里，取 runCfg 的冻结值）。
     * 放在窗口校正之后，人工看到的就是最终窗口（全屏 / 指定尺寸都已生效），
     * 而不是先给一个小窗、点完继续再跳成全屏。
     * cdp 下勾选框是隐藏的，这里也一并跳过 —— 复用你已登录的浏览器，这道门没有意义。 */
    if (runCfg.pauseFirst && runCfg.mode !== 'cdp') {
      const gate = await awaitManualGate();
      if (gate === 'abort') {
        abortFlag = true;
        finishRun({ done: false, state: 'aborted', reason: '用户中止' });
        return;
      }
    }

    runCfg.browserUsed = opened.browser;
    runCfg.fullscreenUsed = opened.fullscreen === true;
    runBrowserOpen = true;   /* 浏览器确实开着了（cdp 直连的那个也算「有开着的」）*/
    updateCloseBtn();

    let lastResult = '';
    /* 准备耗时在此定下：扣掉人工门那一段（与 elapsedMs 同口径，见顶部锚点注释）。 */
    loopStartTs = Date.now();
    prevStepEndTs = loopStartTs;
    prepMs = startTs ? Math.max(0, loopStartTs - startTs - gateAccumMs) : null;
    for (let n = 1; n <= runCfg.maxSteps; n++) {
      if (abortFlag) { finishRun({ done: false, state: 'aborted', reason: '用户中止' }); return; }
      setProgress(n);

      /* ① 快照 —— 优先用上一步动作顺带带回的那份（见 snapshotCarrier）：动作之后、等稳定
       * 之后拍的，当这一步的页面依据；没有才真取一次。
       * 真取那条还兼着两件别的事，所以兜底不能省：①原生弹窗（modal state）期间 snapshot
       * 会被 playwright 拒绝，这不是故障 —— 转成「弹窗步」，只问 Jev 一道「动作」（接受 /
       * 取消弹窗），处理完弹窗下一轮就能正常快照（实测：mailbox 删除触发 confirm 即走这条）；
       * ②CDP 守卫的每步检查点（被关/被切走的专用标签页在 ②page-info 那道同样会拦下，
       * 只是晚一个阶段）。 */
      let snap;
      const carried = snapshotCarrier.take();
      if (carried) {
        snap = { ok: true, snapshot: carried, fromAction: true };
      } else {
        snap = await apiJson('/api/browser/snapshot', {});
      }
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
      /* ①b 快照裁剪（超预算才动手）—— 位置是刻意的：必须在**任何派生之前**。
       * refLabels / refRoles / detectStall / buildState / recallPlan / paramCriteria /
       * buildQuestions / 截图标注 / 落盘 全部从 snapText 派生，只在裁这一处，
       * 它们天然一致（ref 编号、候选、树形、标注指的是同一份文本）。
       * 事后再裁就会出现「候选里的 ref 不在快照里」那类老 bug。
       * 弹窗步的快照是常量说明文本，没有裁的意义，跳过。 */
      let snapTrim = null;
      if (!dialogMode && (!runCfg.snapshotTrim || runCfg.snapshotTrim.on !== false)) {
        snapTrim = SnapshotTrim.truncate({
          snapshot: snapText,
          goal: runCfg.goal,
          budgetBytes: runCfg.snapshotTrim && runCfg.snapshotTrim.budgetBytes,
        });
        snapText = snapTrim.text;
      }
      /* ①c 与上一步**看到的**快照做差分（纯本地计算，零浏览器往返）。
       * 位置与裁剪同理：必须在 buildState / detectStall / 回执之前，且基于**裁后**的 snapText
       * —— 两侧只有落在同一裁剪空间里才有可比性（档位不同会产生成百行假差异，
       * 会被误判成「整页替换」；而最需要这一步的密集页恰好会被裁）。 */
      const prevStep = steps.length ? steps[steps.length - 1] : null;
      const prevTrim = prevStep && prevStep.snapshotTrim;
      const curTrim = snapTrim && snapTrim.meta;
      const diffReliable = (!prevTrim !== !curTrim) ? false
        : (!prevTrim || (prevTrim.rungs || []).join('>') === (curTrim.rungs || []).join('>'));
      const stepDiff = (dialogMode || !prevStep) ? null : SnapshotDiff.diff({
        prev: prevStep.snapshot,
        cur: snapText,
        goal: runCfg.goal,
        actedRef: prevStep.decision && prevStep.decision.param,
        reliable: diffReliable,
      });
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
      /* 停滞检测（重复同一动作 / 快照连续未变）→ 只写进 state 当反馈，不终止。
       * 弹窗步必须排除：那时快照是常量说明文本（DIALOG_SNAPSHOT_NOTE），
       * 连续两步必然「未变化」，不排除就会每次处理弹窗都平白误报一条。 */
      const stall = dialogMode
        ? { notice: null }
        : AutoCore.detectStall(steps, snapText, runCfg.variables);
      /* 效果回执：把「上一步结果」从光秃秃的「成功」升级成一句**观测**（改了哪一行、旧原文 → 新原文）。
       * 必须落在模型唯一信任的那个字段里 —— 另开字段会被当背景噪音（实测反例 r-0929-0847-jwac：
       * 停滞提示说「你在原地打转」，这个字段说「成功」，模型信了后者，一直点到第 10 步）。
       * 只陈述观测：不写「是同一个元素」、不写「因为你点了」—— 解释权归模型，原文对里带着新旧两个
       * ref，模型自己就能把旧 ref 和「已完成步骤」那一行接上。
       * 下列情形一个字都不能说「没变化」（结果不体现在 a11y 快照里，说了就是假话、会让模型重试）：
       * 滚动键 / hover、标签页数量变了（tabNote 自己会说）、用户跳过、弹窗步。 */
      const quietDiff = dialogMode
        || Boolean(tabNote)
        || Boolean(prevStep && prevStep.exec && prevStep.exec.skipped)
        || Boolean(prevStep && prevStep.decision
             && AutoCore.isOpaqueAction(prevStep.decision, runCfg.variables));
      const receipt = SnapshotDiff.receipt({ base: lastResult, diff: quietDiff ? null : stepDiff });
      const lastChange = (!quietDiff && stepDiff && stepDiff.reliable) ? stepDiff.digest : '';
      const state = AutoCore.buildState({
        goal: runCfg.goal, url: pageInfo.url, title: pageInfo.title,
        history, lastResult: tabNote ? (receipt + '\n' + tabNote) : receipt,
        snapshot: snapText, tabs: pageInfo.tabs,
        stallNotice: stall.notice, lastChange: lastChange,
      });
      /* 本步的候选算法路线（「高级参数」里选，默认并行召回）：
       *   parallel —— 首轮仍是三道题，「参数」候选只给**本页前 size 个元素**；动作确定后
       *               若它需要定位元素，再发起第二轮并行召回去核对**其余元素**，最后
       *               在「首轮前 topN 个 + 召回合并」里做一次最终决策
       *   ranked   —— 单次调用 + 相关性裁剪（含「其他」兜底补问，见 resolveMoreBatches）
       * 元素不超过一批（K=0 个召回批次）与关掉裁剪时 plan 为 null，一律走单次调用 */
      const plan = dialogMode ? null : AutoCore.recallPlan({ snapshot: snapText, paramTrim: runCfg.paramTrim });

      const step = {
        n, label: null, decision: null, payload: null, response: null, jevError: null,
        exec: null, llm: null, screenshot: null, terminal: null,
        pageInfo, snapshot: snapText, refLabels, historyLine: null, generatedText: null,
        trim: null, followUps: [], trimNote: null, ms: null, recall: null,
        /* 本步快照裁剪的账（null = 没裁）。与 trim 并列，导出记录里能看见「这步裁了多少」 */
        snapshotTrim: snapTrim ? snapTrim.meta : null,
        /* 这一页依据是怎么来的：'action' = 上一步动作顺带带回（省了一次快照调用），
         * 'fresh' = 这一步真取了一次。看得见才验得动 —— 省没省、哪几步没省，一眼能对。
         * 弹窗步写 null：那时的「快照」是常量说明文本（DIALOG_SNAPSHOT_NOTE），
         * 说成「本步新取」是假话（取是取了，取失败了）。 */
        snapshotFrom: dialogMode ? null : (snap.fromAction ? 'action' : 'fresh'),
        /* 本步与上一步看到的快照之间的差分（见 snapshot-diff.js）。在字面量里就赋值，
         * 而不是等 ⑤b —— 这样 Jev 调用失败 / 解析失败的步也留下了「它看到了什么」的证据，
         * 而那恰恰是最需要回看的一步。 */
        diff: stepDiff,
        /* 「本步要操作的那一行，正是上一步动作改动过的行」—— 参数经归一 / 召回 / 补问之后
         * 才算最终值，所以只能定在 ⑨ 执行之前（见那边）。它只用于重复检测，不写进回执。 */
        chasedOwnChange: false, chasedLine: null, chasedNote: null,
      };
      steps.push(step);
      touch();   /* 主调用期间树即出现本步 'run' 脉冲骨架，与状态条同步 */

      let param;
      let questions;
      if (dialogMode) {
        /* 弹窗步没有快照，只问一道「动作」（dialog-accept / dialog-dismiss） */
        param = { criteria: {}, meta: { trimmed: false } };
        questions = AutoCore.buildDialogQuestions();
      } else if (plan) {
        /* 超限页首轮：三道题照旧，「参数」只给前 size 个元素。
         * 这一段之外的候选交给第二轮的并行召回 —— 首轮不必先排一遍序、也不必
         * 为整页候选付费；首轮的这个作答会成为最终决策的候选之一（见 resolveRecall）. */
        param = { criteria: plan.first.criteria, meta: Object.assign({}, plan.meta, { first: true }) };
        questions = AutoCore.buildQuestions({ snapshot: snapText, param });
      } else {
        /* 「参数」题候选：≤250 个 ref 原样透传，超限才按相关性裁剪（高级参数可关） */
        param = AutoCore.paramCriteria({
          snapshot: snapText, goal: runCfg.goal,
          avoidRefs: Object.keys(failedRefs), paramTrim: runCfg.paramTrim,
        });
        questions = AutoCore.buildQuestions({ snapshot: snapText, param });
      }
      /* 主调用是「真实的这一次」：payload 落到 step 上（可见性：展示的就是发出的）。
       * 单选项题（「参数」候选只剩 1 个）在这里被剥出去由工程直出 —— 首轮的「动作」题
       * 恒 ≥2 个候选，所以首轮永远会发请求，只是可能少问一题。 */
      const prep = prepareAsk(state, questions);
      step.payload = prep.payload;
      step.localQuestions = prep.localQuestions;
      step.trim = param.meta;
      touch();

      const jev = await prep.send();
      step.jevMs = jev.ms;
      if (!jev.ok) {
        step.jevError = jev.error;
        step.label = 'Jev 调用失败';   /* 错误终步在树里不能永远显示「决策中…」 */
        settleStepMs(step);           /* 失败的步也有耗时，不结算就成了树上一条空白 */
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
            /* 候选里根本没有「其他」，这是无效答案，不能拿它去补问。
             * 两条路线的原因不一样，别把并行召回说成「没触发裁剪」——
             * 那是**另一条**路线的事，写错了读记录的人会去找一个不存在的开关 */
            const why = param.meta.algorithm === 'parallel'
              ? '并行召回这条路线没有兜底项'
              : '当前页面未触发候选裁剪';
            step.exhausted = true;
            step.exec = { ok: false, error: 'Jev 选了候选里没有的「其他」（' + why + '）', cmd: null };
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

      /* ⑤b2 第二轮 · 并行召回（只在这一个条件下发生：页面元素超过一批 **且**
       * 首轮动作是需要定位元素的那几个动作）。动作是终止 / 导航 / 生成输入时，
       * 一个召回请求都不发 —— 那正是「先判动作、再决定要不要召回」的全部意义：
       * 不为用不上的候选付费。
       * 召回范围天然不含首轮看过的那一段（切法保证，见 ref-recall.planBatches）；
       * 首轮在那一段里选出的前 topN 个会作为 seed 带进最终候选，与召回结果一起交给 Jev 决策。
       * 落定后 step.decision 带上 param，⑤c 的角色校验与 ⑤d 的文本补问照常接着走。 */
      if (AutoCore.shouldRecall(plan, step.decision) && !step.exhausted) {
        const picked = await resolveRecall(step, plan, state);
        /* 中止也要结算本步耗时：K 批召回是真花掉的时间，这一步不能留成树上的空白
         * （漏结算，差额会冒充成「收尾」，见 settleStepMs 注释）。先结算再 finishRun。 */
        if (abortFlag) { settleStepMs(step); finishRun({ done: false, state: 'aborted', reason: '用户中止' }); return; }
        if (picked) {
          step.label = AutoCore.describeDecision(step.decision, refLabels, runCfg.variables);
        } else if (step.recall && step.recall.note && /用户中止/.test(step.recall.note)) {
          /* 中止不算「未命中」：不写失败原因，别让记录里出现一条假的调用失败 */
          step.label = step.decision.action + '【已中止】';
        } else {
          /* 召回整段失败（K 批全挂 / 最终决策没落定）：记失败步交给 Jev 自纠，不静默 */
          const last = step.followUps[step.followUps.length - 1] || {};
          step.exhausted = true;
          step.exec = { ok: false, cmd: null, error: last.error || '并行召回未能确定目标元素', refNotTried: true };
          step.label = step.decision.action + '【并行召回未命中】';
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
        if (choice === 'abort') { abortFlag = true; step.exec = { skipped: true }; settleStepMs(step); touch(); finishRun({ done: false, state: 'aborted', reason: '用户中止' }); return; }
        if (choice === 'skip') {
          step.exec = { skipped: true };
          step.historyLine = n + '. ' + step.label + ' · 用户跳过';
          history.push(step.historyLine);
          lastResult = '用户跳过（未执行）';
          settleStepMs(step);   /* 跳过也是本步走完（含等人点按钮的时间） */
          touch();
          continue;
        }
      }

      /* 终止动作：截图留证后收尾（放在确认门之后，单步模式下用户可选择跳过）
       * 终止判定不是「一步操作」，所以在时间线上不留 chip（结论由状态条承担）；
       * 卡片保留 —— 它的最终页面截图是完成证据。
       * 「任务已完成」现在是**唯一的终止态**（「放弃」已从动作集下线），走到这里就是 done。 */
      if (step.decision && AutoCore.TERMINAL_TOOLS[step.decision.action]) {
        step.terminal = step.decision.action;
        step.label = step.decision.action;
        if (runCfg.screenshotOn) { await takeShot(step, 'step-' + n + '-final'); }
        settleStepMs(step);    /* 终帧截图也算本步的工作：今天它完全没被计时 */
        touch();
        history.push(AutoCore.formatHistoryStep(n, step.label, true, null));
        finishRun({ done: true, state: 'done', reason: 'Jev 判定：' + step.terminal });
        return;
      }

      /* ⑧ 操作前截图 + 标注
       * 位置与截图都取自动作之前：元素此刻必定还在、位置唯一确定。放到动作后取位置的话，
       * 演示页「归档」「发货」点完就重渲染、ref 立刻失效，一条都标不出来，而且删行会让
       * 后续行往上顶、环落到相邻行上（两种毛病都是实测过的）。标注画在图上，页面不留痕迹。 */
      /* 弹窗步不截图：modal state 下 screenshot 同样被拒，且没有页面元素可标 */
      if (runCfg.screenshotOn && !dialogMode) {
        await takeShot(step, 'step-' + n, assignRef(step.decision, refLabels));
      }

      /* ⑧b 本步要操作的那一行，是否正是**上一步动作改动过的那一行**？
       * 只能定在这里：参数经过归一 / 召回 / 补问之后才算最终值。
       * 这一条是重复检测的关键 —— 元素改了名 playwright 就重发 ref，未归约的指纹会把
       * 六次点同一个按钮记成六个不同动作（实测 r-0929-1918-7yw4 第 5~10 步）。
       * 它只喂 decisionSig 的哨兵与 detectStall 的第三类计数，**不写进回执**（回执只陈述观测）。 */
      if (stepDiff && stepDiff.reliable && step.decision
          && AutoCore.isRefParam(step.decision.param, refLabels)) {
        const line = SnapshotDiff.lineOfRef(step.snapshot, step.decision.param);
        if (line !== null && SnapshotDiff.isChanged(stepDiff, line)) {
          step.chasedOwnChange = true;
          step.chasedLine = line;
          step.chasedNote = '（本行是上一步动作改动过的行）';
        }
      }
      /* ⑨ 执行 */
      if (step.decision && !step.exhausted) {
        await executeDecision(step, step.decision, refLabels);
      }
      /* 本步到此为止 —— 结算后再看守卫拦没拦（守卫拦下的步也该有耗时） */
      settleStepMs(step);
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
      if (!ok && !step.refNotTried && step.decision
          && AutoCore.isRefParam(step.decision.param, refLabels)) {
        failedRefs[step.decision.param] = 1;
      }

      /* ⑩ 历史与失败计数 */
      step.historyLine = AutoCore.formatHistoryStep(n, step.label, ok, step.exec && step.exec.error, step.chasedNote);
      history.push(step.historyLine);
      lastResult = ok
        ? (step.generatedText ? '成功（生成并填入：' + step.generatedText.slice(0, 60) + '）' : '成功')
        /* 与 historyLine 同一份摘要：这里的 slice(0,120) 会把排在末尾的遮挡根因再切一次，
         * 「上一步结果」是模型下一轮唯一的失败线索，不能只剩「超时」 */
        : '失败：' + AutoCore.briefError(step.exec && step.exec.error);
      consecutiveFails = (ok || (step.exec && step.exec.skipped)) ? 0 : consecutiveFails + 1;

      touch();

      /* ⑪ 终止判断 */
      const t = AutoCore.shouldTerminate({
        steps: n, maxSteps: runCfg.maxSteps,
        unfinishedHistory, consecutiveFails, aborted: abortFlag,
      });
      if (t) { finishRun(t); return; }

      /* 间隔为 0 时不发这一次定时器：sleep(0) 至少要过一个宏任务（浏览器有 4ms 下限
       * 与后台节流），几十步累起来也是白白多出来的收尾误差 */
      if (STEP_GAP_MS > 0) await sleep(STEP_GAP_MS);
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
    els.stop.onclick = () => {
      abortFlag = true;
      /* 门开着时 for 循环还没跑起来，没有任何东西在读 abortFlag —— 不放行这道门，
       * 用户点「中止」就是毫无反应（按钮看着能点、点了没动静）。收尾文案交给门后的
       * finishRun 去写，这里那句「将在当前步骤后中止」在门下是错的（根本没有「当前步骤」）。 */
      if (gateRelease) { gateRelease('abort'); return; }
      toast('将在当前步骤后中止…');
    };
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
    if (els.backend) els.backend.value = readStoredBackend();
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
    /* 深链 ?sess=<id>：列表拉完之后再落座（openSessionFromUrl 自己会等列表） */
    openSessionFromUrl().catch((e) => console.warn('[auto] openSessionFromUrl failed:', e));
  }

  return { init: init };
})();

Auto.init();
