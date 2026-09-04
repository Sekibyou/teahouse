(function() {
  /* 底部输入条 — 五模式：与导演对话 / 生成下一章 / 重写本章 / 续写补全 / 总结归纳
     状态机（转正是唯一闸门，正式稿标准流程不可动）：
       READY        最新章是正式稿 → 打字可用；菜单仅 chat/gen/summarize
                    （rewrite/continue 只服务草稿，正式稿态不可见；若当前选中则自动切回 gen）
       GENERATING   生成/重写中 → 打字禁用，右侧为「停止」按钮，可 Esc 打断
       AWAIT_COMMIT 最新章是草稿 → 右侧按钮变「确认草稿」形态（sendBtn 三态）：
         send（纸飞机）= 正常发送 / stop（方块）= 打断生成 / commit（绿色文字）= 转正
         确认草稿 → Teahouse.commitDraft(N)：解析 teahouse-vars → 应用变量
                    → 标记 msg 写回 → 改名 floor-N.md → git 提交
                     菜单含 rewrite/continue（草稿阶段折腾）；仅「生成下一章」模式打字禁用，
                     其余模式打字可用（找导演走「与导演对话」，回档不做常驻按钮）。
     写下一章 = 写 user_msg + Generate floor-N-draft.md，不碰 git；
     续写补全 = Generate 补全到 temp → 子会话合并写回草稿；
     重写草稿 = Generate overwrite 覆写当前草稿（仅草稿，正式稿不可重写）；
     转正只由「确认草稿」按钮（commitDraft 闸门）驱动。

     附加：文末选项条 + 通用判定管线（打字与点选项共用）。
     · 选项区：读变量「文末选项」→ 仅 gen 模式 + READY 态 + 有选项时显示（可折叠），
       点选项 = 以该项为 user 内容走判定管线 → 立即进生成态。
     · 判定管线 finalizeUserMsg(raw) 统一处理"打字 / 点选项"的发送前内容——
         - raw 自带尖括号 <骰子串> → 视为自选判定，roll 该骰子，拼 <骰子串=N> 到末尾；
         - raw 不带尖括号 → roll 1d100 作通用倾向参考，拼一段说明到末尾；
         若用户要求明显无需判定，正文 bot 可无视该段。
  */

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

  /* 文末选项条状态 */
  var OPT_VAR = '文末选项';      // 选项数组变量名
  var optFolded = false;        // 选项区是否折叠
  var optBusy = false;          // 正在掷骰/已触发生成 → 禁点

  /* 思考强度（input-bar 内所有 Generate 共用）：五档变量，点按钮轮换 */
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

  /* ---- 组件级 hover/disabled 样式（固定色按钮无法用内嵌 :hover，注入 <style>） ---- */
  var styleTag = document.createElement('style');
  styleTag.textContent =
    '#teahouse-mode-btn:hover:not(:disabled){background:rgba(255,255,255,0.08);}' +
    '#teahouse-think-btn:hover:not(:disabled){background:var(--control-bg);border-color:var(--border-strong);}' +
    '#teahouse-input-send:hover:not(:disabled){opacity:0.85;}' +
    '#teahouse-input-send:disabled{opacity:0.5;cursor:not-allowed;}' +
    '.teahouse-mode-item:hover{background:var(--control-bg);}' +
    '.teahouse-opt-item:hover{background:var(--control-bg);border-color:var(--border-strong);}' +
    '#teahouse-opt-fold:hover{background:var(--control-bg);}';
  document.head.appendChild(styleTag);

  /* ---- DOM 骨架 ---- */
  var wrap = document.createElement('div');
  wrap.id = 'teahouse-input-bar';
  wrap.style.cssText =
    'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);' +
    'z-index:var(--z-bar);width:min(92%, 640px);' +
    'font-family:"Noto Sans SC","PingFang SC",sans-serif;';

  /* ============ 选项区（form 上方，可折叠） ============
     仅 gen 模式 + READY 态 + 文末选项 length>0 时显示。
     点选项 = 以该项为 user 内容走通用判定管线 → 立即进生成态（与打字回车一致）。 */
  var optWrap = document.createElement('div');
  optWrap.id = 'teahouse-opt-wrap';
  optWrap.style.cssText = 'display:none;margin-bottom:8px;';

  /* 展开态：头部标题+折叠钮 + 纵向选项列表 */
  var optPanel = document.createElement('div');
  optPanel.style.cssText =
    'background:var(--input-bg);border:1px solid var(--panel-border);' +
    'border-radius:16px;overflow:hidden;' +
    'box-shadow:0 8px 28px rgba(0,0,0,0.4);backdrop-filter:blur(10px);';

  var optHead = document.createElement('div');
  optHead.style.cssText =
    'display:flex;align-items:center;gap:8px;padding:7px 12px;' +
    'border-bottom:1px solid var(--panel-border);';

  var optHeadTitle = document.createElement('span');
  optHeadTitle.textContent = '文末选项';
  optHeadTitle.style.cssText =
    'flex:1;font-size:12px;font-weight:700;color:var(--panel-text-soft);' +
    'letter-spacing:0.05em;user-select:none;';

  var optFoldBtn = document.createElement('button');
  optFoldBtn.id = 'teahouse-opt-fold';
  optFoldBtn.type = 'button';
  optFoldBtn.title = '折叠';
  optFoldBtn.innerHTML = '&#9660;';   // ▼
  optFoldBtn.style.cssText =
    'flex:none;width:24px;height:24px;border:none;border-radius:50%;' +
    'background:transparent;color:var(--panel-text-dim);cursor:pointer;' +
    'font-size:12px;line-height:1;transition:background 0.15s,color 0.15s,' +
    'transform 0.2s;';

  optHead.appendChild(optHeadTitle);
  optHead.appendChild(optFoldBtn);

  var optList = document.createElement('div');
  optList.style.cssText =
    'padding:6px;display:flex;flex-direction:column;gap:6px;' +
    'max-height:38vh;overflow-y:auto;';

  optPanel.appendChild(optHead);
  optPanel.appendChild(optList);

  /* 折叠态胶囊（单行，点击展开） */
  var optChip = document.createElement('button');
  optChip.type = 'button';
  optChip.innerHTML = '&#9654; 文末选项';
  optChip.style.cssText =
    'display:none;align-items:center;gap:6px;height:34px;padding:0 14px;' +
    'border-radius:999px;background:var(--input-bg);color:var(--panel-text);' +
    'border:1px solid var(--panel-border);cursor:pointer;' +
    'box-shadow:0 6px 20px rgba(0,0,0,0.4);font-size:12.5px;font-weight:600;' +
    'user-select:none;margin-left:auto;';
  optChip.addEventListener('mouseenter', function() { optChip.style.borderColor = 'var(--border-strong)'; });
  optChip.addEventListener('mouseleave', function() { optChip.style.borderColor = 'var(--panel-border)'; });

  optWrap.appendChild(optPanel);
  optWrap.appendChild(optChip);

  var form = document.createElement('form');
  form.style.cssText =
    'display:flex;align-items:center;gap:8px;' +
    'background:var(--input-bg);' +
    'border:1px solid var(--panel-border);border-radius:28px;' +
    'padding:6px 8px;' +
    'box-shadow:0 8px 28px rgba(0,0,0,0.5);' +
    'backdrop-filter:blur(10px);' +
    'transition:border-color 0.2s,background 0.25s;';

  /* 打字区（READY / GENERATING / AWAIT 的 rewrite/continue/chat 模式显示） */
  var inputArea = document.createElement('div');
  inputArea.id = 'teahouse-input-area';
  inputArea.style.cssText = 'display:flex;align-items:center;gap:8px;flex:1;min-width:0;';

  /* 模式按钮（左侧触发器） */
  var modeBtn = document.createElement('button');
  modeBtn.id = 'teahouse-mode-btn';
  modeBtn.type = 'button';
  modeBtn.title = '切换输入模式';
  modeBtn.style.cssText =
    'flex:none;height:32px;padding:0 10px;border-radius:20px;' +
    'display:flex;align-items:center;gap:5px;' +
    'background:transparent;border:1px solid var(--panel-border);' +
    'font-size:12px;font-weight:600;cursor:pointer;user-select:none;' +
    'transition:background 0.2s,border-color 0.2s,color 0.2s;';

  var modeLabel = document.createElement('span');
  var modeArrow = document.createElement('span');
  modeArrow.textContent = '\u25BE';
  modeArrow.style.cssText = 'font-size:9px;opacity:0.8;';
  modeBtn.appendChild(modeLabel);
  modeBtn.appendChild(modeArrow);

  /* 思考强度按钮：点击轮换，显示当前档名 */
  var thinkBtn = document.createElement('button');
  thinkBtn.id = 'teahouse-think-btn';
  thinkBtn.type = 'button';
  thinkBtn.title = '思考强度：点击轮换（无/低/中/高/极）';
  thinkBtn.style.cssText =
    'flex:none;height:24px;padding:0 8px;border-radius:999px;' +
    'display:inline-flex;align-items:center;gap:3px;' +
    'background:var(--control-bg);border:1px solid var(--panel-border);' +
    'font-size:10.5px;font-weight:700;cursor:pointer;user-select:none;' +
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
    'caret-color:var(--accent);font-size:13px;';

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
    'flex:none;height:32px;min-width:32px;padding:0 12px;border:none;border-radius:20px;' +
    'display:flex;align-items:center;justify-content:center;cursor:pointer;' +
    'transition:opacity 0.2s;';

  /* 打断按钮：生成中显示，点击中断当前 runTool */
  var stopBtn = document.createElement('button');
  stopBtn.id = 'teahouse-input-stop';
  stopBtn.type = 'button';
  stopBtn.title = '打断本次生成（Esc）';
  stopBtn.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" ' +
    'style="display:block;margin:0 auto;">' +
    '<rect x="5" y="5" width="14" height="14" rx="1.5"/></svg>';
  stopBtn.style.cssText =
    'flex:none;height:32px;min-width:32px;padding:0 10px;border:none;border-radius:20px;' +
    'display:none;align-items:center;justify-content:center;cursor:pointer;' +
    'background:var(--danger-fill);color:var(--danger-filled-text);' +
    'transition:opacity 0.2s;';

  inputArea.appendChild(modeBtn);
  inputArea.appendChild(thinkBtn);
  inputArea.appendChild(input);
  inputArea.appendChild(sendBtn);
  inputArea.appendChild(stopBtn);

  form.appendChild(inputArea);

  var status = document.createElement('div');
  status.id = 'teahouse-input-status';
  status.textContent = '';
  status.style.cssText =
    'text-align:center;color:var(--panel-text-dim);font-size:11px;' +
    'margin-top:6px;letter-spacing:0.08em;min-height:16px;';

  /* 上拉菜单 */
  var menu = document.createElement('div');
  menu.id = 'teahouse-mode-menu';
  menu.style.cssText =
    'position:absolute;bottom:calc(100% + 8px);left:0;z-index:var(--z-panel);' +
    'min-width:176px;padding:4px;' +
    'background:var(--panel);color:var(--panel-text);' +
    'border:1px solid var(--panel-border);border-radius:12px;' +
    'box-shadow:var(--shadow-panel);' +
    'display:none;overflow:hidden;' +
    'font-size:12.5px;';

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
      (active ? '<span style="font-size:10px;">&#10003;</span>' : '') +
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

  /* 挂载顺序：选项区在上，form 在下，status 最底 */
  wrap.appendChild(optWrap);
  wrap.appendChild(form);
  wrap.appendChild(menu);
  wrap.appendChild(status);

  /* ---- 模式应用 ---- */
  /* sendBtn 三形态：send（纸飞机）/ commit（确认草稿文字）
     commit 形态只在 AWAIT 态 + gen 模式出现（右侧按钮位替代发送） */
  var sendMode = 'send';
  function syncSendBtn() {
    if (state === S_AWAIT && currentMode === MODE_GEN) {
      sendMode = 'commit';
      sendBtn.innerHTML = '确认草稿';
      sendBtn.style.background = 'var(--success-fill)';
      sendBtn.style.color = 'var(--success-filled-text)';
      sendBtn.style.minWidth = '86px';
      sendBtn.style.padding = '0 16px';
      sendBtn.style.fontSize = '13px';
      sendBtn.title = '解析正文 teahouse-vars 块并转正为正式稿';
    } else {
      sendMode = 'send';
      sendBtn.innerHTML = SEND_ICON;
      sendBtn.style.background = MODES[currentMode].btnBg;
      sendBtn.style.color = '#1a1a1a';
      sendBtn.style.minWidth = '32px';
      sendBtn.style.padding = '0 12px';
      sendBtn.style.fontSize = '';
      var btnTitle = (currentMode === MODE_CHAT) ? '发送'
        : (currentMode === MODE_GEN) ? '生成下一章'
        : (currentMode === MODE_REWRITE) ? '重写本章'
        : (currentMode === MODE_CONT) ? '续写补全'
        : '总结归纳';
      sendBtn.title = btnTitle;
    }
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
    // 选项区只在 gen 模式可见，切模式需同步
    syncOptVisibility();
  }

  /* ---- 输入可用性：AWAIT 态下 gen 模式打字禁用 + sendBtn 变确认草稿；其余模式可用 ---- */
  function applyInputAvailability() {
    if (state !== S_AWAIT) return;
    var awaitGen = (currentMode === MODE_GEN);
    input.disabled = awaitGen;
    sendBtn.style.display = 'flex';
    sendBtn.disabled = false;
    syncSendBtn();
    if (awaitGen) {
      input.placeholder = '最新一章是草稿，请确认草稿或切换模式';
      input.setAttribute('placeholder', input.placeholder);
    } else {
      input.placeholder = MODES[currentMode].placeholder;
      input.setAttribute('placeholder', input.placeholder);
    }
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
      status.textContent = '草稿已就绪：确认草稿，或切换模式续写·重写';
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
    syncOptVisibility();
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

  /* ============ 文末选项区 ============ */

  /* 折叠/展开 */
  function applyOptFold() {
    optPanel.style.display = optFolded ? 'none' : 'block';
    optChip.style.display = optFolded ? 'inline-flex' : 'none';
    optFoldBtn.innerHTML = optFolded ? '&#9650;' : '&#9660;';
    optFoldBtn.title = optFolded ? '展开选项' : '折叠选项';
  }
  optFoldBtn.addEventListener('click', function() { optFolded = true; applyOptFold(); });
  optChip.addEventListener('click', function() { optFolded = false; applyOptFold(); });

  /* HTML 转义（防选项文本内的 < > 破坏结构） */
  function optEsc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* 高亮渲染选项文本：把判定标记单独着色，其余保持默认
      方括号 [...]（判定条件）→ 黄 var(--warn)
      尖括号 <...>（骰子串/判定结果）→ 绿 var(--success)
      每段内容之间用短横线 " — " 分隔，让"行动 — [条件] — <骰子>"三段明确分开 */
  function optHighlight(s) {
    var full = String(s);
    var re = /\[[^\]]*\]|<[^<>]*>/g;
    var html = '';
    var last = 0;
    var m;
    var segments = [];   // [{type:'text'|'cond'|'dice', str}]
    while ((m = re.exec(full)) !== null) {
      var lead = full.slice(last, m.index);
      if (lead) segments.push({ type: 'text', str: lead });
      var tok = m[0];
      segments.push({ type: tok.charAt(0) === '[' ? 'cond' : 'dice', str: tok });
      last = m.index + tok.length;
    }
    var tail = full.slice(last);
    if (tail) segments.push({ type: 'text', str: tail });

    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      // 除段首外，段与段之间插分隔短线
      if (i > 0) html += ' <span style="color:var(--panel-text-dim);">—</span> ';
      if (seg.type === 'cond') {
        html += '<span style="color:var(--warn);">' + optEsc(seg.str) + '</span>';
      } else if (seg.type === 'dice') {
        html += '<span style="color:var(--success);">' + optEsc(seg.str) + '</span>';
      } else {
        html += optEsc(seg.str);
      }
    }
    return html;
  }

  /* 渲染选项列表 */
  function renderOpts(opts) {
    optList.innerHTML = '';
    var arr = Array.isArray(opts) ? opts : [];
    if (arr.length === 0) { hideOpt(); return; }
    optBusy = false;   // 新选项到达 → 重新开放点击（重置上次点选/生成遗留的 busy 锁）
    optHeadTitle.textContent = '文末选项（' + arr.length + '）';
    optChip.innerHTML = '&#9654; 文末选项（' + arr.length + '）';
    for (var i = 0; i < arr.length; i++) {
      (function(idx) {
        var text = String(arr[idx]);
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'teahouse-opt-item';
        btn.style.cssText =
          'width:100%;height:auto;min-height:34px;padding:7px 12px;' +
          'border:1px solid transparent;border-radius:10px;' +
          'background:transparent;color:var(--panel-text);cursor:pointer;' +
          'font-size:12.5px;line-height:1.5;text-align:left;' +
          'white-space:normal;word-break:break-word;' +
          'transition:background 0.15s,border-color 0.15s;';
        btn.innerHTML = optHighlight(text);
        btn.addEventListener('click', function() {
          if (optBusy || state !== S_READY) return;
          optChoose(idx, btn);
        });
        optList.appendChild(btn);
      })(i);
    }
    syncOptVisibility();   // 渲染完再按状态决定显示/隐藏
  }

  /* 选项显示/隐藏：仅 gen+READY+有选项 时显示 */
  function syncOptVisibility() {
    if (state === S_READY && currentMode === MODE_GEN) {
      if (optList.childNodes.length > 0) {
        optWrap.style.display = 'block';
        applyOptFold();
        return;
      }
    }
    optWrap.style.display = 'none';
  }
  /* 清空并隐藏选项区（不保留上次列表） */
  function hideOpt() {
    optWrap.style.display = 'none';
    optBusy = false;
    optList.innerHTML = '';
  }

  /* 刷新选项：读变量 → 有则渲染、空则隐藏 */
  function refreshOpts() {
    window.Teahouse.getVars([OPT_VAR]).then(function(entries) {
      var v = (entries && entries[0]) ? entries[0].value : null;
      if (Array.isArray(v) && v.length > 0) {
        renderOpts(v);
      } else {
        hideOpt();
      }
    }).catch(function() {});
  }

  /* 清空选项变量（选完 / 发送后） */
  function clearOptVar() {
    window.Teahouse.setVar({ '文末选项': [] }).catch(function() {});
  }

  /* ============ 判定管线（打字与点选项共用） ============
     输入：原始 user 内容（打字 / 选项原文）
     输出：Promise<最终 user_msg>
     规则：
       - 内容自带尖括号 <骰子串> → 视为自选判定，roll 该骰子，拼 <骰子串=N> 到末尾；
       - 否则 → roll 1d100 作通用倾向参考，拼一段说明到末尾（正文 bot 可酌情参考/无视）。
     若需"纯点击不判定"或在此之上加动画 / 重掷，改此函数即可。 */
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
      return Promise.resolve(text);
    }
    // 无判定：通用 1d100 作倾向参考
    return window.Teahouse.roll('1d100').then(function(n) {
      return text + '<通用判定：1d100=' + n + '。此为无具体判定要求时的随机倾向参考，你可酌情参考以推动剧情；若用户要求明显无需判定，可无视之。>';
    }).catch(function() {
      return text;
    });
  }

  /* 点选项：以选项原文为 user 内容，走判定管线后生成下一章 */
  function optChoose(idx, btn) {
    var raw = String(optList.childNodes[idx] && optList.childNodes[idx].textContent);
    // 用缓存的原始文本更稳（避免 textContent 被转义）：从变量里取
    window.Teahouse.getVars([OPT_VAR]).then(function(entries) {
      var v = (entries && entries[0]) ? entries[0].value : null;
      var arr = Array.isArray(v) ? v : [];
      var text = arr[idx] !== undefined ? String(arr[idx]) : raw;
      optBusy = true;
      btn.disabled = true;
      clearOptVar();            // 立即清空选项（选项条隐藏）
      genWithJudgement(text);   // 立即进生成态 + 判定管线
    }).catch(function() {
      optBusy = true;
      clearOptVar();
      genWithJudgement(raw);
    });
  }

  /* 生成下一章（含判定管线）：
     先 applyState(S_GEN) 立即进生成态（与打字回车一致），再异步判定管线拿最终 msg，再 runTool。 */
  function genWithJudgement(rawText) {
    var top = currentTop();
    if (top && top.draft) {
      // 防御：有草稿未转正 → 不应开新楼
      optBusy = false;
      refreshState();
      flashStatus('最新一章还是草稿，请先确认或切换模式');
      return;
    }
    var nextNum = (top ? top.num : 0) + 1;
    applyState(S_GEN);                       // 同步进生成态（立即反馈）
    finalizeUserMsg(rawText).then(function(finalMsg) {
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
      return h.then(function() {
        activeRun = null;
        refreshState();
      }).catch(function(err) {
        activeRun = null;
        if (isCancelledErr(err)) {
          flashStatus('已停止生成');
          console.log('[InputBar] gen cancelled:', err);
        } else {
          status.textContent = '生成失败，请重试';
          console.error('[InputBar] gen failed:', err);
        }
        refreshState();
      });
    });
  }

  /* ---- 生成下一章（打字回车用，同样走判定管线） ---- */
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
        console.log('[InputBar] rewrite cancelled:', err);
      } else {
        status.textContent = '重写失败，请重试';
        console.error('[InputBar] rewrite failed:', err);
      }
      refreshState();
    });
  }

  /* ---- 确认草稿 → commitDraft(N) ---- */
  function doCommit() {
    var top = currentTop();
    if (!top || !top.draft) { refreshState(); return; }
    var num = top.num;
    sendBtn.disabled = true;
    sendBtn.textContent = '转正中…';
    window.Teahouse.commitDraft(num).then(function(res) {
      sendBtn.disabled = false;
      syncSendBtn();
      if (res && res.ok) {
        var d = res.data || {};
        refreshState();
        if (d.committed_draft === false) {
          flashStatus('已补解析变量 ✓');
        } else if (d.failed && d.failed.length > 0) {
          flashStatus('已转正，但 ' + d.failed.length + ' 个变量操作失败（可找导演修正后补提交）');
        } else {
          flashStatus('已转正并提交 ✓');
        }
      } else {
        status.textContent = '转正失败：' + ((res && res.error) || '未知错误');
        console.error('[InputBar] commitDraft failed:', res);
      }
    }).catch(function(err) {
      sendBtn.disabled = false;
      syncSendBtn();
      status.textContent = '转正失败：' + errMsg(err);
      console.error('[InputBar] commitDraft failed:', err);
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
      console.log('[InputBar] continue session done:', sid);
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
        console.log('[InputBar] continue cancelled:', err);
        return;
      }
      var isNoDraft = err && err.message === 'NO_DRAFT';
      if (isNoDraft) {
        status.textContent = '当前没有草稿可续写（续写针对草稿）';
        input.value = text;   // 恢复输入，不丢内容
      } else {
        status.textContent = '续写失败：' + errMsg(err);
        console.error('[InputBar] continue failed:', err);
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
      console.log('[InputBar] summarize session done:', sid);
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
      console.error('[InputBar] summarize failed:', err);
    });
  }

  /* ---- 提交入口 ---- */
  function submit() {
    // 防御：AWAIT+gen 时 sendBtn 是 commit 形态，任何提交路径都走转正
    if (sendMode === 'commit') { doCommit(); return; }
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
      clearOptVar();          // 打字发送也会清空选项
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

  form.addEventListener('submit', function(e) { e.preventDefault(); submit(); });
  sendBtn.addEventListener('click', function() {
    // commit 形态（AWAIT+gen）点击 → 转正；其余形态 → 正常发送
    if (sendMode === 'commit') { doCommit(); }
    else { submit(); }
  });
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

  /* ---- 事件订阅 ---- */
  function onGenStatus(statusVal) {
    if (statusVal === 'generating') applyState(S_GEN);
    // 'done' 时草稿文件尚未落盘（随后 output.refresh 才触发文件接管），
    // 此刻 refreshState 会误读最新章仍是正式稿 → 闪回 READY，故不在此切换。
  }
  window.Teahouse.on('generation.status', onGenStatus);
  onGenStatus(window.Teahouse.generationStatus || 'idle');

  // 转正完成（含导演/其它组件触发的 commitDraft）→ 同步状态
  window.Teahouse.on('draft.committed', function() { refreshState(); refreshOpts(); });

  // 文件变化 → 若涉及 floors / 变量(含文末选项) 都刷新
  window.Teahouse.on('output.refresh', function(data) {
    var p = data && data.path;
    if (p && p.indexOf('runtime/floors/') === 0) {
      refreshState();
      return;
    }
    // 生成中选项必已清空、无需刷新（避免频繁读变量干扰）；其余情况刷新选项区
    if (state !== S_GEN) refreshOpts();
  });

  /* ---- 初始化 ---- */
  applyMode();
  initThinkOnce();      // 读思考强度变量（若有）并同步按钮
  refreshState();
  refreshOpts();
  window.registerUI('teahouse-input-bar', wrap);
})();
