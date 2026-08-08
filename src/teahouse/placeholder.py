"""
Placeholder/slice resolver — `{{path}}` file slices and `${name}` variables.

`{{path}}` file slices: pure "copy/move" primitive — inlines file content verbatim,
materializing no semantic change. Used by Write/Edit/WriteLine (resolve_placeholders).

`${name}` variables: reference a value from a var_map (sandbox vars + system-internal
`teahouse.*`). Strict: must be `$` immediately followed by `{...}`; a bare `$` is left
alone. If the name is NOT in var_map, the literal `${name}` is kept unchanged (原样显示).
`teahouse.xxx` values exist only during director system-prompt assembly; elsewhere they
are ordinary missing variables and render literally (naturally 不泄露内部提示词).

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
  {{glob:pattern}}                       Glob-matched files, sorted
  {{glob:pattern:lastN}}                 Glob-matched files, keep the last N by numeric segment (descending)

Note: use | as the anchor separator, : for the line range.
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


_VARIABLE_RE = re.compile(r"\$\{(.+?)\}")

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

    用 balanced 扫描（同 resolve_conditional_slices）匹配开括号，所以：
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
    """One pass of ${name} substitution. Missing variables render literally."""
    def _replacer(match: re.Match) -> str:
        name = match.group(1).strip()
        if name in var_map:
            return _stringify(var_map[name])
        return match.group(0)  # 原样显示

    return _VARIABLE_RE.sub(_replacer, text)


# =====================================================================
# 条件切片 — 变量驱动的 `${ if ...: return ... }` 多行代码块
# =====================================================================
#
# A multi-line `${ ... }` block is a conditional slice: it selects one string to
# inline based on sandbox vars, evaluated at resolve time. A block whose content
# (after strip) contains `return ` (followed by a space) is treated as a **code
# block**: its content is parsed via a whitelist AST interpreter, the single
# matched `return <value>` branch is materialized, and that value is returned for
# the outer resolve loop to continue expanding (it may itself contain `{{...}}`
# or `${...}`). A block with no `return ` is an ordinary variable block reused
# from the standard lookup (read var_map; missing → literal).
#
# All failures (syntax error, non-whitelisted node, unknown name) degrade to the
# literal block text — never raise, so a bad block can't blow up assembly.

# Test trigger: a block is a code block iff `return ` appears inside it.
_CODE_BLOCK_TRIGGER = "return "

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


def _eval_code_block(code: str, var_map: dict) -> str:
    """Evaluate a code block's content to the materialized return value. Always
    returns a string — on any failure, the original literal block text."""
    literal = "${" + code + "}"
    try:
        tree = _parse_code_block(code)
        _check_whitelist(tree)
        env = dict(var_map) if isinstance(var_map, dict) else {}
        value = _exec_block(tree.body, env)
    except (_BlockEvalError, SyntaxError, TypeError, ValueError, ZeroDivisionError):
        return literal
    if value is _NO_RETURN:
        return literal
    return _stringify(value)


def _resolve_one_block(inner: str, var_map: dict) -> str:
    """Resolve a single `${...}` block's content. Returns the replacement string."""
    stripped = inner.strip()
    if _CODE_BLOCK_TRIGGER in stripped:
        return _eval_code_block(stripped, var_map)
    # Ordinary variable block — reuse standard lookup, missing → literal.
    if stripped in var_map:
        return _stringify(var_map[stripped])
    return "${" + inner + "}"  # 原样显示


def resolve_conditional_slices(text: str, var_map: dict) -> str:
    """Replace every multi-line `${ ... }` conditional-slice block in `text`.

    Balanced-brace scan (nested `{}` supported), independent of _VARIABLE_RE so a
    multi-line block isn't truncated at the first `}`. Returns text with matched
    code/variable blocks materialized (or kept literal on failure); ${name} and
    {{path}} placeholders produced here are expanded by the caller's next pass.
    """
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        if text[i] == "$" and i + 1 < n and text[i + 1] == "{":
            depth = 0
            k = i + 1
            closed = False
            while k < n:
                if text[k] == "{":
                    depth += 1
                elif text[k] == "}":
                    depth -= 1
                    if depth == 0:
                        closed = True
                        break
                k += 1
            if not closed:
                # Unbalanced — leave the brace group untouched, resume after `{`.
                out.append(text[i])
                i += 1
                continue
            inner = text[i + 2:k]
            out.append(_resolve_one_block(inner, var_map))
            i = k + 1
        else:
            out.append(text[i])
            i += 1
    return "".join(out)


