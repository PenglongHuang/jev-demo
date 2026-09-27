/* ===================== 问题编辑器：结构化 criteria =====================
 * choice → 选项名 + 描述 的行编辑器；score → 带上下移的等级列表；
 * noul → true/false 两个输入框。大选项集（工具列表 / ref 解析结果）折叠为摘要卡，
 * 可展开预览或转成 JSON 源码继续编辑。buildQuestions 时从 DOM 收集并严格校验。
 */
const Questions = (() => {
  const listEl = document.getElementById('qList');
  let qSeq = 0;
  let listGen = 0;   // 列表代际：清空/重建后，上一代捕获的「删除撤销」要失效（见 .q-del）

  const BIG_THRESHOLD = 12;   // 超过此项数 → 摘要模式

  function isBig(type, criteria) {
    if (type === 'choice') return Object.keys(criteria || {}).length > BIG_THRESHOLD;
    return false;
  }

  function safeParse(s) { try { return JSON.parse(s); } catch (_) { return null; } }

  const TIP_FOR = {
    choice: '选项名 → 描述，最多 255 项。描述要能彼此区分。',
    score: '从低到高的等级描述，2–10 级。建议描述情境而非纯数字。',
    noul: '可选：说明 true / false 各指什么（填了更稳定）。'
  };

  /* ---------- 摘要卡片（大选项集） ---------- */
  function summaryCard(el, type, criteria, tipText) {
    const wrap = document.createElement('div');
    wrap.className = 'crit-summary';
    const n = type === 'choice' ? Object.keys(criteria).length : criteria.length;

    const head = document.createElement('div');
    head.className = 'cs-head';
    const count = document.createElement('span');
    count.innerHTML = '<b>' + n + '</b> 个选项';
    const badge = document.createElement('span');
    badge.className = 'cs-badge';
    badge.textContent = '自动维护';
    head.appendChild(count);
    head.appendChild(badge);
    wrap.appendChild(head);

    if (tipText) {
      const note = document.createElement('p');
      note.className = 'cs-note';
      note.textContent = tipText;
      wrap.appendChild(note);
    }

    const det = document.createElement('details');
    const sum = document.createElement('summary');
    sum.textContent = '预览全部选项';
    det.appendChild(sum);
    const box = document.createElement('div');
    box.className = 'cs-list';
    if (type === 'choice') {
      Object.keys(criteria).forEach((k) => {
        const item = document.createElement('div');
        item.className = 'cs-item';
        const b = document.createElement('b');
        b.textContent = k;
        const s = document.createElement('span');
        s.textContent = criteria[k];
        s.title = criteria[k];
        item.appendChild(b);
        item.appendChild(s);
        box.appendChild(item);
      });
    } else {
      criteria.forEach((v, i) => {
        const item = document.createElement('div');
        item.className = 'cs-item';
        const b = document.createElement('b');
        b.textContent = String(i);
        const s = document.createElement('span');
        s.textContent = v;
        s.title = v;
        item.appendChild(b);
        item.appendChild(s);
        box.appendChild(item);
      });
    }
    det.appendChild(box);
    wrap.appendChild(det);

    const toJson = document.createElement('button');
    toJson.type = 'button';
    toJson.className = 'crit-to-json';
    toJson.textContent = '转换为 JSON 源码编辑';
    toJson.addEventListener('click', () => {
      const ta = renderCritJson(el, criteria);
      ta.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    wrap.appendChild(toJson);

    el.dataset.criteria = JSON.stringify(criteria);
    return wrap;
  }

  function renderCritJson(el, criteria) {
    const box = el.querySelector('.q-crit');
    box.innerHTML = '';
    const ta = document.createElement('textarea');
    ta.className = 'crit-ta';
    ta.setAttribute('aria-label', 'criteria JSON 源码');
    ta.value = JSON.stringify(criteria, null, 2);
    box.appendChild(ta);
    el.dataset.criteria = JSON.stringify(criteria);
    return ta;
  }

  /* ---------- choice 行编辑器 ---------- */
  function choiceEditor(el, criteria) {
    const box = el.querySelector('.q-crit');
    box.innerHTML = '';
    const rows = document.createElement('div');
    rows.className = 'opt-rows';
    box.appendChild(rows);

    const addRow = (k, v) => {
      const row = document.createElement('div');
      row.className = 'opt-row';
      row.innerHTML =
        '<input type="text" class="opt-name" aria-label="选项名" placeholder="选项名" spellcheck="false" />' +
        '<input type="text" class="opt-desc" aria-label="选项描述" placeholder="选项描述（要能和其它选项区分）" />' +
        '<button type="button" class="row-del" title="删除选项" aria-label="删除选项">×</button>';
      row.querySelector('.opt-name').value = k == null ? '' : k;
      row.querySelector('.opt-desc').value = v == null ? '' : v;
      row.querySelector('.row-del').addEventListener('click', () => row.remove());
      return row;
    };

    const entries = Object.entries(criteria || {});
    if (!entries.length) entries.push(['', '']);
    entries.forEach((pair) => rows.appendChild(addRow(pair[0], pair[1])));

    const foot = document.createElement('div');
    foot.className = 'crit-foot';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'chip';
    add.textContent = '＋ 添加选项';
    add.addEventListener('click', () => {
      const row = addRow('', '');
      rows.appendChild(row);
      row.querySelector('.opt-name').focus();
    });
    foot.appendChild(add);
    box.appendChild(foot);
    delete el.dataset.criteria;
  }

  /* ---------- score 等级行编辑器 ---------- */
  function scoreEditor(el, criteria) {
    const box = el.querySelector('.q-crit');
    box.innerHTML = '';
    const rows = document.createElement('div');
    rows.className = 'lvl-rows';
    box.appendChild(rows);

    const renumber = () => {
      const list = Array.from(rows.children);
      list.forEach((row, i) => {
        row.querySelector('.lvl-badge').textContent = i;
        row.querySelector('.lvl-move.up').disabled = i === 0;
        row.querySelector('.lvl-move.down').disabled = i === list.length - 1;
      });
    };

    const addRow = (v) => {
      const row = document.createElement('div');
      row.className = 'lvl-row';
      row.innerHTML =
        '<span class="lvl-badge" aria-hidden="true">0</span>' +
        '<input type="text" class="lvl-desc" aria-label="等级描述" placeholder="这一等级的情境描述" />' +
        '<button type="button" class="lvl-move up" aria-label="上移">↑</button>' +
        '<button type="button" class="lvl-move down" aria-label="下移">↓</button>' +
        '<button type="button" class="row-del" title="删除等级" aria-label="删除等级">×</button>';
      row.querySelector('.lvl-desc').value = v == null ? '' : v;
      row.querySelector('.lvl-move.up').addEventListener('click', () => {
        const prev = row.previousElementSibling;
        if (prev) rows.insertBefore(row, prev);
        renumber();
      });
      row.querySelector('.lvl-move.down').addEventListener('click', () => {
        const next = row.nextElementSibling;
        if (next) rows.insertBefore(next, row);
        renumber();
      });
      row.querySelector('.row-del').addEventListener('click', () => { row.remove(); renumber(); });
      return row;
    };

    const levels = criteria && criteria.length ? criteria : ['', ''];
    levels.forEach((v) => rows.appendChild(addRow(v)));

    const foot = document.createElement('div');
    foot.className = 'crit-foot';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'chip';
    add.textContent = '＋ 添加等级';
    add.addEventListener('click', () => {
      const row = addRow('');
      rows.appendChild(row);
      renumber();
      row.querySelector('.lvl-desc').focus();
    });
    foot.appendChild(add);
    box.appendChild(foot);
    renumber();
    delete el.dataset.criteria;
  }

  /* ---------- noul 编辑器 ---------- */
  function noulEditor(el, criteria) {
    const box = el.querySelector('.q-crit');
    box.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'noul-grid';
    const mk = (lbl, hint, val, dataKey) => {
      const f = document.createElement('div');
      f.className = 'noul-field';
      const lab = document.createElement('label');
      lab.textContent = lbl;
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'noul-inp';
      inp.dataset.noulKey = dataKey;
      inp.setAttribute('aria-label', lbl);
      inp.placeholder = hint;
      inp.value = val == null ? '' : val;
      f.appendChild(lab);
      f.appendChild(inp);
      return f;
    };
    grid.appendChild(mk('true · 「是」的含义', '什么情况下算「是」', criteria ? criteria.true : '', 'true'));
    grid.appendChild(mk('false · 「否」的含义', '什么情况下算「否」', criteria ? criteria.false : '', 'false'));
    box.appendChild(grid);
    delete el.dataset.criteria;
  }

  /* ---------- 渲染入口 ---------- */
  function renderCriteriaValue(el, type, crit) {
    const box = el.querySelector('.q-crit');
    box.innerHTML = '';
    if (type === 'noul') { noulEditor(el, crit); return; }
    if (isBig(type, crit)) {
      const tip = el.dataset.criteriaFrom === 'refs'
        ? '选项从 state 的快照中自动解析，修改 state 后发送时会自动重新解析。'
        : null;
      box.appendChild(summaryCard(el, type, crit, tip));
      return;
    }
    if (type === 'choice') choiceEditor(el, crit);
    else if (type === 'score') scoreEditor(el, crit);
    else noulEditor(el, crit);
  }

  function syncCriteria(el, replace, value) {
    const type = el.querySelector('[data-f="type"]').value;
    const tip = el.querySelector('.q-tip');
    tip.textContent = TIP_FOR[type] || '';

    let crit = null;
    if (!replace && value != null) {
      crit = (typeof value === 'string') ? safeParse(value) : value;
    }
    if (crit == null) {
      if (!replace && typeof value === 'string' && value.trim()) {
        // 恢复保存的场景时可能是没写完的 JSON：原样放进 JSON 源码编辑器，不弄丢内容
        const box = el.querySelector('.q-crit');
        box.innerHTML = '';
        const ta = document.createElement('textarea');
        ta.className = 'crit-ta';
        ta.setAttribute('aria-label', 'criteria JSON 源码');
        ta.value = value;
        box.appendChild(ta);
      } else if (type === 'noul') noulEditor(el, null);
      else if (type === 'score') scoreEditor(el, []);
      else choiceEditor(el, {});
    } else {
      renderCriteriaValue(el, type, crit);
    }
    refreshQHead(el);
  }

  function refreshQHead(el) {
    const type = el.querySelector('[data-f="type"]').value;
    const name = el.querySelector('[data-f="name"]').value.trim() || '未命名问题';
    const badge = el.querySelector('.q-type-badge');
    badge.textContent = type;
    badge.className = 'q-type-badge ' + type;
    el.querySelector('.q-title').textContent = name;
  }

  /* ---------- 从 DOM 收集 criteria（严格校验） ---------- */
  function collectCriteria(el, name) {
    const type = el.querySelector('[data-f="type"]').value;
    const box = el.querySelector('.q-crit');

    // 摘要 / JSON 源码模式：criteria 存在 dataset 里
    if (box.querySelector('.crit-summary') && el.dataset.criteria) {
      return JSON.parse(el.dataset.criteria);
    }
    const ta = box.querySelector('textarea.crit-ta');
    if (ta) {
      const raw = ta.value.trim();
      if (!raw) throw new Error('问题 "' + name + '" 缺少 criteria');
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch (e) { throw new Error('问题 "' + name + '" 的 criteria 不是合法 JSON：' + e.message); }
      return validate(type, parsed, name);
    }

    if (type === 'noul') {
      const t = box.querySelector('.noul-inp[data-noul-key="true"]').value.trim();
      const f = box.querySelector('.noul-inp[data-noul-key="false"]').value.trim();
      if (!t && !f) return undefined;
      return { true: t, false: f };
    }
    if (type === 'choice') {
      const obj = {};
      const seen = {};
      const rows = box.querySelectorAll('.opt-row');
      if (!rows.length) throw new Error('问题 "' + name + '"（choice）至少需要一个选项');
      rows.forEach((row) => {
        const optName = row.querySelector('.opt-name').value.trim();
        if (!optName) throw new Error('问题 "' + name + '"（choice）存在没有选项名的行');
        if (seen[optName]) throw new Error('问题 "' + name + '"（choice）选项名重复：' + optName);
        seen[optName] = true;
        obj[optName] = row.querySelector('.opt-desc').value.trim();
      });
      return validate('choice', obj, name);
    }
    if (type === 'score') {
      const arr = Array.from(box.querySelectorAll('.lvl-row'))
        .map((r) => r.querySelector('.lvl-desc').value.trim());
      return validate('score', arr, name);
    }
    return undefined;
  }

  function validate(type, parsed, name) {
    if (type === 'choice') {
      if (typeof parsed !== 'object' || Array.isArray(parsed) || !Object.keys(parsed).length)
        throw new Error('问题 "' + name + '"：choice 的 criteria 必须是非空 JSON 对象（选项名 → 描述）');
      if (Object.keys(parsed).length > 255)
        throw new Error('问题 "' + name + '"：choice 最多 255 个选项');
      return parsed;
    }
    if (type === 'score') {
      if (!Array.isArray(parsed) || parsed.length < 2 || parsed.length > 10)
        throw new Error('问题 "' + name + '"：score 的 criteria 必须是 2–10 个等级描述组成的 JSON 数组');
      if (parsed.some((v) => typeof v !== 'string' || !v.trim()))
        throw new Error('问题 "' + name + '"：score 存在没有描述的等级');
      return parsed.map((v) => v.trim());
    }
    if (typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('问题 "' + name + '"：noul 的 criteria 必须是 JSON 对象，例如 { "true": "…", "false": "…" }');
    return parsed;
  }

  /* ---------- 添加 / 载入问题 ---------- */
  function addQuestion(q) {
    const id = 'q' + (++qSeq);
    const el = document.createElement('div');
    el.className = 'q';
    el.dataset.qid = id;
    el.innerHTML = `
      <div class="q-head-wrap">
        <button type="button" class="q-head" aria-expanded="true">
          <span class="q-grip" title="拖拽排序" aria-hidden="true">⠿</span>
          <span class="q-type-badge noul">noul</span>
          <span class="q-title">未命名问题</span>
          <span class="q-chevron" aria-hidden="true">▼</span>
        </button>
        <button type="button" class="q-del" title="删除问题" aria-label="删除问题">×</button>
      </div>
      <div class="q-body">
        <div class="q-top">
          <label class="sr-only" for="qt-${id}">问题类型</label>
          <select data-f="type" id="qt-${id}">
            <option value="choice">choice · 单选题</option>
            <option value="score">score · 打分题</option>
            <option value="noul">noul · 判断题</option>
          </select>
          <label class="sr-only" for="qn-${id}">问题名称</label>
          <input type="text" data-f="name" id="qn-${id}" placeholder="问题名称（如 部门）" />
        </div>
        <label class="sr-only" for="qi-${id}">instructions</label>
        <input type="text" data-f="instructions" id="qi-${id}" placeholder="instructions：要问的问题，措辞尽量直接" />
        <div class="q-crit"></div>
        <p class="q-tip field-tip" style="margin:0"></p>
      </div>
    `;
    listEl.appendChild(el);

    el.querySelector('[data-f="type"]').value = q.type || 'noul';
    el.querySelector('[data-f="name"]').value = q.name || ('问题' + qSeq);
    el.querySelector('[data-f="instructions"]').value = q.instructions || '';

    if (q.criteriaFrom) el.dataset.criteriaFrom = q.criteriaFrom;

    // 折叠 / 展开
    el.querySelector('.q-head').addEventListener('click', (e) => {
      if (e.target.closest('.q-grip')) return;
      const collapsed = el.classList.toggle('collapsed');
      el.querySelector('.q-head').setAttribute('aria-expanded', String(!collapsed));
    });

    // 拖拽排序：只在按住把手时才可拖
    const grip = el.querySelector('.q-grip');
    grip.addEventListener('mousedown', () => { el.draggable = true; });
    el.addEventListener('dragstart', (e) => {
      dragEl = el;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', id); } catch (_) {}
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      el.draggable = false;
      document.querySelectorAll('.q.drop-target').forEach((n) => n.classList.remove('drop-target'));
      dragEl = null;
    });

    el.querySelector('.q-del').onclick = () => {
      const parent = el.parentNode;
      if (!parent) return;             /* 已不在文档里（重复点）：没有再删一次的道理 */
      const gen = listGen;             /* 记下这一代列表，撤销时用它判断列表是否已被重建 */
      const next = el.nextSibling;     /* 原位恢复锚点：null 表示它是最后一条（撤销时 append 回去） */
      const name = el.querySelector('[data-f="name"]').value.trim() || '未命名问题';
      el.remove();
      /* 撤销：插回同一个活节点（不是 clone）—— 里面的输入值、事件监听、
       * q-crit 结构与 dataset 全都还在，撤销后可以继续编辑。 */
      undoToast('已删除问题「' + name + '」', () => {
        /* 与 state 字段同一条不变量：撤销窗口里若 Questions.clear()/restoreAll()
         * 重建过列表（例如再点一次预设），这条问题已经回来了；
         * 旧节点再插一次就是重名问题，buildQuestions 会抛「问题 id 重复」。代际变了就不插。 */
        if (gen !== listGen) return;
        if (next && next.parentNode === parent) parent.insertBefore(el, next);
        else parent.appendChild(el);
      });
    };
    el.querySelector('[data-f="type"]').onchange = () => syncCriteria(el, true);
    el.querySelector('[data-f="name"]').addEventListener('input', () => refreshQHead(el));

    syncCriteria(el, false, q.criteria);

    if (q.criteriaFrom === 'refs' && q._refCount != null) {
      el.querySelector('.q-tip').textContent =
        '已从 state 的快照中自动解析出 ' + q._refCount + ' 个 ref。修改 state 后发送时会自动重新解析。';
    }
    refreshQHead(el);
    return el;
  }

  /* 拖拽排序 */
  let dragEl = null;
  function initDragAndDrop() {
    listEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!dragEl) return;
      const after = getDragAfterElement(listEl, e.clientY);
      document.querySelectorAll('.q.drop-target').forEach((n) => n.classList.remove('drop-target'));
      if (after == null) listEl.appendChild(dragEl);
      else { after.classList.add('drop-target'); listEl.insertBefore(dragEl, after); }
    });
  }

  function getDragAfterElement(container, y) {
    const els = [...container.querySelectorAll('.q:not(.dragging)')];
    return els.reduce((closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) return { offset: offset, element: child };
      return closest;
    }, { offset: Number.NEGATIVE_INFINITY }).element;
  }

  /* 用当前 state 里的快照，重新解析所有 ref 类问题 */
  function reparseRefs(silent, snapshotText) {
    const refs = parseSnapshotRefs(snapshotText);
    const rows = Array.from(listEl.querySelectorAll('.q'))
      .filter((el) => el.dataset.criteriaFrom === 'refs');

    if (!rows.length) {
      if (!silent) toast('当前没有需要解析 ref 的问题');
      return 0;
    }
    if (!refs.length) {
      if (!silent) toast('未在 state 的快照中找到任何 ref（需形如 [ref=e16]）');
      return 0;
    }

    const criteria = buildRefCriteria(snapshotText);
    rows.forEach((el) => {
      renderCriteriaValue(el, 'choice', criteria);
      el.querySelector('.q-tip').textContent =
        '已从 state 的快照中自动解析出 ' + refs.length + ' 项。修改 state 后发送时会自动重新解析。';
    });

    if (!silent) toast('已解析出 ' + refs.length + ' 个 ref');
    return refs.length;
  }

  /* 收集全部问题（严格校验） */
  function buildQuestions() {
    const questions = {};
    const rows = listEl.querySelectorAll('.q');
    if (!rows.length) throw new Error('至少需要一个问题（questions）');

    rows.forEach((el) => {
      const type = el.querySelector('[data-f="type"]').value;
      const name = el.querySelector('[data-f="name"]').value.trim();
      const instructions = el.querySelector('[data-f="instructions"]').value.trim();

      if (!name) throw new Error('每个问题都需要一个 id（questions 的键名）');
      if (questions[name]) throw new Error('问题 id 重复：' + name);
      if (!instructions) throw new Error('问题 "' + name + '" 缺少 instructions');

      const q = { type: type, instructions: instructions };
      const crit = collectCriteria(el, name);
      if (crit !== undefined) q.criteria = crit;
      questions[name] = q;
    });
    return questions;
  }

  /* ---------- 保存 / 恢复（宽松导出，半成品也不报错） ---------- */
  function exportAll() {
    return Array.from(listEl.querySelectorAll('.q')).map((el) => {
      const type = el.querySelector('[data-f="type"]').value;
      const name = el.querySelector('[data-f="name"]').value.trim();
      const instructions = el.querySelector('[data-f="instructions"]').value.trim();
      const box = el.querySelector('.q-crit');
      let criteria = null;

      if (el.dataset.criteria) {
        try { criteria = JSON.parse(el.dataset.criteria); } catch (_) { criteria = null; }
      } else {
        const ta = box.querySelector('textarea.crit-ta');
        if (ta) {
          criteria = ta.value;   // 未写完的 JSON 以文本形式保存
        } else if (type === 'noul') {
          const t = box.querySelector('.noul-inp[data-noul-key="true"]').value.trim();
          const f = box.querySelector('.noul-inp[data-noul-key="false"]').value.trim();
          if (t || f) criteria = { true: t, false: f };
        } else if (type === 'choice') {
          const obj = {};
          box.querySelectorAll('.opt-row').forEach((row) => {
            const k = row.querySelector('.opt-name').value.trim();
            if (k) obj[k] = row.querySelector('.opt-desc').value.trim();
          });
          if (Object.keys(obj).length) criteria = obj;
        } else if (type === 'score') {
          const arr = Array.from(box.querySelectorAll('.lvl-row'))
            .map((r) => r.querySelector('.lvl-desc').value.trim());
          if (arr.length) criteria = arr;
        }
      }
      return { type: type, name: name, instructions: instructions, criteria: criteria };
    }).filter((q) => q.name || q.instructions);
  }

  function restoreAll(list) {
    clear();
    (Array.isArray(list) ? list : []).forEach((q) => {
      if (!q || typeof q !== 'object') return;
      const type = (q.type === 'choice' || q.type === 'score' || q.type === 'noul') ? q.type : 'noul';
      addQuestion({
        type: type,
        name: String(q.name || '').slice(0, 120) || ('问题' + (qSeq + 1)),
        instructions: String(q.instructions || ''),
        criteria: (q.criteria === null || q.criteria === undefined) ? undefined : q.criteria
      });
    });
  }

  return {
    addQuestion: addQuestion,
    initDragAndDrop: initDragAndDrop,
    reparseRefs: reparseRefs,
    buildQuestions: buildQuestions,
    syncCriteria: syncCriteria,
    renderCriteriaValue: renderCriteriaValue,
    exportAll: exportAll,
    restoreAll: restoreAll,
    clear: () => { listEl.innerHTML = ''; qSeq = 0; listGen++; },
    count: () => listEl.querySelectorAll('.q').length,
    collapseAll: () => listEl.querySelectorAll('.q').forEach((c) => {
      c.classList.add('collapsed');
      c.querySelector('.q-head').setAttribute('aria-expanded', 'false');
    })
  };
})();
