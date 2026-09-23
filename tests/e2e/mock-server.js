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

  /* ---- 决策 oracle ---- */
  function decide(state) {
    const goal = String(state['任务目标'] || '');
    const snapshot = String(state['页面快照'] || '');
    const archived = /已归档 (\d+) 封/.exec(snapshot);

    if (goal.includes('搜索')) {
      const val = searchValue(snapshot);
      const n = listitemCount(snapshot);
      if (val && n <= 5) return { action: '任务已完成', unfinished: 0 };
      const sb = searchRef(snapshot);
      if (sb) return { action: '生成输入', ref: sb, unfinished: 3 };
      return { action: '无操作', unfinished: 3 };
    }

    if (goal.includes('所有邮件')) {
      const r = findRefAfterLine(snapshot, /- listitem "邮件/, '归档');
      if (r) return { action: 'click', ref: r, unfinished: 4 };
      return { action: '任务已完成', unfinished: 0 };
    }

    /* 默认：归档 9 月对账单场景 */
    const gone = !/listitem "邮件[^"]*9 月电子对账单/.test(snapshot);
    if (gone && archived && Number(archived[1]) >= 1) return { action: '任务已完成', unfinished: 0 };
    const r = findRefAfterLine(snapshot, /9 月电子对账单/, '归档');
    if (r) return { action: 'click', ref: r, unfinished: 3 };
    return { action: '无操作', unfinished: 3 };
  }

  /* ---- System One 响应组装（严格按 output.js 消费的形状） ---- */
  function sysoneRes(body, d) {
    const q = body.questions || {};
    const probs = (hit, others) => {
      const o = { [hit]: 0.87 };
      (others || []).forEach((k, i) => { o[k] = 0.04 + i * 0.01; });
      return o;
    };
    const answers = {
      动作: { type: 'choice', choice: d.action, probabilities: probs(d.action, ['无操作', 'click', 'fill']), confidence: 0.82 },
      参数: { type: 'choice', choice: d.ref || '无需元素', probabilities: probs(d.ref || '无需元素', ['无需元素']), confidence: 0.78 },
      文本: { type: 'choice', choice: '无', probabilities: { 无: 0.95, 招商银行: 0.05 }, confidence: 0.9 },
      未完成: (() => {
        const crit = q['未完成'] && q['未完成'].criteria || [];
        const legend = {};
        crit.forEach((c, i) => { legend[i] = c; });
        const probabilities = {};
        probabilities[d.unfinished] = 0.85;
        probabilities[d.unfinished === 0 ? 1 : 0] = 0.1;
        probabilities[2] = 0.05;
        return { type: 'score', score: d.unfinished, probabilities, legend };
      })(),
    };
    return { model: 'mock-jev', answers, usage: { input_tokens: 4200, output_tokens: 96 } };
  }

  /* ---- 逐请求契约校验（前端构造质量 = E2E 断言面） ---- */
  function checkContract(body) {
    const v = [];
    const q = body.questions || {};
    const names = Object.keys(q);
    if (names.length !== 4 || !['动作', '参数', '文本', '未完成'].every((n) => names.includes(n))) {
      v.push('问题不是固定 4 道：' + names.join(','));
      return v;
    }
    const acts = Object.keys(q['动作'].criteria || {});
    if (acts.length !== 31) v.push('动作候选数=' + acts.length + '（应为 31：27 浏览器 + 2 工程 + 2 终止）');
    ['生成输入', '无操作', '任务已完成', '放弃'].forEach((k) => {
      if (!acts.includes(k)) v.push('动作缺少 ' + k);
    });
    if (q['参数'].type !== 'choice') v.push('参数不是 choice');
    if (q['未完成'].type !== 'score' || (q['未完成'].criteria || []).length !== 5) v.push('未完成应为 5 级 score');
    if (!(q['文本'].criteria || {})['无']) v.push('文本缺少「无」兜底项');

    const state = body.state || {};
    const snapshot = String(state['页面快照'] || '');
    if (!snapshot.includes('[ref=')) v.push('state.页面快照 为空或没有 ref');
    if (!String(state['任务目标'] || '').trim()) v.push('state.任务目标 为空');
    if (!Array.isArray(state['已完成步骤'])) v.push('state.已完成步骤 不是数组');
    if (state['上一步结果'] == null) v.push('state.上一步结果 缺失');

    const params = Object.keys(q['参数'].criteria || {});
    const snapRefs = new Set((snapshot.match(/\[ref=([A-Za-z0-9_-]+)\]/g) || []).map((s) => s.slice(5, -1)));
    params.forEach((k) => {
      if (k === '无需元素') return;
      if (!snapRefs.has(k)) v.push('参数候选 ' + k + ' 不在快照 ref 集合内');
    });
    snapRefs.forEach((r) => {
      if (!params.includes(r)) v.push('快照 ref ' + r + ' 未出现在参数候选中');
    });
    if (v.length && v.length <= 3) {
      /* 快照很大时 ref 校验可能噪声多，只记前 3 条样本 */
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
      decisions.push({
        n: reqCount,
        goal: String(state['任务目标'] || '').slice(0, 24),
        val: searchValue(String(state['页面快照'] || '')),
        items: listitemCount(String(state['页面快照'] || '')),
        archived: (/已归档 (\d+) 封/.exec(String(state['页面快照'] || '')) || [])[1] || '0',
        action: d.action, ref: d.ref || null,
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
