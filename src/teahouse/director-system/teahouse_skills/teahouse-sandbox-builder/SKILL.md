---
name: teahouse-sandbox-builder
description: 教导导演如何设计和构建前端沙盒代码（UI 组件、场景脚本、CSS 主题），包括完整的沙盒 API 参考和最佳实践。**基础层 bootstrap.js 由平台在组装 iframe 时自动注入，不在 sandbox 文件夹里**——导演只需编写实例 `runtime/sandbox/` 下的 `*.js` / `*.css` 组件，不要创建 bootstrap.js。当用户要求创建自定义界面、设计交互、添加 UI 组件、更改主题样式、或"给实例做前端"时触发。
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

Teahouse 前端沙盒是一个通过 `<iframe sandbox="allow-scripts">` 隔离的独立运行环境。沙盒分为两层：

- **基础设施层（引擎内置，不出现于实例）**：`bootstrap.js` — postMessage 通信桥、Teahouse API、runTool 封装、流式草稿管理、事件系统、UI 组件管理、DOM 容器创建。由引擎提供，随引擎升级自动更新。
- **UI 组件层（实例 `runtime/sandbox/`）**：用户的组件文件 — 正文渲染器、翻页器、变量面板、生成按钮、主题样式等。热重载热插拔，写文件即生效。

**沙盒代码是文件系统驱动的**，UI 组件唯一来源是 `runtime/sandbox/` 目录。前端渲染器（SandboxManager）遍历该目录构建 srcdoc，**无需任何推送工具**——你只需 Write 文件，前端自动读取并重建 iframe。

### 沙盒目录结构 —— 一个组件 = 一个文件，或一个文件夹

`runtime/sandbox/` **根目录只允许两类条目，每个组件一份，不留多余文件**：

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

**正文历史不在 `runtime/sandbox/`**——它位于 `runtime/floors/`。沙盒通过 `Teahouse.readText()` 自行读取楼层文件来渲染正文。

### 注入规则（由文件名/扩展名决定，无 content_type 概念）

**无限深度扫描 `.js` / `.css`**：不论在根目录还是任意深度的子文件夹，`*.js` 都追加挂载、`*.css` 都注入 `<head>`，不做跨目录排除。`.json` / `.md` / `.txt` 等数据文件**不被当代码注入**，仅作为文件存在（组件用 `readText` 自行读取）。

### 脚本执行顺序

srcdoc 中的 `<script>` 标签按出现顺序同步执行：

```
<script>引擎内置 bootstrap.js</script>   ← 0. 基础设施：注册 DOMContentLoaded 回调，暴露 window.Teahouse
<script>bridge</script>                  ← 1. 宿主内联的 postMessage 事件桥
<script>用户 UI 组件 *.js</script>       ← 2. 按文件名排序：正文渲染器、翻页器、按钮等
```

**核心要点**：`#teahouse-content` 和 `#teahouse-ui-layer` 两个容器由引擎内置的 bootstrap 在 `DOMContentLoaded` 回调（或 readyState 检查）中创建。用户 `*.js` 应使用 `window.registerUI()` 挂载 fixed 定位元素，`registerUI` 内部有排队机制——如果 UI 层还没创建，它会先把元素放入 `uiQueue`，等容器就绪后再 flush。

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

正文历史位于 `runtime/floors/`，按楼层数字排序。沙盒通过文件操作接口读取：

#### `Teahouse.listFloors() → Promise<FloorEntry[]>`

获取排序后的楼层清单。每个元素是 `{ num, path, draft }`：`{num}` 为楼层数字，`{path}` 为相对实例根目录的路径（如 `runtime/floors/floor-5.md`），`{draft}` 为 `true` 表示半正式稿 `floor-N-draft.md`（正式稿优先于草稿）。

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

