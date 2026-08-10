---
name: teahouse-summarize
description: 教导导演如何执行总结流程，包括上下文压缩、设定更新、变量更新、流水账落盘。归档界由后端在 GitCommit(type=summary) 时自动维护于 .teahouse/dyn_settings/summary/index.json。当满足总结触发条件时（建议每 7 层一次），或用户手动要求总结时触发。
---

# 总结归纳 Skill

教导导演如何执行总结流程。总结通过**更新设定与变量**完成上下文压缩，并把**流水账文本**落在 `.teahouse/dyn_settings/summary/` 供导演回溯深挖设定用。

## 适用时机

当满足总结触发条件时（建议每 7 层一次，最多不超过 10 层），或用户手动要求总结时，加载本 skill。

## 方法论

总结的核心目标：**压缩旧内容，为后续剧情保持连贯性**，同时推进「归档界」让 `{{glob:...:lastN}}` 上下文窗口随之缩小。

**关键原则**：
- 总结的**产物**（改设定 + 改变量 + 流水账）——设定/变量持续影响后续生成，流水账只作导演回溯参考。
- 总结的**结果**（流水账文本）**不入正文 Bot 上下文**。正文模型不靠总结文本，而是靠**设定切片**（`.teahouse/dyn_settings/...` 锚点）承载对过去的记忆，由提示词层弥合。正文可见性由创作者用 yaml 配置决定，引擎不强制。
- **归档界**（已总结到哪一层）由后端在每次 `GitCommit(type="summary", start, end)` 时自动写入根 `.teahouse/dyn_settings/summary/index.json` 的 `summarized_through`，导演无需手改。窗口只回溯未总结楼层。
- **区分"给正文 Bot 看的"与"给未来溯源看的"**：正文 Bot 只吃到 Generate 配置（`.teahouse/generate-config/*.yaml`）实际切片注入的那部分设定/变量；反之，流水账、变量变更记录、`${!-- ... --}` 注释之类只供你自己回溯。改动前先判断这块内容属于哪一侧——不要为了溯源方便把元信息写进正文 Bot 会读取的设定里，也不要以为不在生成配置覆盖范围内的设定改动会影响正文。
- **结构稳定 > 内容更新**：正文 Bot 的上下文靠 Generate 配置文件里的切片锚点按**既有结构**提取组成——`.teahouse/generate-config/*.yaml` 决定"拿哪些设定、按什么顺序拼"。因此总结时**可以改设定/变量的内容，但不得破坏结构**：不得新增/删除变量键，不得新增/删除动态设定板块、改切片锚点或重构 yaml。

## 文件命名规范

流水账存放于 `.teahouse/dyn_settings/summary/` 目录下，命名格式为 `sum-A-B.md`；归档界索引 `.teahouse/dyn_settings/summary/index.json` 由后端自动维护（`summarized_through` + entries）。

- `.teahouse/dyn_settings/summary/sum-1-7.md` — 覆盖第 1 到第 7 层的流水账
- `.teahouse/dyn_settings/summary/sum-8.md` — 仅覆盖第 8 层的流水账（A == B 时简写为单数字）
- `.teahouse/dyn_settings/summary/index.json` — 代码维护的归档界索引，不要手改

## SOP

### 步骤 1：了解总结配置

`teahouse.md` 已注入系统提示词。关注其中：
- 建议总结频率、最大不总结层数
- 是否有自定义的总结模板/规范（如有则优先使用）

### 步骤 2：确定总结范围

```
Read .teahouse/dyn_settings/summary/index.json            → 权威归档界（summarized_through）+ 已有流水账索引
Glob .teahouse/output/floors/floor-*.md   → 列出所有楼层/草稿
```

从 `.teahouse/dyn_settings/summary/index.json` 的 `summarized_through` 读上次总结的结束楼层（代码在每次 GitCommit(type=summary) 时自动维护），结合最新楼层编号确定本次总结范围（上次 end + 1 起）。旧的 `sum-*.md` 文件名数字不再作为归档界来源。

**重要规则**：
- **每一次总结最多覆盖 10 章**。如果用户要求一次性总结超过 10 章，应拆分为多个总结文件，每个覆盖不超过 10 章
- 例如：要求总结 1~23 章 → 创建 `.teahouse/dyn_settings/summary/sum-1-10.md`、`.teahouse/dyn_settings/summary/sum-11-20.md`、`.teahouse/dyn_settings/summary/sum-21-23.md`，并分别 `GitCommit(type="summary", ...)`

### 步骤 3：阅读待总结的楼层

```
Read .teahouse/output/floors/floor-031.md
Read .teahouse/output/floors/floor-032.md
...
```

阅读本次需要总结的所有楼层（`.teahouse/output/floors/`），理解剧情走向和关键变化。

