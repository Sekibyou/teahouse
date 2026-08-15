---
name: teahouse-generate-floor
description: 教导导演如何生成正文楼层，包括上下文准备和 Generate 工具的使用。当用户要求"开始写下一层"或"继续写作"时触发。
---

# 正文生成 Skill

教导导演如何撰写正文楼层。

## 适用时机

当用户要求"开始写下一层"或"继续写作"时，加载本 skill。

## 方法论

正文生成的核心思路：**先理解当前状态，再构造写作请求**。你不是自己写正文，而是通过 Generate 工具让正文 AI 来写。你的职责是提供准确、完整的上下文。

正文「输出」即**文件落盘**：正文历史唯一来源是 `.teahouse/output/floors/`。半正式稿 `floor-N-draft.md`（每层唯一，就地覆盖）是写稿过程中的可见输出；用户在草稿页确认后，由沙盒 `Teahouse.commitDraft(N)` 自动转正为 `floor-N.md`（含解析正文变量块 + git 提交）。前端监听导演的工具调用后自动刷新读取，无需任何推送工具。

## 目录约定

- `temp/` — 草稿/探索中间产物（**每章一份、就地覆盖**，不做多版本并存）。**temp/ 不纳入 git 版本控制**（GitCommit 不会提交其内容），草稿/探索中间产物放这里很安全。**写 temp/ 的 Generate 不进沙盒打字机**——流式仅在最终落进 `.teahouse/output/floors/` 后一次性渲染
- `.teahouse/output/floors/` — 上下文引擎正文历史（半正式稿 + 定稿），每层最多一份，就地覆盖
  - `floor-N-draft.md` — 半正式稿（创作过程中）
  - `floor-N.md` — 正式定稿（满意后 rename）

## 输出路径：按用户要求分流

Generate 的 `path` 落在哪个目录，决定沙盒是否流式渲染，须按用户意图选择：

- **生成全文 / 重写** → `path` **直接**写 `.teahouse/output/floors/floor-{{N}}-draft.md`。
  落盘即在正文历史 → 触发沙盒打字机并常驻渲染。
- **续写 / 大幅度改写** → `path` 写 `temp/draft-{{N}}.md`，完成后读出现稿与之**对比合并**
  （新增部分并入），再落进 `.teahouse/output/floors/floor-{{N}}-draft.md`。
  temp/ 阶段不打字机；落进 floors/ 后一次性渲染合并结果。

## SOP

### 步骤 0：检查文件夹和文件结构

检查以下目录和文件，如果不存在则创建：

```
FileOps mkdir .teahouse/dyn_settings/
FileOps mkdir temp/
FileOps mkdir .teahouse/output/floors/
```

**变量系统不在此创建**。变量统一存放在 `.teahouse/runtime_vars.jsonl`（由 `SetRuntimeVar` 工具写、`GetRuntimeVars` 读），是实例内唯一的变量载体（文件即状态）。设定分两类：**长期静态设定**在根 `static_settings/`（gitignore，只读引用，不修改）；**中短期动态设定**在 `.teahouse/dyn_settings/`（入 git，总结产出）。导演既读写变量，也管理设定。不存在 `variables/` 目录——不要创建它。

### 步骤 1：理解楼层配置

`teahouse.md` 已注入系统提示词。关注其中的楼层字数目标、最大/最小字数限制，以及**归档界**（已总结到哪一层）。

### 步骤 2：创建任务清单

使用 TodoWrite 工具创建任务清单，追踪正文生成的各个步骤。

### 步骤 3：阅读前文，理解剧情

正文历史位于 `.teahouse/output/floors/`，按楼层数字排序：

```
Glob .teahouse/output/floors/floor-*.md   → 列出所有楼层/草稿
Glob .teahouse/dyn_settings/summary/sum-*.md                     → 列出所有总结
```

**阅读策略：**

