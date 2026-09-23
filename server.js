/**
 * Jev 体验网页 - 本地代理服务
 *
 * 作用：
 *  1. 托管前端静态页面
 *  2. 代理转发到 Jev 官方接口 https://api.typesafe.ai/v1/systemone
 *     - 规避浏览器直连的 CORS 限制
 *     - API Key 不入库：优先用页面里填写的 key（请求头 x-typesafe-key），
 *       其次环境变量 TYPESAFE_API_KEY
 *
 * 运行：node server.js  然后访问 http://localhost:3000
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const API_URL = 'https://api.typesafe.ai/v1/systemone';
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';

/* 场景保存：按访问 IP 隔租户，简单 JSON 文件存储（data/ws_<hash>.json） */
const DATA_DIR = path.join(__dirname, 'data');

/* API Key 的两种来源，优先级：请求头 x-typesafe-key（页面里填写）> 环境变量 TYPESAFE_API_KEY。
 * 仓库里不保存任何 key：页面填的 key 只存浏览器 localStorage，随请求头发到本服务做转发。 */
const API_KEY = process.env.TYPESAFE_API_KEY || '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/* ---------------- CORS ----------------
 * 页面可能从静态预览面板（另一个端口/源）打开并回退请求到本服务，
 * 因此需要放开跨源。仅监听本机端口，风险可控。
 */
function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Typesafe-Key');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/* ---------------- 静态文件 ---------------- */
function serveStatic(req, res) {
  applyCors(res);
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  // 防止路径穿越
  const filePath = path.join(__dirname, 'public', path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    // no-cache：保证发版后浏览器不会用旧静态资源
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  });
}

/* ---------------- 场景保存（GET / POST / DELETE /api/workspace） ----------------
 * 租户隔离：取 X-Forwarded-For 首段（反向代理部署时由 nginx 等注入），否则回源 IP；
 * IP 做 SHA-1 哈希后作为文件名，不落明文。存储就是一个 JSON 文件，够用且好备份。
 */
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function workspaceFile(req) {
  const hash = crypto.createHash('sha1').update(clientIp(req)).digest('hex').slice(0, 16);
  return path.join(DATA_DIR, 'ws_' + hash + '.json');
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function handleWorkspace(req, res) {
  applyCors(res);
  const file = workspaceFile(req);

  if (req.method === 'GET') {
    fs.readFile(file, 'utf8', (err, text) => {
      if (err) return sendJson(res, 200, { ok: true, workspace: null });
      try { return sendJson(res, 200, { ok: true, workspace: JSON.parse(text) }); }
      catch (_) { return sendJson(res, 200, { ok: true, workspace: null }); }
    });
    return;
  }

  if (req.method === 'DELETE') {
    fs.unlink(file, () => sendJson(res, 200, { ok: true }));
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) req.destroy(); // 1MB 上限
    });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body || '{}'); }
      catch (_) { return sendJson(res, 400, { ok: false, error: { message: '请求体不是合法 JSON' } }); }

      const questions = (Array.isArray(payload.questions) ? payload.questions : [])
        .slice(0, 50)
        .map((q) => ({
          type: (q && (q.type === 'choice' || q.type === 'score' || q.type === 'noul')) ? q.type : 'noul',
          name: String((q && q.name) || '').slice(0, 120),
          instructions: String((q && q.instructions) || '').slice(0, 4000),
          criteria: (q && q.criteria !== undefined) ? q.criteria : null
        }))
        .filter((q) => q.name || q.instructions);

      const record = {
        savedAt: new Date().toISOString(),
        state: typeof payload.state === 'string' ? payload.state.slice(0, 500000) : '',
        questions: questions
      };

      fs.mkdir(DATA_DIR, { recursive: true }, (err) => {
        if (err) return sendJson(res, 500, { ok: false, error: { message: '存储目录创建失败：' + err.message } });
        fs.writeFile(file, JSON.stringify(record, null, 2), 'utf8', (err2) => {
          if (err2) return sendJson(res, 500, { ok: false, error: { message: '写入失败：' + err2.message } });
          sendJson(res, 200, { ok: true });
        });
      });
    });
    return;
  }

  sendJson(res, 405, { ok: false, error: { message: 'Method Not Allowed' } });
}

/* ---------------- 转发到 Jev ---------------- */
function proxySystemOne(req, res) {
  applyCors(res);
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 2 * 1024 * 1024) req.destroy(); // 2MB 上限
  });

  req.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(body || '{}');
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: { message: '请求体不是合法 JSON：' + e.message } }));
    }

    // 基础校验
    if (typeof payload.state !== 'string' && typeof payload.state !== 'object') {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: { message: '缺少 state 字段（状态文本或对象）' } }));
    }
    if (!payload.questions || typeof payload.questions !== 'object' || !Object.keys(payload.questions).length) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: { message: '至少需要一个问题（questions）' } }));
    }
    if (!payload.model) payload.model = 'jev-latest';

    // Key：请求头（页面填写）优先，其次环境变量；都没有则明确报错
    const key = String(req.headers['x-typesafe-key'] || '').trim() || API_KEY;
    if (!key) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(
        JSON.stringify({
          error: { message: '未配置 API Key：请在页面顶部「API Key」输入框里填写，或在启动服务前设置环境变量 TYPESAFE_API_KEY' }
        })
      );
    }

    const upstreamBody = JSON.stringify(payload);
    const started = Date.now();

    const upstreamReq = https.request(
      API_URL,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + key,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(upstreamBody),
        },
        timeout: 120000,
      },
      (upstreamRes) => {
        let data = '';
        upstreamRes.on('data', (c) => (data += c));
        upstreamRes.on('end', () => {
          const latency = Date.now() - started;
          let parsed = null;
          try {
            parsed = JSON.parse(data);
          } catch (_) {
            /* 保留原始文本 */
          }

          if (upstreamRes.statusCode >= 200 && upstreamRes.statusCode < 300 && parsed) {
            parsed._latency_ms = latency;
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify(parsed));
          }

          res.writeHead(upstreamRes.statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              error: {
                status: upstreamRes.statusCode,
                message: (parsed && parsed.error) || data || '上游返回异常',
              },
              _latency_ms: latency,
            })
          );
        });
      }
    );

    upstreamReq.on('timeout', () => {
      upstreamReq.destroy();
      res.writeHead(504, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: '请求 Jev 超时（120s）' } }));
    });

    upstreamReq.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          error: {
            message: '无法连接 Jev 官方接口：' + err.message + '（请检查本机网络/代理是否能访问 api.typesafe.ai）',
          },
        })
      );
    });

    upstreamReq.write(upstreamBody);
    upstreamReq.end();
  });
}

const server = http.createServer((req, res) => {
  const pathname = req.url.split('?')[0];

  // CORS 预检
  if (req.method === 'OPTIONS') {
    applyCors(res);
    res.writeHead(204);
    return res.end();
  }

  if (pathname === '/api/workspace') return handleWorkspace(req, res);
  if (req.method === 'POST' && pathname === '/api/systemone') return proxySystemOne(req, res);
  if (req.method === 'GET' && pathname === '/api/health') {
    applyCors(res);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, model: 'jev-latest', hasKey: Boolean(API_KEY) }));
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log('');
  console.log('  Jev 体验网页已启动');
  console.log('  →  http://localhost:' + PORT);
  console.log('');
});
