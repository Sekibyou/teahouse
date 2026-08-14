(function() {
  'use strict';

  // ============================================================
  // Teahouse Sandbox Bootstrap — 引擎内置基础设施
  //
  // 这是沙盒的核心运行时，由引擎提供，不出现于实例目录。
  // 职责：
  //   1. postMessage 通信桥（API 代理 + SSE 事件透传）
  //   2. window.Teahouse 公开 API
  //   3. runTool 封装（集中管理 run_uuid、tool_run 分拣、完成判定）
  //   4. 流式管理层（集中订阅 generate_progress，维护 currentDraft）
  //   5. 事件订阅系统 + UI 组件管理 + DOM 容器创建
  //
  // 不负责正文渲染 —— 正文渲染由 teahouse-maintext-renderer.js 提供。
  // ============================================================

  // ---- 内部状态 ----
  var uiComponents = {};   // label -> element
  var eventCallbacks = {}; // event -> [cb]
  var uiQueue = [];        // 未就绪时排队挂载的元素
  var uiLayerReady = false;

  // ---- 宿主桥：所有 API 请求经 postMessage 转发给宿主 ----
  function callHost(method, args) {
    return new Promise(function(resolve, reject) {
      var callId = 'call_' + Math.random().toString(36).substr(2, 9);
      var handler = function(e) {
        if (e.data && e.data._callId === callId) {
          window.removeEventListener('message', handler);
          if (e.data._error) reject(new Error(e.data._error));
          else resolve(e.data._result);
        }
      };
      window.addEventListener('message', handler);
      window.parent.postMessage({ _method: method, _args: args, _callId: callId }, '*');
    });
  }

  // ============================================================
  // runTool 封装层
  //
  // Teahouse.runTool(steps) 内部自动管理 run_uuid 登记、tool_run
  // 事件分拣、完成判定。返回 Promise，在整批完成或失败时 resolve。
  // UI 组件无需手动管理 pendingRuns。
  // ============================================================
  var pendingRuns = {};  // run_uuid -> { total, results, resolve, reject, timer }

  function registerRun(runUuid, total, resolve, reject) {
    pendingRuns[runUuid] = {
      total: total,
      results: {},
      maxIndex: 0,
      resolve: resolve,
      reject: reject
    };
    // 超时保护：5 分钟后强制 reject
    pendingRuns[runUuid].timer = setTimeout(function() {
      var r = pendingRuns[runUuid];
      if (!r) return;
      delete pendingRuns[runUuid];
      r.reject(new Error('runTool 超时：' + runUuid));
    }, 300000);
  }

  function handleToolRun(data) {
    if (!data || !data.run_uuid) return;
    var r = pendingRuns[data.run_uuid];
    if (!r) return;
    r.results[data.index] = { tool: data.tool, result: data.result, ok: !!data.ok };
    r.maxIndex = Math.max(r.maxIndex, data.index || 0);
    if (!data.ok) {
      clearTimeout(r.timer);
      delete pendingRuns[data.run_uuid];
      r.reject(new Error('步骤 ' + data.index + ' (' + data.tool + ') 失败: ' + data.result));
      return;
    }
    // 全部成功步已到齐 → 本批完成
    if (r.maxIndex >= r.total) {
      clearTimeout(r.timer);
      delete pendingRuns[data.run_uuid];
      var results = [];
      for (var i = 1; i <= r.total; i++) {
        results.push(r.results[i] || null);
      }
      r.resolve({ ok: true, results: results, run_uuid: data.run_uuid });
    }
  }

  // —— runTool 批被后端取消：reject 对应批，不再悬到 5 分钟超时 ——
  function handleToolCancel(data) {
    if (!data || !data.run_uuid) return;
    var r = pendingRuns[data.run_uuid];
    if (!r) return;
    clearTimeout(r.timer);
    delete pendingRuns[data.run_uuid];
    r.reject(new Error('runTool 已取消：' + data.run_uuid));
  }

  // ============================================================
  // 流式管理层
  //
  // 集中订阅 generate_progress，维护 currentDraft 缓冲区 +
  // generationStatus 状态机。UI 组件直接读 Teahouse.currentDraft
  // 和订阅 draft.change 事件即可。
  // ============================================================
  var currentDraft = null;   // { path, text, accumulated_len } 或 null
  var generationStatus = 'idle';  // 'idle' | 'generating' | 'done'

  // 只监测直接写进正文历史的生成（.teahouse/output/floors/）。其余路径
  // （temp/、settings/ 等后台 generate）的流式进度不进入状态机，避免干扰
  // 沙盒当前渲染。currentDraft 是单槽位缓冲，path 变化即替换、绝不混串。
  function isWatchableFloorProgress(path) {
    return typeof path === 'string' && path.indexOf('.teahouse/output/floors/') === 0;
  }

  function handleGenerateProgress(data) {
    var path = data && data.path;
    if (!data || path == null) return;
    if (!isWatchableFloorProgress(path)) return;

    if (data.done) {
      // 流结束：校准后清除缓冲。正常路径 file_changed 已先落盘，
      // 这里仅兜底。
      if (currentDraft && currentDraft.path === path && data.accumulated_text != null) {
        currentDraft.text = data.accumulated_text;
        currentDraft.accumulated_len = data.accumulated_len;
        window.Teahouse._emit('draft.change', currentDraft);
      }
      currentDraft = null;
      generationStatus = 'done';
      window.Teahouse._emit('generation.status', 'done');
      return;
    }

    // done:false —— 携带本帧新增 delta，追加而非覆盖
    if (data.delta == null) return;
    generationStatus = 'generating';
    if (!currentDraft || currentDraft.path !== path) {
      currentDraft = { path: path, text: data.delta, accumulated_len: data.accumulated_len };
      window.Teahouse._emit('generation.status', 'generating');
    } else {
      currentDraft.text += data.delta;
      currentDraft.accumulated_len = data.accumulated_len;
    }
    window.Teahouse._emit('draft.change', currentDraft);
  }

  // ---- Teahouse 公开 API ----
  window.Teahouse = {
    // 楼层（正文历史）
    listFloors: function() { return callHost('listFloors', []); },

    // 文件操作
    readText: function(path) { return callHost('readText', [path]); },
    readAsset: function(path) { return callHost('readAsset', [path]); },
    writeFile: function(path, content) { return callHost('writeFile', [path, content]); },

    // ---- 转正（草稿 → 正式稿）----
    // 一次性完成：解析正文 teahouse-vars → 应用变量 → 标记 msg 写回 → 改名 → git 提交。
    // 返回 {ok, data|error}，data 含 {num, title, commit_hash, applied, failed, committed_draft}。
    // 已转正且无未消费 action → 幂等返回。二次补解析失败变量 → 再次调用即可。
    // 约定源：tests/teahouse-commit-draft-api.md (v2)。
    commitDraft: function(num) { return callHost('commitDraft', [num]); },

    // ---- 重写 = 回档：git 丢弃所有暂存/未跟踪改动 ----
    // 复用后端 /git/discard（git checkout -- . + clean -fd，连 untracked 的
    // floor-N-draft.md 一并清除）。B 按钮用它回档后重新生成。
    gitDiscard: function() { return callHost('gitDiscard', []); },

    // 富文本渲染
    renderRichText: function(text) { return callHost('renderRichText', [text]); },

    // 发送消息给导演
    send: function(message) { callHost('send', [message]); },

    // 唤起导演栏：当导演栏被折叠/隐藏时，请求宿主将其打开（纯前端，不触发生成）。
    openDirector: function() { callHost('openDirector', []); },

    // 子会话
    sessionCreate: function(opts) { return callHost('sessionCreate', [opts || {}]); },
    sessionSend: function(session_id, message) {
      return callHost('sessionSend', [{ session_id: session_id, message: message }]);
    },
    sessionDestroy: function(session_id, abort) {
      return callHost('sessionDestroy', [{ session_id: session_id, abort: !!abort }]);
    },

    // 沙盒变量
    setVar: function(updates) { return callHost('setVar', [updates]); },
    getVars: function(names) { return callHost('getVars', [names]); },

    // 变量字面量替换
    replacePlaceholders: function(text, fallbacks) {
      var fb = fallbacks || {};
      return window.Teahouse.getVars([]).then(function(entries) {
        var map = {};
        for (var i = 0; i < entries.length; i++) {
          var e = entries[i];
          map[e.name] = (e.value === undefined || e.value === null) ? '' : String(e.value);
        }
        return String(text).replace(/\$\{([^}]+)\}/g, function(m, name) {
          var has = Object.prototype.hasOwnProperty.call(map, name);
          if (!has) {
            return Object.prototype.hasOwnProperty.call(fb, name) ? fb[name] : m;
          }
          var v = map[name];
          if (v === '' && Object.prototype.hasOwnProperty.call(fb, name)) return fb[name];
          return v;
        });
      });
    },

    // ---- runTool 封装：返回可取消 handle，自动管理完成判定 ----
    // steps: [{tool, args}, ...]
    // 返回值是一个 thenable（带 .then，可 await），同时暴露：
    //   .run_uuid — 受理后填充，供中途取消
    //   .cancel()  — 调用宿主打断本批（等效 Teahouse.cancelRunTool(run_uuid)）
    // 完成/失败/取消时 handle 像 Promise 一样 resolve / reject。
    runTool: function(steps) {
      var resolve, reject;
      var pr = new Promise(function(res, rej) { resolve = res; reject = rej; });
      var handle = {
        run_uuid: null,
        then: function(onFulfilled, onRejected) { return pr.then(onFulfilled, onRejected); },
        cancel: function() {
          if (handle.run_uuid) callHost('cancelRunTools', [handle.run_uuid]);
        }
      };
      callHost('runTools', [steps]).then(function(res) {
        if (!res || !res.ok) {
          reject(new Error('runTool 提交失败：' + (res && res.error ? res.error : JSON.stringify(res))));
          return;
        }
        // 即发即返确认受理 → 记下 run_uuid 供取消，登记本批等待 tool_run 驱动完成
        handle.run_uuid = res.run_uuid;
        var total = res.steps || steps.length;
        registerRun(res.run_uuid, total, resolve, reject);
      }).catch(function(err) {
        reject(err);
      });
      return handle;
    },

    // ---- cancelRunTool：按 run_uuid 显式打断一个 runTool 批次（长 Generate 步骤）----
    cancelRunTool: function(run_uuid) {
      return callHost('cancelRunTools', [run_uuid]);
    },

    // ---- 流式草稿（只读） ----
    // currentDraft: { path, text, accumulated_len } | null
    // generationStatus: 'idle' | 'generating' | 'done'
    get currentDraft() { return currentDraft; },
    get generationStatus() { return generationStatus; },

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

  // ---- 监听宿主推送事件 ----
  // '_teahouse_event'（generate_progress/output.refresh/tool_run/session_* 等透传事件）
  // 由宿主 SandboxManager 注入的 host bridge 统一 _emit，bootstrap 不得在此重复监听。
  // 旧式 tool_call/tool_result/thinking 事件仍在此兼容接收。
  window.addEventListener('message', function(e) {
    var d = e.data;
    if (!d || !d._type) return;
    switch (d._type) {
      case 'tool_call':
      case 'tool_result':
      case 'thinking':
        window.Teahouse._emit(d._type, d._payload);
        break;
    }
  });

  // ---- UI 组件管理 ----
  function registerUI(label, element) {
    if (uiComponents[label]) uiComponents[label].remove();
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

  // ---- DOM 容器 ----
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

  // ---- 初始化 ----
  // 同步创建容器——因为此 <script> 在 <body> 内，document.body 已存在。
  // 同步 boot 保证后续用户 UI 组件执行时容器已就绪，无需异步等待。
  function boot() {
    console.log('[bootstrap] boot start');
    ensureContainers();
    console.log('[bootstrap] containers ready, content=', document.getElementById('teahouse-content'), 'ui-layer=', document.getElementById('teahouse-ui-layer'));
    uiLayerReady = true;
    flushUIQueue();

    // ---- 集中订阅 tool_run / tool_run_cancelled / generate_progress（Teahouse 已就绪后才注册） ----
    window.Teahouse.on('tool_run', handleToolRun);
    window.Teahouse.on('tool_run_cancelled', handleToolCancel);
    window.Teahouse.on('generate_progress', handleGenerateProgress);
    console.log('[bootstrap] tool_run/tool_run_cancelled/generate_progress handlers registered');

    window.Teahouse._emit('teahouse.ready');
    // 通知宿主沙盒就绪
    window.parent.postMessage({ _type: 'ready' }, '*');
    console.log('[bootstrap] boot done, Teahouse methods:', Object.keys(window.Teahouse));
  }

  boot();

  // 暴露到全局供 UI 组件使用
  window.registerUI = registerUI;
})();
