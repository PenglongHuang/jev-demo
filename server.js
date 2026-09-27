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
/* 默认只绑本机回环：本服务无鉴权（浏览器驱动 / 代理都在信任边界内），
 * 暴露到局域网会被用来劫持 playwright 会话或中继请求。需要反代时设 HOST=0.0.0.0。 */
const HOST = process.env.HOST || '127.0.0.1';
/* 仅在显式声明信任反代时才读 X-Forwarded-For（默认直连地址做租户哈希，
 * 防 XFF 伪造冒充他人会话/场景） */
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const API_URL_PRESETS = {
  official: 'https://api.typesafe.ai/v1/systemone',
  openrouter: 'https://openrouter.ai/api/v1/systemone',
};
const DEFAULT_PRESET = 'official';
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Typesafe-Key, X-Endpoint, X-Llm-Base, X-Llm-Key');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/* ---------------- 静态文件 ---------------- */
function serveStatic(req, res) {
  applyCors(res);
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); }
  catch (_) { res.writeHead(400); return res.end('Bad Request'); }
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
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  }
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

/* ---------------- 运行会话记录：data/runs/<id>.json + index.json ----------------
 * 列表只读索引 sidecar（首访问时缺失则扫目录重建），PUT/DELETE 同步维护；
 * 全量文件含截图 base64（数 MB），绝不整读进列表。 */
const RUNS_DIR = path.join(DATA_DIR, 'runs');
const RUNS_INDEX = path.join(RUNS_DIR, 'index.json');
const RUN_ID_RE = /^r-[0-9]{4}-[0-9]{4}-[a-z0-9]{4}$/;

let runsIndexCache = null;
let tmpSeq = 0; /* 原子写中间文件的自增序号：并发写不共用同一个 tmp 名 */

function runIndexEntry(meta) {
  return {
    id: meta.id, goal: String(meta.goal || '').slice(0, 60),
    endState: meta.endState || 'running', stepCount: meta.stepCount || 0,
    startedAt: meta.startedAt || null, endedAt: meta.endedAt || null,
  };
}
function runsIndexSave() {
  try {
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    /* tmp 名带唯一后缀（.json 之后）：并发 PUT 同时维护索引时不互相覆盖中间文件 */
    const tmp = RUNS_INDEX + '.' + Date.now() + '-' + (tmpSeq++) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(runsIndexCache));
    fs.renameSync(tmp, RUNS_INDEX);
  } catch (_) { /* 索引写失败不阻断主流程，下次重建 */ }
}
function runsIndexLoad() {
  if (runsIndexCache) return runsIndexCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(RUNS_INDEX, 'utf8'));
    /* 形状校验：合法 JSON 但非数组（如 {}）会让下面 .sort 同步 throw 打崩整个进程，坏形状按损坏处理 */
    if (!Array.isArray(parsed)) throw new Error('index.json 内容不是数组');
    runsIndexCache = parsed;
  }
  catch (_) {
    runsIndexCache = [];
    let names = [];
    try { names = fs.readdirSync(RUNS_DIR); } catch (_) { /* 目录尚不存在 */ }
    names.filter((f) => /^r-.*\.json$/.test(f)).forEach((f) => {
      try {
        const one = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), 'utf8'));
        if (one && one.meta && one.meta.id) runsIndexCache.push(runIndexEntry(one.meta));
      } catch (_) { /* 单文件损坏跳过 */ }
    });
    runsIndexSave();
  }
  runsIndexCache.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
  return runsIndexCache;
}

