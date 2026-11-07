#!/usr/bin/env python3
"""Import validated expense rows from the workbook's Registro de gastos sheet."""
import argparse
import hashlib
from datetime import date, datetime

from openpyxl import load_workbook

from app.database import connection

CATEGORY_ALIASES = {
    "entretenimiento y disfrute": "Entretenimiento",
    "otros gastos": "Otros",
}


def fingerprint(day, description, category, amount):
    raw = f"{day}\0{description.strip().casefold()}\0{category.strip().casefold()}\0{int(amount)}"
    return hashlib.sha256(raw.encode()).hexdigest()


def import_workbook(workbook_path, database_path):
    book = load_workbook(workbook_path, read_only=True, data_only=True, keep_vba=False)
    if "Registro de gastos" not in book.sheetnames:
        raise SystemExit("No se encontró la hoja «Registro de gastos».")
    sheet = book["Registro de gastos"]
    imported = skipped = 0
    with connection(database_path) as db:
        settings = db.execute("SELECT trip_start, trip_end FROM settings WHERE id=1").fetchone()
        categories = {row["name"].casefold(): row["id"] for row in db.execute("SELECT id,name FROM categories")}
        existing = {fingerprint(row[0], row[1], row[3], row[2]) for row in db.execute("SELECT e.expense_date,e.description,e.amount,c.name FROM expenses e JOIN categories c ON c.id=e.category_id")}
        for values in sheet.iter_rows(min_row=7, values_only=True):
            row = list(values) + [None] * 5
            raw_date, description, category, _, amount = row[:5]
            if not any((raw_date, description, category, amount)):
                continue
            if isinstance(raw_date, datetime):
                expense_date = raw_date.date()
            elif isinstance(raw_date, date):
                expense_date = raw_date
            else:
                skipped += 1
                continue
            description, category = str(description or "").strip(), str(category or "").strip()
            category = CATEGORY_ALIASES.get(category.casefold(), category)
            if not category or not isinstance(amount, (int, float)) or isinstance(amount, bool) or amount <= 0 or int(amount) != amount:
                skipped += 1
                continue
            day = expense_date.isoformat()
            if not settings["trip_start"] <= day <= settings["trip_end"] or len(description) > 120:
                skipped += 1
                continue
            key = category.casefold()
            if key not in categories:
                categories[key] = db.execute("INSERT INTO categories(name) VALUES(?)", (category,)).lastrowid
            amount = int(amount)
            digest = fingerprint(day, description, category, amount)
            if digest in existing:
                skipped += 1
                continue
            stamp = datetime.utcnow().isoformat() + "Z"
            db.execute("INSERT INTO expenses(expense_date,description,category_id,amount,created_at,updated_at) VALUES(?,?,?,?,?,?)", (day, description, categories[key], amount, stamp, stamp))
            existing.add(digest)
            imported += 1
    book.close()
    return imported, skipped


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workbook")
    parser.add_argument("--database", default="/data/travel_budget.sqlite3")
    args = parser.parse_args()
    result = import_workbook(args.workbook, args.database)
    print(f"Importados: {result[0]} · Omitidos o repetidos: {result[1]}")
