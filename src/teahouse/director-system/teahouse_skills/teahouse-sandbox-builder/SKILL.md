---
name: teahouse-sandbox-builder
description: 教导导演如何设计和构建前端沙盒代码（UI 组件、场景脚本、CSS 主题），含沙盒 API 参考与最佳实践。**基础层 bootstrap.js 由平台在组装 iframe 时自动注入，不在 sandbox 文件夹里**——导演只需编写实例 `runtime/sandbox/` 下的 `*.js` / `*.css` 组件，不要创建 bootstrap.js。当用户要求创建自定义界面、设计交互、添加 UI 组件、更改主题样式、"给实例做前端"时触发。（小说式 / 跑团·语C·聊天式 的**模式选择与方法论**见 `teahouse-play-mode` skill；本 skill 只管沙盒代码怎么写。）
---

# Sandbox Builder Skill

教导导演如何设计、编写和部署前端沙盒代码。

## 适用时机

当用户提出以下意图时加载本 skill：
- "给实例做一个 UI 界面"
- "添加一个状态栏 / 侧边栏 / 按钮"
- "修改沙盒样式 / 主题"
- "创建一个交互式场景"
- "让页面看起来像 XX 风格"
- "给实例做前端"
- "重新设计沙盒"

**模式选择**（小说式 vs 跑团 / 语C / 聊天式、要不要启用 DM）属 `teahouse-play-mode` skill；本 skill 只负责"沙盒代码本身怎么写"。

## 沙盒架构概览

Teahouse 前端沙盒是一个通过 `<iframe sandbox="allow-scripts">` 隔离的独立运行环境。沙盒分为两层：

- **基础设施层（引擎内置，不出现于实例）**：`bootstrap.js` — postMessage 通信桥、Teahouse API、runTool 封装、流式草稿管理、事件系统、UI 组件管理、DOM 容器创建。由引擎提供，随引擎升级自动更新。
- **UI 组件层（实例 `runtime/sandbox/`）**：用户的组件文件 — 正文渲染器、翻页器、变量面板、生成按钮、主题样式等。热重载热插拔，写文件即生效。

**沙盒代码是文件系统驱动的**，UI 组件唯一来源是 `runtime/sandbox/` 目录。前端渲染器（SandboxManager）遍历该目录构建 srcdoc，**无需任何推送工具**——你只需 Write 文件，前端自动读取并重建 iframe。

### 沙盒目录结构 —— 一个组件 = 一个文件，或一个文件夹

`runtime/sandbox/` **根目录只允许两类组件条目，每个组件一份，不留多余文件**（另有一个引擎约定的 `manifest.md`，见下）：

| 条目 | 含义 |
|---|---|
| `foo.js` | **简单组件**：单个自包含 js 文件 = 一整个组件 |
| `foo/` | **组件包**：文件夹内一个入口 js + 该组件的数据（`.json` 等） |

**文件夹 = 组件包**。文件夹名 = 组件名，内部唯一的入口脚本**必须与文件夹同名**（如 `foo/foo.js`）；文件夹里其余文件（`.json` / `.md` / `.txt`）都是该组件的数据，数据用**纯 `.json`** 即可（不被当作代码注入，天然安全）。

**三条自包含硬约束**：
- **UI 不写独立 `.css` 文件** —— 组件自己的样式一律**内嵌在组件 js 里**（`element.style.cssText` 或注入 `<style>`），杜绝 `foo.css` 与 `foo.js` 散落。
- **不区分 UI js 与辅助 js** —— 一个组件所有逻辑**收敛进单个 js**（IIFE + 内部 function/var），不拆 helper 文件。
- **根目录不直接放配置文件** —— 数据一律进该组件所属的文件夹内。

**唯一例外：全局主题 css**。仅全局级/换肤入口（如 `theme.css`）允许作为根目录下的独立 css 文件存在。组件局部样式不在此列，一律内嵌 js。