读取实例文件的 **UTF-8 文本内容**。path 相对于实例根目录，如 `"settings/static_settings/world.yaml"`、`runtime/floors/floor-001.md`。用于正文、设定、配置等文本文件；**二进制资源（图片/音频/字体）不在此列，用 `readAsset`**。

```js
const yaml = await Teahouse.readText("settings/static_settings/world.yaml")
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
// 组件包方式：数据写入组件自己的文件夹，写在 .json 上（不被注入、随 git 追踪）
await Teahouse.writeFile("runtime/sandbox/var-editor/important-vars.json",
                         JSON.stringify({ important: ["金币", "修为"] }))
// 读取：
const prefs = JSON.parse(await Teahouse.readText("runtime/sandbox/var-editor/important-vars.json"))
```

**权限**：文件操作受 JWT 身份控制，与当前用户权限一致。沙盒可读写实例内任意路径。

### 沙盒变量

#### `Teahouse.setVar(updates) → Promise<{name,value}[]>`

原子合并写入实例变量，落盘到 `runtime/runtime_vars.jsonl`（**文件即状态**，进 git，导演中断时仍能恢复）。`updates` 为 `{key: value}` 对象，值为任意 JSON 可序列化对象（标量/嵌套皆可）。返回**写后全部变量** `[{name, value, note?, change_log?}]`。也支持元数据/删除：`Teahouse.setVar(updates, {note?, change_log?, delete?})`——`note` 覆盖该变量备注、`change_log` 追加一条历史笔记、`delete` 删名。

```js
await Teahouse.setVar({
  user_name: "LowStar",
  opt_3_1: "opt2"          // 记录玩家在选项块的选择
})
```

**写者约定**：变量是**沙盒与导演共享**的（沙盒 `setVar` 写、导演 `SetRuntimeVar` 工具写，落盘同一文件），用于记录"高度精炼的剧情数值 + 界面临时状态"。判断何时该用变量：**频繁变动、追求极短、供程序使用**（金币、选项选择）；较长的文字状态属于 `settings/dyn_settings/` 动态设定，沙盒用 `writeFile` 维护，但注意**不要用 `writeFile` 写正文楼层**（有并发/精确性风险）。沙盒要推进剧情就走 `Teahouse.send()` 告知导演。

#### `Teahouse.getVars(names) → Promise<{name,value}[]>`

按名读取沙盒变量。`names` 为变量名数组，不传则读全部。用于沙盒内重新渲染（如点击后回显选中态、把 `${user}` 替换为实际值）。

```js
const [user] = await Teahouse.getVars(["user_name"])
// => [{ name: "user_name", value: "LowStar" }]
```

> **🚨 空值 / 缺值语义（最容易写错的地方）**
>
> **你请求的每个名字都会出现在返回数组里；未初始化的名字 `value` 为 `null`。** 变量文件 `runtime/runtime_vars.jsonl` 不存在、或某个变量从未写入，效果完全一样——对应条目返回 `{name, value: null}`。
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

导演**既能读也能写**变量（`GetRuntimeVars` 读、`SetRuntimeVar` 写，走同一 `runtime/runtime_vars.jsonl`）。沙盒选择类状态（如 `opt-3-1: opt2`）常作为"文件即状态 + 中断可恢复"的关键：用户点击选项→ `setVar` 即时落盘 → `send()` 通知导演 → 导演 `GetRuntimeVars` 读取续写。即便导演中途中断，变量已落盘，重启后仍可找回。核心变量会注入导演系统提示词（no cache），导演通常无需额外读取。

### 发送消息

#### `Teahouse.send(message) → void`

模拟用户输入，触发导演回合。等价于用户在 ChatPanel 打字 + Enter。

```js
Teahouse.send("开始第一章")
```

这是沙盒与导演交互的唯一方式。用户选择选项、点击按钮等场景可用此方法驱动剧情。

#### `Teahouse.openDirector() → void`

