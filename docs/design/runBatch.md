# runBatch — 沙盒触发的预设脚本（无导演独立执行）

状态：**设计文档（milestone）**，本次仅沉淀，未实现。

## 背景 / 动机

交互范式演进：从"命令式导演"转向"声明式预设 + 导演后处理"。创作者想用**预设 JSONL 脚本**驱动游玩流程（开场、回合推进、选项点击、git 提交、直接 generate 正文），让用户在游玩时走**低延迟、确定的批量路径**，不经过导演 LLM。导演退居"生成后处理"（总结、改设定、润色、定制化选项）。

现有 `BatchExecute` 是**导演专用**工具（经 LLM function calling 发起，展开后结果喂回导演 messages）。沙盒 iframe 无法触发它。需给沙盒新增 bridge 方法 `runBatch(path)`，后端在**无导演、不喂 LLM** 前提下执行一段 jsonl 脚本。

## 语义（已与创作者对齐）

- **无导演参与**：runBatch 完全独立，不读写导演 messages/session，结果不进导演上下文。
- **一次性返回汇总**：整个 jsonl 跑完，所有步骤结果聚成一个数组返回沙盒一次（不做流式逐步广播）。
- **失败即停**：任一步失败 → 停止，返回「已执行步骤 + 失败步原因」，后续步骤不执行。
- **上下文自维持**：动态上下文（glob lastN + 设定文件 + 变量）由预设规则自给自足，不依赖导演拍板；配合 [条件切片占位符](./conditional-slice.md) 可按变量值选分支。
- **SSE 免费**：各工具执行器自己 `state.broadcast`，沙盒经既有 `useSSERefresh` 自动刷新。

## 已核实的复用事实

- `load_batch(instance_dir, raw_path)` — `src/teahouse/script.py:51`：解析 jsonl → steps，支持行切片 / 上限（默认 50）。
- `execute_tool(name, args, instance_dir, user_id, instance_id)` — `src/teahouse/tools.py:1088`：单工具执行，内部分发（Generate 传 user_id、GitCommit 传 instance_id、其余 instance_dir）；含路径校验。
- `execute_generate(instance_dir, args, user_id)` — `tools.py:533`：**完全自足**（自读 yaml、自解析 `${}`/`{{}}`、自建 writer_client），唯一硬性要求非空 `user_id`；无导演上下文也可调用。
- **SSE 免费**：Write（tools.py:373）、Generate（tools.py:667）、FileOps move/delete（tools.py:748,760）、GitCommit（tools.py:918）各工具执行器都自带 `state.broadcast`（同步推 asyncio 队列）。
- 后端路由：`src/teahouse/routes/workspaces.py`，`router = APIRouter(prefix="/api")`；端点骨架克隆 `save_instance_file`（workspaces.py:486-503）；request 模型仿 `RuntimeVarsUpdateRequest`（workspaces.py:522-526）。
- 沙盒 API：`window.Teahouse` 是普通对象，各方法经 `callHost(method, args)` postMessage 到宿主（bootstrap.js:36）；`renderRichText` 即 `callHost('renderRichText', [text])`（bootstrap.js:95）。`runBatch` 照此暴露。
- 前端：`api.ts` `request<T>()`→`post<T>()`；`instancesApi` 加助手（api.ts:166-212）；错误形状 `RequestResult<T>={ok,data,error}`，后端 `HTTPException` 的 `detail` 被 api.ts:55 读走。
- 桥：`SandboxManager.tsx` `handleMessage` switch（167-224），克隆 `setVar` 分支（194-211）。

## 数据流

```
沙盒场景 JS
  await Teahouse.runBatch("settings/scripts/opening.jsonl", {name:"阿悠"})
    │  callHost('runBatch', [path, args]) → postMessage 宿主
    ▼
SandboxManager.handleMessage "runBatch" case
    → instancesApi.runBatch(instanceId, path, args)
    → POST /api/instances/{id}/batch/run
    ▼
后端端点 run_instance_batch
    → load_batch(instance_dir, path)            # 解析 jsonl → steps
    → for step in steps: execute_tool(...)      # 逐条执行，各自 SSE 广播
    → 失败即停 / 全部完成 → 返回汇总 dict
    ▼ 返回 {ok, completed:[...], failed?:{...}}
宿主 postMessage {_callId, _result} → 沙盒 await 拿到汇总
```

## 改动清单（落地时的实现方案）

### 1. 后端端点 `POST /api/instances/{instance_id}/batch/run` — `src/teahouse/routes/workspaces.py`