### 步骤 4：构造总结内容

**总结模板**：优先使用 `teahouse.md` 或用户提供的总结结构。如果没有，则使用以下默认规范：

每条总结的核心主旨：**为后续剧情的连贯性服务**。

每条默认规范：
- 每个章节一般为 50 字左右
- 可根据章节信息熵灵活调整——信息密度低的章节可跳过（0 字），关键章节可扩展至 200 字
- 如果多个章节有很明显的关联（如连续 5 个章节都是同一场战斗），可放在一起总结，简要说明参与者、消耗了什么、造成什么结果即可
- 战斗中角色间的关键对话、重要决策等对后续剧情有影响的细节仍需提炼

总结内容格式（Markdown）：
```markdown
## 总结 sum-A-B

### 第 A~B 章概述
（简短的总体概述，一段话）

### 逐章/逐段总结
- **floor-A**：...
- **floor-B**：...
```

### 步骤 5：更新设定（关键！）与变量

**先读生成配置，再谈改动。** 正文 Bot 不读总结文本，它靠**设定切片**记住过去；而这些切片由 `.teahouse/generate-config/*.yaml`（发给正文 Bot 的配置文件）按既有结构组织。动手前先：

```
Read .teahouse/generate-config/*.yaml    → 看正文 Bot 到底"吃"进哪些设定、按什么顺序拼、引用了哪些变量
```

基于此文件界定本次改动的作用范围与必要性——只有真正被正文 Bot 引用、或后续提炼需要的状态才值得沉淀。**不要做无用功**：不在生成配置覆盖范围内的内容，正文 Bot 看不见，改动它不产生效果，先想清楚它是否应落到"溯源侧"而非设定。

#### 结构稳定约束（最高优先，防止破坏上下文）

下面几点是硬性约束，源于正文 Bot 上下文靠结构提取、变量靠既有引用语法取值：

- **变量只改值，不增删键**。`SetRuntimeVar` 只对既有变量更新数值/描述；**不得新增变量**（新增的键没有引用方，用不上）也**不得删除变量键**（缺失引用会破坏正文取值）——除非创作者明确要求新增/删除。
- **动态设定只改内容，不动结构**。就地更新既有板块/锚点里的内容；**不新增/删除板块、不改切片锚点、不重构** `.teahouse/dyn_settings/` 与 `.teahouse/generate-config/*.yaml` 的结构——除非创作者明确要求。
- **确有必要扩结构时，先征求同意**。如果你判断需要新增一个动态设定板块，或调整 `.teahouse/generate-config/` 的 yaml（例如为应对长期剧情新增一个设定切片），**不允许自行执行**——必须把改动方案（新建哪个板块 / 锚点放哪个文件 / 为什么正文 Bot 需要它）列出来给用户过目，**获得明确同意后才可修改**。

#### 变量 vs 设定的边界

- **变量**（`SetRuntimeVar` 管理）：高度精炼、会频繁变动的数值/重要值（`金币`、`修为`、`好感度`）。核心变量注入系统提示词（no cache）。**只改既有键的值，不新建键**。
- **动态设定**（`.teahouse/dyn_settings/` 文件管理）：较长、中短期生效的文字状态——人物关系变化、任务进展、二人闹别扭等。会随剧情变，但**不是变量**，用 Write/Edit/WriteLine 就地维护对应板块/锚点，识别到变化时就地更新内容。**只在既有结构内改**。

#### 临时设定：纳入动态设定，注释标注生效周期

新出现的、非长期状态（一次事件挂起、某个临时的悬念/条件、预计会结束的剧情因子），**统一归入动态设定的既有结构**，不要另起变量、也不要擅自开新模式。

- 在其中用注释语法 `${!-- ... --}` 标注**生效周期与到期清理提醒**（如 `${!-- 临时设定：青云山封印松动，持续到主角取回钥匙（计划 floor-01x 前清理） --}`）。注释正文 Bot 不可见，仅你在 Read 时可见并据此周期清理。
- 对**已到生效周期**的临时设定，在总结时**主动清理**——就地删除或改写为已终态，不留失效残留。若清理涉及删除既有板块结构，同样遵循上方"结构稳定"约束：确需删则先征求同意。

#### 变量操作

对于每个数值型状态变更，用 `SetRuntimeVar` 合并写入（只更新既有键的值）：

```
SetRuntimeVar(updates={"金币": 140, "修为": "炼气四层", "主线进度": "青云山试炼完成"})
```

范围/变更历史如需留档（便于跨楼层追踪"何时因何变了多少"），可在 `.teahouse/dyn_settings/` 下维护一份可选的变量变更记录文件（如 `.teahouse/dyn_settings/variable-change-log.md`）并用 Edit 追加。这是可选的，且它属"溯源侧"——不要把它写进正文 Bot 会读取的设定文件。通常直接把变更写进既有设定与正文即可。

