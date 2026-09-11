# DM 模式（跑团 / 语C / 聊天式）

DM 是**实例级的单例 agent**：玩家在**游玩视图**与它对话，它用 `Output` 把发言呈现为气泡（`runtime/dm-output.jsonl`）。它不是批量产文的正文助手，而是这个世界的**主持人 / 对手戏演员**。工具集轻量全权：读 / 写 / git 存盘 / 变量 / `Output` / `Roll` / 正文生成（`Generate`、`BatchGenerate`），**没有**子会话。

## 一、启用与切换

**启用 DM**：在**实例根目录**写 `dm.yaml`（存在即启用）。首个实例通常自带 `dm.yaml.example`，改名即用；格式见下节。

**渲染系统互斥**——切到 DM 式时必须把小说式的组件禁用，否则两套渲染打架：

1. 把 `runtime/sandbox/novel-main.js` 移入 `runtime/sandbox/disabled/`；
2. 把 `dm-main.js` 从 `disabled/` 移出到 `runtime/sandbox/`；
3. 参考设定修改 `dm.yaml`：指出设定都位于哪里、DM 应该阅读哪些内容。

（这两份标准件见本 skill `assets/`，装法见 SKILL.md「标准内置沙盒件」。）

## 二、组装指向 `dm.yaml`（而不是 config yaml）

小说式的组装终点是 `generate-config/*.yaml`；**DM 式的组装终点是 `dm.yaml`**——DM 的提示词就是它。

`dm.yaml` 格式同导演提示词：

