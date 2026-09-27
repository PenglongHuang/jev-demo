/* anno.js 纯几何测试（不起浏览器）：CSS 像素矩形 → 图像像素矩形的换算。
 *
 * 换算的比例**由调用方给定**（每个 CSS 像素对应多少图像像素），不再从「图宽/视口宽」推 ——
 * 那条路是错的，2026-09-28 在真机上量清楚了：
 *   playwright-cli 的 screenshot 默认是 css 档（不带 --hires），**图内容与页面 CSS 像素严格 1:1**；
 *   而画布尺寸 = innerWidth × 内容比例 / 页面缩放，也就是 imgW/innerWidth = 1/页面缩放。
 *   把画布比例当内容比例用，页面缩放不是 100% 时整片标注都会偏：
 *   B 站那次（用户 profile 里 bilibili 缩放 110%）视口 1396×654、图 1269×594，
 *   旧算法得 0.909（真值 1.0），搜索框的框画在 x=531 而元素在 584 —— 左偏 53px。
 * 所以：比例是**入参**，图尺寸只用来判断框还在不在图上。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const Anno = require(path.join(__dirname, '..', 'public', 'js', 'anno.js'));

test('css 档截图：内容与 CSS 像素 1:1，比例由调用方给定', () => {
  const b = Anno.annotationBox({ x: 100, y: 50, w: 200, h: 40 }, 1);
  assert.strictEqual(b.scale, 1);
  assert.deepStrictEqual([b.x, b.y, b.w, b.h], [100, 50, 200, 40]);
  /* 徽章圆心 = 框左上角外沿挂出去半格（默认不贴边） */
  assert.deepStrictEqual([b.center.x, b.center.y], [100 - 12 + 12, 50 - 12 + 12]);
});

test('回归：画布比视口窄（页面缩放 110%）时仍按 1:1 画，不跟着画布缩', () => {
  /* B 站那次实测：rect(584,22,218,20)、视口 1396×654、截图 1269×594。
   * 旧算法 scale = 1269/1396 = 0.909 → 框画到 x=531（元素在 584，左偏 53px）。 */
  const rect = { x: 584, y: 22, w: 218, h: 20 };
  const b = Anno.annotationBox(rect, 1);
  assert.strictEqual(b.x, 584, '框的左沿必须落在元素的 CSS 位置，不能被画布比例缩掉');
  assert.strictEqual(b.y, 22);
  assert.deepStrictEqual([b.w, b.h], [218, 20]);
  /* 而且这个框确实还在图上（画布 1269×594），不该被当成「出图」丢掉 */
  assert.strictEqual(Anno.visibleInImage(b, 1269, 594), true);
});

test('device 档（--hires）时比例是 devicePixelRatio，内容按比例放大', () => {
  /* 实测：hires 图内容 = CSS × devicePixelRatio（0.8333 的缩放下也不含糊） */
  const b = Anno.annotationBox({ x: 100, y: 50, w: 200, h: 40 }, 1.25);
  assert.strictEqual(b.scale, 1.25);
  assert.deepStrictEqual([b.x, b.y, b.w, b.h], [125, 62.5, 250, 50]);
  assert.strictEqual(b.badge.size, Anno.BADGE * 1.25);
});

test('贴到图像上/左边缘时徽章翻到框内侧，不被裁掉', () => {
  const b = Anno.annotationBox({ x: 4, y: 2, w: 300, h: 40 }, 1);
  assert.ok(b.center.x > 0 && b.center.x < 20, '徽章圆心应落在框内左侧：' + b.center.x);
  assert.ok(b.center.y > 0 && b.center.y < 20, '徽章圆心应落在框内上侧：' + b.center.y);
  assert.ok(b.badge.x >= 0 && b.badge.y >= 0, '徽章左/上边不能为负');
});

test('零尺寸元素也给出可见的最小框（8px）', () => {
  const b = Anno.annotationBox({ x: 10, y: 10, w: 0, h: 0 }, 1);
  assert.deepStrictEqual([b.w, b.h], [8, 8]);
});

test('缺少几何/比例非法时返回 null（调用方退回未标注原图），不抛错', () => {
  assert.strictEqual(Anno.annotationBox(null, 1), null);
  assert.strictEqual(Anno.annotationBox({ x: 1, y: 1, w: 2, h: 2 }, 0), null);
  assert.strictEqual(Anno.annotationBox({ x: 1, y: 1, w: 2, h: 2 }, null), null);
  assert.strictEqual(Anno.annotationBox({ x: 1, y: 1, w: 2, h: 2 }, 'abc'), null);
  assert.strictEqual(Anno.annotationBox({ x: NaN, y: 1, w: 2, h: 2 }, 1), null);
  /* 页面传回来的可能是字符串（JSON 往返），也必须认 */
  const b = Anno.annotationBox({ x: '10', y: '20', w: '30', h: '40' }, '1');
  assert.deepStrictEqual([b.x, b.y, b.w, b.h], [10, 20, 30, 40]);
});

test('visibleInImage：完全落在图外就不画（画半截比不画更误导）', () => {
  const box = (x, y, w, h) => ({ x: x, y: y, w: w, h: h, scale: 1 });
  assert.strictEqual(Anno.visibleInImage(box(100, 50, 200, 40), 1269, 594), true, '完整在图内');
  assert.strictEqual(Anno.visibleInImage(box(-10, 50, 200, 40), 1269, 594), true, '左边露出一部分');
  assert.strictEqual(Anno.visibleInImage(box(1200, 50, 200, 40), 1269, 594), true, '右边露出一部分');
  assert.strictEqual(Anno.visibleInImage(box(-300, 50, 200, 40), 1269, 594), false, '整个在左侧图外');
  assert.strictEqual(Anno.visibleInImage(box(1300, 50, 200, 40), 1269, 594), false, '整个在右侧图外');
  assert.strictEqual(Anno.visibleInImage(box(100, 700, 200, 40), 1269, 594), false, '整个在图下方');
  /* 实测过的真实情形：元素滚到视口下方（rect.y=1009 > 视口/图高 993） */
  assert.strictEqual(Anno.visibleInImage(box(889, 1009, 46, 25), 1922, 993), false, '元素在视口下方');
  assert.strictEqual(Anno.visibleInImage(box(100, 50, 200, 40), 0, 0), false, '图尺寸无效');
});
