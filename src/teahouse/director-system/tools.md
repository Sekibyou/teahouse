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

## Generate

**【实验性工具】** 构造正文生成请求。

- `messages`：消息数组，每项包含 role 和 content。content 中可使用 `{{path}}` 占位符引用文件内容。
- 占位符替换后，完整的请求会输出到 `current/generate-output.json` 供调试。
- 当前不会真正调用 LLM。
