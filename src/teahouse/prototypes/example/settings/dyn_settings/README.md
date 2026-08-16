# 动态设定（入 git，随游玩变动）

本目录存放**所有随游玩过程发生变动的内容**，与长期稳定的 `../static_settings/` 相对：
- **动态设定**：主角与某人的关系、当前所在地介绍、任务进展等中短期文字状态。
- **游玩中途产生的设定**：导演按需在游玩中落地的新设定。
- **由静态模板物化出的实例**：先在 `../static_settings/` 读模板，再在本目录创建真正的内容（人物/宗门的实例设定）。

规则：
- **纳入 git 版本控制**。总结子会话用 `GitCommit(type="summary", paths=["settings/dyn_settings", "generate-config", "summary"])` 只提交动态设定相关改动，不与主会话楼层提交互相污染。
- **写入方**：总结子会话与游玩导演都可能写这里；前台游玩（generate）除写 `runtime/floors/` 和 `runtime/runtime_vars.jsonl` 外，落地的动态设定也写这里。
- **创建真实设定实例**：需要新设定时，从 `../static_settings/` 读模板 → 在本目录创建实例。

引用本目录内容用占位符切片，例如 `{{settings/dyn_settings/relationship.md}}`。