**注意**：`bootstrap.js` 是引擎内置的，不在实例目录中。不要创建 `bootstrap.js`——即使创建了也会被忽略。

**另有引擎约定文件 `manifest.md`**（`runtime/sandbox/manifest.md`，可选）：它**不是组件**，而是聚合**包内** UI 资源的清单——每行一个 `{{@包名/runtime/sandbox/xxx.js|.css}}` 引用，引擎把被引用的包文件与本地 `*.js`/`*.css` 一起 inline 进沙盒。它自身不被当资源服务（见 `behavior.md`）。仅在使用包（`packages/`）时才涉及，不用包就无需创建。

**正文历史不在 `runtime/sandbox/`**——它位于 `runtime/floors/`。沙盒通过 `Teahouse.readText()` 自行读取楼层文件来渲染正文。

### 注入规则（由文件名/扩展名决定，无 content_type 概念）

**无限深度扫描 `.js` / `.css`**：不论在根目录还是任意深度的子文件夹，`*.js` 都追加挂载、`*.css` 都注入 `<head>`（按相对路径排序）。**唯一的跨目录排除是 `disabled/` 子树**——其中任何文件都不被服务（这是禁用沙盒代码的机制，见「沙盒代码整体禁用」）。`.json` / `.md` / `.txt` 等数据文件**不被当代码注入**，仅作为文件存在（组件用 `readText` 自行读取）。`bootstrap.js`（引擎内置）与 `manifest.md`（聚合清单）也被排除、不当普通资源服务。

### 脚本执行顺序

srcdoc 中的 `<script>` 标签按出现顺序同步执行：

```
<script>引擎内置 bootstrap.js</script>   ← 0. 基础设施：同步创建容器、暴露 window.Teahouse、注册 tool_run/generate_progress 处理
<script>bridge</script>                  ← 1. 宿主内联的 postMessage 事件桥
<script>用户 UI 组件 *.js</script>       ← 2. 按相对路径排序：正文渲染器、翻页器、按钮等
```

**核心要点**：`#teahouse-content` 和 `#teahouse-ui-layer` 两个容器由引擎内置的 bootstrap **在 `boot()` 里同步创建**（该 `<script>` 位于 `<body>` 内，`document.body` 已存在），后续用户 `*.js` 执行时容器必然已就绪。用户 `*.js` 仍应使用 `window.registerUI()` 挂载 fixed 定位元素——`registerUI` 内部有排队机制兜底（若 UI 层意外未就绪，先把元素放入 `uiQueue`，等容器就绪后再 flush）。

### 运行时通信模型

```
iframe (沙盒)
  │
  │ postMessage({ _method, _args, _callId })
  ▼
宿主页 (SandboxManager.tsx)
  │
  │ 代理到后端 API（附 JWT）
  ▼
FastAPI 后端
```

沙盒**不直接访问后端 API**，所有请求通过宿主页 `postMessage` 桥接。宿主页负责：
- 转发 API 调用并附带 JWT
- BBCode 解析（沙盒调用 `Teahouse.renderRichText()` 拿到的是 HTML）
- 权限控制（文件操作受 JWT 身份限制）

## API 参考（按需读取）

`window.Teahouse` 的全部 API 拆在 `references/` 下，写代码时按需要读：

| 文件 | 内容 |
|---|---|
| `references/core-api.md` | 楼层 `listFloors` · 富文本 `renderRichText` · 文件 `readText`/`readAsset`/`writeFile` · 发送消息 `send`/`openDirector`/`openDM` · UI `registerUI` · 容器约定 |
| `references/vars-api.md` | 变量 `setVar`/`getVars`/`roll`/`replacePlaceholders`（含空值语义）· 变量生效与转正 `refresh`/`commitDraft`/`gitDiscard`、正式楼层不可变 |
| `references/events.md` | `on`/`off` + 事件类型表 · 跟随宿主主题 `theme.change` · 跟随宿主字号 `font-scale` · 流式草稿 `currentDraft` |
| `references/subsessions.md` | 子会话 `sessionCreate`/`sessionSend`/`sessionDestroy` + `session_done` 完整流程与权限 |
| `references/run-tool.md` | `runTool(steps)` 内联工具流水线 + 与 `Teahouse.session*` 的分工对照表 |
| `references/dm-api.md` | DM 呈现 `listMessages` · `sessionSend('dm')` · `chara`/`kind` 两处配合约定 · 用户消息包裹层 |

