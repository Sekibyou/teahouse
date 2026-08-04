---
name: teahouse-export-prototype
description: 教导导演如何将当前实例的设定和素材整理为可导出的原型包。当用户表示要将实例导出为原型、创建原型模板、或提及"打包原型"时触发。
---

# 原型导出 Skill

教导导演如何将当前实例的设定和素材整理到 `_prototype/` 目录，供用户在前端一键导出为可复用的原型。

## 适用时机

当用户提出以下意图时加载本 skill：
- "把这个实例导出为原型"
- "做成原型模板"
- "打包成原型"
- "创建一个基于当前设定的原型"

## 方法论

原型的本质：**一个被反复实例化的模板**。与实例的区别在于：
- 实例 = 具体的存档，有楼层、变量、具体剧情
- 原型 = 抽象的模板，有设定框架、Skill、沙盒代码，但**不包含**故事进度

因此从实例导出原型时，需要做的是：**保留框架，剔除实例特定的进度数据**。

## 原型目录结构

```
_prototype/
├── teahouse.md                    # 通用默认配置（泛化后）
├── .teahouse/                     # [必需] 系统数据
│   ├── output/                    # 沙盒代码（渲染器来源）
│   │   ├── sandbox/               # 沙盒渲染代码
│   │   │   ├── bootstrap.js
│   │   │   ├── theme.css
│   │   │   └── *.js / *.css
│   │   └── floors/                # 初始楼层占位（实例创建后从这里起）
│   │       └── .gitkeep
│   └── text-style-rules.yaml      # 文本样式规则
├── skills/                        # [必需] Skill 包
│   ├── .gitkeep
│   └── <skill-name>/
│       └── SKILL.md
├── settings/                      # [推荐] 设定文件
│   ├── world.yaml                 # 世界观
│   ├── characters.yaml            # 角色
│   └── generate-config-default.yaml
├── .teahouse/runtime_vars.jsonl   # [推荐] 变量系统（文件即状态）
├── assets/                        # [推荐] 静态资源
├── temp/                          # [推荐] 占位空目录
└── summary/                       # [可选] 初始空目录（总结摘要）
```

## SOP

### 步骤 1：了解当前实例全貌

```
Glob settings/**/*                         → 了解设定文件
Glob skills/*/SKILL.md                     → 了解现有 skills
Glob .teahouse/output/sandbox/**/*         → 了解沙盒资源
Glob .teahouse/**/*                        → 了解前端配置
Glob assets/**/*                           → 了解静态资源
```

（`teahouse.md` 已注入系统提示词，无需重新读取。）

### 步骤 2：创建 _prototype/ 目录结构

创建必需目录（带 `.gitkeep`）：

```
FileOps mkdir _prototype/skills
FileOps mkdir _prototype/.teahouse/output/sandbox
FileOps mkdir _prototype/.teahouse/output/floors
```

写入 `.gitkeep`：

```
Write _prototype/skills/.gitkeep → 空内容
Write _prototype/.teahouse/output/floors/.gitkeep → 空内容
```

> 注意：`.teahouse/output/floors/` 是实例正文历史的起始位置，导出为原型后是新实例的初始楼层目录（占位空目录）。旧的根级 `floors/` 已废弃，不再创建。

创建推荐目录（不带 `.gitkeep`，按需）：

```
FileOps mkdir _prototype/settings
FileOps mkdir _prototype/assets
FileOps mkdir _prototype/variables
FileOps mkdir _prototype/temp
FileOps mkdir _prototype/summary
```

### 步骤 3：编写原型的 teahouse.md

基于实例的 `teahouse.md` 编写原型版本。将实例特有的配置泛化为通用默认值。

```
Write _prototype/teahouse.md
---
{{teahouse.md}}
---
```

然后 Edit 修改其中过度具体化的部分（如当前章节号、具体角色名字等），并**清空全局变量区里的归档界**（`summarized_to`）为初始值。

