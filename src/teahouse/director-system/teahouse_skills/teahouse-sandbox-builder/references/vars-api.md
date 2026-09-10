# 沙盒 API · 变量与转正

## 沙盒变量

### `Teahouse.setVar(payload) → Promise<{name,value}[]>`

原子合并写入实例变量，落盘到 `runtime/runtime_vars.jsonl`（**文件即状态**，导演中断时仍能恢复）。该文件是**派生的工作值、被 gitignore**；真正入 git 的是转正时冻结的 `runtime/runtime_vars_snapshot.jsonl`。返回**写后全部变量** `[{name, value, type?, min?, max?, note?, change_log?}]`。

**只接受一个参数对象**，两种形态：

```js
// ① 简写：{name: value}，值为任意 JSON 可序列化对象（标量/嵌套皆可）
await Teahouse.setVar({ user_name: "LowStar", opt_3_1: "opt2" })
```

```js
// ② 完整形态：显式给出 updates 等字段（可同时声明类型/边界、备注、删除）
await Teahouse.setVar({
  updates:    { 金币: 30 },                      // 覆盖值（缺名的变量会被创建）
  meta:       { 金币: { type: "number", min: 0, max: 999 } },  // 声明类型/数值边界
  note:       { 金币: "当前持有的金币数" },        // 覆盖该变量的备注
  change_log: { 金币: { at: "第3章", to: 30 } },  // 追加一条历史笔记
  delete:     ["废弃变量"]                        // 删除指定变量名
})
```

> 完整形态是**一个对象**、不是第二个参数——`Teahouse.setVar(updates, meta)` 这样的双参调用**不生效**（bootstrap 只转发第一个参数）。
> 变量名禁空白/冒号/`@`（`${...}` 标识符与 `${@type ...}` 语法要求），非法名会被后端 400 拒绝。

**写者约定**：变量是**沙盒与导演共享**的（沙盒 `setVar` 写、导演 `SetRuntimeVar` 工具写，落盘同一文件），用于记录"高度精炼的剧情数值 + 界面临时状态"。判断何时该用变量：**频繁变动、追求极短、供程序使用**（金币、选项选择）；较长的文字状态属于 `settings/dyn_settings/` 动态设定，沙盒用 `writeFile` 维护，但注意**不要用 `writeFile` 写正文楼层**（有并发/精确性风险）。沙盒要推进剧情就走 `Teahouse.send()` 告知导演。

### `Teahouse.getVars(names) → Promise<{name,value}[]>`

按名读取沙盒变量。`names` 为变量名数组，不传则读全部。用于沙盒内重新渲染（如点击后回显选中态、把 `${user}` 替换为实际值）。

```js
const [user] = await Teahouse.getVars(["user_name"])
// => [{ name: "user_name", value: "LowStar" }]
```

> **🚨 空值 / 缺值语义（最容易写错的地方）**
>
> **你请求的每个名字都会出现在返回数组里；未初始化的名字 `value` 为 `null`。** 变量文件 `runtime/runtime_vars.jsonl` 不存在、或某个变量从未写入，效果完全一样——对应条目返回 `{name, value: null}`。
>
> **只在你明确传入 `names` 时才保证"每个名字都有"**；不传 `names`（读全部）时，未初始化的变量根本不在，返回的都是已存在的：
>
> ```js
> // 假定只写过 name1="陆霜"：
> getVars(["name1","name2"])       // => [{name:"name1",value:"陆霜"},{name:"name2",value:null}]
> getVars()                        // => [{name:"name1",value:"陆霜"}]   // 读全部，只有已存在
> ```
>
> **因此代码用 `value === null` 判断"未初始化"**，给出回退，不要用 `undefined` 判断（`null` 是稳定值；`undefined` 只在 JSON 序列化边界才出现）。参考范式：
>
> ```js
> function resolveNames(markdown) {
>   return Teahouse.getVars(["name1","name2"]).then(function(entries) {
>     var valueMap = {};
>     for (var i = 0; i < entries.length; i++) valueMap[entries[i].name] = entries[i].value;
>     return markdown.replace(/\{\{name(\d+)\}\}/g, function(full, num) {
>       var val = valueMap['name' + num];
>       return (val !== null && val !== '' && val !== undefined)
>         ? val
>         : '未命名';          // 未初始化/空 → 回退
>     });
>   });
> }
> ```
>
> 同理，`setVar` 的返回是"写后全部变量"，也可用它做 `getVars` 的镜像缓存。

