(function() {
  /* 章节导航条 — 三部分结构
     ◀ 上一章 | N/M · 章节名（点击展开目录快速跳转） | 下一章 ▶

     数据源：window.Teahouse._pageState.floors —— 由 bootstrap 从
     .teahouse/output/floors/ 读取，按楼层数字升序；currentIndex 指向当前展示楼层。 */

  var ACCENT = '#60a5fa';
  var LATEST = '#fbbf24';

  /* HTML 转义 */
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* 章节名：优先 floor.title（bootstrap 从正文首行提取），否则回退到"第 N 章" */
  function chapterName(floor) {
    if (floor.title) return floor.title;
    var n = floor.num + ' 章';
    return '第 ' + n + (floor.draft ? '（草稿）' : '');
  }

  var ARROW_BTN =
    'width:40px;height:40px;flex:none;' +
    'display:flex;align-items:center;justify-content:center;' +
    'background:rgba(0,0,0,0.62);color:#fff;' +
    'border:1px solid rgba(255,255,255,0.14);border-radius:50%;' +
    'backdrop-filter:blur(8px);cursor:pointer;font-size:13px;' +
    'transition:border-color 0.2s,opacity 0.2s;';

  function updateState() {
    var title = document.getElementById('chapter-nav-title');
    var prevBtn = document.getElementById('chapter-nav-prev');
    var nextBtn = document.getElementById('chapter-nav-next');
    if (!title || !prevBtn || !nextBtn) return;

    var st = window.Teahouse._pageState;
    if (!st || !st.floors || st.floors.length === 0) {
      title.textContent = '目录';
      prevBtn.disabled = true;
      nextBtn.disabled = true;
      prevBtn.style.opacity = '0.35';
      nextBtn.style.opacity = '0.35';
      return;
    }

    // floors 已按楼层数字升序；currentIndex 是数组下标（0 = 第 1 章）。
    // 打开时定位到最新章（currentIndex = length-1），故显示 N = currentIndex+1。
    var n = st.currentIndex + 1;
    var m = st.floors.length;
    var cur = st.floors[st.currentIndex];
    title.textContent = n + '/' + m + ' · ' + chapterName(cur);

    // ◀ 上一章 = 回首章方向（index-1）；▶ 下一章 = 往最新/后一页（index+1）。
    var atFirst = st.currentIndex <= 0;               /* 已是第 1 章 */
    var atLast = st.currentIndex >= st.floors.length - 1; /* 已是最新章 */
    prevBtn.disabled = atFirst;
    nextBtn.disabled = atLast;
    prevBtn.style.opacity = atFirst ? '0.35' : '1';
    nextBtn.style.opacity = atLast ? '0.35' : '1';
    prevBtn.style.cursor = atFirst ? 'not-allowed' : 'pointer';
    nextBtn.style.cursor = atLast ? 'not-allowed' : 'pointer';
  }

  function createNav() {
    var wrap = document.createElement('div');
    wrap.id = 'teahouse-chapter-nav';
    wrap.style.cssText =
      'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
      'z-index:300;user-select:none;display:flex;align-items:center;gap:10px;' +
      'font-family:"Noto Sans SC","PingFang SC",sans-serif;';

    var prevBtn = document.createElement('button');
    prevBtn.id = 'chapter-nav-prev';
    prevBtn.title = '上一章';
    prevBtn.innerHTML = '&#9664;';
    prevBtn.style.cssText = ARROW_BTN;

    var trigger = document.createElement('button');
    trigger.id = 'chapter-nav-trigger';
    trigger.style.cssText =
      'display:flex;align-items:center;' +
      'max-width:60vw;padding:0 18px;height:40px;' +
      'background:rgba(0,0,0,0.62);color:#fff;' +
      'border:1px solid rgba(255,255,255,0.14);border-radius:24px;' +
      'backdrop-filter:blur(8px);cursor:pointer;font-size:14px;' +
      'transition:border-color 0.2s;';

    var titleSpan = document.createElement('span');
    titleSpan.id = 'chapter-nav-title';
    titleSpan.style.cssText =
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    titleSpan.textContent = '目录';
    trigger.appendChild(titleSpan);

    var nextBtn = document.createElement('button');
    nextBtn.id = 'chapter-nav-next';
    nextBtn.title = '下一章';
    nextBtn.innerHTML = '&#9654;';
    nextBtn.style.cssText = ARROW_BTN;

    var panel = document.createElement('div');
    panel.id = 'chapter-nav-panel';
    panel.style.cssText =
      'position:absolute;bottom:calc(100% + 12px);left:50%;' +
      'transform:translateX(-50%);' +
      'min-width:250px;max-width:82vw;max-height:58vh;overflow-y:auto;' +
      'background:rgba(10,10,26,0.96);' +
      'border:1px solid rgba(255,255,255,0.12);border-radius:12px;' +
      'padding:6px;display:none;' +
      'box-shadow:0 10px 36px rgba(0,0,0,0.55);' +
      'backdrop-filter:blur(10px);';

    wrap.appendChild(prevBtn);
    wrap.appendChild(trigger);
    wrap.appendChild(nextBtn);
    wrap.appendChild(panel);

    function closePanel() { panel.style.display = 'none'; }

    function goRelative(dir) {
      var st = window.Teahouse._pageState;
      if (!st || !st.floors || st.floors.length === 0) return;
      // ◀ 上一章 (dir=-1) → 回首章方向 index-1；▶ 下一章 (dir=+1) → 后一页 index+1
      var target = st.currentIndex + dir;
      if (target < 0 || target >= st.floors.length) return;
      closePanel();
      window.goToPage(target);
    }

    prevBtn.addEventListener('click', function(e) { e.stopPropagation(); goRelative(-1); });
    nextBtn.addEventListener('click', function(e) { e.stopPropagation(); goRelative(1); });

    trigger.addEventListener('click', function(e) {
      e.stopPropagation();
      var showing = panel.style.display !== 'none';
      if (showing) { closePanel(); } else { renderMenu(); panel.style.display = 'block'; }
    });

    document.addEventListener('click', function(e) {
      if (!wrap.contains(e.target)) closePanel();
    });

    function renderMenu() {
      var state = window.Teahouse._pageState;
      if (!state || !state.floors || state.floors.length === 0) {
        panel.innerHTML =
          '<div style="padding:12px;color:#888;font-size:13px;text-align:center;">暂无章节</div>';
        return;
      }

      var sorted = state.floors.slice(); /* 已按楼层数字升序 */
      var maxNum = sorted[sorted.length - 1].num;
      var currentNum = state.floors[state.currentIndex].num;

      var html = '';
      for (var i = 0; i < sorted.length; i++) {
        var item = sorted[i];
        var isCurrent = item.num === currentNum;
        var isLatest = item.num === maxNum;
        var name = esc(chapterName(item));

        html +=
          '<div class="chapter-nav-item" data-num="' + item.num + '" style="' +
          'display:flex;align-items:center;gap:8px;' +
          'padding:9px 12px;border-radius:8px;cursor:pointer;font-size:13px;' +
          (isCurrent
            ? 'background:rgba(96,165,250,0.22);color:#fff;'
            : 'color:rgba(255,255,255,0.78);') +
          'transition:background 0.15s;">' +
          '<span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
          name + '</span>' +
          (isCurrent
            ? '<span style="flex:none;font-size:10px;color:' + ACCENT + ';' +
              'border:1px solid rgba(96,165,250,0.5);padding:1px 7px;border-radius:10px;">阅读中</span>'
            : '') +
          (item.draft
            ? '<span style="flex:none;font-size:10px;color:' + LATEST + ';' +
              'border:1px solid rgba(251,191,36,0.5);padding:1px 7px;border-radius:10px;">草稿</span>'
            : '') +
          '</div>';
      }
      panel.innerHTML = html;

      var items = panel.querySelectorAll('.chapter-nav-item');
      for (var j = 0; j < items.length; j++) {
        (function(el) {
          el.addEventListener('mouseenter', function() { el.style.background = 'rgba(255,255,255,0.08)'; });
          el.addEventListener('mouseleave', function() { el.style.background = ''; });
          el.addEventListener('click', function(e) {
            e.stopPropagation();
            var num = parseInt(el.getAttribute('data-num'), 10);
            var st = window.Teahouse._pageState;
            for (var k = 0; k < st.floors.length; k++) {
              if (st.floors[k].num === num) { window.goToPage(k); break; }
            }
            closePanel();
          });
        })(items[j]);
      }
    }

    updateState();
    return wrap;
  }

  /* ---- 注册 ---- */
  var nav = createNav();
  if (window.registerUI) {
    window.registerUI('teahouse-chapter-nav', nav);
  }
  window.Teahouse.on('page.change', updateState);
  updateState();
})();
