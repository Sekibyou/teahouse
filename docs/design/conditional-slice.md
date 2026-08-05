# 条件切片占位符 — 变量驱动的 `if...return...` 块

状态：**设计文档（milestone）**，本次仅沉淀，未实现。

## 背景 / 动机

现有占位符体系（见 `src/teahouse/placeholder.py` docstring）两类，语义有意分离：

| 语法 | 含义 | 解析阶段 |
|---|---|---|
| `{{path\|切片}}` | 文件切片（纯拷贝/搬运，无判断） | Write/Edit/WriteLine 显式 `resolve_placeholders=true`；AI 表面 lenient |
| `${name}` | 变量引用（值替换，无判断） | AI 表面（导演提示词 + Generate） |

两类都**不含判断**。但实际创作常需要"按变量值选一段内容灌给正文 bot"：

- 骰子：`dice=5` → 只发那一档，而非把整段 1~6 的阶梯规则全灌给正文 bot。
- 阶梯提示词：按好感度选一段几千字的描写准则/文风参考，命中即整段物化，未命中分支**不进入上下文**。

现状把这些判断全部交给导演或正文模型"自己现场判断"，导致：下回合才生效（导演）、或上下文膨胀（全发给正文 bot）。需要**声明式条件切片**，在解析阶段就地选分支。

## 设计决策（已与创作者对齐）

1. **语法形态**：多行 `${ ... }` 块 + `if / elif / else / return` 标准 Python 语法。块内首现 `return `（`return` 后跟空格）作为"这是代码块"的触发器。
2. **作用域**：**所有 AI 表面**都启用——`resolve_variables` 统一处理 → 导演系统提示词组装 + Generate 都覆盖。理由：导演虽然通常应理解全貌，但创作者可能用它做模式切换等。
3. **执行器**：**AST 白名单求值器**（非 exec、非受限子解释器）。
4. **配套**：
   - 变量命名**禁止空白**（作为代码块中合法 Python 标识符被引用的前提）。
   - `Generate` 的 `dump_payload_path` 改造成 **dry-run**：填了只产 resolved payload JSON，不调用正文模型，供创作者调试。

## 语法设计

### 代码块（有 return）

```yaml
- role: system
  content: |
    当前判定如下：
    ${
    if dice == 6:
        return "{{room1}}"
    elif dice >= 3:
        return "{{room2}}"
    else:
        return "默认情况"
    }
```

- `return "..."` 的值可以是纯文本，也可以是 `{{file:...}}` / `${var}` 占位符。
- 值展开**一次**，后续交给外层 `resolve_variables` 的深度循环（`MAX_RESOLVE_DEPTH=10`，placeholder.py:44）续展。因此 `return "{{room1}}"` 里再嵌切片/变量能继续解析。

### 变量取值（无 return）

块内无 `return ` 触发器 → 按普通变量解析：`${name}` 取变量值替换；读不到 = 保留字面量（原样文本）。

### 自定义函数

开发者可注册少量白名单函数供代码块调用（映射到安全实现）：

```python
import random
WHITELIST_FUNCS = {
    "roll": lambda dice_expr: int(random.randint(1, int(dice_expr.replace("d", "")))),  # 简化为 1dN
    "random": lambda lo, hi: random.randint(int(lo), int(hi)),
}
```

示例：
```
${
if roll("1d6") >= 3:
    return "{{room2}}"
else:
    return "{{room1}}"
}
```

## 实现要点（给落地时的参考）

### 1. 多行块匹配需要在 `_VARIABLE_RE` 之前独立处理

现有 `_VARIABLE_RE = r"\$\{(.+?)\}"`（placeholder.py:69）是**单行非贪婪**，跨到第一个 `}` 就停。多行 `${...}` 块会被它的 `.` 吃到第一个 `}`，产生错误片段。因此：

- 在 `resolve_variables`（placeholder.py:88）里、`_VARIABLE_RE.sub` **之前**，先跑一个 `_resolve_code_blocks(text, var_map, instance_dir)`：
  - 用**平衡大括号**扫描 `${` 到匹配的 `}`（支持嵌套 `{}`），而非正则。
  - 块 content 先 `.strip()`。
  - 判断触发器：`return `（后跟空格）出现在块内 → 代码块；否则 → 变量块。
