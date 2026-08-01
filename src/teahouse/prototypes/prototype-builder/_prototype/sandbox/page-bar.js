(function() {
  /* 章节导航条 — 三部分结构
     ◀ 上一章 | N/M · 章节名（点击展开目录快速跳转） | 下一章 ▶
     当前查看章节高亮"阅读中"，最新章节显示"最新"徽标。 */

  var ACCENT = '#60a5fa';
  var LATEST = '#fbbf24';

  /* HTML 转义，防止 note 中的特殊字符破坏结构 */
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function chapterName(item) {
    return item.note || ('第 ' + item.epNum + ' 章');
  }

  /* 圆形箭头按钮基础样式 */
  var ARROW_BTN =
    'width:40px;height:40px;flex:none;' +
    'display:flex;align-items:center;justify-content:center;' +
    'background:rgba(0,0,0,0.62);color:#fff;' +
    'border:1px solid rgba(255,255,255,0.14);border-radius:50%;' +
    'backdrop-filter:blur(8px);cursor:pointer;font-size:13px;' +
    'transition:border-color 0.2s,opacity 0.2s;';

  /* ---- 模块级：更新导航条状态（进度文字 + 箭头启用态） ---- */
  function updateState() {
    var title = document.getElementById('chapter-nav-title');
    var prevBtn = document.getElementById('chapter-nav-prev');
    var nextBtn = document.getElementById('chapter-nav-next');
    if (!title || !prevBtn || !nextBtn) return;

    var st = window.Teahouse._pageState;
    if (!st || !st.blocks || st.blocks.length === 0) {
      title.textContent = '目录';
      prevBtn.disabled = true;
      nextBtn.disabled = true;
      prevBtn.style.opacity = '0.35';
      nextBtn.style.opacity = '0.35';
      return;
    }

    /* 升序定位当前章节，得出 N/M */
    var sorted = st.blocks.slice().sort(function(a, b) {
      return a.epNum - b.epNum;
    });
    var cur = st.blocks[st.currentIndex];
    var pos = -1;
    for (var i = 0; i < sorted.length; i++) {
      if (sorted[i].uuid === cur.uuid) { pos = i; break; }
    }
    var n = pos >= 0 ? pos + 1 : st.currentIndex + 1;
    var m = sorted.length;
    title.textContent = n + '/' + m + ' · ' + chapterName(cur);

    /* 箭头：上一章=已是最旧章节；下一章=已是最新章节时禁用 */
    var atFirst = st.currentIndex >= st.blocks.length - 1;
    var atLast = st.currentIndex <= 0;
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

    /* ---- 上一章 ---- */
    var prevBtn = document.createElement('button');
    prevBtn.id = 'chapter-nav-prev';
    prevBtn.title = '上一章';
    prevBtn.innerHTML = '&#9664;';
    prevBtn.style.cssText = ARROW_BTN;

    /* ---- 中间：当前进度 N/M + 章节名（点击展开目录） ---- */
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

    /* ---- 下一章 ---- */
    var nextBtn = document.createElement('button');
    nextBtn.id = 'chapter-nav-next';
    nextBtn.title = '下一章';
    nextBtn.innerHTML = '&#9654;';
    nextBtn.style.cssText = ARROW_BTN;

    /* ---- 下拉目录面板 ---- */
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

    function closePanel() {
      panel.style.display = 'none';
    }

    /* ---- 上一章 / 下一章 ----
       pageState.blocks 按 epNum 降序（最新章节在前，index=0 为最新）
       上一章 = index + 1（更旧），下一章 = index - 1（更新） */
    function goRelative(dir) {
      var st = window.Teahouse._pageState;
      if (!st || !st.blocks || st.blocks.length === 0) return;
      var target = dir < 0 ? st.currentIndex + 1 : st.currentIndex - 1;
      if (target < 0 || target >= st.blocks.length) return;
      closePanel();
      window.goToPage(target);
    }

    prevBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      goRelative(-1);
    });
    nextBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      goRelative(1);
    });

    /* ---- 触发器：展开/收起目录 ---- */
    trigger.addEventListener('click', function(e) {
      e.stopPropagation();
      var showing = panel.style.display !== 'none';
      if (showing) {
        closePanel();
      } else {
        renderMenu();
        panel.style.display = 'block';
      }
    });

    /* 点击外部关闭 */
    document.addEventListener('click', function(e) {
      if (!wrap.contains(e.target)) closePanel();
    });

    /* ---- 渲染章节列表 ---- */
    function renderMenu() {
      var state = window.Teahouse._pageState;
      if (!state || !state.blocks || state.blocks.length === 0) {
        panel.innerHTML =
          '<div style="padding:12px;color:#888;font-size:13px;text-align:center;">暂无章节</div>';
        return;
      }

      /* 按章节编号升序展示（第 1 章在最上） */
      var sorted = state.blocks.slice().sort(function(a, b) {
        return a.epNum - b.epNum;
      });
      var maxEp = sorted[sorted.length - 1].epNum; /* 最新章节编号 */
      var currentUuid = state.blocks[state.currentIndex].uuid;

      var html = '';
      for (var i = 0; i < sorted.length; i++) {
        var item = sorted[i];
        var isCurrent = item.uuid === currentUuid;
        var isLatest = item.epNum === maxEp;
        var name = esc(chapterName(item));

        html +=
          '<div class="chapter-nav-item" data-uuid="' + item.uuid + '" style="' +
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
          (isLatest && !isCurrent
            ? '<span style="flex:none;font-size:10px;color:' + LATEST + ';' +
              'border:1px solid rgba(251,191,36,0.5);padding:1px 7px;border-radius:10px;">最新</span>'
            : '') +
          '</div>';
      }
      panel.innerHTML = html;

      /* 悬停反馈 + 点击跳转 */
      var items = panel.querySelectorAll('.chapter-nav-item');
      for (var j = 0; j < items.length; j++) {
        (function(el) {
          el.addEventListener('mouseenter', function() {
            el.style.background = 'rgba(255,255,255,0.08)';
          });
          el.addEventListener('mouseleave', function() {
            el.style.background = '';
          });
          el.addEventListener('click', function(e) {
            e.stopPropagation();
            var uuid = el.getAttribute('data-uuid');
            var st = window.Teahouse._pageState;
            for (var k = 0; k < st.blocks.length; k++) {
              if (st.blocks[k].uuid === uuid) {
                window.goToPage(k);
                break;
              }
            }
            closePanel();
          });
        })(items[j]);
      }
    }

    /* 初始状态 */
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
