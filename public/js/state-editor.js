/* ===================== State 编辑器：表单 / 源码 双模式 =====================
 * JSON 对象 state 在「表单」模式下渲染成 键 → 值 的可编辑行（可增删字段）；
 * 纯文本 state 则是一个大文本框。两种模式随时切换，发送时统一取值：
 * 表单 KV 模式直接产出对象，源码模式返回文本（发送前再按需解析）。
 */
const StateEditor = (() => {
  const formEl = document.getElementById('stateForm');
  const rawWrap = document.getElementById('stateRawWrap');
  const rawTa = document.getElementById('state');
  const metaEl = document.getElementById('stateMeta');
  const fmtBtn = document.getElementById('fmtState');
  const segBtns = Array.from(document.querySelectorAll('#stateModeSeg .seg-btn'));

  let mode = 'form';      // 'form' | 'raw'
  let plain = false;      // true = 纯文本 state（非 JSON 对象）
  let entries = [];       // JSON 模式：[{ key, value: string }]
  let plainText = '';
  let plainTa = null;

  autoGrow(rawTa, 460);

  function looksLikeJson(text) { return /^\s*[[{]/.test(text || ''); }

  /* 识别文本：JSON 对象 → { plain:false, obj }；其余 → { plain:true } */
  function detect(text) {
    if (looksLikeJson(text)) {
      try {
        const obj = parseRelaxedJson(text);
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          return { plain: false, obj: obj };
        }
      } catch (_) { /* 解析失败按纯文本处理 */ }
    }
    return { plain: true, obj: null };
  }

  /* 非字符串值（数组 / 对象 / 数字）在表单里以 JSON 字面量展示，读回时尽量还原 */
  function valueToText(v) {
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v, null, 2); } catch (_) { return String(v); }
  }

  function textToValue(text) {
    const raw = String(text == null ? '' : text);
    const t = raw.trim();
    if (/^[[{]/.test(t)) {
      try { return parseRelaxedJson(t); } catch (_) { return raw; }
    }
    return raw;
  }

  function updateMeta() {
    if (!metaEl) return;
    if (mode === 'raw') { metaEl.textContent = ''; return; }
    metaEl.textContent = plain ? '纯文本' : formEl.querySelectorAll('.kv-row').length + ' 个字段';
  }

  function applySeg() {
    segBtns.forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    fmtBtn.hidden = mode !== 'raw';
    rawWrap.hidden = mode !== 'raw';
    formEl.hidden = mode !== 'form';
  }

  function kvRow(entry) {
    const row = document.createElement('div');
    row.className = 'kv-row';
    row.innerHTML =
      '<input type="text" class="kv-key" aria-label="字段名" placeholder="字段名" spellcheck="false" />' +
      '<textarea class="kv-val" aria-label="字段值（可多行，支持 JSON）" spellcheck="false"></textarea>' +
      '<button type="button" class="row-del" title="删除字段" aria-label="删除字段">×</button>';
    row.querySelector('.kv-key').value = entry.key;
    const val = row.querySelector('.kv-val');
    val.value = entry.value;
    autoGrow(val, 480);
    row.querySelector('.row-del').addEventListener('click', () => {
      row.remove();
      updateMeta();
    });
    return row;
  }

  function renderForm() {
    formEl.innerHTML = '';
    if (plain) {
      const label = document.createElement('label');
      label.className = 'field-label';
      label.textContent = '状态文本';
      const ta = document.createElement('textarea');
      ta.className = 'state-plain-ta';
      ta.setAttribute('aria-label', '状态文本');
      ta.placeholder = '粘贴一段文本…';
      ta.value = plainText;
      ta.addEventListener('input', () => { plainText = ta.value; });
      autoGrow(ta, 460);
      const tip = document.createElement('p');
      tip.className = 'field-tip';
      tip.textContent = '纯文本会原样作为 state 发送。切到「源码」可以改成 JSON 对象。';
      formEl.appendChild(label);
      formEl.appendChild(ta);
      formEl.appendChild(tip);
      plainTa = ta;
    } else {
      plainTa = null;
      entries.forEach((e) => formEl.appendChild(kvRow(e)));
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'chip add-field';
      add.textContent = '＋ 添加字段';
      add.addEventListener('click', () => {
        const row = kvRow({ key: '', value: '' });
        formEl.insertBefore(row, add);
        row.querySelector('.kv-key').focus();
        updateMeta();
      });
      const tip = document.createElement('p');
      tip.className = 'field-tip';
      tip.textContent = '每个字段是一个键值对；值可以是多行文本，也可以是 JSON（数组 / 对象）。';
      formEl.appendChild(add);
      formEl.appendChild(tip);
    }
    updateMeta();
  }

  /* 从 DOM 收集 KV（strict 时对空字段名 / 重复字段名抛错） */
  function collectObj(strict) {
    const obj = {};
    const seen = {};
    const rows = formEl.querySelectorAll('.kv-row');
    rows.forEach((row, idx) => {
      const key = row.querySelector('.kv-key').value.trim();
      if (!key) {
        if (strict) throw new Error('state 第 ' + (idx + 1) + ' 个字段没有字段名');
        return;
      }
      if (seen[key]) {
        if (strict) throw new Error('state 字段名重复：' + key);
        return;
      }
      seen[key] = true;
      obj[key] = textToValue(row.querySelector('.kv-val').value);
    });
    return obj;
  }

  function serializeForm() {
    if (plain) return plainTa ? plainTa.value : plainText;
    return relaxedStringify(collectObj(false), 0);
  }

  function applyRawToForm() {
    const d = detect(rawTa.value);
    plain = d.plain;
    if (d.plain) {
      plainText = rawTa.value;
      entries = [];
    } else {
      entries = Object.keys(d.obj).map((k) => ({ key: k, value: valueToText(d.obj[k]) }));
    }
    renderForm();
  }

  /* 切换模式；目标是表单但 JSON 非法时停留在源码并返回 false */
  function setMode(next) {
    if (next === mode || (next !== 'form' && next !== 'raw')) return mode === next;
    if (next === 'form') {
      if (looksLikeJson(rawTa.value)) {
        try { parseRelaxedJson(rawTa.value); }
        catch (e) { toast('JSON 解析失败，仍停留在源码模式：' + e.message); return false; }
      }
      applyRawToForm();
    } else {
      rawTa.value = serializeForm();
    }
    mode = next;
    applySeg();
    updateMeta();
    return true;
  }

  /* 载入预设 / 重置：以一段文本初始化，默认进表单模式 */
  function load(text) {
    const d = detect(text);
    plain = d.plain;
    entries = d.plain ? [] : Object.keys(d.obj).map((k) => ({ key: k, value: valueToText(d.obj[k]) }));
    plainText = String(text == null ? '' : text);
    rawTa.value = d.plain ? plainText : relaxedStringify(d.obj, 0);
    mode = 'form';
    applySeg();
    renderForm();
  }

  /* 发送时取值：源码 → 文本；纯文本 → 文本；KV → 对象（严格校验） */
  function getValue() {
    if (mode === 'raw') return rawTa.value;
    if (plain) return plainTa ? plainTa.value : plainText;
    return collectObj(true);
  }

  /* 保存场景时取值：任何模式都返回文本（KV 序列化成宽松 JSON） */
  function getText() {
    if (mode === 'raw') return rawTa.value;
    return serializeForm();
  }

  function formatRaw() {
    const raw = rawTa.value.trim();
    if (!raw) return toast('state 为空，无需格式化');
    if (!looksLikeJson(raw)) return toast('state 是纯文本，无需格式化');
    try {
      rawTa.value = relaxedStringify(parseRelaxedJson(raw), 0);
      toast('已格式化 state');
    } catch (e) {
      toast('不是合法 JSON，无法格式化：' + e.message);
    }
  }

  /* 字段增删/改名后刷新「N 个字段」 */
  formEl.addEventListener('input', () => { if (mode === 'form' && !plain) updateMeta(); });

  return {
    load: load,
    setMode: setMode,
    getValue: getValue,
    getText: getText,
    formatRaw: formatRaw
  };
})();