def validate_var_name(name) -> Optional[str]:
    """Return an error string if `name` is invalid as a sandbox variable name, else None.

    Names must not contain whitespace: they are referenced from `${...}` code blocks
    as Python identifiers (e.g. `if dice == 6`), and a spacey name can't be a Name.
    """
    if any(ch.isspace() for ch in str(name)):
        return f"变量名不能包含空白字符: '{name}'（它会作为 Python 标识符被 ${...} 条件切片代码块引用）"
    return None


def substitute_variables(text: str, var_map: dict) -> str:
    """Resolve ${name} variables ONLY (single pass, no {{}}). Missing → literal."""
    return _substitute_variable_literals(text, var_map)


def resolve_variables(text: str, var_map: dict, instance_dir: Path, max_depth: int = MAX_RESOLVE_DEPTH, strict: bool = False) -> str:
    """Resolve ${name} and {{path}} for AI-facing surfaces (system prompt / Generate).

    Alternates ${} → {{}} → ${} → ... until stable, so a {{path}} slice whose content
    references a variable (and vice versa) resolves fully. Bounded by max_depth:
    past the limit, remaining placeholders are left literal (no hard error), so a
    variable whose value (transitively) references itself degrades gracefully.

    Also resolves multi-line ${ ... } conditional-slice blocks (see
    resolve_conditional_slices): an `if ...: return ...` block selects one string to
    inline based on var_map, substituted ahead of the single-line variable pass.

    Missing variables render literally; a bare `$` is never touched. File slices
    are lenient (strict=False): unresolvable `{{...}}` (a doc example) stays literal
    rather than raising.
    """
    # 转义的最后阶段：隐藏被 \ 转义的占位符，避免多轮交替展开把它们吞掉。
    # ${teahouse.*} / ${name} 变量值在循环内才注入，注入后可能出现新的 \{{...}}，
    # 所以隐藏要**在每次迭代里重复做**（把新增的转发给哨兵），循环稳定后统一还原。
    esc_literals: list[str] = []
    for _ in range(max_depth):
        before = text
        text = resolve_conditional_slices(text, var_map)
        text = _substitute_variable_literals(text, var_map)
        # 变量值注入后，把新增的转义占位符保护为哨兵
        text, extra = _hide_escaped_placeholders(text)
        esc_literals.extend(extra)
        if "{{" in text:
            text = resolve_placeholders(text, instance_dir, strict=strict)
        if text == before:
            break
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
    return _resolve_file(raw, instance_dir)


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

    # Match against the instance root. `.teahouse/` is a hidden directory that
    # plain globs skip, so a shorthand pattern like "output/floors/floor-*.md"
    # (per the {{glob:...:lastN}} design) is retried under `.teahouse/output/`.
    matched = sorted(instance_dir.glob(pattern))
    if not matched and not pattern.startswith(".teahouse/"):
        prefixed = sorted(instance_dir.glob(f".teahouse/{pattern}"))
        if prefixed:
            matched = prefixed
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


def _resolve_file(raw: str, instance_dir: Path) -> str:
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

    full = _resolve_file_path(instance_dir, file_path)
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

    # 2. Anchor modifiers (from= / to=)
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

    return "".join(lines)


def _read_full(file_path: str, instance_dir: Path) -> str:
    return _resolve_file_path(instance_dir, file_path).read_text(encoding="utf-8")


def _resolve_file_path(instance_dir: Path, file_path: str) -> Path:
    full = (instance_dir / file_path).resolve()
    if not str(full).startswith(str(instance_dir.resolve())):
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
