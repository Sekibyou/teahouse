# Teahouse — 系统核心配置

本文件为 Teahouse 实例的系统提示词，始终实时注入导演上下文。修改即生效，无需重启。

## 实例信息

<!-- 实例化时自动填写 -->

- **实例 ID**：`<uuid>`
- **关联原型**：`<原型名称>`
- **创建时间**：`<时间戳>`
- **当前楼层计数**：`<数字>`

## 目录结构

```
instance/
├── teahouse.md              # 本文件，系统核心配置
├── settings/                # 设定文件（来自原型，游玩中可选修改）
│   ├── world.yaml           # 世界观设定
│   └── characters.yaml      # 角色初始设定
├── skills/                  # 技能包（提示词 + 例子 + 参考资料）
│   ├── generate-floor/      # 正文生成 skill
│   │   ├── prompt.md
│   │   └── examples/
│   ├── summarize/           # 总结归纳 skill
│   │   ├── prompt.md
│   │   └── examples/
│   └── ...                  # 创作者/用户自定义 skill
├── variables/               # 变量系统
│   ├── active.yaml          # 当前变量（所有追踪变量的当前值）
│   ├── key_variables.yaml   # 关键变量列表
│   └── key_variables_schema.yaml  # 关键变量结构定义
├── floors/                  # 楼层文件
│   ├── floor-001.md
│   ├── floor-002.md
│   └── ...
├── logs/
│   ├── summaries.yaml       # 每层/每次总结的摘要
│   └── change-log/          # 关键变量变更记录
│       ├── floor-005.yaml
│       └── summary-002.yaml
└── current/                 # 当前会话工作区
    ├── draft.md             # 生成中的正文
    └── notes.md             # 导演临时笔记
```

## 楼层定义

- 一个楼层 (Floor) 是一个独立的内容单元，对应一个 `.md` 文件
- 楼层可一次性生成，也可分多次续写/修改完成
- 楼层完成后触发一次 git commit，计入楼层计数
- 楼层文件存放于 `floors/` 目录，命名格式 `floor-{编号}.md`
- 楼层具体长度和完成条件见下方的楼层配置

### 楼层配置

<!-- 根据实例体裁修改此处 -->

- 目标字数：约 3000 字/层
- 最少字数：2000 字/层
- 最大字数：5000 字/层（超出自动建议截断）

> 聊天模拟等短内容场景可降低目标字数，允许多次对话累积为一层。

## 总结规则

总结是一个特殊流程，触发 git commit，不计入楼层计数，触发上下文重组。

- 总结轮存储在 `logs/summaries.yaml`，append-only

### 总结触发条件

- 建议总结频率：每 7 层一次
- 最大不总结层数：10 层（超过则强制建议总结）
- 用户可随时手动触发总结

### 总结时执行的操作

1. 将最早的一批楼层正文压缩为一小段总结
2. 解析自上次总结以来的变量变更，更新 `variables/active.yaml`，追加 `logs/change-log/`
3. git commit（summary commit）
4. 上下文重组——旧楼层正文被总结替代，变量系统按初始值 + 变更链推导

## 变量系统

### 变量定义

variables/active.yaml 存储所有追踪变量的当前值。
variables/key_variables.yaml 定义哪些是关键变量（需 change log）。

变更记录规范：
- 关键变量变更：记录在 `logs/change-log/`，包含变更前后值及原因
- 非关键变量：只在 active.yaml 中更新当前值，不留历史

### 当前变量加载方式

- 自动加载：active.yaml（完整当前状态）
- 按需查询：通过工具读取 change log 或对应楼层原文

## 提交流程

一个楼层结束 或 一次总结完成 → git commit，附提交信息。

提交信息格式：
- 楼层: `floor-NNN: 简短描述`
- 总结: `summary-NNN: 涵盖楼层范围及摘要`

## Git 历史示例

```
floor-001: 林月离开星罗城
floor-002: 路遇苏河
floor-003: 抵达青竹镇
summary-001: floor-001~003 总结，变量已更新
floor-004: 镇中打探消息
floor-005: 夜探藏书阁
summary-002: floor-004~005 总结，变量已更新
```

楼层计数只看 floor commit，summary commit 跳过计数。

## 原型与实例

### 原型 (Prototype)

原型是一个 `.zip` 文件，类似酒馆的角色卡。包含创作时设计好的所有内容：

- teahouse.md（初始配置模板）
- settings/（世界观、角色设定）
- skills/（提示词技能包）
- variables/（初始变量定义和 schema）
- （不含 floors/、logs/——这些是游玩中产生的）

### 实例 (Instance)

原型解压后复制一份到存档目录即成为实例。实例化后独立运作，不跟随原型更新。

一个实例包含：
- teahouse.md
- settings/
- skills/（原型自带 skill + 游玩中新建的）
- variables/（初始 + 游玩变更）
- floors/
- logs/
- current/

### 实例创建流程

```
原型 .zip
  │
  └─ 解压
      │
      └─ 复制到存档目录
          │
          └─ 实例（独立，不跟随原型更新）
              └─ 开始游玩
```

游玩过程中 teahouse.md 和 skill 可以大幅变更，不受原型限制。
