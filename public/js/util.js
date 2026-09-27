/* ===================== 通用工具 ===================== */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function pct(x) { return (x * 100).toFixed(1) + '%'; }

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

function setStatus(text, cls) {
  const pill = document.getElementById('statusPill');
  pill.textContent = text;
  pill.className = 'status-pill' + (cls ? ' ' + cls : '');
}

/* textarea 随内容自动长高（超过 max 后内部滚动；不可见时跳过，显示后再随输入适配） */
function autoGrow(ta, max) {
  const cap = max || 320;
  const fit = () => {
    if (!ta.isConnected || ta.offsetParent === null) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, cap) + 'px';
  };
  ta.__autofit = fit;   /* 暴露给 fitTextareas：元素插进 DOM 之后再补跑一次 */
  ta.addEventListener('input', fit);
  fit();
}

/* 批量补跑自适应。调用方「先把行建出来、再插进 DOM」时，autoGrow 里的首次 fit 会被
 * isConnected 检查挡掉，插入之后又没有任何事件再触发它（只有用户敲字才会跳高）。
 * 所以 append 完成、元素可见后必须显式补一次。 */
function fitTextareas(root) {
  if (!root) return;
  const list = root.querySelectorAll('textarea');
  for (let i = 0; i < list.length; i++) {
    const fit = list[i].__autofit;
    if (typeof fit === 'function') fit();
  }
}

/* ===================== 快照 ref 解析 =====================
 * 从 playwright-cli 的可访问性快照 YAML 中提取全部 ref 及其描述，
 * 生成 Choice 的 criteria。「参数」选项永远和当前 state 里的快照一致。
 */
function parseSnapshotRefs(snapshotText) {
  const refs = [];
  const seen = new Set();

  String(snapshotText || '').split('\n').forEach((line) => {
    const m = line.match(/\[ref=([A-Za-z0-9_-]+)\]/);
    if (!m) return;
    const ref = m[1];
    if (seen.has(ref)) return;
    seen.add(ref);

    let label = line
      .slice(0, m.index)
      .replace(/^\s*[-•]\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
    label = label.replace(/[:：]$/, '').trim();

    const tailMatch = line.match(/\]\s*:\s*(.+)$/);
    const tail = tailMatch ? tailMatch[1].replace(/\s+/g, ' ').trim() : '';

    if (!label) {
      label = tail || '（无描述）';
    } else if (tail && !label.includes(tail)) {
      label = label + '：' + tail;
    }

    const role = label.split(/[\s"]/)[0].toLowerCase();
    const INTERACTIVE_ROLES = [
      'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox',
      'slider', 'switch', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
      'tab', 'option', 'spinbutton', 'listbox', 'treeitem', 'img'
    ];
    const interactive =
      /\[cursor=pointer\]/.test(line) || INTERACTIVE_ROLES.indexOf(role) !== -1;

    /* role 也一并返回：动作 × 角色兼容性校验要用（auto-core.checkActionRole）。
     * 只暴露事实，不做判断 —— 判断规则留在 auto-core，保证这里是纯解析。 */
    refs.push({ ref, label, interactive, role });
  });

  return refs;
}

function buildRefCriteria(snapshotText) {
  const refs = parseSnapshotRefs(snapshotText);
  const criteria = {};
  refs.forEach((r) => {
    criteria[r.ref] = (r.interactive ? '【可交互】' : '【容器/静态】') + ' ' + r.label;
  });
  /* 不再附「无需元素」兜底项：它和不作用于元素的动作（press / goto / 标签页…）
   * 语义打架，真实模型在密集页的候选批次里把它当成了「本批没有目标元素」，
   * 连续三步选它触发校验失败整轮终止（实测百度搜索页 345 ref）。
   * 现在不作用于元素的动作选了参数也不消费（auto-core.normalizeParam 剥掉）。 */
  return criteria;
}

/* 从 state（可能是 JSON 字符串 / 对象）里取出快照文本 */
function extractSnapshotText(stateVal) {
  try {
    const obj = typeof stateVal === 'string' ? parseRelaxedJson(stateVal) : stateVal;
    if (obj && typeof obj === 'object') {
      for (const k of Object.keys(obj)) {
        if (/快照|snapshot/i.test(k) && typeof obj[k] === 'string') return obj[k];
      }
      let best = '';
      for (const v of Object.values(obj)) {
        if (typeof v === 'string' && v.length > best.length) best = v;
      }
      if (best) return best;
    }
  } catch (_) { /* 不是 JSON，按纯文本处理 */ }
  return String(stateVal || '');
}

/* ===================== 宽松 JSON：展示美观、发送前自动转换 =====================
 * 严格 JSON 不允许字符串里有真实换行，所以快照在 JSON 里只能是一长串 \n 转义。
 * 约定：文本框里允许「宽松 JSON」—— 字符串值里可以直接写真实换行/制表符；
 * 点发送或解析时由 relaxToJsonText 自动转回转义符。引号与反斜杠仍按 JSON 规则转义。
 */
function relaxToJsonText(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!inStr) {
      if (c === '"') inStr = true;
      out += c;
      continue;
    }
    if (c === '\\') { out += c + (text[i + 1] || ''); i++; continue; }
    if (c === '"') { inStr = false; out += c; continue; }
    if (c === '\n') { out += '\\n'; continue; }
    if (c === '\r') { out += '\\r'; continue; }
    if (c === '\t') { out += '\\t'; continue; }
    out += c;
  }
  return out;
}

