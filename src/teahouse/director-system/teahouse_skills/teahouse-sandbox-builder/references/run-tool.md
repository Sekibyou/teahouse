# 沙盒 API · 内联工具流水线（runTool）

### runTool(steps) → handle (可取消的 thenable)

依次执行一段**内联工具调用数组**（`[{tool, args}, ...]`），走**低延迟、确定的批量路径**，**不经过导演 LLM**。适合开场预设、回合推进、选项点击后的确定性流程：数组内各步（写文件、Generate 产正文、FileOps、GitCommit）由后端直接按序执行。

`steps` 元素形如 `{tool: "Write", args: {...}}`，与导演同名工具一致（同一 `execute_tool` 通道）。**不解析任何占位符**：需要运行时变量时，先用 `getVars()` 取到真实 js 值并在组装 `args` 时拼接，不要指望沙盒侧 `${{...}}` 占位符解析。

**返回一个可取消的 thenable handle**：bootstrap 内部自动管理 `run_uuid` 登记、`tool_run` 事件分拣、完成判定。handle **带 `.then` 可直接 `await`**，同时暴露两个成员：

- `.run_uuid` — 受理后即填充的本批 UUID，可用来主动打断
- `.cancel()` — 中途打断本批（等效 `Teahouse.cancelRunTool(run_uuid)`）

handle 的 Promise 语义：**在整批完成或失败时 resolve/reject**，UI 无需手动管理 pendingRuns 或订阅 tool_run 事件。

- 成功：`{ok: true, results: [{tool, result, ok}, ...]}` — results 数组按步骤顺序排列
- 失败：Promise reject，错误信息包含失败步骤和原因
- 被打断：`cancel()` 后 reject（`runTool 已取消：<run_uuid>`），**不会等 5 分钟超时**
- 超时保护：5 分钟无响应自动 reject

**中途取消（长 Generate 步骤）**：`runTool` 里若带 `{tool: "Generate", ...}` 这类可能跑很久的步骤，可让玩家随时打断。**已生成的部分会落盘为半成品供续写**（semantics 与"流中失败/中断"一致——`cancel()` 打断的 Generate 会把已累积正文写入目标 path，`-draft.md` 这类即可续写），只是整批 `runTool` 的 handle 会 reject。两种等价写法：

```js
// 方式 A：用 handle.cancel()，先在回调里暂存 handle
var h = Teahouse.runTool([{ tool: "Generate", args: {...} }]);
window.__abortGen = function() { h.cancel(); };   // 某按钮/时机调用

// 方式 B：用 Teahouse.cancelRunTool(run_uuid) 显式传 uuid
Teahouse.cancelRunTool(h.run_uuid);
```

```js
// 开场流水线：产第一楼 + 提交
var floorNum = 1;

Teahouse.runTool([
  { tool: "Generate", args: { source_file: "temp/opening.yaml",
                              path: "runtime/floors/floor-" + floorNum + "-draft.md" }},
  { tool: "GitCommit", args: { message: "floor-" + floorNum + ": 开场" } },
]).then(function(result) {
  console.log("流水线完成", result.results);
}).catch(function(err) {
  console.error("流水线失败", err);
});
```

与 `Teahouse.send()` 的分工：**要走导演的即兴创意/总结/润色 → `send()`**；**要走确定的批量流程（开场、选项后推进、git 提交）→ `runTool()`**。

## runTool 与子会话：两条路都可行

`runTool` 的步骤与导演工具走**同一条 `execute_tool` 通道**，因此 `StartSubSession` / `SendToSubSession` / `DeleteSubSession` **在 runTool 里是可用、被允许的**。沙盒侧另有 `Teahouse.sessionCreate` / `sessionSend` / `sessionDestroy` 封装（见 `subsessions.md`），二者对应关系与差异：

| 需求 | 走 runTool | 走 `Teahouse.session*` |
|---|---|---|
| 建子会话（可同时投首个任务） | `{tool:"StartSubSession", args:{task, enabled_tools?, reasoning_effort?}}` ✅ | `sessionCreate({enabled_tools})` ✅ |
| 追加指令 / 投任务 | `{tool:"SendToSubSession", args:{session_id, message}}` ✅ | `sessionSend(sid, message)` ✅ |
| 得知做完 | 订阅 `Teahouse.on("session_done", fn)` ✅ | 同左 ✅ |
| 回收 / 强停 | `{tool:"DeleteSubSession", args:{session_id, abort?}}` ✅ | `sessionDestroy(sid, abort?)` ✅ |
| 编排形态 | 与 Write/Generate/GitCommit **同一批次按序连做**（一次受理 ≤50 步） | 逐次 `callHost` 往返，需自己串 Promise |

**⚠️ 批次内不能"接着上一步的结果往下编"**：`runTool` 的每个 step 是**静态 `{tool, args}`**，args 里**拿不到前一步的返回值**。所以"建号 → 之后往它投任务 / 收尾删除"这种**需要 sid 的后续动作，不能塞进同一批**——sid 只能从 `StartSubSession` 那一步的 `tool_run` 结果里读到，再发下一批。要一步到位的"建号 + 投任务"就用 `StartSubSession` 自带的 `task` 参数（它会直接 enqueue 给子会话）。

**⚠️ 走 runTool 时的一个语义差异**：runTool 批次**没有所属会话**，所以 `StartSubSession` 建的子会话 `parent_session_id` 为空——
- `await_result` 对它**没有意义**（没有父会话可唤醒）；想让父会话被唤醒，用导演的 `StartSubSession` 或沙盒的 `sessionCreate` 路径。
- 但 `EndSession` 的 `session_done` 广播**照常发出**（`execute_end_session` 无条件广播），沙盒订阅 `Teahouse.on("session_done", fn)` 仍能收到并收尾。
- `SendToSubSession` / `DeleteSubSession` 只认 `args.session_id`，**与父会话无关，行为与导演调用完全一致**。

一句话：**runTool 是"我自己按计划连做几步"，沙盒 `Teahouse.session*` 是"一步一个 API 调用"**；两者都能开/管子会话，按编排形态选——把子会话塞进一条确定性流水线时用前者，按需随手开关时用后者。
