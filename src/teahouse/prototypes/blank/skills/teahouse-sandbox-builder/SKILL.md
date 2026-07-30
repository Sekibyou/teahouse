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

Teahouse 前端沙盒是一个通过 `<iframe sandbox="allow-scripts">` 隔离的独立运行环境。所有代码和内容均由导演通过 Output 工具推送。

### content_type 六种类型

| content_type | 执行时机 | 数量 | 注入方式 | 用途 |
|---|---|---|---|---|
| `bootstrap_js` | append 后立即注入 iframe 并执行 | 全局唯一 | 嵌入 srcdoc `<script>` | 沙盒基础设施：事件监听、scene 管理、渲染循环、Teahouse API |
| `scene_js` | 由 bootstrap 调用 `activateScene` 触发（或直接嵌入 srcdoc） | 通常 1 个，replace 替换 | 嵌入 srcdoc `<script>` | 当前场景的主要展示逻辑：渲染正文、选项按钮、场景状态 |
| `ui_js` | append 后嵌入 srcdoc 执行 | 多个并存，追加式 | 嵌入 srcdoc `<script>` | 悬浮组件：状态栏、背包面板、角色卡、计数器、输入框 |
| `css` | append 后注入 iframe `<head>` | 多个并存，追加式 | 嵌入 srcdoc `<style>` | 全局样式表、主题变量 |
| `rich_text` | 沙盒通过 `Teahouse.renderRichText()` 获取 HTML，自行决定何时何地渲染 | 多个 | 不嵌入 srcdoc；通过 SSE 事件推送到沙盒 | 正文、旁白、富文本消息（默认 content_type） |
| `text` | 沙盒通过 `Teahouse.getOutputBlock()` 获取原始文本 | 多个 | 同上 | 纯文本、日志、调试输出 |

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

### 输出块

#### `Teahouse.listOutputBlocks() → Promise<OutputBlock[]>`

获取所有活跃输出块的摘要列表。返回的每个元素包含 `uuid`、`label`、`note`、`content_type`、`rendered`（可能为空字符串，取决于 SSE 推送时机）。

```js
const blocks = await Teahouse.listOutputBlocks()
const epBlocks = blocks.filter(b => /^ep\d+$/i.test(b.label))
```

#### `Teahouse.getOutputBlock(uuid) → Promise<OutputBlock>`

获取单个输出块的完整数据（含 rendered 内容）。

```js
const block = await Teahouse.getOutputBlock("some-uuid")
const html = await Teahouse.renderRichText(block.rendered)
```

### 富文本渲染

#### `Teahouse.renderRichText(text) → Promise<string>`

将 BBCode 富文本交由宿主层解析为 HTML 字符串。解析在宿主层执行（BBCode → HTML），沙盒拿到 HTML 后自由组织渲染位置和方式。

```js
const html = await Teahouse.renderRichText(block.rendered)
container.innerHTML = html
```

**注意**：`renderRichText` 在宿主层执行，BBCode 标签白名单由 `teahouse-sandbox-richtext-render` skill 定义。不要假设沙盒自己能解析 BBCode。

### 文件操作

#### `Teahouse.readFile(path) → Promise<string | null>`

读取实例文件内容。path 相对于实例根目录，如 `"settings/characters.yaml"`、`"floors/floor-001.md"`。

```js
const yaml = await Teahouse.readFile("settings/world.yaml")
```

#### `Teahouse.writeFile(path, content) → Promise<boolean>`

写入文件内容（覆盖式）。path 相对于实例根目录。

```js
await Teahouse.writeFile("sandbox/state.json", JSON.stringify(saveData))
```

**权限**：文件操作受 JWT 身份控制，与当前用户权限一致。

### 发送消息

#### `Teahouse.send(message) → void`

模拟用户输入，触发导演回合。等价于用户在 ChatPanel 打字 + Enter。

```js
Teahouse.send("开始第一章")
```

这是沙盒与导演交互的唯一方式。用户选择选项、点击按钮等场景可用此方法驱动剧情。

### 事件监听

#### `Teahouse.on(event, callback)`

订阅事件。callback 接收事件 payload。

#### `Teahouse.off(event, callback)`

取消订阅。

