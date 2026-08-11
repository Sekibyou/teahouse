(function() {
  /* 一次性用户名初始化弹窗 —— 每次启动检查 ${user} 变量
     空（未初始化 / 空字符串 / 纯空白）→ 弹出全屏遮罩，要求输入用户名，提交即 setVar
     非空 → 直接跳过，不打扰
     设计为「一次性 + 无法关闭」：没有关闭按钮，点击遮罩不隐藏，只能提交后消失。 */

  var USER_VAR = 'user';

  function isEmpty(value) {
    return value === null || value === undefined || String(value).trim() === '';
  }

  function buildAndCheck() {
    window.Teahouse.getVars([USER_VAR]).then(function(entries) {
      var v = (entries && entries[0]) ? entries[0].value : null;
      if (!isEmpty(v)) return;   // 已有用户名 → 跳过，不弹窗
      showPrompt();
    }).catch(function() {
      // 读取失败时保守起见不打扰游玩，静默跳过
      console.error('[UserPrompt] getVars failed:', arguments[0]);
    });
  }

  function showPrompt() {
    /* 全屏遮罩：z-index 拉满，覆盖输入栏(300)/覆写弹窗(610)等一切 */
    var overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:900;display:flex;' +
      'align-items:center;justify-content:center;' +
      'background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);' +
      'font-family:"Noto Sans SC","PingFang SC",sans-serif;';

    var card = document.createElement('div');
    card.style.cssText =
      'width:min(88%,360px);background:var(--panel);color:var(--panel-text);' +
      'border:1px solid var(--panel-border);border-radius:14px;' +
      'box-shadow:var(--shadow-panel);padding:22px;' +
      'text-align:center;';

    var title = document.createElement('div');
    title.textContent = '欢迎来到灰石镇';
    title.style.cssText =
      'font-size:16px;font-weight:700;margin-bottom:6px;';

    var hint = document.createElement('div');
    hint.textContent = '首次进入，请为自己取一个名字（冒险者代号）。';
    hint.style.cssText =
      'font-size:12.5px;color:var(--panel-text-soft);line-height:1.7;margin-bottom:16px;';

    var input = document.createElement('input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.maxLength = 20;
    input.placeholder = '输入你的名字…';
    input.style.cssText =
      'width:100%;box-sizing:border-box;height:38px;padding:0 12px;' +
      'border-radius:10px;border:1px solid var(--control-border);' +
      'background:var(--control-bg);color:var(--panel-text);outline:none;' +
      'font-size:13px;margin-bottom:16px;';

    var submit = document.createElement('button');
    submit.type = 'button';
    submit.textContent = '开始冒险';
    submit.style.cssText =
      'width:100%;height:38px;border:none;border-radius:10px;' +
      'background:var(--accent-fill);color:var(--accent-filled-text);' +
      'font-size:13px;font-weight:700;cursor:pointer;' +
      'transition:opacity 0.2s;';
    submit.addEventListener('mouseenter', function() { submit.style.opacity = '0.88'; });
    submit.addEventListener('mouseleave', function() { submit.style.opacity = '1'; });

    function commit() {
      var name = input.value.trim();
      if (!name) { input.focus(); return; }
      submit.disabled = true;
      submit.textContent = '设定中…';
      window.Teahouse.setVar({ user: name }).then(function() {
        overlay.remove();
      }).catch(function() {
        submit.disabled = false;
        submit.textContent = '开始冒险';
        input.focus();
      });
    }

    submit.addEventListener('click', commit);
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') commit();
    });

    card.appendChild(title);
    card.appendChild(hint);
    card.appendChild(input);
    card.appendChild(submit);
    overlay.appendChild(card);

    // 无法关闭：点击遮罩、按 Esc 都不隐藏，只能提交
    overlay.addEventListener('click', function(e) { e.stopPropagation(); });

    window.registerUI('user-prompt', overlay);
    input.focus();
  }

  /* 启动时检查一次 */
  if (window.Teahouse && window.Teahouse.getVars) {
    buildAndCheck();
  } else {
    // 保险：等 Teahouse 就绪（一般不会走到）
    var t = setInterval(function() {
      if (window.Teahouse && window.Teahouse.getVars) {
        clearInterval(t);
        buildAndCheck();
      }
    }, 200);
  }
})();
