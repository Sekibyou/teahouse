# 沙盒 API · 事件

## 事件监听

### `Teahouse.on(event, callback)` / `Teahouse.off(event, callback)`

订阅/取消订阅事件。callback 接收事件 payload。

## 事件类型

| 事件 | payload | 触发时机 |
|---|---|---|
| `output.refresh` | `{ path }` | 宿主收到 `file_changed`/`workspace_changed` SSE，且变更**不在** `runtime/sandbox/` 下时推送（floors、`runtime_vars.jsonl`、`text-style-rules.yaml`、`settings/`、`dm-output.jsonl` 等所有"数据"路径）—— **沙盒应重新拉取楼层/文件并重渲染**。`path` 为后端裸相对路径；整仓级变更（如 git 回档）时 `path` 为 `"*"`。**注意 `runtime/sandbox/` 本身的改动不走本事件**（那是代码，宿主直接重建 iframe srcdoc） |
| `tool_run` | `{ run_uuid, index, tool, result, ok, instance_id }` | `runTool` 后台任务每完成一个步骤广播一条。**bootstrap 内部已封装完成判定**，UI 组件通常不需要直接订阅此事件——使用 `Teahouse.runTool()` 的 Promise/handle 接口即可 |
| `tool_run_cancelled` | `{ run_uuid, instance_id }` | 某 runTool 批被后端取消（经 `handle.cancel()` / `Teahouse.cancelRunTool(run_uuid)`）时广播。bootstrap 内部据此 reject 对应批，UI 无需手动订阅 |
| `generate_progress` | `{ run_uuid, path, delta, accumulated_len, accumulated_text, done, instance_id }` | `Generate` 流式每收到一个正文 chunk 广播一条。**bootstrap 内部已集中订阅并维护 `Teahouse.currentDraft`**，UI 组件订阅 `draft.change` 即可——不需要直接处理此事件。**bootstrap 只跟踪写往 `runtime/floors/` 的生成**（其余路径如 `temp/`、`settings/` 的后台生成不进状态机），故 `currentDraft` 只反映进正文历史的流 |
| `draft.change` | `{ path, text, accumulated_len }` | bootstrap 收到（`runtime/floors/` 下的）`generate_progress` 后更新 `currentDraft` 并广播此事件。UI 组件（如正文渲染器）订阅此事件即可实现生成中的打字机效果 |
| `generation.status` | `'generating'` / `'done'` | 生成状态变化时广播。`generating`=开始一段新的正文流（path 变化、建立 `currentDraft` 时）；`done`=生成结束、`currentDraft` 已清空。**该事件从不广播 `'idle'`**——`'idle'` 只是状态变量 `Teahouse.generationStatus` 的初值 |
| `draft.committed` | `{ num, path, title, commit_hash, failed, committed_draft }` | `Teahouse.commitDraft()` 成功转正后宿主广播。**非调用方组件**（page-bar 角标、导演手动转正后 `novel-main.js` 输入条切态）订阅它同步状态 |
| `session_done` | `{ instance_id, session_id }` | 子会话导演调用了 `EndSession` —— 宣告该子任务工作完成。**只发信号、不销毁会话**；是否销毁由调用方（沙盒 `sessionDestroy` 或用户）决定 |
| `session_destroyed` | `{ instance_id, session_id }` | 某子会话被销毁（沙盒或前端调用 `sessionDestroy`）后广播。沙盒若在监听对应会话,应清理相关 UI/状态 |
| `session.busy` | `{ sessions: { <sid>: true }, busy: bool, since: number \| null }` | **导演 / DM 会话开始或结束工作时**推送，**只在两个沿各推一次**（不随流式正文高频刷新）。`sessions` 只列**正在工作**的会话（`main` 主导演 / `dm` DM / `session-<uuid>` 子会话）；`busy` = 是否有任一在跑；`since` = 当前这批忙碌里最早的起始时刻（epoch ms）。**iframe 重建后会补推一次当前值**，订阅即得状态，无需自行拉初始。详见下节 |
| `theme.change` | `{ dark: bool }` | 宿主切 dark/light 主题时推送（初次挂载 / iframe 重建后也会补推当前值）。`dark` 表示宿主当前是否**暗色**。沙盒 UI 若想跟随宿主主题，订阅此事件切换自己的配色 |
| `font-scale` | `{ scale: number }` | 宿主在 设置→通用设置 调字号档位时推送（初次挂载 / iframe 重建后也会补推当前值）。`scale` 是宿主 `--ui-scale` 的乘数（<1 缩小、>1 放大，默认为 1）。沙盒**是否跟随由作者决定**：想跟随宿主字号就用 rem / 字号 CSS 变量做基准（见下），不想跟随可无视此事件 |

