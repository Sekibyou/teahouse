"""
Placeholder/slice resolver — `{{path}}` file slices and `${name}` variables.

`{{path}}` file slices: pure "copy/move" primitive — inlines file content verbatim,
materializing no semantic change. Used by Write/Edit/WriteLine (resolve_placeholders).

`${name}` variables: reference a value from a var_map (sandbox vars + system-internal
`teahouse.*`). Strict: must be `$` immediately followed by `{...}`; a bare `$` is left
alone. If the name is NOT in var_map, the literal `${name}` is kept unchanged (原样显示).
`teahouse.xxx` values exist only during director system-prompt assembly; elsewhere they
are ordinary missing variables and render literally (naturally 不泄露内部提示词).

All `${}` placeholders route through a single registered framework (see the
`${@...}` section): `${@var name}` / `${@type name}` / `${@python return ...}` /
`${@condition ...}` / `${@note ...}` / `${@max|@min|@len|@random}`. Bare `$ {...}`
forms (plain `${name}` variables, and `${ if ...: return ... }` code blocks) are
auto-degraded by a heuristic. Use `${@note name}` and `${@type name}` for comments
and type introspection respectively.

Two surfaces only AI consumes auto-resolve BOTH `${}` and `{{}}`:
  - Generate yaml (sent to the writer LLM)
  - Director system prompt / preset template assembly (no-cache variable snapshot)
The sandbox/render surface does NOT auto-resolve — it calls the inject function to
replace remaining `${name}` literals manually.

File-slice syntax {{path}}:
  {{path}}                               Full file
  {{path:10-30}}                         Line range (1-indexed, inclusive)
  {{path:10-20|from="A"|to="B"}}         Line range then anchor crop
  {{path|from="A"|to="B"}}               Anchor-based range
  {{path|from="A"}}                      From anchor to end
  {{path|to="B"}}                        From start to anchor
  {{path|between="A"|and="B"}}           In-line substring crop (INCLUDES both anchors)
  {{path|between="A"}}                   In-line: from A start to end of text
  {{path|and="B"}}                       In-line: from start of text to B end
  {{glob:pattern}}                       Glob-matched files, sorted
  {{glob:pattern:lastN}}                 Glob-matched files, keep the last N by numeric segment (descending)

Note: use | as the anchor separator, : for the line range. Line-level anchors
(from/to) select whole lines; the string-level anchors (between/and) crop a
substring between two unique markers ON one line (or across lines), INCLUDING
the anchors themselves (an anchor is a unique identifier worth keeping; drop it
with an Edit if unwanted). between/and anchors must occur exactly once.
"""
from __future__ import annotations

import ast
import io
import random
import re
import token
import tokenize
from pathlib import Path
from typing import Optional


class PlaceholderError(Exception):
    """Raised when a placeholder cannot be resolved."""


# A resolved value may itself contain ${...} or {{...}} (e.g. a variable whose value is
# another variable reference). Guard against runaway/cyclic expansion.
MAX_RESOLVE_DEPTH = 10


def resolve_placeholders(text: str, instance_dir: Path, strict: bool = False) -> str:
    """Replace all {{...}} placeholders in text with actual file contents.

    strict=False (default): a placeholder that cannot resolve (bad path, missing
    file, invalid glob/lastN) is left **verbatim** — important because prompt doc
    text often contains `{{glob:...:lastN}}` style **examples** that must not blow
    up assembly. Active, well-formed slices still expand.
    strict=True: raises PlaceholderError on failure (used by Write/Edit/WriteLine
    where the director explicitly opted in and should see the error).
    """
    text, literals = _hide_escaped_placeholders(text)

    def _replacer(match: re.Match) -> str:
        raw = match.group(1).strip()
        try:
            return _resolve_one(raw, instance_dir)
        except PlaceholderError:
            if strict:
                raise
            return match.group(0)  # keep literal

    text = re.sub(r"\{\{(.+?)\}\}", _replacer, text)
    return _restore_escaped_placeholders(text, literals)


# ---------------------------------------------------------------------------
# 转义语法 — 前缀反斜杠保护占位符不被展开
#
#   \{{path}}  /  \{{glob:...:lastN}}   →  字面量  {{path}}（文件切片不展开）
#   \${name}                              →  字面量  ${name}（变量不展开）
#   \$ { if ...: return ... }             →  字面量  ${ if ...: }（条件块不执行）
#   \\                                    →  字面量  \
#
# 实现：解析全程用哨兵令牌顶替被转义的占位符，使之对 ${} / {{}} 两个解析器都
# 不可见（尤其避开 resolve_variables 的多轮交替展开与 max_depth 递归），等解析
# 全部结束后的"最后阶段"才一次性把哨兵还原为去掉反斜杠的字面量。
# ---------------------------------------------------------------------------

# 哨兵令牌。\x01 是几乎不可能出现在正文里的控制符，且两边各有一个，避免与
# 任何真实段落撞车；哨兵内部编号保证唯一。
_ESC_SENTINEL_START = "\x01\x05ESC"
_ESC_SENTINEL_END = "\x01\x05"
_ESC_SENTINEL_RE = re.compile(
    re.escape(_ESC_SENTINEL_START) + r"(\d+)" + re.escape(_ESC_SENTINEL_END)
)


def _hide_escaped_placeholders(text: str) -> tuple[str, list[str]]:
    """把被反斜杠转义的占位符替换为哨兵，返回 (hidden, literals)。

    literals[i] 是第 i 个被转义占位符的**字面量**（去掉前导反斜杠的原样文本）。
    hidden 文本里第 i 个哨兵还原时取 literals[i]。

    用 balanced 扫描（同 _match_brace_group）匹配开括号，所以：
      - \${...}（单行变量）与其内部的 } 正确配对
      - \$ {...}（多行条件块）内部的 } 按嵌套深度配对，不会被截断
      - \{{...}} 单层切片正确配对
    未闭合/异常的前导反斜杠原样保留（不吞掉 \）。
    """
    literals: list[str] = []
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        if text[i] == "\\" and i + 1 < n and text[i + 1] in ("{", "$"):
            second = text[i + 1]
            # 定位开括号位置：
            #   \{{...}}  → 直接从第一个 { 起 balanced
            #   \${...}   → $ 后紧跟 { ，从该 { 起 balanced
            #   \$ {...}  → $ 后允许空白（多行条件块写法），越过空白找 { 再 balanced
            k = i + 1  # 指向 $ 或 {（反斜杠后的第二字符）
            if second == "$":
                k += 1  # 指向 { ，或空白
                while k < n and text[k] in " \t\r\n":
                    k += 1
            # 此时若 text[k] == "{"，即找到开括号；否则不是占位符
            if k < n and text[k] == "{":
                depth = 0
                j = k
                closed = False
                while j < n:
                    if text[j] == "{":
                        depth += 1
                    elif text[j] == "}":
                        depth -= 1
                        if depth == 0:
                            closed = True
                            break
                    j += 1
                if closed:
                    # 被转义片段：去掉前导反斜杠后作为字面量
                    literal = text[i + 1 : j + 1]  # i+1 跳过反斜杠
                    token = f"{_ESC_SENTINEL_START}{len(literals)}{_ESC_SENTINEL_END}"
                    literals.append(literal)
                    out.append(token)
                    i = j + 1
                    continue
            # 无闭合大括号 — 反斜杠原样保留，继续下一个字符
            out.append(text[i])
            i += 1
        else:
            out.append(text[i])
            i += 1
    return "".join(out), literals


def _restore_escaped_placeholders(text: str, literals: list[str]) -> str:
    """把哨兵还原为字面量。仅在全部解析完成后调用（转义的最后阶段）。"""
    def _replacer(match: re.Match) -> str:
        idx = int(match.group(1))
        if 0 <= idx < len(literals):
            return literals[idx]
        return match.group(0)
    return _ESC_SENTINEL_RE.sub(_replacer, text)


