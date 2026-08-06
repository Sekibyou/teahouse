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

**正文历史不在 `.teahouse/output/sandbox/`**——它位于 `.teahouse/output/floors/`（上下文引擎专属），渲染器**不读**它；沙盒通过 `Teahouse.readText()` 自行读取楼层文件来渲染正文。

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
const markdown = await Teahouse.readText(floor.path)
const html = await Teahouse.renderRichText(markdown)
container.innerHTML = html
```

### 富文本渲染

#### `Teahouse.renderRichText(text) → Promise<string>`

将正文文本交由宿主层解析为 HTML 字符串。解析在宿主层执行（BBCode → 样式着色 → Markdown），沙盒拿到 HTML 后自由组织渲染位置和方式。

```js
const markdown = await Teahouse.readText(floor.path)
const html = await Teahouse.renderRichText(markdown)
container.innerHTML = html
```

**注意**：BBCode 标签白名单由 `teahouse-sandbox-richtext-render` skill 定义。不要假设沙盒自己能解析 BBCode。

### 文件操作

#### `Teahouse.readText(path) → Promise<string | null>`

读取实例文件的 **UTF-8 文本内容**。path 相对于实例根目录，如 `"settings/characters.yaml"`、`".teahouse/output/floors/floor-001.md"`。用于正文、设定、配置等文本文件；**二进制资源（图片/音频/字体）不在此列，用 `readAsset`**。

```js
const yaml = await Teahouse.readText("settings/world.yaml")
```

#### `Teahouse.readAsset(path) → Promise<string | null>`

读取实例内的**二进制资源**（图片 / GIF / 音频 / 字体等），返回**可直接用作 `src` 的 data URL**（如 `data:image/png;base64,....`）。path 相对于实例根目录，如 `"assets/bg.png"`、`"assets/theme.woff2"`。

```js
// 图片
const bg = await Teahouse.readAsset("assets/bg.png")
img.src = bg

// 字体（@font-face 动态注入）
const font = await Teahouse.readAsset("assets/px.woff2")
var face = document.createElement('style')
face.textContent = "@font-face{font-family:'px';src:url(" + font + ");}"
document.head.appendChild(face)

// 音频
var audio = new Audio(await Teahouse.readAsset("assets/bgm.mp3"))
```

MIME 后端按文件头（magic bytes）探测，任何文件类型都接受，无需按扩展名约定。
**体积引导**：资产经 base64（约放大 4/3）经 postMessage 传进 iframe 再入 DOM，单文件建议控制在 **10MB 以内**（图片、BGM 都够用）。超大资产会拖慢沙盒渲染甚至卡顿——搭建前**主动提醒用户压缩/分包**，不要自行塞大资源。（后端不设硬门槛，这是创作侧约定。）

#### `Teahouse.writeFile(path, content) → Promise<boolean>`

写入文件内容（覆盖式）。path 相对于实例根目录。

```js
await Teahouse.writeFile(".teahouse/output/sandbox/state.json", JSON.stringify(saveData))
```

**权限**：文件操作受 JWT 身份控制，与当前用户权限一致。沙盒可读写实例内任意路径。

### 沙盒变量

#### `Teahouse.setVar(updates) → Promise<{name,value}[]>`

原子合并写入实例变量，落盘到 `.teahouse/runtime_vars.jsonl`（**文件即状态**，进 git，导演中断时仍能恢复）。`updates` 为 `{key: value}` 对象，值为任意 JSON 可序列化对象（标量/嵌套皆可）。返回**写后全部变量** `[{name, value, note?, change_log?}]`。也支持元数据/删除：`Teahouse.setVar(updates, {note?, change_log?, delete?})`——`note` 覆盖该变量备注、`change_log` 追加一条历史笔记、`delete` 删名。

```js
await Teahouse.setVar({
  user_name: "LowStar",
  opt_3_1: "opt2"          // 记录玩家在选项块的选择
})
```

**写者约定**：变量是**沙盒与导演共享**的（沙盒 `setVar` 写、导演 `SetRuntimeVar` 工具写，落盘同一文件），用于记录"高度精炼的剧情数值 + 界面临时状态"。判断何时该用变量：**频繁变动、追求极短、供程序使用**（金币、选项选择）；较长的文字状态属于 `settings/` 设定，沙盒用 `writeFile` 维护，但注意**不要用 `writeFile` 写正文楼层**（有并发/精确性风险）。沙盒要推进剧情就走 `Teahouse.send()` 告知导演。

#### `Teahouse.getVars(names) → Promise<{name,value}[]>`

按名读取沙盒变量。`names` 为变量名数组，不传则读全部。用于沙盒内重新渲染（如点击后回显选中态、把 `${user}` 替换为实际值）。

```js
const [user] = await Teahouse.getVars(["user_name"])
// => [{ name: "user_name", value: "LowStar" }]
```

> **🚨 空值 / 缺值语义（最容易写错的地方）**
>
> **你请求的每个名字都会出现在返回数组里；未初始化的名字 `value` 为 `null`。** 变量文件 `.teahouse/runtime_vars.jsonl` 不存在、或某个变量从未写入，效果完全一样——对应条目返回 `{name, value: null}`。
>
> **只在你明确传入 `names` 时才保证"每个名字都有"**；不传 `names`（读全部）时，未初始化的变量根本不在，返回的都是已存在的：
>
> ```js
> // 假定只写过 name1="陆霜"：
> getVars(["name1","name2"])       // => [{name:"name1",value:"陆霜"},{name:"name2",value:null}]
> getVars()                        // => [{name:"name1",value:"陆霜"}]   // 读全部，只有已存在
> ```
>
> **因此代码用 `value === null` 判断"未初始化"**，给出回退，不要用 `undefined` 判断（`null` 是稳定值；`undefined` 只在 JSON 序列化边界才出现）。参考范式：
>
> ```js
> function resolveNames(markdown) {
>   return Teahouse.getVars(["name1","name2"]).then(function(entries) {
>     var valueMap = {};
>     for (var i = 0; i < entries.length; i++) valueMap[entries[i].name] = entries[i].value;
>     return markdown.replace(/\{\{name(\d+)\}\}/g, function(full, num) {
>       var val = valueMap['name' + num];
>       return (val !== null && val !== '' && val !== undefined)
>         ? val
>         : '未命名';          // 未初始化/空 → 回退
>     });
>   });
> }
> ```
>
> 同理，`setVar` 的返回是"写后全部变量"，也可用它做 `getVars` 的镜像缓存。

#### 变量字面量替换：`Teahouse.replacePlaceholders(text?)`

沙盒默认**不自动**把正文里的 `${name}` 字面量替换为变量值（渲染层须接触原始正文、且要留机会做特效特写，如 `${user_name}` → 正则 → `[rainbow]LowStar[/rainbow]`）。需要统一替换时手动调用：

```js
// 传 text：只替换这段文本里的 ${name}；返回值是替换后的文本
Teahouse.replacePlaceholders("你好，${user_name}").then(rendered => ...)