**唤起导演栏**：当导演栏被折叠/隐藏（比如玩家全屏游玩、或导演面板被收起）时，请求宿主把导演栏打开。**纯前端信号，不触发生成、不发送任何消息**——只负责把导演栏展开到可见，玩家可看到场景并/或与导演沟通。

```js
// 需要找导演开子会话/沟通前，先把导演栏唤起，让玩家能看到舞台
Teahouse.openDirector()
```

**典型场景**：沙盒某项功能需要调用子会话（`sessionCreate`/`sessionSend`）或与导演对上话，而玩家正全屏游玩、导演栏被折叠。此时在调用子会话或 `send()` **之前**先 `openDirector()`，确保导演栏展开、玩家能看到导演的过程与思考，也能直接打字介入。若导演栏本来就展开着，此调用是空操作（无副作用），可放心调用。

### 内联工具流水线：`Teahouse.runTool`

#### runTool(steps) → handle (可取消的 thenable)

依次执行一段**内联工具调用数组**（`[{tool, args}, ...]`），走**低延迟、确定的批量路径**，**不经过导演 LLM**。适合开场预设、回合推进、选项点击后的确定性流程：数组内各步（写文件、Generate 产正文、FileOps、GitCommit）由后端直接按序执行。

`steps` 元素形如 `{tool: "Write", args: {...}}`，与导演同名工具一致（同一 `execute_tool` 通道）。**不解析任何占位符**：需要运行时变量时，先用 `getVars()` 取到真实 js 值并在组装 `args` 时拼接，不要指望沙盒侧 `${{...}}` 占位符解析。

**返回一个可取消的 thenable handle**：bootstrap 内部自动管理 `run_uuid` 登记、`tool_run` 事件分拣、完成判定。handle **带 `.then` 可直接 `await`**，同时暴露两个成员：

- `.run_uuid` — 受理后即填充的本批 UUID，可用来主动打断
- `.cancel()` — 中途打断本批（等效 `Teahouse.cancelRunTool(run_uuid)`）

handle 的 Promise 语义：**在整批完成或失败时 resolve/reject**，UI 无需手动管理 pendingRuns 或订阅 tool_run 事件。

- 成功：`{ok: true, results: [{tool, result, ok}, ...]}` — results 数组按步骤顺序排列
- 失败：Promise reject，错误信息包含失败步骤和原因
- 被打断：`cancel()` 后 reject（`runTool 已取消：<run_uuid>`），**不会等 5 分钟超时**
- 超时保护：5 分钟无响应自动 reject

**中途取消（长 Generate 步骤）**：`runTool` 里若带 `{tool: "Generate", ...}` 这类可能跑很久的步骤，可让玩家随时打断。**已生成的部分会落盘为半成品供续写**（semantics 与"流中失败/中断"一致——`cancel()` 打断的 Generate 会把已累积正文写入目标 path，`-draft.md` 这类即可续写），只是整批 `runTool` 的 handle 会 reject。两种等价写法：

```js
// 方式 A：用 handle.cancel()，先在回调里暂存 handle
var h = Teahouse.runTool([{ tool: "Generate", args: {...} }]);
window.__abortGen = function() { h.cancel(); };   // 某按钮/时机调用

// 方式 B：用 Teahouse.cancelRunTool(run_uuid) 显式传 uuid
Teahouse.cancelRunTool(h.run_uuid);
```

```js
// 开场流水线：产第一楼 + 提交
var floorNum = 1;

Teahouse.runTool([
  { tool: "Generate", args: { source_file: "temp/opening.yaml",
                              path: "runtime/floors/floor-" + floorNum + "-draft.md" }},
  { tool: "GitCommit", args: { message: "floor-" + floorNum + ": 开场" } },
]).then(function(result) {
  console.log("流水线完成", result.results);
}).catch(function(err) {
  console.error("流水线失败", err);
});
```

与 `Teahouse.send()` 的分工：**要走导演的即兴创意/总结/润色 → `send()`**；**要走确定的批量流程（开场、选项后推进、git 提交）→ `runTool()`**。

