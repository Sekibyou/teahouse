---
name: rich-text
description: 教导导演如何使用 rich_text 渲染器。如果只使用 Markdown 或 HTML 标签则无需调用此 skill；如果使用混合语法（BBCode + Markdown + HTML），或使用 BBCode 特效标签，则必须先调用本 skill 再使用。
---

# Rich Text 渲染器 Skill

教导导演如何使用 rich_text 内容类型的渲染能力。

## 适用时机

当导演需要输出包含以下任一特性的 rich_text 内容时，必须先调用本 skill：
- BBCode 标签（格式化或动画特效）
- BBCode + Markdown + HTML 混合语法
- 需要在文本中嵌入沙盒交互元素（`<script>`、`<button>` 等）

如果输出内容只使用纯 Markdown 或纯 HTML 标签，则无需调用本 skill。

## 渲染管线

rich_text 内容的处理顺序（由前端 `renderText()` 执行）：

```
原始文本
  → 1. BBCode 解析（[b][i][shake] 等标签 → HTML）
  → 2. 文本样式规则着色（符号对如《》、引号等 → 包裹 CSS）
  → 3. Markdown 解析（GFM：标题、列表、表格、代码块等）
  → 4. 渲染为 HTML 插入沙盒
```

### 重要规则

1. **BBCode 标签内部可以嵌套 Markdown**，反过来不行。先写 BBCode，内部用 Markdown。
2. **BBCode 标签可以跨行**，`[glow]...[/glow]` 可以包裹多个段落。但 BBCode 生成的是内联 HTML（`<span>`），跨行时内部换行不会自动转为 `<br>`。如果需要段落分隔，请使用两个换行（空行），或在行末手动写 `<br>`。
3. **不要在 BBCode 标签内部嵌套同类型标签**，但可以嵌套不同类型。
4. **HTML 块元素（如 `<details><summary>`）内部的 Markdown 会被解析**。

## BBCode 标签参考

### 标准格式化

| 标签 | 写法 | 效果 |
|------|------|------|
| 粗体 | `[b]文字[/b]` | **加粗** |
| 斜体 | `[i]文字[/i]` | *倾斜* |
| 下划线 | `[u]文字[/u]` | <u>下划线</u> |
| 删除线 | `[s]文字[/s]` | ~~删除~~ |
| 颜色 | `[color=#ff0000]文字[/color]` | 指定颜色 |
| 字号 | `[size=24]文字[/size]` | 指定字号(px) |

### 动画特效

所有特效支持参数化配置，使用 `key=value` 空格分隔：

| 标签 | 写法 | 可配置参数 |
|------|------|-----------|
| 抖动 | `[shake rate=0.5s level=2]文字[/shake]` | `rate`(速度) `level`(幅度px) |
| 淡入淡出 | `[fade rate=2s min=0.3]文字[/fade]` | `rate`(速度) `min`(最小透明度) |
| 弹跳 | `[bounce rate=0.6s level=10]文字[/bounce]` | `rate`(速度) `level`(高度px) |
| 波浪 | `[wave rate=1s level=5]文字[/wave]` | `rate`(速度) `level`(幅度px) |
| 彩虹 | `[rainbow rate=3s]文字[/rainbow]` | `rate`(速度) |
| 发光 | `[glow color=#f59e0b level=20]文字[/glow]` | `rate`(速度) `color`(颜色) `level`(范围px) |
| 脉冲 | `[pulse rate=1s level=1.1]文字[/pulse]` | `rate`(速度) `level`(缩放比) |
| 打字机 | `[typing]文字[/typing]` | 无参数 |

特效参数均可省略，使用默认值。两种参数格式等价：
- 旧式：`[shake=0.5s]文字[/shake]`（单参数 = rate）
- 新式：`[shake rate=0.5s level=3]文字[/shake]`（支持多参数）

## 混合语法示例

### BBCode + Markdown

```
[size=5][b]第一章 · 标题[/b][/size]

正文内容，支持 **Markdown 加粗** 和 *斜体*。

[glow color=#f59e0b level=20]这句话带有发光特效 —— 适合强调关键台词[/glow]

> 引用块应独立使用，不要包裹在 BBCode 特效中。
> —— 某位角色

- 列表项 1
- 列表项 2
```

> **注意**：引用块（`>`）和代码块（`` ``` ``）是 Markdown 块级元素，不能包裹在 BBCode 特效中。因为 BBCode 生成的是内联 `<span>`，marked 不会解析 `<span>` 内部的 Markdown 块级语法。

### BBCode + HTML

```html
<details>
<summary>[b]点击展开[/b]</summary>

[glow color=#3b82f6]展开后的内容可以包含 BBCode 特效。[/glow]

</details>
```

### 纯 Markdown（无需本 skill）

```markdown
# 第一章 · 标题

正文内容，支持 **加粗** 和 *斜体*。

> 引用文字

- 列表
- 列表
```

## 注意事项

- **BBCode 不能包裹 Markdown 块级元素**。引用块（`>`）和代码块（`` ``` ``）是 Markdown 块级语法，不能放在 BBCode 特效标签内部。因为 BBCode 先生成内联 `<span>`，marked 不会解析 `<span>` 内部的 Markdown 块级语法（引用块、代码块、标题、列表等）。引用块和代码块应独立使用，不要包裹在任何 BBCode 标签中。如果需要对引用块添加视觉效果，考虑使用 HTML + CSS 代替。
- **BBCode 不能整块包裹列表**。`[bounce]01. 第一项\n02. 第二项[/bounce]` 这种写法会让整个列表变成一个内联 `<span>`，破坏排版。如果需要给列表项加特效，请**逐项包裹**：`[bounce]01. 第一项[/bounce]` `[bounce]02. 第二项[/bounce]`。
- **不建议 BBCode 与 Markdown 内联混用**。`[rainbow]**文字**[/rainbow]` 中的 `**` 不会被解析为加粗，原因同上——marked 不处理 `<span>` 内部的 Markdown。BBCode 内需要加粗时请使用 `[b]`，需要斜体用 `[i]`。
- **默认字号是 16px**。`[size]` 的单位是 px，`[size=20]` = 20px，不要用 5、6 这种小数值，会导致文字不可读。建议取值范围：14~32。
- **Markdown 表格内部不支持 BBCode**。表格由 marked 解析，单元格内容不会递归解析 BBCode。如需表格内着色，使用 HTML `<span style="...">` 代替。
- **有序列表和无序列表（`1. `、`- `、`* `）已被禁用**。渲染器会自动插入零宽空格使其不被 marked 解析为 `<ol>` / `<ul>`。需要列表效果时，请手动写序号并用缩进排版。
- **BBCode 和 HTML 标签不能混用**。`[color]` 只能用 `[/color]` 闭合，不能用 `</span>`；同理 `<span>` 只能用 `</span>` 闭合，不能用 `[/span]`。两种标记体系完全独立。
- **不要过度使用特效**——一句对白用一个特效就够了，整段彩虹色会让读者头晕。
- 特效适合用于：关键台词强调、情绪爆发点、超自然/科幻场景的视觉效果。
- 普通叙事段落用 Markdown 即可，不要加 BBCode。
