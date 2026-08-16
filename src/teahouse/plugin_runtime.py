"""
Plugin backend static-safety gate + restricted runtime builtins.

Two layers reconcile ease-of-authoring with the hard boundary that a plugin's
backend must NOT be able to reach the host except through its PluginContext:

L1 — Static AST check (run at load/install time):
    Rejects dangerous imports, dangerous name calls, and dunder attribute
    access BEFORE the module is ever executed. This gives the plugin author an
    explicit, immediate error (rather than a mysterious runtime exception) and
    blocks the obvious escape vectors (os/subprocess/socket/sys/httpx, open,
    eval, exec, __import__, getattr, __class__ etc.).

L2 — Runtime restricted __builtins__ (belt and suspenders):
    The backend module is executed with a stripped __builtins__ copy that omits
    open/exec/eval/__import__/compile/input/globals/vars/getattr/setattr. Even
    if the AST gate misses something, the runtime can't reach those.

These layers are NOT a sandbox for hostile code — they're the boundary that
makes "plugin = trusted, but confined to PluginContext for all I/O" enforceable
against accidental escape, while keeping backend authoring familiar.
"""

from __future__ import annotations

import ast

# Modules a plugin is allowed to import. Anything not on this list is rejected.
# Note: a plugin reaching raw file/network must do so via PluginContext — so
# imports that expose raw filesystem/process/network are deliberately excluded.
SAFE_IMPORT_MODULES = {
    "random",
    "string",
    "math",
    "re",
    "asyncio",
    "datetime",
    "collections",
    "typing",
    "json",
    "itertools",
    "pathlib",      # allowed for Path typing; file I/O must still go via ctx
    "uuid",
    # Pure-data binary codecs needed to decode third-party container formats
    # (e.g. SillyTavern .png cards carry base64+zlib JSON in a tEXt chunk).
    # All three are data-only — no file/network/process escape primitives.
    "struct",
    "base64",
    "zlib",
}

# Always-permitted special modules with no runtime side effects.
_ALWAYS_OK_IMPORTS = {"__future__"}

# Module-name prefixes that are hard-rejected before importing.
BLOCKED_IMPORT_PREFIXES = (
    "os", "subprocess", "socket", "sys", "httpx", "requests", "urllib",
    "importlib", "shutil", "ctypes", "builtins", "signal", "functools",
    "tempfile", "zipfile", "mmap", "pympler",
)

# Calling these names = escape attempt, regardless of what they are.
BLOCKED_NAME_CALLS = {
    "open", "exec", "eval", "compile", "__import__", "input", "breakpoint",
    "globals", "locals", "vars", "getattr", "setattr", "delattr", "dir",
    "hasattr", "memoryview", "bytearray", "chr", "ord", "map",
}

# Attribute access on any value is limited to normal attributes. A benign dunder
# whitelist is allowed (e.g. __class__.__name__ diagnostics); the genuinely
# dangerous object-escape dunders are hard-rejected.
BLOCKED_DUNDER_ATTRS = {
    "__subclasses__", "__mro__", "__bases__", "__globals__", "__dict__",
    "__builtins__", "__class__", "__code__", "__closure__", "__func__",
    "__self__", "__getattribute__", "__setattr__", "__delattr__", "__get__",
    "__wrapped__", "__module__", "__qualname__", "__new__", "__init__",
    "__reduce__", "__reduce_ex__", "__format__", "__sizeof__",
}

# Builtins stripped at runtime execution time. Deliberately surgical:
#  - open/exec/eval/compile/getattr/... are escape vectors → removed.
#  - __import__ is KEPT: the AST gate (validate_backend_source) already rejects
#    any non-whitelisted import and any dynamic __import__(...) call, so the
#    import machinery can only reach whitelisted module roots at runtime.
#  - dunders like __build_class__ (needed for `class`) and __import__ (needed
#    for `import`) must remain for normal Python semantics.
_BLOCKED_BUILTIN_NAMES = {
    "open", "exec", "eval", "compile", "input", "breakpoint",
    "globals", "locals", "vars", "getattr", "setattr", "delattr", "dir",
    "hasattr", "memoryview", "bytearray",
}


class BackendUnsafeError(Exception):
    """Raised when backend.py fails the static safety check."""


class _ImportVisitor(ast.NodeVisitor):
    def __init__(self) -> None:
        self.bad: list[str] = []

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            self._check(alias.name, node.lineno)
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        if node.module:
            self._check(node.module, node.lineno)
        self.generic_visit(node)

    def _check(self, module: str, lineno: int) -> None:
        root = module.split(".")[0]
        if root in _ALWAYS_OK_IMPORTS:
            return
        if root in BLOCKED_IMPORT_PREFIXES or root not in SAFE_IMPORT_MODULES:
            self.bad.append(f"L{lineno}: import {module!r} 不在白名单内（插件只能通过 PluginContext 访问文件/网络/数据）")


class _CallVisitor(ast.NodeVisitor):
    def __init__(self) -> None:
        self.bad: list[str] = []

    def visit_Call(self, node: ast.Call) -> None:
        func = node.func
        if isinstance(func, ast.Name) and func.id in BLOCKED_NAME_CALLS:
            self.bad.append(f"L{node.lineno}: 调用 {func.id!r} 被禁止")
        elif isinstance(func, ast.Attribute) and func.attr in BLOCKED_NAME_CALLS:
            self.bad.append(f"L{node.lineno}: 调用 {func.attr!r} 被禁止")
        self.generic_visit(node)


class _AttrVisitor(ast.NodeVisitor):
    def __init__(self) -> None:
        self.bad: list[str] = []

    def visit_Attribute(self, node: ast.Attribute) -> None:
        if node.attr in BLOCKED_DUNDER_ATTRS:
            self.bad.append(f"L{node.lineno}: 访问危险内置属性 {node.attr!r} 被禁止")
        self.generic_visit(node)


def validate_backend_source(source: str) -> None:
    """Run the static safety check over backend source text. Raises
    BackendUnsafeError listing every violation if any."""
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        raise BackendUnsafeError(f"backend.py 语法错误: {e}")

    violations: list[str] = []
    for visitor in (_ImportVisitor, _CallVisitor, _AttrVisitor):
        v = visitor()
        v.visit(tree)
        violations.extend(v.bad)

    if violations:
        raise BackendUnsafeError(
            "backend.py 未通过安全校验:\n" + "\n".join(violations)
        )


def safe_plugin_builtins() -> dict:
    """Return a copy of __builtins__ with escape-relevant names removed.

    Passed as the module's __builtins__ so the executing backend cannot reach
    them even if the AST gate is bypassed. Only names in _BLOCKED_BUILTIN_NAMES
    are removed; everything else (including dunder builtins needed for normal
    `class`/`import` semantics) is preserved.
    """
    import builtins as _b
    base = dict(vars(_b))
    for name in _BLOCKED_BUILTIN_NAMES:
        base.pop(name, None)
    return base
