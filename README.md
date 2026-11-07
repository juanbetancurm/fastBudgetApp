# Presupuesto de viaje

Aplicación privada para registrar gastos, consultar el saldo y ver resúmenes por categoría y día. Interfaz en español, Flask, SQLite y Chart.js local.

## Arranque local

Requiere Python 3.12 o posterior. En PowerShell:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:SECRET_KEY = py -c "import secrets; print(secrets.token_urlsafe(48))"
$env:COOKIE_SECURE = "false"
$env:ADMIN_PASSWORD = Read-Host "Define una contraseña inicial de al menos 12 caracteres"
$env:DATABASE_PATH = "$PWD\travel_budget.sqlite3"
py -m flask --app wsgi run
```

Abre `http://127.0.0.1:5000`. En la primera ejecución, el presupuesto es $5.000.000 COP y las fechas son 07/11/2026 a 16/11/2026. La contraseña se guarda como hash; la base local queda en `travel_budget.sqlite3`.

## Despliegue en VPS con Docker

La instalación verificada para esta VPS usa el proxy Nginx existente en Docker y la red externa `web`. El servicio de la aplicación no publica puertos en el host; Nginx lo alcanza por el alias privado `viaje-budget:8000`.

Desde el directorio del proyecto en el VPS:

```bash
cp .env.example .env
APP_SECRET="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
APP_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
printf 'SECRET_KEY=%s\nADMIN_PASSWORD=%s\n' "$APP_SECRET" "$APP_PASSWORD" > .env
chmod 600 .env
printf 'Guarda esta contraseña para iniciar sesión: %s\n' "$APP_PASSWORD"
docker compose build
docker compose up -d
docker compose logs --tail=100 app
docker compose exec -T app python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/health').read().decode())"
```

Conserva la contraseña en un gestor seguro. `.env` no debe compartirse ni añadirse a Git. El contenedor ejecuta Gunicorn como usuario sin privilegios y guarda SQLite en el volumen `fastbudgetapp_travel-budget-data`.

### DNS, Nginx y HTTPS

1. El dominio ya resuelve a direcciones de Cloudflare; el DNS público no revela el origen cuando el proxy está habilitado. No cambies sus registros durante el despliegue.
2. Tras verificar que el certificado de origen cubre `viaje.labolavs.com`, agrega [`nginx/viaje.labolavs.com.conf`](nginx/viaje.labolavs.com.conf) al archivo montado `/home/olav/anglemaze-platform/proxy/nginx.conf`. Conserva todas las rutas existentes.
3. Valida la configuración dentro del contenedor Nginx antes de recargarlo. Coordina la recarga del proxy porque sirve los otros sitios del VPS.
4. Comprueba `https://viaje.labolavs.com/health`. La app usa cookies seguras y recibe el esquema HTTPS por el proxy.

La aplicación no publica ningún puerto en el host. Solo los contenedores conectados a la red Docker compartida `web` pueden alcanzar el upstream.

### Copias de seguridad y recuperación

La copia usa la API de backup de SQLite, funciona con la aplicación activa y queda dentro del volumen persistente:

```bash
docker compose exec -T app python scripts/backup_db.py
docker compose exec -T app python scripts/backup_db.py /data/backups/antes-de-actualizar.sqlite3
```

Para restaurar, detén la aplicación:

```bash
docker compose stop app
docker compose run --rm app python scripts/restore_db.py /data/backups/presupuesto-AAAAMMDD-HHMMSS.sqlite3
docker compose up -d app
```

Descarga también copias fuera de la VPS según tu política de respaldo. El archivo contiene movimientos financieros y el hash de acceso; no lo publiques.

### Actualizar sin perder gastos

```bash
docker compose exec -T app python scripts/backup_db.py
docker compose build app
docker compose up -d app
docker compose logs --tail=100 app
docker compose exec -T app python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/health').read().decode())"
```

Sincroniza primero el código actualizado con el método que uses para llevar archivos a la VPS. El volumen sobrevive a recreaciones e imágenes nuevas. No uses `docker compose down -v`, porque elimina el volumen de datos.

## Importar el Excel opcional

Se inspeccionó `Presupuesto_de_viaje.xlsm`: la única fila escrita en el registro está marcada «EJEMPLO» y no se importó. El presupuesto y las fechas coinciden con la configuración inicial. Cuando añadas movimientos reales, conserva una copia del libro y ejecuta:

```bash
docker compose cp Presupuesto_de_viaje.xlsm app:/tmp/presupuesto.xlsm
docker compose exec -T app python scripts/import_excel.py /tmp/presupuesto.xlsm
```

El importador valida fechas, categorías y pesos enteros, omite filas inválidas o fuera del viaje y evita reimportar movimientos idénticos. Normaliza las etiquetas antiguas «Entretenimiento y disfrute» y «Otros gastos» a las categorías iniciales más simples. No ejecuta macros ni fórmulas.

## Pruebas

```bash
python -m unittest discover -s tests -v
```

## Guía rápida

1. Inicia sesión con la contraseña inicial configurada.
2. En **Gastos**, elige fecha y categoría, escribe el valor en pesos sin puntos y pulsa **Guardar gasto**.
3. El saldo actualizado aparece arriba.
4. Abre **Resumen** para ver las gráficas por categoría y día.
5. Pulsa **Configuración** para cambiar presupuesto, fechas o categorías.