def _substitute_variable_literals(text: str, var_map: dict) -> str:
    """Single-pass `${name}` / `${@name ...}` substitution for sandbox surfaces.

    This is the regex-free, registered-framework path: scan the text, match every
    top-level `${...}` (brace-balanced, survives nested `{{}}` / f-string braces),
    judge its syntax (§3.2) and dispatch to a PLACEHOLDER_HANDLERS entry (§3.3).
    Missing/unknown placeholders render literally — never raise.
    """
    return _resolve_one_round_braces(text, var_map, type_map=None)


# =====================================================================
# 条件切片（代码块）— 白名单 AST 解释器
# =====================================================================
#
# A `${ ... }` block routed to python (either `${@python ...}`/`${@condition ...}`
# explicitly, or a bare `${ if ...: return ... }` auto-degraded by the judgment
# layer) is parsed by this whitelist AST interpreter. The single matched
# `return <value>` branch is materialized and returned for the outer resolve loop
# to continue expanding (it may itself contain `{{...}}` or `${...}`).
#
# All failures (syntax error, non-whitelisted node, unknown name) degrade to the
# literal block text — never raise, so a bad block can't blow up assembly.

# Whitelist functions callable from inside a code block. Mapped to safe impls
# so arbitrary calls are never executed.

# --- Simple dice roller (RPG-style syntax), adapted from the reference. ---
# Supported: "1d6", "2d10+5", "4d6k3" (keep highest 3), "4d6d1" (drop lowest 1),
# "1d6r1" (reroll 1s), "1d6ro1" (reroll once), "1d6e" / "1d6!" (exploding),
# "1d6p" (penetrating). Returns an int total. Runs only inside the code-block
# whitelist via WHITELIST_FUNCS["roll"], still getting a plain string constant.
_ROLL_PATTERN = re.compile(
    r"^(\d+)?d(\d+)((?:[kdlrop!e]+\d*)*)?([+-]\d+)?$", re.IGNORECASE
)
_ROLL_KEEP = re.compile(r"k(\d+)", re.IGNORECASE)
_ROLL_DROP = re.compile(r"dl(\d+)", re.IGNORECASE)
_ROLL_REROLL = re.compile(r"r(\d+)", re.IGNORECASE)
_ROLL_REROLL_ONCE = re.compile(r"ro(\d+)", re.IGNORECASE)
_ROLL_EXPLODE = re.compile(r"[e!]", re.IGNORECASE)
_ROLL_PENETRATE = re.compile(r"p(?!\d)", re.IGNORECASE)


def _apply_explode(values: list[int], kept: list[bool], sides: int, explode: bool) -> None:
    """Append extra rolls for max-face dice, in place on values/kept.
    explode=True → exploding (extra added as-is); explode=False → penetrating
    (extra -1, min 1). A hard cap prevents runaway on degenerate dice (sides==1)."""
    cap = 100
    extra_added = 0
    i = 0
    while i < len(values) and extra_added < cap:
        if values[i] == sides:
            extra = random.randint(1, sides)
            if not explode:
                extra = max(1, extra - 1)
            values.append(extra)
            kept.append(True)
            extra_added += 1
        i += 1


def _roll(expression) -> int:
    """Roll `expression` (e.g. "2d6+1", "4d6k3") and return the int total.

    Supported grammar is a subset of the reference dice roller: XdN with optional
    keep (kN), drop-lowest (dlN), reroll (rN), reroll-once (roN), exploding (e/!),
    penetrating (p), and a trailing +/- modifier. Unknown syntax raises ValueError
    which the code-block evaluator catches → falls back to the literal block.
    """
    expr = str(expression).strip().lower()
    m = _ROLL_PATTERN.match(expr)
    if not m:
        raise ValueError(f"invalid dice expression: {expr}")
    count = int(m.group(1)) if m.group(1) else 1
    sides = int(m.group(2))
    mods = m.group(3) or ""
    bonus = int(m.group(4)) if m.group(4) else 0
    if count <= 0 or sides <= 0:
        raise ValueError(f"invalid dice expression: {expr}")

    values = [random.randint(1, sides) for _ in range(count)]
    kept = [True] * count

    reroll_once_threshold = None
    km = _ROLL_REROLL_ONCE.search(mods)
    if km:
        reroll_once_threshold = int(km.group(1))
    elif (rm := _ROLL_REROLL.search(mods)):
        threshold = int(rm.group(1))
        for i, v in enumerate(values):
            while v <= threshold:
                v = random.randint(1, sides)
            values[i] = v

    if reroll_once_threshold is not None:
        for i, v in enumerate(values):
            if v <= reroll_once_threshold:
                values[i] = random.randint(1, sides)

    explode = _ROLL_EXPLODE.search(mods) is not None
    penetrate = _ROLL_PENETRATE.search(mods) is not None
    if explode or penetrate:
        _apply_explode(values, kept, sides, explode)

    if (km := _ROLL_KEEP.search(mods)):
        keep_n = int(km.group(1))
        drop_these = count - keep_n
        if drop_these > 0:
            lowest = sorted(range(len(values)), key=lambda i: values[i])[: min(drop_these, len(values))]
            for i in lowest:
                kept[i] = False
    if (dm := _ROLL_DROP.search(mods)):
        drop_n = int(dm.group(1))
        if drop_n > 0:
            lowest = sorted(range(len(values)), key=lambda i: values[i])[: min(drop_n, len(values))]
            for i in lowest:
                kept[i] = False

    total = sum(v for v, ok in zip(values, kept) if ok) + bonus
    return int(total)


WHITELIST_FUNCS = {
    "roll": _roll,
    "random": lambda lo, hi: random.randint(int(lo), int(hi)),
    "str": str,
}


# AST node types a code block may use. Anything else (Import, Attribute, Exec,
# global/del, non-simple assignment targets, non-whitelisted Call, ...) is
# rejected and the block falls back literal.
_ALLOWED_NODES = {
    ast.Module, ast.Expr, ast.If, ast.IfExp, ast.Return, ast.Assign,
    ast.Compare, ast.Eq, ast.NotEq, ast.Lt, ast.LtE, ast.Gt, ast.GtE,
    ast.BoolOp, ast.And, ast.Or, ast.UnaryOp, ast.Not, ast.USub, ast.UAdd,
    ast.BinOp, ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Mod,
    ast.Constant, ast.Name, ast.Load, ast.Store, ast.List, ast.Tuple,
    ast.Call, ast.keyword, ast.NameConstant,
    ast.JoinedStr, ast.FormattedValue,
}

# Sentinel: the block text ran to completion without hitting a return branch.
_NO_RETURN = object()


class _BlockEvalError(Exception):
    """Raised when a code block cannot be safely evaluated. Degrades to literal."""


def _truthy(v) -> bool:
    return bool(v)


def _check_whitelist(tree: ast.AST) -> None:
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            if not (
                isinstance(node.func, ast.Name)
                and node.func.id in WHITELIST_FUNCS
            ):
                raise _BlockEvalError(f"call to non-whitelisted function: {ast.dump(node.func)}")
        elif type(node) not in _ALLOWED_NODES:
            raise _BlockEvalError(f"node type not allowed: {type(node).__name__}")
    # Name used in a non-Load context must be the target of a simple `x = value`
    # assignment. Attribute/subscript/unpack/global/del/aug-assign targets are all
    # already rejected by the node-type whitelist above (ast.Attribute, ast.Subscript,
    # ast.Tuple-store, ast.Global, ast.Delete, ast.AugAssign are not in _ALLOWED_NODES).
    # Here we only relax Store so that `_exec_block` can bind a local var.
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and not isinstance(node.ctx, (ast.Load, ast.Store)):
            raise _BlockEvalError("name used in unsupported context")