- **最近楼层**：优先用 `{{glob:output/floors/floor-*.md:last10}}` 一次性注入最近 10 层正文（按楼层数字自动升序、正式稿优先于草稿）。如需精读某层，用 Read 直接读文件。
- **更早楼层（已被总结覆盖）**：阅读 `.teahouse/dyn_settings/summary/sum-*.md` 总结，不必逐层读原文。
- 归档界标记在 `teahouse.md` 全局变量区——超过归档界、未被总结覆盖的楼层，正文必须进上下文；被总结覆盖的楼层看总结即可。

充分理解用户的创作意图、叙事风格和当前剧情走向。

### 步骤 4：了解当前变量状态

**核心变量已实时注入你的系统提示词**（no cache）——构建上下文时系统已把 `.teahouse/runtime_vars.jsonl` 当前的 `${name}` 变量快照拼进提示词开头，你通常已经看到它们的现值，无需再 Read（避免游玩时的读取往返）。

若需读取特定变量、或系统提示词里没体现，用 `GetRuntimeVars(names=[...])` 按名精确读取，例如：

```
GetRuntimeVars(names=["金币", "修为", "主角名"])
```

需要更新剧情状态时，用 `SetRuntimeVar` 直接写（与正文一起落盘、进 git、导演/沙盒立即感知），例如：

```
SetRuntimeVar(updates={"金币": 140, "修为": "炼气四层"})
```

记住：**变量是高度精炼的数值/重要值**（金币、修为、好感度、主角名）；较长的中短期文字状态（二人关系、任务描述、经历）属于**动态设定**，放 `.teahouse/dyn_settings/` 下用 Write/Edit/WriteLine 管理，不要塞进变量。

### 步骤 5：阅读相关设定

基于前文和用户的意图，从设定文件夹里阅读可能与这段剧情有关联的设定。**长期背景**（时代特征、势力、修为分段等）在根 `static_settings/`；**中短期动态**（关系、当前所在地、任务进展）在 `.teahouse/dyn_settings/`。使用 Glob 探索设定文件：

```
Glob static_settings/**/*
Glob .teahouse/dyn_settings/**/*
```

在摘抄设定时：
- 结合当前变量的值进行筛选，只摘抄与当前剧情相关的设定
- 自行总结最近几十章之外的、没有被变量系统记录但有用的关键信息——例如人物历史互动、细小的事件、口癖、习惯等
- 使用行号范围或锚点语法截取关键部分，一般不要一次性塞入全文

### 步骤 6：检查当前层草稿状态

检查 `.teahouse/output/floors/` 中当前层（或最近层）的半正式稿状态：

```
Glob .teahouse/output/floors/floor-*.md
```

- **没有当前层草稿**：正常开始生成新楼层。
- **有半正式稿（floor-N-draft.md）**：这是正在创作中的可见输出，询问用户是继续/修改还是放弃重写。
- **已有定稿（floor-N.md）**：询问用户是想对定稿做修改（就地 Edit/WriteLine）还是写下一层。

### 步骤 7：准备 Generate 配置文件

使用 Generate 工具发送正文写作请求。Generate 需要通过 YAML 配置文件（`source_file`）组织消息结构，配置文件支持 `{{path}}` 占位符引用文件内容。

**工作流**：

1. **复制配置模板**（每章一份 `generate-config-{{N}}.yaml`，就地覆盖、不做多版本）：
   - 如果是首次创作：复制 `.teahouse/generate-config/generate-config.yaml` → `temp/generate-config-{{N}}.yaml`
   - 如果是续写：复制上一楼层的 config（如 `temp/generate-config-{{N-1}}.yaml`）→ `temp/generate-config-{{N}}.yaml`

