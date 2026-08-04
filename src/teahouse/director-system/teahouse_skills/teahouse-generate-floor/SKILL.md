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

正文「输出」即**文件落盘**：正文历史唯一来源是 `.teahouse/output/floors/`。半正式稿 `floor-N-draft.md`（每层唯一，就地覆盖）是写稿过程中的可见输出；满意后重命名为 `floor-N.md` 即为定稿。前端监听导演的工具调用后自动刷新读取，无需任何推送工具。

## 目录约定

- `temp/` — 真草稿（多版本、多块拼接，创作过程中间产物）
- `.teahouse/output/floors/` — 上下文引擎正文历史（半正式稿 + 定稿），每层最多一份，就地覆盖
  - `floor-N-draft.md` — 半正式稿（创作过程中）
  - `floor-N.md` — 正式定稿（满意后 rename）

## SOP

### 步骤 0：检查文件夹和文件结构

检查以下目录和文件，如果不存在则创建：

```
FileOps mkdir variables/
FileOps mkdir settings/
FileOps mkdir temp/
FileOps mkdir .teahouse/output/floors/
```

检查并创建变量系统文件（如果不存在）：

- `variables/active-vars.yaml` — 所有当前变量
- `variables/key-vars-change-log.yaml` — 重要的变量变更历史
- `variables/vars-manager.md` — 描述哪些变量值得被记录，哪些变量在变动时应该留下变更历史

对于 `vars-manager.md`：
- 先 Read `settings/` 中的设定文件，了解故事的世界观和角色体系
- 基于设定内容，生成适合本故事的变量管理规则
- 如果没有设定文件或设定内容很少，则创建空文件即可

### 步骤 1：理解楼层配置

`teahouse.md` 已注入系统提示词。关注其中的楼层字数目标、最大/最小字数限制，以及**归档界**（已总结到哪一层）。

### 步骤 2：创建任务清单

使用 TodoWrite 工具创建任务清单，追踪正文生成的各个步骤。

### 步骤 3：阅读前文，理解剧情

正文历史位于 `.teahouse/output/floors/`，按楼层数字排序：

```
Glob .teahouse/output/floors/floor-*.md   → 列出所有楼层/草稿
Glob summary/sum-*.md                     → 列出所有总结
```

**阅读策略：**

- **最近楼层**：优先用 `{{glob:output/floors/floor-*.md:last10}}` 一次性注入最近 10 层正文（按楼层数字自动升序、正式稿优先于草稿）。如需精读某层，用 Read 直接读文件。
- **更早楼层（已被总结覆盖）**：阅读 `summary/sum-*.md` 总结，不必逐层读原文。
- 归档界标记在 `teahouse.md` 全局变量区——超过归档界、未被总结覆盖的楼层，正文必须进上下文；被总结覆盖的楼层看总结即可。

充分理解用户的创作意图、叙事风格和当前剧情走向。

### 步骤 4：了解当前变量状态

```
Read variables/active-vars.yaml
Read variables/key-vars-change-log.yaml
Read variables/vars-manager.md
```

理解当前变量系统中记录的所有状态。如果某些变量对当前剧情很重要，且 `key-vars-change-log.yaml` 中有其变更历史，则还应阅读变更时对应章节的正文，获取更多细节。

### 步骤 5：阅读相关设定

基于前文和用户的意图，从 `settings/` 文件夹里阅读可能与这段剧情有关联的设定。使用 Glob 探索设定文件：

```
Glob settings/**/*
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

1. **复制配置模板**：
   - 如果是首次创作：复制 `settings/generate-config-default.yaml` → `temp/generate-config-{{N}}-1.yaml`
   - 如果是续写：复制上一楼层的 config（如 `temp/generate-config-{{N-1}}-1.yaml`）→ `temp/generate-config-{{N}}-1.yaml`

2. **编辑配置文件**（使用 Edit 工具进行精确修改）：
   - 用 `{{glob:output/floors/floor-*.md:lastN}}` 注入最近 N 层正文（N 由归档界窗口决定，一般 10；被总结覆盖的早期楼层用 `{{summary/sum-*.md}}` 而非逐层）
   - 更新设定引用范围（基于当前变量值调整锚点/行号）
   - 在 user 消息中填入当前的变量状态描述（基于 `variables/active-vars.yaml`）
   - 在最后一条 user 消息中填入用户的实际写作要求
   - 必要时添加伪造的 user/assistant 对话来破限或引导文风

3. **调用 Generate**（真草稿落 temp，多版本并存供返工）：
   ```
   Generate(
     source_file: "temp/generate-config-{{N}}-1.yaml",
     path: "temp/draft-{{N}}-1.md"
   )
   ```

4. **返工时**：版本号递增，如 `temp/generate-config-{{N}}-2.yaml` → Generate → `temp/draft-{{N}}-2.md`

### 步骤 8：落半正式稿（把正文交给前端展示）

Generate 产出的 temp 真草稿定稿后，落为唯一半正式稿，前端即可自动刷新展示：

```
FileOps move temp/draft-{{N}}-{{V}}.md .teahouse/output/floors/floor-{{N}}-draft.md
```

半正式稿 `floor-N-draft.md` **每层唯一**——返工/修改时直接覆盖它（FileOps move 会覆盖已有同名目标）。它是前端在写稿过程中看到的正文版本。

### 步骤 9：通知用户并等待指示

通知用户查看产物（前端已自动展示 `floor-{{N}}-draft.md`）。等待用户进一步指示。

- **如果用户要求返工**：版本号递增生成新的 temp 草稿（draft-{{N}}-2.md）后，再次 FileOps move 覆盖 `.teahouse/output/floors/floor-{{N}}-draft.md`。
- **如果用户要求修改这一层**：不要重新生成，直接对 `.teahouse/output/floors/floor-{{N}}-draft.md` 用 Edit 或 WriteLine 精确替换。除非用户明确要求重写。

### 步骤 10：用户确认后，正式定稿并 Git 提交

**必须等用户明确确认满意后**，才执行定稿与提交：

1. 将半正式稿重命名为正式定稿：
   ```
   FileOps move .teahouse/output/floors/floor-{{N}}-draft.md .teahouse/output/floors/floor-{{N}}.md
   ```

2. 执行 Git 提交：
   ```
   GitCommit(type="floor", number={{N}}, message="简短描述")
   ```

## 注意事项

- **不要一次性塞入太多设定全文**——这会导致上下文过长。使用行号范围或锚点语法截取与当前剧情有关的关键部分。
- **最近章节的正文需完整塞入 Generate 请求中**——用 `{{glob:output/floors/floor-*.md:lastN}}` 自动取窗口，并按归档界判断哪些已被总结覆盖。
- **如果用户的要求是续写**，你应该先检查 `.teahouse/output/floors/` 中的草稿状态。
- **如果用户要求修改某一层**，不要重新生成，使用 Edit 或 WriteLine 对对应 floor 文件精确替换；除非用户明确要求重写。
- **半正式稿每层唯一**：返工覆盖而非累加新文件。
