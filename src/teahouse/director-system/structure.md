# 实例目录结构（引擎约定，固定不变）

实例顶层路径由引擎约定死：只改这些位置里的内容，不挪结构本身。

- `teahouse.md` — 实例配置，始终注入你的上下文
- `runtime/` — 游玩运行时（直接影响画面 / 剧情）
  - `floors/` 正文历史 · `sandbox/` 沙盒渲染 · `assets/` 二进制资源
  - `runtime_vars.jsonl` 变量系统 · `text-style-rules.yaml` 着色规则
- `settings/` — 作者设定与组装
  - `static_settings/` 长期静态设定（只读引用） · `dyn_settings/` 动态设定
  - `assemble.md` 正文组装器 · `key-vars.md` 变量清单
- `generate-config/` — 正文生成 / 补全的 yaml（薄壳，引用组装器）
- `summary/` — 总结流水账 + 归档界索引
- `skills/` — 实例自建 skill（同名时系统内置优先，实例副本不生效）
- `temp/` — 临时草稿 / 报告（不进 git）
- `dm.yaml` — 存在即启用 DM（跑团 / 聊天式）

以上是**固定约定，不反映当前磁盘的实际内容**（本段是常量，不随文件变动刷新）。
要知道某个目录里此刻到底有哪些文件，用 **Glob** 工具探索（如 `runtime/floors/*.md`）。