- `system:` 系统提示词（DM 的角色、呈现规则、工具用法）
- 可选 `messages:` / `user:` / `assistant:` 预设对话，可选 `user_tail:` 包裹本轮玩家消息
- 占位符在组装时解析：`${teahouse.tools_usage}`（DM 白名单工具指南）、`${teahouse.file_tree}`、`${teahouse.available_skills}`、`${变量名}`、`{{path}}`；`user_tail` 内另有 `${teahouse.user_input}` / `${teahouse.usage}` / `${teahouse.big_files}`
- `dm.yaml` 自身会被解析——要展示字面 `{{...}}` / `${...}` 需加 `\` 转义

## 三、⚠️ `dm.yaml` 不要塞会变动的内容（缓存失效）

`dm.yaml` 的 `system:` 位于消息列表**最前端**，**它内任何一处变动都会作废整段上下文的 prompt cache**。而 DM 是持续对话的，缓存每轮都值钱。

所以：

- **系统段只放稳定不变的东西**：DM 的身份与准则、呈现规则、工具用法。**不要把会随剧情变动的设定正文塞进 `system:`**——它一变，整段缓存作废。
- **最佳实践：设定名单放单独文件，`dm.yaml` 里只说「请看某文件」**。即用一个设定文件（如 `settings/dm-settings.md` 或复用 `settings/dyn_settings/`）承载 DM 该知道的设定，`dm.yaml` 的系统段只写一句「开始前先 `Read` 某某文件了解设定与人设」。这样：
  - 系统提示词前缀**字节稳定**（缓存一直命中）；
  - 设定变化只体现为 DM 每次运行时的 `Read` 结果，不进系统提示词、不作废缓存。
- 每轮变动的信息（玩家本轮输入、上下文用量、大文件预警）一律挂 `user_tail:`——它落在消息尾部，不破坏前缀缓存。

## 四、呈现：`Output` 与 DM 的工具面

- **`Output(chara, content, kind?)`** 把发言写进 `runtime/dm-output.jsonl`。玩家在游玩视图**只看到**这里的内容；DM 的思考与工具调用只在 DM 控制台可见。
- **`chara`** 是发言者：`narrator` 用于旁白，角色名用于角色台词。**不要用保留值 `user`**——玩家发言由系统自动写入，重复 Output 会显得重复。
- **`kind`** 是消息类型（可选）；当前惯例三类：`say`（默认，角色对话）、`narrate`（旁白/场景叙述）、`roll`（掷骰结果）。**引擎侧无枚举**——`chara` 与 `kind` 都是**开放值**，但改它们必须**两处同步**：`dm.yaml`（要求 DM 产出）+ 沙盒渲染器（怎么渲染）。详见 `teahouse-sandbox-builder` skill 的 `references/dm-api.md`。
- **`OutputEdit(seq, old_string, new_string)`** 改**最新批次**的已呈现内容（历史批次已冻结）。
- **`content` / `new_string` 支持文件切片 `{{path}}`**（同 Write/Edit 的写法：`{{temp/gen/a.md}}`、`|from="## 秦悠"`、`:10-30` 等）。这让 DM 可以「先落盘、再引用呈现」，不必把长文本整段复制进工具参数；`old_string` 作锚点**不解析**。解析失败会报错并拒绝呈现。**不解析 `${}`**——呈现的是成品正文。要展示字面 `{{` 需在开括号前加反斜杠转义。
- **`Roll(dice)`** 掷骰（`Roll("2d6+1")`、`Roll("4d6k3")`）。**结果不会自动呈现**——要按规则写进 `Output`（可作 `kind:"roll"` 的气泡，或融入叙述）。转述错了可用 `OutputEdit` 改。
- **`Generate(source_file, path, overwrite?, reasoning_effort?)`** 单发一次正文生成，落盘到你指定的 `path`。`path` 是自由的——产素材就落 `temp/`，再用 `Output` 的 `{{}}` 切片引用呈现。**`Generate` 流式在生成中不落盘**，结束/中断/报错才落盘并广播一次 `file_changed`；默认**拒绝覆盖**已存在的文件（要覆盖传 `overwrite=true`）。
- **`BatchGenerate(steps)`** 并行发起多个正文生成（一次最多 8 步，各自落 `temp/`，全部结束才返回）。各步**不共享上下文**——人设与任务写在各步自己的 yaml 里，所以产出是真正独立的，不会互相迁就趋同。三种用法：**多角色各自独立行动**（每步一个角色，DM 再读回来汇总推进）、**一次产出多个备选**、**临时设定/素材**（随机事件、路人、配角、拍卖物品——正文产出前先让它们各自成形）。返回只给「路径 + 成败」不带正文，要读内容自己 `Read`。配上 `Output` 的 `{{}}` 切片，同一轮内就能「先并行产出 → 再引用呈现」闭环。
  —— 一句话选型：**一份就 `Generate`，要几份独立产出就 `BatchGenerate`**（后者并行，且互不趋同）。**写进 `runtime/floors/` 的正文历史归导演**，DM 的产出都应落 `temp/`。
- **状态与存档**：变量用 `SetRuntimeVar` 维护、`GetRuntimeVars` 读；阶段性进展在合适时机 `GitCommit` 存档。
- **`content` 不要加首行缩进或行首空行**——呈现层按行 trim 首尾空白，直接写纯段落即可。
- **初始化**：DM 开始工作前应先查看 `runtime/dm-output.jsonl`（会话可能从中途开始，之前已有扮演历史）。

## 五、玩家发言的两条通道

| 通道 | 入口 | 去向 |
|---|---|---|
| **扮演** | 游玩视图的沙盒输入（`Teahouse.sessionSend('dm', text)`） | 进 `dm-output.jsonl`（开新批次）再交给 DM |
| **局外** | 导演栏的 DM 控制台输入框 | 只进会话、**不进** dm-output |

两条通道靠前端加的系统前缀区分（`[[TH-SYS presence N]]` / `[[TH-SYS ooc]]`），前缀只为 DM 的会话上下文服务，后端写呈现记录时会剥掉。详见 `teahouse-sandbox-builder` skill 的 `references/dm-api.md`。

## 六、风格要点

- 保持角色一致；玩家发言里的行动要给出合理后果，**别替玩家决定他的下一步**。
- 不确定的设定先 `Read` / `Glob` 查证，别凭空编造与已有设定冲突的内容。