读法：`SkillRead(name="teahouse-sandbox-builder", file="references/core-api.md")`。

## SOP

### 步骤 1：了解当前沙盒状态

```
Glob runtime/sandbox/**/*     → 查看沙盒目录中的现有文件
```

确认实例已有哪些 UI 组件。bootstrap 是引擎内置的，不需要也不应该创建。

### 步骤 2：确保渲染系统存在（先按模式分流）

**小说式**：需要**正文渲染器**。若要自己写，参考平台标准件 `novel-main.js`（正文渲染器 + 翻页器 + 输入条合体，见 `teahouse-play-mode` skill 的 `assets/novel-main.js`，可 `SkillRead` 读全文吸收）。核心职责：
- 版面管理：`Teahouse._pageState`（floors 数组 + currentIndex）
- 正文渲染：`listFloors()` + `readText()` + `renderRichText()` → DOM
- 流式草稿：订阅 `draft.change` 事件实现打字机效果
- 翻页：`goToPage(index)` / `renderCurrent()`
- `output.refresh` 精准刷新

编写时建议参考标准件的写法（其正文渲染器 / 输入条用 `var` + 普通 `function`，见 `assets/novel-main.js`）。整段代码包裹在 IIFE `(function() { ... })()` 中避免全局变量污染。

Write 到 `runtime/sandbox/novel-main.js`，前端自动重建 iframe。

**跑团 / 语C / 聊天式**：不要正文渲染器，改用 **DM 气泡渲染器**（`listMessages()` + `sessionSend('dm', …)`，见 `references/dm-api.md`）。同时把正文侧组件（`novel-main.js` / `page-bar.js` 等）移入 `runtime/sandbox/disabled/` 禁用，避免与气泡视图打架；并在实例根目录建 `dm.yaml` 启用 DM（组织方式见 `teahouse-play-mode`）。参考实现：`teahouse-play-mode` skill 的 `assets/dm-main.js`。

### 步骤 3：编写全局主题 CSS（唯一允许的独立 css）

全局级/换肤入口的 `*.css` 注入 iframe `<head>` 中的 `<style>` 标签。基础模板见实例现有 `theme.css`。Write 到 `runtime/sandbox/theme.css`。

`theme.css` 同时承载**主题换肤**：颜色一律抽成 CSS 变量（`--bg` / `--text` / `--panel` / `--accent` …），暗色为 `:root` 默认，亮色由 `html[data-theme="light"]` 覆盖。`theme-proxy.js` 订阅宿主 `theme.change` 切换 `data-theme`，所有用 `var(--…)` 的正文与悬浮组件自动跟随切换。**主题机制全量经此变量集驱动**，组件靠 CSS 变量而不靠各自监听宿主换肤。

**使用 `theme.css` 变量的三条约定**：

1. **自定义组件优先复用 `theme.css` 里已有的变量**（`var(--text)`、`var(--panel)`、`var(--accent)`、`var(--border)` 等），不要为单个组件造专属色值。
2. **`theme.css` 可以修改已有变量的值**——全局换肤、调暗亮两套的具体颜色是 theme.css 的职责。
3. **`theme.css` 不建议新增变量**——同一套变量集是各组件共享的"主题接口"，肆意扩张会让接口臃肿。组件若要一个 `theme.css` 里不存在的颜色，**用内嵌 css**（`style.cssText` 或组件内 `<style>`），不要往 theme.css 加。

