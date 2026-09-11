---
name: teahouse-play-mode
description: 教导导演如何「组织一个实例」——把设定、正文生成、总结设计成一套可运转的结构。含两种游玩形态的方法论：**小说式**（设定引用是 DAG，终点是 `generate-config/*.yaml`；yaml 只当薄壳，复杂语法走 md 中转）与 **DM 式**（跑团/语C/聊天式，组装指向 `dm.yaml`）。构建期必须一并设计好总结（产出只有归档界 + 动态设定），即创建好 `summary/summarize-prompt.md`。另含进阶操作 `BatchGenerate`（正文前并行产出临时设定与随机事件；DM 侧多角色独立扮演与临场素材）。另附平台标准内置沙盒件 `novel-main.js` / `dm-main.js`（原封可用）。当用户要求"搭一个实例 / 组织设定 / 做成跑团 / 做成语C / 聊天式"、"设定该怎么放"、"生成配置怎么组织"、"总结该怎么设计"时触发。
---

# 游玩模式 · 组织实例

教导导演如何组织一个实例：设定放哪、正文怎么产、DM 怎么装、总结怎么设计。

## 先选模式：小说式 / DM 式

两种形态的**渲染系统互斥**，先定下来再动手——选错了画面会乱。

| | 小说式 | DM 式（跑团 / 语C / 聊天式） |
|---|---|---|
| 正文来源 | `runtime/floors/floor-N.md`（散文正文） | `runtime/dm-output.jsonl`（DM 呈现的气泡） |
| 核心组件 | 正文渲染器 + 翻页器 + 输入条 | DM 气泡渲染器 |
| 谁产出 | 导演组织设定 → `Generate` 产文 → 落 floors | **DM** 运行时扮演 → `Output` 落 dm-output |
| 提示词指向 | `generate-config/*.yaml`（薄壳，引用组装器 md） | `dm.yaml` |
| 启用方式 | 默认 | 实例根目录建 `dm.yaml` 即启用 DM |

- **小说式** → 读 `references/novel-mode.md`
- **DM 式** → 读 `references/dm-mode.md`
- **总结设计**（两种模式都要在构建期一并决定）→ 读 `references/summarize.md`

沙盒代码本身（组件怎么写、API、主题）见 `teahouse-sandbox-builder` skill。

## 构建期必做：把总结一并设计好

**总结不是"开跑之后再说"的事**——它决定哪些设定会被沉淀、以什么结构沉淀，而这些结构正是正文生成要引用的。所以在搭设定与组织形式时就要一并想清楚：

1. 哪些动态设定要在总结时被更新、放在 `settings/dyn_settings/` 的哪个文件；
2. 哪些变量要随剧情维护；
3. 然后**创建好 `summary/summarize-prompt.md`**——它就是总结的 SOP，由实例承载、允许随实例修改。

细节与产出约定见 `references/summarize.md`。

## 标准内置沙盒件（原封可用）

平台自带两个**标准实现**，在 `assets/` 下（`SkillRead(name="teahouse-play-mode", file="assets/novel-main.js")` 可读全文吸收参考）：

| 文件 | 用途 |
|---|---|
| `assets/novel-main.js` | 小说式标准件：正文渲染器 + 翻页器 + 输入条（含生成/续写/重写/总结四个模式） |
| `assets/dm-main.js` | DM 式标准件：DM 气泡渲染器 + 忙碌态输入锁（订阅 `session.busy`，DM 工作期间禁用输入并显示「DM 正在工作…」） |

**建议直接使用，不建议导演自己另写一套正文创作或扮演逻辑**——这两份是平台维护的、与后端约定同步演进的标准实现。把它们装进实例：

```
Write(path="runtime/sandbox/novel-main.js",
      content="{{skill:teahouse-play-mode/assets/novel-main.js}}",
      resolve_placeholders=true)
```

（`{{skill:...}}` 切片原样取出字节、不经过你的上下文；DM 式同理把 `dm-main.js` 装进 `runtime/sandbox/`，并把另一份移入 `disabled/`。）

**`Generate` 的定位**：它是**调试工具**——用 dry-run（即填 `dump_payload_path`）看最终 payload 组装成什么样，或真实调用一次看模型产出如何。日常正文由实例里 `novel-main.js` 的生成流水线驱动，不需要你手工组织每次生成。

## 进阶操作：`BatchGenerate`

**正文之前先把素材产出来**——`BatchGenerate` 一次并行发起多个**互相独立**的正文生成，各步不共享上下文，所以产出不会互相迁就趋同（这正是「交给正文模型顺手编」做不到的）。两个模式各有用法：

- **小说式**：正式产正文之前，先并行产出本章要用的**临时人 / 物 / 地点 / 势力**与**随机走向**，落 `temp/`；挑选后转写进 `settings/dyn_settings/`，再接进组装器。也可让沙盒的生成流水线经 `runTool` 自动做，完全不经过你。
- **DM 式**：**多角色各自独立行动**（强隔离，避免一个上下文里互相迁就）、**一次产出多个备选**、**临场素材**（随机事件 / 偶遇路人 / 拍卖物品）。产出落 `temp/` 后可用 `Output` 的 `{{}}` 切片直接引用呈现，同一轮内「先并行产出 → 再引用呈现」闭环。

默认 `reasoning_effort=none`（关闭思考），为快速反应而设——与单发 `Generate` 相反。参数、流程与两种模式的完整写法见 `references/advanced.md`。
