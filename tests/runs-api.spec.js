/* /api/runs 会话落盘接口测试：起真实 server.js 子进程，直打本机端口 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RUNS_DIR = path.join(ROOT, 'data', 'runs');
const AutoCore = require('../public/js/auto-core.js');
const { startServer, req } = require('./helpers/server.js');

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

    /* 幽灵条目自愈：PUT 后绕过 API 直接删文件，GET 单条 404 且索引同步剔除 */
    await req(srv.base, 'PUT', '/api/runs/' + id, rec(id));
    fs.rmSync(path.join(RUNS_DIR, id + '.json'), { force: true });
    assert.strictEqual((await req(srv.base, 'GET', '/api/runs/' + id)).status, 404);
    assert.ok(!(await req(srv.base, 'GET', '/api/runs')).data.runs.some((x) => x.id === id));
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
    /* 确定性互补样本：纯数字后缀也是合法形状（防服务端正则误收紧），
     * 文件不存在应 404 而非 400，不落盘 */
    assert.strictEqual((await req(srv.base, 'GET', '/api/runs/r-0101-0001-0000')).status, 404);
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

test('读取失败但不是「文件没了」→ 503 且**不**剔除索引条目', async () => {
  /* 复现手法：把 <id>.json 换成一个同名目录 → fs.readFile 回 EISDIR
   * （线上等价物是 Windows 索引器/杀软抓着文件回 EBUSY/EPERM，或并发 PUT 正把
   * 新 tmp 换上来）。这类失败是暂时的，一旦当成删除，会话就永久从下拉里消失。 */
  const id = 'r-0101-0003-t003';
  const file = path.join(RUNS_DIR, id + '.json');
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  const srv = await startServer();
  try {
    await srv.wait();
    assert.strictEqual((await req(srv.base, 'PUT', '/api/runs/' + id, rec(id))).status, 200);
    fs.rmSync(file, { force: true });
    fs.mkdirSync(file);

    const got = await req(srv.base, 'GET', '/api/runs/' + id);
    assert.strictEqual(got.status, 503, '暂时读不出来不是 404：' + JSON.stringify(got.data));
    assert.match(got.data.error.message, /暂时|稍后/, '要说清是可重试的：' + got.data.error.message);

    const list = await req(srv.base, 'GET', '/api/runs');
    assert.ok(list.data.runs.some((x) => x.id === id), '索引条目必须还在（没被当幽灵剔除）');
  } finally {
    fs.rmSync(file, { force: true, recursive: true });
    await req(srv.base, 'DELETE', '/api/runs/' + id).catch(() => {});
    srv.child.kill();
  }
});

test('index.json 是合法 JSON 但非数组：不崩进程，从目录重建', async () => {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  fs.writeFileSync(path.join(RUNS_DIR, 'index.json'), '{"a":1}');
  const srv = await startServer();
  try {
    await srv.wait();
    fs.writeFileSync(path.join(RUNS_DIR, 'r-0101-0002-t002.json'), JSON.stringify(rec('r-0101-0002-t002')));
    const list = await req(srv.base, 'GET', '/api/runs');
    assert.strictEqual(list.status, 200);
    assert.ok(Array.isArray(list.data.runs), 'runs 是数组');
    assert.ok(list.data.runs.some((x) => x.id === 'r-0101-0002-t002'));
  } finally { srv.child.kill(); }
});

test('清理测试产物', async () => {
  ['r-0101-0001-t001', 'r-0101-0002-t002'].forEach((id) => {
    fs.rmSync(path.join(RUNS_DIR, id + '.json'), { force: true });
  });
  /* 索引一并清掉：不给开发者真实 data/runs/index.json 留测试幽灵条目 */
  fs.rmSync(path.join(RUNS_DIR, 'index.json'), { force: true });
});
