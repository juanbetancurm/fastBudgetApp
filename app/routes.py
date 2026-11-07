import re
from datetime import date, datetime, timezone

from flask import Blueprint, current_app, jsonify, request, session

from .budget import calculate_summary
from .database import connection

api = Blueprint("api", __name__, url_prefix="/api")


def db():
    return connection(current_app.config["DATABASE"])


def error(message, status=400):
    return jsonify(error=message), status


def payload():
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def amount_value(value):
    if isinstance(value, bool):
        raise ValueError
    if isinstance(value, int):
        amount = value
    elif isinstance(value, str) and re.fullmatch(r"[0-9]{1,12}", value.strip()):
        amount = int(value.strip())
    else:
        raise ValueError
    if amount < 1 or amount > 999_999_999_999:
        raise ValueError
    return amount


def validate_expense(data):
    try:
        expense_date = date.fromisoformat(str(data.get("date", "")))
        if expense_date.isoformat() != data.get("date"):
            raise ValueError
    except (ValueError, TypeError):
        raise ValueError("Escribe una fecha válida.")
    try:
        amount = amount_value(data.get("amount"))
    except ValueError:
        raise ValueError("El valor debe ser un número entero de pesos mayor que cero.")
    try:
        category_id = int(data.get("category_id"))
    except (TypeError, ValueError):
        raise ValueError("Elige una categoría.")
    description = str(data.get("description", "")).strip()
    if len(description) > 120:
        raise ValueError("La descripción no puede superar 120 caracteres.")
    return expense_date.isoformat(), description, category_id, amount


@api.get("/expenses")
def list_expenses():
    with db() as conn:
        rows = conn.execute("SELECT e.id, e.expense_date AS date, e.description, e.category_id, c.name AS category, e.amount FROM expenses e JOIN categories c ON c.id = e.category_id ORDER BY e.expense_date DESC, e.id DESC").fetchall()
        daily = conn.execute("SELECT expense_date AS date, SUM(amount) AS amount FROM expenses GROUP BY expense_date").fetchall()
    return jsonify(expenses=[dict(r) for r in rows], daily={r["date"]: r["amount"] for r in daily})


@api.post("/expenses")
def create_expense():
    data = payload()
    try:
        expense_date, description, category_id, amount = validate_expense(data)
    except ValueError as exc:
        return error(str(exc))
    now = datetime.now(timezone.utc).isoformat()
    with db() as conn:
        if not conn.execute("SELECT id FROM categories WHERE id = ? AND active = 1", (category_id,)).fetchone():
            return error("La categoría seleccionada ya no está disponible.")
        cursor = conn.execute("INSERT INTO expenses(expense_date, description, category_id, amount, created_at, updated_at) VALUES(?,?,?,?,?,?)", (expense_date, description, category_id, amount, now, now))
    return jsonify(id=cursor.lastrowid, message="Gasto guardado."), 201


@api.put("/expenses/<int:expense_id>")
def update_expense(expense_id):
    data = payload()
    try:
        expense_date, description, category_id, amount = validate_expense(data)
    except ValueError as exc:
        return error(str(exc))
    with db() as conn:
        if not conn.execute("SELECT id FROM categories WHERE id = ? AND active = 1", (category_id,)).fetchone():
            return error("La categoría seleccionada ya no está disponible.")
        cur = conn.execute("UPDATE expenses SET expense_date=?, description=?, category_id=?, amount=?, updated_at=? WHERE id=?", (expense_date, description, category_id, amount, datetime.now(timezone.utc).isoformat(), expense_id))
    return (jsonify(message="Gasto actualizado."), 200) if cur.rowcount else error("No encontramos ese gasto.", 404)


@api.delete("/expenses/<int:expense_id>")
def delete_expense(expense_id):
    with db() as conn:
        cur = conn.execute("DELETE FROM expenses WHERE id = ?", (expense_id,))
    return (jsonify(message="Gasto eliminado."), 200) if cur.rowcount else error("No encontramos ese gasto.", 404)


@api.get("/categories")
def list_categories():
    with db() as conn:
        rows = conn.execute("SELECT id, name FROM categories WHERE active=1 ORDER BY id").fetchall()
    return jsonify(categories=[dict(r) for r in rows])