**accent 的三态用法**：`--accent` 只作**文字/边线/勾勾的强调**（如选中文字色、checkbox 勾色、下划线）；**实心 accent 色块**（发送按钮、角标、提交按钮这类"整块填 accent 色"）一律用 `--accent-fill` 做背景 + `--accent-filled-text` 做其上文字——亮色下 `--accent` 是深蓝、`--accent-fill` 是中蓝，两者分开才能保证实心块在亮暗两套都清晰，不会出现"深蓝底黑字"。别把 `--accent` 当底色配深字。

**直接用现成控件类，别手拼控件外观**：`theme.css` 内置一组 `th-` 前缀的复用类，凡是要按钮/输入框/角标/图标按钮，**优先挂这些类**（每个类都自带亮暗跟随 + 统一圆角/悬停/禁用态），而不是写一长串 `style.cssText`：

| 类 | 用途 |
|---|---|
| `th-btn` | 主按钮（主色实心填充 + hover 提亮 + `:disabled` 半透明）。例 `<button class="th-btn">发送</button>` |
| `th-btn-ghost` | 次按钮/描边按钮（透明底 + 细边 + hover 垫淡色） |
| `th-ip` | 输入框（圆角 + 边框 + `:focus` 高亮环） |
| `th-chip` / `th-chip-plain` | 角标/小徽章（主色柔和底 or 中性底） |
| `th-icon` | 图标/星标按钮（透明底 + hover 垫底），配合 `th-icon-stroke`（正常）/ `th-icon-dim`（弱）控制颜色 |
| `th-switch` | 开关（`<label class="th-switch"><input type="checkbox"><span class="th-switch-track"></span>文字</label>`） |

尺寸可用内联 `style` 微调（如 `height:30px;font-size:12px`），但**颜色/圆角/hover/禁用交给类**，不要在组件里重写。按钮想换语义色（比如"危险操作"要红色）就叠一个改 `background` 的内联或再加语义色类。

**语义色变量（成功/危险/警示），与 accent 同构、三态齐全**：
- 文字强调：`--success` / `--danger` / `--warn`
- 柔和底（选中/hover）：`--success-soft` / `--danger-soft` / `--warn-soft`
- 实心底 + 其上文字：`--success-fill`+`--success-filled-text` / `--danger-fill`+`--danger-filled-text`
- 场景：红=脏/未提交/危险（`--danger`）、黄=星标/警示（`--warn`）、绿=最新/成功（`--success`）。当前已应用到 var-editor（脏值与星标）、page-bar（最新/草稿角标）。

**层级速记变量**：`--text-strong/--text/--text-soft/--text-dim`（前景强弱）、`--bg/--bg-elevated/--panel`（底面层级）、`--border/--border-strong`（分隔线）。写组件时按"几级文本/几级底"选，不用记具体 rgba。z 轴另有三档：`--z-trigger`(400) < `--z-bar`(450) < `--z-panel`(500)，悬浮球/常数工具条/弹窗各归其位，别硬写数值。

多个全局 css 文件**叠加生效**。但**组件的局部样式不写独立 css**——一律内嵌进该组件自己的 js（`style.cssText` 或 JS 注入 `<style>`），保持"一个组件一个文件"的自包含。

### 步骤 4：编写 UI 组件（*.js）

UI 组件是固定定位的悬浮元素。模式：

- 自执行 IIFE
- 创建 DOM 元素，设置 `position: fixed` 和 z-index
- 挂载到 `#teahouse-ui-layer`（用 `window.registerUI`，勿直接 appendChild）
- 若 bootstrap 已暴露共享状态，通过 `window.Teahouse` 读写
- 需要响应导演写正文时用 `Teahouse.on("output.refresh", callback)`
- **样式内嵌 js**（`style.cssText`），**所有逻辑收敛进单文件**（不拆辅助 js）

