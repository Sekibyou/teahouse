# 记忆系统与变量系统

Teahouse 的记忆系统借鉴了 Claude Code 的增量上下文管理和 OpenClaw 的分层文件结构。

## 设计原则

1. **所有记忆显式存储在磁盘上**——系统没有隐藏状态，任何长期记忆都可以直接查看和编辑
2. **增量加载**——不把所有历史塞入上下文，只加载当前所需
3. **按需回溯**——需要查细节时通过工具读取，不是自动注入
4. **变量变更由总结 skill 统一处理**——不是每轮都改，减少碎片化写入

## 四层记忆结构

### 第一层：楼层总结

每层生成完成后产生一小段总结，记录该层核心事件。存放于 `logs/summaries.yaml`，append-only。

```yaml
floor-001: 林月逃离星罗城，在城郊遇到受伤的苏河。
floor-002: 林月为苏河包扎伤口，得知星罗城已被暗影教控制。
floor-003: 二人结伴前往最近的青竹镇打探消息。
```

**加载规则**：
- 自动加载：最近 N 层的总结（N 由总结 skill 配置）
- 总结轮之后：最早的一批楼层总结保留，对应的正文被移除

### 第二层：楼层正文

完整楼层内容，存放于 `floors/floor-NNN.md`。

**加载规则**：
- 自动加载：最近 M 层的完整正文（M 由上下文窗口决定）
- 总结轮之后：最早的楼层正文被移除，只保留其总结

### 第三层：当前变量

存储所有追踪变量的当前值，存放于 `variables/active.yaml`。

```yaml
characters:
  林月:
    name: 林月
    age: 17
    appearance: 黑色长发，左手火焰形胎记
    traits: [倔强, 好奇心强]
    cultivation_level: 凝气境三层  # 关键变量
    current_location: 青竹镇
    status: 健康
    relationships:
      苏河: 同伴 (信任)
      慕容远: 师父 (已故)

settings:
  world_name: 云隐大陆
  current_era: 灵历 347 年
  season: 深秋

plot:
  act: 1
  current_goal: 寻找失落的天书碎片
  active_quests:
    - 在青竹镇打听天书碎片的下落
```

**加载规则**：始终自动加载完整文件。

### 第四层：关键变量变更日志

仅记录关键变量的变更历史，存放于 `logs/change-log/`。

每个文件的命名格式：
- `floor-NNN.yaml` — 楼层变更
- `summary-NNN.yaml` — 总结轮变更

```yaml
# logs/change-log/summary-002.yaml
type: summary
covering: floor-004~005

changes:
  - variable: characters.林月.cultivation_level
    from: 凝气境二层
    to: 凝气境三层
    reason: 在青竹镇闭关突破
    at_floor: 005

  - variable: characters.林月.status
    from: 轻伤
    to: 健康
    reason: 伤势痊愈
    at_floor: 005
```

**加载规则**：不自动加载。导演在需要时通过工具查询。

## 关键变量定义

关键变量定义在 `variables/key_variables.yaml`：

```yaml
# 定义哪些变量需要记录变更历史
key_variables:
  - characters.*.cultivation_level       # 所有角色的修为
  - characters.*.status                  # 所有角色的状态
  - characters.*.relationships           # 所有角色的关系
  - plot.current_goal                    # 当前目标
  - plot.active_quests                   # 活跃任务
```

以及 `variables/key_variables_schema.yaml` 定义其结构：

```yaml
# 关键变量的结构定义，用于引导 AI 识别变更
characters:
  林月:
    cultivation_level:
      type: string
      description: 修为境界
      history: true
    status:
      type: string
      enum: [健康, 轻伤, 重伤, 昏迷, 死亡]
      history: true
```

## AI 对变量系统的感知方式

AI 不直接读取整个变更历史，而是通过以下方式理解变量：

1. **自动加载** `variables/active.yaml` → 当前最新值
2. **系统提示告知**"变更日志位置 + 可查询的关键变量"
3. **按需使用工具**：
   - `Read("logs/change-log/summary-002.yaml")` → 查看某次变更详情
   - `Read("floors/floor-005.md")` → 查看变更发生的原文
4. **推导当前值**：初始设定（settings/）+ 所有已发生的变更 = 当前值（active.yaml）

## 总结时的变量更新

总结轮由 `skills/summarize/` skill 驱动，执行以下操作：

1. 加载 summarize skill 的提示词和规则
2. 通读自上次总结以来的所有楼层正文
3. 识别关键变量变更 → 写入 `logs/change-log/`
4. 识别非关键变量变更 → 更新 `variables/active.yaml`
5. 更新 `logs/summaries.yaml`（追加总结 + 更新旧总结）
6. git commit（summary commit）

非关键变量的变更仅在 active.yaml 中更新当前值，不留历史记录。