**🚫 runTool 禁止用于子会话**：`runTool` 走的是"确定批量执行"通道，**不经过导演 LLM**，天然没有"派发一个独立 agent 干活"的能力。因此**禁止用 runTool 创建、管理、删除子会话**（`StartSubSession` / `SendToSubSession` / `DeleteSubSession` 这三个导演工具在 runTool 里不提供对应语义）。创建和管理子会话一律用 **`Teahouse.sessionCreate` / `sessionSend` / `sessionDestroy`** API（见下一节"子会话"）。对照表：

| 需求 | 用 runTool ❌ | 用 Teahouse 子会话 API ✅ |
|---|---|---|
| 想跑一组确定的批处理（开场、选项推进、git 提交、按顺序 Write/Generate） | ✅ 可以，本意就是干这个 | 不必 —— 无谓开一个 agent 太浪费 |
| 想委派一个**独立 agent** 去做一次性任务（总结、改设定、探索某设定、批量润色） | ❌ runTool 不经过 LLM，给不了独立 agent | `sessionCreate` 建号 → `sessionSend` 投任务 → 等 `session_done` → `sessionDestroy` |
| 给子会话设工具权限 | ❌ | `sessionCreate({ enabled_tools: [...] })` |
| 向子会话追加指令 / 催办 | ❌ | `sessionSend(sid, message)` |
| 得知子会话做完了 | ❌ | 订阅 `Teahouse.on("session_done", fn)` |
| 回收 / 强停子会话 | ❌ | `sessionDestroy(sid, abort?)` |

一句话：**runTool 是"我自己按计划连做几步"，子会话是"我开一个 agent 替我想/做"**——两者分工别混。子会话相关操作只走 `Teahouse.session*` API。

### 转正：`Teahouse.commitDraft(N)` / 回档：`Teahouse.gitDiscard()`（v2 新增）

草稿 `floor-N-draft.md` 转正为正式稿 `floor-N.md` **不再由导演 `FileOps move` + `GitCommit`**，改由沙盒调用 `commitDraft` 一次性完成（正文末尾可能带 `<!-- teahouse-vars: [...] -->` 变量操作块，见「正文变量块」）。

#### `Teahouse.commitDraft(N) → Promise<{ok, data|error}>`

把「解析 teahouse-vars → 应用变量 → 剥离块记入 floor-N-meta.json → 改名 → git 提交」绑定为一个**单向闸门**（请求-响应语义，失败 reject）。`data`：

```js
{ num, title, commit_hash,
  applied: [{type, name, value?, index?, applied_value?}],  // 本次消费的操作
  failed:  [{type, name, value?, index?, error}],           // 解析失败的操作（error 含原因）
  committed_draft: bool,    // true=本次新转正；false=幂等/二次补解析
  commit_warning?: string }
```

分支语义：
- `floor-N-draft.md` 存在 → 正常转正（consumed_draft=true）；同时应用正文里的变量块，成功/失败的都带 `msg`（`consumed` / `error:…`）并记入 `floor-N-meta.json`，正文剥离为纯 prose，一并提交。
- `floor-N.md` 已存在但还有**未带 msg 的裸 action** → 二次补解析（`committed_draft=false`，git type=other「正文变量维护」），把新裸 action 再解析一遍，并入该楼的 `floor-N-meta.json`。
- 已全部消费 → 幂等返回（不动正文/git）。

判断「是否有失败」用 `data.failed.length > 0`；沙盒据此决定是否引导导演人工修正失败的 action 后**再次 commitDraft** 补解析。

**适用**：A 按钮（确认草稿可用）/ input-bar 三态的 `AWAIT_COMMIT`。**不是** runTool 的多步工具数组——它是宿主编排的确定性闸门，沙盒只发一个请求。

#### `Teahouse.gitDiscard() → Promise<{ok, data|error}>`

