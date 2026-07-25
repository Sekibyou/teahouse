"""
Director system prompt assembler.

Assembles the Director's system prompt from:
1. Template files in director-system/ (role.md, behavior.md, tools.md, ...)
2. The instance's teahouse.md

All template content lives in markdown files, not in Python code.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Template directory — path relative to this file
# ---------------------------------------------------------------------------

TEMPLATE_DIR = Path(__file__).resolve().parent / "director-system"

# Load order: files are concatenated in this order
TEMPLATE_FILES = [
    "role.md",
    "behavior.md",
    "tools.md",
]

INSTANCE_TEAHOUSE = "teahouse.md"


def assemble_system_prompt(instance_dir: Path) -> str:
    """Assemble the full system prompt for the Director.

    Reads template files from director-system/ in order,
    then appends the instance's own teahouse.md.
    """
    parts: list[str] = []

    # 1. Template parts
    for filename in TEMPLATE_FILES:
        filepath = TEMPLATE_DIR / filename
        if filepath.exists():
            parts.append(filepath.read_text(encoding="utf-8").strip())

    # 2. Instance teahouse.md
    teahouse_path = instance_dir / INSTANCE_TEAHOUSE
    if teahouse_path.exists():
        parts.append(teahouse_path.read_text(encoding="utf-8").strip())

    return "\n\n".join(parts)
