"""RunScript — instance-authored Python recipes run against the tool channel.

Why this exists: a sub-session is an *AI* given a task; a script is a *command*.
The script has no LLM in the loop deciding anything — it is a pre-authored,
parameterised pipeline the director/DM triggers by name. Its whole point over the
sandbox's inline ``runTool`` batch is **data flow**: a ``runTool`` step's args are
static and cannot see the previous step's result, so "Generate → read it back →
trim → append to a JSON" is impossible there and trivial here.

Execution model:
  - Source may come from an instance file (``scripts/foo.py``) or straight from
    the tool argument. Either way it goes through the same plugin gate: the L1
    AST whitelist + L2 stripped builtins from ``plugin_runtime`` (see the note
    below on why the gate is not skipped for "trusted" instance code).
  - The script body is compiled with ``PyCF_ALLOW_TOP_LEVEL_AWAIT``, so it reads
    as a flat async sequence — no mandatory ``async def`` wrapper.
  - Host access is only through the injected ``t`` object, whose ``run_tool`` is
    the very same ``execute_tool`` channel the director uses, carrying the
    *caller's* permission gates so a script cannot widen its invoker's scope.

Why the AST gate stays on: sandbox JS runs in the *browser* and can already touch
every tool through a bounded API surface; a script runs in the *server process*,
where the blast radius includes ``teahouse.yaml`` (JWT secret, master key). The
same trust level does not apply, so the gate is defence-in-depth here rather than
the plugin case's "accidental escape" guard.
"""
from __future__ import annotations

import ast
import asyncio
import contextvars
import gc
import inspect
import time
from pathlib import Path
from typing import Any

from .plugin_runtime import safe_plugin_builtins, validate_backend_source
from .state import state

# Nested RunScript calls (a script invoking one) are allowed but bounded, so a
# runaway self-recursion fails loudly instead of looping forever.
MAX_SCRIPT_DEPTH = 3
_script_depth: contextvars.ContextVar[int] = contextvars.ContextVar("script_depth", default=0)

# Captured stdout cap — a chatty script must not flood the director's context.
_MAX_OUTPUT_CHARS = 20000
# Kept from each end when the cap is hit (a failure is often reported at the tail).
_HEAD_CHARS = 12000
_TAIL_CHARS = 6000


class _MustAwait:
    """Awaitable returned by the three async ``t`` methods.

    A dropped plain coroutine only emits a ``RuntimeWarning`` on GC — easy to miss,
    and the actual damage is silent (a ``Write`` that never happened). This wrapper
    instead records the miss **into the script's own output**, so it shows up in the
    result the caller reads. ``close()`` in the destructor also suppresses the
    RuntimeWarning, so the report is a single visible line rather than stderr noise.

    ``__await__`` delegates, so ``await``, ``asyncio.gather`` and friends all still
    work on it.
    """

    __slots__ = ("_coro", "_ctx", "_what", "_awaited")

    def __init__(self, coro, ctx: "ScriptContext", what: str) -> None:
        self._coro = coro
        self._ctx = ctx
        self._what = what
        self._awaited = False

    def __await__(self):
        self._awaited = True
        return self._coro.__await__()

    def close(self) -> None:
        self._coro.close()

    def __del__(self) -> None:
        if self._awaited:
            return
        try:
            self._coro.close()
        except Exception:
            pass
        try:
            self._ctx._out.append(
                f"[warn] {self._what} 没有被 await —— 这次调用没有真正执行（async 方法必须 await）\n"
            )
        except Exception:
            pass