## 跟随宿主主题（`theme.change`）

沙盒是 `<iframe sandbox="allow-scripts">` 隔离环境，**读不到**宿主 DOM / `localStorage` / CSS class，因此组件要跟随宿主 dark/light，只能订阅宿主主动推送的 `theme.change` 事件。订阅后按 `dark` 切换自己组件的配色（改元素的内联样式、切换 CSS 变量、或注入不同 `<style>` 均可）：

```js
// 组件.js — 跟随宿主主题
var root = document.documentElement;   // 或某个容器

function applyTheme(dark) {
  root.style.setProperty('--bg', dark ? '#0d0d1f' : '#f5f5f7');
  root.style.setProperty('--fg', dark ? '#eee' : '#222');
  root.style.setProperty('--panel', dark ? 'rgba(12,12,28,0.94)' : 'rgba(255,255,255,0.92)');
  root.style.setProperty('--border', dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)');
  Fab.style.border = dark ? '1px solid rgba(255,255,255,0.16)' : '1px solid rgba(0,0,0,0.16)';
  // ...
}

Teahouse.on('theme.change', function(ev) { applyTheme(!!ev.dark); });

// sandbox 端只有一个 host theme，可用 CSS 变量集中换肤：组件里的颜色一律用
// var(--fg) / var(--bg) / var(--panel) 等，host 一改，全部组件自动跟随。
```

**要点**：
- 事件在**初次挂载 / iframe 重建后**也会补推一次当前主题，所以组件无需自行拉初始值——订阅后 `theme.change` 一定会到。
- 宿主切主题**不重建 iframe**（只在变更时发一次事件），所以沙盒内 DOM 状态保留，`applyTheme` 原地换肤即可。
- 让所有组件统一通过 CSS 变量换肤，比每个组件单独监听更省事；若某组件要完全不同的配色，再单独监听 `theme.change`。

## 跟随宿主字号（`font-scale`）

沙盒同样读不到宿主的 `--ui-scale`。想让正文/面板跟随宿主字号档位，**关键在于实例 CSS 从一开始就用地基字号变量（rem 或 CSS 变量）做基准**，而不是把 px 写死在每个组件里——否则宿主无法强制放大已固定 px 的字号。推荐：抽一个 `--font-scale` 变量并在 `theme.css` 里订阅宿主 `font-scale` 事件回填，让所有用它的字号（含 rem）整体缩放：

```js
// theme-proxy.js — 跟随宿主字号档位
Teahouse.on('font-scale', function(ev) {
  var s = (typeof ev.scale === 'number' && ev.scale > 0) ? ev.scale : 1;
  document.documentElement.style.setProperty('--font-scale', s);
});
```

```css
/* theme.css —— 正文/面板字号一律经 --font-scale 放大 */
:root {
  --font-scale: 1;
  /* 1rem 基准上乘宿主乘数：宿主调大字号，正文/卡片文本自动跟随 */
  --text: calc(1rem * var(--font-scale));
  --text-lg: calc(1.15rem * var(--font-scale));
  --text-sm: calc(0.875rem * var(--font-scale));
}
/* 组件用 rem 或 var(--text*) 设字号，不要裸写 px；字号抽到变量便于全局缩放 */
.room-text { font-size: var(--text); }
```

**要点**：
- `font-scale` 与 `theme.change` 一样在**初次挂载 / iframe 重建后补推一次**，订阅即得当前值，无需自行拉初始。
- 宿主切字号**不重建 iframe**，沙盒原地改根 CSS 变量即可即时生效。
- 用 rem 的组件会在浏览器默认 16px 基准上乘 `--font-scale`；若想要**更大范围**的整块缩放（连 rem 的间距也一起），可直接改根 `font-size` 而非只设字号变量，但那样会连布局间距一起放大——通常只想要正文可读性时选字号变量即可。
- 不跟随也合法：某个 canvas / 特殊组件想固定字号，无视 `font-scale` 事件、维持自己的 px 即可。

## 导演 / DM 忙碌态（`session.busy`）

游玩界面的输入条最怕"盲盒"：玩家发了话，AI 却半天不出声，玩家只能反复敲。**`session.busy` 就是把「现在正忙、请稍候」这件事告诉沙盒**——据此锁住输入 + 显示等待提示。

