(function() {
  'use strict';

  // ============================================================
  // teahouse-maintext-renderer.js — 默认正文渲染器
  // ============================================================

  var pageState = { floors: [], currentIndex: 0 };
  window.Teahouse._pageState = pageState;

  // ---- 自动跳转最新章节开关（默认开；状态持久化到 runtime var，刷新不丢） ----
  var autoJumpLatest = true;
  window.Teahouse._autoJumpLatest = autoJumpLatest;
  window.Teahouse.getVars(['auto_jump_latest']).then(function(entries) {
    if (entries && entries[0] && entries[0].value === false) {
      autoJumpLatest = false;
      window.Teahouse._autoJumpLatest = false;
      window.Teahouse._emit('autoJump.change', { value: false });
    }
  }).catch(function() {});

  // ---- 从路径提取章节号 ----
  function floorNumFromPath(path) {
    var m = String(path).match(/(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }

  // ---- 草稿标题标记：markdown 首行若是标题，则在末尾追加「（草稿）」（防重复） ----
  function markDraftTitle(markdown) {
    var lines = String(markdown || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var m = /^(\s*#{1,6}\s+)(.+?)\s*$/.exec(lines[i]);
      if (m) {
        var title = m[2].replace(/（草稿）\s*$/, '').trim();
        lines[i] = m[1] + title + '（草稿）';
        break;
      }
    }
    return lines.join('\n');
  }

  // ---- 章节标题提取 ----
  function titleOf(markdown, floor) {
    var lines = String(markdown || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var t = /^\s*#+\s+(.+)$/.exec(lines[i]);
      if (t) return t[1].trim();
    }
    return '第 ' + floor.num + ' 章' + (floor.draft ? '（草稿）' : '');
  }

  // ---- 正文渲染（单楼层，从文件读取） ----
  function renderFloor(floor) {
    var container = document.getElementById('teahouse-content');
    if (!container) return;

    window.Teahouse.readText(floor.path).then(function(markdown) {
      if (markdown === null || markdown === undefined) {
        container.innerHTML = '<p style="opacity:.5;text-align:center;padding:3rem 0;">（楼层内容暂不可用）</p>';
        return;
      }
      if (floor.draft) markdown = markDraftTitle(markdown);
      return window.Teahouse.replacePlaceholders(markdown).then(function(text) {
        return window.Teahouse.renderRichText(text);
      }).then(function(html) {
        var chapter = document.createElement('article');
        chapter.className = 'teahouse-chapter';
        var body = document.createElement('div');
        body.className = 'teahouse-chapter-body';
        body.innerHTML = html;
        container.innerHTML = '';
        container.appendChild(chapter);
        chapter.appendChild(body);
      });
    }).catch(function(err) {
      console.error('[Maintext Renderer] renderFloor failed:', err);
    });
  }

  // ---- 流式草稿渲染（走 BBCode 解析，不替换变量——变量由后端在 Generate 前已解析） ----
  var draftRenderPending = false;

  function scheduleDraftRender() {
    if (draftRenderPending) return;
    draftRenderPending = true;
    window.requestAnimationFrame(function() {
      draftRenderPending = false;
      var draft = window.Teahouse.currentDraft;
      if (!draft) return;
      renderDraft(draft);
    });
  }

  function renderDraft(draft) {
    var container = document.getElementById('teahouse-content');
    if (!container) return;
    var text = markDraftTitle(draft.text || '');
    window.Teahouse.renderRichText(text).then(function(html) {
      var chapter = document.createElement('article');
      chapter.className = 'teahouse-chapter teahouse-generating';
      var body = document.createElement('div');
      body.className = 'teahouse-chapter-body';
      body.innerHTML = html;
      container.innerHTML = '';
      container.appendChild(chapter);
      chapter.appendChild(body);
    }).catch(function(err) {
      console.error('[Maintext Renderer] renderDraft failed:', err);
    });
  }

  // ---- 将 currentDraft 同步到翻页器 ----
  // draft 是 { path, text, accumulated_len }，从中提取章节号并虚拟一个 floor 条目
  function syncDraftToPageState(draft) {
    var num = floorNumFromPath(draft.path);
    if (!num) return;

    // 找是否已有此章节
    var idx = -1;
    for (var i = 0; i < pageState.floors.length; i++) {
      if (pageState.floors[i].num === num) { idx = i; break; }
    }

    if (idx >= 0) {
      // 已存在（旧 draft 或正式章），更新 draft 标记；
      // 保留已有真实标题（prefetch 到的正文首行），不要覆盖成「第 N 章」
      pageState.floors[idx].draft = true;
      if (!pageState.floors[idx].title) {
        pageState.floors[idx].title = '第 ' + num + ' 章';
      }
      pageState.currentIndex = idx;
    } else {
      // 新章，插入虚拟条目
      var entry = { num: num, path: draft.path, draft: true, title: '第 ' + num + ' 章' };
      pageState.floors.push(entry);
      pageState.floors.sort(function(a, b) { return a.num - b.num; });
      pageState.currentIndex = pageState.floors.length - 1;
    }
    emitPageChange();
  }

  // ---- 翻页 ----
  function renderCurrent() {
    var draft = window.Teahouse.currentDraft;
    if (draft) {
      renderDraft(draft);
      return;
    }
    if (!pageState.floors || pageState.floors.length === 0) return;
    renderFloor(pageState.floors[pageState.currentIndex]);
  }

  function goToPage(index) {
    if (index < 0 || index >= pageState.floors.length) return;
    pageState.currentIndex = index;
    renderCurrent();
    emitPageChange();
  }

  function emitPageChange() {
    window.Teahouse._emit('page.change', {
      index: pageState.currentIndex,
      total: pageState.floors.length
    });
  }

  // ---- 预取标题 ----
  // prefetch 全部完成后广播一次 page.change，让翻页器目录能刷新出真实标题
  function prefetchTitles(floors) {
    if (!floors || floors.length === 0) return;
    var pendingCount = 0;
    var doneCount = 0;
    for (var i = 0; i < floors.length; i++) {
      (function(floor) {
        pendingCount++;
        window.Teahouse.readText(floor.path).then(function(markdown) {
          if (markdown) floor.title = titleOf(markdown, floor);
        }).catch(function() {}).then(function() {
          doneCount++;
          if (doneCount === pendingCount) emitPageChange();
        });
      })(floors[i]);
    }
  }

  // ---- 统一楼层装载：排序 + 预取标题 ----
  // 所有 listFloors() 替换 pageState.floors 的入口都必须走这里，
  // 否则 listFloors 返回的对象不带 title，目录会全显示「第 N 章」
  function setFloors(floors) {
    if (!floors || floors.length === 0) return;
    pageState.floors = floors.slice().sort(function(a, b) { return a.num - b.num; });
    prefetchTitles(pageState.floors);
  }

  // ---- 楼层列表查询 ----
  function indexOfFloorPath(path) {
    for (var i = 0; i < pageState.floors.length; i++) {
      if (pageState.floors[i].path === path) return i;
    }
    return -1;
  }

  function findFloorByPath(path) {
    for (var i = 0; i < pageState.floors.length; i++) {
      if (pageState.floors[i].path === path) return pageState.floors[i];
    }
    return null;
  }

  function removeFloorByPath(path) {
    for (var i = 0; i < pageState.floors.length; i++) {
      if (pageState.floors[i].path === path) {
        pageState.floors.splice(i, 1);
        break;
      }
    }
  }

  function refreshFloorByPath(path) {
    var found = findFloorByPath(path);
    if (found) {
      // 落盘了 → 按文件名判断是否仍为草稿（floor-N-draft.md 仍算草稿）
      found.draft = /floor-\d+-draft\.md$/i.test(path);
      var isCurrent = pageState.floors[pageState.currentIndex] === found;
      window.Teahouse.readText(found.path).then(function(markdown) {
        if (markdown) {
          found.title = titleOf(markdown, found);
          emitPageChange();
          // 原地修改（Edit/WriteLine）且正在显示的章节 → 重读文件重渲染正文主体
          if (isCurrent) renderFloor(found);
        } else {
          // 文件已被删除 → 从列表移除 + 重载定位，避免残留幽灵章节
          removeFloorByPath(path);
          reloadAndRender();
        }
      }).catch(function() {
        // 读取失败同样按删除处理，防残留
        removeFloorByPath(path);
        reloadAndRender();
      });
      return;
    }
    // 列表过期 → 刷新列表后再匹配
    window.Teahouse.listFloors().then(function(floors) {
      if (floors && floors.length > 0) {
        setFloors(floors);
      }
      var found2 = findFloorByPath(path);
      if (found2) {
        // 新楼层落盘：若用户关闭了"自动跳转最新章节"，则停留在当前阅读位置不跳
        if (!autoJumpLatest && pageState.currentIndex < pageState.floors.length - 1) {
          // 保持当前页，仅刷新楼层元数据
          emitPageChange();
          return;
        }
        var idx = indexOfFloorPath(path);
        if (idx >= 0) pageState.currentIndex = idx;
        renderFloor(found2);
        emitPageChange();
      } else {
        reloadAndRender();
      }
    }).catch(function() {
      reloadAndRender();
    });
  }

  function reloadAndRender() {
    window.Teahouse.listFloors().then(function(floors) {
      if (floors && floors.length > 0) {
        setFloors(floors);
      }
      var curNum = pageState.floors[pageState.currentIndex] ?
        pageState.floors[pageState.currentIndex].num : null;
      var idx = -1;
      for (var i = 0; i < pageState.floors.length; i++) {
        if (pageState.floors[i].num === curNum) { idx = i; break; }
      }
      pageState.currentIndex = idx >= 0 ? idx : (pageState.floors.length - 1);
      renderCurrent();
      emitPageChange();
    }).catch(function() {});
  }

  // ---- output.refresh 处理 ----
  window.Teahouse.on('output.refresh', function(data) {
    var path = data && data.path;
    if (path) {
      if (path.indexOf('.teahouse/output/sandbox/') === 0) {
        return;
      }
      if (path.indexOf('.teahouse/output/floors/') === 0) {
        refreshFloorByPath(path);
        return;
      }
    }
    reloadAndRender();
  });

  // ---- 流式草稿变化：渲染 + 同步翻页器 ----
  window.Teahouse.on('draft.change', function(draft) {
    syncDraftToPageState(draft);
    scheduleDraftRender();
  });

  // 生成结束 → 等 output.refresh 落盘后切文件渲染
  window.Teahouse.on('generation.status', function(status) {
    if (status === 'done') {
      // currentDraft 已清空，下次 renderCurrent 会走文件路径
    }
  });

  // ---- 默认渲染入口 ----
  function defaultRender() {
    window.Teahouse.listFloors().then(function(floors) {
      if (!floors || floors.length === 0) return;
      setFloors(floors);
      pageState.currentIndex = pageState.floors.length - 1;
      renderCurrent();
      emitPageChange();
    }).catch(function(err) {
      console.error('[Maintext Renderer] defaultRender failed:', err);
    });
  }

  // ---- 初始化 ----
  defaultRender();

  window.goToPage = goToPage;
  window.renderCurrent = renderCurrent;

  // ---- 跳转最新一章 ----
  window.goToLatest = function() {
    if (!pageState.floors || pageState.floors.length === 0) return;
    goToPage(pageState.floors.length - 1);
    window.scrollTo(0, 0);
  };

  // ---- 回顶部 ----
  window.goToTop = function() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // ---- 自动跳转开关读写（悬浮球用） ----
  window.getAutoJumpLatest = function() { return autoJumpLatest; };
  window.setAutoJumpLatest = function(on) {
    autoJumpLatest = !!on;
    window.Teahouse._autoJumpLatest = autoJumpLatest;
    window.Teahouse.setVar({ auto_jump_latest: autoJumpLatest }).catch(function() {});
    window.Teahouse._emit('autoJump.change', { value: autoJumpLatest });
    return autoJumpLatest;
  };
})();