2. **编辑配置文件**（使用 Edit 工具进行精确修改）：
   - 用 `{{glob:output/floors/floor-*.md:lastN}}` 注入最近 N 层正文（N 由归档界窗口决定，一般 10；被总结覆盖的早期楼层用 `{{.teahouse/dyn_settings/summary/sum-*.md}}` 而非逐层）
   - 更新设定引用范围（基于当前变量值调整锚点/行号）
   - 在 user 消息中用 `${name}` 变量字面量引用当前变量值（如 `${金币}`、`${主角名}`、`${修为}`），Generate 发送给正文 AI 前会统一展开为值；也可用 `{{.teahouse/dyn_settings/xxx.yaml|...}}` 切片注入相关动态设定。**`${ }` 本身就代表「环境」**：括号内是变量命名空间，变量名（或条件表达式）一律**裸写**，无需再加任何包裹——无论是 `${user}` 这种普通变量、还是 `${@python return ... }` 这种条件块，里面的 `user`、`好感度` 都是直接写的裸变量名。
   - **显式占位符（注册式框架 `${@...}`）**：除花括号外，可用反斜杠前缀的独立指令精确表达语义，全部统一进一个判定框架——写清楚比靠猜好：
     - `${@var 金币}` — 变量值（与裸写 `${金币}` 等价）
     - `${@type 金币}` — 变量的类型串（`number`/`string`/`boolean`/`array`），喂给正文 AI 判断类型用
     - `${@python return ...}` — 白名单 python 代码块，须含 `return`（取材于旧 `${ if...return }`，语义不变）
     - `${@condition 好感度 >= 80: "{{xxx.md}}"}` — **最简条件切片**。宽松写法 `${[if ]条件: 真输出 [else 假输出]}`（`if`/`else` 均可选，`else` 后**不带冒号**）：冒号前是条件（python 比较式，如 `好感度 >= 80`、`dice == 6`），冒号后/`else` 后是输出（return 值：带引号字面量 `"{{xxx.md}}"` / `"达标"`、裸变量名 `金币`、函数 `roll("1d10")`、或裸切片 `{{file:10-30}}`），引擎自动封装成 `if 条件: return 真输出 [else: return 假输出]`。**不支持 elif/三元**。**结果**：条件真 → 真输出；条件假且有 else → 假输出；条件假且无 else → **返回空**（不注入任何内容，不是残留原文）；**坏块**（无冒号、语法错、变量不存在）→ **原样保留**便于排查。裸写 `${好感度 >= 80: "..."}` 等价（自动判为 condition）
     - `${@note 任意文本}` — 注释，解析时恒剥为空（正文 AI 看不到，导演 Read 可见）
     - `${@max [1,9,5]}` / `${@min [1,9,5]}` / `${@len [1,2,3]}` — 从字面量列表或数组变量取 max/min/len。列表元素须为合法 python 字面量（字符串要加引号 `"A"`）
     - `${@random ["口粮", "回血药"]}` — 从**给定列表里随机挑一项**（元素须为合法 python 字面量，字符串加引号）。它只认确定的值、**不会自动填充范围**：`[1..6]` 这种范围写法不支持，`[1,6]` 也只是从「1 或 6」二选一、不是「1 到 6 随机取数」。**只想要一个数字时，一律丢骰子**：`${return roll("1d10")}`（也可写成 `${@python return roll("1d10")}`）
     - 未注册的 `@xxx` → 原样保留不报错；变量/路径不存在 → 原样保留
   - **进阶：条件切片**——当需要"按变量值从几段里就地选一段灌给正文"（如骰子分档、好感度阶梯提示词）时，**单条件真/假两大支**用 `${@condition 条件: 真输出 [else 假输出]}`（见上，`else` 可选，无 else 假→空），**多档位阶梯**（三档及以上）用 `${@python }` 代码块在解析阶段命中一段，未命中的分支不进入上下文。示例（每档一份独立设定文件，命中即物化整段）：
     ```
     ${@python return "{{.teahouse/dyn_settings/heartful-zhongqing.md}}" if 好感度 >= 80 else ("{{.teahouse/dyn_settings/heartful-xindong.md}}" if 好感度 >= 50 else "{{.teahouse/dyn_settings/heartful-chujian.md}}")}
     ```
     （等价的多行 if/elif/else 写法见下）`return` 的值也可以是别的占位符（`{{file:line}}`、`${变量}`），会继续被后续解析展开。也可写成多行块（旧裸写 `${ if... }` 仍兼容自动降级，等价）：
     ```
     ${
     if dice == 6:
         return "{{room1.md}}"
     else:
         return "{{room2.md}}"
     }
     ```
     注意：条件里引用的变量名必须不含空白字符（空格/tab/换行）；块内可调用白名单函数 `roll("1d6")` / `random(lo, hi)`。**排查用三态**：`@condition` 假条件 → 该位置变**空**（正常，分支不命中即不注入）；**坏块**（语法/越权/变量不存在）→ **整块原样残留**（说明写错，需改）。写出 payload 后检查是否有未展开的 `${ if... }` / `${@...}` 残留（残留=坏块）。

     **路径基准（重要）**：占位符里的文件路径一律**相对实例根目录**（而非项目根），必须带完整前缀、按实际目录层级写全（可视为"绝对路径"）。引用 `.teahouse/` 下的文件必须写 `.teahouse/output/floors/...` 这类完整前缀；漏写前缀等于指向一个不存在的路径，会**原样残留**。glob 是唯一允许省略 `.teahouse/` 的偷懒写法（引擎会自动补 `.teahouse/` 重试），其余切片请勿依赖此行为。

     **语法要点**：块内是**标准 Python**——字面量布尔必须写 `True`/`False`（大写，小写 `true` 是未定义名会整块残留）。**单行 if 链有引擎兜底但也最不抗造**：`if a: return x elif b: return y else: return z` 这种单行多分支，引擎会拿 token 驱动重写成合法多行（`_rebuild_single_line_if`），`:`/关键字在引号值内不会被误切——但前提是那行**原封不动**地进了 Python 解析。只要 YAML 引号层先动过手脚（见下节），文本走样后照样整块残留。所以踩坑经验仍是：**多分支一律写多行块**（`return "a" if cond else "b"` 这种单行三元可留），把容错面拉到最大，别依赖单行兜底。

     **YAML 引号与转义**：Generate 配置是 **YAML 文件**，占位符/条件块是写在这个文件里的字符串——YAML 的引号规则会**先于**占位符解析生效，内嵌引号常在这里二次破坏。两句实战经验：
     - **`\"` 反斜杠转义在 YAML 里几乎不生效**：双引号字符串里 YAML 才认 `\"`，普通块引号/单引号里反斜杠是字面量。与其跟转义搏斗，不如**直接写引号**——用 YAML 单引号 `'...'` 或块标量（`|`）包住整段，内嵌的双引号原样保留不冲突。只要"外层包装"与"内嵌引号"用了不同引号对，就不需要转义。
     - **优先"值引用"而非"引号锚点"**：当要按值从几段里选一段时，`return "{{xxx.md}}"`（整文件）最稳；需要部分截取时，让切片文件本身固定、靠条件块选文件，而不是在 return 内部写带引号的 `from=` 锚点截取。

     **锚点必须唯一（切片最容易踩的硬约束）**：`{{file|from="A"|to="B"}}` 的锚点是**子串 + 唯一匹配**——`_find_anchor_line` 要求锚点**恰好命中一行**才放行：找不到报「Anchor not found」，命中多行报「Anchor appears on multiple lines」；两类错误在宽松模式下都会让**整片占位符原样残留在 payload 里**（表现成该片设定没被注入）。所以写带锚点切片时有两条铁律：
     - **锚点在目标文件里必须唯一**：避免用它常出现的词句做锚点（人名、常用动作、章节号这类会重复的都不行）。要截一个 `## 章节` 或 `<标签>` 围起的段落，务必确认开/闭标签在全文件只出现一次。
     - **不要在文档正文里用「真实存在的锚点」做教学示例**：若文件开头写了段示例代码、恰以第一章锚点做例子，正文里又在用同一锚点截真实段落，锚点就变两份 → 切片失败。示例要么改用虚构/不存在的锚点占位名（如 `from="<!-- 示例锚点 -->"`），要么加英文注释标记成非真实引用。

     `roll(...)` 骰子支持 RPG 语法：`XdN`（如 `1d6`、`2d10`）、行末 `+N`/`-N` 修饰（如 `2d10+5`）、`k` 取最高（`4d6k3`）、`dl` 去最低（`4d6dl1`）、`r` 重骰 / `ro` 重骰一次（`3d6r1`）、`e`/`!` 爆炸、`p` 穿透；非法表达式会原样保留不报错。

     块内**可以定义局部变量**（仅本次块内有效，返回即弃，绝不写回沙盒变量），并可拼数字进文本。骰子结果存起来、再拼进返回句子时，用 `f-string` 插值数值、`{{切片}}` 放 f-string **外面**用 `+` 拼接（f-string 会把 `{{` 转义成字面 `{`，切片不能写在花括号内）：
     ```
     ${
     result = roll("1d6")
     if result >= 5:
         return f"当前骰子结果是{result}。" + "{{.teahouse/dyn_settings/encounter.md}}"
     else:
         return "未触发特殊遭遇"
     }
     ```
     局部变量只在本代码块作用域内有效，不能跨块复用。
   - 在最后一条 user 消息中填入用户的实际写作要求
   - 必要时添加伪造的 user/assistant 对话来破限或引导文风

