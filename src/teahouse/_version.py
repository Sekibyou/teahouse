import re
import sys
from pathlib import Path

__all__ = ["__version__"]


def _resolve() -> str:
    """版本解析分两态：

    - 冻结态（PyInstaller）：读打包时 build_release 注入的 _version_inject.py 常量，
      发布包不含 pyproject.toml，故运行时不读 toml。
    - 源码态：实时读 pyproject.toml 的 version（唯一权威，改即生效）。
    """
    if getattr(sys, "frozen", False):
        from . import _version_inject
        return _version_inject.__version__
    root = Path(__file__).resolve().parents[2]
    try:
        text = (root / "pyproject.toml").read_text(encoding="utf-8")
    except OSError:
        return "0.0.0"
    m = re.search(r'^version\s*=\s*"([^"]+)"', text, re.MULTILINE)
    return m.group(1) if m else "0.0.0"


__version__ = _resolve()
