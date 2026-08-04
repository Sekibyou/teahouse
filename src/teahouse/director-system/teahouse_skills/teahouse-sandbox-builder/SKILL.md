---
name: teahouse-sandbox-builder
description: 教导导演如何设计和构建前端沙盒代码（bootstrap.js、场景脚本、UI 组件、CSS 主题），包括完整的沙盒 API 参考和最佳实践。当用户要求创建自定义界面、设计交互、添加 UI 组件、更改主题样式、或"给实例做前端"时触发。
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

## 沙盒架构概览

Teahouse 前端沙盒是一个通过 `<iframe sandbox="allow-scripts">` 隔离的独立运行环境。**沙盒代码是文件系统驱动的**，唯一来源是 `.teahouse/output/sandbox/` 目录。前端渲染器（SandboxManager）遍历该目录构建 srcdoc，**无需任何推送工具**——你只需 Write 文件，前端自动读取并重建 iframe。

### 文件分派规则（由文件名/扩展名决定，无 content_type 概念）

| 文件 | 注入方式 | 用途 |
|---|---|---|
| `bootstrap.js` | 最先执行（srcdoc 第一个 `<script>`） | 沙盒基础设施：事件监听、渲染循环、Teahouse API、容器创建 |
| `*.css` | 注入 iframe `<head>` 的 `<style>` | 全局样式表、主题变量 |
| 其余 `*.js` | 按文件名排序追加挂载 | UI 组件、场景脚本、交互逻辑；每个文件独立，可单独编辑 |

**正文历史不在 `.teahouse/output/sandbox/`**——它位于 `.teahouse/output/floors/`（上下文引擎专属），渲染器**不读**它；沙盒通过 `Teahouse.readFile()` 自行读取楼层文件来渲染正文。

### 子目录仅做管理归类

sandbox 下可建子目录归类（如 `ui/`、`scenes/`），但渲染规则**只按文件名/扩展名分派**，不做跨目录排除。

### 脚本执行顺序（关键陷阱）

srcdoc 中的 `<script>` 标签按出现顺序同步执行：

```
<script>bridge</script>          ← 0. 宿主内联的 postMessage 桥
<script>bootstrap.js</script>    ← 1. 先执行：注册 DOMContentLoaded 回调，暴露 window.Teahouse
<script>color-button.js</script>  ← 2. 最后执行：其余 js，此时 #teahouse-ui-layer 可能还不存在！
```

**核心问题**：`#teahouse-content` 和 `#teahouse-ui-layer` 两个容器由 bootstrap 在 `DOMContentLoaded` 回调（或 readyState 检查）中创建。但 `<script>` 标签在 `<body>` 标签内，可能在 `DOMContentLoaded` 之前就解析并执行了。

**结论**：`*.js` 必须使用 `window.registerUI()` 挂载元素，不能直接操作 `#teahouse-ui-layer`。`registerUI` 内部有排队机制——如果 UI 层还没创建，它会先把元素放入 `uiQueue`，等 `DOMContentLoaded` 触发后再 flush。

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

## 沙盒 API 完整参考

所有 API 通过 `window.Teahouse` 暴露给沙盒代码。

### 楼层（正文历史）

正文历史位于 `.teahouse/output/floors/`，按楼层数字排序。沙盒通过文件操作接口读取：

#### `Teahouse.listFloors() → Promise<FloorEntry[]>`

获取排序后的楼层清单。每个元素是 `{ num, path, draft }`：`{num}` 为楼层数字，`{path}` 为相对实例根目录的路径（如 `.teahouse/output/floors/floor-5.md`），`{draft}` 为 `true` 表示半正式稿 `floor-N-draft.md`（正式稿优先于草稿）。

```js
const floors = await Teahouse.listFloors()
const latest = floors.filter(f => f.draft)[floors.length - 1]  // 最近一个半正式稿
```

要读取某楼层正文、并经宿主渲染为 HTML：

```js
const markdown = await Teahouse.readFile(floor.path)
const html = await Teahouse.renderRichText(markdown)
container.innerHTML = html
```

### 富文本渲染

#### `Teahouse.renderRichText(text) → Promise<string>`

将正文文本交由宿主层解析为 HTML 字符串。解析在宿主层执行（BBCode → 样式着色 → Markdown），沙盒拿到 HTML 后自由组织渲染位置和方式。

```js
const markdown = await Teahouse.readFile(floor.path)
const html = await Teahouse.renderRichText(markdown)
container.innerHTML = html
```

**注意**：BBCode 标签白名单由 `teahouse-sandbox-richtext-render` skill 定义。不要假设沙盒自己能解析 BBCode。

### 文件操作

#### `Teahouse.readFile(path) → Promise<string | null>`

