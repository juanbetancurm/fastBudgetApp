import time

from werkzeug.security import check_password_hash

from .database import connection

MAX_FAILURES = 5
WINDOW_SECONDS = 15 * 60
BLOCK_SECONDS = 15 * 60


def verify_login(path, ip, password):
    now = time.time()
    with connection(path) as db:
        row = db.execute("SELECT failures, window_start, blocked_until FROM login_attempts WHERE ip = ?", (ip,)).fetchone()
        if row and row["blocked_until"] > now:
            return False, "Demasiados intentos. Espera unos minutos y vuelve a probar."
        settings = db.execute("SELECT password_hash FROM settings WHERE id = 1").fetchone()
        valid = bool(settings and check_password_hash(settings["password_hash"], password))
        if valid:
            db.execute("DELETE FROM login_attempts WHERE ip = ?", (ip,))
            return True, ""
        if row and now - row["window_start"] < WINDOW_SECONDS:
            failures, start = row["failures"] + 1, row["window_start"]
        else:
            failures, start = 1, now
        blocked = now + BLOCK_SECONDS if failures >= MAX_FAILURES else 0
        db.execute("INSERT OR REPLACE INTO login_attempts(ip, failures, window_start, blocked_until) VALUES(?,?,?,?)", (ip, failures, start, blocked))
        return False, "La contraseña no es correcta." if not blocked else "Demasiados intentos. Espera unos minutos y vuelve a probar."
