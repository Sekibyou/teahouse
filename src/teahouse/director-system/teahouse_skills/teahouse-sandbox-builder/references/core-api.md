# 沙盒 API · 核心

所有 API 通过 `window.Teahouse` 暴露给沙盒代码。

## 楼层（正文历史）

正文历史位于 `runtime/floors/`，按楼层数字排序。沙盒通过文件操作接口读取：

### `Teahouse.listFloors() → Promise<FloorEntry[]>`

获取排序后的楼层清单。每个元素是 `{ num, path, draft }`：`{num}` 为楼层数字，`{path}` 为相对实例根目录的路径（如 `runtime/floors/floor-5.md`），`{draft}` 为 `true` 表示半正式稿 `floor-N-draft.md`（正式稿优先于草稿）。

```js
const floors = await Teahouse.listFloors()
const latest = floors[floors.length - 1]              // 最近一楼层
const isDraft = !!(latest && latest.draft)            // 它是否半正式稿
```

要读取某楼层正文、并经宿主渲染为 HTML：

```js
const markdown = await Teahouse.readText(floor.path)
const html = await Teahouse.renderRichText(markdown)
container.innerHTML = html
```

## 富文本渲染

### `Teahouse.renderRichText(text) → Promise<string>`

将正文文本交由宿主层解析为 HTML 字符串。解析在宿主层执行（BBCode → 样式着色 → Markdown），沙盒拿到 HTML 后自由组织渲染位置和方式。

```js
const markdown = await Teahouse.readText(floor.path)
const html = await Teahouse.renderRichText(markdown)
container.innerHTML = html
```

**注意**：BBCode 标签白名单由 `teahouse-syntax` skill 的 `references/richtext.md` 定义。不要假设沙盒自己能解析 BBCode。

## 文件操作

### `Teahouse.readText(path) → Promise<string | null>`

读取实例文件的 **UTF-8 文本内容**。path 相对于实例根目录，如 `"settings/static_settings/world.yaml"`、`runtime/floors/floor-001.md`。用于正文、设定、配置等文本文件；**二进制资源（图片/音频/字体）不在此列，用 `readAsset`**。

```js
const yaml = await Teahouse.readText("settings/static_settings/world.yaml")
```

### `Teahouse.readAsset(path) → Promise<string | null>`

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

### `Teahouse.writeFile(path, content) → Promise<boolean>`

写入文件内容（覆盖式）。path 相对于实例根目录。

```js
// 组件包方式：数据写入组件自己的文件夹，写在 .json 上（不被注入、随 git 追踪）
await Teahouse.writeFile("runtime/sandbox/var-editor/important-vars.json",
                         JSON.stringify({ important: ["金币", "修为"] }))
// 读取：
const prefs = JSON.parse(await Teahouse.readText("runtime/sandbox/var-editor/important-vars.json"))
```

**权限**：文件操作受 JWT 身份控制，与当前用户权限一致。沙盒可读写实例内任意路径。

## 发送消息

### `Teahouse.send(message) → void`

模拟用户输入，触发导演回合。等价于用户在 ChatPanel 打字 + Enter。

```js
Teahouse.send("开始第一章")
```

这是沙盒与导演交互的唯一方式。用户选择选项、点击按钮等场景可用此方法驱动剧情。

### `Teahouse.openDirector() → void`

**唤起导演栏**：当导演栏被折叠/隐藏（比如玩家全屏游玩、或导演面板被收起）时，请求宿主把导演栏打开。**纯前端信号，不触发生成、不发送任何消息**——只负责把导演栏展开到可见，玩家可看到场景并/或与导演沟通。

```js
// 需要找导演开子会话/沟通前，先把导演栏唤起，让玩家能看到舞台
Teahouse.openDirector()
```

**典型场景**：沙盒某项功能需要调用子会话（`sessionCreate`/`sessionSend`）或与导演对上话，而玩家正全屏游玩、导演栏被折叠。此时在调用子会话或 `send()` **之前**先 `openDirector()`，确保导演栏展开、玩家能看到导演的过程与思考，也能直接打字介入。若导演栏本来就展开着，此调用是空操作（无副作用），可放心调用。

### `Teahouse.openDM() → void`

**唤起 DM 栏**：行为同 `openDirector()`（展开被折叠的导演栏），并**额外把导演栏切到「DM」标签页**。**纯前端信号，不触发生成、不发送任何消息**。实例未启用 DM（无 `dm.yaml`）时切换被忽略，仅展开导演栏。

```js
// 需要玩家以 DM 身份发言（局外发言，只进会话不进呈现）前，先把 DM 栏唤起
Teahouse.openDM()
```

**典型场景**：沙盒判定此刻该由 DM（跑团主持人/语C 对手戏）出面，而玩家正在全屏游玩。调用后 DM 栏展开并停在 DM 标签页，玩家可直接打字以 DM 身份发言。若已停在 DM 标签页，此调用是空操作。

## UI 组件管理

### `window.registerUI(label, element)`（bootstrap 提供）

注册一个 UI 组件到 `#teahouse-ui-layer`。如果 label 已存在，旧组件会被移除。未就绪时自动排队，就绪后挂载。

```js
var bar = document.createElement("div")
bar.id = "my-statusbar"
window.registerUI("statusbar", bar)
```

**重要**：不要直接 `getElementById('teahouse-ui-layer').appendChild()`——`registerUI` 会按 label 去重（同名旧组件自动移除）、并在容器就绪前兜底排队；裸 appendChild 既失去去重，也拿不到这层兜底。

## 容器约定

沙盒 DOM 中有两个由 bootstrap 创建的容器：

| 容器 ID | 用途 | CSS class |
|---|---|---|
| `#teahouse-content` | 主体内容区（正文、章节等） | `teahouse-content` |
| `#teahouse-ui-layer` | UI 覆盖层（fixed 定位组件） | `teahouse-ui-layer` |

**注意**：`#teahouse-ui-layer` 的定位样式（`position: fixed; inset: 0; pointer-events: none; z-index: 100`，其直接子元素设 `pointer-events: auto`）**由 `theme.css` 提供，不是引擎强制的**——bootstrap 只创建这个 class 为 `teahouse-ui-layer` 的空 div，样式全看实例 `theme.css`。组件应作为它的直接子元素，并自己设置 `position: fixed` 定位。
