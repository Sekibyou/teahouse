# 沙盒 API · DM 呈现

DM 的呈现记录位于 `runtime/dm-output.jsonl`，**与 `runtime/floors/` 并列、互不干扰**。仅当实例启用 DM（根目录有 `dm.yaml`）时才有内容。

> DM 模式本身（`dm.yaml` 怎么组织、提示词组装）属 `teahouse-play-mode` skill；本文件只讲**沙盒侧怎么读、怎么写**。

### `Teahouse.listMessages() → Promise<{enabled, messages}>`

- `enabled`：实例是否启用 DM（根目录存在 `dm.yaml`）。
- `messages`：`[{chara, seq, batch, content, kind?}]`——`chara` 发言者（`user` 为玩家保留值），`seq` 全局自增，`batch` 批次号（**只有最新批次可改**，历史批次已冻结），`kind` 可选（`say` / `narrate` / `roll` / …）。

```js
const { enabled, messages } = await Teahouse.listMessages()
if (enabled) messages.forEach(m => renderBubble(m.chara, m.content, m.kind))
```

订阅 `output.refresh`（`data.path === 'runtime/dm-output.jsonl'`）重渲染。

### `Teahouse.sessionSend('dm', text) → Promise<{ok, data:true, error?}>`

玩家**扮演**发言：发给 DM 会话；后端自动把它写入 dm-output（开新批次）再交给 DM（写盘即广播 `file_changed`，故气泡立刻可见）。注意区分：**导演栏里的 DM 会话输入框**里打的字是**局外**发言（只进会话、不进 dm-output），与沙盒的扮演输入是两条不同通道。

## 创作约定：`chara` 与 `kind` 是**开放的**，靠「两处配合」定义

`chara`（谁说）与 `kind`（这是什么类型）引擎都**原样存储、不做校验**——没有固定清单，你写什么就存什么。因此**新增/删除一个发言者或消息类型，必须同时改两处**，缺一不可：

| 改哪 | 作用 |
|---|---|
| ① **实例根目录 `dm.yaml`** | 在提示词里**要求 DM 产出**这些 `chara` / `kind`（如「旁白用 `chara:"narrator"` + `kind:"narrate"`」「掷骰结果用 `kind:"roll"`」）。不改这里，DM 永远产不出你的新类型。 |
| ② **沙盒渲染器（本 skill 的产物）** | 按 `chara` / `kind` 决定**怎么渲染**（气泡形状、颜色、居中、等宽…）。不改这里，新类型只会按默认样式渲染。 |

- **`chara`**：发言者标识，`user` 是玩家保留值；其余任意字符串（角色名 / `narrator` / `system` / `dice` …）。
- **`kind`**：消息类型，供渲染差异化。**引擎侧无枚举**——`say` / `narrate` / `roll` 只是**惯例示例**。你可以自造 `whisper`、`scene`、`系统提示` 等任意值；参考渲染器 `teahouse-play-mode` skill 的 `assets/dm-main.js` 按 `th-dm-kind-<kind>` 生成 CSS 类，加一条样式即生效。
- **对齐约定**：`dm.yaml` 里声明 DM 可用哪些 `kind`、每个什么含义；沙盒的渲染分支与之**一一对应**。二者是同一份约定的两个消费者，改一个务必同步另一个。

## 用户消息的包裹层（只在会话里，**呈现记录里没有**）

玩家发言在**发送前**由前端套了一行**系统前缀**，随正文一起落盘进 `.sessions/dm.jsonl`、一起喂 DM：

| 前缀行 | 含义 |
|---|---|
| `[[TH-SYS presence N]]` | 扮演发言（沙盒输入）——已写入 `runtime/dm-output.jsonl`，seq=N |
| `[[TH-SYS ooc]]` | 局外发言（DM 控制台输入）——不进 dm-output |

格式为 `<前缀行>\n\n<正文>`；约定源 `teahouse-frontend/src/lib/dmWrap.ts`。

**关键：沙盒渲染气泡时无需处理这个前缀**——后端写呈现记录时会剥掉它（`src/teahouse/dm_output.py` 的 `strip_wrap_prefix`），`runtime/dm-output.jsonl` 的 `content` 是纯正文。前缀只为 DM 的**会话上下文**服务；解析它的是**导演栏**（DM 控制台），把前缀裁掉渲染成 badge（`#N` / `#ooc`）。
