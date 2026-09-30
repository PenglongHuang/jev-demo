/* ===================== 步骤截图的元素标注（纯几何 + canvas 合成） =====================
 * 做什么：在**操作前**的那张步骤截图上，画出即将被操作元素的描边框 + 步号徽章。
 *
 * 四条设计约束（都是踩过坑换来的）：
 *  1. **标注画在图上，不画在页面上**。被驱动的浏览器窗口里不留任何痕迹 ——
 *     早先的版本往页面注入 overlay，人盯着窗口会看到环，也白白多一份污染快照的风险。
 *  2. **截图取自操作前**。此刻元素必定还在、位置唯一确定：
 *     画在动作后取位置的话，演示页「归档」「发货」点完就重渲染、ref 立刻失效，
 *     一条都标不出来；而且删行会让后续行往上顶，环会落到相邻行上（两种毛病都是实测的）。
 *  3. **比例由调用方给定，绝不从画布尺寸反推**。playwright-cli 的 screenshot 默认走 css 档
 *     （不带 --hires），2026-09-28 真机实测：**图内容与页面 CSS 像素严格 1:1**，
 *     而画布尺寸 = innerWidth × 内容比例 / 页面缩放 —— 也就是 imgW/innerWidth = 1/页面缩放，
 *     那是画布比例不是内容比例。旧算法拿它当比例，于是页面缩放不是 100% 时整片标注都偏：
 *     B 站那次（用户 profile 里 bilibili 存的是 110% 缩放）视口 1396×654、图 1269×594，
 *     旧算法得 0.909（真值 1.0），搜索框的框画在 x=531 而元素在 584 —— 左偏 53px。
 *     走 device 档（--hires）时比例是 devicePixelRatio，同样由调用方在同一时刻读出来传入。
 *  4. **框整个落在图外就不画**：元素已滚出视口、或被画布裁掉（页面缩放 >100% 时画布比内容小）
 *     时画半截，比明说「未标注」更误导。
 *
 * 纯逻辑无 DOM：浏览器挂 window.Anno，Node 走 module.exports（node:test 使用）。
 */
(function () {
  'use strict';

  /* 标注视觉规格（CSS 像素；画到图上时整体乘 scale） */
  var RING = 3;        /* 描边宽度 */
  var BADGE = 24;      /* 徽章直径 */
  var RING_COLOR = '#e11d48';
  var RING_FILL = 'rgba(225,29,72,0.12)';

  /* 字段缺失一律当「无效」处理，不能让它悄悄变成 0 ——
   * Number(null) 是 0、Number(undefined) 才是 NaN，直接 Number() 会把缺字段画成左上角的环。 */
  function num(v) {
    if (v === null || v === undefined || v === '') return NaN;
    return Number(v);
  }

  /* 把一个元素的 CSS 像素矩形，乘上「内容比例」换算成截图上的图像像素矩形。
   * scale = 每个 CSS 像素对应多少图像像素，**由调用方给定**（见文件头 3）：css 档恒为 1，
   * device 档是 devicePixelRatio。字段缺失或比例非法一律返回 null（调用方退回不标注的原图）。 */
  function annotationBox(rect, scale) {
    if (!rect) return null;
    var rw = num(rect.w), rh = num(rect.h), rx = num(rect.x), ry = num(rect.y);
    var s = num(scale);
    if (!isFinite(s) || s <= 0) return null;
    if (!isFinite(rx) || !isFinite(ry) || !isFinite(rw) || !isFinite(rh)) return null;

    var x = rx * s, y = ry * s;
    var w = Math.max(rw * s, 8), h = Math.max(rh * s, 8);
    /* 徽章挂在框左上角外沿；贴到图像上/左边缘时翻到框内侧，免得被裁掉半个 */
    var half = (BADGE / 2) * s;
    var bx = (x - half < 0) ? x + 2 * s : x - half;
    var by = (y - half < 0) ? y + 2 * s : y - half;
    return {
      x: x, y: y, w: w, h: h, scale: s,
      badge: { x: bx, y: by, size: BADGE * s },
      /* 徽章圆心：E2E 直接采这个像素来证明「标注真的在显示的那张图上」 */
      center: { x: bx + half, y: by + half },
    };
  }

  /* 框是否还露在图上（至少有一部分）。box 为空、或图尺寸无效 → false。
   * 判据用「框与图像矩形是否相交」，两侧都要判：元素往上滚出和往右滚出都会发生。 */
  function visibleInImage(box, imgW, imgH) {
    if (!box) return false;
    var iw = num(imgW), ih = num(imgH);
    if (!isFinite(iw) || iw <= 0 || !isFinite(ih) || ih <= 0) return false;
    if (box.x + box.w <= 0 || box.y + box.h <= 0) return false;   /* 整个在左 / 上之外 */
    if (box.x >= iw || box.y >= ih) return false;                 /* 整个在右 / 下之外 */
    return true;
  }

  /* 在 canvas 上画：原图 + 框 + 徽章 + 步号。返回画好的 canvas。 */
  function drawAnnotation(canvas, img, box, stepNo) {
    var ctx = canvas.getContext('2d');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    ctx.drawImage(img, 0, 0);

    var s = box.scale, radius = 4 * s;
    ctx.save();
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(box.x, box.y, box.w, box.h, radius);
    else ctx.rect(box.x, box.y, box.w, box.h);
    ctx.fillStyle = RING_FILL;
    ctx.fill();
    ctx.lineWidth = RING * s;
    ctx.strokeStyle = RING_COLOR;
    ctx.stroke();

    /* 徽章：白圈 + 投影，保证在深色/花哨页面上也能看清 */
    var cx = box.center.x, cy = box.center.y, r = box.badge.size / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = RING_COLOR;
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 4 * s;
    ctx.shadowOffsetY = 1 * s;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.lineWidth = 3 * s;
    ctx.strokeStyle = '#fff';
    ctx.stroke();

    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 ' + (13 * s) + 'px -apple-system, "Segoe UI", sans-serif';
    ctx.fillText(String(stepNo), cx, cy + 0.5 * s);
    ctx.restore();
    return canvas;
  }

  /* 合成入口：吃截图 dataURL、元素矩形与内容比例，吐出带标注的 dataURL。
   * 失败一律退回原图（标注失败不该让这一步没有图），错误原因一并返回给调用方展示。 */
  function compose(dataUrl, rect, scale, stepNo) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
        var box = annotationBox(rect, scale);
        if (!box) return resolve({ dataUrl: dataUrl, box: null, error: '缺少元素位置或换算比例，未标注' });
        if (!visibleInImage(box, iw, ih)) {
          return resolve({ dataUrl: dataUrl, box: null, error: '元素不在截图范围内（已滚出视口或被画布裁掉），未标注' });
        }
        try {
          var canvas = document.createElement('canvas');
          drawAnnotation(canvas, img, box, stepNo);
          resolve({ dataUrl: canvas.toDataURL('image/png'), box: box, error: null });
        } catch (e) {
          resolve({ dataUrl: dataUrl, box: null, error: '画标注失败：' + ((e && e.message) || String(e)) });
        }
      };
      img.onerror = function () { resolve({ dataUrl: dataUrl, box: null, error: '截图解码失败' }); };
      img.src = dataUrl;
    });
  }

  var api = {
    annotationBox: annotationBox, visibleInImage: visibleInImage, drawAnnotation: drawAnnotation,
    compose: compose, RING: RING, BADGE: BADGE,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.Anno = api;
})();
