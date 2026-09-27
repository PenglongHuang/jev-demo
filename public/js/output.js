/* ===================== 输出区：答案 / 原始响应 / 请求体 =====================
 * 概率条按概率降序排列；超过 COLLAPSE_AT 项时折叠，只展示前几项 + 展开按钮。
 */
const Output = (() => {
  const COLOR = { choice: 'var(--violet)', score: 'var(--green)', noul: 'var(--amber)' };
  const COLLAPSE_AT = 8;   // 超过此项数 → 折叠
  const SHOW_WHEN_COLLAPSED = 6;

  let lastQuestions = {};

  function showPane(name) {
    document.querySelectorAll('.tab').forEach((t) => {
      const on = t.dataset.pane === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
  }

  function setTabsEnabled(enabled) {
    document.querySelectorAll('.tab').forEach((t) => {
      if (t.dataset.pane === 'answers') return;
      t.disabled = !enabled;
    });
  }

  function setRawPane(paneId, text) {
    const pane = document.getElementById(paneId);
    pane.innerHTML =
      '<div class="raw-wrap"><button class="copy-btn" type="button">复制</button>' +
      '<pre class="raw">' + escapeHtml(text) + '</pre></div>';
    pane.querySelector('.copy-btn').onclick = (e) => {
      navigator.clipboard.writeText(text).then(() => {
        e.target.textContent = '已复制';
        e.target.classList.add('ok');
        setTimeout(() => { e.target.textContent = '复制'; e.target.classList.remove('ok'); }, 1500);
      }, () => toast('复制失败，请手动选择文本'));
    };
  }

  function showSkeleton() {
    document.getElementById('paneAnswers').innerHTML =
      '<div class="skel-wrap">' +
      '<div class="skel" style="width:30%"></div><div class="skel" style="width:70%"></div>' +
      '<div class="skel" style="width:55%"></div><div class="skel" style="width:85%"></div>' +
      '<div class="skel" style="width:42%"></div><div class="skel" style="width:64%"></div>' +
      '</div>';
    showPane('answers');
  }

  function renderError(msg, detail, title) {
    document.getElementById('paneAnswers').innerHTML =
      '<div class="demo-err" role="alert"><b>' + escapeHtml(title || '请求失败') + '</b><br />' +
      escapeHtml(msg) +
      (detail ? '<br /><br /><span style="font-family:var(--mono);font-size:12px">' + escapeHtml(detail) + '</span>' : '') +
      '</div>';
    setStatus('出错', 'error');
    showPane('answers');
  }

  function resetPane() {
    setTabsEnabled(false);
    document.getElementById('paneAnswers').innerHTML =
      '<div class="out-empty"><div class="big" aria-hidden="true">◇</div>发送后这里会显示结构化答案：<br />选项 / 分值 / 概率分布 / 置信度</div>';
    setStatus('就绪', '');
    showPane('answers');
  }

  function bar(label, p, color, hit) {
    const w = Math.max(0, Math.min(1, p)) * 100;
    return '<div class="bar-row' + (hit ? ' hit' : '') + '">' +
      '<span class="bar-label" title="' + escapeHtml(label) + '">' + escapeHtml(label) + '</span>' +
      '<span class="bar-track"><span class="bar-fill" style="width:0%;background:' + color + '" data-w="' + w + '"></span></span>' +
      '<span class="bar-val">' + pct(p) + '</span>' +
      '</div>';
  }

  /* 概率条动画：先以 0% 插入，下一帧再落到目标宽度 */
  function animateBars(root) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        root.querySelectorAll('.bar-fill[data-w]').forEach((el) => {
          el.style.width = el.dataset.w + '%';
          el.removeAttribute('data-w');
        });
      });
    });
  }

  /* 概率行 HTML：降序排列；超过阈值 → 前 N 项 + 折叠区 + 展开按钮。
   * hitKey 为 null（score）：全部用主题色；choice：命中项主题色、其余灰。 */
  function barsHtml(probs, color, hitKey) {
    const entries = Object.keys(probs)
      .map((k) => ({ k: k, p: probs[k] }))
      .sort((a, b) => b.p - a.p);
    const row = (e) => {
      const hit = hitKey != null && e.k === hitKey;
      return bar(e.k, e.p, hit || hitKey == null ? color : '#cdd1d8', hit);
    };

    if (entries.length <= COLLAPSE_AT) {
      return '<div class="bars">' + entries.map(row).join('') + '</div>';
    }

    const head = entries.slice(0, SHOW_WHEN_COLLAPSED);
    const rest = entries.slice(SHOW_WHEN_COLLAPSED);
    return '<div class="bars">' +
      head.map(row).join('') +
      '<div class="bars-extra">' + rest.map(row).join('') + '</div>' +
      '<button type="button" class="bars-toggle" data-expand="1">展开全部 ' + entries.length + ' 项（还有 ' + rest.length + ' 项）</button>' +
      '</div>';
  }

  function bindBarToggles(pane) {
    pane.querySelectorAll('.bars-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const bars = btn.closest('.bars');
        const expanded = bars.classList.toggle('expanded');
        btn.textContent = expanded ? '收起低概率选项' : '展开全部（还有 ' + bars.querySelectorAll('.bars-extra .bar-row').length + ' 项）';
      });
    });
  }

  function renderAnswers(data) {
    const answers = data.answers || {};
    const usage = data.usage || {};
    const model = data.model || '—';
    const latency = data._latency_ms;

    let html = '<div class="meta">';
    html += '<span class="tag">模型 <b>' + escapeHtml(model) + '</b></span>';
    if (latency != null) html += '<span class="tag">延迟 <b>' + latency + ' ms</b></span>';
    if (usage.input_tokens != null) html += '<span class="tag">输入 <b>' + usage.input_tokens + '</b> tokens</span>';
    if (usage.output_tokens != null) html += '<span class="tag">输出 <b>' + usage.output_tokens + '</b> tokens</span>';
    html += '</div>';

    Object.keys(answers).forEach((key) => {
      const a = answers[key];
      const t = a.type || 'noul';
      const inst = (lastQuestions[key] && lastQuestions[key].instructions) || '';
      const color = COLOR[t] || 'var(--text-2)';

      html += '<div class="ans v-' + t + '">';
      html += '<div class="ans-head"><span class="ans-id">' + escapeHtml(key) + '</span><span class="ans-type">' + escapeHtml(t) + '</span></div>';
      if (inst) html += '<div class="ans-inst">' + escapeHtml(inst) + '</div>';

      if (t === 'choice') {
        html += '<div class="verdict"><span class="main">' + escapeHtml(a.choice) + '</span>';
        html += '<span class="note">命中项</span></div>';
        html += barsHtml(a.probabilities || {}, color, a.choice);
      } else if (t === 'score') {
        html += '<div class="verdict"><span class="main">' + Number(a.score).toFixed(2) + '</span>';
        html += '<span class="note">加权分值（等级下标区间内）</span></div>';
        const legend = a.legend || {};
        const probs = {};
        Object.keys(a.probabilities || {}).forEach((k) => {
          probs[legend[k] != null ? k + ' · ' + legend[k] : k] = a.probabilities[k];
        });
        html += barsHtml(probs, color, null);
      } else {
        const p = Number(a.noul);
        const verdict = p >= 0.5 ? '是' : '否';
        html += '<div class="verdict"><span class="main">' + p.toFixed(3) + '</span>';
        html += '<span class="note">"是"的概率 → <b>' + verdict + '</b>（阈值 0.5）</span></div>';
        html += '<div class="bars">' + bar('是', p, color, p >= 0.5) + bar('否', 1 - p, '#cdd1d8', p < 0.5) + '</div>';
      }

      if (a.confidence != null) {
        html += '<div class="conf-wrap">' +
          '<div class="conf-top"><span>confidence（分布形状，非正确率保证）</span><b>' + Number(a.confidence).toFixed(3) + '</b></div>' +
          '<div class="bar-track"><div class="bar-fill" style="width:0%;background:var(--accent)" data-w="' + Math.max(0, Math.min(1, a.confidence)) * 100 + '"></div></div>' +
          '</div>';
      }

      html += '</div>';
    });

    const pane = document.getElementById('paneAnswers');
    pane.innerHTML = html;
    bindBarToggles(pane);
    animateBars(pane);
  }

  function renderAll(data, payload) {
    lastQuestions = payload.questions;
    renderAnswers(data);
    setRawPane('paneRaw', JSON.stringify({ model: data.model, answers: data.answers, usage: data.usage, _latency_ms: data._latency_ms }, null, 2));
    setRawPane('paneRequest', JSON.stringify(payload, null, 2));
    setTabsEnabled(true);
    setStatus((data.answers ? Object.keys(data.answers).length : 0) + ' 个答案', 'done');
    showPane('answers');
  }

  return {
    showPane: showPane,
    setTabsEnabled: setTabsEnabled,
    showSkeleton: showSkeleton,
    renderError: renderError,
    renderAll: renderAll,
    resetPane: resetPane
  };
})();
