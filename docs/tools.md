# 导演工具集

导演 (Director) 是执行编排流程的 AI 主体。本文档定义导演可用的工具集。

## 工具设计原则

1. **每个工具职责单一**——不做"智能"的复合操作，让导演自己编排
2. **工具契约保证一致性**——成功/失败明确返回，失败时状态不变
3. **增量操作优先**——尽量避免全量读写，减少上下文消耗
4. **所有操作可审计**——工具的调用记录本身就是操作日志

## 文件操作工具

### Read

读取文件内容，支持指定范围。

```
Read(path, [offset], [limit])
→ 文件内容（或指定行范围）
```

用途：加载设定、查看楼层正文、查阅 change log、读取 skill 内容。

### Write

写入文件内容（覆盖式）。

```
Write(path, content)
→ 成功/失败
```

用途：创建新的楼层文件、更新 current/draft.md、创建新 skill。
注意：Write 是覆盖写入，不是追加。追加内容使用 Edit。

### Edit

对现有文件执行精确字符串替换。需指定 `old_string` 和 `new_string`，工具会验证 `old_string` 在文件中唯一且匹配。

```
Edit(path, old_string, new_string)
→ 成功/失败（失败时文件状态不变）
```

用途：修正楼层内容、更新变量文件中的特定字段、修改 skill 配置。

**关键特性**：
- Harness 会追踪文件状态，Edit 成功后导演无需重新 Read 验证
- 如果文件被外部修改导致 old_string 不匹配，工具会报错
- 支持 `replace_all` 模式批量替换

### Glob

按模式匹配文件路径。

```
Glob(pattern)
→ 匹配的文件路径列表
```

用途：列出楼层文件、查找 change log、搜索设定文件、列举可用 skill。

## 变量系统工具

### MemorySearch

语义搜索变更日志，返回包含查询内容的变更记录及文件路径。

```
MemorySearch(query)
→ 变更记录列表（含文件路径和行号）
```

用途：在需要回忆某个变量变更细节时使用。

### VariableDiff

对比当前变量与指定版本的差异。

```
VariableDiff(from_version, to_version)
→ 变更列表
```

用途：查看自上次总结以来变量系统的变化。

### VariableHistory

查询特定关键变量的完整变更历史。

```
VariableHistory(variable_path)
→ 按时间排序的变更记录
│   └─ 每个记录包含：文件位置、变更前后值、原因、发生楼层
```

用途：了解某个变量从故事开始到现在的完整演变。

## 生成工具

### Generate

调用最强模型生成正文。

```
Generate(prompt, context, [params])
→ 生成内容
```

参数：
- `prompt`：生成指令（通常来自 skill 的 prompt.md）
- `context`：已组装的上下文（设定 + 变量 + 前文）
- `params.model`：使用的模型（默认最强模型）
- `params.temperature`：温度参数
- `params.max_tokens`：最大输出长度

### Refine

调用轻量模型对正文进行修正。

```
Refine(text, instruction)
→ 修正后的文本
```

用途：格式修正、拼写检查、一致性微调。

### Judge

评估生成内容的质量，返回评分和问题列表。

```
Judge(text, criteria)
→ {pass: boolean, issues: string[], score: number}
```

用途：一致性检查（角色眼睛颜色是否一致）、格式检查、质量评估。

## Skill 管理工具

### SkillList

列出实例中所有可用 skill。

```
SkillList()
→ skill 名称和路径列表
```

### SkillRead

读取指定 skill 的内容。

```
SkillRead(skill_name)
→ skill 的完整内容（prompt + examples + 参考资料）
```

### SkillCreate

在实例中创建新 skill。

```
SkillCreate(name, content)
→ 成功/失败
```

### SkillExport

将 skill 导出为可复用的包。

```
SkillExport(skill_name, output_path)
→ 文件路径
```

## 版本控制工具

### GitCommit

执行一次 git 提交（`git add -A && git commit`），锁定当前实例所有文件的状态。

```
GitCommit(message)
→ {commit_hash, branch, files_changed}
```

- `message`：提交信息，建议格式 `floor-NNN: 简短描述`