class ScriptContext:
    """The ``t`` object handed to a script — its only gateway to the engine.

    Method names mirror ``PluginContext`` so authors (and the director reading
    the README) move between the two without relearning anything. Deliberately
    absent: ``network_request`` (the plugin system owns the outbound channel).
    """

    def __init__(
        self,
        instance_dir: Path,
        args: dict,
        *,
        user_id: str | None = None,
        instance_id: str | None = None,
        session_id: str | None = None,
        enabled_tools: list[str] | None = None,
        exclude: set[str] | None = None,
        run_uuid: str | None = None,
        label: str = "script",
    ) -> None:
        self.instance_dir = instance_dir
        self.args = args
        self.user_id = user_id
        self.instance_id = instance_id
        self.session_id = session_id
        self.enabled_tools = enabled_tools
        self.exclude = exclude
        self.run_uuid = run_uuid
        self.label = label
        self._out: list[str] = []
        self._steps = 0

    # ---- tool channel ----
    def run_tool(self, name: str, args: dict | None = None) -> _MustAwait:
        """Run one director tool and return its result text. **Must be awaited.**

        The caller's ``enabled_tools`` / ``exclude`` are re-applied, so a script
        cannot reach a tool its invoker could not have called directly. A failed
        tool returns a string starting with ``"Error"`` (it does not raise) —
        check it when the next step depends on the result.
        """
        return _MustAwait(
            self._run_tool(name, args), self, f"t.run_tool({name!r})"
        )

    async def _run_tool(self, name: str, args: dict | None = None) -> str:
        from .tools import execute_tool

        result = await execute_tool(
            name,
            args or {},
            self.instance_dir,
            self.user_id,
            self.instance_id,
            run_uuid=self.run_uuid,
            session_id=self.session_id,
            enabled_tools=self.enabled_tools,
            exclude=self.exclude,
        )
        self._steps += 1
        state.broadcast(
            "tool_run",
            {
                "run_uuid": self.run_uuid,
                "index": self._steps,
                "tool": name,
                "result": result,
                "ok": not str(result).startswith("Error"),
                "instance_id": self.instance_id or self.instance_dir.name,
            },
        )
        return result

    def run_tools(self, steps: list[dict]) -> _MustAwait:
        """Run ``[{tool, args}, ...]`` serially and return each step's result."""
        return _MustAwait(self._run_tools(steps), self, "t.run_tools(...)")

    async def _run_tools(self, steps: list[dict]) -> list[str]:
        out = []
        for step in steps:
            if not isinstance(step, dict) or "tool" not in step:
                out.append("Error: run_tools 的每一步都要是 {'tool': ..., 'args': ...}")
                continue
            out.append(await self._run_tool(step["tool"], step.get("args") or {}))
        return out

    # ---- instance file I/O ----
    def _path(self, path: str) -> Path:
        from .tools import _validate_path

        return _validate_path(self.instance_dir, path)

    def read_file(self, path: str) -> str:
        full = self._path(path)
        if not full.exists():
            raise FileNotFoundError(f"文件不存在: {path}")
        return full.read_text(encoding="utf-8")

    def read_bytes(self, path: str) -> bytes:
        full = self._path(path)
        if not full.exists():
            raise FileNotFoundError(f"文件不存在: {path}")
        return full.read_bytes()

    def write_file(self, path: str, content: str) -> None:
        """Write an instance file (**synchronous** — no ``await``).

        Writes are path-guarded exactly like reads (no ``..`` escape, no absolute
        paths) and, when the caller carries a tool allow-list, confined to what
        that caller could have written itself: ``temp/`` is always fair game
        (it is gitignored scratch, and ``Report`` grants the same to any scoped
        session), anything else needs the ``Write`` grant.
        """
        self._require_write(path)
        full = self._path(path)
        existed = full.exists()
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text(content, encoding="utf-8")
        state.broadcast(
            "file_changed",
            {
                "path": path,
                "tool": "RunScript",
                "type": "modified" if existed else "created",
                "instance_id": self.instance_id or self.instance_dir.name,
            },
        )

    def _require_write(self, path: str) -> None:
        if self.enabled_tools is None or "Write" in self.enabled_tools:
            return
        norm = str(path).replace("\\", "/").lstrip("./")
        if norm.startswith("temp/"):
            return
        raise PermissionError(
            f"脚本调用方没有 Write 权限，只能写 temp/（本次要写 {path}）。"
            "请让调用方显式授予 Write，或把产物改落到 temp/。"
        )

    def file_exists(self, path: str) -> bool:
        return self._path(path).exists()

    def list_files(self, subdir: str = "") -> list[str]:
        base = self._path(subdir) if subdir else self.instance_dir.resolve()
        if not base.is_dir():
            return []
        root = self.instance_dir.resolve()
        return sorted(
            str(p.relative_to(root)).replace("\\", "/")
            for p in base.rglob("*")
            if p.is_file()
        )

    # ---- runtime vars ----
    def get_var(self, names: list[str] | str | None = None) -> list[dict]:
        """Read runtime vars. ``names`` is a **list** of names — a bare string is
        accepted as a single name (rather than being iterated character by
        character into a silent all-``None`` result)."""
        from .database.workspaces import read_sandbox_vars

        if isinstance(names, str):
            names = [names]
        return read_sandbox_vars(self.instance_dir, names)

    def set_var(
        self,
        updates: dict,
        note: dict | None = None,
        change_log: dict | None = None,
    ) -> None:
        """Write runtime vars from a **dict** ``{name: value}``. Requires the
        caller's ``SetRuntimeVar`` grant when it carries a tool allow-list."""
        from .database.workspaces import write_sandbox_vars

        if not isinstance(updates, dict):
            raise TypeError(
                f"t.set_var 需要字典入参，形如 t.set_var({{'金币': 120}})；收到 {type(updates).__name__}。"
            )
        if self.enabled_tools is not None and "SetRuntimeVar" not in self.enabled_tools:
            raise PermissionError(
                "脚本调用方没有 SetRuntimeVar 权限。请让调用方显式授予，或改由导演自己做这次变量写入。"
            )
        write_sandbox_vars(self.instance_dir, updates, note, change_log)

    # ---- misc ----
    def roll(self, expr: str) -> _MustAwait:
        """Roll dice via the engine's single-source-of-truth roller (`1d6`,
        `2d6+1`, `4d6k3`). **Must be awaited**; raises ValueError on a bad
        expression."""
        return _MustAwait(self._roll(expr), self, f"t.roll({expr!r})")

    async def _roll(self, expr: str) -> int:
        from .tools import execute_roll

        raw = await execute_roll(self.instance_dir, {"dice": str(expr)})
        if raw.startswith("Error"):
            raise ValueError(raw)
        return int(raw)

    def log(self, message: Any) -> None:
        """Append a line to this run's output (visible to the caller)."""
        self._out.append(f"[log] {message}\n")

    # ---- output buffer ----
    def _print(self, *parts: Any, sep: str = " ", end: str = "\n", **_kw: Any) -> None:
        self._out.append(sep.join(str(p) for p in parts) + end)

    def output(self) -> str:
        text = "".join(self._out)
        if len(text) > _MAX_OUTPUT_CHARS:
            dropped = len(text) - _HEAD_CHARS - _TAIL_CHARS
            text = (
                f"{text[:_HEAD_CHARS]}\n"
                f"…（输出共 {len(text)} 字符，中间 {dropped} 字符已省略，"
                f"上限 {_MAX_OUTPUT_CHARS}；需要看全就把它写进文件再 Read）…\n"
                f"{text[-_TAIL_CHARS:]}"
            )
        return text


