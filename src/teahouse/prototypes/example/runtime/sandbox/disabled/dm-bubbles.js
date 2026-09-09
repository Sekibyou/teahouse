(function() {
  'use strict';

  // ============================================================
  // dm-bubbles.js — DM 呈现（message bubble）参考渲染器【已禁用，按需启用】
  //
  // 本文件放在 runtime/sandbox/disabled/ 下 = **不加载**。跑团 / 语C / 聊天类实例
  // 才需要它：把本文件与同目录的 dm.yaml 一起启用（把 dm-bubbles.js 移到
  // runtime/sandbox/ 根目录，并在实例根目录建 dm.yaml），同时禁用正文渲染器
  // （teahouse-maintext-renderer.js / page-bar.js 移到 disabled/）。
  //
  // 渲染源：Teahouse.listMessages() → { enabled, messages: [{chara, seq, batch, content, kind?}] }
  //   - 这是与 floors 并列的**独立线路**：DM 不走 runtime/floors/。
  //   - 只有最新批次可改；历史批次已冻结（见 OutputEdit）。
  //
  // 玩家扮演发言：Teahouse.sessionSend('dm', text) —— 默认按扮演处理，
  //   后端会自动把它写入 dm-output（开新批次）再交给 DM。DM 栏（ChatPanel）
  //   里输入的内容则是局外发言，只进会话、不进 dm-output。
  //
  // 注意：组件样式一律内嵌（不写独立 .css），见 teahouse-sandbox-builder 硬约束。
  // ============================================================

  var DM_SID = 'dm';
  var root = null;

  // ---- 内嵌样式（复用 theme.css 变量，缺省用中性色兜底） ----
  var STYLE_ID = 'th-dm-bubbles-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = [
      '.th-dm-root{position:fixed;inset:0;z-index:60;display:flex;flex-direction:column;',
      'background:var(--bg,#faf8f4);color:var(--text,#2b2b2b);font-family:inherit;}',
      '.th-dm-list{flex:1;overflow-y:auto;padding:16px 12px;display:flex;flex-direction:column;gap:10px;}',
      '.th-dm-bubble{max-width:78%;align-self:flex-start;padding:8px 12px;',
      'border-radius:14px 14px 14px 4px;background:var(--panel,#fff);',
      'border:1px solid var(--border,rgba(0,0,0,.08));line-height:1.6;',
      'word-break:break-word;white-space:pre-wrap;}',
      '.th-dm-bubble-user{align-self:flex-end;border-radius:14px 14px 4px 14px;',
      'background:var(--accent-fill,#e8dcc8);border-color:transparent;color:var(--accent-filled-text,inherit);}',
      '.th-dm-chara{font-size:.75em;opacity:.6;margin-bottom:2px;}',
      '.th-dm-kind-roll{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;',
      'background:var(--panel,#fff);border-style:dashed;}',
      '.th-dm-kind-narrate{align-self:center;max-width:92%;background:transparent;',
      'border:none;text-align:center;opacity:.78;font-style:italic;}',
      '.th-dm-inputbar{display:flex;gap:8px;padding:10px 12px;',
      'border-top:1px solid var(--border,rgba(0,0,0,.08));background:var(--panel,#fff);}',
      '.th-dm-input{flex:1;min-width:0;padding:10px 12px;border-radius:10px;',
      'border:1px solid var(--border,rgba(0,0,0,.12));background:transparent;color:inherit;',
      'font:inherit;min-height:44px;}',
      '.th-dm-send{min-width:64px;min-height:44px;padding:0 14px;border-radius:10px;border:none;',
      'background:var(--accent-fill,#8a7a5c);color:var(--accent-filled-text,#fff);',
      'font:inherit;cursor:pointer;}',
    ].join('');
    document.head.appendChild(st);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function bubbleHtml(m) {
    var isUser = m.chara === 'user';
    var cls = 'th-dm-bubble' + (isUser ? ' th-dm-bubble-user' : '') +
      (m.kind ? ' th-dm-kind-' + esc(m.kind) : '');
    return '<div class="' + cls + '" data-seq="' + esc(m.seq) + '">' +
      '<div class="th-dm-chara">' + esc(isUser ? '你' : m.chara) + '</div>' +
      '<div class="th-dm-content">' + esc(m.content) + '</div>' +
      '</div>';
  }

  function render(messages) {
    var list = root && root.querySelector('.th-dm-list');
    if (!list) return;
    list.innerHTML = messages.map(bubbleHtml).join('');
    list.scrollTop = list.scrollHeight;
  }

  function build() {
    ensureStyle();
    root = document.createElement('div');
    root.className = 'th-dm-root';
    root.innerHTML =
      '<div class="th-dm-list"></div>' +
      '<div class="th-dm-inputbar">' +
      '<input class="th-dm-input" type="text" placeholder="说点什么…" autocomplete="off">' +
      '<button class="th-dm-send" type="button">发送</button>' +
      '</div>';
    document.body.appendChild(root);

    var input = root.querySelector('.th-dm-input');
    var sendBtn = root.querySelector('.th-dm-send');

    function showError(msg) {
      var bar = root.querySelector('.th-dm-err');
      if (!bar) {
        bar = document.createElement('div');
        bar.className = 'th-dm-err';
        bar.style.cssText = 'padding:6px 12px;font-size:12px;color:#b3261e;background:rgba(179,38,30,.08);';
        root.insertBefore(bar, root.querySelector('.th-dm-inputbar'));
      }
      bar.textContent = '发送失败：' + msg;
    }

    function submit() {
      var text = input.value.trim();
      if (!text) return;
      input.value = '';
      // 扮演发言 → 后端自动入 dm-output
      // 注意：沙盒 iframe 是 sandbox="allow-scripts"（无 allow-forms），
      // 因此不能用 <form> submit —— 必须 click / keydown 手动触发。
      var p;
      try {
        p = window.Teahouse.sessionSend(DM_SID, text);
      } catch (e) {
        showError(String(e));
        return;
      }
      if (p && typeof p.then === 'function') {
        p.then(function(res) {
          if (res && res.ok === false) showError(res.error || 'sessionSend 返回失败');
        }).catch(function(e) { showError(String(e)); });
      }
    }

    sendBtn.addEventListener('click', submit);
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    input.focus();
  }

  function refresh() {
    window.Teahouse.listMessages().then(function(res) {
      if (!res || !res.enabled) return;
      if (!root) build();
      render(res.messages || []);
    }).catch(function() {});
  }

  window.Teahouse.on('output.refresh', function(data) {
    var p = data && data.path;
    if (p === 'runtime/dm-output.jsonl') refresh();
  });

  refresh();
})();
