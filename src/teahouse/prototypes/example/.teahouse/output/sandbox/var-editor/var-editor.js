(function() {
  /* 变量修改器 — 右侧悬浮球点击弹出
     两个 Tab：
       Tab1 重要变量：列出重要变量，就地改值，点「提交」才统一落盘（Teahouse.setVar 合并写）
       Tab2 所有变量：列出全部变量字面量，勾选 = 加入重要变量（清单存 var-editor/important-vars.json）
     风格对齐翻页器 page-bar：面板走 theme.css 的 CSS 变量（亮暗跟随宿主）
     语义色引用变量：危险/脏 var(--danger)、星标/重要 var(--warn)、强调 var(--accent)；
     控件用 theme.css 的 th-btn / th-btn-ghost / th-ip / th-icon 类。
     层级：按钮 var(--z-trigger) / 弹窗 var(--z-panel)，规范见 theme.css */

  var ACCENT = 'var(--accent)';
  var PANEL_W = 330;
  var PREFS_PATH = '.teahouse/output/sandbox/var-editor/important-vars.json';

  /* ---------- 工具 ---------- */
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* 值 → 编辑框文本：对象/数组 JSON 化，标量直接转字符串，null 给空 */
  function valToText(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') {
      try { return JSON.stringify(v); } catch (e) { return String(v); }
    }
    return String(v);
  }

  /* 编辑框文本 → 值：能 JSON.parse 就解析（数字/布尔/对象/数组/null），否则当字符串 */
  function textToVal(t) {
    var s = String(t).trim();
    if (s === '') return '';
    try { return JSON.parse(s); } catch (e) { return s; }
  }

  /* ---------- DOM 骨架 ---------- */
  var fab = document.createElement('button');
  fab.id = 'var-editor-fab';
  fab.type = 'button';
  fab.title = '变量修改器';
  fab.innerHTML = '<span id="var-editor-fab-icon" style="display:inline-block;transition:transform 0.25s;">&#9881;</span>';
  fab.style.cssText =
    'position:fixed;right:22px;bottom:94px;z-index:var(--z-trigger);' +
    'width:46px;height:46px;border-radius:50%;' +
    'display:flex;align-items:center;justify-content:center;' +
    'background:var(--fab-bg);color:var(--panel-text);' +
    'border:1px solid var(--panel-border);' +
    'backdrop-filter:blur(8px);cursor:pointer;font-size:16px;' +
    'box-shadow:0 6px 20px rgba(0,0,0,0.45);' +
    'transition:transform 0.2s,border-color 0.2s,background 0.25s,color 0.25s;' +
    'user-select:none;';

  var dirtyDot = document.createElement('span');
  dirtyDot.id = 'var-editor-fab-dot';
  dirtyDot.title = '有未提交的修改';
  dirtyDot.style.cssText =
    'position:absolute;top:-3px;right:-3px;' +
    'width:12px;height:12px;border-radius:50%;' +
    'background:var(--danger-fill);border:2px solid var(--fab-bg);' +
    'display:none;';
  fab.appendChild(dirtyDot);

  var panel = document.createElement('div');
  panel.id = 'var-editor-panel';
  panel.style.cssText =
    'position:fixed;right:22px;bottom:calc(94px + 56px);z-index:var(--z-panel);' +
    'width:' + PANEL_W + 'px;max-width:92vw;max-height:70vh;' +
    'background:var(--panel);color:var(--panel-text);' +
    'border:1px solid var(--panel-border);border-radius:14px;' +
    'box-shadow:0 12px 40px rgba(0,0,0,0.6);' +
    'backdrop-filter:blur(10px);' +
    'display:none;overflow:hidden;flex-direction:column;' +
    'font-family:"Noto Sans SC","PingFang SC",sans-serif;';

  panel.innerHTML =
    /* 标题 */
    '<div style="display:flex;align-items:center;gap:8px;padding:10px 12px;' +
    'border-bottom:1px solid var(--panel-border);">' +
    '<span style="flex:1;font-size:13px;font-weight:700;letter-spacing:0.05em;">变量修改器</span>' +
    '<span id="var-editor-hint" style="font-size:10px;color:var(--panel-text-dim);">读档中…</span>' +
    '</div>' +
    /* Tab 头 */
    '<div id="var-editor-tabs" style="display:flex;padding:6px 10px 0;gap:6px;">' +
    '<button type="button" data-tab="1" class="ve-tab" style="' +
    'flex:1;height:30px;border:none;border-bottom:2px solid transparent;border-radius:8px 8px 0 0;' +
    'cursor:pointer;font-size:12px;background:transparent;">重要变量</button>' +
    '<button type="button" data-tab="2" class="ve-tab" style="' +
    'flex:1;height:30px;border:none;border-bottom:2px solid transparent;border-radius:8px 8px 0 0;' +
    'cursor:pointer;font-size:12px;background:transparent;">所有变量</button>' +
    '</div>' +
    /* Tab 内容容器 */
    '<div id="var-editor-body" style="flex:1;min-height:180px;max-height:44vh;overflow-y:auto;padding:10px;"></div>' +
    /* 底部操作行（仅重要变量 tab 显示提交） */
    '<div id="var-editor-foot" style="display:none;gap:6px;padding:8px 10px;' +
    'border-top:1px solid var(--panel-border);">' +
    '<button type="button" id="var-editor-submit" class="th-btn" style="' +
    'flex:1;height:32px;">提交修改</button>' +
    '</div>';

  document.body.appendChild(fab);
  document.body.appendChild(panel);

  var tabBtns = panel.querySelectorAll('#var-editor-tabs button');
  var bodyBox = document.getElementById('var-editor-body');
  var foot = document.getElementById('var-editor-foot');
  var submitBtn = document.getElementById('var-editor-submit');
  var hint = document.getElementById('var-editor-hint');

  /* ---------- 状态 ---------- */
  var open = false;
  var activeTab = 1;
  var importantList = [];   // 重要变量名数组
  var allVars = [];         // [{name, value}]
  var pending = {};         // 待提交修改 {name: 编辑框文本}

  /* ---------- 数据载入 ---------- */
  function loadImportant() {
    return Teahouse.readText(PREFS_PATH).then(function(txt) {
      try {
        var parsed = JSON.parse(txt || '{}');
        importantList = Array.isArray(parsed.important) ? parsed.important : [];
      } catch (e) {
        importantList = [];
      }
    }).catch(function() { importantList = []; });
  }

  function saveImportant() {
    return Teahouse.writeFile(PREFS_PATH, JSON.stringify({ important: importantList }));
  }

  function loadAll() {
    return Teahouse.getVars().then(function(entries) {
      allVars = entries || [];
    });
  }

  function refreshAll() {
    hint.textContent = '读档中…';
    return Promise.all([loadImportant(), loadAll()]).then(function() {
      hint.textContent = '共 ' + allVars.length + ' 个变量';
      render();
    }).catch(function() {
      hint.textContent = '读取失败';
    });
  }

  /* ---------- Tab 切换 ---------- */
  function setTab(n) {
    activeTab = n;
    for (var i = 0; i < tabBtns.length; i++) {
      var isActive = parseInt(tabBtns[i].getAttribute('data-tab'), 10) === n;
      tabBtns[i].style.background = isActive ? 'var(--accent-soft)' : 'transparent';
      tabBtns[i].style.color = isActive ? 'var(--accent-text)' : 'var(--panel-text-soft)';
      tabBtns[i].style.borderBottom = isActive ? '2px solid var(--accent)' : '2px solid transparent';
    }
    foot.style.display = (n === 1 && Object.keys(pending).length > 0) ? 'flex' : 'none';
    render();
  }

  /* ---------- 渲染 ---------- */
  function render() {
    if (!open) return;
    if (activeTab === 1) renderImportant();
    else renderAll();
    foot.style.display = (activeTab === 1 && Object.keys(pending).length > 0) ? 'flex' : 'none';
    dirtyDot.style.display = Object.keys(pending).length > 0 ? 'block' : 'none';
  }

  function renderImportant() {
    if (importantList.length === 0) {
      bodyBox.innerHTML =
        '<div style="padding:18px 10px;text-align:center;">' +
        '<div style="color:var(--panel-text-soft);font-size:12.5px;margin-bottom:6px;">还没有重要变量</div>' +
        '<div style="color:var(--panel-text-dim);font-size:11px;">去「所有变量」勾选，就会出现在这里</div>' +
        '</div>';
      return;
    }
    var valueMap = {};
    for (var i = 0; i < allVars.length; i++) valueMap[allVars[i].name] = allVars[i].value;

    var html = '';
    for (var j = 0; j < importantList.length; j++) {
      (function(name) {
        var curVal = valueMap[name];
        var curText = valToText(curVal);
        var editText = (name in pending) ? pending[name] : curText;
        var isDirty = (name in pending);
        html +=
          '<div class="ve-row" data-name="' + esc(name) + '" style="' +
          'display:flex;align-items:center;gap:6px;padding:7px 4px;border-bottom:1px solid var(--panel-border);">' +
          '<div style="flex:none;width:88px;font-size:11.5px;color:var(--panel-text-soft);' +
          'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left;" title="' + esc(name) + '">' +
          esc(name) + '</div>' +
          '<input type="text" value="' + esc(editText) + '" placeholder="' + esc(curText) + '" class="th-ip" style="' +
          'border:1px solid ' + (isDirty ? 'var(--danger)' : 'var(--control-border)') + ';' +
          (isDirty ? 'border-color:var(--danger);' : '') + '">' +
          (isDirty ? '<span style="color:var(--danger);font-size:10px;flex:none;">改</span>' : '') +
          '<button type="button" class="ve-unpin th-icon" title="取消重要" style="' +
          'font-size:14px;color:var(--warn);">&#9733;</button>' +
          '</div>';
      })(importantList[j]);
    }
    bodyBox.innerHTML = html;

    /* 输入监听 → 记入 pending */
    var inputs = bodyBox.querySelectorAll('input[type="text"]');
    for (var k = 0; k < inputs.length; k++) {
      (function(inp) {
        var row = inp.closest('.ve-row');
        var name = row.getAttribute('data-name');
        inp.addEventListener('input', function() {
          pending[name] = inp.value;
          inp.style.borderColor = 'var(--danger)';
          // 更新行内"改"标记
          var badge = row.querySelector('.ve-badge');
          if (!badge) {
            var sp = document.createElement('span');
            sp.className = 've-badge';
            sp.style.cssText = 'color:var(--danger);font-size:10px;flex:none;';
            sp.textContent = '改';
            inp.parentNode.insertBefore(sp, inp.nextSibling);
          }
          foot.style.display = 'flex';
          dirtyDot.style.display = 'block';
        });
      })(inputs[k]);
    }
    /* 取消重要 */
    var unpins = bodyBox.querySelectorAll('.ve-unpin');
    for (var m = 0; m < unpins.length; m++) {
      (function(btn) {
        btn.addEventListener('click', function() {
          var name = btn.closest('.ve-row').getAttribute('data-name');
          importantList = importantList.filter(function(n) { return n !== name; });
          delete pending[name];
          saveImportant().then(refreshAll);
        });
      })(unpins[m]);
    }
  }

  function renderAll() {
    if (allVars.length === 0) {
      bodyBox.innerHTML = '<div style="padding:18px 10px;color:var(--panel-text-dim);font-size:12px;text-align:center;">暂无变量</div>';
      return;
    }
    var html =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">' +
      '<span style="flex:1;font-size:10.5px;color:var(--panel-text-dim);">点击星标 = 加入重要变量</span>' +
      '<button type="button" id="ve-refresh" class="th-btn-ghost" style="' +
      'flex:none;height:24px;padding:0 10px;font-size:11px;border-radius:6px;">刷新</button>' +
      '</div>';
    for (var i = 0; i < allVars.length; i++) {
      (function(item) {
        var isImp = importantList.indexOf(item.name) !== -1;
        var disp = valToText(item.value);
        html +=
          '<div class="ve-all-row" data-name="' + esc(item.name) + '" style="' +
          'display:flex;align-items:center;gap:8px;padding:6px 4px;border-radius:6px;' +
          'border-bottom:1px solid var(--panel-border);' +
          (isImp ? 'background:var(--accent-soft);' : '') + '">' +
          '<button type="button" class="ve-star th-icon" title="' + (isImp ? '取消重要' : '标记重要') + '" style="' +
          'font-size:16px;padding:2px;' +
          'color:' + (isImp ? 'var(--warn)' : 'var(--panel-text-dim)') + ';">' +
          (isImp ? '&#9733;' : '&#9734;') + '</button>' +
          '<span style="flex:none;width:92px;font-size:11.5px;color:' + (isImp ? 'var(--accent-text)' : 'var(--panel-text-soft)') + ';' +
          'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + esc(item.name) + '">' + esc(item.name) + '</span>' +
          '<span style="flex:1;font-size:11px;color:var(--panel-text-dim);' +
          'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:right;" title="' + esc(disp) + '">' +
          esc(disp) + '</span>' +
          '</div>';
      })(allVars[i]);
    }
    bodyBox.innerHTML = html;

    /* 点击星标切换重要 */
    var rows = bodyBox.querySelectorAll('.ve-all-row');
    for (var j = 0; j < rows.length; j++) {
      (function(row) {
        var star = row.querySelector('.ve-star');
        var name = row.getAttribute('data-name');
        star.addEventListener('click', function() {
          if (importantList.indexOf(name) !== -1) {
            importantList = importantList.filter(function(n) { return n !== name; });
            delete pending[name];
          } else {
            if (importantList.indexOf(name) === -1) importantList.push(name);
          }
          saveImportant().then(refreshAll);
        });
      })(rows[j]);
    }

    var refBtn = document.getElementById('ve-refresh');
    if (refBtn) refBtn.addEventListener('click', refreshAll);
  }

  /* ---------- 提交 ---------- */
  function submit() {
    if (Object.keys(pending).length === 0) return;
    var updates = {};
    var names = Object.keys(pending);
    for (var i = 0; i < names.length; i++) {
      updates[names[i]] = textToVal(pending[names[i]]);
    }
    submitBtn.disabled = true;
    submitBtn.textContent = '提交中…';
    Teahouse.setVar(updates).then(function() {
      pending = {};
      submitBtn.disabled = false;
      submitBtn.textContent = '提交修改';
      hint.textContent = '已保存 ✓';
      return refreshAll();
    }).catch(function() {
      submitBtn.disabled = false;
      submitBtn.textContent = '提交修改';
      hint.textContent = '保存失败';
    });
  }

  /* ---------- 开合 ---------- */
  function openPanel() {
    open = true;
    panel.style.display = 'flex';
    document.getElementById('var-editor-fab-icon').style.transform = 'rotate(45deg)';
    refreshAll();
  }
  function closePanel() {
    open = false;
    panel.style.display = 'none';
    document.getElementById('var-editor-fab-icon').style.transform = '';
  }
  fab.addEventListener('click', function(e) {
    e.stopPropagation();
    open ? closePanel() : openPanel();
  });

  /* 点击外部收起 */
  document.addEventListener('click', function(e) {
    if (open && !panel.contains(e.target) && !fab.contains(e.target)) closePanel();
  });

  /* ---------- 事件绑定 ---------- */
  for (var i = 0; i < tabBtns.length; i++) {
    (function(btn) {
      btn.addEventListener('click', function() {
        setTab(parseInt(btn.getAttribute('data-tab'), 10));
      });
    })(tabBtns[i]);
  }
  submitBtn.addEventListener('click', submit);

  /* 导演改变量（如选项落盘）后，若面板开着，静默重载 */
  Teahouse.on('output.refresh', function() {
    if (open) {
      loadAll().then(function() { render(); });
    }
  });

  /* ---------- 挂载 ---------- */
  window.registerUI('var-editor-fab', fab);
  window.registerUI('var-editor-panel', panel);

  setTab(1);
  loadImportant().then(loadAll).then(function() {
    hint.textContent = '共 ' + allVars.length + ' 个变量';
    if (open) render();
  });
})();