克隆 `save_instance_file`（workspaces.py:486-503）骨架。新增 request Pydantic 模型字段：`path: str`（必填，相对实例根，支持 `:start-end` 行切片）、`args: dict | None`（可选，供脚本内传给各步，与步骤自身 args 合并、步骤优先生效）。

```python
@router.post("/instances/{instance_id}/batch/run")
async def run_instance_batch(instance_id, body, user=Depends(require_user)):
    u = await require_user_info(user)
    inst = await get_instance(instance_id)
    if not inst or inst["user_id"] != u["id"]:
        raise HTTPException(404, "Instance not found")
    instance_dir = _resolve_instance_dir(inst)
    user_id = u["id"]
    try:
        steps = load_batch(instance_dir, body.path)      # script.py:51
        results = []
        for i, step in enumerate(steps, 1):
            name = step["tool"]
            cargs = {**step.get("args", {}), **(body.args or {})}
            res = await execute_tool(name, cargs, instance_dir, user_id, inst["id"])
            results.append({"index": i, "tool": name, "result": res})
            if res.startswith("Error"):                  # 失败即停
                return {"ok": False, "completed": results,
                        "failed": {"index": i, "tool": name, "result": res}}
        return {"ok": True, "completed": results}
    except BatchError as e:
        raise HTTPException(400, f"批量脚本错误: {e}")
```

补 import：`from ..script import load_batch, BatchError`、`from ..tools import execute_tool`。

### 2. 前端 API 助手 `instancesApi.runBatch` — `teahouse-frontend/src/lib/api.ts`

在 `instancesApi`（166-212）加：

```ts
runBatch(instanceId: string, path: string, args?: Record<string, unknown>) {
  return post<BatchRunResult>(`/api/instances/${instanceId}/batch/run`, { path, args })
}
```

导出类型 `BatchRunResult = { ok: boolean; completed: {index:number; tool:string; result:string}[]; failed?: {index:number; tool:string; result:string} }`。

### 3. 沙盒桥 `runBatch` — `teahouse-frontend/src/components/SandboxManager.tsx`

switch（194 `setVar` 处）加 case，克隆 `readFile`/`setVar` 风格：

```ts
case "runBatch": {
  if (instanceId && _args[0]) {
    const res = await instancesApi.runBatch(instanceId, _args[0], _args[1])
    result = res.ok ? res.data : { ok: false, error: res.error }
  }
  break
}
```

### 4. 沙盒 API 暴露 — bootstrap.js

在 `window.Teahouse` 对象加（参考 `renderRichText`，bootstrap.js:95）：

```js
runBatch: function(path, args) { return callHost('runBatch', [path, args]); },
```

## 创作者用法示例

- **开场**：`runBatch("settings/scripts/opening.jsonl", {出身:"A"})` → 脚本内 `FileOps move disabled/A.md → floors/floor-1.md` + `Generate` 产第一楼 + `GitCommit`。
- **回合推进**（可配 [条件切片](./conditional-slice.md)）：点击选项后 `setVar` 改变量 → `runBatch` 内 `Generate` 按变量选定分支 → `FileOps draft→正式` → `GitCommit`。

## 边界（明确排除）

- **不新建"批处理 runner"独立模块**：直接复用 `load_batch` + `execute_tool`，一个 for 循环。
- **不碰导演 LLM 循环**：结果不进导演 messages/session。
- **不下发导演工具全集**：runBatch 只认脚本里写的工具名；安全边界 = 脚本内容信任 + 每工具 `_validate_path`。不额外开放沙盒任意调用工具。
- **不做并发控制**：沙盒 batch 与导演后台总结并发写同文件，由创作者编排避免；后续按需加固。
- **不做流式逐步广播**：一次性返回汇总。

## 验证（落地时）

1. `cd teahouse-frontend && pnpm build` 通过。
2. 最小 jsonl（1 条 `{"tool":"Write","args":{"path":"temp/x.txt","content":"hi"}}`）→ 返回 `{ok:true, completed:[...]}`；文件生成；SSE `file_changed` 触发。
3. 失败即停：第二条给非法路径 → `{ok:false, completed:[首条], failed:{...}}`，后续步骤不执行。
4. Generate 步：带认证 user_id → 正常产文件（不依赖导演）。
5. 沙盒：场景 JS `await Teahouse.runBatch("settings/scripts/opening.jsonl")` → 开场就位、floor-1.md 生成、沙盒经 SSE 自动刷新。