- 变量块直接复用现有取值逻辑（读 `var_map`，无 → 字面量）。

### 2. AST 白名单求值器

```python
import ast

ALLOWED_NODES = {
    ast.Module, ast.Expr, ast.If, ast.IfExp, ast.Return,
    ast.Compare, ast.Eq, ast.NotEq, ast.Lt, ast.LtE, ast.Gt, ast.GtE,
    ast.BoolOp, ast.And, ast.Or, ast.UnaryOp, ast.Not,
    ast.BinOp, ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Mod,
    ast.Constant, ast.Name, ast.Load, ast.Str, ast.Num, ast.List, ast.Tuple,
}
# 遍历 ast.parse 结果，遇到不在白名单的节点 → 抛错，块结果回退为字面量。
# 不允许：Assign/Name(Store)、Call（除白名单函数）、Import、Attribute、Exec 等。
```

- 求值上下文：把 `var_map`（沙盒变量扁平 map）注入为顶层 Name。
- 白名单函数通过 `WHITELIST_FUNCS` 表放行，其余 `Call` 一律拒绝。
- 遍历通过后，用自定义 `_interp` 解释 AST（NodeVisitor 或递归），对 `If` 看分支条件的求值走白名单，命中的 `Return` 分支返回其 Constant 值；无 return 命中 → 回退字面量或空。

### 3. 变量名禁空白校验

- 变量写入入口增加校验：`SetRuntimeVar`（tools.py ~262 的 `_write_sandbox_vars` 前）、沙盒 `setVar`（routes/workspaces.py `set_runtime_vars`）写变量时，`name` 含空白（空格/tab/换行）→ 拒绝或告警。
- 理由：代码块用 `if dice_result == ...` 引用变量，需作为合法 Python 标识符；带空格的变量名无法被 AST `Name` 引用。

### 4. Generate dry-run（`dump_payload_path` 语义变更）

在 `execute_generate`（tools.py:533）Step 3（tools.py:591-600）改造：

- 现有逻辑：resolved 后若填 `dump_payload_path` 则写 JSON **然后继续**调用模型。
- 改为：若填 `dump_payload_path`，写完 JSON 后 **`return`（不调用正文模型）**，返回如 `"Dry-run: payload 已写出到 <path>，未调用正文模型"`。
- 对齐 README/CLAUDE.md 里 `dump_payload_path` 的描述。

## 关键约束

- **不 exec 原始代码**：只 `ast.parse` + 白名单 `_interp`，禁止 import / eval / exec / 属性访问 / 任意函数调用（除白名单）。
- **解析失败不报错**：坏块回退为字面量（保留原文），与现有变量"缺失→原样显示"一致，不炸 generate。
- **深度互递归**：代码块的返回值复用现有 `resolve_variables` 交替解析，不新开深度计数。

## 影响文件（落地时的改动清单）

- `src/teahouse/placeholder.py` — `resolve_variables` 新增 `_resolve_code_blocks`；新增 AST 求值器；注变量 regex。
- `src/teahouse/tools.py` — `execute_generate` 的 dry-run 改造；变量命名禁空白校验。
- `src/teahouse/routes/workspaces.py` — `set_runtime_vars` 变量名禁空白校验。
- `CLAUDE.md` — 占位符语法表补条件切片一行。

## 验证（落地时）

1. `for` 循环跑一个 yaml：`${ if dice == 6: return "{{a}}" else: return "{{b}}" }`，`dice=6` → 得到 a 文件内容；`dice=3` → b。
2. 白名单：块内写 `import os; os.system("whoami")` → 求值失败回退字面量，不执行、不崩。
3. 多行块：含缩进、空行、嵌套 `{}` 的块正确捕获。
4. dry-run：填 `dump_payload_path`，模型不被调用，payload 正确写出。
5. 回归：现有 `{{glob:...:last2}}`、`{{file:line}}`、`${name}` 行为不变。
