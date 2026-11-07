#!/usr/bin/env python3
"""Create an online, transaction-consistent SQLite backup."""
import argparse
import os
from datetime import datetime
from pathlib import Path

from app.database import connect


def backup(source, destination):
    source, destination = Path(source), Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    src, dst = connect(str(source)), connect(str(destination))
    try:
        src.backup(dst)
        result = dst.execute("PRAGMA integrity_check").fetchone()[0]
        if result != "ok":
            raise RuntimeError(f"La copia no pasó la verificación: {result}")
    finally:
        dst.close()
        src.close()
    os.chmod(destination, 0o600)
    return destination


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", nargs="?", help="Ruta de destino (por defecto /data/backups/fecha.sqlite3)")
    args = parser.parse_args()
    target = args.destination or f"/data/backups/presupuesto-{datetime.now().strftime('%Y%m%d-%H%M%S')}.sqlite3"
    print(backup(os.environ.get("DATABASE_PATH", "/data/travel_budget.sqlite3"), target))
