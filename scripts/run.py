"""List or run project tasks: python scripts/run.py --help."""

from __future__ import annotations

import runpy
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts._commands import ALIASES, COMMANDS, resolve_command


def print_help():
    print("Cách dùng: python scripts/run.py <tác-vụ> [tham-số]")
    for title, names in (
        ("Data v2 — VieSign đang dùng", [n for n in COMMANDS if n.startswith("viesign-")]),
        ("Chạy ứng dụng", ["serve-api"]),
        ("Data v1 — ASL cũ", [n for n in COMMANDS if n.startswith("asl-")]),
    ):
        print(f"\n{title}:")
        for name in names:
            print(f"  {name:27} {COMMANDS[name][1]}")
    print("\nVí dụ: python scripts/run.py viesign-original --plan")
    print("Chi tiết thư mục và các lệnh cũ: scripts/README.md")


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = sys.argv[1:]
    if not args or args[0] in {"-h", "--help", "list"}:
        print_help()
        return
    name = ALIASES.get(args[0], args[0])
    try:
        script, description = resolve_command(name)
    except KeyError:
        raise SystemExit(f"Không có tác vụ '{args[0]}'. Xem: python scripts/run.py --help")
    # Several old ASL utilities perform writes/API calls at module scope and
    # do not implement argparse. Their help must never execute those operations.
    if name.startswith("asl-") and any(arg in {"-h", "--help"} for arg in args[1:]):
        print(f"{name}: {description}\nFile: {script}\nNhóm: data_v1_asl (pipeline cũ).")
        return
    sys.argv = [str(ROOT / script), *args[1:]]
    runpy.run_module(script.removesuffix(".py").replace("/", "."), run_name="__main__")


if __name__ == "__main__":
    main()
