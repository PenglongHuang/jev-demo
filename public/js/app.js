/* ===================== 主应用：预设 Tab / 发送 / 事件绑定 ===================== */

/* ---------- 顶层预设 Tab（场景分组） ---------- */
const PresetTabs = (() => {
  const tabsEl = document.getElementById('presetTabs');
  const chipsEl = document.getElementById('presets');
  const descEl = document.getElementById('presetDesc');

  let groups = [];       // [{ name, presets }]
  let activeGroup = 0;
  let activePreset = null;

  function build() {
    // 按 group 聚类，保持首次出现的顺序
    groups = [];
    PRESETS.forEach((p) => {
      let g = groups.find((x) => x.name === (p.group || '其他'));
      if (!g) { g = { name: p.group || '其他', presets: [] }; groups.push(g); }
      g.presets.push(p);
    });

    tabsEl.innerHTML = '';
    groups.forEach((g, gi) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'ptab' + (gi === 0 ? ' active' : '');
      tab.setAttribute('role', 'tab');
      tab.dataset.gi = gi;
      tab.setAttribute('aria-selected', String(gi === 0));
      const label = document.createElement('span');
      label.textContent = g.name;
      const count = document.createElement('span');
      count.className = 'ptab-count';
      count.textContent = g.presets.length;
      tab.appendChild(label);
      tab.appendChild(count);
      tab.addEventListener('click', () => selectGroup(gi));
      tabsEl.appendChild(tab);
    });

    selectGroup(0);
  }

  function selectGroup(gi) {
    if (gi === activeGroup && chipsEl.children.length) return; // 重复点击同一 Tab 不重载
    activeGroup = gi;
    Array.from(tabsEl.children).forEach((t, i) => {
      t.classList.toggle('active', i === gi);
      t.setAttribute('aria-selected', String(i === gi));
    });

    // 切 Tab 只切换该分组的预设列表，绝不自动载入 —— 自定义场景不会被冲掉
    chipsEl.innerHTML = '';
    groups[gi].presets.forEach((p) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (p === activePreset ? ' active' : '');
      b.textContent = p.name;
      b.addEventListener('click', () => load(p));
      chipsEl.appendChild(b);
    });

    // 常驻的「自定义」入口：不属于任何分组，每个 Tab 下都可见
    const custom = document.createElement('button');
    custom.type = 'button';
    custom.className = 'chip chip-custom' + (activePreset === null ? ' active' : '');
    custom.textContent = '＋ 自定义';
    custom.title = '清空 state 与问题，从空白开始构建你自己的场景';
    custom.addEventListener('click', loadCustom);
    chipsEl.appendChild(custom);

    // 说明文案：载入中的预设优先；否则展示该组第一个预设作为分组介绍
    const first = groups[gi].presets[0];
    const activeHere = groups[gi].presets.indexOf(activePreset) !== -1;
    descEl.textContent = (activeHere && activePreset.desc) ? activePreset.desc : (first && first.desc ? first.desc : '');
  }

  /* 重置：显式载入第一个分组的第一个预设 */
  function resetToDefault() {
    selectGroup(0);
    load(groups[0].presets[0]);
  }

  function load(p) {
    activePreset = p;
    chipsEl.querySelectorAll('.chip').forEach((c) => {
      c.classList.toggle('active', c.textContent === p.name);
    });
    descEl.textContent = p.desc || '';
    App.loadPreset(p);
  }

  /* 自定义模式：无预设高亮 */
  function markCustom(descText) {
    activePreset = null;
    chipsEl.querySelectorAll('.chip').forEach((c) => {
      c.classList.toggle('active', c.classList.contains('chip-custom'));
    });
    descEl.textContent = descText || '从空白开始：填写状态与问题，构建你自己的场景。';
  }

  function loadCustom() {
    markCustom();
    App.loadCustom();
    toast('已进入自定义模式：state 与问题已清空');
  }

  /* 键盘导航：← → 在组之间切换 */
  tabsEl.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = e.key === 'ArrowRight'
      ? (activeGroup + 1) % groups.length
      : (activeGroup - 1 + groups.length) % groups.length;
    selectGroup(next);
    tabsEl.children[next].focus();
  });

  return { build: build, loadFirst: () => load(groups[0].presets[0]), resetToDefault: resetToDefault, markCustom: markCustom };
})();