def _eval_expr(node: ast.AST, env: dict):
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Name):
        if node.id in env:
            return env[node.id]
        raise _BlockEvalError(f"unknown variable referenced in code block: '{node.id}'")
    if isinstance(node, ast.Call):
        if isinstance(node.func, ast.Name) and node.func.id in WHITELIST_FUNCS:
            args = [_eval_expr(a, env) for a in node.args]
            return WHITELIST_FUNCS[node.func.id](*args)
        raise _BlockEvalError("non-whitelisted call")
    if isinstance(node, ast.BinOp):
        left = _eval_expr(node.left, env)
        right = _eval_expr(node.right, env)
        binop = type(node.op)
        if binop is ast.Add:
            return left + right
        if binop is ast.Sub:
            return left - right
        if binop is ast.Mult:
            return left * right
        if binop is ast.Div:
            return left / right
        if binop is ast.Mod:
            return left % right
        raise _BlockEvalError(f"unsupported binary op: {binop.__name__}")
    if isinstance(node, ast.Compare):
        left = _eval_expr(node.left, env)
        for op, comparator in zip(node.ops, node.comparators):
            right = _eval_expr(comparator, env)
            cmpop = type(op)
            if cmpop is ast.Eq:
                ok = left == right
            elif cmpop is ast.NotEq:
                ok = left != right
            elif cmpop is ast.Lt:
                ok = left < right
            elif cmpop is ast.LtE:
                ok = left <= right
            elif cmpop is ast.Gt:
                ok = left > right
            elif cmpop is ast.GtE:
                ok = left >= right
            else:
                raise _BlockEvalError(f"unsupported comparison op: {cmpop.__name__}")
            if not ok:
                return False
            left = right
        return True
    if isinstance(node, ast.BoolOp):
        if isinstance(node.op, ast.And):
            return all(_truthy(_eval_expr(v, env)) for v in node.values)
        # ast.Or
        return any(_truthy(_eval_expr(v, env)) for v in node.values)
    if isinstance(node, ast.UnaryOp):
        val = _eval_expr(node.operand, env)
        if isinstance(node.op, ast.Not):
            return not _truthy(val)
        if isinstance(node.op, ast.USub):
            return -val
        if isinstance(node.op, ast.UAdd):
            return val
        raise _BlockEvalError(f"unsupported unary op: {type(node.op).__name__}")
    if isinstance(node, ast.IfExp):
        if _truthy(_eval_expr(node.test, env)):
            return _eval_expr(node.body, env)
        return _eval_expr(node.orelse, env)
    if isinstance(node, ast.List):
        return [_eval_expr(e, env) for e in node.elts]
    if isinstance(node, ast.Tuple):
        return tuple(_eval_expr(e, env) for e in node.elts)
    if isinstance(node, ast.JoinedStr):
        return "".join(_eval_expr(v, env) for v in node.values)
    if isinstance(node, ast.FormattedValue):
        value = _eval_expr(node.value, env)
        conversion = node.conversion
        if conversion == 114:      # !r
            text = repr(value)
        elif conversion == 115:    # !s
            text = str(value)
        elif conversion == 97:     # !a
            text = ascii(value)
        else:
            text = str(value)
        if node.format_spec is not None:
            spec = _eval_expr(node.format_spec, env)
            text = format_text(value, spec, text)
        return text
    raise _BlockEvalError(f"unsupported expression node: {type(node).__name__}")


def format_text(value, spec: str, fallback: str) -> str:
    """Apply a Python format spec (e.g. '03d', '>5') to `value`. Falls back to
    `fallback` if the spec isn't applicable to the value's type (non-fatal)."""
    try:
        return format(value, spec)
    except (TypeError, ValueError):
        return fallback


def _exec_block(stmts: list[ast.stmt], env: dict):
    """Execute a code block's statements. Returns (value, has_return in this branch).
    Unmatched branches fall through to sibling statements; overall no return → _NO_RETURN."""
    for stmt in stmts:
        if isinstance(stmt, ast.Return):
            return _eval_expr(stmt.value, env)
        if isinstance(stmt, ast.If):
            branch = stmt.body if _truthy(_eval_expr(stmt.test, env)) else stmt.orelse
            v = _exec_block(branch, env)
            if v is not _NO_RETURN:
                return v
            continue
        if isinstance(stmt, ast.Expr):
            # Evaluate for allowed side-effect-free expressions (e.g. nothing meaningful)
            _eval_expr(stmt.value, env)
            continue
        if isinstance(stmt, ast.Assign):
            if len(stmt.targets) != 1 or not isinstance(stmt.targets[0], ast.Name):
                raise _BlockEvalError("assignment must target a single simple name")
            env[stmt.targets[0].id] = _eval_expr(stmt.value, env)
            continue
        raise _BlockEvalError(f"unsupported statement node: {type(stmt).__name__}")
    return _NO_RETURN


_SINGLE_LINE_BRANCH_KEYWORDS = {"elif", "else"}


def _rebuild_single_line_if(code: str) -> str:
    """Rewrite a single-line `if C: return A elif C2: return B else: return D`
    chain (invalid as inline Python) into an equivalent valid multi-line block.

    Token-driven so `:` / keywords inside the quoted return values are never split.
    The DSL restricts suites to `return <expr>`, so every top-level `:` is a header
    terminator and every top-level elif/else begins a new branch line.
    """
    toks = [
        t for t in tokenize.generate_tokens(io.StringIO(code).readline)
        if t.type not in (tokenize.NEWLINE, tokenize.ENDMARKER,
                          tokenize.INDENT, tokenize.DEDENT, tokenize.NL)
    ]
    parts: list[str] = []
    for t in toks:
        s = t.string
        if t.type == token.OP and s == ":":
            parts.append(" :")
            parts.append("\n    ")
        elif t.type == token.NAME and s in _SINGLE_LINE_BRANCH_KEYWORDS:
            parts.append("\n")
            parts.append(s)
        elif s == "return":
            parts.append("return")
        else:
            parts.append(" " + s)
    return "".join(parts).lstrip("\n ")


def _parse_code_block(code: str) -> ast.Module:
    """Parse a code block, falling back to a single-line if/elif/else rebuild
    when the raw text is inline Python (which does not compile as-is)."""
    try:
        return ast.parse(code, mode="exec")
    except SyntaxError:
        if "\n" not in code.strip():
            return ast.parse(_rebuild_single_line_if(code), mode="exec")
        raise


def _eval_code_block_value(code: str, var_map: dict):
    """Evaluate `code`, returning `(ok, value_or_None)`.

    Distinguishes the two degraded outcomes so callers can decide fallback:
      - Syntax / whitelist / eval exception (bad block) → **raises**.
      - Executed cleanly but no `return` reached (e.g. a false `if` condition) →
        `(False, None)`.
      - A `return` was materialized → `(True, <stringified value>)`.
    """
    tree = _parse_code_block(code)
    _check_whitelist(tree)
    env = dict(var_map) if isinstance(var_map, dict) else {}
    value = _exec_block(tree.body, env)
    if value is _NO_RETURN:
        return False, None
    return True, _stringify(value)


def _eval_code_block(code: str, var_map: dict, fail_literal: str | None = None) -> str:
    """Evaluate a code block's content to the materialized return value. Always
    returns a string — on any failure, `fail_literal` (or the original block text
    `${code}`) is returned.

    `fail_literal` lets callers that rewrite the code (e.g. `@condition` wrapping it
    in `if/return`) fall back to their own user-visible literal instead of the mangled
    rewritten code.
    """
    literal = fail_literal if fail_literal is not None else "${" + code + "}"
    try:
        ok, val = _eval_code_block_value(code, var_map)
    except (_BlockEvalError, SyntaxError, TypeError, ValueError, ZeroDivisionError):
        return literal
    if not ok:
        return literal
    return val


