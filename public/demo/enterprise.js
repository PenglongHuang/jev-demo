/* ============================================================================
 * 企业外壳行为层（Enterprise Shell）—— 与 enterprise.css 配套，四个演示页共用
 *
 * ## 这条约束是从实测里来的，不是拍脑袋
 * tests/driver-smoke.spec.js 断言「读元素位置前后两次 aria 快照**逐字节一致**」，
 * tests/scenario-walk.spec.js 又靠 label 正则在快照里找 ref。0.1.17 实测（见
 * .tmp-review/probe-out.txt）确认了两件事：
 *
 *   1. **aria-hidden="true" 挡不住快照** —— 藏在 aria-hidden 里的走字时钟照样
 *      出现在快照里（`- generic [ref=e4]: "14:29:18 #16"`）。所以「把自变文本
 *      藏进 aria-hidden」这条路是死的。
 *   2. **任何页面自己动的文本都会让两次快照不一致**（实测 1.2 秒内两次快照
 *      就不相等）。toast 之所以没事，是因为它只切 class、文本一旦写下就不再变。
 *
 * 于是本文件所有「活性」都遵守一条硬规矩：
 *
 *   ▶ **开关关闭时（默认），首次渲染后页面不许再改一个字的 DOM 文本。**
 *     常开的动效一律走 CSS（见 enterprise.css：揭幕、描边、脉冲、跑马灯），
 *     CSS 动画不改 DOM，快照自然稳定。
 *   ▶ **JS 驱动的活性（走字时钟、同步状态轮转、周期到达、通知栈）一律由
 *     「实时模拟」开关解锁**，且只在该开关被用户显式打开后才起定时器。
 *     这既是技术约束，也是更清楚的语义：页面默认是确定的，打开开关它才开始活。
 *
 * 挂载点约定（页面只需给一个，其余由本文件自建）：
 *   .topbar       —— 存在就把铃铛/用户菜单/实时区/开关追加进去（右对齐）
 *   #entKpis      —— KPI 条容器
 *   --ent-maxw    —— 页面在 :root 覆写，让 KPI 条与主容器同宽
 * ==========================================================================*/
