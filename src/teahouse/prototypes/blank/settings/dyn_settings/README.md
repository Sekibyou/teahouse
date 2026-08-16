# 动态设定（入 git，随游玩变动）

本目录存放**随剧情变化的可变设定**，由总结（teahouse-summarize）产出并维护：
- 主角与某人的关系、当前所在地介绍、任务进展等**中短期文字状态**；
- 归档界由顶层 `../summary/index.json`（后端自动维护）记录，流水账 `sum-*.md` 也在 `../summary/`。

规则：
- **纳入 git 版本控制**。总结子会话提交时用
  `GitCommit(type="summary", paths=["settings/dyn_settings", "generate-config", "summary"])` 只提交动态设定相关改动，不与主会话的楼层提交互相污染。
- **总结子会话是主要写入方**；前台游玩（generate）写 `runtime/runtime_vars.jsonl` 和 `runtime/floors/`，落地的动态设定也写这里。

引用本目录内容用占位符切片，例如 `{{settings/dyn_settings/relationship.md}}`。