### `Teahouse.roll(expr) → Promise<number>`

按 RPG 骰子语法掷骰并返回 int 总数。**复用后端 placeholder 的同一套 `roll()` 语法（单一事实源）**，与导演代码块 `${ if...: }` 里的 `roll("1d6")` 语义完全一致。异步（经后端往返），需要 `await`：

```js
const dmg = await Teahouse.roll("2d6+1")
const loot = await Teahouse.roll("4d6k3")   // 保最高 3 个
```

支持语法（同导演 `roll()`）：`XdN` + 可选 `kN`(保最高) / `dlN`(丢最低) / `rN`(重掷≤N) / `roN`(重掷一次≤N) / `e`/`!`(爆炸) / `p`(穿透) / 尾随 `+/-` 修正，如 `"1d6"`、`"2d10+5"`、`"4d6k3"`、`"4d6dl1"`、`"1d6r1"`、`"1d6!"`。非法表达式 → Promise reject。

### 变量字面量替换：`Teahouse.replacePlaceholders(text, fallbacks?) → Promise<string>`

沙盒默认**不自动**把正文里的 `${name}` 字面量替换为变量值（渲染层须接触原始正文、且要留机会做特效特写，如 `${user_name}` → 正则 → `[rainbow]LowStar[/rainbow]`）。需要统一替换时**显式传入要处理的文本**，返回替换后的文本：

```js
// 传入 markdown / 正文片段，返回替换后的字符串
Teahouse.replacePlaceholders(markdown).then(function(text) { /* 用 text 渲染 */ })

// 可选第二参：某个变量为空（null/空串）时用它兜底
Teahouse.replacePlaceholders(markdown, { user: "无名客" })
```

实现细节：取全部变量（内部 `getVars([])`）建 `name → String(value)` 映射，正则 `/\$\{([^}]+)\}/g` 做**固定字符串替换**；变量不存在则原样保留 `${name}`（传了 `fallbacks` 则用兜底值）。**没有"不传 text 就整页替换"的重载**——不传 text 会被 `String(undefined)` 处理，务必显式传文本。

替换是固定字符串替换，仅当某值想"全篇统一变成字面值"时用；要做灵活特效，直接在已替换的文本上做正则特写更灵活。

### 导演侧读写：`GetRuntimeVars` / `SetRuntimeVar`

导演**既能读也能写**变量（`GetRuntimeVars` 读、`SetRuntimeVar` 写，走同一 `runtime/runtime_vars.jsonl`）。沙盒选择类状态（如 `opt-3-1: opt2`）常作为"文件即状态 + 中断可恢复"的关键：用户点击选项→ `setVar` 即时落盘 → `send()` 通知导演 → 导演 `GetRuntimeVars` 读取续写。即便导演中途中断，变量已落盘，重启后仍可找回。核心变量会注入导演系统提示词（no cache），导演通常无需额外读取。

## 变量生效与转正：`Teahouse.refresh()` / `Teahouse.commitDraft(N)` / 回档 `Teahouse.gitDiscard()`

**核心约定：变量在草稿落盘那一刻即生效，不必等转正。** 实例只有**一类变量、两个文件**：

- `runtime/runtime_vars.jsonl` —— **工作值**（gitignored，派生文件，可随时删除重建）。沙盒 `setVar` 与导演 `SetRuntimeVar` 都写它；一切读取（`getVars`、`${}` 占位符、导演系统提示词）都取自它。
- `runtime/runtime_vars_snapshot.jsonl` —— **权威快照**（入 git）。只在转正时由后端写入，等于转正那一刻的完整变量状态。

