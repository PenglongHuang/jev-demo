/* E2E 本地 oracle：高保真模拟 System One 协议 + OpenAI 兼容生成模型。
 * oracle 不硬编码步骤序号 —— 它解析前端真实构造的 state（任务目标 / 页面快照 /
 * 已完成步骤）做决策，并逐请求校验问题构造契约（违规记入 report，E2E 末尾硬断言）。
 * 供 tests/e2e/run.js 以 E2E_UPSTREAM=mock 模式使用；有真实 key 时可切
 * E2E_UPSTREAM=real 完全绕开本文件。 */
'use strict';

const http = require('http');

function startMocks() {
  const violations = [];
  const llmCalls = [];
  const decisions = [];
  let reqCount = 0;

  /* ---- 从快照行提取信息 ---- */
  const refOf = (line) => {
    const m = String(line).match(/\[ref=([A-Za-z0-9_-]+)\]/);
    return m ? m[1] : null;
  };
  function findRefAfterLine(snapshot, lineMatcher, buttonName) {
    const lines = snapshot.split('\n');
    const at = lines.findIndex((l) => lineMatcher.test(l));
    if (at === -1) return null;
    for (let i = at; i < lines.length && i <= at + 14; i++) {
      if (lines[i].includes('- button "' + buttonName + '"')) {
        const r = refOf(lines[i]);
        if (r) return r;
      }
    }
    return null;
  }
  const listitemCount = (snapshot) => (snapshot.match(/- '?listitem "邮件/g) || []).length;
  /* 注意：元素获得焦点后行内会插入 [active] 等属性 token（实测
   * `- searchbox "搜索邮件" [active] [ref=e4]: 值`），正则须容忍任意属性段 */
  const searchValue = (snapshot) => {
    const m = snapshot.match(/- searchbox "搜索邮件" (?:\[[^\]]+\] )*\[ref=[^\]]+\]: ?(.*)$/m);
    return m ? m[1].trim() : '';
  };
  const searchRef = (snapshot) => {
    const m = snapshot.match(/- searchbox "搜索邮件" (?:\[[^\]]+\] )*\[ref=([A-Za-z0-9_-]+)\]/);
    return m ? m[1] : null;
  };

  /* oracle 的「没找到目标元素」兜底动作。
   * 这里**不能**返回「放弃」：脚本场景里这一支通常只意味着快照还没到位（页面尚未渲染完
   * 或上一个场景的浏览器没收拾干净），放弃会把一次可自愈的等待变成整轮 giveup
   * （实测：S2 因此在 mock 侧直接终止）—— 这条教训后来直接把「放弃」从动作集里拔掉了。
   * 也不能用「无操作」—— 它更早下线。tab-list 是唯一满足条件的替代：真实动作、
   * 不需要 ref 也不需要文本、对页面零副作用，跑一步就能拿到新快照再判一次。 */
  const RE_OBSERVE = { action: 'tab-list', unfinished: 1 };

  /* ---- 决策 oracle ---- */
  function decide(state) {
    const goal = String(state['任务目标'] || '');
    const snapshot = String(state['页面快照'] || '');
    const archived = /已归档 (\d+) 封/.exec(snapshot);

    /* 弹窗步：快照被换成阻塞说明文本（auto-core DIALOG_SNAPSHOT_NOTE），只剩一道动作题 */
    if (snapshot.includes('原生对话框')) return { action: 'dialog-accept', unfinished: 0 };

    /* 哨兵标签回归（S7）：动作不需要元素（dialog-dismiss）时仍回「其他」（REF_MORE）。
     * 前端必须把参数归一为空并**重算标签** —— 否则时间线上会留下「dialog-dismiss【其他 ·
     * 展开下一批】」，读起来像真的在展开候选批次。第二轮收尾。 */
    if (goal.includes('哨兵标签回归')) {
      const hist = JSON.stringify(state['已完成步骤'] || []);
      if (/dialog-dismiss/.test(hist)) return { action: '任务已完成', unfinished: 0 };
      return { action: 'dialog-dismiss', ref: '其他', unfinished: 1 };
    }

    if (goal.includes('删除')) {
      const gone = !/listitem "邮件[^"]*8 月电子对账单/.test(snapshot);
      if (gone && /已删除 1 封/.test(snapshot)) return { action: '任务已完成', unfinished: 0 };
      const r = findRefAfterLine(snapshot, /8 月电子对账单/, '删除');
      if (r) return { action: 'click', ref: r, unfinished: 1 };
      return RE_OBSERVE;
    }

    if (goal.includes('搜索')) {
      const val = searchValue(snapshot);
      const n = listitemCount(snapshot);
      if (val && n <= 5) return { action: '任务已完成', unfinished: 0 };
      const sb = searchRef(snapshot);
      if (sb) return { action: '生成输入', ref: sb, unfinished: 1 };
      return RE_OBSERVE;
    }

    if (goal.includes('所有邮件')) {
      const r = findRefAfterLine(snapshot, /- listitem "邮件/, '归档');
      if (r) return { action: 'click', ref: r, unfinished: 1 };
      return { action: '任务已完成', unfinished: 0 };
    }

    /* 订单后台（S6）：目标选项已选中 → 完成；否则 select 订单状态下拉框。
     * 文本取值不走这里 —— select 落定后前端会发单道「文本」补问，见 decideText。 */
    if (goal.includes('订单状态')) {
      if (/option "已付款待发货"[^\n]*\[selected\]/.test(snapshot)) return { action: '任务已完成', unfinished: 0 };
      const m = snapshot.match(/- combobox "订单状态" (?:\[[^\]]+\] )*\[ref=([A-Za-z0-9_-]+)\]/);
      if (m) return { action: 'select', ref: m[1], unfinished: 1 };
      return RE_OBSERVE;
    }

    /* 默认：归档 9 月对账单场景 */
    const gone = !/listitem "邮件[^"]*9 月电子对账单/.test(snapshot);
    if (gone && archived && Number(archived[1]) >= 1) return { action: '任务已完成', unfinished: 0 };
    const r = findRefAfterLine(snapshot, /9 月电子对账单/, '归档');
    if (r) return { action: 'click', ref: r, unfinished: 1 };
    return RE_OBSERVE;
  }

  /* 文本补问 oracle：目标里的「选择「xxx」」即应选定的取值（S6 → 已付款待发货）。
   * 候选是前端从下拉框真实选项构造的 —— 答案不在候选内会被 checkContract 记违规，
   * 这就是「候选构造正确性」的 E2E 断言面。 */
  function decideText(state) {
    const m = String(state['任务目标'] || '').match(/选择「([^」]+)」/);
    return m ? m[1] : null;
  }

  /* ---- System One 响应组装（严格按 output.js 消费的形状） ----
   * 按请求实际携带的题名作答：首轮 3 道（动作/参数/未完成），补问 1 道
   * （参数批次 / 动作冲突 / 文本）—— 前端问什么答什么，不硬塞不存在的题。 */
  function sysoneRes(body, d) {
    const q = body.questions || {};
    const probs = (hit, others) => {
      const o = { [hit]: 0.87 };
      (others || []).forEach((k, i) => { o[k] = 0.04 + i * 0.01; });
      return o;
    };
    const answers = {};
    if (q['动作']) {
      answers['动作'] = { type: 'choice', choice: d.action, probabilities: probs(d.action, ['click', 'fill', 'press']), confidence: 0.82 };
    }
    if (q['参数']) {
      /* 剧本动作带 ref 才答参数题：候选里只有真实 ref（「无需元素」已下线），
       * 不作用于元素的动作（goto/press/终止…）不答，parseDecision 容忍缺失。
       * 目标 ref 不在本题候选里时（并行召回的批次只含页面后半段）就答该批第一个候选 ——
       * 真机上模型也只能在候选里选，冒充「批外作答」会让 choiceInBatch 这类断言失去意义 */
      if (d.ref) {
        const crit = Object.keys(q['参数'].criteria || {});
        const hit = crit.includes(d.ref) ? d.ref : crit[0];
        if (hit) {
          const other = crit.find((k) => k !== hit);
          answers['参数'] = { type: 'choice', choice: hit, probabilities: probs(hit, other ? [other] : []), confidence: 0.78 };
        }
      }
    }
    if (q['文本']) {
      const others = Object.keys(q['文本'].criteria || {}).filter((k) => k !== d.text).slice(0, 2);
      answers['文本'] = { type: 'choice', choice: d.text, probabilities: probs(d.text, others), confidence: 0.9 };
    }
    if (q['未完成']) {
      const crit = q['未完成'].criteria || [];
      const legend = {};
      crit.forEach((c, i) => { legend[i] = c; });
      /* 2 级量表：概率只落在 0/1 上，score 就是加权均值（0~1 连续） */
      const probabilities = {};
      probabilities[d.unfinished] = 0.85;
      probabilities[d.unfinished === 0 ? 1 : 0] = 0.15;
      answers['未完成'] = { type: 'score', score: d.unfinished, probabilities, legend };
    }
    return { model: 'mock-jev', answers, usage: { input_tokens: 4200, output_tokens: 96 } };
  }

  /* ---- 逐请求契约校验（前端构造质量 = E2E 断言面） ---- */
  function checkContract(body) {
    const v = [];
    const q = body.questions || {};
    const names = Object.keys(q);
    /* 单题补问是合法形态，三条路径各一种：
     *   仅「参数」——候选裁剪展开下一批（Jev 选了「其他」）
     *   仅「动作」——动作与元素角色不兼容，重问动作（Agent 侧 checkActionRole 拦下的）
     *   仅「文本」——动作+参数落定后的取值补问（select 选项名 / press 键名 / 变量池） */
    if (names.length === 1 && ['参数', '动作', '文本'].includes(names[0])) {
      const crit = Object.keys((q[names[0]] || {}).criteria || {});
      if (!crit.length) v.push('单题补问的候选为空：' + names[0]);
      /* 并行召回的批次（默认算法）：候选必须是真 ref、必须 ≤ 250、且不得出现「其他」——
       * 这条路线没有兜底项，候选就是召回结果；措辞里也要说明只在本批内排序 */
      if (names[0] === '参数') {
        const snap = String((body.state || {})['页面快照'] || '');
        const known = new Set((snap.match(/\[ref=([A-Za-z0-9_-]+)\]/g) || []).map((s) => s.slice(5, -1)));
        crit.forEach((k) => { if (!known.has(k)) v.push('召回批次候选 ' + k + ' 不在快照 ref 集合内'); });
        if (crit.includes('其他')) v.push('并行召回的候选里不得出现「其他」兜底项');
        if (crit.length > 250) v.push('召回批次候选数 ' + crit.length + ' 超过接口 255 上限');
        const inst = String((q[names[0]] || {}).instructions || '');
        if (/不需要判断目标是否在本批中/.test(inst)) {
          if (!/第 \d+\/\d+ 批/.test(inst)) v.push('召回批次 instructions 没写清是第几批');
        }
      }
      return v;
    }
    if (names.length !== 3 || !['动作', '参数', '未完成'].every((n) => names.includes(n))) {
      v.push('问题不是固定 3 道：' + names.join(','));
      return v;
    }
    const acts = Object.keys(q['动作'].criteria || {});
    if (acts.length !== 21) v.push('动作候选数=' + acts.length + '（应为 21：19 浏览器 + 1 工程 + 1 终止）');
    ['生成输入', '任务已完成'].forEach((k) => {
      if (!acts.includes(k)) v.push('动作缺少 ' + k);
    });
    /* 「无操作」已下线（空转出口导致模型 fill 完干等），任何形态回潮都算违约 */
    if (acts.includes('无操作')) v.push('动作候选里不得再出现「无操作」');
    /* 「放弃」同样已下线：模型随时可选的免死金牌，会把可自愈的卡壳变成整轮终止 */
    if (acts.includes('放弃')) v.push('动作候选里不得再出现「放弃」');
    if (q['参数'].type !== 'choice') v.push('参数不是 choice');
    if (q['未完成'].type !== 'score' || (q['未完成'].criteria || []).length !== 2) v.push('未完成应为 2 级 score');

    const state = body.state || {};
    const snapshot = String(state['页面快照'] || '');
    if (!snapshot.includes('[ref=')) v.push('state.页面快照 为空或没有 ref');
    if (!String(state['任务目标'] || '').trim()) v.push('state.任务目标 为空');
    if (!Array.isArray(state['已完成步骤'])) v.push('state.已完成步骤 不是数组');
    if (state['上一步结果'] == null) v.push('state.上一步结果 缺失');

    /* 参数覆盖按是否裁剪分档：候选被折叠（含「其他」或数量少于快照 ref 总数）时
     * 只查「给出的候选都真实存在」，反向全覆盖只在未裁剪时成立 ——
     * 订单页 392 refs 会被裁到首批 80，双向断言必爆假违规 */
    const params = Object.keys(q['参数'].criteria || {});
    const snapRefs = new Set((snapshot.match(/\[ref=([A-Za-z0-9_-]+)\]/g) || []).map((s) => s.slice(5, -1)));
    const trimmed = params.includes('其他') || params.length < snapRefs.size;
    params.forEach((k) => {
      if (k === '其他') return;
      if (!snapRefs.has(k)) v.push('参数候选 ' + k + ' 不在快照 ref 集合内');
    });
    if (!trimmed) {
      snapRefs.forEach((r) => {
        if (!params.includes(r)) v.push('快照 ref ' + r + ' 未出现在参数候选中');
      });
    }
    return v.slice(0, 6);
  }

  /* ---- System One mock ---- */
  const sysone = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/__report') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ reqCount, violations, llmCalls, decisions }));
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      reqCount++;
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch (_) { payload = null; }
      if (!payload || !payload.state || !payload.questions) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'mock: 请求缺少 state/questions' } }));
      }
      checkContract(payload).forEach((x) => violations.push('#' + reqCount + ' ' + x));
      const state = typeof payload.state === 'string' ? JSON.parse(payload.state) : payload.state;
      const d = decide(state);
      const qnames = Object.keys(payload.questions || {});
      /* 单道「文本」补问：oracle 从任务目标取应选值，并校验它确实在候选里 ——
       * 候选是前端从下拉框选项/键名/变量池构造的，答案落不进去就是构造 bug */
      if (qnames.length === 1 && qnames[0] === '文本') {
        d.text = decideText(state);
        const crit = Object.keys((payload.questions['文本'] || {}).criteria || {});
        if (d.text == null) {
          violations.push('#' + reqCount + ' 文本补问 oracle 未从任务目标解析出取值');
        } else if (!crit.includes(d.text)) {
          violations.push('#' + reqCount + ' 文本答案「' + d.text + '」不在候选内（候选构造错误）：' + crit.slice(0, 8).join(','));
        }
      }
      decisions.push({
        n: reqCount,
        goal: String(state['任务目标'] || '').slice(0, 24),
        val: searchValue(String(state['页面快照'] || '')),
        items: listitemCount(String(state['页面快照'] || '')),
        archived: (/已归档 (\d+) 封/.exec(String(state['页面快照'] || '')) || [])[1] || '0',
        action: d.action, ref: d.ref || null, text: d.text || null,
      });
      const out = sysoneRes(payload, d);
      out._oracle = d;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });

  /* ---- OpenAI 兼容生成模型 mock ---- */
  const llm = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let p = null;
      try { p = JSON.parse(body || '{}'); } catch (_) { /* ignore */ }
      llmCalls.push({ model: p && p.model, prompt: p && p.messages, auth: req.headers.authorization || '' });
      const content = '招商银行';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-e2e', object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 88, completion_tokens: 4, total_tokens: 92 },
      }));
    });
  });

  return new Promise((resolve) => {
    sysone.listen(0, '127.0.0.1', () => {
      llm.listen(0, '127.0.0.1', () => {
        resolve({
          sysonePort: sysone.address().port,
          llmPort: llm.address().port,
          report: async () => {
            const r = await fetch('http://127.0.0.1:' + sysone.address().port + '/__report');
            return r.json();
          },
          close: () => { sysone.close(); llm.close(); },
        });
      });
    });
  });
}

module.exports = { startMocks };