它由后端**权威状态**（`session_tracker` 的 running map）驱动：导演 / DM 的工具循环一启动就广播 `start` 边界、结束时广播 `done`，宿主把 running map 归一成本事件，**只在开始 / 结束两个沿各推一次**，不随流式正文高频刷新。

```js
Teahouse.on('session.busy', function(ev) {
  // ev.sessions 只列正在工作的会话；缺省即空闲
  var dmWorking = !!ev.sessions['dm'];
  var dirWorking = !!ev.sessions['main'];
  input.disabled = dmWorking;                 // 锁输入（DM 式）
  hint.textContent = dmWorking ? 'DM 正在工作… ' + elapsed(ev.since) : '';
});
```

**要点**：
- **事件在初次挂载 / iframe 重建后也会补推一次当前值**，订阅即得状态，无需自行拉初始（与 `theme.change` / `font-scale` 同）。
- **只认自己关心的会话**：DM 式看 `sessions['dm']`，小说式看 `sessions['main']`。主导演在后台跑（生成正文、总结）时不该锁住 DM 的扮演输入，反之亦然。
- **秒数自己算**：`since` 是权威起始时刻（epoch ms），用它算「已过去多少秒」；iframe 中途重建也能续上，不会从 0 重数。**没有高频 tick**——不要指望靠事件更新秒数，用 `setInterval` 自绘。
- **超时兜底**：SSE 断线期间可能漏掉结束事件。宿主在重连后会拉 `GET /instances/{id}/sessions/status` 校正并补推，沙盒侧无需额外处理。
- 忙碌期间**别把 DOM 全拆了重建**（那会丢掉玩家已输入的草稿）——禁用输入框即可。

## 流式草稿（`Teahouse.currentDraft`）

bootstrap 内部集中订阅 `generate_progress`，维护流式草稿缓冲区。UI 组件可以直接读取：

- **`Teahouse.currentDraft`** — `{ path, text, accumulated_len }` 或 `null`。生成中实时更新（delta 追加），生成结束清空
- **`Teahouse.generationStatus`** — `'idle'` / `'generating'` / `'done'`

正文渲染器可以这样实现打字机效果：

```js
Teahouse.on("draft.change", function(draft) {
  // draft = { path, text, accumulated_len }
  // 用 requestAnimationFrame 节流渲染，避免高频 DOM 操作
  scheduleRender(draft);
});

Teahouse.on("generation.status", function(status) {
  if (status === "done") {
    // 生成结束，等 output.refresh 触发文件渲染接管
  }
});
```

宿主监听 `file_changed` / `workspace_changed` SSE（导演工具调用广播）：变更路径**在 `runtime/sandbox/` 之外** → 向沙盒推送 `output.refresh`（数据类变更，沙盒重读重渲染）；变更**在 `runtime/sandbox/` 内** → 不推 `output.refresh`，而是重建 iframe srcdoc（代码类变更，热重载）。沙盒借此在导演每次写正文/改组件后自动对齐。

**⚠️ `_teahouse_event` 事件桥单一所有权**：宿主在 srcdoc 顶部注入的 bridge 是 `_teahouse_event`（含 `generate_progress`、`output.refresh`）的**唯一**转发入口，它已监听 `window message` 并 `_emit`。bootstrap 内部订阅 `generate_progress` 和 `tool_run` 维护 currentDraft 和 runTool 封装。用户代码不应再直接监听 `generate_progress` 或自行管理 `tool_run` 完成判定，应使用 `Teahouse.runTool()` Promise 和 `draft.change` 事件。

**Generate 流式**：生成进行中**不落盘**，仅把每个正文 chunk 作为增量 `delta` 立即广播 `generate_progress`（携带 `run_uuid`、`path`）。**结束/用户取消（runTool 打断或导演 ESC）/报错才一次性落盘 + 广播 `file_changed`，且广播一条 `done:true` 带全文 `accumulated_text` 的校准消息**（取消也算"中断"，**已生成的正文同样落半成品供续写**，不会丢内容）。bootstrap 据此：
- 开始 generate → `generationStatus = 'generating'`，`currentDraft` 建立，`draft.change` 广播
- 每个 delta → 追加到 `currentDraft.text`，`draft.change` 广播 → 正文渲染器 rAF 节流刷新
- 结束 → `currentDraft = null`，`generationStatus = 'done'`，等 `file_changed` → `output.refresh` → 文件渲染接管
