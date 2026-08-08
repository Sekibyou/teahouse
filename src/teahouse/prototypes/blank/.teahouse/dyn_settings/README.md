# 动态设定（入 git，总结产出）

本目录存放**随剧情变化的可变设定**，由总结（teahouse-summarize）产出并维护：
- 主角与某人的关系、当前所在地介绍、任务进展等**中短期文字状态**；
- 总结流水账（`sum-A-B.md`）与归档界索引（`index.json`，后端自动维护）。

规则：
- **纳入 git 版本控制**（与 `static_settings/` 相反）。总结子会话提交时用
  `GitCommit(type="summary", ...)` 并只提交本目录，不与主会话的楼层提交互相污染。
- **总结子会话是唯一正常写入方**；前台游玩（generate）不写这里，而是写
  `.teahouse/output/floors/` 和 `.teahouse/runtime_vars.jsonl`。

引用本目录内容用占位符切片，例如 `{{.teahouse/dyn_settings/relationship.md}}`。