```js
// runtime/sandbox/statusbar.js — 底栏状态条（简单组件：单文件即可）
(function() {
  var bar = document.createElement('div')
  bar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:200;display:flex;...'
  window.registerUI('statusbar', bar)
})()
```

```js
// runtime/sandbox/var-editor/var-editor.js — 组件包：文件夹 = 组件
//   数据文件在同文件夹：var-editor/important-vars.json
(function() {
  var PANEL;
  // ... 用 Teahouse.readText("runtime/sandbox/var-editor/important-vars.json")
  //     读配置，Teahouse.writeFile(...) 写回，Teahouse.setVar/getVars 读写变量
  window.registerUI('var-editor', PANEL)
})()
```

一个组件 = 一个入口 js（或一个文件夹），文件相互独立、可单独编辑替换。

### 步骤 5（可选）：编写用户输入组件

沙盒可通过 `Teahouse.send()` 发送用户消息给导演。自定义输入框、选项按钮、快捷指令参照标准件 `novel-main.js` 内联的输入条模式（`teahouse-play-mode` skill 的 `assets/novel-main.js`）；一次性初始化遮罩类组件的轻量范式可参考 example 原型的 `user-prompt.js`。

### 步骤 6：部署和迭代

#### 首次部署顺序

先创建文件，再 Write 到 `runtime/sandbox/`：

1. **novel-main.js**（小说式）：正文渲染器（最先执行，建立 _pageState 和渲染逻辑）
2. **theme.css**（可选）：全局主题样式——唯一允许的独立 css，换肤入口
3. **其余组件**：简单组件写 `*.js`；带数据的组件开同名文件夹（`组名/组名.js` + `组名/数据.json`）

#### 迭代修改

- **修改组件 → 直接 Edit `runtime/sandbox/` 下对应 js（或组件文件夹内文件）**。前端监听到 `file_changed` 后重建 iframe srcdoc（热重载）。**数据文件变更和代码变更一样会触发重建**——改组件自持的 `*.json` 后，相当于改沙盒内容，iframe 也会刷新。
- 修改正文渲染器 → iframe 全重建，DOM 状态全丢。

#### 沙盒代码整体禁用

如需临时禁用沙盒（让游玩模式退化为纯文本渲染），把 `runtime/sandbox/` 下的代码**移动到 `runtime/sandbox/disabled/`**：

```
FileOps move runtime/sandbox/novel-main.js runtime/sandbox/disabled/novel-main.js
```

`runtime/sandbox/disabled/` 内的文件渲染器**不读取**（除 `disabled/` 外均启用），故移入即从沙盒移除、但仍保留在该子目录（git 追踪、可恢复）；需要恢复时移回 `runtime/sandbox/`。只服务沙盒代码，正文楼层无此需求。

## 最佳实践

