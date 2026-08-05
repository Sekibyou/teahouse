(function() {
  'use strict';

  // ============================================================
  // Teahouse Sandbox Bootstrap
  // 参考实现 — 创作者可替换整个文件
  //
  // 文件系统驱动的展示模型：
  //   - 正文历史位于 .teahouse/output/floors/，靠文件名中间数字排序
  //     （floor-5.md / floor-5-draft.md），由 Teahouse.listFloors() 提供
  //   - 沙盒通过 Teahouse.readText(path) + Teahouse.renderRichText() 渲染正文
  //   - 宿主在楼上文件变更时推送 'output.refresh'，沙盒据此重读刷新
  // ============================================================

  // ---- 内部状态 ----
  var uiComponents = {};
  var eventCallbacks = {};
  var uiQueue = [];
  var uiLayerReady = false;

  // ---- Teahouse API 桥（通过 postMessage 调用宿主） ----
  function callHost(method, args) {
    return new Promise(function(resolve, reject) {
      var callId = 'call_' + Math.random().toString(36).substr(2, 9);
      var handler = function(e) {
        if (e.data && e.data._callId === callId) {
          window.removeEventListener('message', handler);
          if (e.data._error) {
            reject(new Error(e.data._error));
          } else {
            resolve(e.data._result);
          }
        }
      };
      window.addEventListener('message', handler);
      window.parent.postMessage({ _method: method, _args: args, _callId: callId }, '*');
    });
  }

  // ---- Teahouse 公开 API ----
  window.Teahouse = {
    // 楼层（正文历史）——按文件名数字排序，由宿主从 .teahouse/output/floors/ 读取
    listFloors: function() { return callHost('listFloors', []); },

    // 文件操作
    //   readText(path)                — 读 UTF-8 文本（floors/设定/配置），返回 string；二进制文件请用 readAsset
    //   readAsset(path)               — 读二进制资源（图片/gif/音频/字体…），返回可直接用作 src 的 data URL
    //   writeFile(path, content)      — 写文本文件
    readText: function(path) { return callHost('readText', [path]); },
    readAsset: function(path) { return callHost('readAsset', [path]); },
    writeFile: function(path, content) { return callHost('writeFile', [path, content]); },

    // 预设脚本流水线（无导演独立执行，一次性返回汇总 + 失败即停）
    //   runBatch(path, args?) — 执行 settings/ 等处的 jsonl 脚本；args 并入每一步
    runBatch: function(path, args) { return callHost('runBatch', [path, args]); },

    // 实例变量（setVar 落盘到 .teahouse/runtime_vars.jsonl，文件即状态）
    //   setVar(updates)              — {name:value} 合并写；返回写后全部变量 [{name,value,note?,change_log?}]
    //   setVar({updates,note,change_log,delete}) — 可带元数据：note 覆盖、change_log 追加、delete 删名
    //   getVars(names)               — 按名读取；返回 [{name,value,note?,change_log?}]
    setVar: function(updates, extra) {
      if (extra && typeof extra === 'object') {
        return callHost('setVar', [{ updates: updates, note: extra.note, change_log: extra.change_log, delete: extra.delete }]);
      }
      return callHost('setVar', [updates]);
    },
    getVars: function(names) { return callHost('getVars', [names || []]); },

    // 变量字面量替换（手动/兜底一键替换）
    //   replacePlaceholders(text?) — 把 text（或整页正文）里所有 ${name} 字面量替换为变量值。
    //   沙盒默认【不】自动替换正文里的 ${name}，因为渲染层必须接触原始正文、且需要机会做
    //   特效特写（如 ${user_name} → 正则 → [rainbow]李四[/rainbow]）。
    //   需要时手动调用本函数统一替换，或关闭下方 defaultRender 里的默认调用。
    replacePlaceholders: function(text) {
      return window.Teahouse.getVars([]).then(function(entries) {
        if (!entries || entries.length === 0) return text;
        var map = {};
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].value === null || entries[i].value === undefined) continue;
          map[entries[i].name] = String(entries[i].value);
        }
        var apply = function(s) {
          if (!s) return s;
          return s.replace(/\$\{([^}]+)\}/g, function(m, name) {
            return Object.prototype.hasOwnProperty.call(map, name) ? map[name] : m;
          });
        };
        if (text !== undefined && text !== null) return apply(text);
        // 没传 text：对整页正文做兜底替换（默认关闭，见 defaultRender 注释）
        var content = document.getElementById('teahouse-content');
        if (content && !content.dataset.varsReplaced) {
          content.dataset.varsReplaced = '1';
          content.innerHTML = apply(content.innerHTML);
        }
        return content ? content.innerHTML : text;
      });
    },

    // 发送消息
    send: function(message) { callHost('send', [message]); },

    // 富文本渲染（宿主解析 BBCode/着色/Markdown）
    renderRichText: function(text) { return callHost('renderRichText', [text]); },

    // 事件监听
    on: function(event, callback) {
      if (!eventCallbacks[event]) eventCallbacks[event] = [];
      eventCallbacks[event].push(callback);
    },
    off: function(event, callback) {
      if (!eventCallbacks[event]) return;
      eventCallbacks[event] = eventCallbacks[event].filter(function(cb) { return cb !== callback; });
    },

    // 内部使用：事件分发
    _emit: function(event, data) {
      if (!eventCallbacks[event]) return;
      eventCallbacks[event].forEach(function(cb) { cb(data); });
    }
  };

  // ---- 监听宿主推送的事件 ----
  window.addEventListener('message', function(e) {
    var d = e.data;
    if (!d || !d._type) return;
    if (d._type === '_teahouse_event') {
      window.Teahouse._emit(d._event, d._data);
    } else {
      switch (d._type) {
        case 'tool_call':
        case 'tool_result':
        case 'thinking':
          window.Teahouse._emit(d._type, d._payload);
          break;
      }
    }
  });

  // ---- UI 组件管理 ----
  function registerUI(label, element) {
    if (uiComponents[label]) {
      uiComponents[label].remove();
    }
    uiComponents[label] = element;
    if (uiLayerReady) {
      document.getElementById('teahouse-ui-layer').appendChild(element);
    } else {
      uiQueue.push({ label: label, element: element });
    }
  }

  function flushUIQueue() {
    var layer = document.getElementById('teahouse-ui-layer');
    if (!layer) return;
    for (var i = 0; i < uiQueue.length; i++) {
      var item = uiQueue[i];
      layer.appendChild(item.element);
      uiComponents[item.label] = item.element;
    }
    uiQueue.length = 0;
  }

  // ---- 默认渲染：按楼层文件名数字渲染正文（带翻页） ----
  // 翻页状态：共享给 UI 组件读写。
  //   floors:        [{ num, path, draft }] 按楼层数字升序
  //   currentIndex:  当前展示的楼层下标（0 = 最新一层）
  var pageState = { floors: [], currentIndex: 0 };
  window.Teahouse._pageState = pageState;

  function defaultRender() {
    window.Teahouse.listFloors().then(function(floors) {
      if (!floors || floors.length === 0) return;
      // 沙盒内按楼层数字升序；展示时最新（数字最大）在前
      pageState.floors = floors.slice().sort(function(a, b) { return a.num - b.num; });
      pageState.currentIndex = pageState.floors.length - 1;
      renderCurrent();
      prefetchTitles(pageState.floors);
      // 默认对整页做一次变量兜底替换。若你的正文里有 ${user_name} 这类想保留做特效特写的
      // 字面量，删掉这行即可（或用 Teahouse.replacePlaceholders(text) 仅在指定时机手动替换）。
      window.Teahouse.replacePlaceholders();
      window.Teahouse._emit('page.change', { index: pageState.currentIndex, total: pageState.floors.length });
    }).catch(function(err) {
      console.error('[Teahouse Bootstrap] defaultRender failed:', err);
    });
  }

  function renderCurrent() {
    if (!pageState.floors || pageState.floors.length === 0) return;
    var floor = pageState.floors[pageState.currentIndex];
    renderFloor(floor);
  }

  // 为每个楼层异步预取标题（page-bar 的目录显示用），不阻塞展示
  function prefetchTitles(floors) {
    if (!floors) return;
    var pending = 0;
    for (var i = 0; i < floors.length; i++) {
      (function(floor) {
        pending++;
        window.Teahouse.readText(floor.path).then(function(markdown) {
          if (markdown) floor.title = titleOf(markdown, floor);
        }).catch(function() {}).then(function() { pending--; return null; });
      })(floors[i]);
    }
  }

  function goToPage(index) {
    if (index < 0 || index >= pageState.floors.length) return;
    pageState.currentIndex = index;
    renderCurrent();
    window.Teahouse._emit('page.change', { index: index, total: pageState.floors.length });
  }

  // 从楼层正文提取首行标题（如 "# 第X章 · 标题"），无则回退到楼层名
  function titleOf(markdown, floor) {
    var lines = String(markdown || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var t = /^\s*#+\s+(.+)$/.exec(lines[i]);
      if (t) return t[1].trim();
    }
    return '第 ' + floor.num + ' 章' + (floor.draft ? '（草稿）' : '');
  }

  function renderFloor(floor) {
    var container = document.getElementById('teahouse-content');
    if (!container) return;

    window.Teahouse.readText(floor.path).then(function(markdown) {
      if (markdown === null || markdown === undefined) {
        // 半正式稿刚被删除/迁移——回退显示空
        container.innerHTML = '<p style="opacity:.5;text-align:center;padding:3rem 0;">（楼层内容暂不可用）</p>';
        return;
      }
      return window.Teahouse.renderRichText(markdown).then(function(html) {
        // 小说式整章渲染：章节标题 + 连续正文（保留 <hr> 作为页内分隔）
        var chapter = document.createElement('article');
        chapter.className = 'teahouse-chapter';

        var header = document.createElement('header');
        header.className = 'teahouse-chapter-title';
        header.textContent = titleOf(markdown, floor);
        chapter.appendChild(header);

        var body = document.createElement('div');
        body.className = 'teahouse-chapter-body';
        body.innerHTML = html;
        chapter.appendChild(body);

        container.innerHTML = '';
        container.appendChild(chapter);
      });
    }).catch(function(err) {
      console.error('[Teahouse Bootstrap] renderFloor failed:', err);
    });
  }

  // ---- 宿主推送事件处理 ----
  // output.refresh：.teahouse 下文件变更（含 floors、sandbox、样式），重新拉楼层并刷新展示
  window.Teahouse.on('output.refresh', function(data) {
    if (data && data.path && data.path.indexOf('.teahouse/output/sandbox/') === 0) {
      // 沙盒代码变了会触发宿主重建 iframe（本实例直接销毁重建），无需处理
      return;
    }
    reloadAndRender();
  });

  function reloadAndRender() {
    window.Teahouse.listFloors().then(function(floors) {
      if (floors && floors.length > 0) {
        pageState.floors = floors.slice().sort(function(a, b) { return a.num - b.num; });
      }
      // 尽量停留在当前楼层：按 num 匹配，否则回到最新
      var curNum = pageState.floors[pageState.currentIndex] ?
        pageState.floors[pageState.currentIndex].num : null;
      var idx = -1;
      for (var i = 0; i < pageState.floors.length; i++) {
        if (pageState.floors[i].num === curNum) { idx = i; break; }
      }
      pageState.currentIndex = idx >= 0 ? idx : (pageState.floors.length - 1);
      renderCurrent();
      prefetchTitles(pageState.floors);
      window.Teahouse.replacePlaceholders();
      window.Teahouse._emit('page.change', { index: pageState.currentIndex, total: pageState.floors.length });
    }).catch(function() {});
  }

  // ---- 初始化 ----
  function ensureContainers() {
    if (!document.getElementById('teahouse-content')) {
      var contentDiv = document.createElement('div');
      contentDiv.id = 'teahouse-content';
      contentDiv.className = 'teahouse-content';
      document.body.appendChild(contentDiv);
    }
    if (!document.getElementById('teahouse-ui-layer')) {
      var uiLayer = document.createElement('div');
      uiLayer.id = 'teahouse-ui-layer';
      uiLayer.className = 'teahouse-ui-layer';
      document.body.appendChild(uiLayer);
    }
  }

  function boot() {
    ensureContainers();
    uiLayerReady = true;
    flushUIQueue();
    window.parent.postMessage({ _type: 'ready' }, '*');
    defaultRender();
  }

  document.addEventListener('DOMContentLoaded', boot);
  if (document.readyState === 'interactive' || document.readyState === 'complete') {
    boot();
  }

  // 暴露方法到全局供 UI 组件使用
  window.registerUI = registerUI;
  window.goToPage = goToPage;
  window.renderCurrent = renderCurrent;
})();