// 不传 text：对整页正文做一次兜底替换（默认 bootstrap 里已调用，可自行关掉）
Teahouse.replacePlaceholders()
```

替换是固定字符串替换，仅当某值想"全篇统一变成字面值"时用；要做灵活特效，直接在已替换的文本上做正则特写更灵活。

#### 导演侧读写：`GetRuntimeVars` / `SetRuntimeVar`

导演**既能读也能写**变量（`GetRuntimeVars` 读、`SetRuntimeVar` 写，走同一 `.teahouse/runtime_vars.jsonl`）。沙盒选择类状态（如 `opt-3-1: opt2`）常作为"文件即状态 + 中断可恢复"的关键：用户点击选项→ `setVar` 即时落盘 → `send()` 通知导演 → 导演 `GetRuntimeVars` 读取续写。即便导演中途中断，变量已落盘，重启后仍可找回。核心变量会注入导演系统提示词（no cache），导演通常无需额外读取。

### 发送消息

#### `Teahouse.send(message) → void`

模拟用户输入，触发导演回合。等价于用户在 ChatPanel 打字 + Enter。

```js
Teahouse.send("开始第一章")
```

这是沙盒与导演交互的唯一方式。用户选择选项、点击按钮等场景可用此方法驱动剧情。

### 内联工具流水线：`Teahouse.runTool`

#### runTool(steps) → Promise<{ok, accepted, run_uuid, steps}>

依次执行一段**内联工具调用数组**（`[{tool, args}, ...]`），走**低延迟、确定的批量路径**，**不经过导演 LLM**。适合开场预设、回合推进、选项点击后的确定性流程：数组内各步（写文件、Generate 产正文、FileOps、GitCommit）由后端直接按序执行。

`steps` 元素形如 `{tool: "Write", args: {...}}`，与导演同名工具一致（同一 `execute_tool` 通道）。**不解析任何占位符**：需要运行时变量时，先用 `getVars()` 取到真实 js 值并在组装 `args` 时拼接，不要指望沙盒侧 `${{...}}` 占位符解析。

**即发即返（fire-and-forget）**：本调用**只确认后端已受理**，立即返回 `{ok, accepted, run_uuid, steps}`，**不阻塞等待执行结果**。因为内联流水线里的 `Generate` 等步骤可能跑几十秒（调正文模型），同步等待会撞上前端 fetch 超时。各步骤在**后台串行执行**，**每完成一步广播一条 `tool_run` 事件**。产出落地后另有 `file_changed` SSE 驱动 `output.refresh` 刷新楼层/沙盒。

**完成判定（关键）**：`run_uuid` 唯一标识"这一批调用"。沙盒组件应订阅 `tool_run` 事件，**按 `run_uuid` 筛选出本批、数 `index` 判定完成/失败**——任一步 `ok:false` 即整批失败（后端失败即停）；`index` 收齐到 `steps` 总数即整批完成。`run_uuid` 用于隔离同一沙盒里多个组件、甚至多个实例并发跑批。

**创作重点**：runTool 把"流程"收进按钮对应的 js 里——脚本与触发器不分家，路径/命名不再隐形耦合。每步自带全部所需参数（路径、内容、generate 用的 yaml 源等），不依赖导演拍板。`Generate` 步可指定正文产出，`GitCommit` 步可落盘提交。

```js
// 开场流水线：产第一楼 + 提交（newest_floor 用 js 运行时取值）
const vs = await Teahouse.getVars()
const floor = vs.newest_floor ?? "1"