/* 会话记录 API 契约（Wave 0 冻结）：
 *   GET    /api/runs                  → { ok, runs:[索引条目] }               （已有）
 *   GET    /api/runs/:id              → 记录全量 / 404 / 503                 （已有）
 *   PUT    /api/runs/:id              → { ok:true }                          （已有）
 *   DELETE /api/runs/:id              → { ok:true }（幂等）                  （已有）
 *   DELETE /api/runs?before=<ISO8601> → { ok:true, deleted:N }               （条目 8）
 *       只删 meta.startedAt 严格早于 before 的记录；before 缺失/空/不可解析 → 400。
 *       绝不能把「参数没解析出来」当成「删全部」。
 *   POST   /api/browser/close         → { ok, mode, attached, closed }        （条目 10）
 *       closed=false 表示之前压根没有开着的浏览器 → 前端不得提示「浏览器已关闭」。
 *
 * 注意路由：本函数收到的是 pathname（server.js 顶部 req.url.split('?')[0]），
 * 查询串要从 req.url 自己取，例如 new URL(req.url, 'http://x').searchParams.get('before')。
 */
function handleRuns(req, res, pathname) {
  applyCors(res);
  const rest = pathname.slice('/api/runs'.length).replace(/^\/+/, '');
  const id = rest.split('/')[0] || '';
  const err = (code, msg) => sendJson(res, code, { ok: false, error: { message: msg } });

  if (req.method === 'GET' && !id) return sendJson(res, 200, { ok: true, runs: runsIndexLoad() });

  if (req.method === 'DELETE' && !id) {
    /* 条目 8：按时间边界批量清理。护栏 —— before 缺失 / 空串 / Date.parse 为 NaN 一律 400，
     * 绝不能把「参数没解析出来」当成「删全部」。查询串要从 req.url 自己取：传进来的
     * pathname 已被 split('?') 砍掉。 */
    const beforeRaw = new URL(req.url, 'http://localhost').searchParams.get('before');
    const beforeMs = beforeRaw ? Date.parse(beforeRaw) : NaN;
    if (!beforeRaw || Number.isNaN(beforeMs)) {
      return err(400, '查询参数 before 缺失或不是合法时间（ISO8601）：' + JSON.stringify(beforeRaw));
    }
    const idx = runsIndexLoad();
    const doomed = idx.filter((x) => {
      const t = Date.parse(x.startedAt);   /* 无 startedAt / 坏值 → NaN，绝不误删 */
      return !Number.isNaN(t) && t < beforeMs;   /* 严格早于 */
    });
    if (!doomed.length) return sendJson(res, 200, { ok: true, deleted: 0 });   /* 幂等 */
    const doomedIds = new Set(doomed.map((x) => x.id));
    let pending = doomed.length;
    let deleted = 0;
    doomed.forEach((x) => {
      fs.unlink(path.join(RUNS_DIR, x.id + '.json'), (e) => {
        if (!e || e.code === 'ENOENT') deleted++;   /* ENOENT：索引里的幽灵条目，一并清理 */
        if (--pending === 0) {                      /* 全部删完再重建索引，避免中间态落盘 */
          runsIndexCache = runsIndexLoad().filter((y) => !doomedIds.has(y.id));
          runsIndexSave();
          sendJson(res, 200, { ok: true, deleted });
        }
      });
    });
    return;
  }

  if (!RUN_ID_RE.test(id)) return err(400, '会话 id 不合法：' + id);
  const file = path.join(RUNS_DIR, id + '.json');

  if (req.method === 'GET') {
    fs.readFile(file, (e, data) => {
      if (e) {
        /* 只有「文件确实不在了」才是幽灵条目，才顺手剔除（绕过 API 手删的情况）。
         * 其它读错误（Windows 上索引器/杀软抓着文件 → EBUSY/EPERM；并发 autosave 的
         * PUT 正把新 tmp 换上来；同名目录 → EISDIR）**不动索引** —— 那些是暂时的，
         * 一旦当成删除，这个会话就永久从下拉里消失了（惰性重建只在 index.json 本身
         * 读不出来时才跑，而记录文件还在磁盘上）。 */
        if (e.code !== 'ENOENT') {
          return err(503, '会话文件暂时读不出来（' + (e.code || e.message) + '），请稍后重试：' + id);
        }
        const idx = runsIndexLoad();
        if (idx.some((x) => x.id === id)) {
          runsIndexCache = idx.filter((x) => x.id !== id);
          runsIndexSave();
        }
        return err(404, '会话不存在：' + id);
      }
      try { sendJson(res, 200, JSON.parse(data)); }
      catch (_) { err(500, '会话文件损坏：' + id); }
    });
    return;
  }
  if (req.method === 'PUT') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 96 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      let obj;
      try { obj = JSON.parse(body || '{}'); }
      catch (_) { return err(400, '请求体不是合法 JSON'); }
      if (!obj || !obj.meta || obj.meta.id !== id) return err(400, '记录 meta.id 与路径不一致');
      fs.mkdir(RUNS_DIR, { recursive: true }, (e1) => {
        if (e1) return err(500, '目录创建失败：' + e1.message);
        /* 唯一 tmp 名，后缀必须落在 .json 之后（r-x.json.<ts>-<seq>.tmp）：
         * 同 id 并发 PUT 不撞名，且目录重建扫描的 /^r-.*\.json$/ 不会误收残留 tmp */
        const tmp = file + '.' + Date.now() + '-' + (tmpSeq++) + '.tmp';
        fs.writeFile(tmp, JSON.stringify(obj), (e2) => {
          if (e2) return err(500, '写入失败：' + e2.message);
          fs.rename(tmp, file, (e3) => {
            if (e3) return err(500, '落盘失败：' + e3.message);
            runsIndexCache = runsIndexLoad().filter((x) => x.id !== id);
            runsIndexCache.push(runIndexEntry(obj.meta));
            runsIndexCache.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
            runsIndexSave();
            sendJson(res, 200, { ok: true });
          });
        });
      });
    });
    return;
  }
  if (req.method === 'DELETE') {
    fs.unlink(file, () => {          /* 不存在也成功（幂等） */
      runsIndexCache = runsIndexLoad().filter((x) => x.id !== id);
      runsIndexSave();
      sendJson(res, 200, { ok: true });
    });
    return;
  }
  err(405, 'Method Not Allowed');
}