# =====================================================================
# `${@...}` — 注册式占位符统一框架（§3.1 搜索状态机 + §3.2 判定层 + §3.3 处理器）
# =====================================================================
#
# 每一次解析只处理**最表层**的占位符：从首个 `${`（进入 S 搜索）或 `{{`
# （进入 P 搜索）开始，用花括号配对外层匹配到同级闭合，判其语法，产出字符串；
# 产物流入下一轮输入（resolve_variables 的多轮循环消化），循环直到稳定。
#
#   `${name}`             裸写普通变量（无空白/无冒号）
#   `${@var name}`        显式变量
#   `${@type name}`       取变量类型
#   `${@max [..]}` / `${@min [..]}` / `${@len ...}`   从列表/变量取 max/min/len
#   `${@random [a,b,c]}`  随机取列表一项（字面量或数组变量）
#   `${@python return ...}`  白名单 python 代码块（须含 return）
#   `${@condition 条件: 输出 else 假输出}`  最简条件切片（if/else 均可选，宽松）：
#                                封装成 `if 条件: return 输出 else: return 假输出`；
#                                真→输出，假+else→假输出，假无else→空，坏块→原样
#                                （else 是识别符、后不带冒号；[] 仅为可选标记，勿写入）
#   `${@note ...}`        注释，恒剥为空（不做内部展开）
#   `${ if ...: return ... }`   裸写带 return → 自动降级为 python（兼容旧写法）
#   `${条件: 输出 else 假}` / `${a:b}`  裸写含最外层冒号（含/不含 else）→ 自动判为 condition
#   `${a:b:c}` (≥2 最外层冒号，无 else)    原样保留，不解析
#
# 兜底原则：绝大多数失败（变量不存在、未注册指令、坏块、语法错）统一"回退原样字面量"，
# 绝不报错（It should degrade to literal）。唯一例外是 `@condition` 的**假条件**（语义
# 不中）→ 返回空字符串，使"分支不命中=不注入内容"成立；坏块仍保留原样便于排查。


def _match_brace_group(text: str, start: int) -> tuple[str, int] | None:
    """From a `${` at `start` (start points at `$`), find the matching `}`.

    Counts **single** `{` / `}` (so `{{foo}}` file-slices and f-string braces
    inside a block balance instead of truncating at the first `}`). Returns
    (inner_without_outer_braces, index_after_closing_`}`), or None if unbalanced.
    """
    n = len(text)
    depth = 0
    k = start  # start points at '$'
    while k < n:
        c = text[k]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return text[start + 2:k], k + 1
        k += 1
    return None


def _match_double_brace(text: str, start: int) -> tuple[str, int] | None:
    """From a `{{` at `start`, find the matching `}}`.

    Counts `{` individually like _match_brace_group but only closes when `}}`
    appears (internal single braces don't close a slice). Returns
    (path, index_after_closing_`}}`), or None if unbalanced.
    """
    n = len(text)
    depth = 0
    k = start
    while k < n:
        c = text[k]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return text[start + 2:k], k + 1
        k += 1
    return None


def _scan_top_level(text: str):
    """Scan `text` left→right, yielding every top-level `${...}` group.

    First-opener-wins: whichever of `${`/`{{` appears earlier is consumed by its
    own matcher; content inside an outer group is skipped, so a `{{}}` inside a
    `${...}` never triggers the slice matcher (and vice versa). Yields
    (inner, start_index, end_index_after_close).
    """
    n = len(text)
    i = 0
    while i < n:
        c = text[i]
        if c == "$" and i + 1 < n and text[i + 1] == "{":
            res = _match_brace_group(text, i)
            if res is None:
                i += 1
                continue
            inner, end = res
            yield "var", inner, i, end
            i = end
        elif c == "{" and i + 1 < n and text[i + 1] == "{":
            res = _match_double_brace(text, i)
            if res is None:
                i += 1
                continue
            inner, end = res
            yield "slice", inner, i, end
            i = end
        else:
            i += 1


def _resolve_python(value: str, var_map: dict, type_map: dict | None) -> str:
    """Route a python/condition body through the whitelist code-block interpreter."""
    return _eval_code_block(value, var_map)


def _resolve_type(value: str, var_map: dict, type_map: dict | None) -> str:
    """`@type` — return the variable's declared/inferred type string."""
    name = value.strip()
    if type_map and name in type_map:
        return str(type_map[name])
    return None  # 未知 → 回退原样


def _resolve_note(_value: str, _var_map: dict, _type_map: dict | None) -> str:
    """`@note` comments strip to empty, no internal expansion."""
    return ""


def _resolve_random(value: str, var_map: dict, type_map: dict | None) -> str:
    """`@random` — pick one item from a list literal or an array variable."""
    v = _try_resolve_value(value, var_map)
    if isinstance(v, list) and v:
        return _stringify(random.choice(v))
    return None


def _resolve_len(value: str, var_map: dict, type_map: dict | None) -> str:
    v = _try_resolve_value(value, var_map)
    if v is not None:
        try:
            return _stringify(len(v))
        except TypeError:
            pass
    return None


def _resolve_maxmin(value: str, var_map: dict, fn) -> str:
    v = _try_resolve_value(value, var_map)
    if v is not None:
        try:
            unfolded = v
            if isinstance(unfolded, (list, tuple)) and len(unfolded) == 1 and isinstance(unfolded[0], (list, tuple)):
                unfolded = unfolded[0]
            return _stringify(fn(unfolded))
        except (TypeError, ValueError):
            pass
    return None


def _try_resolve_value(value: str, var_map: dict):
    """Resolve a handler argument: a variable name, else a python literal value."""
    name = value.strip()
    if name in var_map:
        return var_map[name]
    try:
        return ast.literal_eval(name)
    except (ValueError, SyntaxError):
        return None


def _quote_if_bare_slice(out: str) -> str:
    """Wrap a bare `{{...}}` output in double quotes so the resulting code is valid.

    From `${a >= 10: {{file:10-30}}}` the output is `{{file:10-30}}` — a bare slice
    (no surrounding quotes) is not a valid Python expression, so `return {{file:10-30}}`
    would be a syntax error. Quoting it turns the slice into a string constant the
    resolve loop expands next round. A slice already inside quotes is left untouched.
    """
    s = out.strip()
    if s.startswith("{{") and s.endswith("}}"):
        return '"' + s + '"'
    return out


def _find_outer_keyword(text: str, kw: str) -> int:
    """Return the index of keyword `kw` at brace/quote depth 0 (word-boundary), or -1.

    Colons/quotes/braces don't contain a real `else`; only a standalone `else`
    surrounded by whitespace (or line edges) counts, so a `else` inside a quoted
    output string or a `{{slice}}` is ignored.
    """
    in_quote = False
    brace_depth = 0
    n = len(text)
    i = 0
    while i < n:
        c = text[i]
        if c == '"':
            in_quote = not in_quote
            i += 1
            continue
        if c == "{":
            brace_depth += 1
            i += 1
            continue
        if c == "}":
            brace_depth = max(0, brace_depth - 1)
            i += 1
            continue
        if not in_quote and brace_depth == 0 and (c.isalnum() or c == "_"):
            if text.startswith(kw, i):
                before = text[i - 1] if i > 0 else " "
                after = text[i + len(kw)] if i + len(kw) < n else " "
                if (not before.isalnum() and before != "_") and (not after.isalnum() and after != "_"):
                    return i
            while i < n and (text[i].isalnum() or text[i] == "_"):
                i += 1
            continue
        i += 1
    return -1


def _split_condition(text: str) -> tuple[str, str, str | None] | None:
    """Parse a condition body `if 条件: 真输出 else 假输出`.

    Rules (宽松、小白友好)：
      - 可选前导 `if `。
      - `条件: 真输出` 以第一个**最外层**冒号切分（引号/花括号内冒号不计）。
      - 可选 `else 假输出`：`else` 是特殊符号（最外层单词边界），**其后不允许冒号**
        （假输出直接跟内容）。无 `else` → 假分支为 None。
      - 返回 (condition, true_output, false_output_or_None)；格式非法返回 None。
    """
    s = text.strip()
    # 可选前导 if
    if s.lower().startswith("if ") or s == "if":
        s = s[2:].strip() if len(s) > 2 else ""
    # 找最外层 else（若无 → 单分支）
    epos = _find_outer_keyword(s, "else")
    head = s
    false_out = None
    if epos != -1:
        head = s[:epos].strip()
        false_out = s[epos + 4:].strip()
    # 真分支：第一个最外层冒号切分 条件 / 真输出
    cpos = _first_outer_colon(head)
    if cpos == -1:
        return None
    cond = head[:cpos].strip()
    true_out = head[cpos + 1:].strip()
    if not cond or not true_out:
        return None
    return cond, true_out, (false_out if false_out else None)


