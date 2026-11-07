import os
import tempfile
import unittest
from datetime import date

from app import create_app
from app.budget import calculate_summary
from app.database import connection
from scripts.backup_db import backup


class TravelBudgetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.temp.name, "test.sqlite3")
        self.app = create_app({"TESTING": True, "SECRET_KEY": "test-secret", "DATABASE": self.path, "ADMIN_PASSWORD": "correct-horse-battery", "SESSION_COOKIE_SECURE": False})
        self.client = self.app.test_client()

    def tearDown(self):
        self.temp.cleanup()

    def login(self):
        self.client.get("/login")
        with self.client.session_transaction() as sess:
            token = sess["login_csrf"]
        response = self.client.post("/login", data={"csrf_token": token, "password": "correct-horse-battery"})
        self.assertEqual(response.status_code, 302)
        with self.client.session_transaction() as sess:
            self.csrf = sess["csrf_token"]

    def api(self, path, method="get", **kwargs):
        kwargs.setdefault("headers", {})["X-CSRF-Token"] = self.csrf
        return getattr(self.client, method)(path, **kwargs)

    def add_expense(self, amount=125000, day="2026-11-07", category_id=1, description="Almuerzo"):
        return self.api("/api/expenses", "post", json={"date": day, "description": description, "category_id": category_id, "amount": amount})

    def test_authentication_and_unauthorized_requests(self):
        self.assertEqual(self.client.get("/api/expenses").status_code, 401)
        self.assertEqual(self.client.get("/").status_code, 302)
        self.assertEqual(self.client.get("/health").json, {"status": "ok"})
        static_response = self.client.get("/static/css/app.css")
        self.assertEqual(static_response.status_code, 200)
        static_response.close()
        self.login()
        self.assertEqual(self.api("/api/expenses").status_code, 200)

    def test_login_rate_limit(self):
        self.client.get("/login")
        with self.client.session_transaction() as sess:
            token = sess["login_csrf"]
        for _ in range(5):
            response = self.client.post("/login", data={"csrf_token": token, "password": "incorrecta"})
            self.assertEqual(response.status_code, 401)
        blocked = self.client.post("/login", data={"csrf_token": token, "password": "correct-horse-battery"})
        self.assertEqual(blocked.status_code, 401)
        self.assertIn("Demasiados intentos", blocked.get_data(as_text=True))

    def test_crud_category_and_csrf(self):
        self.login()
        self.assertEqual(self.client.post("/api/expenses", json={"amount": 100}).status_code, 400)
        created = self.add_expense()
        self.assertEqual(created.status_code, 201)
        expense_id = created.json["id"]
        self.assertEqual(self.api("/api/expenses").json["expenses"][0]["category"], "Alimentación")
        updated = self.api(f"/api/expenses/{expense_id}", "put", json={"date": "2026-11-08", "description": "Cena", "category_id": 2, "amount": 220000})
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(self.api("/api/summary").json["total_spent"], 220000)
        self.assertEqual(self.api("/api/expenses/999", "delete").status_code, 404)
        renamed = self.api("/api/categories/2", "put", json={"name": "Alojamiento"})
        self.assertEqual(renamed.status_code, 200)
        self.assertEqual(self.api("/api/expenses").json["expenses"][0]["category"], "Alojamiento")
        self.assertEqual(self.api(f"/api/expenses/{expense_id}", "delete").status_code, 200)
        self.assertEqual(self.api("/api/summary").json["total_spent"], 0)

    def test_validation_and_budget_settings(self):
        self.login()
        self.assertEqual(self.add_expense(amount=0).status_code, 400)
        self.assertEqual(self.add_expense(amount="12.5").status_code, 400)
        self.assertEqual(self.add_expense(day="2026-02-30").status_code, 400)
        self.assertEqual(self.add_expense(category_id=999).status_code, 400)
        self.assertEqual(self.api("/api/expenses", "post", json=[]).status_code, 400)
        self.assertEqual(self.api("/api/settings", "put", json=[]).status_code, 400)
        settings = self.api("/api/settings", "put", json={"initial_budget": 3000000, "trip_start": "2026-11-07", "trip_end": "2026-11-16"})
        self.assertEqual(settings.status_code, 200)
        self.assertEqual(settings.json["initial_budget"], 3000000)
        self.add_expense(amount=3500000)
        summary = self.api("/api/summary").json
        self.assertEqual(summary["remaining"], -500000)
        self.assertEqual(summary["recommended_daily"], 0)
        self.assertTrue(summary["warning"])

    def test_summary_daily_category_and_remaining_days(self):
        self.login()
        self.add_expense(100000, "2026-11-07", 1, "Desayuno")
        self.add_expense(50000, "2026-11-07", 1, "Café")
        self.add_expense(75000, "2026-11-08", 2, "Bus")
        summary = self.api("/api/summary").json
        self.assertEqual(summary["total_spent"], 225000)
        self.assertEqual(summary["remaining"], 4775000)
        self.assertEqual(summary["trip_days"], 10)
        self.assertEqual(summary["original_daily"], 500000)
        self.assertEqual(summary["daily"][0]["amount"], 150000)
        self.assertEqual(sum(c["amount"] for c in summary["categories"]), summary["total_spent"])
        self.assertEqual(summary["top_category"], "Alimentación")
        row = {"initial_budget": 1000, "trip_start": "2026-11-07", "trip_end": "2026-11-16", "timezone": "America/Bogota"}
        self.assertEqual(calculate_summary(row, [], date(2026, 11, 7))["remaining_days"], 10)
        self.assertEqual(calculate_summary(row, [], date(2026, 11, 16))["remaining_days"], 1)
        self.assertEqual(calculate_summary(row, [], date(2026, 11, 17))["remaining_days"], 0)
        self.assertEqual(calculate_summary(row, [], date(2026, 11, 1))["recommended_daily"], 100)

    def test_database_survives_app_reinitialization(self):
        self.login()
        self.add_expense()
        app_again = create_app({"TESTING": True, "SECRET_KEY": "test-secret", "DATABASE": self.path, "SESSION_COOKIE_SECURE": False})
        client_again = app_again.test_client()
        with client_again.session_transaction() as sess:
            sess["authenticated"] = True
            sess["csrf_token"] = "second-token"
        response = client_again.get("/api/expenses")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json["expenses"]), 1)
        with connection(self.path) as conn:
            self.assertTrue(conn.execute("PRAGMA foreign_keys").fetchone()[0])
            self.assertNotEqual(conn.execute("SELECT password_hash FROM settings").fetchone()[0], "correct-horse-battery")

    def test_sqlite_online_backup_contains_expenses(self):
        self.login()
        self.add_expense()
        target = os.path.join(self.temp.name, "backup.sqlite3")
        backup(self.path, target)
        with connection(target) as conn:
            self.assertEqual(conn.execute("SELECT SUM(amount) FROM expenses").fetchone()[0], 125000)


if __name__ == "__main__":
    unittest.main()
