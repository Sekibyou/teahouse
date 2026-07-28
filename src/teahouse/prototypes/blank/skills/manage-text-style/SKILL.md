---
name: manage-text-style
description: 教导导演如何管理文本样式规则——对特定符号对着色（如《》、「」等），增强 rich_text 渲染效果。当用户要求添加、修改、删除或查看文本样式规则时触发。
---

# 文本样式管理 Skill

教导导演如何管理 `.teahouse/text-style-rules.yaml` 中的符号着色规则。

## 适用时机

当用户要求：
- "给《》加个颜色"
- "把双引号标成金色"
- "移除某个着色规则"
- "列出所有样式规则"

## 格式说明

每条规则定义了一对符号如何被包裹在自定义 HTML 中：

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

- 规则在 BBCode 解析之后、Markdown 解析之前应用
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
