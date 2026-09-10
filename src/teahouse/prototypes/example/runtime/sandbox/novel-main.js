(function() {
  'use strict';

  // ============================================================
  // novel-main.js — 小说模式主组件（正文渲染 + 翻页 + 输入条 合体）
  // ------------------------------------------------------------
  // 合并自 teahouse-maintext-renderer.js（正文渲染 / 翻页 / 流式草稿）
  // 与 input-bar.js（五模式输入条 / 状态机 / 判定管线 / 子会话）。
  //
  // 版式参考 dm-main.js：正文区（flex:1 滚动）与底部输入条上下排列于
  // 同一全屏容器内，正文列与输入条共用「同宽居中」的内层列
  // （min(90%, 760px)）。复用 theme.css 的 CSS 变量，亮暗主题 /
  // 宿主字号自动跟随；组件样式一律内嵌，不写独立 .css。
  //
  // 输入条五模式（无独立「转正确认」步骤：转正并入「生成下一章」）：
  //   READY        最新章是正式稿 → 打字可用；菜单仅 chat/gen/summarize
  //   GENERATING   生成/重写中 → 打字禁用，右侧为「停止」按钮，可 Esc 打断
  //   AWAIT_COMMIT 最新章是草稿 → 打字可用；菜单含 rewrite/continue
  //   写下一章 = （若有草稿先转正）写 user_msg + Generate floor-N-draft.md
  //   续写补全 = Generate 补全到 temp → 子会话合并写回草稿
  //   重写草稿 = Generate overwrite 覆写当前草稿（仅草稿）
  //   转正 = 由「生成下一章」提交时自动触发（commitDraft 闸门）
  //   附加：打字自带尖括号 <骰子串> → 自选判定，roll 后拼 <骰子串=N>
  // ============================================================

  // ============================================================
  // 0. 全局共享状态
  // ============================================================
  var pageState = { floors: [], currentIndex: 0 };
  window.Teahouse._pageState = pageState;

  // ---- 自动跳转最新章节开关（默认开；持久化到 runtime var，刷新不丢） ----
  var autoJumpLatest = true;
  window.Teahouse._autoJumpLatest = autoJumpLatest;
  window.Teahouse.getVars(['auto_jump_latest']).then(function(entries) {
    if (entries && entries[0] && entries[0].value === false) {
      autoJumpLatest = false;
      window.Teahouse._autoJumpLatest = false;
      window.Teahouse._emit('autoJump.change', { value: false });
    }
  }).catch(function() {});

  // ============================================================
  // 1. 布局与交互样式（内嵌 <style>）
  // ============================================================
  var styleTag = document.createElement('style');
  styleTag.textContent = [
    // 全屏根容器：上下 flex（正文区 + 输入条）
    '.th-novel-root{position:fixed;inset:0;z-index:60;display:flex;flex-direction:column;',
    'background:var(--bg);color:var(--text);font-family:inherit;}',
    // 正文滚动区（负责滚动）
    '.th-novel-list{flex:1;overflow-y:auto;padding:2.5rem 0.5rem 2rem;}',
    // 同宽居中内容列（正文与输入条共用）
    '.th-novel-inner{width:min(90%,760px);margin:0 auto;}',
    // 底部输入条区
    '.th-novel-inputbar{flex:none;padding:8px 0.5rem 10px;}',
    // 药丸输入条（外观取自 dm-main）
    '.th-novel-pill{position:relative;display:flex;align-items:center;gap:6px;',
    'background:var(--input-bg);border:1px solid var(--panel-border);border-radius:999px;',
    'padding:3px 5px 3px 6px;box-shadow:0 2px 10px rgba(0,0,0,.12);',
    'font-family:"Noto Sans SC","PingFang SC",sans-serif;',
    'transition:border-color .2s,background .25s;}',
    '.th-novel-pill:focus-within{border-color:var(--accent);}',
    // 状态行
    '.th-novel-status{text-align:center;color:var(--panel-text-dim);',
    'font-family:"Noto Sans SC","PingFang SC",sans-serif;',
    'font-size:calc(11px * var(--font-scale));margin-top:6px;letter-spacing:0.08em;min-height:16px;}',
    // 隐藏 bootstrap 的空正文容器（本组件自带正文区）
    '#teahouse-content{display:none;}',
    // 交互态
    '#teahouse-mode-btn:hover:not(:disabled){background:rgba(255,255,255,0.08);}',
    '#teahouse-think-btn:hover:not(:disabled){background:var(--control-bg);border-color:var(--border-strong);}',
    '#teahouse-input-send:hover:not(:disabled){opacity:0.85;}',
    '#teahouse-input-send:disabled{opacity:0.5;cursor:not-allowed;}',
    '.teahouse-mode-item:hover{background:var(--control-bg);}'
  ].join('');
  document.head.appendChild(styleTag);

  // ============================================================
  // 2. DOM 骨架（正文区 + 输入条，上下排列于同一容器）
  // ============================================================
  var root = document.createElement('div');
  root.className = 'th-novel-root';

  // ---- 正文区 ----
  var listEl = document.createElement('div');
  listEl.className = 'th-novel-list';
  var listInner = document.createElement('div');
  listInner.className = 'th-novel-inner';
  var contentEl = document.createElement('div');
  contentEl.className = 'th-novel-content';
  listInner.appendChild(contentEl);
  listEl.appendChild(listInner);
  root.appendChild(listEl);

  // ---- 输入条区 ----
  var inputBar = document.createElement('div');
  inputBar.className = 'th-novel-inputbar';
  var inputBarInner = document.createElement('div');
  inputBarInner.className = 'th-novel-inner';
  inputBar.appendChild(inputBarInner);
  root.appendChild(inputBar);

  // ============================================================
  // 3. 输入条：五模式 / 思考强度 / 状态机
  // ============================================================
  var MODE_CHAT = 'chat';
  var MODE_GEN  = 'gen';
  var MODE_REWRITE = 'rewrite';
  var MODE_CONT = 'continue';
  var MODE_SUMM = 'summarize';

  var MODES = {
    chat: {
      label: '与导演对话',
      dot: '#5b8cff',
      btnBg: '#5b8cff',
      placeholder: '对导演说点什么…（Enter 发送）'
    },
    gen: {
      label: '生成下一章',
      dot: '#22c55e',
      btnBg: '#22c55e',
      placeholder: '输入下一章的要点…（Enter 生成）'
    },
    rewrite: {
      label: '重写本章',
      dot: '#f87171',
      btnBg: '#f87171',
      placeholder: '输入本章重写的要点…（Enter 重写）'
    },
    continue: {
      label: '续写补全',
      dot: '#a78bfa',
      btnBg: '#a78bfa',
      placeholder: '输入续写补全的要点…（Enter 补全）'
    },
    summarize: {
      label: '总结归纳',
      dot: '#f59e0b',
      btnBg: '#f59e0b',
      placeholder: '输入总结范围，如：最近10章 或者 71~79章'
    }
  };

  /* ---- 状态机 ---- */
  var S_READY = 'ready';
  var S_GEN   = 'generating';
  var S_AWAIT = 'await_commit';
  var state = S_READY;

  var currentMode = MODE_GEN;
  var activeRun = null;         // 当前进行中的 runTool handle（用于打断生成）
  var activeSid = null;         // 当前活跃的子会话 id（续写合并 / 总结归纳）
  var activeSessionLabel = '';  // 活跃子会话的类型名
  var statusTimer = null;

  /* 思考强度（所有 Generate 共用）：五档变量，点按钮轮换 */
  var THINK_VAR = '思考强度';   // 沙盒变量名，值 = 一档
  var THINK_LEVELS = [          // 按钮显示 = 档名；档名 → Generate 的 reasoning_effort
    { label: '无',   effort: 'none' },
    { label: '低',   effort: 'low'  },
    { label: '中',   effort: 'mid'  },
    { label: '高',   effort: 'high' },
    { label: '极',   effort: 'max'  }
  ];
  var thinkEffort = 'none';     // 当前生效的 effort（兜底默认无）
  var thinkInitPromise = null;  // 读档初始化只跑一次

  var PLACEHOLDER_BUSY = '导演正在执笔…';

  /* ---- 药丸容器（= 原 form / inputArea） ---- */
  var pill = document.createElement('div');
  pill.className = 'th-novel-pill';
  pill.id = 'teahouse-input-bar';
  var inputArea = pill;   // 兼容原代码对 inputArea 的引用

  /* ---- 模式按钮（左侧触发器） ---- */
  var modeBtn = document.createElement('button');
  modeBtn.id = 'teahouse-mode-btn';
  modeBtn.type = 'button';
  modeBtn.title = '切换输入模式';
  modeBtn.style.cssText =
    'flex:none;height:28px;padding:0 10px;border-radius:20px;' +
    'display:flex;align-items:center;gap:5px;' +
    'background:transparent;border:1px solid var(--panel-border);' +
    'font-size:calc(12px * var(--font-scale));font-weight:600;cursor:pointer;user-select:none;' +
    'transition:background 0.2s,border-color 0.2s,color 0.2s;';

  var modeLabel = document.createElement('span');
  var modeArrow = document.createElement('span');
  modeArrow.textContent = '\u25BE';
  modeArrow.style.cssText = 'font-size:calc(9px * var(--font-scale));opacity:0.8;';
  modeBtn.appendChild(modeLabel);
  modeBtn.appendChild(modeArrow);

  /* ---- 思考强度按钮：点击轮换，显示当前档名 ---- */
  var thinkBtn = document.createElement('button');
  thinkBtn.id = 'teahouse-think-btn';
  thinkBtn.type = 'button';
  thinkBtn.title = '思考强度：点击轮换（无/低/中/高/极）';
  thinkBtn.style.cssText =
    'flex:none;height:22px;padding:0 8px;border-radius:999px;' +
    'display:inline-flex;align-items:center;gap:3px;' +
    'background:var(--control-bg);border:1px solid var(--panel-border);' +
    'font-size:calc(10.5px * var(--font-scale));font-weight:700;cursor:pointer;user-select:none;' +
    'color:var(--text-dim);line-height:1;' +
    'transition:background 0.2s,border-color 0.2s,color 0.2s;';

  var thinkLabel = document.createElement('span');
  thinkBtn.appendChild(thinkLabel);

  var input = document.createElement('input');
  input.id = 'teahouse-input';
  input.type = 'text';
  input.autocomplete = 'off';
  input.style.cssText =
    'flex:1;min-width:0;height:auto;border:none;background:transparent;' +
    'line-height:1;color:var(--panel-text);outline:none;' +
    'caret-color:var(--accent);font-size:calc(13px * var(--font-scale));';

  var sendBtn = document.createElement('button');
  sendBtn.id = 'teahouse-input-send';
  sendBtn.type = 'button';
  sendBtn.title = '发送';
  /* 纸飞机发送 icon（feather send），颜色随当前模式按钮色（currentColor） */
  var SEND_ICON =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
    'style="display:block;margin:0 auto;">' +
    '<path d="M22 2L11 13"/><path d="M22 2L15 22l-4-9-9-4z"/></svg>';
  sendBtn.style.cssText =
    'flex:none;height:28px;min-width:28px;padding:0 12px;border:none;border-radius:20px;' +
    'display:flex;align-items:center;justify-content:center;cursor:pointer;' +
    'transition:opacity 0.2s;';

  /* ---- 打断按钮：生成中显示，点击中断当前 runTool ---- */
  var stopBtn = document.createElement('button');
  stopBtn.id = 'teahouse-input-stop';
  stopBtn.type = 'button';
  stopBtn.title = '打断本次生成（Esc）';
  stopBtn.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" ' +
    'style="display:block;margin:0 auto;">' +
    '<rect x="5" y="5" width="14" height="14" rx="1.5"/></svg>';
  stopBtn.style.cssText =
    'flex:none;height:28px;min-width:28px;padding:0 10px;border:none;border-radius:20px;' +
    'display:none;align-items:center;justify-content:center;cursor:pointer;' +
    'background:var(--danger-fill);color:var(--danger-filled-text);' +
    'transition:opacity 0.2s;';

  pill.appendChild(modeBtn);
  pill.appendChild(thinkBtn);
  pill.appendChild(input);
  pill.appendChild(sendBtn);
  pill.appendChild(stopBtn);

  /* ---- 上拉菜单 ---- */
  var menu = document.createElement('div');
  menu.id = 'teahouse-mode-menu';
  menu.style.cssText =
    'position:absolute;bottom:calc(100% + 8px);left:0;z-index:var(--z-panel);' +
    'min-width:176px;padding:4px;' +
    'background:var(--panel);color:var(--panel-text);' +
    'border:1px solid var(--panel-border);border-radius:12px;' +
    'box-shadow:var(--shadow-panel);' +
    'display:none;overflow:hidden;' +
    'font-size:calc(12.5px * var(--font-scale));';
  pill.appendChild(menu);

  /* ---- 状态行 ---- */
  var status = document.createElement('div');
  status.id = 'teahouse-input-status';
  status.textContent = '';
  status.className = 'th-novel-status';

  inputBarInner.appendChild(pill);
  inputBarInner.appendChild(status);

  function menuItemHtml(key, m) {
    var active = (currentMode === key);
    var bg = active ? (m.dot + '22') : 'transparent';
    var fg = active ? m.dot : 'var(--panel-text-soft)';
    return '<div class="teahouse-mode-item" data-mode="' + key + '" style="' +
      'display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;' +
      'cursor:pointer;background:' + bg + ';color:' + fg + ';' +
      'transition:background 0.15s;">' +
      '<span style="width:8px;height:8px;border-radius:50%;background:' + m.dot + ';flex:none;"></span>' +
      '<span style="flex:1;">' + m.label + '</span>' +
      (active ? '<span style="font-size:calc(10px * var(--font-scale));">&#10003;</span>' : '') +
      '</div>';
  }

  /* 菜单项按最新章是否草稿过滤：
     草稿态 → chat/gen/rewrite/continue/summarize（草稿阶段可折腾）
     正式稿态 → chat/gen/summarize（rewrite/continue 只服务草稿，不可见） */
  function latestHasDraft() {
    var st = window.Teahouse._pageState || { floors: [], currentIndex: 0 };
    var floors = st.floors || [];
    var top = floors.length ? floors[floors.length - 1] : null;
    return !!(top && top.draft);
  }

  function modeOrder() {
    var order = [MODE_CHAT, MODE_GEN, MODE_SUMM];
    if (latestHasDraft()) {
      return [MODE_CHAT, MODE_GEN, MODE_REWRITE, MODE_CONT, MODE_SUMM];
    }
    return order;
  }

  function renderMenu() {
    var html = '';
    var order = modeOrder();
    for (var i = 0; i < order.length; i++) {
      html += menuItemHtml(order[i], MODES[order[i]]);
    }
    menu.innerHTML = html;
    var items = menu.querySelectorAll('.teahouse-mode-item');
    for (var j = 0; j < items.length; j++) {
      (function(el) {
        el.addEventListener('click', function(e) {
          e.stopPropagation();
          var key = el.getAttribute('data-mode');
          // 防御：菜单里已过滤，但万一切到只服务草稿的模式且无草稿 → 忽略
          if ((key === MODE_REWRITE || key === MODE_CONT) && !latestHasDraft()) {
            closeMenu();
            applyState(S_READY);
            return;
          }
          currentMode = key;
          closeMenu();
          applyMode();
        });
      })(items[j]);
    }
  }

  function openMenu() { renderMenu(); menu.style.display = 'block'; }
  function closeMenu() { menu.style.display = 'none'; }

  /* ---- 思考强度档位 ---- */
  function thinkEffortOfLabel(label) {
    for (var i = 0; i < THINK_LEVELS.length; i++) {
      if (THINK_LEVELS[i].label === label) return THINK_LEVELS[i].effort;
    }
    return null;   // 未知档名 → 交给外层回退 'none'
  }
  function thinkLabelOfEffort(effort) {
    for (var i = 0; i < THINK_LEVELS.length; i++) {
      if (THINK_LEVELS[i].effort === effort) return THINK_LEVELS[i].label;
    }
    return '中';
  }
  function syncThinkBtn() {
    thinkLabel.textContent = thinkLabelOfEffort(thinkEffort);
    thinkBtn.title = '思考强度：' + thinkLabelOfEffort(thinkEffort) + '（点击轮换：无/低/中/高/极）';
  }
  /* 初始化只读档一次：变量有值（须能匹配某档）→ 采用；否则默认 none */
  function initThinkOnce() {
    if (thinkInitPromise) return thinkInitPromise;
    thinkInitPromise = window.Teahouse.getVars([THINK_VAR]).then(function(entries) {
      var v = (entries && entries[0]) ? entries[0].value : null;
      var ef = thinkEffortOfLabel(String(v));
      if (ef) thinkEffort = ef;
      syncThinkBtn();
    }).catch(function() { syncThinkBtn(); });
    return thinkInitPromise;
  }
  function setThinkVar(value) {
    var next = {};
    next[THINK_VAR] = value;
    window.Teahouse.setVar(next).catch(function() {});
  }
  /* 点击 → 轮换并落盘 */
  thinkBtn.addEventListener('click', function() {
    var cur = thinkLabelOfEffort(thinkEffort);
    var idx = 0;
    for (var i = 0; i < THINK_LEVELS.length; i++) {
      if (THINK_LEVELS[i].label === cur) { idx = i; break; }
    }
    idx = (idx + 1) % THINK_LEVELS.length;
    thinkEffort = THINK_LEVELS[idx].effort;
    syncThinkBtn();
    setThinkVar(THINK_LEVELS[idx].label);
  });

  /* ---- 模式应用 ---- */
  /* sendBtn 只有「发送」一个形态：转正已并入「生成下一章」提交，不再有独立确认按钮 */
  function syncSendBtn() {
    sendBtn.innerHTML = SEND_ICON;
    sendBtn.style.background = MODES[currentMode].btnBg;
    sendBtn.style.color = '#1a1a1a';
    sendBtn.style.minWidth = '28px';
    sendBtn.style.padding = '0 12px';
    sendBtn.style.fontSize = '';
    var btnTitle = (currentMode === MODE_CHAT) ? '发送'
      : (currentMode === MODE_GEN) ? '生成下一章'
      : (currentMode === MODE_REWRITE) ? '重写本章'
      : (currentMode === MODE_CONT) ? '续写补全'
      : '总结归纳';
    // 草稿态 gen：提交会先转正本章，再生成下一章
    if (currentMode === MODE_GEN && latestHasDraft()) btnTitle = '转正本章并生成下一章';
    sendBtn.title = btnTitle;
  }

  function applyMode() {
    var m = MODES[currentMode];
    modeLabel.textContent = m.label;
    modeBtn.style.color = m.dot;
    modeBtn.style.borderColor = m.dot;
    syncSendBtn();
    input.placeholder = m.placeholder;
    input.setAttribute('placeholder', m.placeholder);
    // 重写模式：以 user_msg 填充输入框，用户可修改
    if (currentMode === MODE_REWRITE) {
      window.Teahouse.getVars(['user_msg']).then(function(entries) {
        var v = entries && entries[0] ? entries[0].value : null;
        input.value = (v !== null && v !== undefined) ? String(v) : '';
      }).catch(function() {});
    } else {
      input.value = '';
    }
    // 若处于 AWAIT 态，切模式后刷新「打字可用性」（gen 禁用，其余可用）
    applyInputAvailability();
  }

  /* ---- 输入可用性：AWAIT（有草稿）态下打字一律可用 ----
     gen 模式提交 = 先转正本章草稿，再生成下一章；其余模式照常。 */
  function applyInputAvailability() {
    if (state !== S_AWAIT) return;
    input.disabled = false;
    sendBtn.style.display = 'flex';
    sendBtn.disabled = false;
    syncSendBtn();
    if (currentMode === MODE_GEN) {
      input.placeholder = '输入下一章要点…（提交将先转正本章，再生成下一章）';
    } else {
      input.placeholder = MODES[currentMode].placeholder;
    }
    input.setAttribute('placeholder', input.placeholder);
  }

  /* ---- 状态机 ---- */
  function applyState(s) {
    state = s;
    if (s === S_GEN) {
      input.disabled = true;
      modeBtn.disabled = true;
      sendBtn.style.display = 'none';
      sendBtn.disabled = true;
      stopBtn.style.display = 'inline-block';
      inputArea.style.display = 'flex';
      input.placeholder = PLACEHOLDER_BUSY;
      input.setAttribute('placeholder', input.placeholder);
      status.textContent = PLACEHOLDER_BUSY;
      input.blur();
    } else if (s === S_AWAIT) {
      modeBtn.disabled = false;
      stopBtn.style.display = 'none';
      inputArea.style.display = 'flex';
      applyInputAvailability();
      status.textContent = '草稿已就绪：直接生成下一章将自动转正本章；或切换「重写 / 续写」修改草稿';
    } else {
      // READY：正式稿态，rewrite/continue 不可用 → 防御性强制切回 gen
      if (currentMode === MODE_REWRITE || currentMode === MODE_CONT) {
        currentMode = MODE_GEN;
        applyMode();
      }
      input.disabled = false;
      modeBtn.disabled = false;
      sendBtn.style.display = 'flex';
      sendBtn.disabled = false;
      stopBtn.style.display = 'none';
      inputArea.style.display = 'flex';
      syncSendBtn();
      status.textContent = '';
      input.placeholder = MODES[currentMode].placeholder;
      input.setAttribute('placeholder', input.placeholder);
    }
  }

  /* 从权威楼层清单判定状态：最新章是 draft → AWAIT_COMMIT，否则 READY */
  function refreshState() {
    window.Teahouse.listFloors().then(function(floors) {
      var top = (floors && floors.length) ? floors[floors.length - 1] : null;
      if (top && top.draft) applyState(S_AWAIT);
      else applyState(S_READY);
    }).catch(function() {});
  }

  /* ---- 子会话运行期：输入框可继续打字，打字 = 补发给当前活跃子会话 ----
     收到子会话 EndSession（session_done）后回到普通可输入态，不自动销毁。 */
  function setSessionActive(sid, label) {
    activeSid = sid;
    activeSessionLabel = label;
    input.disabled = false;
    modeBtn.disabled = true;   // 补发期禁切模式，提交一律走补发
    sendBtn.style.display = 'flex';
    sendBtn.disabled = false;
    stopBtn.style.display = 'none';
    inputArea.style.display = 'flex';
    syncSendBtn();
    input.placeholder = '给' + label + '子会话补发消息…（Enter 发送）';
    input.setAttribute('placeholder', input.placeholder);
  }
  function clearSessionActive() {
    activeSid = null;
    activeSessionLabel = '';
    refreshState();   // 回到按最新章 draft 判定的状态
  }

  /* ---- 打断生成 ---- */
  function cancelActive() {
    if (activeRun && activeRun.cancel) {
      activeRun.cancel();
    }
  }

  function isCancelledErr(err) {
    return errMsg(err).indexOf('已取消') !== -1;
  }

  function flashStatus(text) {
    status.textContent = text;
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(function() {
      if (!input.disabled && status.textContent === text) status.textContent = '';
    }, 2400);
  }

  function errMsg(err) {
    if (!err) return '';
    if (typeof err === 'string') return err;
    if (err.message) return err.message;
    try { return JSON.stringify(err); } catch (e) { return String(err); }
  }

  /* ---- 当前最高楼层 / 最高草稿 ---- */
  function currentTop() {
    var st = window.Teahouse._pageState || { floors: [], currentIndex: 0 };
    var floors = st.floors || [];
    return floors.length ? floors[floors.length - 1] : null;
  }

  /* ============ 判定管线（打字用） ============
      输入：原始 user 内容
      输出：Promise<最终 user_msg>
      规则：内容自带尖括号 <骰子串> → 视为自选判定，roll 该骰子，拼 <骰子串=N> 到末尾；
            不带尖括号则原样发送，不做任何自动判定。 */
  function finalizeUserMsg(rawText) {
    var text = String(rawText || '').trim();
    if (!text) return Promise.resolve(text);
    var diceM = /<([^<>]+)>/.exec(text);
    if (diceM) {
      // 自带判定：roll 对应骰子，拼 <骰=N> 到末尾
      var dice = diceM[1].trim();
      if (dice) {
        return window.Teahouse.roll(dice).then(function(n) {
          return text + '<' + dice + '=' + n + '>';
        }).catch(function() {
          return text;   // roll 失败：原样发，不阻塞
        });
      }
    }
    return Promise.resolve(text);
  }

  /* 生成下一章（含判定管线）：
      先 applyState(S_GEN) 立即进生成态，再异步判定管线拿最终 msg；
      若当前最新章是草稿 → 先 commitDraft(N) 转正本章，再 Generate 下一章草稿；否则直接生成。 */
  function genWithJudgement(rawText) {
    var top = currentTop();
    var hadDraft = !!(top && top.draft);
    var commitNum = hadDraft ? top.num : 0;
    var nextNum = (top ? top.num : 0) + 1;
    applyState(S_GEN);                       // 同步进生成态（立即反馈）
    finalizeUserMsg(rawText).then(function(finalMsg) {
      var doGenSteps = function() {
        var steps = [
          { tool: 'SetRuntimeVar', args: { updates: { user_msg: finalMsg } } },
          { tool: 'Generate', args: {
            source_file: 'generate-config/generate.yaml',
            path: 'runtime/floors/floor-' + nextNum + '-draft.md',
            reasoning_effort: thinkEffort
          }}
        ];
        var h = window.Teahouse.runTool(steps);
        activeRun = h;
        return h;
      };
      var chain;
      if (hadDraft) {
        status.textContent = '正在转正本章草稿…';
        chain = window.Teahouse.commitDraft(commitNum).then(function(res) {
          if (!res || !res.ok) {
            throw new Error('转正失败：' + ((res && res.error) || '未知错误'));
          }
          return doGenSteps();
        });
      } else {
        chain = doGenSteps();
      }
      return chain.then(function() {
        activeRun = null;
        refreshState();
      }).catch(function(err) {
        activeRun = null;
        if (isCancelledErr(err)) {
          flashStatus('已停止生成');
          console.log('[NovelMain] gen cancelled:', err);
        } else {
          status.textContent = '生成失败：' + errMsg(err);
          console.error('[NovelMain] gen failed:', err);
        }
        refreshState();
      });
    });
  }

  /* ---- 生成下一章（打字回车用） ---- */
  function doGen(text) {
    genWithJudgement(text);
  }

  /* ---- 重写本章（仅草稿）：Generate overwrite 覆写当前草稿，不碰 git ----
      正式稿不可重写（标准流程锁定），想改走导演/手动危险操作。 */
  function doRewrite(text) {
    var top = currentTop();
    if (!top || !top.draft) {
      refreshState();
      flashStatus('没有草稿可重写（正式稿不可重写）');
      return;
    }
    var n = top.num;
    var steps = [
      { tool: 'SetRuntimeVar', args: { updates: { user_msg: text } } },
      { tool: 'Generate', args: {
        source_file: 'generate-config/generate.yaml',
        path: 'runtime/floors/floor-' + n + '-draft.md',
        overwrite: true,
        reasoning_effort: thinkEffort
      }}
    ];
    applyState(S_GEN);
    status.textContent = '正在重写本章草稿…';
    var h = window.Teahouse.runTool(steps);
    activeRun = h;
    h.then(function() {
      activeRun = null;
      refreshState();
      flashStatus('已重写本章 ✓');
    }).catch(function(err) {
      activeRun = null;
      if (isCancelledErr(err)) {
        flashStatus('已停止重写');
        console.log('[NovelMain] rewrite cancelled:', err);
      } else {
        status.textContent = '重写失败，请重试';
        console.error('[NovelMain] rewrite failed:', err);
      }
      refreshState();
    });
  }

  /* ---- 找导演走「与导演对话」模式，回档是危险操作不做常驻按钮 ---- */

  /* ---- 续写补全流水线（仅草稿） ----
      1) 写 user_msg
      2) Generate 补全内容到 temp/floor-N-draft-补全.md（continue.yaml，temp 中间产物直接覆盖）
      3) 开启子会话：合并 原文+补全 → 完整章节正文，写回 floor-N-draft.md
      子会话完成后（session_done）通知玩家，不自动销毁。 */
  var CONT_YAML = 'generate-config/continue.yaml';

  function buildContinueSteps(text) {
    var top = currentTop();
    if (!top || !top.draft) return Promise.reject(new Error('NO_DRAFT'));
    var n = top.num;
    var srcPath = 'runtime/floors/floor-' + n + '-draft.md';
    var contPath = 'temp/floor-' + n + '-draft-补全.md';
    var steps = [
      { tool: 'SetRuntimeVar', args: { updates: { user_msg: text } } },
      { tool: 'Generate', args: {
        source_file: CONT_YAML,
        path: contPath,
        overwrite: true,
        reasoning_effort: thinkEffort
      }}
    ];
    return Promise.resolve({ steps: steps, n: n, srcPath: srcPath, contPath: contPath });
  }

  function openContinueSession(info) {
    var srcPath = info.srcPath;
    var contPath = info.contPath;
    var task = [
      '你的任务是合并文件，核心目标是在 ' + srcPath + ' 的基础上进行修改以得到完整的章节正文。',
      '我们正在工作的对象是 ' + srcPath + '，其内容可能不完整或者需要大改，因此基于 generate 工具创建了 ' + contPath + '。',
      '该任务用到的配置文件 yaml 是：' + CONT_YAML + '。对于完整正文的要求在其中应该有提到。你需要把原文和新产出的文章进行结合以符合完整正文的要求。',
      '常见场景：1) 原文写到一半中断（如网络断开），需要续写剩余部分；2) 原文某段写得不好被用户删掉并留下占位符（如 ...、〔待补〕、TODO 等），需要重写该段；3) 原文结尾缺少 metadata/状态标记，需要补上。',
      '【操作方式 · 第一回合尽量读全 · 节约 token 优先】',
      '参考文件 ' + contPath + ' 是「切片源」，不是输出目标；输出目标 ' + srcPath + ' 可以被修改。',
      '不要整篇重写，也不要重复输出两边都已有的内容。具体做法：',
      '1) 第一回合就把本任务涉及的所有文件尽量一次性读完：Read ' + contPath + ' 和 ' + srcPath + '（以及任务里提到的其他任何文件），不要分多个批次逐个读。一次 Read 之间不要夹其他操作，尽量在同一轮内完成全部阅读，再一次性判断哪些部分烂掉/重复/多余；',
      '2) 把原文里烂掉的部分删掉、把补全文件里用不到或重复的部分删掉，让两边能对齐；',
      '3) 用 Edit / WriteLine 工具精准修改 ' + srcPath + '，new_content 里用 {{}} 切片语法直接引用干净的补全文件内容，例如 {{' + contPath + ':10-30}} 或 {{' + contPath + '|from="关键词"|to="关键词"}}，让后端把对应行切片展开后写入，实现精准合并；',
      '4) 需要整段替换时也用 Edit + 切片引用，不要在 new_content 里手打整段大文本。',
      '【进度与汇报】请使用 TodoWrite 工具维护一个任务清单，逐步记录本次合并的进度（读取文件 / 判断烂段 / 修改正文 / 收尾）。处理过程中可以简要说明你正在做什么，不必静默。',
      '【完成宣告】任务全部做完后，先以文本输出这句话：「续写合并已完成 ✓ 如希望清理，请输入 /clear」，然后调用 EndSession 宣告任务结束。EndSession 之后不要输出任何内容。'
    ].join('\n');
    window.Teahouse.openDirector();   // 子会话启动前先唤起导演栏，让玩家能看到补全过程并介入
    return window.Teahouse.sessionCreate({
        enabled_tools: ['Read', 'Glob', 'Grep', 'Edit', 'WriteLine', 'TodoWrite', 'EndSession'],
        reasoning_effort: 'none'
      }).then(function(created) {
        if (!created || !created.ok) {
          throw new Error((created && created.error) || '创建子会话失败');
        }
        var sid = created.data.session_id;
        window.Teahouse.sessionSend(sid, task);
        return sid;
      });
  }

  /* 续写合并子会话：收到 EndSession 后通知完成并恢复输入；不自动销毁 */
  function onSessionDone(sid) {
    var handler = function(data) {
      if (!data || data.session_id !== sid) return;
      window.Teahouse.off('session_done', handler);
      window.Teahouse.off('session_destroyed', destroyHandler);
      clearSessionActive();
      flashStatus('续写合并已完成 ✓ 如希望清理，请输入 /clear');
      console.log('[NovelMain] continue session done:', sid);
    };
    var destroyHandler = function(data) {
      if (!data || data.session_id !== sid) return;
      window.Teahouse.off('session_done', handler);
      window.Teahouse.off('session_destroyed', destroyHandler);
      clearSessionActive();
    };
    window.Teahouse.on('session_done', handler);
    window.Teahouse.on('session_destroyed', destroyHandler);
  }

  function doContinue(text) {
    var top = currentTop();
    if (!top || !top.draft) {
      refreshState();
      flashStatus('当前没有草稿可续写（续写针对草稿）');
      return;
    }
    applyState(S_GEN);
    status.textContent = '正在生成补全内容…';
    buildContinueSteps(text).then(function(info) {
      var h = window.Teahouse.runTool(info.steps);
      activeRun = h;
      return h.then(function() { return info; });
    }).then(function(info) {
      activeRun = null;
      status.textContent = '补全已生成，正在派发子会话合并…';
      return openContinueSession(info);
    }).then(function(sid) {
      onSessionDone(sid);
      setSessionActive(sid, '续写合并');
      flashStatus('已派发续写合并子会话，可继续打字补发');
    }).catch(function(err) {
      activeRun = null;
      clearSessionActive();
      if (isCancelledErr(err)) {
        flashStatus('已停止补全');
        console.log('[NovelMain] continue cancelled:', err);
        return;
      }
      var isNoDraft = err && err.message === 'NO_DRAFT';
      if (isNoDraft) {
        status.textContent = '当前没有草稿可续写（续写针对草稿）';
        input.value = text;   // 恢复输入，不丢内容
      } else {
        status.textContent = '续写失败：' + errMsg(err);
        console.error('[NovelMain] continue failed:', err);
      }
    });
  }

  /* ---- 总结归纳流水线（子会话） ---- */
  var SUMMARIZE_PROMPT = 'summary/summarize-prompt.md';

  function openSummarizeSession(text) {
    window.Teahouse.openDirector();   // 唤起导演栏，让玩家看到总结过程并可介入
    return window.Teahouse.readText(SUMMARIZE_PROMPT).then(function(prompt) {
      var raw = (prompt || '');
      // 用 split/join 全量替换占位符，而非 String.replace：
      // replace 的第二个参数会把 $& / $' / $` / $n 当特殊替换模式，用户输入里带 $ 时
      // 会被吞字、甚至把 __USER_REQUEST__ 原文"还原"出来，表现为占位符没被替换。
      var task = raw.split('__USER_REQUEST__').join(text);
      if (task.indexOf('__USER_REQUEST__') !== -1) {
        throw new Error('总结提示词中仍残留 __USER_REQUEST__ 占位符（模板可能含多份占位符或读取异常）');
      }
      if (!task) {
        throw new Error('总结提示词文件为空或读取失败：' + SUMMARIZE_PROMPT);
      }
      return window.Teahouse.sessionCreate({
          enabled_tools: ['Read', 'Glob', 'Grep', 'GetRuntimeVars', 'SetRuntimeVar',
                          'SkillRead', 'FileOps', 'Write', 'Edit', 'WriteLine',
                          'TodoWrite', 'GitStatus', 'GitDiff', 'GitCommit', 'EndSession'],
          reasoning_effort: 'mid'
        }).then(function(created) {
          if (!created || !created.ok) {
            throw new Error((created && created.error) || '创建子会话失败');
          }
          var sid = created.data.session_id;
          window.Teahouse.sessionSend(sid, task);
          return sid;
        });
    });
  }

  /* 总结子会话：收到 EndSession 后通知完成并恢复输入；不自动销毁 */
  function onSummarizeDone(sid) {
    var handler = function(data) {
      if (!data || data.session_id !== sid) return;
      window.Teahouse.off('session_done', handler);
      window.Teahouse.off('session_destroyed', destroyHandler);
      clearSessionActive();
      flashStatus('总结已完成 ✓ 已提交，如希望清理请输入 /clear');
      console.log('[NovelMain] summarize session done:', sid);
    };
    var destroyHandler = function(data) {
      if (!data || data.session_id !== sid) return;
      window.Teahouse.off('session_done', handler);
      window.Teahouse.off('session_destroyed', destroyHandler);
      clearSessionActive();
    };
    window.Teahouse.on('session_done', handler);
    window.Teahouse.on('session_destroyed', destroyHandler);
  }

  function doSummarize(text) {
    // 派发期间手动禁用输入（不借用 S_GEN 状态机，避免误显停止按钮）
    input.disabled = true;
    modeBtn.disabled = true;
    sendBtn.style.display = 'none';
    stopBtn.style.display = 'none';
    status.textContent = '正在派发总结子会话…';
    openSummarizeSession(text).then(function(sid) {
      onSummarizeDone(sid);
      setSessionActive(sid, '总结');
      flashStatus('已派发总结子会话，可继续打字补发');
    }).catch(function(err) {
      clearSessionActive();
      status.textContent = '派发总结失败：' + errMsg(err);
      console.error('[NovelMain] summarize failed:', err);
    });
  }

  /* ---- 提交入口 ---- */
  function submit() {
    var text = input.value.trim();
    if (!text || input.disabled) return;

    // 子会话运行期：打字 = 补发给当前活跃子会话
    if (activeSid) {
      input.value = '';
      input.blur();
      window.Teahouse.sessionSend(activeSid, text);
      flashStatus('已补发给' + activeSessionLabel + '子会话');
      return;
    }

    if (currentMode === MODE_CHAT) {
      input.value = '';
      input.blur();
      flashStatus('已送达，导演记下了');
      window.Teahouse.openDirector();   // 唤起导演栏，让玩家能看到导演回应
      window.Teahouse.send(text);
    } else if (currentMode === MODE_GEN) {
      input.value = '';
      input.blur();
      doGen(text);
    } else if (currentMode === MODE_REWRITE) {
      input.value = '';
      input.blur();
      doRewrite(text);
    } else if (currentMode === MODE_SUMM) {
      input.value = '';
      input.blur();
      doSummarize(text);
    } else {
      // 续写补全
      input.value = '';
      input.blur();
      doContinue(text);
    }
  }

  sendBtn.addEventListener('click', function() { submit(); });
  stopBtn.addEventListener('click', function() { cancelActive(); });
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });
  // ESC 快捷打断：任意处按 Esc 且正在生成 → 中断当前 runTool
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && activeRun && activeRun.cancel) {
      cancelActive();
    }
  });

  modeBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    if (menu.style.display === 'block') closeMenu();
    else openMenu();
  });
  document.addEventListener('click', function() { closeMenu(); });

  // ============================================================
  // 4. 正文渲染 / 翻页 / 流式草稿
  // ============================================================

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
    window.Teahouse.readText(floor.path).then(function(markdown) {
      if (markdown === null || markdown === undefined) {
        contentEl.innerHTML = '<p style="opacity:.5;text-align:center;padding:3rem 0;">（楼层内容暂不可用）</p>';
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
        contentEl.innerHTML = '';
        contentEl.appendChild(chapter);
        chapter.appendChild(body);
      });
    }).catch(function(err) {
      console.error('[NovelMain] renderFloor failed:', err);
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
    var text = markDraftTitle(draft.text || '');
    window.Teahouse.renderRichText(text).then(function(html) {
      var chapter = document.createElement('article');
      chapter.className = 'teahouse-chapter teahouse-generating';
      var body = document.createElement('div');
      body.className = 'teahouse-chapter-body';
      body.innerHTML = html;
      contentEl.innerHTML = '';
      contentEl.appendChild(chapter);
      chapter.appendChild(body);
      // 打字机跟随：滚动到底，让新生成的内容始终可见
      listEl.scrollTop = listEl.scrollHeight;
    }).catch(function(err) {
      console.error('[NovelMain] renderDraft failed:', err);
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

  // ---- output.refresh 处理（正文） ----
  window.Teahouse.on('output.refresh', function(data) {
    var path = data && data.path;
    if (path) {
      if (path.indexOf('runtime/sandbox/') === 0) {
        return;
      }
      if (path.indexOf('runtime/floors/') === 0) {
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
  window.Teahouse.on('generation.status', function(statusVal) {
    if (statusVal === 'done') {
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
      console.error('[NovelMain] defaultRender failed:', err);
    });
  }

  // ---- 全局翻页接口（供 page-bar 调用） ----
  window.goToPage = goToPage;
  window.renderCurrent = renderCurrent;

  // ---- 跳转最新一章 ----
  window.goToLatest = function() {
    if (!pageState.floors || pageState.floors.length === 0) return;
    goToPage(pageState.floors.length - 1);
    listEl.scrollTop = 0;
  };

  // ---- 回顶部 ----
  window.goToTop = function() {
    listEl.scrollTo({ top: 0, behavior: 'smooth' });
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

  // ============================================================
  // 5. 输入条事件订阅
  // ============================================================
  function onGenStatus(statusVal) {
    if (statusVal === 'generating') applyState(S_GEN);
    // 'done' 时草稿文件尚未落盘（随后 output.refresh 才触发文件接管），
    // 此刻 refreshState 会误读最新章仍是正式稿 → 闪回 READY，故不在此切换。
  }
  window.Teahouse.on('generation.status', onGenStatus);
  onGenStatus(window.Teahouse.generationStatus || 'idle');

  // 转正完成（含导演/其它组件触发的 commitDraft）→ 同步状态
  window.Teahouse.on('draft.committed', function() { refreshState(); });

  // 文件变化 → 若涉及 floors 则刷新状态
  window.Teahouse.on('output.refresh', function(data) {
    var p = data && data.path;
    if (p && p.indexOf('runtime/floors/') === 0) {
      // 楼层文件变动（草稿落盘 / 改写）→ 让后端重算变量，使变量在草稿阶段即生效，
      // 不必等到转正。读变量本身也会触发重算，这里是主动推送一次。
      if (window.Teahouse.refresh) window.Teahouse.refresh().catch(function() {});
      refreshState();
    }
  });

  // ============================================================
  // 6. 初始化
  // ============================================================
  applyMode();
  initThinkOnce();      // 读思考强度变量（若有）并同步按钮
  refreshState();
  defaultRender();
  window.registerUI('teahouse-novel-main', root);
})();
