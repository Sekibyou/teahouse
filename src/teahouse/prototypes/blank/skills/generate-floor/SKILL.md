---
name: generate-floor
description: 教导导演如何生成正文楼层，包括上下文准备和 Generate 工具的使用。当用户要求"开始写下一层"或"继续写作"时触发。
---

# 正文生成 Skill

教导导演如何撰写正文楼层。

## 适用时机

当用户要求"开始写下一层"或"继续写作"时，加载本 skill。

## 方法论

正文生成的核心思路：**先理解当前状态，再构造写作请求**。你不是自己写正文，而是通过 Generate 工具让正文 AI 来写。你的职责是提供准确、完整的上下文。

## SOP

### 步骤 1：了解全局配置

```
Read teahouse.md
```

关注：楼层字数目标（约 3000 字）、最小/最大字数限制。

### 步骤 2：加载角色和世界观设定

```
Read settings/characters.yaml
Read settings/world.yaml
```

需要理解当前活跃的角色、他们的关系和当前处境，以及故事世界的基础设定。

### 步骤 3：了解当前变量状态

```
Read variables/active.yaml
```

变量包含故事中需要追踪的所有信息——角色关系、势力状态、关键物品位置等。

### 步骤 4：阅读前文

```
Glob floors/floor-*.md       → 列出所有楼层
Glob floors/sum-*.md         → 列出所有总结
```

**阅读策略：**

- **最近 10 层**：必须阅读**原文**。这是保持剧情连贯性的核心。
- **第 11~50 层**：阅读**总结**（`sum-*.md`），不必逐层读原文。如果某次总结覆盖了这些楼层，阅读对应的 `sum-*.md` 即可。
- **超过 50 层之前**：通常不需要回顾，除非涉及跨章节的伏笔或角色复出。

使用行号范围或锚点语法截取关键部分，不要一次性塞入全文。如果用户指定了某一层，也需阅读。

### 步骤 5：检查是否有未完成的草稿

```
Read temp/draft.md
```

如果有未完成的草稿（非空），说明当前正在续写某层，应在此基础上继续。

### 步骤 6：构造 Generate 请求

使用 Generate 工具发送正文写作请求，生成位置为 `temp/draft-{{当前楼层+1}}-1.md`。

messages 结构示例：

```json
[
  {
    "role": "system",
    "content": "你是一位小说创作AI。\n字数要求：约3000字。\n风格要求：保持与前文一致的叙事风格。\n请将正文写入 temp/draft-{{N}}-1.md"
  },
  {
    "role": "user",
    "content": "## 设定\n{{settings/characters.yaml|from=\"当前活跃角色\"}}\n\n## 当前状态\n{{variables/active.yaml}}\n\n## 前情提要\n{{floors/floor-050.md:1-20}}\n\n请开始写第51层。"
  }
]
```

使用 `{{path}}` 占位符引用文件内容，后端会自动替换为实际内容。

### 步骤 7：输出到前端

生成完成后，使用 Output 工具将正文推送到前端：

```
Output(
  content: "{{temp/draft-{{N}}-1.md}}",
  label: "ep{{N}}",
  note: "第{{N}}章正文第一版",
  mode: "append"
)
```

label 必须遵循 `teahouse.md` 中约定的命名规则：以 `ep` 开头接数字（如 `ep1`、`ep51`）。前端会自动提取 ep 块并展示最高编号章节。

### 步骤 8：通知用户并等待指示

通知用户查看产物。等待用户进一步指示。

- 如果用户要求返工：生成 `temp/draft-{{N}}-2.md`（编号递增），然后使用 Output replace 更新：
  ```
  Output(
    content: "{{temp/draft-{{N}}-2.md}}",
    label: "ep{{N}}",
    note: "第{{N}}章正文第二版",
    mode: "replace",
    target_uuid: "<之前 append 返回的 uuid>"
  )
  ```
- 如果用户确认提交：将 draft 文件移动到 `floors/` 文件夹，按楼层编号重命名为 `floor-{{N}}.md`。移动后使用 Output replace 将内容路径更新为新路径：
  ```
  Output(
    content: "{{floors/floor-{{N}}.md}}",
    label: "ep{{N}}",
    note: "第{{N}}章正文（已提交）",
    mode: "replace",
    target_uuid: "<之前 append/最后一次 replace 返回的 uuid>"
  )
  ```
  然后执行 `GitCommit(type="floor", number={{N}}, message="简短描述")` 提交。提交后实例内的 `floors/`、`variables/` 等所有变更将被锁定。如需创建剧情分支，使用 `GitBranch("create", "branch-name")`。

## 注意事项

- 不要一次性塞入太多楼层全文——这会导致上下文过长。使用行号范围或锚点语法截取关键部分。
- 如果楼层需要续写，在 user 消息末尾加上"请继续上一段的内容"。
- 如果用户要求修改某一层，不要重新生成，使用 Edit 工具进行精确替换。
