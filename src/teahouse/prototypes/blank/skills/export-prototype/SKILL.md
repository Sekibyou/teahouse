---
name: export-prototype
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

## 输出格式

原型的目录结构与实例完全一致，但内容被"模板化"处理。作为参考，一个最小原型必须包含：

```
_prototype/
  teahouse.md                        # 通用默认配置
  assets/                            # 静态资源
  settings/                          # 设定文件
    world.yaml                       # 世界观
    characters.yaml                  # 角色
  skills/                            # Skill 包
    <skill-name>/
      SKILL.md
  temp/                              # 临时文件夹（空）
```

可选但推荐：
```
  sandbox/                           # 前端沙盒渲染资源
    bootstrap.js
    *.js / *.css
  .teahouse/                         # 前端配置
    output-blocks.yaml
    text-style-rules.yaml
```

## SOP

### 步骤 1：了解当前实例全貌

```
Read teahouse.md                           → 了解实例配置
Glob settings/**/*                         → 了解设定文件
Glob skills/*/SKILL.md                     → 了解现有 skills
Glob sandbox/**/*                          → 了解沙盒资源
Glob .teahouse/**/*                        → 了解前端配置
Glob assets/**/*                           → 了解静态资源
```

### 步骤 2：读取需要精简的设定文件

使用 `{{path}}` 占位符语法，通过 Write 工具把设定文件复制到 `_prototype/`。同时可以对不必要的内容做脱敏处理（去掉实例特有的具体剧情细节，保留通用框架和角色设定）。

示例——复制世界设定：
```
Write _prototype/settings/world.yaml
---
{{settings/world.yaml}}
---
```

### 步骤 3：编写原型的 teahouse.md

基于实例的 `teahouse.md` 编写原型版本。将实例特有的配置（如当前章节号）替换为通用默认值。

```
Write _prototype/teahouse.md
---
{{teahouse.md}}
---
```

然后 Edit 修改其中过度具体化的部分。

### 步骤 4：复制 Skills

将实例中的 skills 复制到 `_prototype/`。注意：
- **通用 skills**（generate-floor、summarize、rich-text、manage-text-style）应当复制
- **实例特有 skills**（如果有用户为特定故事开发的 skill）也应当复制——这是原型的核心价值
- 如果某个 skill 的 SKILL.md 包含过于具体的故事信息，用 Edit 做泛化

```
Write _prototype/skills/generate-floor/SKILL.md
---
{{skills/generate-floor/SKILL.md}}
---
```

对每个需要保留的 skill 重复此操作。

### 步骤 5：复制沙盒资源

如果实例有沙盒代码（`sandbox/` 目录下 js/css 文件），将它们复制到原型：

```
Write _prototype/sandbox/bootstrap.js
---
{{sandbox/bootstrap.js}}
---
```

同样复制其它 scene_js、ui_js、css 文件。

### 步骤 6：复制前端配置

```
Write _prototype/.teahouse/output-blocks.yaml
---
{{.teahouse/output-blocks.yaml}}
---
```

### 步骤 7：复制静态资源

将 `assets/` 目录下所有文件复制到 `_prototype/assets/`。

### 步骤 8：创建占位空目录

```
FileOps mkdir _prototype/temp
```

### 步骤 9：检查完整性

```
Glob _prototype/**/*
```

检查目录列表是否符合预期。完成后告知用户：
- 原型包在 `_prototype/` 中已准备就绪
- 用户可以检查各文件内容
- 确认无误后在前端点击"导出为原型"按钮

## 注意事项

- **不要复制 `floors/`**：楼层是故事进度，不属于原型
- **不要复制 `variables/`**：变量是故事状态，不属于原型
- **不要复制 `.git/`**：git 历史是实例私有的
- **不要复制 `logs/`**：日志是实例运作记录
- **检查 `_prototype/teahouse.md`**：确保其中不包含当前楼层的引用或具体章节信息
- **settings 适度泛化**：保留角色基础设定和世界观框架，去掉"当前正在发生"的临时状态
- **`{{path}}` 占位符支持切片**：可以使用 `{{path:1-50}}` 只引用文件的前 50 行，或用锚点 `{{path|from="## 角色"|to="## 势力"}}` 精确引用某个段落
- **每个 `{{path}}` 引用占一行**：不要和其他文本混在同一行，放在独立的一行中引用