用途：楼层完成或总结时提交。每次调用会自动暂存所有变更（`git add -A`），无需手动指定文件列表。

### GitBranch

分支管理操作，用于剧情分支存档和回档。

```
GitBranch(action, [name])
→ {action, [branches], [name], [current_branch]}
```

参数：
- `action`：`list` / `create` / `switch` / `delete`
- `name`：分支名（create/switch/delete 时需要）

- `list`：列出所有分支，标记当前分支
- `create`：基于当前 HEAD 创建新分支
- `switch`：切换到已有分支（会改变实例目录下所有文件的版本，sessions/ 已移出版本控制）
- `delete`：删除分支（安全模式，未合并时拒绝）

### GitLog

查看提交历史。

```
GitLog([limit])
→ [{hash, author, date, message}]
```

用途：确认楼层计数、查看总结历史。

## 上下文管理工具

### ContextStatus

查看当前上下文的统计信息。

```
ContextStatus()
→ {loaded_summaries: int, loaded_floors: int, total_tokens: int, last_summary: string}
```

用途：帮助导演判断是否需要触发总结。

### MemoryRecall

加载指定文件的全部内容到上下文。

```
MemoryRecall(path)
→ 文件内容
```

用途：按需加载 settings/ 中的设定文件、全文阅读某个楼层、加载 skill。

## 实例管理工具

### InstanceInfo

查看当前实例的信息。

```
InstanceInfo()
→ {instance_id, prototype_name, created_at, current_floor}
```

### PrototypeLink

查看与当前实例关联的原型信息（只读，实例化后不跟随更新）。

```
PrototypeLink()
→ {prototype_name, version, description, creator}
```

## 工具调用编排模式

### 典型楼层生成编排

```
1.  InstanceInfo()                                  → 确认实例和当前楼层
2.  MemoryRecall("settings/world.yaml")             → 加载世界观
3.  MemoryRecall("settings/characters.yaml")         → 加载角色设定
4.  SkillRead("generate-floor")                     → 加载正文生成 skill
5.  MemoryRecall("variables/active.yaml")            → 加载当前变量
6.  Read("logs/summaries.yaml", offset=-7)           → 最近总结
7.  Glob("floors/floor-{NNN..MMM}.md")              → 最近楼层列表
8.  Read("floors/floor-NNN.md")                      → 加载最近正文
    →  上下文组装完成
9.  Generate(组装内容, skill中的prompt)               → 生成
10. Judge(生成内容, 一致性检查)                       → 自查
11. [如需修正] Refine(生成内容, 格式修正)              → 修正
12. Write("floors/floor-NNN.md", 最终版)             → 写入文件
13. GitCommit("floor-NNN: 描述")                     → 提交
14. [如需总结] 读取所有未总结楼层 → 加载summarize skill → 更新变量 → 总结提交
```

### 典型查询编排

```
1. MemorySearch("林月的修为")                  → 找到变更记录
2. Read("logs/change-log/summary-002.yaml")    → 查看变更详情
3. [如需更多背景] Read("floors/floor-005.md")  → 查看原文
```

## 工具与 Claude Code 的对应关系

| Teahouse 工具 | Claude Code 对应 | 差异 |
|---|---|---|
| Read | Read | 基本相同 |
| Write | Write | 基本相同 |
| Edit | Edit | 基本相同 |
| Glob | Glob | 基本相同 |
| MemorySearch | memory_search (OpenClaw) | 语义搜索变更日志 |
| Generate | — | 调用最强模型生成正文 |
| Refine | — | 调用轻量模型修正 |
| Judge | — | 质量评估 |
| SkillList | — | 列举可用 skill |
| SkillRead | — | 读取 skill 内容 |
| SkillCreate | — | 创建新 skill |
| SkillExport | — | 导出 skill |
| GitCommit | git commit | 结构化提交信息 |
| GitLog | git log | 带楼层计数感知 |
| ContextStatus | — | 上下文健康检查 |
| MemoryRecall | Read | 加载文件到上下文 |
| InstanceInfo | — | 实例信息 |
| PrototypeLink | — | 关联原型信息 |
