---
name: teahouse-sandbox-richtext-render
description: 教导导演如何使用前端沙盒的富文本渲染能力，包括 BBCode 标签白名单和文本样式着色规则管理。当输出需要使用 BBCode 特效、管理符号着色规则、或混合使用 BBCode + Markdown + HTML 时触发。
---

# 沙盒富文本渲染 Skill

教导导演如何使用 rich_text 内容类型的渲染能力，以及管理符号着色规则。

## 适用时机

当导演需要输出包含以下任一特性的 rich_text 内容时，必须先调用本 skill：
- BBCode 标签（格式化或动画特效）
- BBCode + Markdown + HTML 混合语法
- 需要在文本中嵌入沙盒交互元素（`<script>`、`<button>` 等）

当用户要求：
- "给《》加个颜色"
- "把双引号标成金色"
- "移除某个着色规则"
- "列出所有样式规则"

如果输出内容只使用纯 Markdown 或纯 HTML 标签，则无需调用本 skill。

---

# 第一部分：BBCode 渲染

## 🚨 最重要的规则 — BBCode 标签白名单制

**以下列表是渲染器支持的全部 BBCode 标签。禁止使用列表之外的任何标签！**

渲染器只会解析这些标签——任何不在列表中的标签（如 `[center]`、`[quote]`、`[list]`、`[*]`、`[hr]`、`[code]` 等）**都不会被渲染，会原样显示为纯文本**。

### 标准格式化（6 个）

| 标签 | 写法 |
|------|------|
| 粗体 | `[b]文字[/b]` |
| 斜体 | `[i]文字[/i]` |
| 下划线 | `[u]文字[/u]` |
| 删除线 | `[s]文字[/s]` |
| 颜色 | `[color=#ff0000]文字[/color]` |
| 字号 | `[size=24]文字[/size]` |

### 动画特效（8 个）

| 标签 | 写法 |
|------|------|
| 抖动 | `[shake rate=0.5s level=2]文字[/shake]` |
| 淡入淡出 | `[fade rate=2s min=0.3]文字[/fade]` |
| 弹跳 | `[bounce rate=0.6s level=10]文字[/bounce]` |
| 波浪 | `[wave rate=1s level=5]文字[/wave]` |
| 彩虹 | `[rainbow rate=3s]文字[/rainbow]` |
| 发光 | `[glow color=#f59e0b level=20]文字[/glow]` |
| 脉冲 | `[pulse rate=1s level=1.1]文字[/pulse]` |
| 打字机 | `[typing]文字[/typing]` |

### 视觉标签（4 个）

| 标签 | 写法 | 效果 |
|------|------|------|
| 阴影 | `[shadow color=rgba(0,0,0,0.5) level=4]文字[/shadow]` | 朦胧褪色，营造神秘/旧书文字感 |
| 高亮 | `[highlight color=#f59e0b]文字[/highlight]` | 荧光笔效果，醒目标记关键词 |
| 剧透 | `[spoiler]文字[/spoiler]` | 黑条遮盖，hover 时显示 |
| 提示 | `[tip=提示内容]文字[/tip]` | 虚线下划线+💡角标，hover 弹出气泡提示 |

**总共只有以上 18 个 BBCode 标签可用。没有 `[center]`、没有 `[quote]`、没有 `[list]`、没有 `[*]`、没有 `[hr]`、没有 `[code]`。需要居中/引用/分割线/代码块请使用 Markdown 或 HTML。**

如果你不确定某个标签是否存在，就不要用——用 Markdown 代替。

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

## BBCode 使用注意事项

