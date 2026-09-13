(function() {
  'use strict';

  // ============================================================
  // dm-main.js — DM 呈现（message bubble）渲染器
  //
  // 渲染源：Teahouse.listMessages() → { enabled, messages: [{chara, seq, batch, content, kind?}] }
  //   - 与 floors 并列的**独立线路**：DM 不走 runtime/floors/。
  //   - 只有最新批次可改；历史批次已冻结（见 OutputEdit）。
  //
  // 玩家扮演发言：Teahouse.sessionSend('dm', text) —— 默认按扮演处理，
  //   后端自动把它写入 dm-output（开新批次）再交给 DM。
  //
  // 忙碌态：订阅宿主透传的 `session.busy`（后端 session_tracker 的权威
  //   running map，宿主归一后只在「开始 / 结束」两个沿各推一次）——
  //   DM 工作期间锁住输入条 + 显示等待提示，避免玩家对着盲盒猛敲。
  //
  // 版式：气泡内容区与正文渲染器**同宽居中**（min(90%, 760px)），
  //   复用 theme.css 的 CSS 变量，亮暗主题 / 宿主字号自动跟随。
  //
  // 注意：组件样式一律内嵌（不写独立 .css），见 teahouse-sandbox-builder 硬约束。
  // ============================================================

  var DM_SID = 'dm';
  var root = null;
  var userName = '你';   // 玩家显示名，读变量 `user`，缺省「你」

  // ---- 忙碌态（后端权威，宿主只在边界推送） ----
  var busy = false;       // DM 会话是否正在工作
  var busySince = 0;      // 本轮忙碌的起始时刻（宿主给出 since 时以其为准）
  var busyTicker = null;  // 秒数跳动定时器，仅在忙碌期间存在

  // ---- 出场特效：新消息先以「正在输入」占位，再揭示正文 ----
  var nodeBySeq = Object.create(null);  // seq → 已渲染的气泡节点（复用，不重复入场）
  var ENTER_MS = 500;                    // 占位「正在输入」停留时长（≈0.5s）
  var STAGGER_MS = 300;                  // 多条一起到达时的错峰步长（第 i 条等 i×0.3s 才出场）
  // 本次加载的「首帧」标记：首帧里已存在的消息一律直接成稿（不占位、不滑入）。
  // nodeBySeq 只活在内存，iframe 一重建（刷新页面 / 改沙盒代码 / 切布局）就归零，
  // 若不分首帧，整段历史会被当成「新消息」从头重播一遍入场动画。首帧落定后置
  // false —— 此后到达的才是真·新消息，正常走入场。
  var firstPaint = true;

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
      'font-size:calc(16px * var(--font-scale));}',

      // 输入条：固定在底部（只留药丸本体，无通栏底板）
      '.th-dm-inputbar{padding:8px 0.5px 10px;}',

      // 忙碌提示：输入条上方的居中胶囊（仅 DM 工作时显示）
      '.th-dm-working{display:none;align-items:center;justify-content:center;gap:7px;',
      'padding:0 0 8px;font-size:calc(12px * var(--font-scale));',
      'color:var(--panel-text-dim,rgba(0,0,0,.45));}',
      '.th-dm-working.on{display:flex;}',
      '.th-dm-working-dot{flex:none;width:7px;height:7px;border-radius:50%;',
      'background:var(--accent,#60a5fa);animation:th-dm-pulse 1.3s ease-in-out infinite;}',
      '@keyframes th-dm-pulse{0%,100%{opacity:.3;}50%{opacity:1;}}',

      // 药丸式输入条 —— 外观取自 input-bar，但固定贴底、不悬浮
      '.th-dm-inputwrap{display:flex;align-items:center;gap:8px;',
      'background:var(--input-bg,rgba(16,16,36,.92));',
      'border:1px solid var(--panel-border,rgba(0,0,0,.12));border-radius:999px;',
      'padding:3px 5px 3px 5px;',
      'box-shadow:0 2px 10px rgba(0,0,0,.12);',
      'transition:border-color .2s,background .25s;}',
      '.th-dm-inputwrap:focus-within{border-color:var(--accent);}',
      '.th-dm-inputwrap.th-dm-locked{opacity:.72;}',

      // 唤起 DM 栏触发器（仿 novel 输入条左侧模式按钮：胶囊 + 小圆点 + 标签）
      '.th-dm-open{flex:none;height:26px;padding:0 10px;border-radius:20px;',
      'display:inline-flex;align-items:center;gap:5px;',
      'background:transparent;border:1px solid var(--panel-border,rgba(0,0,0,.12));',
      'color:var(--accent-text,#bcd4ff);',
      'font-size:calc(12px * var(--font-scale));font-weight:600;line-height:1;',
      'cursor:pointer;user-select:none;',
      'transition:background .2s,border-color .2s;}',
      '.th-dm-open:hover{background:var(--control-bg,rgba(0,0,0,.05));}',
      '.th-dm-open-dot{width:8px;height:8px;border-radius:50%;flex:none;',
      'background:var(--accent,#60a5fa);}',

      '.th-dm-input{flex:1;min-width:0;height:auto;padding:0;border:none;',
      'background:transparent;color:var(--panel-text,inherit);outline:none;',
      'caret-color:var(--accent);font:inherit;',
      'font-size:calc(13px * var(--font-scale));line-height:1.4;}',
      '.th-dm-input::placeholder{color:var(--panel-text-dim,rgba(0,0,0,.4));}',
      '.th-dm-input:disabled{cursor:not-allowed;}',

      '.th-dm-send{flex:none;height:28px;min-width:28px;padding:0 9px;border:none;',
      'border-radius:999px;display:flex;align-items:center;justify-content:center;',
      'background:var(--accent-fill,#8a7a5c);color:var(--accent-filled-text,#fff);',
      'cursor:pointer;transition:opacity .2s;}',
      '.th-dm-send:hover:not(:disabled){opacity:.85;}',
      '.th-dm-send:disabled{opacity:.5;cursor:not-allowed;}',

      // ---- 出场特效：气泡先「正在输入」，再揭示正文 ----
      // 整条消息的出现：从下往上滑入 + 透明度渐变（≈0.2s，播放起点用内联 animation-delay 错峰）
      '.th-dm-in{animation:th-dm-appear .2s ease both;}',
      '@keyframes th-dm-appear{from{opacity:0;transform:translateY(14px);}to{opacity:1;transform:none;}}',
      // 正文揭示时的淡入
      '.th-dm-fadein{animation:th-dm-fadein .18s ease both;}',
      '@keyframes th-dm-fadein{from{opacity:0;}to{opacity:1;}}',
      // 「正在输入」三点：随各自 kind 继承颜色 / 对齐
      '.th-dm-typing{display:inline-flex;align-items:center;gap:4px;height:1.1em;vertical-align:middle;}',
      '.th-dm-typing i{display:block;width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.5;',
      'animation:th-dm-blink 1s ease-in-out infinite both;}',
      '.th-dm-typing i:nth-child(1){animation-delay:-.2s;}',
      '.th-dm-typing i:nth-child(2){animation-delay:-.1s;}',
      '.th-dm-typing i:nth-child(3){animation-delay:0s;}',
      '@keyframes th-dm-blink{0%,80%,100%{opacity:.25;transform:translateY(0);}40%{opacity:.85;transform:translateY(-3px);}}',

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

    // 旁白：居中无框，不标发言者（内容本身就是旁白，无需「旁白」二字）
    if (kind === 'narrate') {
      return '<div class="th-dm-bubble th-dm-kind-narrate" data-seq="' + esc(m.seq) + '">' +
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

  // 「正在输入」三点占位（结构由 bubbleHtml 包进各自的 kind 形态里）
  function typingHtml() {
    return '<span class="th-dm-typing"><i></i><i></i><i></i></span>';
  }

  // HTML 字符串 → 单个根元素
  function elemFromHtml(html) {
    var t = document.createElement('div');
    t.innerHTML = html;
    return t.firstElementChild;
  }

  function nearBottom() {
    var s = root.querySelector('.th-dm-list');
    if (!s) return true;
    return (s.scrollHeight - s.scrollTop - s.clientHeight) < 80;
  }

  function scrollBottom() {
    var s = root.querySelector('.th-dm-list');
    if (s) s.scrollTop = s.scrollHeight;
  }

  // 揭示：把占位「...」换成真正内容
  function reveal(node, html) {
    var c = node.querySelector('.th-dm-content');
    if (c) {
      c.innerHTML = html;
      c.classList.add('th-dm-fadein');
      // 淡入播完就摘类：留着的话，这个节点日后再被移动/重插时会重播
      c.addEventListener('animationend', function() {
        c.classList.remove('th-dm-fadein');
      }, { once: true });
    } else {
      node.innerHTML = html;
    }
    node.dataset.entering = '0';
  }

  // 只有「新消息」或「内容变过的老消息」才跑 renderRichText；其余复用节点缓存的 HTML。
  // 关键：生成结束时后端会推一次全量 listMessages —— 若对每条都重渲染 + 重写 DOM，
  // 老气泡会被整片重建，视觉上就是「闪一下」。这里靠缓存把未变消息变成 no-op。
  function render(messages) {
    var stream = root && root.querySelector('.th-dm-stream');
    if (!stream) return;
    if (!messages || messages.length === 0) {
      nodeBySeq = Object.create(null);
      stream.innerHTML = '<div class="th-dm-empty">（还没有对话。说点什么，故事就开始了…）</div>';
      firstPaint = false;   // 空态也算首帧落定：之后来的第一条就是真·新消息，该入场
      return;
    }
    var jobs = [];   // 每条消息一个 renderContent Promise，或 null（用缓存）
    var cache = [];  // 索引 → html
    messages.forEach(function(m, i) {
      var key = (m.seq != null) ? String(m.seq) : ('#' + i);
      var node = nodeBySeq[key];
      if (!node || (node.dataset.entering !== '1' && node.__rawContent !== m.content)) {
        jobs[i] = renderContent(m);
      } else {
        jobs[i] = null;
        cache[i] = node.__html;
      }
    });
    var todo = [];
    jobs.forEach(function(p, i) { if (p) todo.push(i); });
    Promise.all(todo.map(function(i) { return jobs[i]; })).then(function(htmls) {
      todo.forEach(function(i, k) { cache[i] = htmls[k]; });
      paint(messages, cache);
    }).catch(function() {
      paint(messages, messages.map(function(m) { return esc(trimLines(m.content)); }));
    });
  }

  // 增量对账：按 seq 复用已有节点，只有「首次出现」的消息才走入场流程。
  function paint(messages, htmls) {
    var stream = root.querySelector('.th-dm-stream');
    if (!stream) return;
    var wasNear = nearBottom();   // 入场前是否贴底 → 决定末尾要不要跟着滚
    var touched = Object.create(null);
    var pending = [];

    // ---- 第一遍：建新节点 / 就地更新内容。此遍一律不动 DOM 结构。 ----
    messages.forEach(function(m, i) {
      var key = (m.seq != null) ? String(m.seq) : ('#' + i);
      touched[key] = true;
      var node = nodeBySeq[key];
      if (!node) {
        // fresh = 本次加载之后才到达的消息；首帧里的历史消息不算，直接成稿
        var fresh = !firstPaint;
        node = elemFromHtml(bubbleHtml(m, fresh ? typingHtml() : (htmls[i] || '')));
        if (!node) return;
        if (fresh) {
          // 新消息：先摆出「正在输入」占位，稍后揭示
          var idx = pending.length;   // 本批次内的出场次序 → 决定错峰延迟
          node.classList.add('th-dm-in');
          node.style.animationDelay = (idx * STAGGER_MS) + 'ms';
          // 入场动画播完立刻摘掉动画类与内联延迟：类留在节点上的话，一旦这个节点
          // 日后再被移动/重插（DOM 移动 = 移除再插入，会重置动画），浏览器就会把
          // th-dm-appear 从头重播一遍 —— 整列旧气泡跟着闪。摘掉后节点不可再被重播。
          node.addEventListener('animationend', function() {
            node.classList.remove('th-dm-in');
            node.style.animationDelay = '';
          }, { once: true });
          pending.push({ node: node, idx: idx });
        } else {
          node.dataset.entering = '0';   // 已成品，无待揭示内容
        }
        node.dataset.seqKey = key;
        node.__rawContent = m.content;
        node.__html = htmls[i] || '';
        nodeBySeq[key] = node;
      } else if (node.dataset.entering !== '1') {
        // 老消息：内容有变才重写（相同 = no-op，杜绝每次 refresh 都重建 DOM 的闪烁）
        if (node.__rawContent !== m.content) {
          var c = node.querySelector('.th-dm-content');
          if (c) c.innerHTML = htmls[i];
          node.__rawContent = m.content;
          node.__html = htmls[i] || '';
        }
      } else if (htmls[i] != null) {
        // 仍在占位阶段（ENTER_MS 内又来一次 refresh）：更新待揭示的内容
        node.__rawContent = m.content;
        node.__html = htmls[i];
      }
    });

    // 清掉本次不再存在的节点（含空态占位）——先清，下面摆位的游标才对得上
    Array.prototype.slice.call(stream.children).forEach(function(ch) {
      var k = ch.dataset ? ch.dataset.seqKey : null;
      if (!k || !touched[k]) {
        if (k && nodeBySeq[k]) delete nodeBySeq[k];
        ch.remove();
      }
    });

    // ---- 第二遍：按序摆放，只在节点不在期望位置时才移动它。 ----
    // ⚠️ 不能像以前那样对每条都 `stream.appendChild(node)` 来"顺带排序"：
    // appendChild 作用在**已在同一父下**的节点上 = 先移除再插入（Chrome 官方
    // moveBefore 文档明说这种"隐式移除会重置各类状态"），CSS 动画随之被重置并
    // 从头播放——于是每次 refresh 所有旧气泡都重播一遍 th-dm-in 入场动画，
    // 整列闪一下。改用游标比对：顺序本来就对的节点一个都不碰。
    var ref = stream.firstChild;
    messages.forEach(function(m, i) {
      var key = (m.seq != null) ? String(m.seq) : ('#' + i);
      var node = nodeBySeq[key];
      if (!node) return;
      if (node === ref) {
        ref = node.nextSibling;      // 已在期望位置 → 游标前进
      } else {
        stream.insertBefore(node, ref);   // ref 为 null 时等同追加到末尾
      }
    });

    // 首帧落定：本帧内已存在的消息都按「旧消息」处理过了，之后到达的才走入场
    firstPaint = false;

    // 入场：按次序错峰出场（第 i 条等 i×STAGGER），各自占位 ENTER_MS 后再揭示正文
    pending.forEach(function(p) {
      p.node.dataset.entering = '1';
      setTimeout(function() {
        if (!p.node.isConnected) return;
        var stick = nearBottom();
        reveal(p.node, p.node.__html || '');
        if (stick) scrollBottom();
      }, p.idx * STAGGER_MS + ENTER_MS);
    });

    // 只有原本就贴底时才跟随滚动（免得把正在上翻看历史的玩家拽回来）
    if (wasNear) scrollBottom();
  }

  // ---- 忙碌态：锁输入条 + 显示等待提示 ----
  // 秒数只在忙过 3 秒后才露出来：短回合闪一下反而显得卡。
  function busyLabel() {
    var secs = Math.floor((Date.now() - busySince) / 1000);
    return secs >= 3 ? ('DM 正在工作… ' + secs + 's') : 'DM 正在工作…';
  }

  function paintBusy() {
    if (!root) return;
    var box = root.querySelector('.th-dm-working');
    var text = root.querySelector('.th-dm-working-text');
    var input = root.querySelector('.th-dm-input');
    var send = root.querySelector('.th-dm-send');
    var wrap = root.querySelector('.th-dm-inputwrap');
    if (box) box.className = busy ? 'th-dm-working on' : 'th-dm-working';
    if (text) text.textContent = busy ? busyLabel() : '';
    if (input) {
      input.disabled = busy;
      input.placeholder = busy ? 'DM 正在工作，请稍候…' : '说点什么…';
    }
    if (send) send.disabled = busy;
    if (wrap) wrap.className = busy
      ? 'th-dm-inner th-dm-inputwrap th-dm-locked'
      : 'th-dm-inner th-dm-inputwrap';
  }

  // since：宿主给出的权威起始时刻（epoch ms）。iframe 重建时靠它把秒数续上，
  // 而不是从 0 重数。空闲时不保留定时器。
  function setBusy(on, since) {
    on = !!on;
    var wasBusy = busy;
    busy = on;
    if (on) {
      busySince = (typeof since === 'number' && since > 0)
        ? since
        : (wasBusy && busySince ? busySince : Date.now());
    } else {
      busySince = 0;
    }
    if (busyTicker) { clearInterval(busyTicker); busyTicker = null; }
    if (on) busyTicker = setInterval(paintBusy, 1000);
    paintBusy();
  }

  function build() {
    ensureStyle();
    root = document.createElement('div');
    root.className = 'th-dm-root';
    // 注意：沙盒 iframe 是 sandbox="allow-scripts"（无 allow-forms），用 <form>
    // 提交会被浏览器拦截、点发送毫无反应 —— 必须 click / Enter 手动触发。
    root.innerHTML =
      '<div class="th-dm-list"><div class="th-dm-inner th-dm-stream"></div></div>' +
      '<div class="th-dm-inputbar">' +
      '<div class="th-dm-working"><span class="th-dm-working-dot"></span>' +
      '<span class="th-dm-working-text"></span></div>' +
      '<div class="th-dm-inner th-dm-inputwrap">' +
      '<button class="th-dm-open" type="button" title="唤起 DM 栏">' +
      '<span class="th-dm-open-dot"></span>DM</button>' +
      '<input class="th-dm-input" type="text" placeholder="说点什么…" autocomplete="off">' +
      '<button class="th-dm-send" type="button" title="发送">' + SEND_ICON + '</button>' +
      '</div></div>';
    document.body.appendChild(root);
    var input = root.querySelector('.th-dm-input');
    var sendBtn = root.querySelector('.th-dm-send');
    var openDmBtn = root.querySelector('.th-dm-open');
    openDmBtn.addEventListener('click', function() {
      if (window.Teahouse.openDM) window.Teahouse.openDM();
    });
    function submit() {
      if (busy) return;   // 忙碌期间输入条已 disabled，这里兜底键盘/程序化触发
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
    // 新根节点落地时可能已经处于忙碌（iframe 刚重建 / 提示先于建树到达）
    paintBusy();
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

  // 后端权威的「DM 是否正在工作」：宿主把 session_event 的 running map 归一成
  // 这个事件（payload: { sessions:{<sid>:true}, busy, since }），只在开始 / 结束
  // 两个沿各推一次，不随流式正文高频刷新。
  // 只认 DM 会话自身——主导演在后台跑（生成正文、总结等）不该锁住玩家对话。
  window.Teahouse.on('session.busy', function(data) {
    var sessions = (data && data.sessions) || {};
    setBusy(!!sessions[DM_SID], data && data.since);
  });

  refresh();
})();