#### 清理无用变量

用 `GetRuntimeVars()` 读全部变量，结合对故事的理解审视是否出现过期变量。**只允许对确认已失效的键覆盖为合理值；是否删除键遵循上方"变量只改值不含/删键"约束**——确需删则先征求用户同意。不确定时保留，宁可多留也不要误删。

### 步骤 6：写入流水账（导演回溯参考）

```
FileOps mkdir .teahouse/dyn_settings/summary/ → 确保存在
Write .teahouse/dyn_settings/summary/sum-A-B.md     → 写入流水账文本
```

如果拆分为多个摘要，每个写入独立文件。

> ⚠️ 流水账仅供导演回溯深挖设定用，**不会进入正文 Bot 的上下文**。对后续剧情真正重要的是你在步骤 5 里更新出的 `.teahouse/dyn_settings/` 设定与 `.teahouse/runtime_vars.jsonl` 变量。正文 Bot 看「最近 N 章正文 + 动态设定 + 变量」即可；若创作者想在自己的 yaml 配置里引用 summary 也行——正文可见性由创作者自己决定，引擎不强制。

### 步骤 7：Git 提交（归档界由后端自动维护）

```
GitCommit(type="summary", start=A, end=B, paths=[".teahouse/dyn_settings", ".teahouse/generate-config"], message="简短描述")
```

**务必带 `paths=[".teahouse/dyn_settings", ".teahouse/generate-config"]`**：总结会话改动（动态设定 + 流水账 + 归档界 index）在本目录下；`.teahouse/generate-config/` 的生成配置若随剧情重组也会在本轮变。带上这两个路径确保本轮提交**只提交总结自己的改动**，不会把主会话尚未提交的楼层/变量改动卷进来——这是总结子会话能与前台游玩**并行**、互不污染的关键。提交前可先 `GitStatus` / `GitDiff(staged=true)` 自查本次 stage 的内容。

> git 只提交 `paths` 里**实际有变**的文件：若本轮生成配置没改（动态设定切片由 dyn_settings 承载、generate-config 常年不动），git 自动跳过它，不会产生空改动提交。提交前用 `GitDiff(staged=true)` 确认 stage 的正是你想提交的那几个。

> 🚫 总结**不修改** `static_settings/`（根目录，长期静态设定，已被 gitignore）。它是背景板级常量，跟剧情无关，交给你只读引用（`{{static_settings/...}}` 切片），不要写它。

提交时后端会自动执行两件事：
1. 把 `.teahouse/dyn_settings/summary/index.json` 的 `summarized_through` 推进到 **B**（覆盖楼层含端点），
2. 追加一条流水账索引 entry `{start, end, file}`。

你无需手改 `teahouse.md` 里的归档界——它已经由代码自动维护。**唯一要保证的是 start/end 填对**（与 `sum-N-M.md` 覆盖范围一致），因为后端信任你上报的 `end`。后续 `{{glob:output/floors/floor-*.md:lastN}}` 的窗口计算会自动读该索引只回溯未总结楼层。

如果有多个摘要范围，每个单独一次 GitCommit。总结不是楼层，不增加楼层计数。

## 注意事项

- **归档界在 `.teahouse/dyn_settings/summary/index.json`，由代码自动推进**，不要手改 `teahouse.md` 的 `summarized_to`（已退役）。
- `sum-*.md` 名字里的数字现在**只作文档/文件名**，后端统计不再靠它推导归档界——所以名字可稍随意，但仍建议按规范命名便于人读。

- 总结不是楼层，不增加楼层计数
- **总结产物是「改设定+改变量+流水账」三件事**——流水账不进正文 Bot 上下文，别指望它直接喂给正文模型
- **结构稳定优先于内容更新**：改设定/变量内容可以，增删任何结构必须克制。正文 Bot 上下文靠 `.teahouse/generate-config/*.yaml` 的既有切片锚点组装、变量靠既有引用语法取值——新键/新板块没有引用方就是无用功，删键/删板块会破坏既有引用。除非用户明确要求，不做结构性增删。
- 需要新增动态设定板块或改动 `.teahouse/generate-config/*.yaml` 时，**先列方案给用户过目，获同意才改**；临时设定归入既有动态设定结构，用注释标注生效周期，周期一到主动清理。
- 不要在总结中遗漏重要变量/设定变更——宁可多记也不要漏记
- 如果某个变量在本轮总结中没有变化，保持原值不变
- 变量值是自然语言描述，不追求结构化，但要准确
- 清理变量时务必谨慎：阅读变量的作用域和相关章节，确认已失效才清理；不确定时保留。是否删除键同样遵循"变量只改值不含/删键"约束，确需删则先征求同意
