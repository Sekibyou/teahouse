# scripts/ —— 预制脚本（RunScript）

这里放**预制脚本**：一段 Python 流程，供导演/DM 用 `RunScript` 工具**传参调用**。

和「子会话」的区别：子会话里有个 AI 在拿主意；脚本里**没有 AI 决策**，只是一条确定性流水线。
所以它不消耗对话上下文、不占用会话，适合重复发生的事（后台产出素材、批量归档、定期更新）
和步骤之间有数据依赖的编排（Generate 产出 → 读回来裁剪 → 追加进某个 json）。

> **目录是约定，不是强制**：脚本放在实例内任何路径都能跑（`RunScript` 的 `path` 就是普通实例路径）。
> 除非某脚本与某类设定强绑定、放一起更合理，否则**都放这里**。
> ⚠️ 与 `skills/<名>/scripts/` 含义不同：那是 skill 自带的辅助脚本，不是给 `RunScript` 用的。

## 怎么写

一个脚本 = 一个 `.py` 文件。它是一段**平铺的 async 序列**（可以顶层 `await`，读起来像 bash 脚本），
也可以定义 `async def run(t, args)` 当入口。两种入口的规则：

- **只定义 `run`、顶层不调用它** → 引擎在顶层跑完后**自动调用一次** `run(t, args)`，其返回值显示在
  `--- 返回值 ---` 段。
- **顶层自己调了 `run`（如 `await run(t, args)`）** → 引擎**不再自动调用**（否则会双跑，同一件事做两遍）。
  递归的自调用不算，引擎只认模块体里的调用。
- 建议二选一，别混着写。

所有能力都在注入的 `t` 对象上：

```python
# scripts/forum-post.py —— 按话题产出 N 条论坛发言，追加进 runtime/assets/forum.json
n = args.get("n", 3)
paths = [f"temp/forum-{i}.md" for i in range(n)]
for p in paths:
    await t.run_tool("Generate", {"source_file": "generate-config/forum.yaml", "path": p})

texts = [t.read_file(p) for p in paths]        # ← 读文件是【同步】的，不要 await；上一步结果拿得到
old = t.read_file("runtime/assets/forum.json") if t.file_exists("runtime/assets/forum.json") else "[]"
data = json.loads(old) + [{"topic": args.get("topic"), "text": x.strip()} for x in texts]
t.write_file("runtime/assets/forum.json", json.dumps(data, ensure_ascii=False, indent=2))
print(f"已产出 {n} 条")
```

### ⚠️ `t` 的接口：async 的只有三个，其余全是同步的

**漏写 `await` 不会报错，但那次调用等于没执行**（拿到一个没被等待的协程对象，`t.run_tool("Write", ...)`
漏 await 就是"没写盘"）。漏了会在脚本输出里留下 `[warn] ...没有被 await` —— 看到它就回去补 `await`。

| 方法 | async? | 说明 |
|---|---|---|
| `await t.run_tool(name, args)` | ✅ | 调一个导演工具（Generate / Write / GitCommit / SetRuntimeVar / StartSubSession…），返回结果文本 |
| `await t.run_tools([{tool,args}, …])` | ✅ | 批量串行；返回与入参等长同序的字符串数组 |
| `await t.roll("1d6")` | ✅ | 掷骰（复用引擎骰子语法），返回 int；非法表达式抛 `ValueError` |
| `t.read_file(p)` / `t.read_bytes(p)` | | 读文件；不存在抛 `FileNotFoundError` |
| `t.write_file(p, content)` | | 写文件（覆盖式，自动刷新前端）；返回 `None` |
| `t.file_exists(p)` | | 是否存在 |
| `t.list_files(subdir)` | | 列文件（相对实例根）。**目录不存在返回 `[]`，不抛** |
| `t.get_var(["金币","好感度"])` | | **传名字数组**（传单个字符串＝单元素列表）；返回**永远是列表** `[{name,value,type,min,max,…}]`；未声明的变量在结果里 `value` 为 `None`。**不传参＝返回实例内全部变量** |
| `t.set_var({"金币": 120}, note, change_log)` | | **传字典**；number 强校验类型、按 `min`/`max` 自动夹取；合并写入并保留元数据。返回 `None`（其余接口多返回字符串） |
| `t.log(msg)` | | 记一行输出（`print` 的输出同样会回传） |

### 错误约定（两套，别混）