1. **语法：ES6+ 完全可用**。沙盒 iframe 直接跑在现代 WebView 上（Chromium 内核），`const`/`let`、箭头函数、模板字符串、`class`、解构、`async`/`await`、可选链 `?.`、空值合并 `??`、BigInt 等**均已实测通过**，想用就用。平台标准件（`novel-main.js` / `dm-main.js`）沿用 `var` + 普通 `function` 是**既有风格**、不是技术限制。
2. **IIFE 包裹每个文件**：避免全局变量污染
3. **组件样式内嵌 js**（`style.cssText` / JS 注入 `<style>`）：组件不写独立 css，不拆辅助 js —— 一个组件 = 一个自包含 js 文件，或一个组件包文件夹
4. **一个组件一个入口**：简单组件就一个 `foo.js`；要配数据就开同名文件夹（`foo/foo.js` + `foo/*.json`），根目录不留散文件
5. **共享状态通过 `window.Teahouse` 暴露**：标准件的 `window.Teahouse._pageState`（floors + currentIndex，见 `novel-main.js`）即此模式；自定义组件可照此挂自己的状态键（如 `window.Teahouse._myState`）
6. **跨组件通信通过事件**：自定义事件走同一套系统——`window.Teahouse._emit('myevent', data)` + `window.Teahouse.on('myevent', callback)`（`color.change` 只是命名示例，引擎无内置该事件）
7. **正文渲染靠 `listFloors()` + `readText()` + `renderRichText()`**：不要假设正文会被推送进来
8. **fixed 定位的 UI 组件用 `theme.css` 的 z 层级变量**：`--z-trigger`（悬浮球/齿轮等打开弹窗的按钮，400）< `--z-bar`（底部输入条等常驻工具条，450）< `--z-panel`（弹窗面板，500），见 `theme.css`；不要硬写自己的 z-index 数值
9. **改标准件就顺着它的风格写**：编辑 `novel-main.js` / `dm-main.js` 这类既有文件时按原风格（`var` + 普通 `function`），新写的文件随你选——但别在同一文件里两种风格交替
10. **CSS 中用 `rgba()` 而非 `oklch()`**：iframe 内没有 Tailwind 的 oklch polyfill
11. **先 Read 后 Edit**：修改现有沙盒代码前先读取当前内容
12. **ui_js 必须通过 `window.registerUI(label, element)` 挂载 UI 元素**：不要直接 `appendChild`——只有挂进 `#teahouse-ui-layer` 才落到 UI 覆盖层（层级/指针事件），且 `registerUI` 会按 label 去重（同名旧组件自动移除）并兜底排队
13. **共享状态挂载到 `window.Teahouse` 并带事件通知**：状态变更方 `_emit`，订阅方 `on`
14. **runTool 用 handle 接口，不要手动管理 tool_run**：`Teahouse.runTool(steps).then(...)` 自动完成判定；长 Generate 步骤要用 `handle.cancel()` / `Teahouse.cancelRunTool(run_uuid)` 让玩家可打断
15. **流式生成用 `draft.change` 事件，不要直接监听 `generate_progress`**：bootstrap 已集中处理

## 注意事项

- **不要创建 bootstrap.js**：bootstrap 是引擎内置的，实例 sandbox 目录下创建它会被忽略
- **修改正文渲染器触发 iframe 重建**：所有沙盒内 DOM 状态和运行时变量都会丢失
- **沙盒不直接访问后端 API**：所有请求由宿主代理。不要写 `fetch()` 或 `XMLHttpRequest`
- **iframe sandbox="allow-scripts"** 不允许 `allow-same-origin`、`allow-forms`、`allow-popups`。沙盒内无法访问 localStorage、Cookie、或宿主 DOM
- **BBCode 渲染在宿主层**：沙盒代码中不要手动解析 BBCode，调用 `Teahouse.renderRichText()`
- **文件操作有权限**：`readText` / `readAsset` / `writeFile` 受当前用户 JWT 权限限制
- **正文楼层在 `runtime/floors/`**：沙盒要渲染正文就读那里，别把正文代码放 sandbox
- **组件数据放组件文件夹，不进根目录**：`foo/foo.js` + `foo/*.json`；`.json` 不被注入，用 `writeFile`/`readText` 自读写，随 git 追踪、导出随包
- **数据文件是 `.json` 时不被当代码注入，安全**：但**别在组件文件夹放 `*.js`/`*.css` 之外的其他可执行东西**——无限深度扫描下，任何深度的 `.js`/`.css` 都会被注入进 srcdoc
- **不确定时参考标准件**：`teahouse-play-mode` skill 的 `assets/novel-main.js` 与 `assets/dm-main.js` 是平台维护的完整实现，`SkillRead` 可读全文；`prototypes/example/` 原型另有 `page-bar.js`（悬浮翻页球）、`theme-proxy.js`（主题/字号跟随）、`user-prompt.js`（一次性用户名弹窗）、`var-editor/`（变量面板，组件包范式）可作小件参考