### 事件类型

| 事件 | payload | 触发时机 |
|---|---|---|
| `output.append` | `OutputBlock`（含 rendered） | 导演 Output(mode="append") 后 SSE 推送 |
| `output.replace` | `OutputBlock`（含 rendered） | 导演 Output(mode="replace") 后 SSE 推送 |
| `output.delete` | `{ uuid }` | 导演 Output(mode="delete") 后 SSE 推送 |

```js
Teahouse.on("output.append", function(block) {
  if (block.content_type === "rich_text" && /^ep\d+$/i.test(block.label)) {
    renderChapter(block)
  }
})

Teahouse.on("output.replace", function(block) {
  if (block.content_type === "rich_text") {
    rerenderChapter(block)
  }
})

Teahouse.on("output.delete", function(data) {
  removeChapterFromDOM(data.uuid)
})
```

### Scene 管理

#### `Teahouse.activateScene(uuid) → void`

请求宿主激活指定 scene_js 块。注意：当前实现中 scene_js 已嵌入 srcdoc，此方法主要为 forward-compatibility 保留。场景脚本应在 srcdoc 加载时自执行并调用 `registerScene()`。

#### `window.registerScene(name, component)`（bootstrap 提供）

注册当前场景组件。

```js
window.registerScene("chapter-viewer", {
  unmount: function() {
    // 清理 DOM、取消定时器等
    container.innerHTML = ""
  }
})
```

#### `window.activateScene(uuid)`（bootstrap 提供）

bootstrap 内部 scene 切换函数。卸载旧 scene，加载新 scene。

### UI 组件管理

#### `window.registerUI(label, element)`（bootstrap 提供）

注册一个 UI 组件到 `#teahouse-ui-layer`。如果 label 已存在，旧组件会被移除。

```js
var bar = document.createElement("div")
bar.id = "my-statusbar"
// ... 设置样式和内容 ...
window.registerUI("statusbar", bar)
```

### 容器约定

沙盒 DOM 中有两个由 bootstrap 创建的容器：

| 容器 ID | 用途 | CSS class |
|---|---|---|
| `#teahouse-content` | 主体内容区（正文、章节等） | `teahouse-content` |
| `#teahouse-ui-layer` | UI 覆盖层（fixed 定位组件） | `teahouse-ui-layer` |

`#teahouse-ui-layer` 是 `position: fixed; inset: 0; pointer-events: none; z-index: 100`，其直接子元素会设为 `pointer-events: auto`。这意味着 UI 组件应作为 `#teahouse-ui-layer` 的直接子元素，且需要自己设置 `position: fixed` 定位。

## SOP

### 步骤 1：了解当前沙盒状态

```
Glob sandbox/**/*                         → 查看沙盒目录中的现有文件
Read .teahouse/output-blocks.yaml         → 查看活跃输出块
```

确认实例是否已有沙盒代码。如果没有 `bootstrap.js`，则需要从零开始（步骤 2）；如果已有，则在其基础上增改。

### 步骤 2（仅全新沙盒）：创建 bootstrap.js

如果实例 `sandbox/` 目录下没有 `bootstrap.js`，需要先创建。核心职责：

1. 实现 `callHost()` — postMessage 通信层
2. 定义 `window.Teahouse` API — 暴露给所有沙盒脚本
3. 监听宿主推送事件 — `output.append` / `output.replace` / `output.delete`
4. Scene 管理 — `activateScene()`、`registerScene()`
5. UI 组件管理 — `registerUI()`
6. 默认渲染逻辑 — 获取 ep 块、调用 `renderRichText()`、渲染为气泡
7. 初始化 — 创建 `#teahouse-content` 和 `#teahouse-ui-layer` 容器，发送 `{ _type: "ready" }` 通知宿主

编写时使用普通 function 和 var（兼容旧浏览器，因为 iframe 无 transpiler）。整段代码包裹在 IIFE `(function() { ... })()` 中避免全局变量污染。

bootstrap.js 编写完成后，使用 Output 推送到前端：
```
Output(
  content: "{{sandbox/bootstrap.js}}",
  label: "ui_bootstrap",
  note: "沙盒基础设施",
  content_type: "bootstrap_js",
  mode: "append"
)
```

