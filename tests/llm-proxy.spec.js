/* /api/llm 透传代理测试：起真实 server.js 子进程 + 本机 mock OpenAI 兼容上游 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { startServer } = require('./helpers/server.js');

/* ---------------- 本机 mock 上游（OpenAI 兼容 /chat/completions） ---------------- */
function startMock() {
  const received = [];
  let mode = 'ok'; // ok | fail500
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url.endsWith('/chat/completions') && mode === 'ok') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-mock', object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: '招商银行' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 21, completion_tokens: 4, total_tokens: 25 },
        }));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'mock upstream down' } }));
      }
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, received, setMode: (m) => { mode = m; }, port: srv.address().port }));
  });
}

/* ---------------- 起真实 server.js ---------------- */

test('POST /api/llm：校验、透传、错误映射', async (t) => {
  const mock = await startMock();
  const srv = await startServer();
  await srv.wait();
  t.after(() => { srv.child.kill(); mock.srv.close(); });

  const url = (p) => srv.base + p;
  const headers = (base, key) => ({ 'Content-Type': 'application/json', 'X-Llm-Base': base, 'X-Llm-Key': key });
  const body = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], temperature: 0.3, max_tokens: 200 };

  /* 1. base 非 https 且非 localhost → 400 */
  let r = await fetch(url('/api/llm'), { method: 'POST', headers: headers('http://192.168.1.5:8000', 'sk-x'), body: JSON.stringify(body) });
  assert.strictEqual(r.status, 400);
  assert.match((await r.json()).error.message, /https|localhost/);

  /* 1b. URL 解析级绕过一律拒绝（前缀正则时代的老洞） */
  for (const bad of [
    'http://localhost@evil.com/v1',
    'http://127.0.0.1:8080@evil.com',
    'http://127.0.0.1.evil.com/x',
    'http://127.0.0.1@192.168.1.1:8080/admin',
    'https://user:pass@api.example.com/v1',
    'ftp://example.com/v1',
  ]) {
    r = await fetch(url('/api/llm'), { method: 'POST', headers: headers(bad, 'sk-x'), body: JSON.stringify(body) });
    assert.strictEqual(r.status, 400, '应拒绝 ' + bad);
  }

  /* 1c. 自定义 Jev 上游：无页面 Key 时不放行自定义地址（防服务端 env Key 外送到任意 URL） */
  {
    /* 起一个带 env Key 的实例才能命中该分支 */
    const srv2 = startServer(30000, { TYPESAFE_API_KEY: 'sk-operator-secret' });
    t.after(() => srv2.child.kill());
    await srv2.wait();
    const r2 = await fetch(srv2.base + '/api/systemone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Endpoint': 'https://collector.example.com/v1/systemone' },
      body: JSON.stringify({ state: 'x', questions: { a: { type: 'noul', name: 'a', instructions: 'i' } } }),
    });
    assert.strictEqual(r2.status, 403);
    assert.match((await r2.json()).error.message, /自定义接口/);
  }

  /* 2. 缺 key / 缺 model / 缺 messages → 400 */
  r = await fetch(url('/api/llm'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Llm-Base': 'http://localhost:' + mock.port + '/v1' }, body: JSON.stringify(body) });
  assert.strictEqual(r.status, 400);
  r = await fetch(url('/api/llm'), { method: 'POST', headers: headers('http://localhost:' + mock.port + '/v1', 'sk-x'), body: JSON.stringify({ messages: [] }) });
  assert.strictEqual(r.status, 400);
  r = await fetch(url('/api/llm'), { method: 'POST', headers: headers('http://localhost:' + mock.port + '/v1', 'sk-x'), body: JSON.stringify({ model: 'm' }) });
  assert.strictEqual(r.status, 400);

  /* 3. 正常透传：URL 拼接 /chat/completions、Authorization、白名单四字段、响应原样 + _latency_ms */
  r = await fetch(url('/api/llm'), {
    method: 'POST',
    headers: headers('http://localhost:' + mock.port + '/v1', 'sk-test-key'),
    body: JSON.stringify(Object.assign({}, body, { stream: true, extra: 'should-be-stripped' })),
  });
  assert.strictEqual(r.status, 200);
  const data = await r.json();
  assert.strictEqual(data.choices[0].message.content, '招商银行');
  assert.ok(typeof data._latency_ms === 'number');

  assert.strictEqual(mock.received.length, 1);
  const seen = mock.received[0];
  assert.strictEqual(seen.method, 'POST');
  assert.strictEqual(seen.url, '/v1/chat/completions');
  assert.strictEqual(seen.headers.authorization, 'Bearer sk-test-key');
  const seenBody = JSON.parse(seen.body);
  assert.deepStrictEqual(Object.keys(seenBody).sort(), ['max_tokens', 'messages', 'model', 'temperature']);
  assert.strictEqual(seenBody.messages[0].content, 'hi');

  /* 4. base 已带 /chat/completions 时不重复拼接 */
  await fetch(url('/api/llm'), {
    method: 'POST',
    headers: headers('http://localhost:' + mock.port + '/v1/chat/completions', 'sk-test-key'),
    body: JSON.stringify(body),
  });
  assert.strictEqual(mock.received[mock.received.length - 1].url, '/v1/chat/completions');

  /* 5. 上游 500 → {error:{message, upstream}} */
  mock.setMode('fail500');
  r = await fetch(url('/api/llm'), { method: 'POST', headers: headers('http://localhost:' + mock.port + '/v1', 'sk-test-key'), body: JSON.stringify(body) });
  const errData = await r.json();
  assert.strictEqual(r.status, 500);
  assert.match(errData.error.message, /mock upstream down/);
  assert.ok(errData.error.upstream.includes('/v1/chat/completions'));

  /* 6. health 带 browserDetail（playwright-cli 已装的机器上 available=true） */
  r = await fetch(url('/api/health'));
  const h = await r.json();
  assert.ok(h.ok);
  assert.ok(h.browserDetail && typeof h.browserDetail.available === 'boolean');
  if (h.browserDetail.available) assert.match(h.browserDetail.version, /\d+\.\d+\.\d+/);
});