function parseRelaxedJson(text) {
  return JSON.parse(relaxToJsonText(text));
}

function relaxedStringify(value, level) {
  const pad = '  '.repeat(level);
  const padIn = '  '.repeat(level + 1);

  if (typeof value === 'string') {
    if (value.indexOf('\n') === -1) return JSON.stringify(value);
    const esc = (l) => JSON.stringify(l).slice(1, -1);
    const lines = value.split('\n');
    return '"' + esc(lines[0]) + lines.slice(1).map((l) => '\n' + padIn + esc(l)).join('') + '"';
  }
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return '[\n' + value.map((v) => padIn + relaxedStringify(v, level + 1)).join(',\n') + '\n' + pad + ']';
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) return '{}';
    const items = keys.map((k) => padIn + JSON.stringify(k) + ': ' + relaxedStringify(value[k], level + 1));
    return '{\n' + items.join(',\n') + '\n' + pad + '}';
  }
  return JSON.stringify(value);
}

/* ===================== 撤销提示（删除类操作的安全网） =====================
 * 5 秒内可撤销：onUndo 由调用方提供（恢复它刚删掉的东西）。
 * 宿主 #undoHost 懒建 —— 不进 index.html，省掉一次跨文件的骨架协调。
 * 同一时刻只留一条：新提示顶掉旧的，不堆成一列。
 * 样式在 styles.css 的「Wave 0 冻结」块里（#undoHost / .undo-toast / .undo-btn）。 */
function undoToast(msg, onUndo, ms) {
  let host = document.getElementById('undoHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'undoHost';
    document.body.appendChild(host);
  }
  host.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'undo-toast';
  const text = document.createElement('span');
  text.textContent = msg;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'undo-btn';
  btn.textContent = '撤销';
  box.appendChild(text);
  box.appendChild(btn);
  host.appendChild(box);
  requestAnimationFrame(() => box.classList.add('show'));
  let done = false;
  const dismiss = () => {
    if (done) return;
    done = true;
    box.classList.remove('show');
    setTimeout(() => box.remove(), 220);
  };
  const timer = setTimeout(dismiss, ms || 5000);
  btn.onclick = () => { clearTimeout(timer); dismiss(); onUndo && onUndo(); };
  return dismiss;
}

/* ===================== 删除 + 撤销（删除类操作的安全网） =====================
 * 三处可删除列表（变量池 / 问题列表 / state 字段）共用同一套「删掉 + 5 秒撤销」：
 * 删除前抓住原位锚点，撤销时插回**同一个活节点**（不是 clone）—— 里面的输入值、
 * 事件监听、dataset 全都还在，撤销后可以接着编辑。
 *
 * opts.stillValid：可选。撤销窗口里容器可能已被重建（再点一次预设 / 表单↔源码来回切），
 *   那一代的节点是重新从数据建出来的，这个条目本来就已经回来了 —— 旧节点再插一次
 *   就成了重复条目（buildQuestions 抛「问题 id 重复」/ collectObj 抛「字段名重复」）。
 *   代际变了就退化成幂等空操作，不插。
 * opts.fallbackAnchor：可选，容器内没有原锚点时（如同级的锚点也被删了）的兜底插入点，
 *   收 parent 返回一个节点（例：parent => parent.querySelector('.add-field')）。
 * opts.onChange：可选，删除后与撤销后各跑一次（如 state-editor 的 updateMeta）。 */