bootstrap_js 推送后前端会立即重建 iframe srcdoc，沙盒重新初始化。

### 步骤 3：编写 CSS 主题

css 类型的内容块注入 iframe `<head>` 中的 `<style>` 标签。基础模板：

```css
/* sandbox/theme.css */
*, *::before, *::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html, body {
  width: 100%;
  min-height: 100%;
  font-family: "Noto Serif SC", Georgia, serif;
  font-size: 16px;
  line-height: 1.8;
  color: #e5e5e5;
  background-color: #1a1a2e;
}

/* 内容容器 — max-width 居中 */
.teahouse-content {
  max-width: 720px;
  margin: 0 auto;
  padding: 2rem 1.5rem 6rem;
}

/* 气泡卡片 */
.teahouse-bubble {
  margin-bottom: 1.5rem;
  padding: 1rem 1.25rem;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 8px;
  border-left: 3px solid rgba(59, 130, 246, 0.4);
  animation: bubble-fade-in 0.4s ease-out;
}

@keyframes bubble-fade-in {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}

/* UI 层 — 覆盖整个视口，pointer-events 穿透 */
.teahouse-ui-layer {
  position: fixed;
  top: 0; right: 0; bottom: 0; left: 0;
  pointer-events: none;
  z-index: 100;
}
.teahouse-ui-layer > * {
  pointer-events: auto;
}

/* 富文本基础样式 */
.teahouse-content h1, .teahouse-content h2, .teahouse-content h3 { ... }
.teahouse-content p { ... }
.teahouse-content blockquote { ... }
.teahouse-content a { ... }
```

通过 Output 推送 css 块：
```
Output(
  content: "{{sandbox/theme.css}}",
  label: "ui_theme",
  note: "沙盒默认主题",
  content_type: "css",
  mode: "append"
)
```

CSS 块是叠加式的——推送多个 css 块，所有样式都会生效。

### 步骤 4：编写场景脚本 (scene_js)

场景脚本负责渲染主体内容（章节切换、选项按钮等）。通过 `window.registerScene()` 注册，提供 `unmount` 方法用于清理。

关键模式：
- 自执行 IIFE，在加载时完成初始化
- 注册 scene 组件，提供 unmount 钩子
- 将共享状态暴露到 `window._teahouse_*` 供 UI 组件读取

```js
// sandbox/scene.js
(function() {
  var allEps = []
  var currentIdx = -1
  var container = document.getElementById('teahouse-content')

  // 暴露状态到全局供其他组件读取
  window._teahouse_eps = []
  window._teahouse_epIdx = -1
  window._teahouse_showChapter = showChapter

  window.registerScene('chapter-viewer', { unmount: unmount })

  function loadChapters() {
    Teahouse.listOutputBlocks().then(function(blocks) {
      allEps = blocks
        .filter(function(b) { return /^ep\d+$/i.test(b.label) })
        .sort(function(a, b) {
          var na = parseInt(a.label.replace(/^ep/i, ''), 10)
          var nb = parseInt(b.label.replace(/^ep/i, ''), 10)
          return na - nb
        })
      window._teahouse_eps = allEps
      if (allEps.length > 0) showChapter(allEps[allEps.length - 1].uuid)
    })
  }

  function showChapter(uuid) {
    var ep = allEps.find(function(e) { return e.uuid === uuid })
    if (!ep) return
    currentIdx = allEps.indexOf(ep)
    window._teahouse_epIdx = currentIdx

    Teahouse.getOutputBlock(uuid).then(function(block) {
      if (!block || !block.rendered) return
      return Teahouse.renderRichText(block.rendered)
    }).then(function(html) {
      if (!html) return
      var parts = html.split('<hr>')
      container.innerHTML = ''
      parts.forEach(function(part) {
        var bubble = document.createElement('div')
        bubble.className = 'teahouse-bubble'
        bubble.innerHTML = part
        container.appendChild(bubble)
      })
    })
  }

  // 监听实时推送的新章节
  Teahouse.on('output.append', function(block) {
    if (/^ep\d+$/i.test(block.label) && block.content_type === 'rich_text') {
      var num = parseInt(block.label.replace(/^ep/i, ''), 10)
      if (!allEps.find(function(e) { return e.uuid === block.uuid })) {
        allEps.push({ uuid: block.uuid, label: block.label, note: block.note, epNum: num })
        allEps.sort(function(a, b) { return a.epNum - b.epNum })
        window._teahouse_eps = allEps
      }
      showChapter(block.uuid)
    }
  })

  function unmount() {
    if (container) container.innerHTML = ''
  }

  loadChapters()
})()
```

