/* ===================== 步骤截图的元素标注（纯几何 + canvas 合成） =====================
 * 做什么：在**操作前**的那张步骤截图上，画出即将被操作元素的描边框 + 步号徽章。
 *
 * 三条设计约束（都是踩过坑换来的）：
 *  1. **标注画在图上，不画在页面上**。被驱动的浏览器窗口里不留任何痕迹 ——
 *     早先的版本往页面注入 overlay，人盯着窗口会看到环，也白白多一份污染快照的风险。
 *  2. **截图取自操作前**。此刻元素必定还在、位置唯一确定：
 *     画在动作后取位置的话，演示页「归档」「发货」点完就重渲染、ref 立刻失效，
 *     一条都标不出来；而且删行会让后续行往上顶，环会落到相邻行上（两种毛病都是实测的）。
 *  3. **尺寸随图缩放**。截图是设备像素、元素矩形是 CSS 像素，两者差一个
 *     deviceScaleFactor（本项目有原生像素/固定尺寸等窗口方案，DPR 不固定），
 *     所以 scale = 图宽 / 视口宽 必须由同一时刻的两个数算出来，不能猜。
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

  /* 把一个元素的 CSS 像素矩形，换算成截图上的图像像素矩形。
   * rect/viewport 来自同一时刻的页内读数；imgW 是截图的真实像素宽度（解码后才知道）。
   * 任一缺失或不可除就返回 null（调用方退回「不标注的原图」）。 */
  function annotationBox(rect, viewport, imgW) {
    if (!rect || !viewport) return null;
    var rw = num(rect.w), rh = num(rect.h), rx = num(rect.x), ry = num(rect.y);
    var vw = num(viewport.w);
    var iw = num(imgW);
    if (!isFinite(rx) || !isFinite(ry) || !isFinite(rw) || !isFinite(rh)) return null;
    if (!isFinite(vw) || vw <= 0 || !isFinite(iw) || iw <= 0) return null;

    var scale = iw / vw;
    var x = rx * scale, y = ry * scale;
    var w = Math.max(rw * scale, 8), h = Math.max(rh * scale, 8);
    /* 徽章挂在框左上角外沿；贴到图像上/左边缘时翻到框内侧，免得被裁掉半个 */
    var half = (BADGE / 2) * scale;
    var bx = (x - half < 0) ? x + 2 * scale : x - half;
    var by = (y - half < 0) ? y + 2 * scale : y - half;
    return {
      x: x, y: y, w: w, h: h, scale: scale,
      badge: { x: bx, y: by, size: BADGE * scale },
      /* 徽章圆心：E2E 直接采这个像素来证明「标注真的在显示的那张图上」 */
      center: { x: bx + half, y: by + half },
    };
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

  /* 合成入口：吃截图 dataURL 与几何，吐出带标注的 dataURL。
   * 失败一律退回原图（标注失败不该让这一步没有图），错误原因一并返回给调用方展示。 */
  function compose(dataUrl, rect, viewport, stepNo) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        var box = annotationBox(rect, viewport, img.naturalWidth || img.width);
        if (!box) return resolve({ dataUrl: dataUrl, box: null, error: '缺少元素位置或视口尺寸，未标注' });
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

  var api = { annotationBox: annotationBox, drawAnnotation: drawAnnotation, compose: compose, RING: RING, BADGE: BADGE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.Anno = api;
})();
