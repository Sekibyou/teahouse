(function() {
  /* theme-proxy.js — 宿主主题跟随
     订阅宿主推送的 theme.change（dark: bool），把 documentElement 的
     data-theme 切到 'dark'/'light'。theme.css 用该属性切换一套 CSS 变量，
     所有用 var(--xxx) 的正文与悬浮组件自动跟随换肤。
     只此一个文件监听宿主；组件不该各自再订阅 theme.change，改走 CSS 变量。 */

  function applyTheme(dark) {
    document.documentElement.setAttribute(
      'data-theme',
      dark ? 'dark' : 'light'
    );
  }

  window.Teahouse.on('theme.change', function(ev) {
    if (ev && typeof ev.dark === 'boolean') applyTheme(ev.dark);
  });

  // 宿主在初次挂载 / iframe 重建后都会补推 theme.change，故此订阅即够，
  // 无需额外拉初始值。兜底：若无论如何没收到，默认用暗色（与 theme.css
  // 的 :root 默认一致）。
  applyTheme(true);
})();