读取实例文件内容。path 相对于实例根目录，如 `"settings/characters.yaml"`、`".teahouse/output/floors/floor-001.md"`。

```js
const yaml = await Teahouse.readFile("settings/world.yaml")
```

#### `Teahouse.writeFile(path, content) → Promise<boolean>`

写入文件内容（覆盖式）。path 相对于实例根目录。

```js
await Teahouse.writeFile(".teahouse/output/sandbox/state.json", JSON.stringify(saveData))
```

**权限**：文件操作受 JWT 身份控制，与当前用户权限一致。沙盒可读写实例内任意路径。

### 发送消息

#### `Teahouse.send(message) → void`

模拟用户输入，触发导演回合。等价于用户在 ChatPanel 打字 + Enter。

```js
Teahouse.send("开始第一章")
```

这是沙盒与导演交互的唯一方式。用户选择选项、点击按钮等场景可用此方法驱动剧情。

### 事件监听

#### `Teahouse.on(event, callback)` / `Teahouse.off(event, callback)`

订阅/取消订阅事件。callback 接收事件 payload。

### 事件类型

| 事件 | payload | 触发时机 |
|---|---|---|
| `output.refresh` | `{ path }` | 导演写/改/移动 `.teahouse/` 下文件（含 floors、sandbox）后宿主推送 —— **沙盒应重新拉取楼层/文件并重渲染** |

宿主监听 `file_changed` SSE（导演工具调用广播），当变更路径位于 `.teahouse/` 下时向沙盒推送 `output.refresh`。沙盒借此在导演每次写正文/改代码后自动刷新。

```js
Teahouse.on("output.refresh", function(data) {
  console.log("instance files changed:", data.path)
  reloadFloors()  // 重新 listFloors + readFile + render
})
```

### UI 组件管理

#### `window.registerUI(label, element)`（bootstrap 提供）

注册一个 UI 组件到 `#teahouse-ui-layer`。如果 label 已存在，旧组件会被移除。未就绪时自动排队，就绪后挂载。

```js
var bar = document.createElement("div")
bar.id = "my-statusbar"
window.registerUI("statusbar", bar)
```

**重要**：不要直接 `getElementById('teahouse-ui-layer').appendChild()`，这会因 DOM 未就绪而静默失败。

### 容器约定

沙盒 DOM 中有两个由 bootstrap 创建的容器：

| 容器 ID | 用途 | CSS class |
|---|---|---|
| `#teahouse-content` | 主体内容区（正文、章节等） | `teahouse-content` |
| `#teahouse-ui-layer` | UI 覆盖层（fixed 定位组件） | `teahouse-ui-layer` |

`#teahouse-ui-layer` 是 `position: fixed; inset: 0; pointer-events: none; z-index: 100`，其直接子元素会设为 `pointer-events: auto`。UI 组件应作为其直接子元素，且自己设置 `position: fixed` 定位。

## SOP

### 步骤 1：了解当前沙盒状态

```
Glob .teahouse/output/sandbox/**/*     → 查看沙盒目录中的现有文件
```

确认实例是否已有沙盒代码。如果没有 `bootstrap.js`，则需要从零开始（步骤 2）；如果已有，则在其基础上增改。

### 步骤 2（仅全新沙盒）：创建 bootstrap.js

如果 `.teahouse/output/sandbox/` 目录下没有 `bootstrap.js`，需要先创建。核心职责：

1. 实现 `callHost()` — postMessage 通信层
2. 定义 `window.Teahouse` API — 暴露给所有沙盒脚本（含 `listFloors`、`readFile`、`writeFile`、`renderRichText`、`send`）
3. 监听宿主推送事件 — `output.refresh`
4. UI 组件管理 — `registerUI()`
5. 默认渲染逻辑 — `listFloors()` + `readFile()` + `renderRichText()` 按楼层渲染
6. 初始化 — 创建 `#teahouse-content` 和 `#teahouse-ui-layer` 容器，发送 `{ _type: "ready" }` 通知宿主

编写时使用普通 function 和 var（兼容旧浏览器，因为 iframe 无 transpiler）。整段代码包裹在 IIFE `(function() { ... })()` 中避免全局变量污染。

bootstrap.js 编写完成后，**直接 Write 到 `.teahouse/output/sandbox/bootstrap.js`**，前端自动重建 iframe srcdoc，沙盒重新初始化（无需任何推送）。

写完后前端会收到 `file_changed` 并重建沙盒。

### 步骤 3：编写 CSS 主题

css 文件注入 iframe `<head>` 中的 `<style>` 标签。基础模板见实例现有 `theme.css`。Write 到 `.teahouse/output/sandbox/theme.css`。

多个 css 文件**叠加生效**——写多个 `*.css`，所有样式都会注入。