3. **调用 Generate**（按上面的「输出路径」分流，配置 `source_file` 每章一份就地覆盖）：
   - **生成全文 / 重写**（直接落正文历史，触发打字机）：
     ```
     Generate(
       source_file: "temp/generate-config-{{N}}.yaml",
       path: ".teahouse/output/floors/floor-{{N}}-draft.md"
     )
     ```
   - **续写 / 大幅度改写**（先落 temp 不打字机，完成后再对比合并、落进 floors）：
     ```
     Generate(
       source_file: "temp/generate-config-{{N}}.yaml",
       path: "temp/draft-{{N}}.md"
     )
     ```

4. **返工时**：直接改 `temp/generate-config-{{N}}.yaml` 后再 Generate（不建多版本），产出同样就地覆盖。

### 步骤 8：落半正式稿（把正文交给前端展示）

- **生成全文 / 重写场景**：Generate 已直接写 `.teahouse/output/floors/floor-{{N}}-draft.md`，前端已自动展示，**无需 move**。
- **续写 / 大幅度改写场景**：Generate 产出的 temp 草稿定稿后，与现有稿件对比合并，再落为唯一半正式稿：

```
FileOps move temp/draft-{{N}}.md .teahouse/output/floors/floor-{{N}}-draft.md
```

半正式稿 `floor-N-draft.md` **每层唯一**——返工/修改时直接覆盖它（FileOps move 会覆盖已有同名目标）。它是前端在写稿过程中看到的正文版本。