### 步骤 4：复制并泛化设定文件

使用 `{{path}}` 占位符语法，通过 Write 工具把设定文件复制到 `_prototype/`。同时脱敏处理（去掉实例特有的具体剧情细节，保留通用框架和角色设定）。

示例——复制世界设定：
```
Write _prototype/settings/world.yaml
---
{{settings/world.yaml}}
---
```

用 Edit 去掉"当前正在发生"的临时状态，保留通用框架。角色设定同理。同时若实例有自定义的 `settings/generate-config-default.yaml` 则一并复制。

### 步骤 5：复制 Skills

将实例中的 skills 复制到 `_prototype/`。注意：
- **通用 skills**（teahouse-generate-floor、teahouse-summarize、teahouse-sandbox-richtext-render 等）应当复制
- **实例特有 skills**（如果有用户为特定故事开发的 skill）也应当复制——这是原型的核心价值
- 如果某个 skill 的 SKILL.md 包含过于具体的故事信息，用 Edit 做泛化

```
Write _prototype/skills/teahouse-generate-floor/SKILL.md
---
{{skills/teahouse-generate-floor/SKILL.md}}
---
```

对每个需要保留的 skill 重复此操作。

### 步骤 6：复制沙盒资源

如果实例有沙盒代码（`.teahouse/output/sandbox/` 下 js/css 文件），将它们复制到原型：

```
Write _prototype/.teahouse/output/sandbox/bootstrap.js
---
{{teahouse-output-sandbox/bootstrap.js}}
---
```

> 注意：源路径是 `.teahouse/output/sandbox/`。用一个简短的自定义占位符（如上）指向实例 `.teahouse/output/sandbox/bootstrap.js`，或在目标占位符中明确提到该路径。复制 `*.js` / `*.css` 全部。如果实例没有沙盒资源，跳过此步骤。

### 步骤 7：复制其余前端配置

```
Write _prototype/.teahouse/text-style-rules.yaml
---
{{.teahouse/text-style-rules.yaml}}
---
```

> 没有 output-blocks.jsonl 了——旧的前端输出块机制已废弃，新结构只有 `.teahouse/output/`（sandbox 代码 + floors 楼层）和 `text-style-rules.yaml`。

### 步骤 8：复制静态资源

将 `assets/` 目录下所有文件复制到 `_prototype/assets/`。如果 `assets/` 为空则跳过。

### 步骤 9：检查完整性

```
Glob _prototype/**/*
```

检查目录列表是否符合预期。完成后告知用户：
- 原型包在 `_prototype/` 中已准备就绪
- 用户可以检查各文件内容
- 确认无误后在前端点击"导出为原型"按钮

## 注意事项

- **不要复制 `.teahouse/output/floors/` 的内容**：楼层是故事进度，不属于原型。但该目录本身需要创建（含 `.gitkeep`），因为它是新实例的初始楼层目录，且 `.gitignore` 需保证它能入库。
- **不要复制 `.teahouse/runtime_vars.jsonl` 内容**：变量是故事状态，不属于原型。导出时该文件只保留为空模板（builder 在打包前写入的预设变量除外——若这是一套可复用的默认变量，可保留作为新实例的初始变量）。
- **不要复制 `summary/` 内容**：摘要文本是实例的进度记忆，不属于原型。
- **不要复制 `.git/`**：git 历史是实例私有的。
- **检查 `_prototype/teahouse.md`**：确保其中不包含当前楼层的引用、具体章节信息，且归档界已清空。
- **settings 适度泛化**：保留角色基础设定和世界观框架，去掉"当前正在发生"的临时状态。
- **`{{path}}` 占位符支持切片**：可以使用 `{{path:1-50}}` 只引用文件的前 50 行，或用锚点 `{{path|from="## 角色"|to="## 势力"}}` 精确引用某个段落。
- **每个 `{{path}}` 引用占一行**：不要和其他文本混在同一行，放在独立的一行中引用。