/* ---------- 主应用 ---------- */
const App = (() => {
  const sendBtn = document.getElementById('send');
  const keyInput = document.getElementById('apiKey');
  let userActed = false;   // 用户已手动选择场景后，启动时的自动恢复不再覆盖

  /* ---------- API 地址探测 ---------- */
  const LOCAL_ORIGIN = 'http://localhost:3000';
  let API_BASE = null;

  async function probe(base) {
    try {
      const res = await fetch(base + '/api/health', { cache: 'no-store', mode: 'cors' });
      if (!res.ok) return false;
      const j = JSON.parse(await res.text());
      return !!j.ok;
    } catch (_) {
      return false;
    }
  }

  async function resolveApiBase() {
    if (await probe('')) return '';
    if (await probe(LOCAL_ORIGIN)) return LOCAL_ORIGIN;
    return null;
  }

  function apiUrl(path) { return (API_BASE || '') + path; }

  /* ---------- 载入预设 ---------- */
  function loadPreset(p) {
    userActed = true;
    StateEditor.load(p.state);
    Questions.clear();
    p.questions.forEach((q) => Questions.addQuestion(resolveDynamicCriteria(q, p.state)));
    // 预设载入后问题卡全部收起，保持清爽；单问题预设无意义所以全展开
    if (Questions.count() > 1) Questions.collapseAll();
    toast('已载入「' + p.name + '」');
  }

  /* ---------- 自定义模式：完全空白（问题列表的占位提示由 CSS :empty 提供） ---------- */
  function loadCustom() {
    userActed = true;
    try { StateEditor.load(''); } finally { Questions.clear(); }
  }

  /* ---------- 场景保存 / 恢复（服务端按 IP 隔离的 JSON 存储） ---------- */
  async function saveWorkspace() {
    try {
      const res = await fetch(apiUrl('/api/workspace'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: StateEditor.getText(), questions: Questions.exportAll() })
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      toast('场景已保存（按 IP 隔离，刷新页面自动恢复）');
    } catch (e) {
      toast('保存失败：' + e.message);
    }
  }

  async function restoreWorkspace() {
    try {
      const res = await fetch(apiUrl('/api/workspace'), { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const ws = data && data.workspace;
      if (!ws || userActed) return;
      const hasState = typeof ws.state === 'string' && ws.state.trim();
      const hasQuestions = Array.isArray(ws.questions) && ws.questions.length;
      if (!hasState && !hasQuestions) return;
      StateEditor.load(hasState ? ws.state : '');
      Questions.restoreAll(hasQuestions ? ws.questions : []);
      PresetTabs.markCustom('已恢复上次保存的场景（按访问 IP 隔离），可继续编辑后重新保存。');
      toast('已恢复上次保存的场景');
    } catch (_) { /* 无后端或从未保存过 —— 保持默认预设 */ }
  }

  function resolveDynamicCriteria(q, stateText) {
    if (q.criteriaFrom !== 'refs') return q;
    const snap = extractSnapshotText(stateText);
    const refs = parseSnapshotRefs(snap);
    const out = Object.assign({}, q);
    out.criteria = buildRefCriteria(snap);
    out._refCount = refs.length;
    return out;
  }

  /* ---------- 收集请求体 ---------- */
  function buildPayload() {
    const stateVal = StateEditor.getValue();
    if (typeof stateVal === 'string' && !stateVal.trim()) {
      throw new Error('请先填写 state（状态文本或 JSON）');
    }

    let stateOut = stateVal;
    if (typeof stateVal === 'string' && /^\s*[[{]/.test(stateVal)) {
      try { stateOut = parseRelaxedJson(stateVal); }
      catch (_) { throw new Error('state 看起来是 JSON，但解析失败，请检查格式'); }
    }

    const questions = Questions.buildQuestions();
    return { state: stateOut, model: document.getElementById('model').value, questions: questions };
  }

  /* ---------- 发送 ---------- */
  async function send() {
    // 发送前用当前 state 重新解析 ref 类问题的 criteria，避免拿到预设载入时的旧快照
    Questions.reparseRefs(true, extractSnapshotText(StateEditor.getValue()));

    let payload;
    try {
      payload = buildPayload();
    } catch (e) {
      Output.renderError(e.message, '', '表单需要修正，尚未发送');
      return toast(e.message);
    }

    if (!keyInput.value.trim()) {
      Output.renderError('请在页面右上角「API Key」输入框里填写你的 API Key（或让服务端通过环境变量 TYPESAFE_API_KEY 配置）。', '', '缺少 API Key，尚未发送');
      return;
    }

    setBusy(true);
    Output.showSkeleton();

    try {
      let res;
      try {
        res = await fetch(apiUrl('/api/systemone'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Typesafe-Key': keyInput.value.trim()
          },
          body: JSON.stringify(payload)
        });
      } catch (netErr) {
        throw {
          kind: 'network',
          msg: '连不上本地服务（' + netErr.message + '）',
          detail: '请确认 `node server.js` 正在运行，且你访问的是 http://localhost:3000'
        };
      }

      const rawText = await res.text();

      if (!rawText.trim()) {
        throw {
          kind: 'no-backend',
          msg: '请求 /api/systemone 没有返回任何内容',
          detail: '当前页面没有连到后端服务。如果你是在静态预览里打开的 HTML，它不会代理接口请求 —— 请运行 `node server.js` 后访问 http://localhost:3000'
        };
      }

      let data;
      try { data = JSON.parse(rawText); }
      catch (parseErr) {
        throw { kind: 'bad-json', msg: '服务返回的不是合法 JSON：' + parseErr.message, detail: '原始响应前 300 字符：' + rawText.slice(0, 300) };
      }

      if (!res.ok) {
        const m = (data.error && (data.error.message || data.error)) || ('HTTP ' + res.status);
        Output.renderError(typeof m === 'string' ? m : JSON.stringify(m), res.status === 401 ? '请确认 API Key 是否有效' : '');
      } else {
        Output.renderAll(data, payload);
      }
    } catch (e) {
      if (e && e.kind) Output.renderError(e.msg, e.detail);
      else Output.renderError('发生未知错误：' + (e && e.message ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  function setBusy(b) {
    sendBtn.disabled = b;
    document.getElementById('spin').style.display = b ? 'inline-block' : 'none';
    document.getElementById('sendLabel').textContent = b ? '请求中…' : '发送给 Jev';
    if (b) setStatus('请求中', 'busy');
  }

  /* ---------- 启动自检 ---------- */
  async function checkBackend() {
    const bar = document.getElementById('warnbar');
    const base = await resolveApiBase();

    if (base === null) {
      API_BASE = null;
      bar.className = 'warnbar show';
      bar.innerHTML =
        '<div class="title">⚠ 连不上后端服务，无法调用 Jev</div>' +
        '已尝试 <code>' + location.origin + '/api/health</code> 和 <code>' + LOCAL_ORIGIN + '/api/health</code>，都没有响应。' +
        '请启动本地服务：<br />' +
        '1. 进入 <code>jev-demo</code> 目录，<b>双击 <code>start.bat</code></b>（或执行 <code>node server.js</code>）<br />' +
        '2. 保持那个终端窗口开着<br />' +
        '<button id="retryBtn" type="button" class="btn-retry">↻ 重试连接</button>';
      const rb = document.getElementById('retryBtn');
      if (rb) rb.onclick = () => {
        rb.textContent = '正在重试…';
        checkBackend();
      };
      return;
    }

    API_BASE = base;
    setStatus('就绪', '');

    if (base === '') {
      bar.className = 'warnbar';
      bar.innerHTML = '';
    } else {
      bar.className = 'warnbar show';
      bar.innerHTML =
        '<div class="title">✓ 已自动连到 ' + LOCAL_ORIGIN + '</div>' +
        '本页是从静态预览打开的，没有自带后端；已自动把请求转发到本地服务，<b>功能完全可用</b>。';
    }
  }

  /* ---------- 事件绑定 ---------- */
  function bindEvents() {
    sendBtn.onclick = send;

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !sendBtn.disabled) {
        e.preventDefault();
        send();
      }
    });

    // 输出区 Tab
    document.querySelectorAll('.tabs .tab').forEach((t) => {
      t.addEventListener('click', () => { if (!t.disabled) Output.showPane(t.dataset.pane); });
    });

    // 添加问题
    document.getElementById('addQ').onclick = () => {
      const el = Questions.addQuestion({ type: 'noul', name: '问题' + (Questions.count() + 1), instructions: '' });
      el.classList.remove('collapsed'); // 新建的问题保持展开，方便直接填写
      el.querySelector('[data-f="instructions"]').focus();
    };

    // 重新解析 ref
    document.getElementById('reparseQ').onclick = () =>
      Questions.reparseRefs(false, extractSnapshotText(StateEditor.getValue()));

    // 保存场景（按 IP 隔离）
    document.getElementById('saveWs').onclick = saveWorkspace;

    // state 格式化（源码模式）
    document.getElementById('fmtState').onclick = () => StateEditor.formatRaw();

    // state 模式切换
    document.querySelectorAll('#stateModeSeg .seg-btn').forEach((b) => {
      b.addEventListener('click', () => StateEditor.setMode(b.dataset.mode));
    });

    // 重置：回到第一个分组的第一个预设
    document.getElementById('reset').onclick = () => {
      PresetTabs.resetToDefault();
      Output.resetPane();
    };
  }

  /* ---------- API Key：localStorage 持久化 ---------- */
  function initKey() {
    const KEY_STORAGE = 'jev-api-key';
    keyInput.value = localStorage.getItem(KEY_STORAGE) || '';
    keyInput.addEventListener('input', () => {
      const v = keyInput.value.trim();
      if (v) localStorage.setItem(KEY_STORAGE, v);
      else localStorage.removeItem(KEY_STORAGE);
    });
  }

  function init() {
    initKey();
    bindEvents();
    Questions.initDragAndDrop();
    PresetTabs.build();
    PresetTabs.loadFirst();
    // 后端就绪后尝试恢复该 IP 上次保存的场景
    checkBackend().then(restoreWorkspace);
  }

  return { init: init, loadPreset: loadPreset, loadCustom: loadCustom };
})();

App.init();
