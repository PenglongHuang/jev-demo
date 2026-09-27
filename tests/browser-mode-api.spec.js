/* 浏览器模式接口测试：起真实 server.js 子进程，直打 /api/browser/*。
 *
 * 这一组测试**不起浏览器**：只覆盖「在起进程之前就该拦住/回答掉」的部分 ——
 * 模式白名单、CDP 目标校验、CDP 预检。真跑三种模式的验收在
 * tests/cdp-attach.spec.js（JEVDEMO_CDP=1 时启用）与 tests/driver-smoke.spec.js。 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

function startServer() {
  const port = 33000 + Math.floor(Math.random() * 20000);
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

test('GET /api/browser/cdp-probe：只读预检，返回可用的 channel/endpoint 与做法提示', async () => {
  const srv = await startServer();
  try {
    await srv.wait();
    const r = await req(srv.base, 'GET', '/api/browser/cdp-probe');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.ok, true);
    assert.strictEqual(typeof r.data.available, 'boolean');
    assert.match(r.data.hint, /chrome:\/\/inspect|remote-debugging/i, '提示里要给出开启调试端口的做法');
    if (r.data.available) {
      assert.ok(['chrome', 'msedge'].includes(r.data.channel), 'channel 只能是内核名');
      /* 端点两种形态都合法，优先 ws（端口文件第二行，带 UUID）：
       * - Chrome 147+ 在默认 profile 上关掉了 /json/* 发现（404），ws 是唯一可用的形态
       * - http 形态是兜底（带 --user-data-dir 启动的 Chrome 两者都讲）
       * 都不能用 localhost：Chrome 只绑 IPv4，可能先解析到 ::1 而连不上 */
      if (/^ws:\/\//.test(r.data.endpoint)) {
        assert.match(r.data.endpoint, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[A-Za-z0-9._-]+$/,
          'ws 端点必须带 UUID 路径 —— 少一段会被 404');
      } else {
        assert.match(r.data.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
      }
      assert.strictEqual(r.data.reason, null);
    } else {
      assert.strictEqual(r.data.endpoint, null);
      /* 不可用要分清原因，前端才能给对症的下一步。
       * 取值域只有这两条（外加 server 侧的 no-driver / error，见 server.js 的 cdp-probe
       * 分支与 browser-driver.js cdpProbe 的注释）：「端口在监听但拒绝 DevTools」探不出来 ——
       * 探活只做 TCP connect，不做握手（握手会打掉用户正要点的授权弹窗），
       * 那种情况的文案由 attach 阶段的 403/404 翻译负责。 */
      assert.ok(['no-port-file', 'unreachable', 'no-driver', 'error'].includes(r.data.reason),
        '未知的 reason：' + JSON.stringify(r.data.reason));
    }
  } finally { srv.child.kill(); }
});

test('open：非法模式直接拒绝，且不启动任何浏览器', async () => {
  const srv = await startServer();
  try {
    await srv.wait();
    const t0 = Date.now();
    const r = await req(srv.base, 'POST', '/api/browser/open', { url: 'https://a.com', mode: 'CDP' });
    assert.strictEqual(r.status, 200, '失败也走 200（既有约定）');
    assert.strictEqual(r.data.ok, false);
    assert.match(r.data.error, /模式/, '要说清是模式不认：' + JSON.stringify(r.data));
    assert.ok(Date.now() - t0 < 3000, '不该走到起进程那步');
  } finally { srv.child.kill(); }
});

test('open：cdp 目标的非法形状在起进程之前就被拒（含注入字符与超长）', async () => {
  const srv = await startServer();
  try {
    await srv.wait();
    for (const cdp of ['ftp://x', 'a"b', 'a%b', 'a\nb', 'ws://' + 'a'.repeat(400)]) {
      const r = await req(srv.base, 'POST', '/api/browser/open', {
        url: 'https://a.com', mode: 'cdp', cdp: cdp,
      });
      assert.strictEqual(r.data.ok, false, '应拒绝：' + JSON.stringify(cdp.slice(0, 30)));
      assert.match(r.data.error, /CDP|不允许|过长|端点/, '错误要说清原因：' + r.data.error);
    }
  } finally { srv.child.kill(); }
});

test('open：cdp 指向一个没开的端口 → 人话报错（含怎么开调试端口），不留会话', async () => {
  const srv = await startServer();
  try {
    await srv.wait();
    /* 1 端口不会有人监听：attach 必然失败。验的是「失败得清楚」而不是「连得上」 */
    const r = await req(srv.base, 'POST', '/api/browser/open', {
      url: 'https://a.com', mode: 'cdp', cdp: 'ws://127.0.0.1:1/devtools/browser/deadbeef',
    });
    assert.strictEqual(r.data.ok, false);
    assert.match(r.data.error, /连不上|CDP/, '要是人话：' + r.data.error);
    /* 失败后不得留下半开的会话：close 应当是干净的（幂等，不报错） */
    const c = await req(srv.base, 'POST', '/api/browser/close', {});
    assert.strictEqual(c.status, 200);
    /* 条目 10：空闲时（本来就没开着）close 必须自报 closed=false，
     * 前端据此不提示「浏览器已关闭」。既有 200 断言是契约，保持不变。 */
    assert.strictEqual(c.data.closed, false, '没开着的会话 close 应 closed=false');
  } finally { srv.child.kill(); }
});