- **`t.run_tool` 失败不抛异常**，返回以 `Error` 开头的字符串——下一步依赖它时自己判断。
- **文件与变量接口出错是抛异常**（路径越界、文件不存在、变量类型不符、权限不足）。
  **没被 `try/except` 接住时会中止整个脚本**，出错行与「出错前的输出」会一并回传。
  （所以你可以 `try: t.read_file(...) except FileNotFoundError:` 兜住它，脚本会继续跑。）

## 登记表

**新增脚本时在这里加一条**——导演和用户都靠它发现脚本（`RunScript` 的提示词会指引导演先
`Glob("scripts/*.py")` 再读本文件）。写清楚：干什么、要什么参数、什么时候该调。

| 脚本 | 用途 | 参数 | 何时调用 |
|---|---|---|---|
| *(示例：`forum-post.py`)* | *(按话题产出 N 条论坛发言，追加进 `runtime/assets/forum.json`)* | *(topic: str, n: int)* | *(玩家开启论坛界面时)* |

（上面这行是格式示例，加真脚本时**替换掉它**；没有脚本时把表格留空即可。）

## 注意事项

### 两套拦截，时机不同（决定能不能用 `try/except` 兜）

| 拦在哪 | 什么会被拦 | 能否 `try/except` 兜住 |
|---|---|---|
| **执行前·静态预扫描** | 禁用 import（见下）／禁用调用（`open`/`eval`/`getattr`/`dir`…）／危险 dunder 属性 | ❌ **兜不住**——整段拒绝执行，脚本根本不跑，只回一份违规清单（带行号） |
| **执行中·运行时** | 路径越界、越权写、变量类型不符、文件不存在 | ✅ 能兜住（接住就继续跑）；**没接住就中止整个脚本**，并回带出错行 + 出错前的输出 |

### 静态预扫描的三份清单

**① 可以 import 的（白名单，其余一律拒）**：
`json` `re` `math` `random` `datetime` `collections` `itertools` `string` `typing` `pathlib`
`uuid` `asyncio` `struct` `base64` `zlib`（外加无副作用的 `__future__`）。
要读写文件/网络一律走 `t.*`，不要指望 import 标准库的 io/os。

**② 禁止调用的名字**（无论在哪出现）：
`open` `exec` `eval` `compile` `__import__` `input` `breakpoint` `globals` `locals` `vars`
`getattr` `setattr` `delattr` `dir` `hasattr` `memoryview` `bytearray` `chr` `ord` `map`
（`dir`/`chr`/`ord`/`map` 本身无害，是为了堵住"用它们拼出反射路径"这类绕过，所以一并禁掉；
想看 `t` 有哪些方法，直接读本文件的接口表。）

**③ 禁止访问的危险属性**：
`__class__` `__subclasses__` `__mro__` `__bases__` `__globals__` `__dict__` `__builtins__`
`__code__` `__closure__` `__func__` `__self__` `__getattribute__` `__reduce__` 等。

> 这三份清单与**插件沙盒共用同一套门禁**（插件后端也跑在同一个受限环境里），所以改动会同时影响两边。

### 其他

- **不能访问网络**：外网一律走插件工具。
- **输出上限**：超过 20000 字符会**保留头尾、中间省略**；要看全量就把结果写进文件再 Read。
- **嵌套**：脚本里再调 `RunScript` 最多 3 层。内层的 `run()` 返回值与报错**都在内层那次
  `run_tool` 的返回值里**——调用方要自己用它（比如 `print`），否则看不到（不是被引擎丢掉）。
- **受调用方白名单约束**：脚本里写文件/变量也要过调用者的工具白名单——被授予 `RunScript` 但没有
  `Write` 的子会话，脚本只能写 `temp/`；没有 `SetRuntimeVar` 就不能 `t.set_var`。
- **变量**：`t.set_var` 写的变量若与某楼层变量块同名，会在下一次变量重算时被重放覆盖
  （与沙盒 `setVar` 是同一个坑）。
- **并发**：`import asyncio` 可用，但一次性扇出几十个 Generate 容易触发厂商限流——建议自己
  用 `asyncio.Semaphore` 控制并发（`BatchGenerate` 内置上限是 8）。
- **提交**：脚本改了正式区（`runtime/floors/`、`settings/`）后要不要 `GitCommit`，由脚本自己决定
  （在脚本里 `await t.run_tool("GitCommit", {...})`）。注意**脚本里提交不会弹审批**——审批拦在导演
  工具循环那一层（只有导演发起的 `GitCommit` 才拦），脚本与沙盒 `runTool` 一样是直接执行的。