**重写 = 回档**：git 丢弃所有未提交改动（`git checkout -- .` + `git clean -fd`，连 untracked 的 `floor-N-draft.md` 一并清除）。B 按钮用于"这版草稿不满意，回到上一正式稿状态重新生成"。

> 注意：`commitDraft` / `gitDiscard` 走宿主 `SandboxManager` 桥（`callHost`），非 runTool。它们不经过导演 LLM，无法由导演工具集触发——由沙盒 UI 按钮调用。

### 子会话（sub-session）— 一次性导演子任务

适合：一次性的总结、改设定、探索某设定、批量润色。子会话**独立上下文、受限工具**,干完可销毁,**不污染主会话历史**——搭建造型阶段测试子任务不会误伤正在进行的搭建主对话。导演自己也可在子会话里开子 agent 探索。

**沙盒建子会话 ≠ 导演 `StartSubSession`**：沙盒的 `sessionCreate` 只**开一个空档**给你手动操作——它不传任务、不记录调用方、也不自动唤醒你。所以沙盒侧的"自动化委派"必须自己走完三步：**①建号拿 sid → ②注入任务 + 订阅完成信号 → ③等信号处理收尾**。切记子会话完成后**不会通知到沙盒**，靠的是你订阅的 `session_done` 事件——不要假设它自己会回来找你。

```js
var sid;

// ① 创建子会话 + 设立权限,拿到 sid
//   enabled_tools 未给 = 默认只读基础集(Read/Glob/Grep/SkillRead/GetRuntimeVars/GitLog/GitDiff/GitStatus/Report/EndSession);
//   按任务放开权限,例如允许改变量/写 temp 草稿/生成正文:
Teahouse.sessionCreate({
  enabled_tools: ["Read", "Glob", "Grep", "GetRuntimeVars", "SetRuntimeVar", "Report", "Generate", "EndSession"]
}).then(function(created) {
  // 注意：返回统一为 {ok, data|error}（与 readText 等一致）。成功用 created.ok 判断，
  //       session_id 在 created.data.session_id。
  if (!created.ok) throw new Error(created.error)
  sid = created.data.session_id
  startTask();          // ② 号建好才注入任务,别在拿到 sid 前发
  listenDone();         // ③ 同时挂上完成信号监听
})

// ② 注入任务文字(投进子会话后台循环即开跑);用户可在导演栏切到该会话看思考/工具过程,也能直接打字介入
function startTask() {
  Teahouse.sessionSend(sid, "把第 3~5 章总结为《宗门势力》设定,结论写入 Report temp/summary-1.md,完成后用 EndSession")
}

// ③ 等待完成信号以对接 —— 子会话导演调 EndSession 后触发(只发信号、不销毁会话)
function listenDone() {
  Teahouse.on("session_done", function(data) {
    if (data.session_id !== sid) return
    Teahouse.sessionDestroy(sid);  // 干完回收;若 mid-run 想强停,传 true
    // 对接产出:Read 子会话 report 用,或重新拉楼层(它若 Generate 了正文,output.refresh 会推)
  })
}
```

**等待期间不要傻等**：装完"建 → 送 → 挂"之后立即放回控制权,别在 `session_done` 到达前做会与之冲突的事；若子会话产出了正文/文件,宿主会照常推 `output.refresh`,沙盒据此重渲染即可。