通过 Output 推送：
```
Output(
  content: "{{sandbox/scene.js}}",
  label: "ui_scene",
  note: "章节查看器",
  content_type: "scene_js",
  mode: "append"
)
```

### 步骤 5：编写 UI 组件 (ui_js)

UI 组件是固定定位的悬浮元素。模式：

- 自执行 IIFE
- 创建 DOM 元素，设置 `position: fixed` 和 z-index
- 挂载到 `#teahouse-ui-layer`
- 可选调用 `window.registerUI(label, element)` 注册（便于管理）
- 通过 `window._teahouse_*` 全局变量与 scene 共享状态

```js
// sandbox/statusbar.js — 底栏状态条
(function() {
  var bar = document.createElement('div')
  bar.style.cssText =
    'position:fixed;bottom:0;left:0;right:0;z-index:200;' +
    'display:flex;align-items:center;justify-content:center;gap:16px;' +
    'padding:10px 20px;' +
    'background:rgba(10,10,30,0.92);' +
    'border-top:1px solid rgba(255,255,255,0.08);'

  bar.innerHTML =
    '<button id="btn-prev">◀ 上一章</button>' +
    '<span id="chapter-info"></span>' +
    '<button id="btn-next">下一章 ▶</button>'

  var uiLayer = document.getElementById('teahouse-ui-layer')
  if (uiLayer) {
    uiLayer.appendChild(bar)
    window.registerUI('statusbar', bar)
  }

  document.getElementById('btn-prev').addEventListener('click', function() {
    var eps = window._teahouse_eps || []
    var idx = window._teahouse_epIdx
    if (idx > 0 && window._teahouse_showChapter) {
      window._teahouse_showChapter(eps[idx - 1].uuid)
    }
  })

  document.getElementById('btn-next').addEventListener('click', function() {
    var eps = window._teahouse_eps || []
    var idx = window._teahouse_epIdx
    if (idx < eps.length - 1 && window._teahouse_showChapter) {
      window._teahouse_showChapter(eps[idx + 1].uuid)
    }
  })
})()
```

通过 Output 推送：
```
Output(
  content: "{{sandbox/statusbar.js}}",
  label: "ui_statusbar",
  note: "底栏章节导航",
  content_type: "ui_js",
  mode: "append"
)
```

ui_js 是**追加式**的，不会替换已有组件。可推送多个 UI 组件，它们会共存。

### 步骤 6（可选）：编写用户输入组件

沙盒可通过 `Teahouse.send()` 发送用户消息给导演。常用于自定义输入框、选项按钮、快捷指令。

```js
// sandbox/input-bar.js
(function() {
  var inputBar = document.createElement('div')
  inputBar.style.cssText =
    'position:fixed;bottom:60px;left:50%;z-index:300;' +
    'transform:translateX(-50%);' +
    'display:flex;align-items:center;gap:8px;' +
    'padding:8px 16px;background:rgba(15,15,40,0.95);' +
    'border:1px solid rgba(255,255,255,0.1);border-radius:12px;'

  inputBar.innerHTML =
    '<input id="sandbox-input" type="text" placeholder="对导演说些什么..." style="' +
      'flex:1;background:transparent;border:none;outline:none;color:#e5e5e5;font-size:14px;">' +
    '<button id="sandbox-send">发送</button>'

  var uiLayer = document.getElementById('teahouse-ui-layer')
  if (uiLayer) {
    uiLayer.appendChild(inputBar)
    window.registerUI('sandbox-input', inputBar)
  }

  function send() {
    var input = document.getElementById('sandbox-input')
    if (!input) return
    var text = input.value.trim()
    if (!text) return
    input.value = ''
    if (window.Teahouse) window.Teahouse.send(text)
  }

  document.getElementById('sandbox-send').addEventListener('click', send)
  document.getElementById('sandbox-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') send()
  })
})()
```

