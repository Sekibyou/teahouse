# 实例配置

## 工作内容定义

协助写设定和前端沙盒代码。

## 文末选项功能（给玩家的可选项，默认关闭）

若剧情要采用"章末给玩家可选项"，需要把以下三处从注释/示例改成正文以启用（沙盒 input-bar 的选项条已默认搭载，读到「文末选项」数组即展示）：

| 文件 | 现有形态 | 启用方式 |
|---|---|---|
| `settings/key-vars.md` | 变量清单，默认以注释引用 | 按 `settings/key-vars-withOption-example.md`（含文末选项变量的完整示例，不进正文、仅作参考）把「文末选项」变量行与产出要求并入 |
| `settings/assemble.md` | 变量维护要求包在 `${@note}` 注释里 | 移除该注释块以引用 key-vars |
| `generate-config/generate.yaml` | user content 里的 `${@note}` 提示 | 把变量系统 note 移除、改为要求产出变量更新块 |

**判定标记格式须与沙盒 input-bar.js 严格一致**：需判定选项在文本内联 方括号`[...]`（判定条件）+ 尖括号`<...>`（骰子串，RPG 语法如 `3d6k2`）。完整要求见 `settings/key-vars-withOption-example.md`。

## Skill使用

以下为本实例可用的内置 Skill。**正文生成、沙盒搭建、总结、导出等关键动作，动工前先读对应 skill**，严格按其 SOP 执行。

| Skill | 触发场景 | 用途 |
|---|---|---|
| `teahouse-generate-floor` | 用户要求「写下一章 / 继续写作 / 生成正文」 | 生成正文楼层的完整流程：上下文准备 + Generate 工具使用 |
| `teahouse-sandbox-builder` | 用户要求创建/修改沙盒代码、UI 组件、CSS 主题 | 设计构建前端沙盒（UI 组件、场景脚本、CSS 主题），含沙盒 API 参考与最佳实践 |
| `teahouse-sandbox-richtext-render` | 需要输出 BBCode 特效、管理符号着色规则 | 前端沙盒富文本渲染能力：BBCode 标签白名单、文本样式着色规则管理 |
| `teahouse-summarize` | 用户要求总结，或满足总结触发条件（建议每 7 层一次） | 总结流程：上下文压缩、设定更新、变量更新、流水账落盘 |
| `teahouse-export-prototype` | 用户要求将实例导出为原型 / 打包原型 | 把当前实例就地整理为可导出的原型包 |

> 注：以上五个 skill 由引擎内置提供（不在实例 `skills/` 目录），撰写正文 / 改沙盒 / 总结 / 导出前记得先 `SkillRead` 加载对应方法论。