(function (global) {
  'use strict';

  var doc = global.document;

  /* ---------- 小工具 ---------- */
  function h(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function $(sel) { return doc.querySelector(sel); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function hhmmss(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); }
  function hhmm(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function money(n) { return '¥' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function int(n) { return n.toLocaleString('en-US'); }

  /* ==========================================================================
   * 1. 左侧模块 rail
   * ========================================================================*/

  function buildRail(cfg) {
    var rail = h('nav', 'ent-rail');
    rail.setAttribute('aria-label', '模块导航');
    rail.appendChild(h('div', 'ent-rail-logo', cfg.logo || '灵'));

    (cfg.modules || []).forEach(function (m) {
      if (m.sep) { rail.appendChild(h('div', 'ent-rail-sep')); return; }
      var b = h('button', 'ent-rail-item');
      b.type = 'button';
      b.appendChild(h('span', 'ent-rail-ico', m.icon));
      b.appendChild(h('span', 'ent-rail-txt', m.label));
      b.setAttribute('aria-label', m.label + (m.active ? '（当前模块）' : ''));
      if (m.active) b.setAttribute('aria-current', 'page');
      if (m.badge) b.appendChild(h('span', 'ent-rail-badge', String(m.badge)));
      b.onclick = function () { if (cfg.onPick) cfg.onPick(m); };
      rail.appendChild(b);
    });

    var foot = h('div', 'ent-rail-foot');
    var help = h('button', 'ent-rail-item');
    help.type = 'button';
    help.appendChild(h('span', 'ent-rail-ico', '？'));
    help.appendChild(h('span', 'ent-rail-txt', '帮助'));
    help.setAttribute('aria-label', '快捷键与帮助');
    help.onclick = openShortcuts;
    foot.appendChild(help);
    rail.appendChild(foot);

    doc.body.appendChild(rail);
    doc.body.classList.add('ent-has-rail');
    return rail;
  }

  /* ==========================================================================
   * 2. KPI 条 —— 数字一次写死终值，滚动感由 CSS 揭幕动效给
   * ========================================================================*/

  function sparkSVG(values, w, hh) {
    var svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ent-spark');
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + hh);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');   /* 纯装饰，藏掉不影响任何断言 */
    var min = Math.min.apply(null, values), max = Math.max.apply(null, values);
    var span = (max - min) || 1, n = values.length;
    var sx = function (i) { return n === 1 ? w / 2 : (i / (n - 1)) * w; };
    var sy = function (v) { return hh - 2 - ((v - min) / span) * (hh - 5); };
    var d = values.map(function (v, i) { return (i ? 'L' : 'M') + sx(i).toFixed(1) + ' ' + sy(v).toFixed(1); }).join(' ');
    var area = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    area.setAttribute('class', 'area');
    area.setAttribute('d', d + ' L' + w + ' ' + hh + ' L0 ' + hh + ' Z');
    var line = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    line.setAttribute('class', 'line');
    line.setAttribute('d', d);
    svg.appendChild(area);
    svg.appendChild(line);
    /* 用真实路径长度做描边动画：只写 CSS 变量，不改任何文本 */
    requestAnimationFrame(function () {
      try { line.style.setProperty('--ent-len', String(Math.ceil(line.getTotalLength()) + 1)); }
      catch (e) { /* 量不到就退回 CSS 默认值，只是动效略糙 */ }
    });
    return svg;
  }

  function kpiCard(it) {
    var card = h('div', 'ent-kpi');
    card.setAttribute('data-kpi', it.label);
    var top = h('div', 'ent-kpi-top');
    if (it.icon) top.appendChild(h('span', 'ent-kpi-ico', it.icon));
    top.appendChild(h('span', 'ent-kpi-label', it.label));
    card.appendChild(top);

    var val = h('div', 'ent-kpi-val');
    var num = h('span', null, String(it.value));
    num.setAttribute('data-kpi-value', '');
    val.appendChild(num);
    if (it.unit) val.appendChild(h('span', 'ent-kpi-unit', it.unit));
    if (it.delta) val.appendChild(h('span', 'ent-kpi-delta ' + (it.tone || 'flat'), it.delta));
    card.appendChild(val);

    if (it.spark && it.spark.length > 1) card.appendChild(sparkSVG(it.spark, 120, 26));
    else if (it.bar) {
      var bar = h('div', 'ent-kpi-bar');
      var fill = h('i', it.bar.tone || '');
      fill.style.width = it.bar.pct + '%';
      bar.appendChild(fill);
      card.appendChild(bar);
    }
    if (it.note) card.appendChild(h('div', 'ent-kpi-note', it.note));
    return card;
  }

  function buildKpis(host, items) {
    if (!host) return;
    clear(host);
    (items || []).forEach(function (it) { host.appendChild(kpiCard(it)); });
  }

  /** 只给「实时模拟」用：把某张 KPI 的数字改掉。默认态下绝不被调用。 */
  function bumpKpi(host, label, delta) {
    var card = host && host.querySelector('[data-kpi="' + label + '"]');
    var num = card && card.querySelector('[data-kpi-value]');
    if (!num) return;
    var cur = parseInt(String(num.textContent).replace(/[^\d-]/g, ''), 10);
    if (isNaN(cur)) return;
    num.textContent = int(cur + delta);
    card.classList.remove('ent-flash');
    void card.offsetWidth;          /* 重启动画，不改文本以外的任何东西 */
    card.classList.add('ent-flash');
  }

  /* ==========================================================================
   * 3. 通知中心（铃铛）/ 用户菜单 —— 打开才渲染，关闭即清空
   * ========================================================================*/

  function noticeItem(x) {
    var li = h('li', 'ent-pop-item' + (x.unread ? ' unread' : ''));
    li.appendChild(h('span', 'ent-pop-ico', x.icon || '•'));
    var main = h('div', 'ent-pop-main');
    main.appendChild(h('span', 'ent-pop-title', x.title));
    if (x.body) main.appendChild(h('span', 'ent-pop-body', x.body));
    main.appendChild(h('span', 'ent-pop-time', x.time));
    li.appendChild(main);
    return li;
  }

  function buildBell(cfg) {
    var slot = h('div', 'ent-slot');
    var btn = h('button', 'ent-iconbtn');
    btn.type = 'button';
    btn.appendChild(h('span', null, '🔔'));
    var unread = function () { return (cfg.notices || []).filter(function (x) { return x.unread; }).length; };
    var n0 = unread();
    if (n0) btn.appendChild(h('span', 'ent-iconbtn-dot', n0 > 99 ? '99+' : String(n0)));
    btn.setAttribute('aria-label', '通知中心，共 ' + (cfg.notices || []).length + ' 条，' + n0 + ' 条未读');
    btn.setAttribute('aria-expanded', 'false');
    slot.appendChild(btn);

    var pop = null;
    function close() {
      if (!pop) return;
      slot.removeChild(pop);
      pop = null;
      btn.setAttribute('aria-expanded', 'false');
    }
    function renderList(list) {
      clear(list);
      (cfg.notices || []).forEach(function (x) { list.appendChild(noticeItem(x)); });
    }
    function open() {
      if (pop) return close();
      pop = h('div', 'ent-pop');
      pop.setAttribute('role', 'dialog');
      pop.setAttribute('aria-label', '通知中心');
      var head = h('div', 'ent-pop-head');
      head.appendChild(h('span', null, '通知中心'));
      head.appendChild(h('span', 'ent-pop-sub', '共 ' + (cfg.notices || []).length + ' 条'));
      head.appendChild(h('span', 'spacer'));
      var all = h('button', 'ent-btn-mini', '全部已读');
      all.type = 'button';
      all.onclick = function () {
        (cfg.notices || []).forEach(function (x) { x.unread = false; });
        var dot = btn.querySelector('.ent-iconbtn-dot');
        if (dot) dot.remove();
        btn.setAttribute('aria-label', '通知中心，共 ' + (cfg.notices || []).length + ' 条，0 条未读');
        renderList(list);
        if (cfg.onRead) cfg.onRead();
      };
      head.appendChild(all);
      pop.appendChild(head);

      var list = h('ul', 'ent-pop-list');
      renderList(list);
      pop.appendChild(list);

      var foot = h('div', 'ent-pop-foot');
      foot.appendChild(h('span', 'ent-pop-sub', '仅展示最近 ' + (cfg.notices || []).length + ' 条'));
      var more = h('button', 'ent-btn-mini', '查看全部');
      more.type = 'button';
      more.onclick = function () { close(); if (cfg.onMore) cfg.onMore(); };
      foot.appendChild(more);
      pop.appendChild(foot);

      slot.appendChild(pop);
      btn.setAttribute('aria-expanded', 'true');
    }
    btn.onclick = open;
    doc.addEventListener('click', function (e) { if (pop && !slot.contains(e.target)) close(); });
    doc.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    return slot;
  }

  function buildUser(cfg) {
    var slot = h('div', 'ent-slot');
    var btn = h('button', 'ent-userbtn');
    btn.type = 'button';
    btn.appendChild(h('span', 'ent-avatar', cfg.initial || '张'));
    btn.appendChild(h('span', 'who', cfg.name));
    btn.setAttribute('aria-label', cfg.name + '（' + cfg.role + '）· 账号菜单');
    btn.setAttribute('aria-expanded', 'false');
    slot.appendChild(btn);

    var pop = null;
    function close() {
      if (!pop) return;
      slot.removeChild(pop);
      pop = null;
      btn.setAttribute('aria-expanded', 'false');
    }
    btn.onclick = function () {
      if (pop) return close();
      pop = h('div', 'ent-pop');
      pop.setAttribute('role', 'menu');
      pop.setAttribute('aria-label', '账号菜单');
      var head = h('div', 'ent-pop-head');
      head.appendChild(h('span', 'ent-avatar', cfg.initial || '张'));
      var box = h('div');
      box.appendChild(h('div', null, cfg.name));
      box.appendChild(h('div', 'ent-pop-sub', cfg.email));
      head.appendChild(box);
      pop.appendChild(head);

      var ul = h('ul', 'ent-menulist');
      (cfg.items || []).forEach(function (it) {
        if (it.sep) { ul.appendChild(h('li', 'ent-menu-sep')); return; }
        var li = h('li');
        var b = h('button', null);
        b.type = 'button';
        b.appendChild(h('span', null, it.icon || ''));
        b.appendChild(h('span', null, it.label));
        b.onclick = function () { close(); if (it.onPick) it.onPick(); };
        li.appendChild(b);
        ul.appendChild(li);
      });
      pop.appendChild(ul);
      slot.appendChild(pop);
      btn.setAttribute('aria-expanded', 'true');
    };
    doc.addEventListener('click', function (e) { if (pop && !slot.contains(e.target)) close(); });
    doc.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    return slot;
  }

  /* ==========================================================================
   * 4. 实时区（时钟 / 同步状态）——**只在「实时模拟」打开后才存在并开始走**
   *
   * 关着的时候这里是一片 0 宽的空壳，快照里连一个字都没有；打开才注入并
   * 每秒更新。这样默认态的实现就是「什么都不做」，而不是「做很多再藏起来」。
   * ========================================================================*/

  function createLiveBox() {
    var box = h('div', 'ent-topmeta');
    var clock = null, syncTxt = null, timer = null, started = 0;

    function tick() {
      clock.textContent = hhmm(new Date());
      var secs = Math.floor((Date.now() - started) / 1000);
      syncTxt.textContent = secs < 8 ? '已同步 · 刚刚'
        : secs < 60 ? '已同步 · ' + secs + ' 秒前'
        : '已同步 · ' + Math.floor(secs / 60) + ' 分钟前';
    }
    return {
      el: box,
      start: function () {
        if (timer) return;
        started = Date.now();
        box.appendChild(h('div', 'ent-clock', '--:--'));
        var s = h('div', 'ent-synced');
        s.appendChild(h('span', 'dot'));
        syncTxt = h('span', null, '已同步 · 刚刚');
        s.appendChild(syncTxt);
        box.appendChild(s);
        clock = box.querySelector('.ent-clock');
        tick();
        timer = setInterval(tick, 1000);
      },
      stop: function () {
        if (timer) { clearInterval(timer); timer = null; }
        clear(box);
        clock = syncTxt = null;
      },
      get running() { return Boolean(timer); },
    };
  }

  /* ==========================================================================
   * 5. 实时模拟开关 —— 默认关；打开才让数据自己动
   * ========================================================================*/

  function buildSimToggle(cfg) {
    var label = h('label', 'ent-sim');
    /* 刻意**不**加 title：title 会让 label 在快照里变成一个带长名字的 generic 节点，
     * 纯噪声。开关的用途由切换时的 toast 说明。 */
    var cb = doc.createElement('input');
    cb.type = 'checkbox';
    cb.setAttribute('aria-label', cfg.label || '实时模拟开关');
    label.appendChild(cb);
    label.appendChild(h('span', 'ent-switch'));
    var txt = h('span', null, cfg.offLabel || '实时模拟');
    label.appendChild(txt);

    cb.addEventListener('change', function () {
      label.classList.toggle('on', cb.checked);
      txt.textContent = cb.checked ? (cfg.onLabel || '模拟中') : (cfg.offLabel || '实时模拟');
      if (cfg.onChange) cfg.onChange(cb.checked);
    });
    return label;
  }

  /* ==========================================================================
   * 6. 通知栈（右下角）—— 只被「实时模拟」的到达事件调用
   * ========================================================================*/

  var toastHost = null;
  function ensureToastHost() {
    if (toastHost && doc.body.contains(toastHost)) return toastHost;
    toastHost = h('div', 'ent-toasts');
    doc.body.appendChild(toastHost);
    return toastHost;
  }
  function pushToast(o) {
    var host = ensureToastHost();
    var t = h('div', 'ent-toast');
    t.appendChild(h('span', 'ent-toast-ico', o.icon || '🔔'));
    var box = h('div');
    box.appendChild(h('b', null, o.title));
    if (o.meta) box.appendChild(h('span', 'ent-toast-meta', o.meta));
    t.appendChild(box);
    host.appendChild(t);
    while (host.children.length > 4) host.removeChild(host.firstChild);
    setTimeout(function () {
      t.classList.add('leaving');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 220);
    }, o.ms || 5200);
  }

  /* ==========================================================================
   * 7. 右侧抽屉 —— 关闭即清空，绝不把内容留在无障碍树里
   *    刻意不用 aria-modal：抽屉是辅助面板，不是模态框；用了会让
   *    playwright-cli 在打开期间拒绝快照（scenario-walk 里记过这个坑）。
   * ========================================================================*/

  var drawerEl = null, backdropEl = null, drawerBody = null, drawerTabs = null, lastFocus = null;

  function ensureDrawer() {
    if (drawerEl) return;
    backdropEl = h('div', 'ent-drawer-backdrop');
    backdropEl.hidden = true;
    backdropEl.onclick = closeDrawer;
    doc.body.appendChild(backdropEl);

    drawerEl = h('aside', 'ent-drawer');
    drawerEl.hidden = true;
    drawerEl.setAttribute('role', 'dialog');
    var head = h('div', 'ent-drawer-head');
    var title = h('h2', null, '');
    title.id = 'entDrawerTitle';
    drawerEl.setAttribute('aria-labelledby', 'entDrawerTitle');
    head.appendChild(title);
    var sub = h('span', 'ent-drawer-sub', '');
    sub.id = 'entDrawerSub';
    head.appendChild(sub);
    head.appendChild(h('span', 'spacer'));
    var x = h('button', 'ent-btn-mini', '关闭');
    x.type = 'button';
    x.onclick = closeDrawer;
    head.appendChild(x);
    drawerEl.appendChild(head);

    drawerTabs = h('div', 'ent-drawer-tabs');
    drawerTabs.setAttribute('role', 'tablist');
    drawerTabs.hidden = true;
    drawerEl.appendChild(drawerTabs);

    drawerBody = h('div', 'ent-drawer-body');
    drawerEl.appendChild(drawerBody);

    doc.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !drawerEl.hidden) closeDrawer(); });
    doc.body.appendChild(drawerEl);
  }

  function openDrawer(cfg) {
    ensureDrawer();
    lastFocus = doc.activeElement;
    drawerEl.querySelector('h2').textContent = cfg.title || '详情';
    doc.getElementById('entDrawerSub').textContent = cfg.sub || '';

    clear(drawerTabs);
    var tabs = cfg.tabs || [];
    if (tabs.length) {
      drawerTabs.hidden = false;
      tabs.forEach(function (t, i) {
        var b = h('button', null, t.label);
        b.type = 'button';
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
        b.onclick = function () {
          Array.prototype.forEach.call(drawerTabs.children, function (o) {
            o.setAttribute('aria-selected', o === b ? 'true' : 'false');
          });
          clear(drawerBody);
          drawerBody.appendChild(t.render());
        };
        drawerTabs.appendChild(b);
      });
      clear(drawerBody);
      drawerBody.appendChild(tabs[0].render());
    } else {
      drawerTabs.hidden = true;
      clear(drawerBody);
      if (cfg.render) drawerBody.appendChild(cfg.render());
    }

    var foot = drawerEl.querySelector('.ent-drawer-foot');
    if (foot) foot.remove();
    if (cfg.footer) {
      var f = h('div', 'ent-drawer-foot');
      f.appendChild(cfg.footer);
      drawerEl.appendChild(f);
    }

    drawerEl.hidden = false;
    backdropEl.hidden = false;
    requestAnimationFrame(function () {
      drawerEl.classList.add('show');
      backdropEl.classList.add('show');
    });
    var closeBtn = drawerEl.querySelector('.ent-drawer-head .ent-btn-mini');
    if (closeBtn) closeBtn.focus();
  }

  function closeDrawer() {
    if (!drawerEl || drawerEl.hidden) return;
    drawerEl.classList.remove('show');
    backdropEl.classList.remove('show');
    setTimeout(function () {
      drawerEl.hidden = true;
      backdropEl.hidden = true;
      /* 关闭即清空：隐藏内容不留在无障碍树里 */
      clear(drawerBody);
      clear(drawerTabs);
      drawerTabs.hidden = true;
    }, 240);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  /* ==========================================================================
   * 8. 骨架屏（仅用户触发刷新时用，默认态不会出现）
   * ========================================================================*/

  function skeleton(host, ms, done) {
    var box = h('div', 'ent-skel');
    for (var i = 0; i < 5; i++) {
      var row = h('div', 'ent-skel-row');
      row.appendChild(h('div', 'ent-skel-bar avatar'));
      row.appendChild(h('div', 'ent-skel-bar w1'));
      row.appendChild(h('div', 'ent-skel-bar w2'));
      row.appendChild(h('div', 'ent-skel-bar w3'));
      box.appendChild(row);
    }
    var prevPos = host.style.position;
    host.style.position = 'relative';
    host.appendChild(box);
    setTimeout(function () {
      if (box.parentNode) box.parentNode.removeChild(box);
      host.style.position = prevPos;
      if (done) done();
    }, ms);
  }

  /* ==========================================================================
   * 9. 底部状态栏 + 公告跑马灯
   *    「实时」那一格由 createLiveBox 之外的东西驱动会破坏确定性，所以
   *    状态栏里只放静态文本 + 一个纯 CSS 脉冲的绿点（CSS 不动 DOM）。
   * ========================================================================*/

  function buildStatusbar(cfg) {
    var bar = h('div', 'ent-statusbar');
    (cfg.left || []).forEach(function (t) {
      var s = h('span');
      if (t.dot) s.appendChild(h('span', 'ent-status-dot'));
      s.appendChild(doc.createTextNode(t.text !== undefined ? t.text : t));
      bar.appendChild(s);
    });
    bar.appendChild(h('span', 'spacer'));
    (cfg.right || []).forEach(function (t) {
      bar.appendChild(h('span', null, t.text !== undefined ? t.text : t));
    });
    doc.body.appendChild(bar);
    doc.body.classList.add('ent-has-statusbar');
    return bar;
  }

  /** 公告跑马灯：内容固定，位移由 CSS keyframes 完成 —— 零 DOM 改动，常开安全 */
  function buildTicker(host, text) {
    if (!host) return null;
    var box = h('div', 'ent-ticker');
    box.appendChild(h('span', 'ent-ticker-tag', '系统公告'));
    var win = h('div', 'ent-ticker-window');
    var inner = h('div', 'ent-ticker-inner');
    inner.appendChild(h('span', null, text));
    win.appendChild(inner);
    box.appendChild(win);
    host.appendChild(box);
    return box;
  }

  /* ==========================================================================
   * 10. 快捷键帮助（按 ? 打开）
   * ========================================================================*/

  function openShortcuts() {
    var dlg = h('dialog');
    dlg.setAttribute('aria-label', '快捷键与帮助');
    var head = h('div', 'dlg-head');
    head.appendChild(h('span', null, '快捷键与帮助'));
    var x = h('button', 'btn', '关闭');
    x.type = 'button';
    x.onclick = function () { dlg.close(); };
    head.appendChild(x);
    dlg.appendChild(head);
    var body = h('div', 'dlg-body');
    var dl = h('dl', 'ent-kv');
    [['?', '打开本帮助'], ['Ctrl / ⌘ + K', '聚焦页面搜索框'], ['/', '同 Ctrl + K'],
     ['Esc', '关闭抽屉 / 弹窗'], ['Enter', '在搜索框内立即查询']].forEach(function (p) {
      var dt = h('dt');
      dt.appendChild(h('span', 'ent-kbd', p[0]));
      dl.appendChild(dt);
      dl.appendChild(h('dd', null, p[1]));
    });
    body.appendChild(dl);
    dlg.appendChild(body);
    doc.body.appendChild(dlg);
    dlg.addEventListener('close', function () { dlg.remove(); });
    dlg.showModal();
    x.focus();
  }

  function wireShortcuts(searchSel) {
    doc.addEventListener('keydown', function (e) {
      var tag = (e.target && e.target.tagName || '').toLowerCase();
      var typing = tag === 'input' || tag === 'textarea' || tag === 'select' || (e.target && e.target.isContentEditable);
      if (e.key === '?' && !typing) { e.preventDefault(); openShortcuts(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        var s = $(searchSel);
        if (s) { e.preventDefault(); s.focus(); if (s.select) s.select(); }
        return;
      }
      if (e.key === '/' && !typing) {
        var s2 = $(searchSel);
        if (s2) { e.preventDefault(); s2.focus(); }
      }
    });
  }

  /* ==========================================================================
   * 11. 实时模拟引擎 —— 页面注册 tick；关着时一个定时器都不起
   * ========================================================================*/

  function createSim(opt) {
    var timer = null, step = 0, on = false, listeners = [];
    function fire() {
      step += 1;
      listeners.forEach(function (fn) { try { fn(step); } catch (e) { /* 单个订阅出错不拖垮引擎 */ } });
    }
    return {
      get on() { return on; },
      get step() { return step; },
      subscribe: function (fn) {
        listeners.push(fn);
        return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
      },
      set: function (v) {
        on = Boolean(v);
        if (timer) { clearInterval(timer); timer = null; }
        if (!on) return;
        step = 0;
        timer = setInterval(fire, (opt && opt.everyMs) || 5000);
      },
    };
  }

  /* ==========================================================================
   * 12. 组装入口
   * ========================================================================*/

  function mountShell(cfg) {
    cfg = cfg || {};
    if (cfg.rail) buildRail(cfg.rail);

    var kpiHost = doc.getElementById('entKpis');
    if (kpiHost && cfg.kpis) buildKpis(kpiHost, cfg.kpis);
    if (cfg.ticker && cfg.tickerHost) buildTicker(doc.getElementById(cfg.tickerHost), cfg.ticker);

    var sim = createSim({ everyMs: (cfg.sim && cfg.sim.everyMs) || 5000 });
    var live = createLiveBox();

    var top = $('.topbar');
    if (top) {
      if (cfg.notices) top.appendChild(buildBell({ notices: cfg.notices, onMore: cfg.noticesMore }));
      if (cfg.user) top.appendChild(buildUser(cfg.user));
      top.appendChild(live.el);
      if (cfg.sim) {
        top.appendChild(buildSimToggle({
          label: cfg.sim.label || '实时模拟',
          onLabel: cfg.sim.onLabel || '模拟中',
          offLabel: cfg.sim.offLabel || '实时模拟',
          hint: cfg.sim.hint,
          onChange: function (v) {
            sim.set(v);
            if (v) { live.start(); pushToast({ icon: '▶', title: '已开启实时模拟', meta: '数据开始按固定节奏自行变化；关闭即恢复确定态' }); }
            else { live.stop(); pushToast({ icon: '⏸', title: '已关闭实时模拟', meta: '页面恢复为确定的初始数据' }); }
          },
        }));
      } else {
        top.appendChild(h('span', 'ent-sim-static', '演示数据 · 确定态'));
      }
    }

    if (cfg.statusbar) buildStatusbar(cfg.statusbar);
    wireShortcuts(cfg.searchSelector || 'input[type="search"]');
    if (cfg.onReady) cfg.onReady({ sim: sim, kpiHost: kpiHost, live: live });

    return { sim: sim, live: live, kpiHost: kpiHost };
  }

  global.Enterprise = {
    mountShell: mountShell,
    rail: buildRail,
    kpis: buildKpis,
    bumpKpi: bumpKpi,
    bell: buildBell,
    user: buildUser,
    sim: createSim,
    toast: pushToast,
    drawer: { open: openDrawer, close: closeDrawer },
    skeleton: skeleton,
    statusbar: buildStatusbar,
    ticker: buildTicker,
    shortcuts: openShortcuts,
    h: h, clear: clear, money: money, int: int, hhmm: hhmm, hhmmss: hhmmss,
  };
})(window);
