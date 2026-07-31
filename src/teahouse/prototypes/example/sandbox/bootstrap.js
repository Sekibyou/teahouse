(function() {
  'use strict';

  // ============================================================
  // Teahouse Sandbox Bootstrap
  // 参考实现 — 创作者可替换整个文件
  // ============================================================

  // ---- 内部状态 ----
  const uiComponents = {};
  const stylesheets = new Set();
  const eventCallbacks = {};

  // ---- Teahouse API 模拟（沙盒内通过 postMessage 调用宿主） ----
  // 通信层由宿主注入的 teahouse-bridge.js 提供
  // bootstrap.js 假设 bridge 已就绪

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
    // 输出块
    listOutputBlocks: function() { return callHost('listOutputBlocks', []); },
    getOutputBlock: function(uuid) { return callHost('getOutputBlock', [uuid]); },

    // 文件操作
    readFile: function(path) { return callHost('readFile', [path]); },
    writeFile: function(path, content) { return callHost('writeFile', [path, content]); },

    // 发送消息
    send: function(message) { callHost('send', [message]); },

    // 富文本渲染
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

    switch (d._type) {
      case 'output.append':
      case 'output.replace':
      case 'output.delete':
      case 'tool_call':
      case 'tool_result':
      case 'thinking':
        window.Teahouse._emit(d._type, d._payload);
        break;
    }
  });

  // ---- Scene 管理 ----

  var uiQueue = [];
  var uiLayerReady = false;

  function registerUI(label, element) {
    if (uiComponents[label]) {
      uiComponents[label].remove();
    }
    uiComponents[label] = element;
    if (uiLayerReady) {
      document.getElementById('teahouse-ui-layer')!.appendChild(element);
    } else {
      uiQueue.push({ label, element });
    }
  }

  function flushUIQueue() {
    const layer = document.getElementById('teahouse-ui-layer');
    if (!layer) return;
    for (const { label, element } of uiQueue) {
      layer.appendChild(element);
      uiComponents[label] = element;
    }
    uiQueue.length = 0;
  }

  // ---- 默认渲染：获取 ep 块并渲染 rich_text ----

  function defaultRender() {
    window.Teahouse.listOutputBlocks().then(function(blocks) {
      var epBlocks = blocks
        .filter(function(b) { return /^ep\d+$/i.test(b.label) && b.content_type === 'rich_text'; })
        .map(function(b) {
          var num = parseInt(b.label.replace(/^ep/i, ''), 10);
          return Object.assign({}, b, { epNum: num });
        })
        .sort(function(a, b) { return b.epNum - a.epNum; });

      if (epBlocks.length > 0) {
        renderEpBlock(epBlocks[0]);
      } else {
        // Fallback: 渲染所有 rich_text 块
        var rtBlocks = blocks.filter(function(b) { return b.content_type === 'rich_text'; });
        if (rtBlocks.length > 0) {
          renderEpBlock(rtBlocks[0]);
        }
      }
    }).catch(function(err) {
      console.error('[Teahouse Bootstrap] defaultRender failed:', err);
    });
  }

  function renderEpBlock(block) {
    var container = document.getElementById('teahouse-content');
    if (!container) return;

    window.Teahouse.getOutputBlock(block.uuid).then(function(full) {
      return window.Teahouse.renderRichText(full.content);
    }).then(function(html) {
      // 按分隔符切片渲染为气泡
      var parts = html.split('<hr>');
      container.innerHTML = '';
      parts.forEach(function(part) {
        var bubble = document.createElement('div');
        bubble.className = 'teahouse-bubble';
        bubble.innerHTML = part;
        container.appendChild(bubble);
      });
    }).catch(function(err) {
      console.error('[Teahouse Bootstrap] renderEpBlock failed:', err);
    });
  }

  // ---- 宿主推送事件处理 ----

  window.Teahouse.on('output.append', function(block) {
    switch (block.content_type) {
      case 'rich_text':
        if (/^ep\d+$/i.test(block.label)) {
          renderEpBlock(block);
        }
        break;
      case 'ui_js':
        // Evaluate UI JS block — sandbox host embeds initial ones in srcdoc,
        // this handles blocks appended after initial load via SSE
        try {
          var script = document.createElement('script');
          script.textContent = block.content;
          document.head.appendChild(script);
        } catch(e) {
          console.error('[Teahouse Bootstrap] ui_js eval failed:', e);
        }
        break;
      case 'css':
        // CSS 追加式（由宿主注入 iframe head）
        break;
    }
  });

  window.Teahouse.on('output.replace', function(block) {
    switch (block.content_type) {
      case 'rich_text':
        if (/^ep\d+$/i.test(block.label)) {
          renderEpBlock(block);
        }
        break;
    }
  });

  // ---- 初始化 ----

  document.addEventListener('DOMContentLoaded', function() {
    // 创建默认的 UI 层和内容容器
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

    // 通知宿主：沙盒已就绪
    uiLayerReady = true;
    flushUIQueue();
    window.parent.postMessage({ _type: 'ready' }, '*');
  });

  // 如果 DOM 已经加载（srcdoc 注入脚本的情况）
  if (document.readyState === 'interactive' || document.readyState === 'complete') {
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
    uiLayerReady = true;
    flushUIQueue();
    window.parent.postMessage({ _type: 'ready' }, '*');
  }

  // 在整个 sandbox 初始化完成后执行默认渲染
  setTimeout(function() {
    defaultRender();
  }, 100);

  // 暴露方法到全局供场景和 UI 脚本使用
  window.registerUI = registerUI;
})();