- **BBCode 不能包裹 Markdown 块级元素**。引用块（`>`）和代码块（`` ``` ``）是 Markdown 块级语法，不能放在 BBCode 特效标签内部。
- **BBCode 不能整块包裹列表**。`[bounce]01. 第一项\n02. 第二项[/bounce]` 这种写法会让整个列表变成一个内联 `<span>`，破坏排版。如果需要给列表项加特效，请**逐项包裹**。
- **不建议 BBCode 与 Markdown 内联混用**。`[rainbow]**文字**[/rainbow]` 中的 `**` 不会被解析为加粗。BBCode 内需要加粗时请使用 `[b]`，需要斜体用 `[i]`。
- **默认字号是 16px**。`[size]` 的单位是 px，`[size=20]` = 20px，不要用 5、6 这种小数值，会导致文字不可读。建议取值范围：14~32。
- **Markdown 表格内部不支持 BBCode**。如需表格内着色，使用 HTML `<span style="...">` 代替。
- **有序列表和无序列表（`1. `、`- `、`* `）已被禁用**。渲染器会自动插入零宽空格使其不被 marked 解析为 `<ol>` / `<ul>`。需要列表效果时，请手动写序号并用缩进排版。
- **BBCode 和 HTML 标签不能混用**。`[color]` 只能用 `[/color]` 闭合，不能用 `</span>`；同理 `<span>` 只能用 `</span>` 闭合。
- **不要过度使用特效**——一句对白用一个特效就够了，整段彩虹色会让读者头晕。

---

# 第二部分：文本样式规则（符号着色）

## 格式说明

文本样式规则定义在 `.teahouse/text-style-rules.yaml`。每条规则定义了一对符号如何被包裹在自定义 HTML 中。规则在 BBCode 解析之后、Markdown 解析之前应用。

```yaml
rules:
  - start_symbol: "《"      # 起始符号
    end_symbol: "》"        # 结束符号（与 start 相同时表示对称型，如引号）
    start_html: '<span style="color: #e5c07b;">'   # 插入在起始符号前
    end_html: "</span>"                             # 插入在结束符号后
    enabled: true           # 是否启用
    order: 1                # 处理顺序（数字小者优先）
```

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `start_symbol` | string | 起始符号，支持多字符（如 `"""`） |
| `end_symbol` | string | 结束符号。与 start 相同时，匹配同一符号的相邻出现（如 `"..."`） |
| `start_html` | string | 在起始符号前插入的 HTML（通常是开标签） |
| `end_html` | string | 在结束符号后插入的 HTML（通常是闭标签） |
| `enabled` | bool | `true` 启用，`false` 禁用（保留配置但不生效） |
| `order` | int | 处理优先级，数字小者先处理。建议长符号排前面，避免被短符号误匹配 |

### 注意事项

- 可以跨 BBCode 标签匹配（如 `《[b]标题[/b]》` 会被正确匹配）
- HTML 内容中 `"` 需转义，或使用单引号包裹
- YAML 中 `>` 等特殊字符需用引号包裹属性值

## SOP

### 查看规则

```
Read .teahouse/text-style-rules.yaml
```

若文件不存在，说明该实例尚未配置任何样式规则，可以创建新文件。

### 添加规则

1. 先 Read 当前文件，了解已有规则
2. 确定新规则的 order 值（建议在最大值基础上 +1，或插入到合适位置）
3. 使用 Edit 追加新规则到 rules 列表末尾
4. 告知用户新规则已生效。前端下次刷新内容时会自动应用

### 删除规则

1. Read 当前文件
2. 使用 Edit 删除整条规则（从 `- start_symbol` 到 `order: N` 的所有行）
3. 告知用户

### 修改规则

1. Read 当前文件
2. 使用 Edit 精确替换需要修改的字段值
3. 告知用户

### 切换启用/禁用

1. Read 当前文件
2. 将对应规则的 `enabled` 字段改为 `true` 或 `false`
3. 无需删除配置即可暂时关闭某条规则

## 示例对话

**用户**: 给《》着金色

**导演**:
1. Read `.teahouse/text-style-rules.yaml`
2. 如果文件不存在，Write 新文件；否则 Edit 追加规则：
```yaml
  - start_symbol: "《"
    end_symbol: "》"
    start_html: '<span style="color: #e5c07b;">'
    end_html: "</span>"
    enabled: true
    order: 1
```
3. 回复：已将《》配置为金色着色，前端刷新后生效。
