import os
from pathlib import Path

from flask import Flask, jsonify, redirect, render_template, request, session, url_for
from werkzeug.middleware.proxy_fix import ProxyFix

from .database import connection, initialize
from .routes import api


def create_app(test_config=None):
    app = Flask(__name__)
    app.config.update(
        SECRET_KEY=os.environ.get("SECRET_KEY"),
        DATABASE=os.environ.get("DATABASE_PATH", "/data/travel_budget.sqlite3"),
        ADMIN_PASSWORD=os.environ.get("ADMIN_PASSWORD"),
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=os.environ.get("COOKIE_SECURE", "true").lower() == "true",
        PERMANENT_SESSION_LIFETIME=60 * 60 * 12,
        MAX_CONTENT_LENGTH=1024 * 1024,
        TESTING=False,
    )
    if test_config:
        app.config.update(test_config)
    if not app.config.get("SECRET_KEY"):
        if app.config["TESTING"]:
            app.config["SECRET_KEY"] = "test-only-secret"
        else:
            raise RuntimeError("Configura SECRET_KEY en el entorno antes de iniciar la aplicación.")

    if os.environ.get("TRUST_PROXY", "false").lower() == "true" and not app.config["TESTING"]:
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

    Path(app.config["DATABASE"]).parent.mkdir(parents=True, exist_ok=True)
    initialize(app.config["DATABASE"], app.config.get("ADMIN_PASSWORD"))
    app.register_blueprint(api)

    @app.before_request
    def protect_all_but_login_and_health():
        if request.endpoint in {"login", "health", "static"} or request.endpoint is None:
            return None
        if not session.get("authenticated"):
            if request.path.startswith("/api/"):
                return jsonify(error="Debes iniciar sesión."), 401
            return redirect(url_for("login"))
        if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
            sent = request.headers.get("X-CSRF-Token") or request.form.get("csrf_token")
            if not sent or sent != session.get("csrf_token"):
                return jsonify(error="La sesión venció. Actualiza la página e inténtalo de nuevo."), 400
        return None

    @app.get("/health")
    def health():
        try:
            with connection(app.config["DATABASE"]) as db:
                db.execute("SELECT 1")
            return jsonify(status="ok")
        except Exception:
            return jsonify(status="error"), 503

    @app.after_request
    def security_headers(response):
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'")
        return response

    @app.route("/login", methods=["GET", "POST"])
    def login():
        if session.get("authenticated"):
            return redirect(url_for("index"))
        if request.method == "GET":
            return render_template("login.html", csrf_token=session.setdefault("login_csrf", os.urandom(24).hex()))
        csrf = request.form.get("csrf_token", "")
        if not csrf or csrf != session.get("login_csrf"):
            return render_template("login.html", error="La página venció. Vuelve a intentarlo.", csrf_token=session.setdefault("login_csrf", os.urandom(24).hex())), 400
        from .auth import verify_login
        allowed, message = verify_login(app.config["DATABASE"], request.remote_addr or "unknown", request.form.get("password", ""))
        if not allowed:
            return render_template("login.html", error=message, csrf_token=session["login_csrf"]), 401
        session.clear()
        session.permanent = True
        session["authenticated"] = True
        session["csrf_token"] = os.urandom(32).hex()
        return redirect(url_for("index"))

    @app.post("/logout")
    def logout():
        session.clear()
        return redirect(url_for("login"))

    @app.get("/")
    def index():
        if not session.get("authenticated"):
            return redirect(url_for("login"))
        return render_template("index.html", csrf_token=session["csrf_token"])

    return app
