/* 起真实 server.js 子进程的公共夹具。
 *
 * 这段引导（随机端口 → spawn → 健康轮询 → 统一的 {status,data} 信封）此前在
 * 7 个 spec 里各抄一份，连就绪判据都在漂移：有的只查 HTTP 200，有的还查 body 的 ok，
 * 有的轮询超时后静默继续（后面每个断言都失败，却看不出根因是服务没起来）。
 * 现在只有这一份。
 *
 * 用法：
 *   const { startServer, req } = require('./helpers/server.js');
 *   const srv = startServer();              // { child, base, wait }
 *   await srv.wait();                       // 就绪前一直等，超时抛错
 *   ... req(srv.base, 'GET', '/api/health')
 *   srv.child.kill();                       // 收尾（各 spec 自己负责，见 t.after / finally）
 *
 * portBase 可传（各 spec 用不同的基数把随机端口摊开，纯粹是降低并行撞端口概率）；
 * extraEnv 用于「换个环境变量再起一个实例」的用例（如带 TYPESAFE_API_KEY 的实例）。
 */
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

function startServer(portBase, extraEnv) {
  const port = (portBase || 30000) + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(port) }, extraEnv || {}),
    stdio: 'ignore', windowsHide: true,
  });
  const base = 'http://127.0.0.1:' + port;

  /* 就绪判据是「健康检查真的回了 ok」，不是只看 HTTP 200 —— 端口被别的进程占着时
   * 也可能回 200，但那个服务不认我们的路由，后面的断言会以看不懂的方式全挂。 */
  const wait = async () => {
    for (let i = 0; i < 150; i++) {
      try {
        const r = await fetch(base + '/api/health');
        if (r.ok && (await r.json()).ok) return base;
      } catch (_) { /* 尚未监听 */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('server 未能在 15s 内就绪：' + base);
  };

  return { child, base, wait };
}

/* 统一信封：{status, data}（body 不是 JSON 时 data 为 null，调用方按 status 判） */
const req = (base, method, p, body) => fetch(base + p, {
  method, headers: body ? { 'Content-Type': 'application/json' } : {},
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

module.exports = { startServer, req, ROOT };