### 步骤 9：通知用户并等待指示

通知用户查看产物（前端已自动展示 `floor-{{N}}-draft.md`）。等待用户进一步指示。

- **如果用户要求返工**：直接修改 `temp/generate-config-{{N}}.yaml`（或对应场景的产出）后再次生成，就地覆盖 `.teahouse/output/floors/floor-{{N}}-draft.md`（续写/改写场景需再对比合并后 move）。
- **如果用户要求修改这一层**：不要重新生成，直接对 `.teahouse/output/floors/floor-{{N}}-draft.md` 用 Edit 或 WriteLine 精确替换。除非用户明确要求重写。

### 步骤 10：用户确认后，交由沙盒转正（commitDraft）

**必须等用户明确确认满意后**，才执行转正。**转正不再是导演做 `FileOps move` + `GitCommit`**——改由沙盒 `Teahouse.commitDraft(N)`（host 侧的确定性闸门）一次性完成：

> 沙盒（本实例的 `.teahouse/output/sandbox/` 前端，如 input-bar.js）在用户点击「确认草稿可用」时调用 `Teahouse.commitDraft(N)`。它会：解析正文里的 `<!-- teahouse-vars: [...] -->` 变量块 → 应用变量 → 标记 msg 写回 → `floor-N-draft.md` 改名 `floor-N.md` → git 提交(type=floor) → 广播 `draft.committed`。

作为导演，你的职责是确保正文**末尾/文中**已正确产出 `<!-- teahouse-vars: [...] -->` 变量操作块（见下节「正文变量块约定」），并让用户理解转正由 front-end 触发，**不要自己 move + commit**。