### 步骤 4：编写 UI 组件（*.js）

UI 组件是固定定位的悬浮元素。模式：

- 自执行 IIFE
- 创建 DOM 元素，设置 `position: fixed` 和 z-index
- 挂载到 `#teahouse-ui-layer`（用 `window.registerUI`，勿直接 appendChild）
- 若 bootstrap 已暴露共享状态，通过 `window.Teahouse` 读写
- 需要响应导演写正文时用 `Teahouse.on("output.refresh", callback)`

```js
// .teahouse/output/sandbox/statusbar.js — 底栏状态条
(function() {
  var bar = document.createElement('div')
  bar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:200;display:flex;...'
  window.registerUI('statusbar', bar)
})()
```

多个 `*.js` 是**追加式**的，不会替换已有组件。一个文件一个组件，独立可编辑。

### 步骤 5（可选）：编写用户输入组件

沙盒可通过 `Teahouse.send()` 发送用户消息给导演。自定义输入框、选项按钮、快捷指令参照实例现有 `input-bar.js` 模式。

### 步骤 6：部署和迭代

#### 首次部署顺序

先创建文件，再 Write 到 `.teahouse/output/sandbox/`：

1. **bootstrap.js**：必须最先（前端识别 bootstrap.js 最先执行）
2. **theme.css**：主题样式
3. **其余 *.js**：UI 组件（可一次写多个）

#### 迭代修改

- **修改代码文件 → 直接 Edit `.teahouse/output/sandbox/` 下对应文件**。前端监听到 `file_changed` 后重建 iframe srcdoc。
- 修改 bootstrap.js → iframe 全重建，DOM 状态全丢。只在必须修改基础设施时动它。

#### 沙盒代码整体禁用

如需临时禁用沙盒（让游玩模式退化为纯文本渲染），把 `.teahouse/output/sandbox/` 下的代码**移动到 `.teahouse/output_disabled/`**：

```
FileOps move .teahouse/output/sandbox/bootstrap.js .teahouse/output_disabled/bootstrap.js
```

`.teahouse/output_disabled/` 无子结构，目录本身即禁用标记——渲染器**不读它**，故移入即从沙盒移除；需要恢复时移回 `.teahouse/output/sandbox/`。只服务沙盒代码，正文楼层无此需求。

## 最佳实践

1. **使用 var 和普通 function**：iframe 无 transpiler，不识别 const/let/箭头函数
2. **IIFE 包裹每个文件**：避免全局变量污染
3. **共享状态通过 `window.Teahouse` 暴露**：`window.Teahouse._colorState`、`window.Teahouse._pageState` 等
4. **跨组件通信通过事件**：`window.Teahouse._emit('color.change', data)` + `window.Teahouse.on('color.change', callback)`
5. **正文渲染靠 `listFloors()` + `readFile()` + `renderRichText()`**：不要假设正文会被推送进来
6. **fixed 定位的 UI 组件 z-index 分层次**：topbar ~200、UI 层 ~100、panel ~200、input ~300
7. **不要在沙盒内写 ES6+ 语法**：`let`、`const`、`=>`、模板字符串、async/await 都不安全（用 var + 普通 function + Promise 链）
8. **CSS 中用 `rgba()` 而非 `oklch()`**：iframe 内没有 Tailwind 的 oklch polyfill
9. **先 Read 后 Edit**：修改现有沙盒代码前先读取当前内容
10. **一个文件一个组件**：分开后更容易独立替换和迭代
11. **ui_js 必须通过 `window.registerUI(label, element)` 挂载 UI 元素**：不要直接 `appendChild`，因 DOM 未就绪会静默丢失
12. **共享状态挂载到 `window.Teahouse` 并带事件通知**：状态变更方 `_emit`，订阅方 `on`

## 注意事项

- **修改 bootstrap.js 触发 iframe 重建**：所有沙盒内 DOM 状态和运行时变量都会丢失。只在必须修改基础设施时更新它
- **沙盒不直接访问后端 API**：所有请求由宿主代理。不要写 `fetch()` 或 `XMLHttpRequest`
- **iframe sandbox="allow-scripts"** 不允许 `allow-same-origin`、`allow-forms`、`allow-popups`。沙盒内无法访问 localStorage、Cookie、或宿主 DOM
- **BBCode 渲染在宿主层**：沙盒代码中不要手动解析 BBCode，调用 `Teahouse.renderRichText()`
- **文件操作有权限**：`readFile` / `writeFile` 受当前用户 JWT 权限限制
- **正文楼层在 `.teahouse/output/floors/`**：沙盒要渲染正文就读那里，别把正文代码放 sandbox
- **不确定时参考原型模板**：prototype 自带 `.teahouse/output/sandbox/` 的实现参考
