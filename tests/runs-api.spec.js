/* /api/runs 会话落盘接口测试：起真实 server.js 子进程，直打本机端口 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUNS_DIR = path.join(ROOT, 'data', 'runs');
const AutoCore = require('../public/js/auto-core.js');

function startServer() {
  const port = 30000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(port) }),
    stdio: 'ignore', windowsHide: true,
  });
  const base = 'http://127.0.0.1:' + port;
  const wait = async () => {
    for (let i = 0; i < 50; i++) {
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

const rec = (id, over) => Object.assign({
  meta: { id, goal: '整理邮箱', endState: 'done', stepCount: 1, startedAt: '2026-09-25T11:00:00Z', endedAt: '2026-09-25T11:01:00Z' },
  steps: [{ n: 1, label: 'l', screenshot: 'data:image/png;base64,AAAA' }],
}, over || {});

test('PUT → GET 列表 → GET 全量 → DELETE 全链路；非法 id 拒绝', async () => {
  const srv = await startServer();
  try {
    await srv.wait();
    const id = 'r-0101-0001-t001';
    const put = await req(srv.base, 'PUT', '/api/runs/' + id, rec(id));
    assert.strictEqual(put.status, 200);

    const list = await req(srv.base, 'GET', '/api/runs');
    const item = list.data.runs.find((x) => x.id === id);
    assert.ok(item, '列表里能找到新会话');
    assert.strictEqual(item.goal, '整理邮箱');
    assert.strictEqual(item.stepCount, 1);
    assert.ok(!JSON.stringify(item).includes('base64'), '列表不含截图');

    const full = await req(srv.base, 'GET', '/api/runs/' + id);
    assert.strictEqual(full.data.meta.id, id);
    assert.strictEqual(full.data.steps[0].screenshot.slice(0, 10), 'data:image');

    /* 覆盖写：同 id 再 PUT，stepCount 更新且不产生重复条目 */
    await req(srv.base, 'PUT', '/api/runs/' + id, rec(id, { meta: { id, goal: 'g2', endState: 'running', stepCount: 2, startedAt: '2026-09-25T12:00:00Z' } }));
    const list2 = await req(srv.base, 'GET', '/api/runs');
    assert.strictEqual(list2.data.runs.filter((x) => x.id === id).length, 1);
    assert.strictEqual(list2.data.runs.find((x) => x.id === id).stepCount, 2);

    /* meta.id 与路径不一致 → 400；目录穿越形状 → 400 */
    assert.strictEqual((await req(srv.base, 'PUT', '/api/runs/' + id, rec('r-0101-0001-othr'))).status, 400);
    assert.strictEqual((await req(srv.base, 'GET', '/api/runs/r-0101-0001-T001')).status, 400);
    assert.strictEqual((await req(srv.base, 'GET', '/api/runs/..%2Fws_x')).status, 400);

    const del = await req(srv.base, 'DELETE', '/api/runs/' + id);
    assert.strictEqual(del.status, 200);
    assert.strictEqual((await req(srv.base, 'GET', '/api/runs/' + id)).status, 404);
    assert.ok(!(await req(srv.base, 'GET', '/api/runs')).data.runs.some((x) => x.id === id));
    /* 幂等删除 */
    assert.strictEqual((await req(srv.base, 'DELETE', '/api/runs/' + id)).status, 200);
  } finally {
    srv.child.kill();
  }
});

test('newRunId 生成的 id 能被 server 接受（id 规则单一行为源交叉验证）', async () => {
  const srv = await startServer();
  const id = AutoCore.newRunId();
  try {
    await srv.wait();
    const put = await req(srv.base, 'PUT', '/api/runs/' + id, rec(id));
    assert.strictEqual(put.status, 200);
  } finally {
    await req(srv.base, 'DELETE', '/api/runs/' + id).catch(() => {});
    srv.child.kill();
  }
});

test('索引缺失时从目录重建', async () => {
  fs.mkdirSync(RUNS_DIR, { recursive: true }); /* 本用例自足：不依赖前面用例建过目录 */
  fs.rmSync(path.join(RUNS_DIR, 'index.json'), { force: true });
  const srv = await startServer();
  try {
    await srv.wait();
    fs.writeFileSync(path.join(RUNS_DIR, 'r-0101-0002-t002.json'), JSON.stringify(rec('r-0101-0002-t002')));
    const list = await req(srv.base, 'GET', '/api/runs');
    assert.ok(list.data.runs.some((x) => x.id === 'r-0101-0002-t002'));
  } finally { srv.child.kill(); }
});

test('清理测试产物', async () => {
  ['r-0101-0001-t001', 'r-0101-0002-t002'].forEach((id) => {
    fs.rmSync(path.join(RUNS_DIR, id + '.json'), { force: true });
  });
});