### 步骤 7：部署和迭代

#### 首次部署顺序

先创建文件，再通过 Output 推送。推送顺序：

1. **bootstrap_js**：必须最先推送（或更新后立即推送），因为后续所有内容都依赖它
2. **css**：主题样式
3. **scene_js**：主体场景
4. **ui_js**：UI 组件（可以一次推送多个）
5. **rich_text**：正文内容

#### 迭代修改

- 修改代码文件 → 使用 Output mode="replace" 更新对应的输出块
- 如果修改了 bootstrap.js，需要 Output replace 对应的 bootstrap_js 块
- 如果修改了 css，Output replace 对应的 css 块
- scene_js 替换后旧场景的 unmount 会被调用，新场景加载
- ui_js 替换后在 iframe 重建后重新注入

#### label 命名规范

| 类型 | 推荐 label | 说明 |
|---|---|---|
| bootstrap_js | `ui_bootstrap` | 固定不变 |
| scene_js | `ui_scene` 或 `ui_scene_{name}` | 描述场景用途 |
| ui_js | `ui_{component}` | 如 `ui_statusbar`、`ui_menupanel`、`ui_inputbar` |
| css | `ui_theme` 或 `ui_theme_{variant}` | 如 `ui_theme`、`ui_theme_dark` |
| rich_text | `ep{N}` | 如 `ep1`、`ep2`（与 teahouse.md 约定一致） |

#### replace 模式注意事项

- 修改 bootstrap.js 后，前端重建 srcdoc，iframe 完全重新初始化——这意味着所有 DOM 状态丢失
- 修改 ui_js 或 css，前端也会重建 srcdoc（通过检测 uuid 变化）——同样会丢失 DOM 状态
- 修改 scene_js，前端重建 srcdoc（当前实现中代码块变更都会触发重建）
- 修改 rich_text 通过 replace 推送，沙盒内的 Teahouse.on("output.replace") 事件会触发，由 scene 脚本负责原地更新

如果需要在重建后保持状态，使用 `Teahouse.writeFile()` 持久化关键数据到 `sandbox/` 目录。

## 最佳实践

1. **使用 var 和普通 function**：iframe 无 transpiler，不识别 const/let/箭头函数
2. **IIFE 包裹每个文件**：避免全局变量污染
3. **共享状态通过 window 暴露**：`window._teahouse_eps`、`window._teahouse_showChapter` 等
4. **UI 组件通过轮询或全局变量感知状态变化**：因为 ui_js 和 scene_js 是独立脚本
5. **`renderRichText` 返回的 HTML 用 `<hr>` 分隔段落**：可据此切片为气泡
6. **fixed 定位的 UI 组件 z-index 分层次**：topbar ~200、UI 层 ~100、panel ~200、input ~300
7. **不要在沙盒内写 ES6+ 语法**：`let`、`const`、`=>`、模板字符串、Promise 链之外的 async/await 都不安全
8. **CSS 中用 `rgba()` 而非 `oklch()`**：iframe 内没有 Tailwind 的 oklch polyfill
9. **先 Read 后 Edit**：修改现有沙盒代码前先读取当前内容
10. **一个文件一个组件**：不要把所有 UI 写在一个文件里——分开后更容易独立替换和迭代

## 注意事项

- **bootstrap_js 推送触发 iframe 重建**：所有沙盒内 DOM 状态和运行时变量都会丢失。只在必须修改基础设施时更新它
- **沙盒不直接访问后端 API**：所有请求由宿主代理。不要写 `fetch()` 或 `XMLHttpRequest`
- **iframe sandbox="allow-scripts"** 不允许 `allow-same-origin`、`allow-forms`、`allow-popups`。沙盒内无法访问 localStorage、Cookie、或宿主 DOM
- **BBCode 渲染在宿主层**：沙盒代码中不要试图手动解析 BBCode，调用 `Teahouse.renderRichText()` 即可
- **文件操作有权限**：`readFile` / `writeFile` 受当前用户 JWT 权限限制
- **不确定时参考现有代码**：`data/lowstar/instances/222/sandbox/` 有完整的实现参考