def _first_outer_colon(text: str) -> int:
    """Index of the first colon at brace/quote depth 0 (or -1 if none)."""
    in_quote = False
    brace_depth = 0
    for i, ch in enumerate(text):
        if ch == '"':
            in_quote = not in_quote
        elif ch == "{":
            brace_depth += 1
        elif ch == "}":
            brace_depth = max(0, brace_depth - 1)
        elif not in_quote and brace_depth == 0 and ch == ":":
            return i
    return -1


def _count_outer_colons(text: str) -> int:
    """Count colons at brace/quote depth 0 (colons inside `"..."` or `{{...}}` don't count).

    Used by the judgment layer to decide "bare contains a condition-colon → condition".
    Because `else` takes no trailing colon, `条件: 真 else 假` has exactly one outer colon
    and is correctly routed; a bare `a:b:c` (two outer colons, no else) stays literal.
    """
    in_quote = False
    brace_depth = 0
    count = 0
    for ch in text:
        if ch == '"':
            in_quote = not in_quote
        elif ch == "{":
            brace_depth += 1
        elif ch == "}":
            brace_depth = max(0, brace_depth - 1)
        elif not in_quote and brace_depth == 0 and ch == ":":
            count += 1
    return count


def _resolve_condition(value: str, var_map: dict, type_map: dict | None, original: str | None = None) -> str:
    """`@condition` — 最简条件切片（统一裸写与显式入口）。

    宽松写法 `${if 条件: 真输出 else 假输出}`（`if`/`else` 均可选，`else` 后
    不带冒号），引擎把**最外层冒号**切出条件/真输出、把 `else` 关键字切出假分支，
    封装为 `if 条件: return 真输出 else: return 假输出` 丢进白名单 python 解释器
    执行。单分支（无 else）或多分支（有 else）均可；不支持 elif/三元。
    切片/引号内的冒号与 `else` 不计。输出为裸 `{{...}}` 切片时自动套引号
    （`{{file:10-30}}` → `"{{file:10-30}}"`）。条件即 python 比较式；输出即 return
    值——引号字面量、裸变量名（按 env 查现值）、函数调用（`roll("1d10")`）皆由解释器
    天然处理。

    结果：命中 → 真输出；假且无 else → **空**；假且有 else → **假输出**；坏块
    （无冒号 / 语法错 / 变量不存在 / 越权）→ 回退**原样字面量**，便于排查。
    """
    literal = original if original is not None else "${@condition " + value + "}"
    parts = _split_condition(value)
    if parts is None:
        return literal  # 坏块：无有效冒号/空分支
    cond, true_out, false_out = parts
    q_true = _quote_if_bare_slice(true_out)
    if false_out is not None:
        code = f"if {cond}:\n    return {q_true}\nelse:\n    return {_quote_if_bare_slice(false_out)}"
    else:
        code = f"if {cond}:\n    return {q_true}"
    try:
        ok, val = _eval_code_block_value(code, var_map)
    except (_BlockEvalError, SyntaxError, TypeError, ValueError, ZeroDivisionError):
        return literal  # 坏块
    if not ok:
        return ""  # 假条件（无 else 分支时）→ 空（不注入内容）
    return val


# --- §3.3 类型注册表：@A → handler(C, var_map, type_map) -> str。返回 None 视为未命中→原样。 ---
PLACEHOLDER_HANDLERS: dict[str, object] = {
    "var": lambda c, vm, tm: _stringify(vm[c.strip()]) if c.strip() in vm else None,
    "type": _resolve_type,
    "python": _resolve_python,
    "condition": _resolve_condition,
    "note": _resolve_note,
    "random": _resolve_random,
    "len": _resolve_len,
    "max": lambda c, vm, tm: _resolve_maxmin(c, vm, max),
    "min": lambda c, vm, tm: _resolve_maxmin(c, vm, min),
}


def _judge_and_resolve(inner: str, var_map: dict, type_map: dict | None) -> str:
    """§3.2 判定层 + §3.3 处理器分发。对单个 `${...}` inner 返回替换串。

    失败统一回退原样字面量 `${inner}`（绝不抛错）。
    """
    stripped = inner.strip()
    literal = "${" + inner + "}"

    if stripped.startswith("@"):
        head, _, rest = stripped[1:].partition(" ")
        rest = rest.strip()
        handler = PLACEHOLDER_HANDLERS.get(head)
        if handler is None:
            return literal  # 未注册指令 → 原样
        try:
            if head == "condition":
                out = _resolve_condition(rest, var_map, type_map, original=literal)
            else:
                out = handler(rest, var_map, type_map)
        except Exception:
            return literal
        if out is None:
            return literal
        return out

    # -- 裸写启发式判定 --
    has_space = any(ch.isspace() for ch in stripped)
    if not has_space and _count_outer_colons(stripped) == 0:
        return _stringify(var_map[stripped]) if stripped in var_map else literal
    if "return " in stripped:
        return _resolve_python(stripped, var_map, type_map)
    if _count_outer_colons(stripped) == 1:
        # 裸写单冒号 → condition（if/return 封装），失败回退用户原始字面量
        return _resolve_condition(stripped, var_map, type_map, original=literal)
    # ≥2 最外层冒号，或带 @/空白却无 return —— 无法分类 → 原样
    return literal


# =====================================================================
# `${@mention <kw1>, <kw2>, ... : <output>}` — 关键词灯（就地逐轮求值）
# =====================================================================
#
# 用于「散碎且量大、按需才注入」的设定（传说道具、传闻、武器、配角）。冒号前是
# 逗号分隔的**多个正则**，一旦它所在的那一层完整文本里任一正则有命中，就输出
# 冒号后的内容（内容可含 `${}`/`{{}}`，交由后续轮正常展开）；未命中则原样透传
# 到下一层再试（更深层可能才展开出关键词）。与 `@condition`/`@random` 同类：
# 就地求值，不拖到最后一层统一清扫。
#
# 唯一的特殊点是：它要匹配「它所在的整篇 text」，而普通 handler 签名
# (inner, var_map, type_map) 拿不到。因此不进 PLACEHOLDER_HANDLERS 注册表，由
# `_resolve_one_round_braces` 循环体内特判，把当前 text 一并传入。
#
# 销毁：未命中的 `@mention` 从头透传、循环收敛后仍是字面量；由 resolve_variables
# 在收敛出口调用 `_drop_unmatched_mentions` 统一删除（不留脏文本喂给 AI）。被
# `\` 转义的 `\${@mention...}` 已被哨兵隐藏，天然跳过命中与销毁。


def _split_mention(text: str) -> tuple[list[str], str] | None:
    """解析 `${@mention 关键词区: 输出区}`，返回 (keywords, output)，坏块返回 None。

    按**最外层**冒号切分（引号/`{{...}}` 内的冒号不计，复用 `_first_outer_colon`），
    关键词段按 `,` 拆分并 strip；输出可为任意含 `{{}}`/`${}` 的值表达式（下一轮展开）。
    `text` 为含 `@mention` 前缀的 inner 全文，先剥掉该指令头再拆分。
    与 `_split_condition` 风格一致：宽松、坏块降级字面量，不外泄报错。
    """
    s = text.strip()
    if s.startswith("@mention"):
        s = s[len("@mention"):].strip()
    elif s.startswith("@"):
        s = s[1:].strip()
    cpos = _first_outer_colon(s)
    if cpos == -1:
        return None
    kw_part = s[:cpos].strip()
    out_part = s[cpos + 1:].strip()
    if not kw_part:
        return None
    kws = [k.strip() for k in kw_part.split(",")]
    kws = [k for k in kws if k]
    if not kws:
        return None
    return kws, out_part