// 订阅本批结果
const onRun = (data) => {
  if (data.run_uuid !== res.run_uuid) return   // 只认本批
  if (!data.ok) { console.error("流水线停在", data.index, data.result); return }
  if (data.index >= res.steps) { console.log("全部完成"); reloadFloors() }
}
Teahouse.on("tool_run", onRun)

const res = await Teahouse.runTool([
  { tool: "Generate", args: { source_file: "temp/opening.yaml",
                              path: `.teahouse/output/floors/floor-${floor}-draft.md` }},
  { tool: "GitCommit", args: { message: `floor-${floor}: 开场` } },
])
if (!res.ok) { console.error("提交失败", res) }
```

与 `Teahouse.send()` 的分工：**要走导演的即兴创意/总结/润色 → `send()`**；**要走确定的批量流程（开场、选项后推进、git 提交）→ `runTool()`**。

### 事件监听

#### `Teahouse.on(event, callback)` / `Teahouse.off(event, callback)`

订阅/取消订阅事件。callback 接收事件 payload。

### 事件类型

| 事件 | payload | 触发时机 |
|---|---|---|
| `output.refresh` | `{ path }` | 导演写/改/移动 `.teahouse/` 下文件（含 floors、sandbox）后宿主推送 —— **沙盒应重新拉取楼层/文件并重渲染** |
| `tool_run` | `{ run_uuid, index, tool, result, ok, instance_id }` | `runTool` 后台任务每完成一个步骤广播一条（含成败）—— 组件按 `run_uuid` 筛选、数 `index` 判定整批完成/失败 |
| `generate_progress` | `{ run_uuid, path, accumulated_len, accumulated_text, done, instance_id }` | `Generate` 流式每 ~200ms 广播一条；`accumulated_text` 是**当前完整文本**（非 diff），前端直接覆盖缓冲渲染（幂等，不怕乱序/漏条）；`done:false` 表示生成中，`done:true` 表示已结束落盘 — 组件用它做"生成中"缓冲渲染 |

宿主监听 `file_changed` SSE（导演工具调用广播），当变更路径位于 `.teahouse/` 下时向沙盒推送 `output.refresh`。沙盒借此在导演每次写正文/改代码后自动刷新。

`tool_run` / `generate_progress` 走同一条桥（宿主把后端对应 SSE 透传给沙盒），**不需要沙盒自己连 SSE**。用于 `runTool` 即发即返 + `Generate` 流式的批内反馈，见上文 runTool 章节。

**Generate 流式（档1）**：生成进行中**不落盘**，仅每 ~200ms 广播 `generate_progress`（携带 `run_uuid`、`path`、`accumulated_text` 当前全文）。**结束/中断/报错才一次性落盘 + 广播 `file_changed`**。组件据此：
- 开始 generate（`runTool` 首响应拿到 `run_uuid`）→ 建"生成中"缓冲，按 `run_uuid`+`path` 绑定，用 `accumulated_text` 覆盖渲染（标题标"生成中"）
- 结束判定用 **And**：同 `run_uuid` 的 `tool_run`（完成/失败）+ 同 `path` 的 `file_changed` 都到，才判定真正结束 → 读文件刷新（只改文字不重渲染）
- 中间态仅在内存，重启/退出后干净；重开时自动回退到"读文件渲染"（半成品或完整草稿）

```js
Teahouse.on("output.refresh", function(data) {
  console.log("instance files changed:", data.path)
  reloadFloors()  // 重新 listFloors + readText + render
})

// 生成中缓冲：accumulated_text 是当前全文，直接覆盖渲染（幂等）；
// 结束以 file_changed/tool_run 双确认后切到文件渲染
Teahouse.on("generate_progress", function(data) {
  if (data.run_uuid !== pendingBuffer.run_uuid) return
  pendingBuffer.text = data.accumulated_text   // 覆盖，而非追加
  renderPendingBuffer()                        // 标题"第 N 章（生成中）"
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
2. 定义 `window.Teahouse` API — 暴露给所有沙盒脚本（含 `listFloors`、`readText`、`readAsset`、`writeFile`、`setVar`、`getVars`、`renderRichText`、`send`、`runTool`）
3. 监听宿主推送事件 — `output.refresh`
4. UI 组件管理 — `registerUI()`
5. 默认渲染逻辑 — `listFloors()` + `readText()` + `renderRichText()` 按楼层渲染
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
5. **正文渲染靠 `listFloors()` + `readText()` + `renderRichText()`**：不要假设正文会被推送进来
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
- **文件操作有权限**：`readText` / `readAsset` / `writeFile` 受当前用户 JWT 权限限制
- **正文楼层在 `.teahouse/output/floors/`**：沙盒要渲染正文就读那里，别把正文代码放 sandbox
- **不确定时参考原型模板**：prototype 自带 `.teahouse/output/sandbox/` 的实现参考
