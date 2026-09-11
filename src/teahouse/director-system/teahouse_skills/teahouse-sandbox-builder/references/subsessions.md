# 沙盒 API · 子会话

一次性导演子任务。适合：一次性的总结、改设定、探索某设定、批量润色。子会话**独立上下文、受限工具**,干完可销毁,**不污染主会话历史**——搭建造型阶段测试子任务不会误伤正在进行的搭建主对话。导演自己也可在子会话里开子 agent 探索。

**沙盒建子会话 ≠ 导演 `StartSubSession`**：沙盒的 `sessionCreate` 只**开一个空档**给你手动操作——它不传任务、不记录调用方、也不自动唤醒你。所以沙盒侧的"自动化委派"必须自己走完三步：**①建号拿 sid → ②注入任务 + 订阅完成信号 → ③等信号处理收尾**。切记子会话完成后**不会通知到沙盒**，靠的是你订阅的 `session_done` 事件——不要假设它自己会回来找你。

> 另一条路：`runTool` 也能直接调 `StartSubSession` / `SendToSubSession` / `DeleteSubSession`（同一工具通道，已允许）。两者取舍与 runTool 路径的语义差异（父会话为空、`await_result` 无效）见 `run-tool.md`。本文件讲的是沙盒原生 `Teahouse.session*` 这条。

```js
var sid;

// ① 创建子会话 + 设立权限,拿到 sid
//   enabled_tools 未给 = 默认只读基础集(Read/Glob/Grep/CheckPackageRefs/SkillRead/GetRuntimeVars/GitLog/GitDiff/GitStatus/Report/EndSession);
//   按任务放开权限,例如允许改变量/写 temp 草稿/生成正文:
Teahouse.sessionCreate({
  enabled_tools: ["Read", "Glob", "Grep", "GetRuntimeVars", "SetRuntimeVar", "Report", "Generate", "EndSession"]
}).then(function(created) {
  // 注意：返回统一为 {ok, data|error}（与 readText 等一致）。成功用 created.ok 判断，
  //       session_id 在 created.data.session_id。
  if (!created.ok) throw new Error(created.error)
  sid = created.data.session_id
  startTask();          // ② 号建好才注入任务,别在拿到 sid 前发
  listenDone();         // ③ 同时挂上完成信号监听
})

// ② 注入任务文字(投进子会话后台循环即开跑);导演栏会自动切到这个子会话,
//    玩家能当场看到思考/工具过程,也能直接打字介入(见 API 的 sessionSend 说明)
function startTask() {
  Teahouse.sessionSend(sid, "把第 3~5 章总结为《宗门势力》设定,结论写入 Report temp/summary-1.md,完成后用 EndSession")
}

// ③ 等待完成信号以对接 —— 子会话导演调 EndSession 后触发(只发信号、不销毁会话)
function listenDone() {
  Teahouse.on("session_done", function(data) {
    if (data.session_id !== sid) return
    Teahouse.sessionDestroy(sid);  // 干完回收;若 mid-run 想强停,传 true
    // 对接产出:Read 子会话 report 用,或重新拉楼层(它若 Generate 了正文,output.refresh 会推)
  })
}
```

**等待期间不要傻等**：装完"建 → 送 → 挂"之后立即放回控制权,别在 `session_done` 到达前做会与之冲突的事；若子会话产出了正文/文件,宿主会照常推 `output.refresh`,沙盒据此重渲染即可。

## API

调用一律返回统一的 `{ok, data|error}` —— 用 `res.ok` 判成败、`res.error` 取错误理由。

- `Teahouse.sessionCreate(opts)` → `Promise<{ok, data:{session_id, enabled_tools}, error?}>`,`opts.enabled_tools` 可选(未给=只读基础集:Read/Glob/Grep/CheckPackageRefs/SkillRead/GetRuntimeVars/GitLog/GitDiff/GitStatus/Report/EndSession;`opts.reasoning_effort` 亦可选，设定该子会话的思考强度)。只建号、不投任务;成功同步落盘 meta,**创建后即可立即 `sessionSend`,无需等就绪**。
- `Teahouse.sessionSend(session_id, message)` → `Promise<{ok, data:true, error?}>`,把消息补发给指定子会话(等价于向该会话发一条 user 消息,但隔离上下文);任务与追加指令都走它。**发送会顺带聚焦**:宿主把导演栏切到该子会话,故派发后导演栏一露面就在这个子会话上、玩家不必自己点标签。聚焦只管"切到哪个会话",**不负责把折叠/隐藏的导演栏打开**——要让玩家当场看见,仍需在派发前自己调一次 `openDirector()`。另注意 `sessionCreate` 本身不聚焦:只建号不发消息时不会切过去。
- `Teahouse.sessionDestroy(session_id, abort?)` → `Promise<{ok, data:true, error?}>`,销毁子会话文件;`abort=true` 额外中止该会话进行中的生成。回收要你主动调,`session_done` 不会销毁。
- 事件:`Teahouse.on('session_done', fn)` / `Teahouse.on('session_destroyed', fn)`。**注意**:`sessionSend` 成功时返回的是 `{ok:true, data:true}`,不是 `true` 裸布尔——沙盒侧务必用 `res.ok` 判断,不要写 `res === true` 或 `res.ok === undefined` 这类旧假设。

## 权限

子会话只能调用其 `enabled_tools` 列表里的工具,默认禁止一切写正式区(floors/、`settings/dyn_settings/` 等)。想产出玩家可见正文/正式设定时,由具备写权限的主会话或沙盒落到正确目录。子会话拿到的探索结论用 `Report` 写 `temp/*.md`(`temp/` 不纳入 git 版本控制,安全)。
