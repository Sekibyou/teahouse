# 行为准则

## 任务清单

当面对复杂的多步骤任务时（3 个以上独立步骤），使用 TodoWrite 工具创建任务清单追踪进度。简单任务无需使用。

规则：
- 同时只能有一个任务为 in_progress
- 每次调用传入完整的 todos 数组，全量覆盖
- 任务完成后标记为 completed，不要从数组中删除
- 清单仅存在于当前会话，不持久化

## 工具调用上限

**单轮对话中最多进行 15 次工具调用（指 15 轮 LLM ↔ 工具交互）。**

最佳实践：
- 不要一次性把所有工具调用都挤在一轮里发出。先调用最关键的几个工具，收到结果后再根据实际情况决定下一步。
- 每次调用工具后，分析返回结果，再规划下一批工具调用。这样更高效，也避免超出上限导致任务中断。
- 如果确实需要大量工具调用，请分批进行：完成一批后，在下一轮对话中继续。

## 基本规则

1. **按需读取**——在操作前先 Read 相关文件，了解当前状态。
2. **增量修改**——优先使用 Edit 进行精确修改，仅在必要时使用 Write 覆盖整个文件。
3. **路径规范**——所有文件路径都是相对于实例根目录的，不要使用绝对路径。
4. **单次聚焦**——一次只做一件事，完成后再进行下一步。
5. **出错告知**——如果某个操作失败，分析原因后重试或调整方案。

## 沙盒输出机制（文件系统驱动）

**正文和沙盒代码的「输出」即文件落盘，没有任何推送工具。** 前端监听导演的工具调用（Write/Edit/FileOps 等触发 `file_changed`）后自动刷新读取：

- **正文历史**：写入 `.teahouse/output/floors/` 下的 `floor-N-draft.md`（写稿中）或 `floor-N.md`（定稿）。前端靠**文件名中间数字**排序展示。
- **沙盒代码**：写入 `.teahouse/output/sandbox/*.js` / `*.css`。渲染器按文件名分派——`bootstrap.js` 最先执行、`*.css` 注入 `<head>`、其余 `*.js` 追加挂载。
- 调用 Generate 生成正文前，须先构建对应的 YAML 配置文件（`source_file`）组织消息结构；在配置文件内需引用历史楼层入上下文时，用 `{{glob:output/floors/floor-*.md:lastN}}` 占位符自动按楼层数字取最近 N 层窗口。
- 沙盒代码需整体禁用时，把 `.teahouse/output/sandbox/` 下的文件移到 `.teahouse/output/sandbox/disabled/`（除 `disabled/` 外均启用；此子目录内文件渲染器不读，移入即禁用）。

## 实例目录结构

每个实例的目录结构如下。使用 Glob 工具探索目录内部文件。

| 目录 | 性质 | 用途 |
|---|---|---|
| `.teahouse/output/sandbox/` | 必需 | 沙盒渲染代码（bootstrap.js 最先、*.css、其余 *.js） |
| `.teahouse/output/sandbox/disabled/` | 可选 | 沙盒代码禁用区（除本子目录外均启用；移入即禁用，渲染器不读） |
| `.teahouse/output/floors/` | 必需 | 正文历史（floor-N.md 定稿 + floor-N-draft.md 半正式稿） |
| `.teahouse/text-style-rules.yaml` | 必需 | 文本样式着色规则 |
| `.teahouse/dyn_settings/` | 推荐 | 动态设定（关系、所在地、任务进展等可变状态，总结产出，入 git） |
| `.teahouse/dyn_settings/summary/` | 必需 | 汇总流水账 `sum-N-M.md`（导演回溯参考，不进正文 Bot 上下文）+ `index.json`（归档界，后端自动维护） |
| `.teahouse/generate-config/` | 推荐 | Generate 配置模板（引用 dyn_settings/static_settings 切片，更新跟随总结） |
| `static_settings/` | 推荐 | 长期静态设定（背景板/修为/势力，gitignore，只读引用） |
| `temp/` | 推荐 | 临时文件：真草稿（draft-{N}-{V}.md） |

## 建议设定格式

设定文件（`settings/`）建议采用带明确起止标记的区块格式（如 XML 风格标签），以配合切片工具的 `from=` / `to=` 锚点按区块精确截取、注入上下文：

```yaml
<游戏规则说明>
...
</游戏规则说明>
```

引用时用切片句子精确抓取该区块（`from=` 起点、`to=` 终点，均为包含行）：

```
{{settings/gamerule.md|from="<游戏规则说明>"|to="</游戏规则说明>"}}
```