正文里的 `<!-- teahouse-vars: [...] -->` 块**永远保留在正文里**：转正不剥离、不打 `msg` 标记、不产出 `floor-N-meta.json`。后端会在每次读取变量时重放「所有比最后一个正式楼层更新的楼层文件」（即草稿）里的块——所以**草稿一落盘，变量就更新**；改写草稿后重放一次即可，始终幂等。

> **准则：正式楼层不可变。** `runtime/floors/floor-N.md`（定稿）是 git 锁定的历史，**包括其中的变量块在内，一律不要修改**——要改就走回退 / 新建分支（那是分支操作，不是"改"历史）。只有草稿 `floor-N-draft.md` 可以任意修改、重写。
>
> 引擎**不校验**这一点：若绕过约定直接改了某个旧正式楼层的变量块，该块不会再被重放，快照与正文会**静默不一致**（变量停在旧值，无任何报错）。所以这是一条必须自觉遵守的约束。
>
> 万一已经发生了（或变量状态明显错乱），导演可调用 **`RepairVars`** 兜底：以 git 历史里最早的变量快照为基底，从零重放所有正式楼层（+ 当前草稿）的变量块，重建变量并重新冻结权威快照。幂等，只动变量、不碰正文。

### `Teahouse.refresh() → Promise<{ok, data|error}>`

**让后端立即重算变量**并返回 `{vars}`。**凡沙盒里合法地创建 / 修改 / 重写了 `runtime/floors/floor-N-draft.md`（或改了 `runtime_vars.jsonl`）之后，都应当调用一次**——这样依赖变量的界面（选项、状态栏、分支判定）随草稿即时更新，而不是等到转正。

```js
await Teahouse.refresh()      // 重算并拿到最新变量
```

> 读变量（`getVars`）的读路径本身也会触发重算，`refresh` 是主动推送一次，让界面在新草稿落盘后立刻对齐。建议在收到 `output.refresh`（`path` 以 `runtime/floors/` 开头）时调用。

### `Teahouse.commitDraft(N) → Promise<{ok, data|error}>`

草稿 `floor-N-draft.md` 转正为正式稿 `floor-N.md`：**后端一次完成**「重算变量（含本楼草稿）→ 冻结快照 → 改名 → git 提交」，沙盒只发一个请求（单向闸门，请求-响应语义）。`data`：

```js
{ num, path, title, commit_hash,
  failed: string[],          // 变量块解析/应用失败的说明（可空）
  committed_draft: bool,     // true=本次新转正；false=已是正式稿（幂等）
  commit_warning?: string }
```

分支语义：
- `floor-N-draft.md` 存在 → 正常转正：变量重算到本楼、快照冻结在 N、文件改名并以 `floor-N: <标题>` 提交。
- `floor-N.md` 已存在 → **幂等返回**（`committed_draft=false`），不动正文与 git。不再有"二次补解析"分支。

判断「是否有失败」用 `data.failed.length > 0`。**转正不由导演做**：不要 `FileOps move` + `GitCommit`。

**适用**：草稿确认按钮（转正本章）/ 标准件 `novel-main.js` 输入条的 `AWAIT_COMMIT` 态（其"写下一章"会先转正当前草稿）。

### `Teahouse.gitDiscard() → Promise<{ok, data|error}>`

**重写 = 回档**：git 丢弃所有未提交改动（`git checkout -- .` + `git clean -fd`，连 untracked 的 `floor-N-draft.md` 一并清除）。用于"这版草稿不满意，回到上一正式稿状态重新生成"。工作值同时失效，下次读取变量时由快照重建——**存档点之外的临时状态会被回档，这是期望行为**。

> 与「重写本章」的取舍：本 API 是**推倒重来**（连草稿文件一起丢弃）；若只想在现有草稿上覆写，标准件走的是 `Generate` overwrite（不碰 git），二者不要混用。

> 注意：`refresh` / `commitDraft` / `gitDiscard` 走宿主 `SandboxManager` 桥（`callHost`），非 runTool。它们不经过导演 LLM，无法由导演工具集触发——由沙盒 UI 或沙盒脚本调用。