API（调用一律返回统一的 `{ok, data|error}` —— 用 `res.ok` 判成败、`res.error` 取错误理由）：
- `Teahouse.sessionCreate(opts)` → `Promise<{ok, data:{session_id, enabled_tools}, error?}>`,`opts.enabled_tools` 可选(未给=只读基础集:Read/Glob/Grep/SkillRead/GetRuntimeVars/GitLog/GitDiff/GitStatus/Report/EndSession)。只建号、不投任务;成功同步落盘 meta,**创建后即可立即 `sessionSend`,无需等就绪**。
- `Teahouse.sessionSend(session_id, message)` → `Promise<{ok, data:true, error?}>`,把消息补发给指定子会话(等价于向该会话发一条 user 消息,但隔离上下文);任务与追加指令都走它。
- `Teahouse.sessionDestroy(session_id, abort?)` → `Promise<{ok, data:true, error?}>`,销毁子会话文件;`abort=true` 额外中止该会话进行中的生成。回收要你主动调,`session_done` 不会销毁。
- 事件:`Teahouse.on('session_done', fn)` / `Teahouse.on('session_destroyed', fn)`。**注意**:`sessionSend` 成功时返回的是 `{ok:true, data:true}`,不是 `true` 裸布尔——沙盒侧务必用 `res.ok` 判断,不要写 `res === true` 或 `res.ok === undefined` 这类旧假设。

**权限**:子会话只能调用其 `enabled_tools` 列表里的工具,默认禁止一切写正式区(floors/、`settings/dyn_settings/` 等)。想产出玩家可见正文/正式设定时,由具备写权限的主会话或沙盒落到正确目录。子会话拿到的探索结论用 `Report` 写 `temp/*.md`(`temp/` 不纳入 git 版本控制,安全)。

### 事件监听

#### `Teahouse.on(event, callback)` / `Teahouse.off(event, callback)`

订阅/取消订阅事件。callback 接收事件 payload。

### 事件类型

| 事件 | payload | 触发时机 |
|---|---|---|
| `output.refresh` | `{ path }` | 导演写/改/移动 `runtime/` 下文件（含 floors、sandbox）后宿主推送 —— **沙盒应重新拉取楼层/文件并重渲染** |
| `tool_run` | `{ run_uuid, index, tool, result, ok, instance_id }` | `runTool` 后台任务每完成一个步骤广播一条。**bootstrap 内部已封装完成判定**，UI 组件通常不需要直接订阅此事件——使用 `Teahouse.runTool()` 的 Promise/handle 接口即可 |
| `tool_run_cancelled` | `{ run_uuid, instance_id }` | 某 runTool 批被后端取消（经 `handle.cancel()` / `Teahouse.cancelRunTool(run_uuid)`）时广播。bootstrap 内部据此 reject 对应批，UI 无需手动订阅 |
| `generate_progress` | `{ run_uuid, path, delta, accumulated_len, accumulated_text, done, instance_id }` | `Generate` 流式每收到一个正文 chunk 广播一条。**bootstrap 内部已集中订阅并维护 `Teahouse.currentDraft`**，UI 组件订阅 `draft.change` 即可——不需要直接处理此事件 |
| `draft.change` | `{ path, text, accumulated_len }` | bootstrap 收到 `generate_progress` 后更新 `currentDraft` 并广播此事件。UI 组件（如正文渲染器）订阅此事件即可实现生成中的打字机效果 |
| `generation.status` | `'idle'` / `'generating'` / `'done'` | 生成状态变化时广播。`generating`=开始生成/有新 delta；`done`=生成结束、`currentDraft` 已清空 |
| `draft.committed` | `{ num, path, title, commit_hash, applied, failed, committed_draft }` | `Teahouse.commitDraft()` 成功转正/补解析后宿主广播。**非调用方组件**（page-bar 角标、导演手动转正后 input-bar 切态）订阅它同步状态 |
| `session_done` | `{ instance_id, session_id }` | 子会话导演调用了 `EndSession` —— 宣告该子任务工作完成。**只发信号、不销毁会话**；是否销毁由调用方（沙盒 `sessionDestroy` 或用户）决定 |
| `session_destroyed` | `{ instance_id, session_id }` | 某子会话被销毁（沙盒或前端调用 `sessionDestroy`）后广播。沙盒若在监听对应会话,应清理相关 UI/状态 |
| `theme.change` | `{ dark: bool }` | 宿主切 dark/light 主题时推送（初次挂载 / iframe 重建后也会补推当前值）。`dark` 表示宿主当前是否**暗色**。沙盒 UI 若想跟随宿主主题，订阅此事件切换自己的配色 |

