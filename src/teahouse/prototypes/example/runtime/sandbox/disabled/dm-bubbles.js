(function() {
  'use strict';

  // ============================================================
  // dm-bubbles.js — DM 呈现（message bubble）渲染器
  //
  // 渲染源：Teahouse.listMessages() → { enabled, messages: [{chara, seq, batch, content, kind?}] }
  //   - 与 floors 并列的**独立线路**：DM 不走 runtime/floors/。
  //   - 只有最新批次可改；历史批次已冻结（见 OutputEdit）。
  //
  // 玩家扮演发言：Teahouse.sessionSend('dm', text) —— 默认按扮演处理，
  //   后端自动把它写入 dm-output（开新批次）再交给 DM。
  //
  // 版式：气泡内容区与正文渲染器**同宽居中**（min(90%, 760px)），
  //   复用 theme.css 的 CSS 变量，亮暗主题 / 宿主字号自动跟随。
  //
  // 注意：组件样式一律内嵌（不写独立 .css），见 teahouse-sandbox-builder 硬约束。
  // ============================================================

  var DM_SID = 'dm';
  var root = null;
  var userName = '你';   // 玩家显示名，读变量 `user`，缺省「你」

  // 发送按钮纸飞机图标（同 input-bar 的 feather send，颜色随 currentColor）
  var SEND_ICON =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
    'style="display:block;margin:0 auto;">' +
    '<path d="M22 2L11 13"/><path d="M22 2L15 22l-4-9-9-4z"/></svg>';

  // ---- 内嵌样式（复用 theme.css 变量，缺省用中性色兜底） ----
  var STYLE_ID = 'th-dm-bubbles-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = [
      '.th-dm-root{position:fixed;inset:0;z-index:60;display:flex;flex-direction:column;',
      'background:var(--bg,#faf8f4);color:var(--text,#2b2b2b);font-family:inherit;}',

      // 滚动列表：负责滚动；左右留一点 gutter，内容宽度交给内层
      '.th-dm-list{flex:1;overflow-y:auto;padding:2.5rem 0.5rem 2rem;}',

      // 内层内容列 —— 与正文版式同宽居中
      '.th-dm-inner{width:min(90%,760px);margin:0 auto;}',

      // 气泡列（垂直排列 + 间距）
      '.th-dm-stream{display:flex;flex-direction:column;gap:14px;}',

      // 气泡行：头像 + 气泡列（say 专用）
      '.th-dm-row{display:flex;align-items:flex-start;gap:10px;max-width:100%;}',
      '.th-dm-row-dm{align-self:flex-start;}',
      '.th-dm-row-user{align-self:flex-end;flex-direction:row-reverse;}',

      // 头像圆圈（文字头像；未来可换成 icon）
      '.th-dm-avatar{flex:none;width:38px;height:38px;border-radius:50%;',
      'display:flex;align-items:center;justify-content:center;',
      'background:var(--accent-soft,rgba(96,165,250,.16));color:var(--accent-text,#bcd4ff);',
      'font-size:calc(15px * var(--font-scale));font-weight:700;line-height:1;',
      'user-select:none;overflow:hidden;}',

      // 气泡列（名字在上、气泡在下）
      '.th-dm-bubblewrap{display:flex;flex-direction:column;align-items:flex-start;',
      'min-width:0;max-width:78%;}',
      '.th-dm-row-user .th-dm-bubblewrap{align-items:flex-end;}',

      // 气泡基座（贴头像一侧的顶角为直角）
      '.th-dm-bubble{padding:10px 15px;',
      'border-radius:4px 14px 14px 14px;background:var(--panel,#fff);',
      'border:1px solid var(--border,rgba(0,0,0,.08));line-height:1.75;',
      'font-size:calc(16px * var(--font-scale));',
      'word-break:break-word;white-space:normal;',
      'box-shadow:0 1px 3px rgba(0,0,0,.06);}',
      '.th-dm-content p{margin:0 0 .6em;}',
      '.th-dm-content p:last-child{margin-bottom:0;}',
      '.th-dm-content h1,.th-dm-content h2,.th-dm-content h3{font-size:1.15em;margin:.4em 0 .3em;}',
      '.th-dm-content code{font-size:.88em;padding:.1em .3em;background:var(--code-bg,rgba(0,0,0,.08));border-radius:3px;}',

      // 玩家侧气泡：贴头像一侧顶角直角；中性色（跟随主题，不抢符号着色）
      '.th-dm-bubble-user{border-radius:14px 4px 14px 14px;',
      'background:var(--control-bg,rgba(0,0,0,.06));border-color:var(--border);',
      'color:var(--panel-text,inherit);}',

      // 发言者名（气泡上方外侧）
      '.th-dm-chara{font-size:.72em;font-weight:600;letter-spacing:.02em;',
      'opacity:.62;margin:0 2px 4px;}',

      // 判定气泡：居中胶囊（非 say 气泡样式）
      '.th-dm-kind-roll{align-self:center;max-width:92%;width:auto;',
      'padding:5px 14px;border-radius:999px;',
      'background:var(--control-bg,rgba(0,0,0,.05));',
      'border:1px solid var(--border,rgba(0,0,0,.08));box-shadow:none;',
      'font-size:calc(13px * var(--font-scale));line-height:1.5;',
      'display:inline-flex;align-items:center;gap:8px;justify-content:center;}',
      '.th-dm-dice-tag{flex:none;font-size:.85em;font-weight:700;letter-spacing:.04em;',
      'color:var(--accent-text,inherit);opacity:.9;}',

      // 旁白：无框、居中、非斜体
      '.th-dm-kind-narrate{align-self:center;max-width:92%;background:transparent;',
      'border:none;box-shadow:none;text-align:center;opacity:.78;',
      'font-size:calc(15px * var(--font-scale));}',

      // 输入条：固定在底部（只留药丸本体，无通栏底板）
      '.th-dm-inputbar{padding:8px 0.5px 10px;}',

      // 药丸式输入条 —— 外观取自 input-bar，但固定贴底、不悬浮
      '.th-dm-inputwrap{display:flex;align-items:center;gap:8px;',
      'background:var(--input-bg,rgba(16,16,36,.92));',
      'border:1px solid var(--panel-border,rgba(0,0,0,.12));border-radius:999px;',
      'padding:3px 5px 3px 14px;',
      'box-shadow:0 2px 10px rgba(0,0,0,.12);',
      'transition:border-color .2s,background .25s;}',
      '.th-dm-inputwrap:focus-within{border-color:var(--accent);}',

      '.th-dm-input{flex:1;min-width:0;height:auto;padding:0;border:none;',
      'background:transparent;color:var(--panel-text,inherit);outline:none;',
      'caret-color:var(--accent);font:inherit;',
      'font-size:calc(13px * var(--font-scale));line-height:1.4;}',
      '.th-dm-input::placeholder{color:var(--panel-text-dim,rgba(0,0,0,.4));}',

      '.th-dm-send{flex:none;height:28px;min-width:28px;padding:0 9px;border:none;',
      'border-radius:999px;display:flex;align-items:center;justify-content:center;',
      'background:var(--accent-fill,#8a7a5c);color:var(--accent-filled-text,#fff);',
      'cursor:pointer;transition:opacity .2s;}',
      '.th-dm-send:hover:not(:disabled){opacity:.85;}',
      '.th-dm-send:disabled{opacity:.5;cursor:not-allowed;}',

      // 空态
      '.th-dm-empty{padding:3rem 0;text-align:center;opacity:.5;',
      'font-size:calc(15px * var(--font-scale));}',
    ].join('');
    document.head.appendChild(st);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // 逐行修剪首尾空白（含全角空格 U+3000）——AI 常自作主张给正文加首行缩进，
  // 呈现层是气泡/居中，缩进只会破坏排版，这里统一抹掉。
  function trimLines(s) {
    return String(s == null ? '' : s)
      .split('\n')
      .map(function(line) { return line.replace(/^[\s\u3000]+|[\s\u3000]+$/g, ''); })
      .join('\n');
  }

  // kind 别名归一化：narrator/narrate → narrate；dice/roll → roll
  function normalizeKind(kind) {
    if (kind === 'narrator' || kind === 'narrate') return 'narrate';
    if (kind === 'dice' || kind === 'roll') return 'roll';
    return kind || 'say';
  }

  // 头像文字：优先 icon（未来扩展），否则取名字首字；空名回退 '?'
  function avatarChar(name, icon) {
    if (icon != null && icon !== '') return String(icon);
    var s = String(name == null ? '' : name).trim();
    return s ? s.charAt(0) : '?';
  }

  function bubbleHtml(m, contentHtml) {
    var isUser = m.chara === 'user';
    var kind = normalizeKind(m.kind);

    // 旁白：居中无框，标签「旁白」
    if (kind === 'narrate') {
      return '<div class="th-dm-bubble th-dm-kind-narrate" data-seq="' + esc(m.seq) + '">' +
        '<div class="th-dm-chara">旁白</div>' +
        '<div class="th-dm-content">' + contentHtml + '</div>' +
        '</div>';
    }
    // 判定：居中胶囊，前缀标签「判定」
    if (kind === 'roll') {
      return '<div class="th-dm-bubble th-dm-kind-roll" data-seq="' + esc(m.seq) + '">' +
        '<span class="th-dm-dice-tag">判定</span>' +
        '<span class="th-dm-content">' + contentHtml + '</span>' +
        '</div>';
    }

    // say：头像在气泡外侧，名字挂在气泡上方
    var name = isUser ? userName : m.chara;
    var rowCls = 'th-dm-row ' + (isUser ? 'th-dm-row-user' : 'th-dm-row-dm');
    return '<div class="' + rowCls + '" data-seq="' + esc(m.seq) + '">' +
      '<div class="th-dm-avatar">' + esc(avatarChar(name, m.icon)) + '</div>' +
      '<div class="th-dm-bubblewrap">' +
      '<div class="th-dm-chara">' + esc(name) + '</div>' +
      '<div class="th-dm-bubble' + (isUser ? ' th-dm-bubble-user' : '') + '">' +
      '<div class="th-dm-content">' + contentHtml + '</div>' +
      '</div>' +
      '</div>' +
      '</div>';
  }

  // 内容经宿主 renderRichText 渲染（BBCode → 符号着色 → Markdown），拿回 HTML。
  // 渲染失败/无内容时回退为转义纯文本，保证一定可显示。
  function renderContent(m) {
    var raw = trimLines(m.content == null ? '' : String(m.content));
    if (!raw) return Promise.resolve('');
    return window.Teahouse.renderRichText(raw).then(function(html) {
      return (html == null || html === '') ? esc(raw) : html;
    }).catch(function() {
      return esc(raw);
    });
  }

  function render(messages) {
    var stream = root && root.querySelector('.th-dm-stream');
    if (!stream) return;
    if (!messages || messages.length === 0) {
      stream.innerHTML = '<div class="th-dm-empty">（还没有对话。说点什么，故事就开始了…）</div>';
      return;
    }
    Promise.all(messages.map(function(m) {
      return renderContent(m).then(function(html) { return bubbleHtml(m, html); });
    })).then(function(parts) {
      stream.innerHTML = parts.join('');
      var scroller = root.querySelector('.th-dm-list');
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    }).catch(function() {
      // 极端兜底：纯文本回退
      stream.innerHTML = messages.map(function(m) {
        return bubbleHtml(m, esc(trimLines(m.content)));
      }).join('');
      var scroller = root.querySelector('.th-dm-list');
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
  }

  function build() {
    ensureStyle();
    root = document.createElement('div');
    root.className = 'th-dm-root';
    // 注意：沙盒 iframe 是 sandbox="allow-scripts"（无 allow-forms），用 <form>
    // 提交会被浏览器拦截、点发送毫无反应 —— 必须 click / Enter 手动触发。
    root.innerHTML =
      '<div class="th-dm-list"><div class="th-dm-inner th-dm-stream"></div></div>' +
      '<div class="th-dm-inputbar"><div class="th-dm-inner th-dm-inputwrap">' +
      '<input class="th-dm-input" type="text" placeholder="说点什么…" autocomplete="off">' +
      '<button class="th-dm-send" type="button" title="发送">' + SEND_ICON + '</button>' +
      '</div></div>';
    document.body.appendChild(root);
    var input = root.querySelector('.th-dm-input');
    var sendBtn = root.querySelector('.th-dm-send');
    function submit() {
      var text = input.value.trim();
      if (!text) return;
      input.value = '';
      // 扮演发言 → 后端自动入 dm-output
      window.Teahouse.sessionSend(DM_SID, text);
    }
    sendBtn.addEventListener('click', submit);
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
  }

  function refresh() {
    window.Teahouse.listMessages().then(function(res) {
      if (!res || !res.enabled) return;
      if (!root) build();
      // 读玩家名变量（`user`），缺省回退「你」
      window.Teahouse.getVars(['user']).then(function(entries) {
        var v = (entries && entries[0]) ? entries[0].value : null;
        if (v !== null && v !== undefined && v !== '') userName = String(v);
      }).catch(function() {}).then(function() {
        render(res.messages || []);
      });
    }).catch(function() {});
  }

  window.Teahouse.on('output.refresh', function(data) {
    var p = data && data.path;
    if (p === 'runtime/dm-output.jsonl') refresh();
  });

  refresh();
})();
