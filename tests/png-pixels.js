/* 测试专用的极简 PNG 解码（零依赖，用内置 zlib），供 driver 冒烟与 E2E 共用。
 *
 * 为什么值得写这 40 行：「DOM 里有标记节点」≠「图里有标记像素」。标注功能的全部承诺
 * 就是截图里能看出操作了哪个元素，所以「入画」必须被机械断言，而不是靠人眼看图
 * —— 这个功能第一版就是因为只靠肉眼看图（且测试全用 ref 不会失效的搜索框）而漏掉了
 * 真实场景一条都标不出来的缺陷。
 *
 * 只支持 playwright 截图的形态：8bit、colorType 2(RGB)/6(RGBA)、无隔行。
 */
'use strict';
const zlib = require('zlib');

/* 入参兼容三种形态：PNG 的 Buffer、裸 base64 串、data:image/png;base64,xxx 串 */
function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  const s = String(input == null ? '' : input);
  return Buffer.from(s.startsWith('data:') ? s.slice(s.indexOf(',') + 1) : s, 'base64');
}

function pngHasPixel(dataUrl, want, tol) {
  const px = pngPixels(dataUrl);
  if (!px) return false;
  const t = tol == null ? 8 : tol;
  const { buf, bpp } = px;
  for (let i = 0; i + 2 < buf.length; i += bpp) {
    if (Math.abs(buf[i] - want[0]) <= t && Math.abs(buf[i + 1] - want[1]) <= t && Math.abs(buf[i + 2] - want[2]) <= t) return true;
  }
  return false;
}

/* 解出全部像素：{ buf(RGB/RGBA 连续), w, h, bpp }；不支持的形态返回 null */
function pngPixels(dataUrl) {
  const buf = toBuffer(dataUrl);
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null;

  let pos = 8, w = 0, h = 0, depth = 0, color = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; color = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8 || (color !== 2 && color !== 6) || !w || !h) return null;

  const bpp = color === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const prev = y ? out.slice((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    const cur = out.slice(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 255;
    }
  }
  return { buf: out, w, h, bpp };
}

module.exports = { pngHasPixel, pngPixels };
