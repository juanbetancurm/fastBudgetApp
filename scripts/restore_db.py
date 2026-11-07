#!/usr/bin/env python3
"""Restore a SQLite backup. Stop the application before running this command."""
import argparse
import os
from pathlib import Path

from app.database import connect


def restore(source, destination):
    source, destination = Path(source), Path(destination)
    if not source.is_file():
        raise SystemExit(f"No existe el respaldo: {source}")
    src, dst = connect(str(source)), connect(str(destination))
    try:
        result = src.execute("PRAGMA integrity_check").fetchone()[0]
        if result != "ok":
            raise SystemExit(f"El respaldo no pasó la verificación: {result}")
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    os.chmod(destination, 0o600)
    print(f"Base restaurada desde {source}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("backup")
    parser.add_argument("--database", default=os.environ.get("DATABASE_PATH", "/data/travel_budget.sqlite3"))
    args = parser.parse_args()
    restore(args.backup, args.database)