def _resolve_mention(inner: str, mention_source: str, var_map: dict, self_literal: str | None = None) -> str | None:
    """对单个 `${@mention ...}` inner 就地求值。命中→输出表达式求值结果；全未命中→None。

    关键词是逗号分隔的多个正则：任一在 `mention_source` 上 `re.search` 命中即命中。
    `mention_source` 是「正文全文」——在 Generate 跨消息场景它是**上一轮所有 msg 拼接**的
    只读变量（prev_joined）；单文本场景回退为当前文本。
    **匹配源排除 mention 自身**：从 `mention_source` 中剔除本探针字面量 `${@mention ...}`
    （`self_literal` 传入）——否则关键词出现在 `${@mention 剑: ...}` 自己里会"自己匹配自己"
    的无条件命中，"提到才触发"失效。跨消息拼接下也能正确剔除（字面量替换，不依赖索引）。

    output 与 `@condition` 同为 **python 值表达式**（裸值语义）：`"字符串"`→剥引号得到
    字符串内容、变量名→变量值、`[1,2]`→数组、`roll(...)`→函数调用；`"{{xx.md}}"`
    求值后得到 `{{xx.md}}` 这串字符，交由后续 resolve 继续解析。
    坏正则降级为字面匹配（经 re.escape）；坏块/坏表达式 → None 走字面量透传。
    """
    parsed = _split_mention(inner)
    if parsed is None:
        return None
    kws, output = parsed
    # 排除自身字面量，避免关键词自匹配
    search_text = mention_source
    if self_literal and self_literal in search_text:
        search_text = search_text.replace(self_literal, "")
    try:
        hit = False
        for kw in kws:
            try:
                pattern = re.compile(kw)
            except re.error:
                pattern = re.compile(re.escape(kw))
            if pattern.search(search_text):
                hit = True
                break
    except Exception:
        return None
    if not hit:
        return None
    # 命中：output 作为 python 值表达式求值（同 @condition：包 return 再喂解释器）。
    # 裸 `{{slice}}` 输出不是合法 python（`return {{w.md}}` 语法错）→ 先套引号成 `"{{w.md}}"`
    # 再求值，得到 `{{w.md}}` 字符串、由后续 resolve 轮次展开（与 @condition 的 _quote_if_bare_slice 同源）。
    try:
        ok, val = _eval_code_block_value(f"return {_quote_if_bare_slice(output)}", var_map)
    except Exception:
        return None
    if not ok:
        return None
    return val


def _drop_unmatched_mentions(text: str) -> str:
    """删除整篇 text 里仍残留的、**良构但未命中**的 `${@mention ...}` 字面量。

    用在 resolve_variables 循环**收敛后**、哨兵还原之前：此刻普通占位符已全解，
    良构的未命中 `@mention` 从头透传、仍是字面量，应销毁以免脏文本喂给 AI；命中过的
    输出已展开、不再是 `${@mention` 字面量，不受影响。**坏块（无有效冒号/关键词，
    `_split_mention` 返回 None）保留原样**——与 `@condition` 坏块降级为字面量一致，
    不销毁，便于创作者排查。被 `\` 转义的 `\${@mention...}` 已被哨兵隐藏
    （以 `_ESC_SENTINEL_*` 形式存在于 text），不会以 `${@mention` 字面量出现，天然跳过。
    """
    if "@mention" not in text:
        return text
    pieces: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        if (
            text[i] == "$"
            and i + 1 < n and text[i + 1] == "{"
        ):
            j = i + 2
            while j < n and text[j].isspace():
                j += 1
            if text[j:j + len("@mention")] == "@mention":
                res = _match_brace_group(text, i)
                if res is not None:
                    inner, end = res
                    # 良构（能拆出关键词+输出）才视为待销毁的未命中；坏块保留
                    if _split_mention(inner) is not None:
                        i = end  # 丢弃整段
                        continue
        pieces.append(text[i])
        i += 1
    return "".join(pieces)


# 公开别名：供 Generate 跨消息路径（tools._resolve_messages_vars）在所有轮结束后统一销毁
# 未命中的 @mention 残留。
drop_unmatched_mentions = _drop_unmatched_mentions


def strip_placeholder_shells(text: str) -> str:
    """剥掉所有**最外层** `${...}` / `{{...}}` 占位符组字面量，保留其余正文。

    供 Generate 跨消息路径构建 @mention 的只读匹配源（prev_joined）前调用。目标：
    - 占位符外壳（指令名、切片文件名等）非正文，不应参与关键词命中判定；
    - 否则 `${@mention 黄泉...}`、`{{黄泉.md}}` 这类字面量会让触发词在**正文其实没提**时
      被文件名/指令文字误命中（如 `{{zzz.md}}` 含 "zzz"、内容却无 "zzz"，仍误触发 @mention zzz）。
    - 只剥最外层、不分析嵌套：`${@condition some: "{{xxx.md}}"}` 匹配外层 `${...}` 整组删除，
      内层 `{{xxx.md}}` 随外层一并消失。
    - `${@note ...}` 注释也是 `${...}` 子集，一并剥空。
    匹配源经 resolve 多轮后通常是"已展开正文"（无外壳），此剥壳只影响仍以字面量存在的
    未展开/待激活占位符——目的是让匹配源贴近"最终会进正文的内容"。
    """
    if "${" not in text and "{{" not in text:
        return text
    pieces: list[str] = []
    cursor = 0
    for _kind, _inner, start, end in _scan_top_level(text):
        pieces.append(text[cursor:start])
        # 不拼接占位符段（丢弃），保留其余
        cursor = end
    pieces.append(text[cursor:])
    return "".join(pieces)


def _resolve_one_round_braces(text: str, var_map: dict, type_map: dict | None, mention_source: str | None = None) -> str:
    """One pass: match every top-level `${...}` and replace via the judgment layer.

    Only `${}` groups are handled here. `{{}}` slices are handled by
    resolve_placeholders separately in the resolve_variables loop (which owns
    instance_dir). Produced strings may contain fresh `${`/`{{`, fed to the next round.
    `mention_source` 供 `@mention` 做关键词匹配源（Generate 跨消息场景为上一轮全部 msg
    拼接；None 时回退用当前 `text` 本身）。
    """
    pieces: list[str] = []
    cursor = 0
    for kind, inner, start, end in _scan_top_level(text):
        if kind != "var":
            continue  # stay out of `{{}}` — resolve_placeholders owns those
        pieces.append(text[cursor:start])
        # @mention 特判：就地求值需看到关键词源文本，不进注册表（见其上方注释）
        if inner.strip().startswith("@mention"):
            src = mention_source if mention_source is not None else text
            self_lit = "${" + inner + "}"
            out = _resolve_mention(inner, src, var_map, self_lit)
            pieces.append(out if out is not None else self_lit)
        else:
            pieces.append(_judge_and_resolve(inner, var_map, type_map))
        cursor = end
    pieces.append(text[cursor:])
    return "".join(pieces)


def validate_var_name(name) -> Optional[str]:
    """Return an error string if `name` is invalid as a sandbox variable name, else None.

    Names must not contain whitespace: they are referenced from `${...}` code blocks
    as Python identifiers (e.g. `if dice == 6`), and a spacey name can't be a Name.
    Names must not contain `:`: the judgment layer routes a single `/multiple` colon
    in a bare `${...}` to the python/condition path (e.g. `${a:b}`), so a colon in a
    real variable name would make that parse ambiguous.
    Names must not contain `@`: it is the reserved prefix of the explicit directive
    syntax `${@name ...}`, so a real variable name starting with `@` (or containing
    it) would collide with directive parsing.
    """
    s = str(name)
    if any(ch.isspace() for ch in s) or ":" in s or "@" in s:
        return (
            f"变量名不能包含空白字符、冒号 ':' 或 '@': '{name}'"
            "（空白会破坏 ${...} 代码块做 Python 标识符；冒号 ':' 会让裸 ${...} 被判定层误判为 python/condition；'@' 是 ${@name} 显式指令的保留前缀）"
        )
    return None


def substitute_variables(text: str, var_map: dict) -> str:
    """Resolve ${name} variables ONLY (single pass, no {{}}). Missing → literal."""
    return _substitute_variable_literals(text, var_map)