/* ---------------- playwright-jev-agent ----------------
 * 驱动模块懒加载：playwright 未安装时不影响其余功能。
 * 租户隔离与场景保存一致：按 IP 哈希得到 CLI session 名。
 */
let driver = null;
let driverLoadTried = false;
function getDriver() {
  if (!driverLoadTried) {
    driverLoadTried = true;
    try { driver = require('./browser-driver'); } catch (_) { driver = null; }
    if (driver) driver.dataDir = DATA_DIR;
  }
  return driver;
}

function browserSession(req) {
  const hash = crypto.createHash('sha1').update(clientIp(req)).digest('hex').slice(0, 12);
  return 'jev' + hash;
}

function readJsonBody(req, res, cb) {
  applyCors(res);
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 256 * 1024) req.destroy();
  });
  req.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch (_) { return sendJson(res, 400, { ok: false, error: { message: '请求体不是合法 JSON' } }); }
    cb(payload);
  });
}

async function handleBrowser(req, res, action) {  const d = getDriver();
  if (!d) {
    applyCors(res);
    return sendJson(res, 200, { ok: false, code: 'NO_DRIVER', error: { message: 'browser-driver 模块不可用' } });
  }
  const session = browserSession(req);

  if (action === 'status') {
    applyCors(res);
    return sendJson(res, 200, Object.assign({ ok: true, session: session }, d.status()));
  }
  /* CDP 预检（只读）：默认 profile 里有没有 DevToolsActivePort，**并且真探一次端点** ——
   * 只有文件不够（陈旧残留 / Chrome 136+ 绑了端口却拒绝 DevTools）。前端在选 cdp 模式时
   * 先问一次，把「连不上」提前说清楚，而不是等 run 失败再翻译报错。 */
  if (action === 'cdp-probe') {
    applyCors(res);
    let probe = { available: false, reason: 'no-driver', channel: null, endpoint: null, hint: '' };
    try {
      probe = d.cdpProbe ? await d.cdpProbe() : probe;
    } catch (e) {
      probe = { available: false, reason: 'error', channel: null, endpoint: null, hint: String(e && e.message || e) };
    }
    return sendJson(res, 200, Object.assign({ ok: true, session: session }, probe));
  }
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: { message: 'Method Not Allowed' } });

  readJsonBody(req, res, async (payload) => {
    let out;
    try {
      if (action === 'open') {
        const browser = ['chrome', 'msedge'].includes(payload.browser) ? payload.browser : undefined;
        /* 浏览器模式（连接方式，与内核正交；前端 mode 指定，缺省 isolated）：
         *   isolated   — 每次起一个干净实例（默认，最收敛）
         *   persistent — 仍是我们自己起的窗口，但 profile 落盘（登录一次长期复用）
         *   cdp        — attach 到用户已开着调试端口的浏览器，复用其真实登录态。
         *                **窗口类动作在此模式下全部跳过**：那是用户的窗口与视口，
         *                不是我们起的实例（driver 侧同样会拒绝，双层保险）。 */
        const browserMode = payload.mode == null ? 'isolated' : String(payload.mode);
        if (!['isolated', 'persistent', 'cdp'].includes(browserMode)) {
          return sendJson(res, 200, { ok: false, error: '不支持的浏览器模式：' + JSON.stringify(browserMode.slice(0, 40)) + '（可选 isolated / persistent / cdp）' });
        }
        /* 窗口模式三档（前端 windowMode 指定，缺省 max）：
         *   max  — 最大化：窗口铺满屏幕（保留浏览器工具栏，任务栏照常）★默认
         *   full — 真全屏：CDP fullscreen，连任务栏一起盖住、无工具栏
         *   size — 指定页面视口尺寸（resize）
         * native=true 时按物理像素渲染（忽略系统缩放），max/full 都适用。
         * 前端同时传 width/height 作目标尺寸参考（size 档直接用，其余用于校验）。 */
        const windowMode = ['full', 'max', 'size'].includes(payload.windowMode) ? payload.windowMode : 'max';
        const attach = browserMode === 'cdp';
        const maximize = !attach && windowMode !== 'size';
        const native = maximize && payload.native === true;
        out = await d.open(session, String(payload.url || ''), {
          browser: browser,
          mode: browserMode,
          cdp: payload.cdp == null ? undefined : String(payload.cdp),
          maximize: maximize,
          native: native,
        });
        if (attach) {
          /* 附身模式：不碰用户的窗口几何，什么都不用校正 —— 直接把它标记出来，
           * 前端据此提示「运行期间那个浏览器窗口会被占用」。 */
          if (out && out.ok) out.windowSkipped = true;
        } else if (out && out.ok && windowMode === 'full') {
          /* 真全屏：先按最大化开窗（CDP 全屏失败时仍是体面的最大化窗口），
           * 再经 CDP 切到 fullscreen 态，最后实测视口确认生效。 */
          const r = await d.fullscreen(session);
          out.fullscreen = Boolean(r && r.ok);
          if (!out.fullscreen) out.fullscreenError = (r && r.error) || 'CDP 全屏调用失败';
          const ref = d._test.parseWindowSize(payload.width, payload.height);
          if (out.fullscreen && ref) {
            try {
              await new Promise((r2) => setTimeout(r2, 800));   // 全屏切换有过渡
              const vp = await d.viewport(session);
              if (vp && (vp.w < ref.w * 0.98 || vp.h < ref.h * 0.98)) {
                out.fullscreen = false;
                out.fullscreenError = '视口 ' + vp.w + '×' + vp.h + ' 未达整屏 ' + ref.w + '×' + ref.h;
              }
            } catch (_) { /* 校验异常不推翻已生效的全屏 */ }
          }
        } else if (out && out.ok && windowMode === 'max') {
          const ref = d._test.parseWindowSize(payload.width, payload.height);
          if (ref) {
            try {
              /* 等 1.2s：open 返回时 Chrome 可能仍在应用最大化，立刻读视口
               * 会拿到中间值导致误判走 resize 兜底 */
              await new Promise((r) => setTimeout(r, 1200));
              const vp = await d.viewport(session);
              if (vp && (vp.w < ref.w * 0.85 || vp.h < ref.h * 0.85)) {
                const rz = await d.resize(session, ref.w, ref.h);
                out.maximized = false;
                out.resized = Boolean(rz.ok);
                if (!rz.ok) out.resizeError = rz.error;
              }
            } catch (_) { /* 校验失败不阻断，维持最大化结果 */ }
          }
        } else if (out && out.ok) {
          const size = d._test.parseWindowSize(payload.width, payload.height);
          if (size) {
            const rz = await d.resize(session, size.w, size.h);
            out.resized = Boolean(rz.ok);
            if (!rz.ok) out.resizeError = rz.error;
          }
        }
      }
      else if (action === 'snapshot') out = await d.snapshot(session);
      else if (action === 'page-info') out = await d.pageInfo(session);
      else if (action === 'act') out = await d.act(session, String(payload.command || ''), payload.ref ? String(payload.ref) : null, payload.text != null ? String(payload.text) : null);
      else if (action === 'screenshot') {
        /* 带 ref 时把该元素的矩形与当时视口一并返回（工程自动执行，不占 Jev 名额）：
         * 前端拿它把「即将被操作的元素」标到这张图上去。位置与截图取自同一时刻、且
         * 都在动作之前 —— 元素此刻必定还在，位置唯一确定，不存在 ref 失效或行位移的问题。
         * 标注画在图上（public/js/anno.js），被驱动页面里不留痕迹。 */
        const ref = payload.ref ? String(payload.ref) : null;
        const pos = ref ? await d.rect(session, ref) : null;
        /* 文件名用前端给的每步名（step-1 / step-2…）：原先这里把 session 又当 name 传了一次，
         * 于是全部截图都落到同一个 <session>.png 上、后一步覆盖前一步，driver 里
         * 「文件保留在 data/ 便于排查留证」的意图落空。session 作兜底（并发会话不撞名）。 */
        out = await d.screenshot(session, payload.name ? String(payload.name) : session);
        if (out && out.ok && pos && pos.ok) {
          out.rect = pos.rect;
          out.viewport = pos.viewport;
        }
      }
      else if (action === 'close') {
        out = await d.close(session);
        /* 附身模式只断开连接：用户那个浏览器不是我们起的，也不该被我们关掉 —— 说清楚，
         * 免得「浏览器已关闭」的提示让人以为自己的窗口没了。 */
        if (out && out.ok && out.attached) out.message = '已断开连接（你的浏览器仍在运行，标签页保留）';
        /* 本来就没开着（driver 的 closed=false）→ 别说「已关闭」，如实告诉用户无需关闭。 */
        else if (out && out.ok && !out.closed) out.message = '当前没有开着的浏览器（无需关闭）';
      }
      else return sendJson(res, 404, { ok: false, error: { message: 'Unknown browser action' } });
    } catch (e) {
      out = { ok: false, error: String(e && e.message || e) };
    }
    sendJson(res, out && out.ok ? 200 : 200, out);
  });
}