如果用户通过对话要求"提交/定稿"，你可以提醒：转正是草稿页的「确认」按钮动作；若正文里没有需要生效的变量块，沙盒会直接转正（无变量操作）。

## 正文变量块约定（teahouse-vars）

正文可携带变量操作，**由正文 AI 在剧情变动处（文中/章节任意位置）就地书写**一个 HTML 注释块。转正（commitDraft）时由宿主一次性解析、应用、标记并 git 提交。约定源：`tests/teahouse-commit-draft-api.md`（v2）。

```html
<!-- teahouse-vars: [
  {"type": "set",   "name": "金币",  "value": 120},
  {"type": "add",   "name": "金币",  "value": -30},
  {"type": "append","name": "背包",  "value": {"type": "item", "name": "回血药"}},
  {"type": "pop",   "name": "背包",  "value": {"type": "item", "name": "生锈匕首"}},
  {"type": "x",     "name": "背包",  "index": 2, "value": {"type": "item", "name": "钥匙"}},
  {"type": "set",   "name": "当前状态", "value": "XXX感到不适，皱眉看着主角"}
] -->
```

### 语义

| `type` | 合法目标 | 语义 |
|---|---|---|
| `set` | boolean/string/number/array | 整体覆盖；name 不存在自动创建 |
| `add` | number | 现值 = 现值 + value；未设按 0 起加 |
| `append` | array | 尾部追加 value |
| `pop` | array | 按值移除第一个匹配 |
| `x` | array | index 处整体替换；index 可负；越界失败 |

- **顺序敏感**：数组从上到下逐条执行；同批按序叠加。
- **类型约束（硬）**：正文 bot 只维护 boolean/string/number/array 四类；**对象仅程序内用，正文 bot 不维护对象**（非要用只能 `set` 整体替换，非最佳实践）。
- **强类型与数值边界**：每个变量声明了类型（见 `正文变量维护.md` 清单的 `type` 列），`set` 值必须与类型相符；数值变量可有 `min`/`max`，`set`/`add` 写入自动夹取（超界压回边界，正文 AI 按剧情写期望值即可）。正文 AI 可用 `${@type 变量名}` 读取变量的类型（发送前展开），用 `${变量名}` 读值。
- **失败留痕**：转正时成功的 action 写 `"msg":"consumed"`，失败的写 `"msg":"error:<原因>"`，**全部保留不删**（导演借此看到哪些成功/失败及正文上下文）。带 `msg` 的 action 后续不再被消费。
- 变量变更需绑定单一时刻（转正那次 git 提交），故**不要在正文里反复改同一个块**；正式稿被 git 锁定，二次补解析仅处理"无 msg 的裸 action"。

### 导演如何保证正文产块

- 在 `generate-config-{{N}}.yaml` 的 **system 段**维护一段「章末/适当处用 teahouse-vars 块输出变量操作」的指令（正文 AI 真正读它），并给出上文表格的 type 语义 + 当前关键变量快照（名/值/类型）。
- 当前变量快照通常已实时注入系统提示词（no cache）。若正文 AI 需要更细的现值类型，用 `GetRuntimeVars(names=[...])` 喂给它；`Generate` 配置里也可直接写 `${@type 变量名}` 让其展开为类型。导演尽量在配置里帮 bot 建好「要更新的变量」白名单（含类型与边界），减少类型/命名错误。

## 注意事项

- **不要一次性塞入太多设定全文**——这会导致上下文过长。使用行号范围或锚点语法截取与当前剧情有关的关键部分。
- **最近章节的正文需完整塞入 Generate 请求中**——用 `{{glob:output/floors/floor-*.md:lastN}}` 自动取窗口，并按归档界判断哪些已被总结覆盖。
- **如果用户的要求是续写**，你应该先检查 `.teahouse/output/floors/` 中的草稿状态。
- **如果用户要求修改某一层**，不要重新生成，使用 Edit 或 WriteLine 对对应 floor 文件精确替换；除非用户明确要求重写。
- **半正式稿每层唯一**：返工覆盖而非累加新文件。
