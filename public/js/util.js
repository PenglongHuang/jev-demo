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
  ta.addEventListener('input', fit);
  fit();
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
  criteria['无需元素'] = '不需要操作任何元素（例如任务已完成、或仅需滚动/等待）';
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

/* node:test 环境导出（浏览器 <script> 加载时此分支不生效，auto-core.js 复用同一实现） */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseSnapshotRefs, buildRefCriteria, extractSnapshotText };
}
