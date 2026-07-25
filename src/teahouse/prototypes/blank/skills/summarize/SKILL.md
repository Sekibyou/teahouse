---
name: summarize
description: 教导导演如何执行总结流程，包括上下文重组和变量更新。当满足总结触发条件时（建议每 7 层一次），或用户手动要求总结时触发。
---

# 总结归纳 Skill

教导导演如何执行总结流程，包括上下文重组和变量更新。

## 适用时机

当满足总结触发条件时（建议每 7 层一次，最多不超过 10 层），或用户手动要求总结时，加载本 skill。

## 方法论

总结的核心目标：**压缩旧内容，提取关键信息，更新变量状态**，为导演的下一阶段工作准备好干净、精简的上下文。

## SOP

### 步骤 1：了解总结配置

```
Read teahouse.md
```

关注：建议总结频率、最大不总结层数。

### 步骤 2：确定总结范围

```
Glob logs/summaries.yaml      → 查看上次总结的位置
Glob floors/floor-*.md         → 列出所有楼层
```

计算自上次总结以来新增的楼层范围。例如：上次总结在 floor-030，当前最新是 floor-037，则需总结 floor-031~037。

### 步骤 3：阅读待总结的楼层

```
Read floors/floor-031.md
Read floors/floor-032.md
...
```

阅读本次需要总结的所有楼层，理解剧情走向和关键变化。

### 步骤 4：构造总结内容

生成一段对新增楼层的概括性总结，包含：主要剧情推进、角色变化、关键事件。

### 步骤 5：更新变量

基于新增楼层的内容，识别变量变更：
- **关键变量变更**（需留 change log 的）：如角色关系重大转变、势力格局变化等
- **普通变量变更**：如角色位置、当前任务等

对于每个变更：
1. 更新 `variables/active.yaml` 中的当前值
2. 如果是关键变量，追加一条记录到 `logs/change-log/`，包含：变更前后值、变更原因、发生楼层

### 步骤 6：写入总结文件

```
Read logs/summaries.yaml         → 确认现有格式
Edit/Write logs/summaries.yaml   → 追加本次总结
```

### 步骤 7：写入变更日志

```
Write logs/change-log/summary-NNN.yaml   → 写入本次所有关键变量变更
```

### 步骤 8：Git 提交

```
GitCommit("summary-NNN: 覆盖楼层 M~N 的总结")
```

## 变量变更记录的格式

关键变量变更记录格式：

```yaml
changes:
  - variable: "characters.A.attitude_toward_B"
    label: "林月对苏然的信任"
    type: core
    changed_from: "敌视，认为苏然是叛徒"
    changed_to: "开始信任，但仍保留一丝警惕"
    reason: "苏然在战斗中救下了林月的同伴"
    trigger_floor: 33
```

普通变量只需更新 `variables/active.yaml` 中的当前值，不留日志。

## 注意事项

- 总结不是楼层，不增加楼层计数
- 不要在总结中遗漏重要变量变更——宁可多记也不要漏记
- 如果某个变量在本轮总结中没有变化，保持原值不变
- 变量值是自然语言描述，不追求结构化，但要准确