def resolve_variables(text: str, var_map: dict, instance_dir: Path, max_depth: int = MAX_RESOLVE_DEPTH, strict: bool = False, type_map: dict | None = None, mention_source: str | None = None) -> str:
    """Resolve `${}` and `{{path}}` for AI-facing surfaces (system prompt / Generate).

    Pure per-round model (§3.4): each round matches every top-level placeholder,
    judges its syntax and dispatches to the handler registry, producing strings that
    become the next round's input. Alternation between `${}`-expansion and `{{}}`
    file slices happens **within** a round (brace groups first, then resolving any
    `{{}}` produced), and loops until stable. Bounded by max_depth: past the limit,
    remaining placeholders are left literal (no hard error), so a variable whose
    value (transitively) references itself degrades gracefully.

    Missing variables render literally; a bare `$` is never touched. File slices
    are lenient (strict=False): unresolvable `{{...}}` (a doc example) stays literal
    rather than raising.
    """
    # 转义的最后阶段：隐藏被 \ 转义的占位符，避免多轮循环把 ${/{{ 哨兵吞掉。
    # 变量值在循环内才注入，注入后可能出现新的 \{{...}}，所以隐藏要**每次迭代重复做**，
    # 循环稳定后统一还原哨兵。
    esc_literals: list[str] = []
    text, pre = _hide_escaped_placeholders(text)
    esc_literals.extend(pre)
    for _ in range(max_depth):
        before = text
        # ${} 一组（搜索状态机 → 判定 → 处理器），再解本轮新产出的 {{}} 切片。
        text = _resolve_one_round_braces(text, var_map, type_map, mention_source)
        if "{{" in text:
            text = resolve_placeholders(text, instance_dir, strict=strict)
        # 变量值注入后，把新增的转义占位符保护为哨兵
        text, extra = _hide_escaped_placeholders(text)
        esc_literals.extend(extra)
        if text == before:
            break
    # 单文本调用面（mention_source=None）：在此销毁未命中的 @mention 残留（否则脏文本喂 AI）。
    # 跨 msg 调用面（mention_source 非 None）：**不在此销毁**——未命中的 @mention 需透传保留
    # 给外层 `_resolve_messages_vars` 的全部轮结束后统一销毁（跨消息最后一轮才销毁），
    # 否则第一轮未命中就被删，后续轮即便 mention_source 更新也无 @mention 可匹配。
    # 位置在哨兵还原之前：被 \ 转义的 \${@mention...} 已以哨兵形式存在，天然跳过。
    if mention_source is None:
        text = _drop_unmatched_mentions(text)
    return _restore_escaped_placeholders(text, esc_literals)


def _stringify(value) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        try:
            import json
            return json.dumps(value, ensure_ascii=False)
        except (TypeError, ValueError):
            return str(value)
    return str(value)


def resolve_messages_placeholders(messages: list[dict], instance_dir: Path) -> list[dict]:
    """Recursively resolve placeholders in all string values of a messages array."""
    return [_resolve_msg_dict(msg, instance_dir) for msg in messages]


# =====================================================================
# Internal: recursive dict/list resolution
# =====================================================================

def _resolve_msg_dict(d: dict, instance_dir: Path) -> dict:
    out = {}
    for k, v in d.items():
        if isinstance(v, str):
            out[k] = resolve_placeholders(v, instance_dir)
        elif isinstance(v, dict):
            out[k] = _resolve_msg_dict(v, instance_dir)
        elif isinstance(v, list):
            out[k] = [_resolve_msg_item(item, instance_dir) for item in v]
        else:
            out[k] = v
    return out


def _resolve_msg_item(item, instance_dir: Path):
    if isinstance(item, str):
        return resolve_placeholders(item, instance_dir)
    if isinstance(item, dict):
        return _resolve_msg_dict(item, instance_dir)
    if isinstance(item, list):
        return [_resolve_msg_item(i, instance_dir) for i in item]
    return item


# =====================================================================
# Internal: single placeholder resolution
# =====================================================================

def _resolve_one(raw: str, instance_dir: Path) -> str:
    if raw.startswith("glob:"):
        return _resolve_glob(raw[5:].strip(), instance_dir)
    if raw.startswith("@"):
        return _resolve_package(raw, instance_dir)
    return _resolve_file(raw, instance_dir)


def _split_package_ref(raw: str) -> tuple[str, str]:
    """Split `{{@<包名>/<rest>}}` inner text into (pkg_name, rest).

    raw is the content after the leading `@` (may include modifiers in rest that
    _resolve_file understands). Package name = whole segment before the first `/`.
    """
    stripped = raw.strip()
    if stripped.startswith("@"):
        stripped = stripped[1:]
    stripped = stripped.strip()
    slash = stripped.find("/")
    if slash == -1:
        return stripped.strip(), ""
    return stripped[:slash].strip(), stripped[slash + 1:].strip()


def check_package_ref(instance_dir: Path, raw: str) -> tuple[bool, str]:
    """Validate a single `{{@包名/rest}}` reference. Returns (ok, reason).

    Public helper so the CheckPackageRefs director tool and the resolver share the
    exact same package-root semantics (包缺失/路径不存在/路径穿越判定) — no drift.
    `raw` may be the whole `{{@...}}` inner text or just `@包名/rest`.
    """
    pkg_name, rest = _split_package_ref(raw)
    if not pkg_name:
        return False, "空包名"
    pkg_root = instance_dir / "packages" / pkg_name
    if not pkg_root.is_dir():
        return False, f"包 '{pkg_name}' 未安装"
    if not rest:
        # 只引用包根目录本身，不具体到文件——可指向 README 之类，但此处视为"未指定文件"
        return False, f"包 '{pkg_name}' 未指定具体文件（只写了包名）"
    # rest 可能带 :行段 / |from=to——解析前的裸路径不含这些语法也行；这里用
    # _resolve_file_path 判定文件可达，遇到行段修饰则先截出纯路径段。
    base_file = rest.split("|", 1)[0].split(":", 1)[0].strip()
    if not base_file:
        return False, "未指定文件路径"
    try:
        _resolve_file_path(instance_dir, base_file, base_dir=pkg_root)
    except PlaceholderError as e:
        return False, str(e)
    return True, ""



def _resolve_package(raw: str, instance_dir: Path) -> str:
    """Resolve `{{@包名/rest}}` against `<instance>/packages/<包名>/rest`.

    包名 = 第一个 `/` 前的整段（包名本身可含空格/点号/中文，作识别符带版本号）。
    rest 支持与普通切片相同的 `:行段`/`|from=to` 修饰（经 _resolve_file 转发）。
    包缺失或不存在的路径：
      - strict=True（resolve_placeholders）时抛 PlaceholderError
      - 否则在 _replacer 里被捕获，原样保留字面量（文档示例不炸）。
    路径穿越由 _resolve_file_path 的 resolve()+startswith 防护。
    """
    pkg_name, rest = _split_package_ref(raw)
    if not pkg_name:
        raise PlaceholderError(f"Package path empty: {raw}")

    pkg_root = instance_dir / "packages" / pkg_name
    if not pkg_root.is_dir():
        raise PlaceholderError(f"Package not installed: {pkg_name}")
    if not rest:
        raise PlaceholderError(f"Package path is a directory: {pkg_name}")
    # 包内文件不搞 glob，仅走普通切片（含行段/anchor）
    return _resolve_file(rest, instance_dir, base_dir=pkg_root)


_NUM_SEGMENT_RE = re.compile(r"(\d+)")


def _first_number(name: str) -> int | None:
    """Return the first numeric segment in a filename, or None if absent.

    e.g. 'floor-5.md' -> 5, 'floor-5-draft.md' -> 5, 'readme.md' -> None.
    """
    m = _NUM_SEGMENT_RE.search(name)
    return int(m.group(1)) if m else None


def _is_draft(name: str) -> bool:
    """A file is a 'draft' (semi-formal) when its stem carries a -draft suffix."""
    return bool(re.search(r"-draft\.", name))