function removeWithUndo(node, msg, opts) {
  const o = opts || {};
  const parent = node.parentNode;
  if (!parent) return;                 /* 已不在文档里（重复点）：没有再删一次的道理 */
  const next = node.nextSibling;       /* 记住原位，撤销时插回同一处 */
  node.remove();
  if (o.onChange) o.onChange();
  undoToast(msg, () => {
    if (o.stillValid && !o.stillValid()) return;
    const tip = (next && next.parentNode === parent) ? next
      : (o.fallbackAnchor ? o.fallbackAnchor(parent) : null);
    if (tip) parent.insertBefore(node, tip);
    else parent.appendChild(node);
    if (o.onChange) o.onChange();
  });
}

/* Tab 键圈在容器里不外溢（#taskModal 任务弹窗、#confirmModal 确认框共用）。
 * 焦点跑到背后页面上是最不该发生的事：Tab 到一半回车就可能落在被遮挡的按钮上 ——
 * 对破坏性操作的确认框尤其如此。不可见 / 禁用的节点不参与回绕。 */
function trapTab(e, root) {
  const nodes = Array.from(root.querySelectorAll(
    'button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
  )).filter((n) => !n.disabled && n.offsetParent !== null);
  if (!nodes.length) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/* ===================== 居中确认（替代 window.confirm） =====================
 * 复用既有的 .modal-backdrop / .modal 视觉（与「运行参数」「API 配置」同一套）。
 * 骨架 #confirmModal 在 index.html；这里只负责填充与开关。
 * 骨架缺失时优雅退回原生 confirm —— 不让一个 DOM 事故把功能整个打死。 */
function confirmDialog(opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const back = document.getElementById('confirmModal');
    if (!back) return resolve(window.confirm(o.title || '确认？'));
    const title = back.querySelector('#confirmTitle');
    const body = back.querySelector('#confirmBody');
    const okBtn = back.querySelector('#confirmOk');
    const cancelBtn = back.querySelector('#confirmCancel');
    const closeBtn = back.querySelector('#confirmClose');
    title.textContent = o.title || '确认';
    body.textContent = o.text || '';      /* 只收纯文本：调用方拼 html 会带进 XSS 面 */
    okBtn.textContent = o.okText || '确认';
    okBtn.className = 'btn-primary' + (o.danger === false ? '' : ' danger-solid');
    cancelBtn.textContent = o.cancelText || '取消';
    const lastFocus = document.activeElement;   /* 关闭后把焦点还回原处 */
    let done = false;
    function finish(v) {
      if (done) return;
      done = true;
      back.hidden = true;
      document.removeEventListener('keydown', onKey);
      if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (_) { /* 元素已消失 */ } }
      resolve(v);
    }
    function onKey(e) {
      if (e.key === 'Escape') { finish(false); return; }
      if (e.key !== 'Tab') return;
      trapTab(e, back);   /* 这是**破坏性操作的确认框**，焦点绝对不能跑到背后页面上 */
    }
    document.addEventListener('keydown', onKey);
    okBtn.onclick = () => finish(true);
    cancelBtn.onclick = () => finish(false);
    if (closeBtn) closeBtn.onclick = () => finish(false);   /* ✕ 等同取消，别让它成死按钮 */
    back.onclick = (e) => { if (e.target === back) finish(false); };
    back.hidden = false;
    setTimeout(() => cancelBtn.focus(), 30);   /* 焦点给「取消」：破坏性操作不该默认确认 */
  });
}

/* node:test 环境导出（浏览器 <script> 加载时此分支不生效，auto-core.js 复用同一实现） */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseSnapshotRefs, buildRefCriteria, extractSnapshotText };
}
