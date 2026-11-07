import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from werkzeug.security import generate_password_hash

DEFAULT_CATEGORIES = [
    "Alimentación", "Hospedaje", "Transporte", "Entretenimiento",
    "Compras", "Salud y emergencias", "Otros",
]


def connect(path):
    db = sqlite3.connect(path, timeout=15)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    db.execute("PRAGMA busy_timeout = 15000")
    return db


@contextmanager
def connection(path):
    db = connect(path)
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def initialize(path, initial_password=None):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with connect(path) as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                initial_budget INTEGER NOT NULL CHECK (initial_budget > 0),
                trip_start TEXT NOT NULL,
                trip_end TEXT NOT NULL,
                timezone TEXT NOT NULL DEFAULT 'America/Bogota',
                currency TEXT NOT NULL DEFAULT 'COP',
                password_hash TEXT
            );
            CREATE TABLE IF NOT EXISTS categories (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1))
            );
            CREATE TABLE IF NOT EXISTS expenses (
                id INTEGER PRIMARY KEY,
                expense_date TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                category_id INTEGER NOT NULL REFERENCES categories(id),
                amount INTEGER NOT NULL CHECK(amount > 0),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);
            CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category_id);
            CREATE TABLE IF NOT EXISTS login_attempts (
                ip TEXT PRIMARY KEY,
                failures INTEGER NOT NULL,
                window_start REAL NOT NULL,
                blocked_until REAL NOT NULL DEFAULT 0
            );
        """)
        row = db.execute("SELECT id FROM settings WHERE id = 1").fetchone()
        if row is None:
            if not initial_password or len(initial_password) < 12:
                raise RuntimeError("En la primera ejecución define ADMIN_PASSWORD con al menos 12 caracteres.")
            db.execute(
                "INSERT INTO settings(id, initial_budget, trip_start, trip_end, timezone, currency, password_hash) VALUES(1, 5000000, '2026-11-07', '2026-11-16', 'America/Bogota', 'COP', ?)",
                (generate_password_hash(initial_password),),
            )
            db.executemany("INSERT INTO categories(name) VALUES(?)", [(name,) for name in DEFAULT_CATEGORIES])
        elif db.execute("SELECT password_hash FROM settings WHERE id = 1").fetchone()["password_hash"] is None:
            if not initial_password or len(initial_password) < 12:
                raise RuntimeError("Define ADMIN_PASSWORD con al menos 12 caracteres para completar la configuración inicial.")
            db.execute("UPDATE settings SET password_hash = ? WHERE id = 1", (generate_password_hash(initial_password),))