/* ---------------- 上游 URL 安全校验 ----------------
 * 自定义上游（X-Endpoint / x-llm-base）只允许：
 *   https:// 任意主机（用户自己配置的提供商）
 *   http://  仅限 localhost / 127.0.0.1 / [::1]（本机调试，含 E2E mock）
 * 且禁止 URL 内嵌 userinfo（http://localhost@evil.com/ 这类绕过）。 */
function isAllowedCustomUpstream(raw) {
  let u;
  try { u = new URL(raw); } catch (_) { return null; }
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (u.protocol === 'https:') return u;
  if (u.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1' || host === '::1')) return u;
  return null;
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
    const keyFromHeader = String(req.headers['x-typesafe-key'] || '').trim();
    const key = keyFromHeader || API_KEY;
    if (!key) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(
        JSON.stringify({
          error: { message: '未配置 API Key：请在页面顶部「API Key」输入框里填写，或在启动服务前设置环境变量 TYPESAFE_API_KEY' }
        })
      );
    }

    // 上游地址：预设名直接放行；自定义 URL 必须由页面自带 Key 请求（防止把
    // 服务端环境变量里的 Key 外送到任意地址），且只允许 https 或本机 http
    let endpointHeader = String(req.headers['x-endpoint'] || DEFAULT_PRESET).trim();
    let upstreamUrl;
    if (API_URL_PRESETS[endpointHeader]) {
      upstreamUrl = API_URL_PRESETS[endpointHeader];
    } else {
      const custom = isAllowedCustomUpstream(endpointHeader);
      if (!custom) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
          error: { message: '自定义接口地址被拒绝：仅允许 https:// 或 http://localhost（本机调试）' }
        }));
      }
      if (!keyFromHeader) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
          error: { message: '使用自定义接口时必须在页面配置里填写 API Key（服务端环境变量 Key 不转发到自定义地址）' }
        }));
      }
      upstreamUrl = custom.href;
    }

    const upstreamBody = JSON.stringify(payload);
    const started = Date.now();

    const upstreamMod = upstreamUrl.toLowerCase().startsWith('http://') ? http : https;
    const upstreamReq = upstreamMod.request(
      upstreamUrl,
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
            parsed._upstream = upstreamUrl;
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify(parsed));
          }

          res.writeHead(upstreamRes.statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              error: {
                status: upstreamRes.statusCode,
                message: (parsed && parsed.error) || data || '上游返回异常',
                upstream: upstreamUrl,
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
      res.end(JSON.stringify({ error: { message: '请求上游超时（120s）', upstream: upstreamUrl } }));
    });

    upstreamReq.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          error: {
            message: '无法连接上游：' + err.message,
            upstream: upstreamUrl,
          },
        })
      );
    });

    upstreamReq.write(upstreamBody);
    upstreamReq.end();
  });
}

