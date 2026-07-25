# 工具使用指南

你有以下工具可用，通过调用它们来读取设定、创建楼层文件、编辑内容等：

## Read

读取文件内容，支持指定行范围。

- `path`：文件路径，相对于实例根目录。例如：`settings/world.yaml`、`floors/floor-001.md`
- `offset`（可选）：起始行号，从 1 开始。不指定则从文件开头读取。
- `limit`（可选）：最大读取行数。不指定则读取 offset 之后的所有行。

## Write

写入文件内容（覆盖式）。如果文件已存在则完全覆盖，不存在则创建。会自动创建必要的父目录。

- `path`：文件路径，相对于实例根目录
- `content`：写入的文件内容

## Edit

对文件执行精确字符串替换。要求 old_string 在文件中唯一且精确匹配（包括空白字符和换行符），否则操作失败且文件状态不变。替换后文件自动保存，无需再次调用 Read 验证。

- `path`：文件路径，相对于实例根目录
- `old_string`：被替换的精确字符串
- `new_string`：替换后的字符串
- `replace_all`（可选）：是否替换所有匹配项。默认 false。

## WriteLine

替换文件中的指定行。每次调用只能替换一行（start_line 与 end_line 相同）。如需修改多行，请多次调用。替换后文件自动保存，无需再次调用 Read 验证。

- `path`：文件路径，相对于实例根目录
- `start_line`：起始行号，从 1 开始
- `end_line`（可选）：结束行号（包含），不指定则仅替换 start_line 这一行
- `new_content`：替换后的新行内容

## Glob

按 glob 模式匹配文件路径。例如：`**/*.md` 匹配所有 markdown 文件，`floors/floor-*.md` 匹配楼层文件。

- `pattern`：glob 模式，相对于实例根目录

## SkillRead

读取指定 Skill 的教学内容（SKILL.md），获得该 Skill 完整的方法论和 SOP。

- `name`：Skill 名称，例如 `generate-floor`、`summarize`

## Generate

**【实验性工具】** 构造正文生成请求。

- `messages`：消息数组，每项包含 role 和 content。content 中可使用 `{{path}}` 占位符引用文件内容。
- 占位符替换后，完整的请求会输出到 `current/generate-output.json` 供调试。
- 当前不会真正调用 LLM。

### 占位符语法

content 中可使用以下占位符引用文件内容：

```
{{path}}                            ← 引用整个文件
{{path:10-30}}                      ← 引用文件的第 10~30 行
{{path|from="关键字"}}              ← 从关键字所在行开始到文件末尾（含关键字行）
{{path|to="关键字"}}                ← 从文件开头到关键字所在行（含关键字行）
{{path|from="A"|to="B"}}            ← 从 A 所在行到 B 所在行（含 A，含 B）
{{path:10-30|from="A"|to="B"}}      ← 先取 10~30 行，再按锚点缩小
{{glob:模式}}                       ← 按 glob 模式匹配多个文件，按文件名排序
```

语法规则：
- **行号范围**用 `:` 加在文件名后：`{{file.md:10-20}}`
- **锚点修饰符**用 `|` 分隔：`{{file.md|from="A"|to="B"}}`
- 行号范围和锚点可混用：`{{file.md:10-30|from="A"|to="B"}}`
- 锚点值是精确子串匹配，必须唯一出现一次
- 如果不确定行号，优先使用 `from=` 锚点语法