@api.post("/categories")
def create_category():
    name = str(payload().get("name", "")).strip()
    if not name or len(name) > 40:
        return error("Escribe un nombre de categoría de hasta 40 caracteres.")
    with db() as conn:
        if any(row["name"].casefold() == name.casefold() for row in conn.execute("SELECT name FROM categories WHERE active=1")):
            return error("Ya existe una categoría con ese nombre.")
    try:
        with db() as conn:
            cur = conn.execute("INSERT INTO categories(name) VALUES(?)", (name,))
    except Exception as exc:
        if "UNIQUE" in str(exc):
            return error("Ya existe una categoría con ese nombre.")
        raise
    return jsonify(id=cur.lastrowid, name=name), 201


@api.put("/categories/<int:category_id>")
def rename_category(category_id):
    name = str(payload().get("name", "")).strip()
    if not name or len(name) > 40:
        return error("Escribe un nombre de categoría de hasta 40 caracteres.")
    with db() as conn:
        if any(row["name"].casefold() == name.casefold() for row in conn.execute("SELECT name FROM categories WHERE active=1 AND id<>?", (category_id,))):
            return error("Ya existe una categoría con ese nombre.")
    try:
        with db() as conn:
            cur = conn.execute("UPDATE categories SET name=? WHERE id=? AND active=1", (name, category_id))
    except Exception as exc:
        if "UNIQUE" in str(exc):
            return error("Ya existe una categoría con ese nombre.")
        raise
    return (jsonify(id=category_id, name=name), 200) if cur.rowcount else error("No encontramos esa categoría.", 404)


@api.get("/settings")
def get_settings():
    with db() as conn:
        row = conn.execute("SELECT initial_budget, trip_start, trip_end, timezone, currency FROM settings WHERE id=1").fetchone()
    return jsonify(dict(row))


@api.put("/settings")
def update_settings():
    data = payload()
    try:
        budget = amount_value(data.get("initial_budget"))
        start, end = date.fromisoformat(data.get("trip_start", "")), date.fromisoformat(data.get("trip_end", ""))
        if end < start or (end - start).days > 365:
            raise ValueError
    except (ValueError, TypeError):
        return error("Revisa el presupuesto y las fechas. El viaje debe durar entre 1 y 366 días.")
    with db() as conn:
        conn.execute("UPDATE settings SET initial_budget=?, trip_start=?, trip_end=? WHERE id=1", (budget, start.isoformat(), end.isoformat()))
    return get_settings()


@api.get("/summary")
def summary():
    with db() as conn:
        settings = conn.execute("SELECT * FROM settings WHERE id=1").fetchone()
        expenses = conn.execute("SELECT e.expense_date, e.amount, c.name AS category FROM expenses e JOIN categories c ON c.id=e.category_id").fetchall()
    return jsonify(calculate_summary(settings, expenses))


# --- Tasa EUR→COP informativa -------------------------------------------------
# Solo lectura y sin base de datos: consulta una fuente pública sin llave y guarda
# el resultado unos minutos en memoria. El navegador no puede consultarla directo
# por la política CSP (connect-src 'self'), por eso pasa por este endpoint.
FX_URL = "https://open.er-api.com/v6/latest/EUR"
FX_TTL_SECONDS = 6 * 60 * 60
_fx_cache = {"fetched": 0.0, "data": None}


def fetch_fx_rate():
    import json
    import time
    from email.utils import parsedate_to_datetime
    from urllib.request import Request, urlopen

    now = time.time()
    if _fx_cache["data"] and now - _fx_cache["fetched"] < FX_TTL_SECONDS:
        return _fx_cache["data"]
    request_ = Request(FX_URL, headers={"User-Agent": "presupuesto-viaje/1.0", "Accept": "application/json"})
    with urlopen(request_, timeout=6) as response:
        raw = json.loads(response.read(200_000))
    rate = float(raw["rates"]["COP"])
    if raw.get("result") != "success" or not 100 < rate < 100_000:
        raise ValueError("Tasa fuera de rango")
    updated = parsedate_to_datetime(raw["time_last_update_utc"]).astimezone(timezone.utc).isoformat()
    data = {"rate": rate, "updated": updated, "source": "ExchangeRate-API"}
    _fx_cache.update(fetched=now, data=data)
    return data


@api.get("/fx")
def fx():
    try:
        return jsonify(fetch_fx_rate())
    except Exception:
        return error("No pudimos consultar la tasa de cambio.", 502)
