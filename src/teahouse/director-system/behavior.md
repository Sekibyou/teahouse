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

## 楼层与总结命名规范

正文楼层必须存放在 `.teahouse/output/floors/` 目录下，总结摘要存放于根 `summary/` 目录，遵循严格的命名格式供系统统计与目录树展示：

| 类型 | 位置 | 命名格式 | 示例 |
|---|---|---|---|
| 正式楼层 | `.teahouse/output/floors/` | `floor-N.md` | `floor-1.md`、`floor-42.md` |
| 半正式稿 | `.teahouse/output/floors/` | `floor-N-draft.md`（每层唯一，就地覆盖） | `floor-3-draft.md` |
| 总结摘要 | `summary/` | `sum-N.md` 或 `sum-A-B.md` | `summary/sum-7.md`、`summary/sum-1-7.md` |

**正式定稿（已确认提交的楼层）必须为 `.teahouse/output/floors/floor-N.md`，严格遵循命名格式。**

- 半正式稿 `floor-N-draft.md` 是写稿过程中的可见输出，每层**唯一**，返工时就地覆盖；用户满意后重命名为 `floor-N.md`。
- 真草稿和中间产物写入 `temp/` 目录（按需创建），文件名不做格式要求。

## 正文输出机制（文件系统驱动）

**正文和沙盒代码的「输出」即文件落盘，没有任何推送工具。** 前端监听导演的工具调用（Write/Edit/FileOps 等触发 `file_changed`）后自动刷新读取：

- **正文历史**：写入 `.teahouse/output/floors/` 下的 `floor-N-draft.md`（写稿中）或 `floor-N.md`（定稿）。前端靠**文件名中间数字**排序展示。
- **沙盒代码**：写入 `.teahouse/output/sandbox/*.js` / `*.css`。渲染器按文件名分派——`bootstrap.js` 最先执行、`*.css` 注入 `<head>`、其余 `*.js` 追加挂载。
- 需引用历史楼层入上下文时，用 `{{glob:output/floors/floor-*.md:lastN}}` 占位符自动按楼层数字取最近 N 层窗口。
- 沙盒代码需整体禁用时，把 `.teahouse/output/sandbox/` 下的文件移到 `.teahouse/output_disabled/`（无子结构，目录本身即禁用标记）。

## 实例目录结构

每个实例的目录结构如下。使用 Glob 工具探索目录内部文件。

| 目录 | 性质 | 用途 |
|---|---|---|
| `.teahouse/output/sandbox/` | 必需 | 沙盒渲染代码（bootstrap.js 最先、*.css、其余 *.js） |
| `.teahouse/output/floors/` | 必需 | 正文历史（floor-N.md 定稿 + floor-N-draft.md 半正式稿） |
| `.teahouse/output_disabled/` | 可选 | 沙盒代码整体禁用开关（无子结构，移入即禁用） |
| `.teahouse/text-style-rules.yaml` | 必需 | 文本样式着色规则 |
| `summary/` | 必需 | 总结摘要文本（导演参考，不进正文 Bot 上下文） |
| `settings/` | 推荐 | 故事设定（角色、世界观等）及 Generate Payload 配置模板 |
| `variables/` | 推荐 | 故事变量（状态跟踪） |
| `assets/` | 推荐 | 静态资源（图片、字体、音频等） |
| `temp/` | 推荐 | 临时文件：真草稿（draft-{N}-{V}.md）、Generate Payload 配置（generate-config-{N}-{V}.yaml） |