def _resolve_glob(raw_pattern: str, instance_dir: Path) -> str:
    # 多平台：反斜杠规范化为正斜杠，与文件切片一致。
    raw_pattern = raw_pattern.replace("\\", "/")
    # Split off an optional trailing ':lastN' suffix, e.g. 'floors/floor-*.md:last30'.
    pattern = raw_pattern
    last_n: int | None = None
    if ":" in raw_pattern:
        head, _, tail = raw_pattern.rpartition(":")
        low = tail.strip()
        if low.lower().startswith("last"):
            try:
                n = int(low[4:].strip())
            except ValueError:
                n = None
            if n is not None:
                if n <= 0:
                    raise PlaceholderError(f"lastN must be > 0: {raw_pattern}")
                pattern, last_n = head.strip(), n
            else:
                raise PlaceholderError(f"Invalid lastN suffix in glob: {raw_pattern}")

    # Match against the instance root. Patterns are relative to the instance root
    # and glob directly (runtime/floors/, settings/..., etc. are normal dirs now).
    matched = sorted(instance_dir.glob(pattern))
    if not matched:
        raise PlaceholderError(f"glob pattern matched no files: {pattern}")

    if last_n is not None:
        matched = _take_last_by_number(matched, last_n)

    parts = []
    for path in matched:
        rel = str(path.relative_to(instance_dir)).replace("\\", "/")
        content = path.read_text(encoding="utf-8")
        parts.append(f"--- {rel} ---\n{content}")
    return "\n\n".join(parts)


def _take_last_by_number(matched: list[Path], last_n: int) -> list[Path]:
    """Keep the files whose numeric segment ranks in the top `last_n` (descending).

    Files are grouped by numeric segment; within one number the formal floor
    (floor-N.md) wins over the draft (floor-N-draft.md). Files without a numeric
    segment are dropped when a lastN window is requested. The chosen files are
    returned in ascending numeric order (floor 1 → N), since a glob window feeds
    prose into the context in story order.
    """
    best_by_num: dict[int, Path] = {}
    for p in matched:
        num = _first_number(p.name)
        if num is None:
            continue
        current = best_by_num.get(num)
        if current is None or (not _is_draft(p.name) and _is_draft(current.name)):
            best_by_num[num] = p

    chosen_nums = sorted(best_by_num.keys(), reverse=True)[:last_n]
    ordered = sorted(
        ((best_by_num[num], num) for num in chosen_nums),
        key=lambda pn: (pn[1], 0 if not _is_draft(pn[0].name) else 1),
    )
    return [p for p, _ in ordered]


def _resolve_file(raw: str, instance_dir: Path, base_dir: Path | None = None) -> str:
    # Split on | to separate file/line-range from anchor modifiers
    # e.g. "test.md:10-30|from=A|to=B" → ["test.md:10-30", "from=A", "to=B"]
    pipe_parts = _split_pipes_outside_quotes(raw)
    base_part = pipe_parts[0].strip()  # e.g. "test.md" or "test.md:10-30"
    anchor_parts = pipe_parts[1:]      # e.g. ['from="A"', 'to="B"']

    # Parse base: separate file path from optional line range
    colon_pos = base_part.find(":")
    if colon_pos == -1:
        file_path = base_part
        line_range = None
    else:
        file_path = base_part[:colon_pos].strip()
        line_range = _extract_line_range(base_part[colon_pos + 1:].strip())

    full = _resolve_file_path(instance_dir, file_path, base_dir=base_dir)
    content = full.read_text(encoding="utf-8")
    lines = content.splitlines(keepends=True)

    # 1. Line range
    if line_range is not None:
        start, end = line_range
        start = max(0, start)
        end = min(len(lines), end)
        if start >= end:
            raise PlaceholderError(f"Line range out of bounds: {start+1}-{end}")
        lines = lines[start:end]

    # 2. Anchor modifiers (from= / to=) — LINE-level. from= cuts from the line
    #    containing the anchor; to= cuts up to AND INCLUDING that line.
    for part in anchor_parts:
        part = part.strip()
        from_a = _extract_quoted(part, "from")
        to_a = _extract_quoted(part, "to")

        if from_a is not None:
            idx = _find_anchor_line(from_a, lines)
            lines = lines[idx:]

        if to_a is not None:
            idx = _find_anchor_line(to_a, lines)
            lines = lines[: idx + 1]  # include the anchor line

    # 3. String-level anchors (between= / and=) — crop a SUBSTRING between two
    #    unique markers on a single line (or across lines), INCLUDING the anchors.
    #    Operates on the whole selected text (post from/to line crop). Both anchors
    #    must occur exactly once; start order is validated. Half-open: a single
    #    between= runs to end-of-text, a single and= runs from start-of-text.
    content = "".join(lines)
    between_a = and_a = None
    for part in anchor_parts:
        part = part.strip()
        b = _extract_quoted(part, "between")
        a = _extract_quoted(part, "and")
        if b is not None:
            between_a = b
        if a is not None:
            and_a = a

    if between_a is not None or and_a is not None:
        start = 0
        if between_a is not None:
            start = _find_unique_anchor(content, between_a)
        end = len(content)
        if and_a is not None:
            a_pos = _find_unique_anchor(content, and_a)
            end = a_pos + len(and_a)
        if start > end:
            raise PlaceholderError(
                f"between anchor '{between_a}' starts after and anchor '{and_a}' ends"
            )
        return content[start:end]

    return content


def _read_full(file_path: str, instance_dir: Path) -> str:
    return _resolve_file_path(instance_dir, file_path).read_text(encoding="utf-8")


def _resolve_file_path(instance_dir: Path, file_path: str, base_dir: Path | None = None) -> Path:
    # base_dir 默认取 instance_dir；传包根时可让 `{{@pkg/...}}` 在包目录内解析。
    root = base_dir or instance_dir
    # 多平台：把反斜杠规范化为正斜杠，Windows 上写惯的 `\` 路径在 Linux 也能解析。
    full = (root / file_path.replace("\\", "/")).resolve()
    if not str(full).startswith(str(root.resolve())):
        raise PlaceholderError(f"Path traversal detected: {file_path}")
    if not full.exists():
        raise PlaceholderError(f"File not found: {file_path}")
    if full.is_dir():
        raise PlaceholderError(f"Path is a directory: {file_path}")
    return full


# =====================================================================
# Modifier parsing
# =====================================================================

LINE_RANGE_RE = re.compile(r"^(\d+)\s*-\s*(\d+)$")


def _extract_line_range(s: str) -> Optional[tuple[int, int]]:
    """Extract 0-indexed [start, end) from a 'start-end' pattern.
    Returns None if no line range found.
    """
    s = s.strip()
    m = LINE_RANGE_RE.search(s)
    if not m:
        return None
    start = int(m.group(1)) - 1  # 1-indexed → 0-indexed
    end = int(m.group(2))         # inclusive → exclusive
    if start < 0:
        raise PlaceholderError(f"Line number must be >= 1, got {m.group(1)}")
    if start >= end:
        raise PlaceholderError(f"Empty line range: {start+1}-{end}")
    return (start, end)


def _split_pipes_outside_quotes(s: str) -> list[str]:
    """Split string by | that are not inside double quotes."""
    parts: list[str] = []
    current: list[str] = []
    in_quotes = False
    for ch in s:
        if ch == '"':
            in_quotes = not in_quotes
            current.append(ch)
        elif ch == "|" and not in_quotes:
            parts.append("".join(current))
            current = []
        else:
            current.append(ch)
    parts.append("".join(current))
    return parts


def _extract_quoted(s: str, key: str) -> Optional[str]:
    """Extract value from key="value" pattern. Returns None if not found."""
    m = re.search(rf'{key}="([^"]*)"', s)
    return m.group(1) if m else None


def _find_anchor_line(anchor: str, lines: list[str]) -> int:
    """Find the 0-indexed line index containing anchor. Raises if not exactly one."""
    found = None
    for i, line in enumerate(lines):
        if anchor in line:
            if found is not None:
                raise PlaceholderError(f"Anchor appears on multiple lines: '{anchor}'")
            found = i
    if found is None:
        raise PlaceholderError(f"Anchor not found: '{anchor}'")
    return found


def _find_unique_anchor(text: str, anchor: str) -> int:
    """Find the 0-indexed position of a string-level anchor. Raises if not exactly one."""
    if not anchor:
        raise PlaceholderError("Anchor must not be empty")
    count = text.count(anchor)
    if count == 0:
        raise PlaceholderError(f"Anchor not found: '{anchor}'")
    if count > 1:
        raise PlaceholderError(f"Anchor appears {count} times (must be unique): '{anchor}'")
    return text.find(anchor)
