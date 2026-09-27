/* 会话记录清理 API（条目 8 · 服务端半边）。
 * DELETE /api/runs?before=<ISO8601> → { ok:true, deleted:N }
 * 契约见 server.js 里 handleRuns 上方的注释块。
 * 起真实 server.js 子进程、直打本机端口 —— 与 tests/runs-api.spec.js 同一套模式。 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

function startServer() {
  const port = 30000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(port) }),
    stdio: 'ignore', windowsHide: true,
  });
  const base = 'http://127.0.0.1:' + port;
  const wait = async () => {
    for (let i = 0; i < 150; i++) {
      try { const r = await fetch(base + '/api/health'); if (r.ok) return base; }
      catch (_) { /* 未监听 */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('server 未就绪');
  };
  return { child, base, wait };
}

const req = (base, method, p, body) => fetch(base + p, {
  method, headers: body ? { 'Content-Type': 'application/json' } : {},
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

const rec = (id, startedAt) => ({
  meta: { id, goal: 'g', endState: 'done', stepCount: 1, startedAt, endedAt: startedAt },
  steps: [{ n: 1, label: 'l' }],
});

test('DELETE /api/runs?before= 只删更早的记录；缺参 / 非法参 400 且不删任何东西', async () => {
  const srv = await startServer();
  const ids = ['r-0101-0101-r001', 'r-0101-0101-r002', 'r-0101-0101-r003'];
  try {
    await srv.wait();
    await req(srv.base, 'PUT', '/api/runs/' + ids[0], rec(ids[0], '2026-01-01T00:00:00Z'));
    await req(srv.base, 'PUT', '/api/runs/' + ids[1], rec(ids[1], '2026-06-01T00:00:00Z'));
    await req(srv.base, 'PUT', '/api/runs/' + ids[2], rec(ids[2], '2026-09-01T00:00:00Z'));

    const has = async (id) => (await req(srv.base, 'GET', '/api/runs/' + id)).status === 200;

    /* 缺 before / 空 before / 非时间 before —— 三种都必须 400，且一条都不能少。
     * 这条是安全护栏：把「参数没解析出来」当成「删全部」是不可接受的。 */
    for (const bad of ['/api/runs', '/api/runs?before=', '/api/runs?before=not-a-date']) {
      const r = await req(srv.base, 'DELETE', bad);
      assert.strictEqual(r.status, 400, bad + ' 应 400，实际 ' + r.status);
      assert.ok(/before/.test(r.data.error.message), '错误信息要提到 before：' + r.data.error.message);
      assert.ok(await has(ids[0]) && await has(ids[1]) && await has(ids[2]),
        bad + ' 之后一条都不该少');
    }

    /* 正常清理：只删 2026-07-01 之前的两条 */
    const del = await req(srv.base, 'DELETE', '/api/runs?before=2026-07-01T00:00:00Z');
    assert.strictEqual(del.status, 200);
    assert.strictEqual(del.data.deleted, 2);
    assert.ok(!(await has(ids[0])), '最早的应被删');
    assert.ok(!(await has(ids[1])), '6 月的应被删');
    assert.ok(await has(ids[2]), '9 月的不该被删');
    const list = await req(srv.base, 'GET', '/api/runs');
    assert.ok(!list.data.runs.some((x) => ids.slice(0, 2).includes(x.id)), '索引里也不该残留');

    /* 幂等：再清一次同一边界，deleted 应该是 0 而不是报错 */
    const again = await req(srv.base, 'DELETE', '/api/runs?before=2026-07-01T00:00:00Z');
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.data.deleted, 0);
  } finally {
    for (const id of ids) await req(srv.base, 'DELETE', '/api/runs/' + id).catch(() => {});
    srv.child.kill();
  }
});
