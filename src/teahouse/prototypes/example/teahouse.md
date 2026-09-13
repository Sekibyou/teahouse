# 实例配置

## 工作内容定义

协助写设定和前端沙盒代码。

## 如何启用变量（默认关闭）

让正文 AI 直接维护变量，需要两步：

1. 把变量 `启用变量维护` 设置为 `true`（解锁组装器里的「变量维护要求」段）。
2. 前往 `settings/key-vars.md` 声明你需要正文维护的变量。格式请参考 `settings/key-vars.md.example`。

## DM 模式

跑团 / 语C / 聊天式：玩家在游玩视图与 DM 对话，DM 用 `Output` 把发言呈现为气泡（记录落在 `runtime/dm-output.jsonl`）。

- 切换SOP：1. 查看 `dm-main.js` 文件的位置，如果是disabled则说明大概率未开启 2. 查看 `dm.yaml` 或者 `dm.yaml.example`，带example后缀的话则说明未开启 3. 要启用的话，直接执行一键切换脚本即可 4. 启用后修改 `teahouse.md` 本段，标记为已启用，删除此SOP
- 一键切换脚本：`scripts/enable-dm.py`。

## Skill使用

以下为本实例可用的内置 Skill。**正文生成、沙盒搭建、总结、导出等关键动作，动工前先读对应 skill**，严格按其 SOP 执行。

| Skill | 触发场景 | 用途 |
|---|---|---|
| `teahouse-play-mode` | 搭实例 / 组织设定 / 做跑团·语C·聊天式 / 设计总结 | 把设定、正文生成、总结设计成一套可运转的结构：小说式与 DM 式两种形态的构建方法论 + 平台内置沙盒件 |
| `teahouse-syntax` | 变量·条件·骰子语法、BBCode 特效、着色规则 | 两套内容语法参考：`${}` 表达式 与 富文本渲染（BBCode 白名单、`text-style-rules.yaml` 管理） |
| `teahouse-sandbox-builder` | 用户要求创建/修改沙盒代码、UI 组件、CSS 主题 | 设计构建前端沙盒（UI 组件、场景脚本、CSS 主题），含沙盒 API 参考与最佳实践 |
| `teahouse-export-prototype` | 用户要求将实例导出为原型 / 打包原型 | 把当前实例就地整理为可导出的原型包 |

> 注：以上四个 skill 由引擎内置提供（不在实例 `skills/` 目录），搭实例 / 查语法 / 改沙盒 / 导出前记得先 `SkillRead` 加载对应方法论。
