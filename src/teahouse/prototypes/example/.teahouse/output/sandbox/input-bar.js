(function() {
  /* 底部输入框 — 四模式：与导演对话 / 生成下一章 / 重写本章 / 续写补全
     模式切换：输入框左侧上拉菜单（模式按钮 + 弹出菜单）
       对话模式：内容经 Teahouse.send() 发给导演（蓝色）
       生成模式：内容存变量 user_msg →（若最高章节为草稿）draft 转正 + 楼层提交
                → Generate 下一楼 draft（绿色）
       重写模式：切换时以 user_msg 填充输入框；发送前先检查 git，不干净则
                other 存档「重写：章节名」→ 写 user_msg → Generate 覆写当前章（红色）
       续写模式：写 user_msg → Generate 补全草稿到 temp → 开子会话合并原文+补全
                为完整章节正文（紫色）
     发送按钮背景/文字为内嵌固定颜色，与菜单主题色一致。
     生成模式为默认模式，发送即生成，无确认弹窗。 */

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
      placeholder: '对 Remielle 说点什么…（Enter 发送）'
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

  var MODE_ORDER = [MODE_CHAT, MODE_GEN, MODE_REWRITE, MODE_CONT, MODE_SUMM];

  var currentMode = MODE_GEN;   // 初始化默认「生成下一章」
  var lastGenArgs = null;   // 最近一次 Generate 步骤参数（覆写重试用）
  var activeRun = null;     // 当前进行中的 runTool handle（用于打断生成）
  var activeSid = null;         // 当前活跃的子会话 id（续写合并 / 总结归纳）
  var activeSessionLabel = '';  // 活跃子会话的类型名（续写合并 / 总结归纳）

  var PLACEHOLDER_BUSY = 'Remielle 正在执笔…';
  var statusTimer = null;

  /* ---- 组件级 hover/disabled 样式（固定色按钮无法用内嵌 :hover，注入 <style>） ---- */
  var styleTag = document.createElement('style');
  styleTag.textContent =
    '#teahouse-mode-btn:hover:not(:disabled){background:rgba(255,255,255,0.08);}' +
    '#teahouse-input-send:hover:not(:disabled){opacity:0.85;}' +
    '#teahouse-input-send:disabled{opacity:0.5;cursor:not-allowed;}' +
    '.teahouse-mode-item:hover{background:var(--control-bg);}';
  document.head.appendChild(styleTag);

  /* ---- DOM 骨架 ---- */
  var wrap = document.createElement('div');
  wrap.id = 'teahouse-input-bar';
  wrap.style.cssText =
    'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);' +
    'z-index:var(--z-bar);width:min(92%, 640px);' +
    'font-family:"Noto Sans SC","PingFang SC",sans-serif;';

  var form = document.createElement('form');
  form.style.cssText =
    'display:flex;align-items:center;gap:8px;' +
    'background:var(--input-bg);' +
    'border:1px solid var(--panel-border);border-radius:28px;' +
    'padding:6px 8px;' +
    'box-shadow:0 8px 28px rgba(0,0,0,0.5);' +
    'backdrop-filter:blur(10px);' +
    'transition:border-color 0.2s,background 0.25s;';

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
  sendBtn.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
    'style="display:block;margin:0 auto;">' +
    '<path d="M22 2L11 13"/><path d="M22 2L15 22l-4-9-9-4z"/></svg>';
  sendBtn.style.cssText =
    'flex:none;height:32px;min-width:32px;padding:0 12px;border:none;border-radius:20px;' +
    'display:flex;align-items:center;justify-content:center;cursor:pointer;' +
    'transition:opacity 0.2s;';

  /* 打断按钮：生成/补全进行中显示，点击中断当前 runTool */
  var stopBtn = document.createElement('button');
  stopBtn.id = 'teahouse-input-stop';
  stopBtn.type = 'button';
  stopBtn.title = '打断本次生成（Esc）';
  /* 方块停止 icon（feather square），配合停止钮红底色 */
  stopBtn.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" ' +
    'style="display:block;margin:0 auto;">' +
    '<rect x="5" y="5" width="14" height="14" rx="1.5"/></svg>';
  stopBtn.style.cssText =
    'flex:none;height:32px;min-width:32px;padding:0 10px;border:none;border-radius:20px;' +
    'display:none;align-items:center;justify-content:center;cursor:pointer;' +
    'background:var(--danger-fill);color:var(--danger-filled-text);' +
    'transition:opacity 0.2s;';

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

  function renderMenu() {
    var html = '';
    for (var i = 0; i < MODE_ORDER.length; i++) {
      html += menuItemHtml(MODE_ORDER[i], MODES[MODE_ORDER[i]]);
    }
    menu.innerHTML = html;
    var items = menu.querySelectorAll('.teahouse-mode-item');
    for (var i = 0; i < items.length; i++) {
      (function(el) {
        el.addEventListener('click', function(e) {
          e.stopPropagation();
          currentMode = el.getAttribute('data-mode');
          closeMenu();
          applyMode();
        });
      })(items[i]);
    }
  }

  function openMenu() { renderMenu(); menu.style.display = 'block'; }
  function closeMenu() { menu.style.display = 'none'; }

  form.appendChild(modeBtn);
  form.appendChild(input);
  form.appendChild(sendBtn);
  form.appendChild(stopBtn);
  wrap.appendChild(form);
  wrap.appendChild(menu);
  wrap.appendChild(status);

  /* ---- 模式应用 ---- */
  function applyMode() {
    var m = MODES[currentMode];
    modeLabel.textContent = m.label;
    modeBtn.style.color = m.dot;
    modeBtn.style.borderColor = m.dot;
    sendBtn.style.background = m.btnBg;
    sendBtn.style.color = '#1a1a1a';   // 亮彩色底上的纸飞机用深色，清晰可辨
    var btnTitle = (currentMode === MODE_CHAT) ? '发送'
      : (currentMode === MODE_GEN) ? '生成下一章'
      : (currentMode === MODE_REWRITE) ? '重写本章'
      : (currentMode === MODE_CONT) ? '续写补全'
      : '总结归纳';
    sendBtn.title = btnTitle;
    input.placeholder = m.placeholder;
    input.setAttribute('placeholder', m.placeholder);
    // 重写模式：以 user_msg 填充输入框，用户可修改
    if (currentMode === MODE_REWRITE) {
      window.Teahouse.getVars(['user_msg']).then(function(entries) {
        var v = entries && entries[0] ? entries[0].value : null;
        input.value = (v !== null && v !== undefined) ? String(v) : '';
      }).catch(function() {});
    } else {
      // 其他模式：清空，避免残留重写预填/上次输入
      input.value = '';
    }
  }

  /* ---- 状态 ---- */
  function setGenerating(g) {
    input.disabled = g;
    modeBtn.disabled = g;
    // 生成中隐藏「发送」按钮（保留「停止」）；完成后恢复
    sendBtn.style.display = g ? 'none' : 'flex';
    sendBtn.disabled = g;
    stopBtn.style.display = g ? 'inline-block' : 'none';
    input.placeholder = g ? PLACEHOLDER_BUSY : MODES[currentMode].placeholder;
    input.setAttribute('placeholder', input.placeholder);
    if (g) input.blur();
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
    input.placeholder = '给' + label + '子会话补发消息…（Enter 发送）';
    input.setAttribute('placeholder', input.placeholder);
  }
  function clearSessionActive() {
    activeSid = null;
    activeSessionLabel = '';
    input.disabled = false;
    modeBtn.disabled = false;
    sendBtn.style.display = 'flex';
    sendBtn.disabled = false;
    stopBtn.style.display = 'none';
    input.placeholder = MODES[currentMode].placeholder;
    input.setAttribute('placeholder', input.placeholder);
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

  /* ---- 覆写确认弹窗（Generate 报"文件已存在"时触发） ---- */
  var rewriteOverlay = document.createElement('div');
  rewriteOverlay.id = 'teahouse-rewrite-dialog';
  rewriteOverlay.style.cssText =
    'position:fixed;inset:0;z-index:610;display:none;' +
    'align-items:center;justify-content:center;' +
    'background:rgba(0,0,0,0.55);' +
    'font-family:"Noto Sans SC","PingFang SC",sans-serif;';
  rewriteOverlay.innerHTML =
    '<div style="width:min(92%,360px);background:var(--panel);color:var(--panel-text);' +
    'border:1px solid var(--panel-border);border-radius:14px;' +
    'box-shadow:var(--shadow-panel);padding:18px;">' +
    '<div style="font-size:14px;font-weight:700;margin-bottom:10px;">文件已存在</div>' +
    '<div style="font-size:12.5px;color:var(--panel-text-soft);line-height:1.7;margin-bottom:16px;">' +
    '是否重写？这会导致旧文件被删除。如果你认为旧文件有保存的价值，请先进行 git 提交存档。</div>' +
    '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
    '<button type="button" id="rewrite-dialog-cancel" style="' +
    'height:32px;padding:0 16px;border-radius:20px;border:1px solid var(--control-border);' +
    'background:transparent;color:var(--panel-text-soft);font-size:13px;cursor:pointer;">取消</button>' +
    '<button type="button" id="rewrite-dialog-ok" style="' +
    'height:32px;padding:0 16px;border-radius:20px;border:none;' +
    'background:#f87171;color:#ffffff;font-size:13px;font-weight:700;cursor:pointer;">确认重写</button>' +
    '</div></div>';
  document.body.appendChild(rewriteOverlay);

  function showRewriteDialog() { rewriteOverlay.style.display = 'flex'; }
  function hideRewriteDialog() { rewriteOverlay.style.display = 'none'; }
  document.getElementById('rewrite-dialog-cancel').addEventListener('click', function() { hideRewriteDialog(); });
  document.getElementById('rewrite-dialog-ok').addEventListener('click', function() {
    hideRewriteDialog();
    doGenOverwrite();
  });
  rewriteOverlay.addEventListener('click', function(e) {
    if (e.target === rewriteOverlay) hideRewriteDialog();
  });

  /* ---- 生成下一章流水线 ---- */
  function extractTitle(md) {
    var lines = String(md || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var m = /^\s*#\s+(.+?)\s*$/.exec(lines[i]);
      if (m) return m[1].trim();
    }
    return '';
  }

  function buildSteps(text) {
    var st = window.Teahouse._pageState || { floors: [], currentIndex: 0 };
    var floors = st.floors || [];
    var top = floors.length ? floors[floors.length - 1] : null;
    var nextNum = (top ? top.num : 0) + 1;
    var steps = [];

    // 顺序约定：先固化当前状态（draft 转正 + 楼层提交），
    // git 提交之后才写变量 user_msg 并生成下一楼 —— 新变量与新楼层都是"git 之后的待办"。
    if (top && top.draft) {
      var n = top.num;
      var src = '.teahouse/output/floors/floor-' + n + '-draft.md';
      var dst = '.teahouse/output/floors/floor-' + n + '.md';
      return window.Teahouse.readText(src).then(function(md) {
        var title = extractTitle(md) || ('第 ' + n + ' 章');
        steps.push({ tool: 'FileOps', args: { action: 'move', path: src, destination: dst } });
        steps.push({ tool: 'GitCommit', args: { type: 'floor', number: n, message: title } });
        // git 之后：写入 user_msg（Generate 配置里 ${user_msg} 由后端在生成前解析）
        steps.push({ tool: 'SetRuntimeVar', args: { updates: { user_msg: text } } });
        steps.push({ tool: 'Generate', args: {
          source_file: '.teahouse/generate-config/正文生成.yaml',
          path: '.teahouse/output/floors/floor-' + nextNum + '-draft.md'
        }});
        return steps;
      });
    }

    // 无草稿：直接写变量 + 生成下一楼
    steps.push({ tool: 'SetRuntimeVar', args: { updates: { user_msg: text } } });
    steps.push({ tool: 'Generate', args: {
      source_file: '.teahouse/generate-config/正文生成.yaml',
      path: '.teahouse/output/floors/floor-' + nextNum + '-draft.md'
    }});
    return Promise.resolve(steps);
  }

  function errMsg(err) {
    if (!err) return '';
    if (typeof err === 'string') return err;
    if (err.message) return err.message;
    try { return JSON.stringify(err); } catch (e) { return String(err); }
  }

  function doGen(text) {
    setGenerating(true);
    status.textContent = '正在保存草稿并生成下一章…';
    buildSteps(text).then(function(steps) {
      lastGenArgs = null;
      for (var i = 0; i < steps.length; i++) {
        if (steps[i].tool === 'Generate') lastGenArgs = steps[i].args;
      }
      var h = window.Teahouse.runTool(steps);
      activeRun = h;
      return h;
    }).then(function() {
      activeRun = null;
      setGenerating(false);
      flashStatus('已生成下一章 ✓');
    }).catch(function(err) {
      activeRun = null;
      setGenerating(false);
      if (isCancelledErr(err)) {
        flashStatus('已停止生成');
        console.log('[InputBar] gen cancelled:', err);
        return;
      }
      var msg = errMsg(err);
      // 识别 Generate 只读保护报错：文件已存在 → 弹覆写确认（可先 git 存档）
      if (msg.indexOf('目标文件已存在') !== -1) {
        showRewriteDialog();
      } else {
        status.textContent = '生成失败，请重试';
        console.error('[InputBar] gen failed:', err);
      }
    });
  }

  /* 覆写确认后：仅重发 Generate 步骤（前面的定稿/提交/写变量已完成），overwrite=true */
  function doGenOverwrite() {
    if (!lastGenArgs) return;
    setGenerating(true);
    status.textContent = '正在重写生成…';
    var args = {};
    for (var k in lastGenArgs) args[k] = lastGenArgs[k];
    args.overwrite = true;
    var h = window.Teahouse.runTool([{ tool: 'Generate', args: args }]);
    activeRun = h;
    h.then(function() {
      activeRun = null;
      setGenerating(false);
      flashStatus('已重写生成 ✓');
    }).catch(function(err) {
      activeRun = null;
      setGenerating(false);
      if (isCancelledErr(err)) {
        flashStatus('已停止生成');
        return;
      }
      status.textContent = '重写失败，请重试';
      console.error('[InputBar] rewrite failed:', err);
    });
  }

  /* ---- 重写本章流水线 ----
     流程：1) 检查 git 是否干净，不干净 → other 存档「重写：章节名」
           2) 把输入框内容保存为 user_msg
           3) Generate 覆写当前章（overwrite=true，draft/正式章都可重写） */
  function gitDirtyFromResult(result) {
    if (!result) return false;
    var out = result.result;
    if (out === null || out === undefined) return false;
    var s = (typeof out === 'string' ? out : JSON.stringify(out)) || '';
    s = s.trim();
    if (!s || s === '[]' || s === '{}') return false;
    return true;
  }

  function buildRewriteSteps(text) {
    var st = window.Teahouse._pageState || { floors: [], currentIndex: 0 };
    var floors = st.floors || [];
    var cur = floors[st.currentIndex];
    if (!cur) return Promise.reject(new Error('当前没有可重写的章节'));
    var title = cur.title || ('第 ' + cur.num + ' 章');
    var steps = [];

    // 1) git 是否干净：先跑一次 GitStatus，再组装后续步骤
    return window.Teahouse.runTool([{ tool: 'GitStatus', args: {} }]).then(function(res) {
      var dirty = false;
      var results = (res && res.results) ? res.results : [];
      for (var i = 0; i < results.length; i++) {
        if (results[i].tool === 'GitStatus') dirty = gitDirtyFromResult(results[i]);
      }
      if (dirty) {
        steps.push({ tool: 'GitCommit', args: { type: 'other', message: '重写：' + title } });
      }
      // 2) 写 user_msg
      steps.push({ tool: 'SetRuntimeVar', args: { updates: { user_msg: text } } });
      // 3) 覆写当前章
      steps.push({ tool: 'Generate', args: {
        source_file: '.teahouse/generate-config/正文生成.yaml',
        path: cur.path,
        overwrite: true
      }});
      return steps;
    });
  }

  function doRewrite(text) {
    setGenerating(true);
    status.textContent = '正在检查存档并重写本章…';
    buildRewriteSteps(text).then(function(steps) {
      return window.Teahouse.runTool(steps);
    }).then(function() {
      setGenerating(false);
      flashStatus('已重写本章 ✓');
    }).catch(function(err) {
      setGenerating(false);
      status.textContent = '重写失败，请重试';
      console.error('[InputBar] rewrite failed:', err);
    });
  }

  /* ---- 续写补全流水线 ----
     针对草稿（floor-N-draft.md）：
       1) 写 user_msg
       2) Generate 补全内容到 temp/floor-N-draft-补全.md（正文补全.yaml，temp 中间产物直接覆盖）
       3) 开启子会话：合并 原文+补全 → 完整章节正文，写回 floor-N-draft.md
      子会话完成后（session_done）通知玩家，不自动销毁，玩家可用 /clear 清理。 */
  var CONT_YAML = '.teahouse/generate-config/正文补全.yaml';

  function buildContinueSteps(text) {
    var st = window.Teahouse._pageState || { floors: [], currentIndex: 0 };
    var floors = st.floors || [];
    var top = floors.length ? floors[floors.length - 1] : null;
    // 续写针对草稿：最高章节必须是 draft
    if (!top || !top.draft) return Promise.reject(new Error('NO_DRAFT'));
    var n = top.num;
    var srcPath = '.teahouse/output/floors/floor-' + n + '-draft.md';
    var contPath = 'temp/floor-' + n + '-draft-补全.md';
    var steps = [
      { tool: 'SetRuntimeVar', args: { updates: { user_msg: text } } },
      { tool: 'Generate', args: {
        source_file: CONT_YAML,
        path: contPath,
        overwrite: true
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
        // 统一返回 {ok, data|error}：用 created.ok 判成败，sid 在 created.data.session_id。
        if (!created || !created.ok) {
          throw new Error((created && created.error) || '创建子会话失败');
        }
        var sid = created.data.session_id;
        window.Teahouse.sessionSend(sid, task);
        return sid;
      });
  }

  /* 续写合并子会话：收到 EndSession 后通知完成并恢复输入；不自动销毁（用户可用 /clear 清理） */
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
    setGenerating(true);
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

  /* ---- 总结归纳流水线 ----
     用户输入总结范围 → 直接归纳进子会话任务提示词 → 开子会话按 teahouse-summarize skill 总结
     子会话完成后（session_done）通知玩家，不自动销毁，玩家可用 /clear 清理。 */
  function openSummarizeSession(text) {
    var task = [
      '你的任务是执行一次「总结归纳」流程，把用户指定的楼层范围压缩归档。',
      '【第一步 · 必须先加载技能】先用 SkillRead 读取 teahouse-summarize，严格按其中 SOP 执行总结。这是本任务的唯一方法依据。',
      '【进度记录】请使用 TodoWrite 工具维护任务清单，逐步记录总结进度（读归档界 / 读楼层 / 更新设定与变量 / 写流水账 / git 提交），让用户能实时看到你做到哪一步。',
      '【用户原始要求（用户在输入框手打的原文，请原样解读、严格遵循，不要擅自改动或扩大其范围）】',
      '『' + text + '』',
      '以上是用户的原始要求。请以它为准：解析其中的总结范围（例如「最近10章」「71~79章」「总结到第80章」等），确定要覆盖的楼层编号区间。若原始要求未指明明确起点，先 Read .teahouse/dyn_settings/summary/index.json 读归档界 summarized_through（上次已总结到的结束楼层），以此为起点顺延。',
      '【执行流程 · 严格按 skill SOP】',
      '1) Read .teahouse/dyn_settings/summary/index.json 确认归档界与已有流水账；',
      '2) Read 本次待总结的全部楼层（.teahouse/output/floors/floor-N.md）；',
      '3) 把对后续剧情有持续影响的信息沉淀进 .teahouse/dyn_settings/ 的动态设定文件，并更新变量（GetRuntimeVars / SetRuntimeVar）；',
      '4) Write 流水账到 .teahouse/dyn_settings/summary/sum-A-B.md。注意：每次总结最多覆盖 10 章，超过 10 章需拆分成多个 sum-*.md 文件（如 sum-1-10.md、sum-11-20.md…），每个单独提交；',
      '5) 用 GitCommit(type="summary", start=A, end=B, paths=[".teahouse/dyn_settings", ".teahouse/generate-config"], message="简短描述") 提交。若拆分为多个范围，逐个提交。提交前用 GitStatus / GitDiff(staged=true) 自查本次 stage 的正是总结自己的改动（别把主会话未提交的楼层/变量卷进来）。',
      '【完成宣告】任务全部做完后，先以文本输出这句话：「总结已完成 ✓ 如希望清理，请输入 /clear」，然后调用 EndSession 宣告任务结束。EndSession 之后不要再输出任何内容。'
    ].join('\n');
    window.Teahouse.openDirector();   // 唤起导演栏，让玩家看到总结过程并可介入
    return window.Teahouse.sessionCreate({
        enabled_tools: ['Read', 'Glob', 'Grep', 'GetRuntimeVars', 'SetRuntimeVar',
                        'SkillRead', 'FileOps', 'Write', 'Edit', 'WriteLine',
                        'TodoWrite', 'GitStatus', 'GitDiff', 'GitCommit', 'EndSession'],
        reasoning_effort: 'mid'
      }).then(function(created) {
        // 统一返回 {ok, data|error}：用 created.ok 判成败，sid 在 created.data.session_id。
        if (!created || !created.ok) {
          throw new Error((created && created.error) || '创建子会话失败');
        }
        var sid = created.data.session_id;
        window.Teahouse.sessionSend(sid, task);
        return sid;
      });
  }

  /* 总结子会话：收到 EndSession 后通知完成并恢复输入；不自动销毁（用户可用 /clear 清理） */
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
    setGenerating(true);
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
      flashStatus('已送达，Remielle 记下了');
      window.Teahouse.openDirector();   // 唤起导演栏，让玩家能看到导演回应
      window.Teahouse.send(text);
    } else if (currentMode === MODE_GEN) {
      // 生成下一章：无需弹窗确认。buildSteps 内已处理——最高章节是 draft 就先转正提交，
      // 再生成下一楼；已是正式版则直接生成。立即清空输入开跑。
      input.value = '';
      input.blur();
      doGen(text);
    } else if (currentMode === MODE_REWRITE) {
      // 重写：确认前不清空输入（弹窗由 doRewrite 流程内处理）
      input.value = '';
      input.blur();
      doRewrite(text);
    } else if (currentMode === MODE_SUMM) {
      // 总结归纳：派发子会话
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

  /* 生成中禁言 */
  function onGen(statusVal) {
    if (statusVal === 'generating') setGenerating(true);
    else if (statusVal === 'done') setGenerating(false);
  }
  window.Teahouse.on('generation.status', onGen);
  onGen(window.Teahouse.generationStatus || 'idle');

  /* ---- 初始化 ---- */
  applyMode();
  window.registerUI('teahouse-input-bar', wrap);
})();