def _script_filename(label: str) -> str:
    return f"<script:{label}>"


def _module_body_calls_run(tree: ast.AST) -> bool:
    """True when the script's *module body* itself invokes ``run``.

    A script may either just define ``async def run(t, args)`` and let the engine
    call it, or drive everything at the top level. Doing both — defining ``run``
    and calling it in the body — used to run it **twice** (the author's call plus
    the engine's auto-call). The engine now skips its auto-call in that case.

    Deliberately does not descend into function/class bodies, so a recursive
    ``run`` calling itself is not mistaken for the top-level pattern.
    """
    stack = list(getattr(tree, "body", []))
    while stack:
        node = stack.pop()
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "run"
        ):
            return True
        stack.extend(ast.iter_child_nodes(node))
    return False


def _format_failure(exc: BaseException, source: str, label: str, out: str) -> str:
    """Build a readable failure string: the exception, then the offending
    source line(s) from the script itself — internal frames are dropped so the
    author sees their own code, not our runner."""
    fname = _script_filename(label)
    lines = source.splitlines()
    located = []
    tb = exc.__traceback__
    while tb is not None:
        if tb.tb_frame.f_code.co_filename == fname:
            lineno = tb.tb_lineno
            text = lines[lineno - 1].strip() if 0 < lineno <= len(lines) else ""
            located.append(f"  {label}:{lineno}  {text}")
        tb = tb.tb_next

    msg = [f"Error: 脚本 {label} 执行失败：{type(exc).__name__}: {exc}"]
    if located:
        msg.extend(located)
    if out.strip():
        msg.append("--- 出错前的输出 ---")
        msg.append(out.rstrip())
    return "\n".join(msg)


