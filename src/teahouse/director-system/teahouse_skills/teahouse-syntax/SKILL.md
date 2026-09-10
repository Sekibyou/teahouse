---
name: teahouse-syntax
description: 本引擎的两套「内容语法」参考——① `${}` 表达式语法（变量引用、`${@condition}`/`${@python}`/`${@mention}` 等注册式指令、骰子 `roll()`、转义）；② 富文本渲染语法（BBCode 标签白名单、与 Markdown/HTML 的混用规则、文本样式着色规则 `text-style-rules.yaml` 的增删改查）。当导演被问及变量/条件/骰子语法、要给正文加特效、要管理符号着色规则、或不确定某个 BBCode 标签是否存在时触发。**文件切片语法 `{{路径|切片}}` 见「行为准则」（behavior.md），不在本 skill。**
---

# Teahouse 语法参考

引擎里有两套写法各管一件事，别混：

| 想做什么 | 语法 | 在哪 |
|---|---|---|
| 引用**文件内容**（切片/搬运） | `{{路径\|切片}}` | **行为准则**（behavior.md）——唯一事实源 |
| 引用**变量值** / 条件分支 / 掷骰 | `${...}` | 本 skill → `references/expressions.md` |
| 给正文**着色 / 加特效** | BBCode `[b]…[/b]`、着色规则 yaml | 本 skill → `references/richtext.md` |

- `${}` 表达式（含 `@condition` / `@python` / `@mention` / `roll()` / 转义）→ 读 `references/expressions.md`
- 富文本（BBCode 白名单 + 混用规则 + 着色规则管理）→ 读 `references/richtext.md`

读法：`SkillRead(name="teahouse-syntax", file="references/expressions.md")`。

**注**：`${@note ...}` 注释语法写在**行为准则**里（behavior.md），因为它常驻可见、写设定时就要用；本 skill 不复述。