/* ---------------- 转发到生成模型（OpenAI 兼容 /chat/completions） ----------------
 * playwright-jev-agent「生成输入」动作用的纯透传：
 *  - 地址与 Key 全部来自页面请求头（x-llm-base / x-llm-key），服务端不保存
 *  - base 仅允许 https:// 或 http://localhost（内网地址一律拒绝）
 *  - 请求体做字段白名单（model/messages/temperature/max_tokens），messages 内容原样透传不改动
 */
function proxyLlm(req, res) {
  readJsonBody(req, res, (payload) => {
    const base = String(req.headers['x-llm-base'] || '').trim();
    const key = String(req.headers['x-llm-key'] || '').trim();

    if (!key) {
      return sendJson(res, 400, { error: { message: '缺少生成模型 API Key（请求头 x-llm-key）' } });
    }
    /* 用 URL 解析校验而非前缀正则：防 http://localhost@evil.com、
     * http://127.0.0.1.evil.com、URL userinfo 等绕过 */
    const baseParsed = isAllowedCustomUpstream(base);
    if (!baseParsed) {
      return sendJson(res, 400, { error: { message: 'Base URL 必须是 https://，或 http://localhost（本机调试，不允许内嵌用户名密码）' } });
    }
    const model = String(payload.model || '').trim();
    if (!model) return sendJson(res, 400, { error: { message: '缺少 model 字段' } });
    if (!Array.isArray(payload.messages) || !payload.messages.length) {
      return sendJson(res, 400, { error: { message: '缺少 messages 字段（非空数组）' } });
    }

    // 字段白名单重组：只透传约定的四个字段
    const upstreamBody = JSON.stringify({
      model: model,
      messages: payload.messages,
      temperature: typeof payload.temperature === 'number' ? payload.temperature : 0.3,
      max_tokens: typeof payload.max_tokens === 'number' ? payload.max_tokens : 200,
    });

    // base 已带 /chat/completions 则不重复拼接
    const baseHref = baseParsed.href;
    const upstreamUrl = /\/chat\/completions\/?$/i.test(baseHref)
      ? baseHref
      : baseHref.replace(/\/+$/, '') + '/chat/completions';

    const upstreamMod = upstreamUrl.toLowerCase().startsWith('http://') ? http : https;
    const started = Date.now();
    const upstreamReq = upstreamMod.request(
      upstreamUrl,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + key,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(upstreamBody),
        },
        timeout: 60000,
      },
      (upstreamRes) => {
        let data = '';
        upstreamRes.on('data', (c) => (data += c));
        upstreamRes.on('end', () => {
          const latency = Date.now() - started;
          let parsed = null;
          try { parsed = JSON.parse(data); } catch (_) { /* 保留原文 */ }

          if (upstreamRes.statusCode >= 200 && upstreamRes.statusCode < 300 && parsed) {
            parsed._latency_ms = latency;
            parsed._upstream = upstreamUrl;
            return sendJson(res, 200, parsed);
          }
          sendJson(res, upstreamRes.statusCode >= 400 ? upstreamRes.statusCode : 502, {
            error: {
              status: upstreamRes.statusCode,
              message: (parsed && parsed.error && (parsed.error.message || parsed.error)) || data || '上游返回异常',
              upstream: upstreamUrl,
            },
            _latency_ms: latency,
          });
        });
      }
    );

    upstreamReq.on('timeout', () => {
      upstreamReq.destroy();
      sendJson(res, 504, { error: { message: '请求生成模型超时（60s）', upstream: upstreamUrl } });
    });
    upstreamReq.on('error', (err) => {
      sendJson(res, 502, { error: { message: '无法连接生成模型：' + err.message, upstream: upstreamUrl } });
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
  if (pathname === '/api/runs' || pathname.startsWith('/api/runs/')) return handleRuns(req, res, pathname);
  if (pathname.startsWith('/api/browser/')) return handleBrowser(req, res, pathname.slice('/api/browser/'.length));
  if (req.method === 'POST' && pathname === '/api/systemone') return proxySystemOne(req, res);
  if (req.method === 'POST' && pathname === '/api/llm') return proxyLlm(req, res);
  if (req.method === 'GET' && pathname === '/api/health') {
    applyCors(res);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    const d = getDriver();
    // browserDetail：playwright-cli 安装探测（结果缓存 60s），前端据此渲染 browserPill 三态
    Promise.resolve(d ? d.status() : Promise.resolve({ available: false, reason: 'NO_DRIVER' }))
      .then((st) => {
        res.end(JSON.stringify({
          ok: true,
          model: 'jev-latest',
          hasKey: Boolean(API_KEY),
          browser: Boolean(st.available),
          browserDetail: st,
        }));
      })
      .catch(() => res.end(JSON.stringify({ ok: true, model: 'jev-latest', hasKey: Boolean(API_KEY), browser: false, browserDetail: { available: false } })));
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  fs.mkdirSync(DATA_DIR, { recursive: true }); // 浏览器驱动把截图等产物写在这里
  const major = Number((process.versions.node || '0').split('.')[0]);
  if (major < 18) {
    console.warn('  ⚠ 检测到 Node ' + process.versions.node + '：本项目要求 Node 18+（spawn/嵌套 fetch 依赖），部分功能可能异常');
  }
  console.log('');
  console.log('  Jev 体验网页已启动');
  console.log('  →  http://localhost:' + PORT);
  console.log('');
});
