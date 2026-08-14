# 总结归纳提示词模板

本文件是 input-bar 组件「总结归纳」模式的子会话任务提示词。由 `.teahouse/output/sandbox/input-bar/input-bar.js` 读取，替换 `__USER_REQUEST__` 占位符后派发给总结子会话。

**维护说明（导演可见）**：以下内容与创作强相关，按实际实例修改：
- 「本次总结要维护的动态设定」：列出 `.teahouse/dyn_settings/` 下需要总结时更新的文件
- 「本次总结要维护的变量」：列出需要在总结时按剧情更新的变量
- 「静态文件检查」：列出总结时需顺带检查的静态切片源

---

你的任务是执行一次「总结归纳」流程，把用户指定的楼层范围压缩归档。

【第一步 · 必须先加载技能】先用 SkillRead 读取 teahouse-summarize，严格按其中 SOP 执行总结。这是本任务的唯一方法依据。

【进度记录】请使用 TodoWrite 工具维护任务清单，逐步记录总结进度（读归档界 / 读楼层 / 更新设定与变量 / 写流水账 / git 提交），让用户能实时看到你做到哪一步。

【用户原始要求（用户在输入框手打的原文，请原样解读、严格遵循，不要擅自改动或扩大其范围）】
『__USER_REQUEST__』
以上是用户的原始要求。请以它为准：解析其中的总结范围（例如「最近10章」「71~79章」「总结到第80章」等），确定要覆盖的楼层编号区间。若原始要求未指明明确起点，先 Read .teahouse/dyn_settings/summary/index.json 读归档界 summarized_through（上次已总结到的结束楼层），以此为起点顺延。

【本次总结要维护的动态设定】
- .teahouse/dyn_settings/角色动态.md（覆盖式更新：当前心理/所在地/现场状态）

【本次总结要维护的变量】
- 好感度_角色A（B类状态，按剧情变化更新）
- 当前剧情阶段 / 剧情flag

【静态文件检查】
- 切片源是否需补区块（好感度阶段提示词.md 若出现新档位）

【执行流程 · 严格按 skill SOP】
1) Read .teahouse/dyn_settings/summary/index.json 确认归档界与已有流水账；
2) Read 本次待总结的全部楼层（.teahouse/output/floors/floor-N.md）；
3) 把对后续剧情有持续影响的信息沉淀进 .teahouse/dyn_settings/ 的动态设定文件，并更新变量（GetRuntimeVars / SetRuntimeVar）；
4) Write 流水账到 .teahouse/dyn_settings/summary/sum-A-B.md。注意：每次总结最多覆盖 10 章，超过 10 章需拆分成多个 sum-*.md 文件（如 sum-1-10.md、sum-11-20.md…），每个单独提交；
5) 用 GitCommit(type="summary", start=A, end=B, paths=[".teahouse/dyn_settings", ".teahouse/generate-config"], message="简短描述") 提交。若拆分为多个范围，逐个提交。提交前用 GitStatus / GitDiff(staged=true) 自查本次 stage 的正是总结自己的改动（别把主会话未提交的楼层/变量卷进来）。

【完成宣告】任务全部做完后，先以文本输出这句话：「总结已完成 ✓ 如希望清理，请输入 /clear」，然后调用 EndSession 宣告任务结束。EndSession 之后不要再输出任何内容。
