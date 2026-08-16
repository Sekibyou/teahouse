(function() {
  /* 悬浮球导航 — 右下角点击展开
     内含：上一章 ◀ | 进度 N/M（点开目录跳转）| 下一章 ▶
           回最新章节 / 回顶部 / 自动跳转开关
     数据源：window.Teahouse._pageState.floors（renderer 维护）
     章节名优先 floor.title，否则回退"第 N 章"
     层级：按钮 var(--z-trigger) / 弹窗 var(--z-panel)，规范见 theme.css */

  var ACCENT = 'var(--accent)';
  var PANEL_W = 264;

  /* HTML 转义 */
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function chapterName(floor) {
    var base = floor.title ? floor.title : '第 ' + floor.num + ' 章';
    return base + (floor.draft ? '（草稿）' : '');
  }

  /* ---------- 窄屏适配：底部输入条与右侧悬浮球不重叠 ----------
     输入条 width:min(92%,640px) 居中，右缘距右 = (w - min(92%w,640))/2；
     当 w < 776px 时该留白 < 68px（悬浮球占 right:22px + 46px 宽），两者重叠。
     窄屏时把右侧两个悬浮球（本组 chapter-fab + var-editor-fab）整体上移 +70px，
     避开输入条（wrap 顶部约 82px，两球落到 96/164px，留 14px 间隙，原 22px 间距保持）。
     用 !important 压过组件内联 bottom。 */
  var responsiveStyle = document.createElement('style');
  responsiveStyle.textContent =
    '@media (max-width: 779px){' +
    '#chapter-fab{bottom:96px !important;}' +
    '#chapter-fab-panel{bottom:calc(96px + 56px) !important;}' +
    '#var-editor-fab{bottom:164px !important;}' +
    '#var-editor-panel{bottom:calc(164px + 56px) !important;}' +
    '}';
  document.head.appendChild(responsiveStyle);

  /* ---------- 悬浮球按钮 ---------- */
  var fab = document.createElement('button');
  fab.id = 'chapter-fab';
  fab.type = 'button';
  fab.title = '导航';
  fab.innerHTML = '<span id="chapter-fab-icon" style="display:inline-block;transition:transform 0.25s;">&#9776;</span>';
  fab.style.cssText =
    'position:fixed;right:22px;bottom:26px;z-index:var(--z-trigger);' +
    'width:46px;height:46px;border-radius:50%;' +
    'display:flex;align-items:center;justify-content:center;' +
    'background:var(--fab-bg);color:var(--panel-text);' +
    'border:1px solid var(--panel-border);' +
    'backdrop-filter:blur(8px);cursor:pointer;font-size:16px;' +
    'box-shadow:0 6px 20px rgba(0,0,0,0.45);' +
    'transition:transform 0.2s,border-color 0.2s,background 0.25s,color 0.25s;' +
    'user-select:none;';

  var miniCount = document.createElement('span');
  miniCount.id = 'chapter-fab-count';
  miniCount.textContent = '';
  miniCount.style.cssText =
    'position:absolute;top:-4px;right:-4px;' +
    'min-width:18px;height:18px;padding:0 4px;border-radius:9px;' +
    'background:var(--accent-fill);color:var(--accent-filled-text);' +
    'font-size:10px;line-height:18px;font-weight:700;' +
    'display:none;align-items:center;justify-content:center;' +
    'font-variant-numeric:tabular-nums;white-space:nowrap;';
  fab.appendChild(miniCount);

  /* ---------- 展开面板 ---------- */
  var panel = document.createElement('div');
  panel.id = 'chapter-fab-panel';
  panel.style.cssText =
    'position:fixed;right:22px;bottom:calc(26px + 56px);z-index:var(--z-panel);' +
    'width:' + PANEL_W + 'px;max-width:88vw;' +
    'background:var(--panel);color:var(--panel-text);' +
    'border:1px solid var(--panel-border);border-radius:14px;' +
    'box-shadow:0 12px 40px rgba(0,0,0,0.6);' +
    'backdrop-filter:blur(10px);' +
    'display:none;overflow:hidden;' +
    'font-family:"Noto Sans SC","PingFang SC",sans-serif;';

  var html =
    /* 翻页行 */
    '<div style="display:flex;align-items:center;gap:6px;padding:10px 12px;' +
    'border-bottom:1px solid var(--panel-border);">' +
    '<button type="button" id="fab-prev" title="上一章" class="th-btn-ghost" style="' +
    'width:34px;height:34px;flex:none;border-radius:50%;font-size:12px;' +
    'display:flex;align-items:center;justify-content:center;padding:0;line-height:1;">&#9664;</button>' +
    '<button type="button" id="fab-count" title="当前章节进度" class="th-btn-ghost" style="' +
    'flex:1;height:34px;border-radius:17px;font-size:13px;' +
    'font-variant-numeric:tabular-nums;letter-spacing:0.04em;">0/0</button>' +
    '<button type="button" id="fab-next" title="下一章" class="th-btn-ghost" style="' +
    'width:34px;height:34px;flex:none;border-radius:50%;font-size:12px;' +
    'display:flex;align-items:center;justify-content:center;padding:0;line-height:1;">&#9654;</button>' +
    '</div>' +
    /* 目录列表 */
    '<div id="fab-list" style="max-height:220px;overflow-y:auto;padding:4px 6px;' +
    'border-bottom:1px solid var(--panel-border);"></div>' +
    /* 操作行 */
    '<div style="display:flex;align-items:center;gap:4px;padding:8px 10px;">' +
    '<button type="button" id="fab-latest" title="回最新章节" class="th-btn" style="' +
    'flex:1;height:30px;font-size:12px;">回最新</button>' +
    '<button type="button" id="fab-top" title="回顶部" class="th-btn-ghost" style="' +
    'flex:1;height:30px;font-size:12px;">回顶部</button>' +
    '<label id="fab-autolabel" title="新章节落盘时是否自动跳转" class="th-switch" style="' +
    'flex:1.2;height:30px;display:flex;align-items:center;justify-content:center;gap:6px;' +
    'border-radius:8px;user-select:none;">' +
    '<input type="checkbox" id="fab-auto">' +
    '<span class="th-switch-track"></span>' +
    '<span id="fab-auto-text">自动跳转</span></label>' +
    '</div>';

  panel.innerHTML = html;
  document.body.appendChild(fab);
  document.body.appendChild(panel);

  /* ---------- 引用元素 ---------- */
  var prevBtn = document.getElementById('fab-prev');
  var nextBtn = document.getElementById('fab-next');
  var countBtn = document.getElementById('fab-count');
  var listBox = document.getElementById('fab-list');
  var latestBtn = document.getElementById('fab-latest');
  var topBtn = document.getElementById('fab-top');
  var autoChk = document.getElementById('fab-auto');
  var autoText = document.getElementById('fab-auto-text');

  var DISABLED_OP = 0.35;
  function setBtnState(btn, disabled) {
    btn.disabled = disabled;
    btn.style.opacity = disabled ? DISABLED_OP : 1;
    btn.style.cursor = disabled ? 'not-allowed' : 'pointer';
  }

  /* ---------- 面板开合 ---------- */
  var open = false;
  function openPanel() {
    open = true;
    panel.style.display = 'block';
    document.getElementById('chapter-fab-icon').style.transform = 'rotate(90deg)';
    renderMenu();
    syncFab();
  }
  function closePanel() {
    open = false;
    panel.style.display = 'none';
    document.getElementById('chapter-fab-icon').style.transform = '';
  }
  fab.addEventListener('click', function(e) { e.stopPropagation(); open ? closePanel() : openPanel(); });

  /* ---------- 状态同步 ---------- */
  function getState() {
    return window.Teahouse._pageState || { floors: [], currentIndex: 0 };
  }

  function syncFab() {
    var st = getState();
    var n = st.floors.length;
    if (n === 0) {
      miniCount.style.display = 'none';
      countBtn.textContent = '0/0';
      setBtnState(prevBtn, true);
      setBtnState(nextBtn, true);
      return;
    }
    var cur = st.currentIndex + 1;
    countBtn.textContent = cur + '/' + n;
    miniCount.textContent = cur + '/' + n;
    miniCount.style.display = 'flex';
    setBtnState(prevBtn, st.currentIndex <= 0);
    setBtnState(nextBtn, st.currentIndex >= n - 1);
  }

  function syncAuto() {
    var v = window.getAutoJumpLatest ? window.getAutoJumpLatest() : true;
    autoChk.checked = v;
    autoText.textContent = v ? '自动跳转' : '手动翻页';
    autoText.style.color = v ? 'var(--accent-text)' : 'var(--panel-text-dim)';
  }

  /* ---------- 目录渲染 ---------- */
  function renderMenu() {
    var st = getState();
    if (!st.floors || st.floors.length === 0) {
      listBox.innerHTML = '<div style="padding:10px;color:var(--panel-text-dim);font-size:12px;text-align:center;">暂无章节</div>';
      return;
    }
    var maxNum = st.floors[st.floors.length - 1].num;
    var currentNum = st.floors[st.currentIndex].num;
    var html = '';
    for (var i = st.floors.length - 1; i >= 0; i--) {
      (function(item, i) {
        var isCurrent = item.num === currentNum;
        var isLatest = item.num === maxNum;
        var badge = '';
        if (isCurrent) badge = '<span style="color:var(--accent);font-size:10px;">阅读中</span>';
        else if (isLatest) badge = '<span style="color:var(--success);font-size:10px;">最新</span>';
        else if (item.draft) badge = '<span style="color:var(--warn);font-size:10px;">草稿</span>';
        html +=
          '<div class="fab-item" data-index="' + i + '" style="' +
          'display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px;' +
          'cursor:pointer;font-size:12.5px;' +
          (isCurrent ? 'background:var(--accent-soft);color:var(--panel-text);' : 'color:var(--panel-text-soft);') +
          '"><span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
          esc(chapterName(item)) + '</span>' + badge + '</div>';
      })(st.floors[i], i);
    }
    listBox.innerHTML = html;
    var items = listBox.querySelectorAll('.fab-item');
    for (var j = 0; j < items.length; j++) {
      (function(el) {
        var origBg = el.style.background;
        el.addEventListener('mouseenter', function() { el.style.background = 'var(--control-bg)'; });
        el.addEventListener('mouseleave', function() { el.style.background = origBg; });
        el.addEventListener('click', function() {
          var idx = parseInt(el.getAttribute('data-index'), 10);
          if (!isNaN(idx)) window.goToPage(idx);
          closePanel();
        });
      })(items[j]);
    }
  }

  /* ---------- 事件绑定 ---------- */
  prevBtn.addEventListener('click', function() {
    var st = getState();
    if (st.currentIndex > 0) window.goToPage(st.currentIndex - 1);
  });
  nextBtn.addEventListener('click', function() {
    var st = getState();
    if (st.currentIndex < st.floors.length - 1) window.goToPage(st.currentIndex + 1);
  });
  latestBtn.addEventListener('click', function() {
    if (window.goToLatest) window.goToLatest();
    closePanel();
  });
  topBtn.addEventListener('click', function() {
    if (window.goToTop) window.goToTop();
    closePanel();
  });
  autoChk.addEventListener('change', function() {
    if (window.setAutoJumpLatest) window.setAutoJumpLatest(autoChk.checked);
    syncAuto();
  });

  /* 点击外部收起 */
  document.addEventListener('click', function(e) {
    if (open && !panel.contains(e.target) && !fab.contains(e.target)) closePanel();
  });

  /* ---------- 事件订阅 ---------- */
  window.Teahouse.on('page.change', function() { syncFab(); if (open) renderMenu(); });
  window.Teahouse.on('autoJump.change', syncAuto);

  /* ---------- 挂载 ---------- */
  window.registerUI('teahouse-chapter-nav', fab);
  window.registerUI('teahouse-chapter-panel', panel);

  syncFab();
  syncAuto();
})();
