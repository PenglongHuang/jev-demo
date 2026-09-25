/* anno.js 纯几何测试（不起浏览器）：CSS 像素矩形 → 图像像素矩形的换算。
 *
 * 为什么这块必须测：截图是设备像素、元素矩形是 CSS 像素，两者差一个
 * deviceScaleFactor。本项目窗口方案有「原生像素（scale 1）」「跟随屏幕（可能 1.25/1.5）」
 * 「固定尺寸」等，DPR 不固定，所以换算只能由同一时刻的 viewport 宽算出来。
 * 算错的话环会整体偏移或大小失真 —— 而且只在特定窗口方案下才看得出来。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const Anno = require(path.join(__dirname, '..', 'public', 'js', 'anno.js'));

test('scale = 图宽 / 视口宽：DPR 1 时一一对应（原生像素窗口）', () => {
  const b = Anno.annotationBox({ x: 100, y: 50, w: 200, h: 40 }, { w: 1920, h: 1080 }, 1920);
  assert.strictEqual(b.scale, 1);
  assert.deepStrictEqual([b.x, b.y, b.w, b.h], [100, 50, 200, 40]);
  /* 徽章圆心 = 框左上角外沿挂出去半格（默认不贴边） */
  assert.deepStrictEqual([b.center.x, b.center.y], [100 - 12 + 12, 50 - 12 + 12]);
});

test('scale 不为 1：Windows 125% 缩放下图比视口宽，标注必须跟着放大', () => {
  /* 视口 1536 CSS 像素、截图 1920 设备像素 → scale 1.25 */
  const b = Anno.annotationBox({ x: 100, y: 50, w: 200, h: 40 }, { w: 1536, h: 864 }, 1920);
  assert.strictEqual(b.scale, 1.25);
  assert.deepStrictEqual([b.x, b.y, b.w, b.h], [125, 62.5, 250, 50]);
  assert.strictEqual(b.badge.size, Anno.BADGE * 1.25);
});

test('贴到图像上/左边缘时徽章翻到框内侧，不被裁掉', () => {
  const b = Anno.annotationBox({ x: 4, y: 2, w: 300, h: 40 }, { w: 1000, h: 800 }, 1000);
  assert.ok(b.center.x > 0 && b.center.x < 20, '徽章圆心应落在框内左侧：' + b.center.x);
  assert.ok(b.center.y > 0 && b.center.y < 20, '徽章圆心应落在框内上侧：' + b.center.y);
  assert.ok(b.badge.x >= 0 && b.badge.y >= 0, '徽章左/上边不能为负');
});

test('零尺寸元素也给出可见的最小框（8px）', () => {
  const b = Anno.annotationBox({ x: 10, y: 10, w: 0, h: 0 }, { w: 100, h: 100 }, 100);
  assert.deepStrictEqual([b.w, b.h], [8, 8]);
});

test('缺少几何时返回 null（调用方退回未标注原图），不抛错', () => {
  assert.strictEqual(Anno.annotationBox(null, { w: 100, h: 100 }, 100), null);
  assert.strictEqual(Anno.annotationBox({ x: 1, y: 1, w: 2, h: 2 }, null, 100), null);
  assert.strictEqual(Anno.annotationBox({ x: 1, y: 1, w: 2, h: 2 }, { w: 0, h: 0 }, 100), null);
  assert.strictEqual(Anno.annotationBox({ x: 1, y: 1, w: 2, h: 2 }, { w: 100, h: 100 }, 0), null);
  assert.strictEqual(Anno.annotationBox({ x: NaN, y: 1, w: 2, h: 2 }, { w: 100, h: 100 }, 100), null);
  /* 页面传回来的可能是字符串（JSON 往返），也必须认 */
  const b = Anno.annotationBox({ x: '10', y: '20', w: '30', h: '40' }, { w: '100', h: '100' }, '100');
  assert.deepStrictEqual([b.x, b.y, b.w, b.h], [10, 20, 30, 40]);
});