#### 跟随宿主主题（`theme.change`）

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

### 流式草稿（`Teahouse.currentDraft`）

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

宿主监听 `file_changed` SSE（导演工具调用广播），当变更路径位于 `runtime/` 下时向沙盒推送 `output.refresh`。沙盒借此在导演每次写正文/改代码后自动刷新。

**⚠️ `_teahouse_event` 事件桥单一所有权**：宿主在 srcdoc 顶部注入的 bridge 是 `_teahouse_event`（含 `generate_progress`、`output.refresh`）的**唯一**转发入口，它已监听 `window message` 并 `_emit`。bootstrap 内部订阅 `generate_progress` 和 `tool_run` 维护 currentDraft 和 runTool 封装。用户代码不应再直接监听 `generate_progress` 或自行管理 `tool_run` 完成判定，应使用 `Teahouse.runTool()` Promise 和 `draft.change` 事件。

**Generate 流式**：生成进行中**不落盘**，仅把每个正文 chunk 作为增量 `delta` 立即广播 `generate_progress`（携带 `run_uuid`、`path`）。**结束/用户取消（runTool 打断或导演 ESC）/报错才一次性落盘 + 广播 `file_changed`，且广播一条 `done:true` 带全文 `accumulated_text` 的校准消息**（取消也算"中断"，**已生成的正文同样落半成品供续写**，不会丢内容）。bootstrap 据此：
- 开始 generate → `generationStatus = 'generating'`，`currentDraft` 建立，`draft.change` 广播
- 每个 delta → 追加到 `currentDraft.text`，`draft.change` 广播 → 正文渲染器 rAF 节流刷新
- 结束 → `currentDraft = null`，`generationStatus = 'done'`，等 `file_changed` → `output.refresh` → 文件渲染接管

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
Glob runtime/sandbox/**/*     → 查看沙盒目录中的现有文件
```

确认实例已有哪些 UI 组件。bootstrap 是引擎内置的，不需要也不应该创建。

### 步骤 2：确保正文渲染器存在

如果实例没有正文渲染器，需要创建一个。引擎提供了默认的 `teahouse-maintext-renderer.js` 作为模板。核心职责：
- 版面管理：`Teahouse._pageState`（floors 数组 + currentIndex）
- 正文渲染：`listFloors()` + `readText()` + `renderRichText()` → DOM
- 流式草稿：订阅 `draft.change` 事件实现打字机效果
- 翻页：`goToPage(index)` / `renderCurrent()`
- `output.refresh` 精准刷新

编写时使用普通 function 和 var（兼容旧浏览器，因为 iframe 无 transpiler）。整段代码包裹在 IIFE `(function() { ... })()` 中避免全局变量污染。

Write 到 `runtime/sandbox/teahouse-maintext-renderer.js`，前端自动重建 iframe。

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

尺寸可用内联 `style` 微调（如 `height:30px;font-size:12px`），但**颜色/圆角/hover/禁用交给类**，不要在组件里重写。按钮想换语义色（比如"危险操作"要红色）就叠一个改 `background` 的内联或再加语义色类。

**语义色变量（成功/危险/警示），与 accent 同构、三态齐全**：
- 文字强调：`--success` / `--danger` / `--warn`
- 柔和底（选中/hover）：`--success-soft` / `--danger-soft` / `--warn-soft`
- 实心底 + 其上文字：`--success-fill`+`--success-filled-text` / `--danger-fill`+`--danger-filled-text`
- 场景：红=脏/未提交/危险（`--danger`）、黄=星标/警示（`--warn`）、绿=最新/成功（`--success`）。当前已应用到 var-editor（脏值与星标）、page-bar（最新/草稿角标）。

**层级速记变量**：`--text-strong/--text/--text-soft/--text-dim`（前景强弱）、`--bg/--bg-elevated/--panel`（底面层级）、`--border/--border-strong`（分隔线）。写组件时按"几级文本/几级底"选，不用记具体 rgba。

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

沙盒可通过 `Teahouse.send()` 发送用户消息给导演。自定义输入框、选项按钮、快捷指令参照实例现有 `input-bar.js` 模式。

### 步骤 6：部署和迭代

#### 首次部署顺序

先创建文件，再 Write 到 `runtime/sandbox/`：

1. **teahouse-maintext-renderer.js**：正文渲染器（最先执行，建立 _pageState 和渲染逻辑）
2. **theme.css**（可选）：全局主题样式——唯一允许的独立 css，换肤入口
3. **其余组件**：简单组件写 `*.js`；带数据的组件开同名文件夹（`组名/组名.js` + `组名/数据.json`）

#### 迭代修改

- **修改组件 → 直接 Edit `runtime/sandbox/` 下对应 js（或组件文件夹内文件）**。前端监听到 `file_changed` 后重建 iframe srcdoc（热重载）。**数据文件变更和代码变更一样会触发重建**——改组件自持的 `*.json` 后，相当于改沙盒内容，iframe 也会刷新。
- 修改正文渲染器 → iframe 全重建，DOM 状态全丢。

#### 沙盒代码整体禁用

如需临时禁用沙盒（让游玩模式退化为纯文本渲染），把 `runtime/sandbox/` 下的代码**移动到 `runtime/sandbox/disabled/`**：

```
FileOps move runtime/sandbox/teahouse-maintext-renderer.js runtime/sandbox/disabled/teahouse-maintext-renderer.js
```

`runtime/sandbox/disabled/` 内的文件渲染器**不读取**（除 `disabled/` 外均启用），故移入即从沙盒移除、但仍保留在该子目录（git 追踪、可恢复）；需要恢复时移回 `runtime/sandbox/`。只服务沙盒代码，正文楼层无此需求。

## 最佳实践

1. **使用 var 和普通 function**：iframe 无 transpiler，不识别 const/let/箭头函数
2. **IIFE 包裹每个文件**：避免全局变量污染
3. **组件样式内嵌 js**（`style.cssText` / JS 注入 `<style>`）：组件不写独立 css，不拆辅助 js —— 一个组件 = 一个自包含 js 文件，或一个组件包文件夹
4. **一个组件一个入口**：简单组件就一个 `foo.js`；要配数据就开同名文件夹（`foo/foo.js` + `foo/*.json`），根目录不留散文件
5. **共享状态通过 `window.Teahouse` 暴露**：`window.Teahouse._colorState`、`window.Teahouse._pageState` 等
6. **跨组件通信通过事件**：`window.Teahouse._emit('color.change', data)` + `window.Teahouse.on('color.change', callback)`
7. **正文渲染靠 `listFloors()` + `readText()` + `renderRichText()`**：不要假设正文会被推送进来
8. **fixed 定位的 UI 组件 z-index 分层次**：topbar ~200、UI 层 ~100、panel ~200、input ~300
9. **不要在沙盒内写 ES6+ 语法**：`let`、`const`、`=>`、模板字符串、async/await 都不安全（用 var + 普通 function + Promise 链）
10. **CSS 中用 `rgba()` 而非 `oklch()`**：iframe 内没有 Tailwind 的 oklch polyfill
11. **先 Read 后 Edit**：修改现有沙盒代码前先读取当前内容
12. **ui_js 必须通过 `window.registerUI(label, element)` 挂载 UI 元素**：不要直接 `appendChild`，因 DOM 未就绪会静默丢失
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
- **不确定时参考 sandbox 实例**：`data/lowstar/instances/sandbox/` 下有完整的 UI 组件参考