async def run_script(
    instance_dir: Path,
    *,
    source: str,
    args: dict | None = None,
    label: str = "script",
    user_id: str | None = None,
    instance_id: str | None = None,
    session_id: str | None = None,
    enabled_tools: list[str] | None = None,
    exclude: set[str] | None = None,
    run_uuid: str | None = None,
) -> str:
    """Compile and run one script. Returns the caller-facing result text; a
    failure comes back as an ``"Error: ..."`` string (never raises) so the tool
    loop's contract holds."""
    if _script_depth.get() >= MAX_SCRIPT_DEPTH:
        return (
            f"Error: 脚本嵌套过深（RunScript 最多嵌套 {MAX_SCRIPT_DEPTH} 层，本次为 {label}）"
            "——检查是否有自调用。"
        )

    try:
        validate_backend_source(source, label=label)
    except Exception as e:
        return f"Error: {e}"

    try:
        code = compile(source, _script_filename(label), "exec", ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
        tree = ast.parse(source)
    except SyntaxError as e:
        line = f"（第 {e.lineno} 行）" if e.lineno else ""
        return f"Error: 脚本 {label} 语法错误{line}: {e.msg}"

    ctx = ScriptContext(
        instance_dir,
        args or {},
        user_id=user_id,
        instance_id=instance_id,
        session_id=session_id,
        enabled_tools=enabled_tools,
        exclude=exclude,
        run_uuid=run_uuid,
        label=label,
    )
    ns: dict[str, Any] = {
        "__builtins__": safe_plugin_builtins(),
        "__name__": "__script__",
        "__file__": label,
        "t": ctx,
        "args": ctx.args,
        "print": ctx._print,
    }

    started = time.monotonic()
    token = _script_depth.set(_script_depth.get() + 1)
    returned: Any = None
    failed: BaseException | None = None
    try:
        # Top-level await makes eval return a coroutine; a purely-synchronous
        # body returns None. Either way the module body has fully run by here.
        result = eval(code, ns)  # noqa: S307 — source is AST-gated + builtins-stripped
        if inspect.isawaitable(result):
            await result
        entry = ns.get("run")
        # Auto-call the `run` entry point — unless the body already called it
        # itself (that would run it twice).
        if callable(entry) and not _module_body_calls_run(tree):
            entry_result = entry(ctx, ctx.args)
            returned = await entry_result if inspect.isawaitable(entry_result) else entry_result
    except asyncio.CancelledError:
        raise
    except BaseException as e:  # noqa: BLE001 — surfaced as text, never propagated
        failed = e
    finally:
        _script_depth.reset(token)

    # Collect now, not at function exit: a script that assigned an async call
    # without awaiting it (``x = t.run_tool(...)``) leaves the wrapper alive in
    # `ns`, so its ``[warn]`` would land after the output string was already
    # built — i.e. never reach the caller. Dropping `ns` here makes the warning
    # part of THIS result.
    ns.clear()
    gc.collect()
    out = ctx.output()

    if failed is not None:
        return _format_failure(failed, source, label, out)

    elapsed = time.monotonic() - started
    head = f"脚本 {label} 执行完成（{ctx._steps} 次工具调用，耗时 {elapsed:.1f}s）"
    parts = [head]
    if out.strip():
        parts.append("--- 输出 ---")
        parts.append(out.rstrip())
    if returned is not None:
        parts.append("--- 返回值 ---")
        parts.append(str(returned))
    if len(parts) == 1:
        parts.append("（脚本没有输出；如需回报结果，用 print(...) 或 return）")
    return "\n".join(parts)
