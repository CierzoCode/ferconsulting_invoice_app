from __future__ import annotations

import csv
import io
import math
import os
import random
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from flask import Flask, Response, jsonify, render_template, request

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)
DB_PATH = Path(os.environ.get("ATOMIZADOR_DB", DATA_DIR / "atomizador.db"))
API_KEY = os.environ.get("ATOMIZADOR_API_KEY", "").strip()

app = Flask(__name__)
app.config["JSON_SORT_KEYS"] = False

DEFAULT_SETTINGS = {
    "work_width_m": 8.0,
    "target_l_ha": 300.0,
    "target_pressure_bar": 10.0,
    "pressure_tolerance_bar": 1.5,
    "pressure_difference_alarm_bar": 2.0,
    "tank_capacity_l": 600.0,
    "min_work_speed_kmh": 0.8,
    "min_work_flow_l_min": 0.5,
}


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_utc(value: datetime | None = None) -> str:
    value = value or utc_now()
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_timestamp(value: Any) -> datetime:
    if not value:
        return utc_now()
    try:
        text = str(value).strip().replace("Z", "+00:00")
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except (ValueError, TypeError):
        return utc_now()


def numeric(value: Any, default: float = 0.0, minimum: float | None = None, maximum: float | None = None) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        result = default
    if not math.isfinite(result):
        result = default
    if minimum is not None:
        result = max(minimum, result)
    if maximum is not None:
        result = min(maximum, result)
    return result


@contextmanager
def db_connection():
    connection = sqlite3.connect(DB_PATH, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def init_db() -> None:
    with db_connection() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                work_width_m REAL NOT NULL,
                target_l_ha REAL NOT NULL,
                target_pressure_bar REAL NOT NULL,
                pressure_tolerance_bar REAL NOT NULL,
                pressure_difference_alarm_bar REAL NOT NULL,
                tank_capacity_l REAL NOT NULL,
                min_work_speed_kmh REAL NOT NULL,
                min_work_flow_l_min REAL NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                parcel TEXT NOT NULL,
                product TEXT NOT NULL,
                operator TEXT NOT NULL,
                started_at TEXT NOT NULL,
                ended_at TEXT,
                status TEXT NOT NULL DEFAULT 'active',
                work_width_m REAL NOT NULL,
                target_l_ha REAL NOT NULL,
                target_pressure_bar REAL NOT NULL,
                tank_initial_l REAL NOT NULL,
                liters_applied REAL NOT NULL DEFAULT 0,
                area_ha REAL NOT NULL DEFAULT 0,
                distance_m REAL NOT NULL DEFAULT 0,
                work_seconds REAL NOT NULL DEFAULT 0,
                last_sample_at TEXT,
                last_lat REAL,
                last_lon REAL
            );

            CREATE TABLE IF NOT EXISTS telemetry (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL,
                timestamp TEXT NOT NULL,
                pressure_1_bar REAL NOT NULL,
                pressure_2_bar REAL,
                flow_l_min REAL NOT NULL,
                speed_kmh REAL NOT NULL,
                latitude REAL,
                longitude REAL,
                l_ha REAL,
                liters_delta REAL NOT NULL,
                area_delta_ha REAL NOT NULL,
                distance_delta_m REAL NOT NULL,
                is_working INTEGER NOT NULL,
                source TEXT NOT NULL DEFAULT 'sensor',
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_telemetry_session_time
                ON telemetry(session_id, timestamp DESC);

            CREATE TABLE IF NOT EXISTS device_location (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                timestamp TEXT NOT NULL,
                latitude REAL NOT NULL,
                longitude REAL NOT NULL,
                speed_kmh REAL NOT NULL,
                accuracy_m REAL
            );

            CREATE TABLE IF NOT EXISTS sprayer_control (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                left_enabled INTEGER NOT NULL DEFAULT 0,
                right_enabled INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL
            );
            """
        )
        existing = db.execute("SELECT id FROM settings WHERE id = 1").fetchone()
        if not existing:
            db.execute(
                """
                INSERT INTO settings (
                    id, work_width_m, target_l_ha, target_pressure_bar,
                    pressure_tolerance_bar, pressure_difference_alarm_bar,
                    tank_capacity_l, min_work_speed_kmh, min_work_flow_l_min, updated_at
                ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    DEFAULT_SETTINGS["work_width_m"],
                    DEFAULT_SETTINGS["target_l_ha"],
                    DEFAULT_SETTINGS["target_pressure_bar"],
                    DEFAULT_SETTINGS["pressure_tolerance_bar"],
                    DEFAULT_SETTINGS["pressure_difference_alarm_bar"],
                    DEFAULT_SETTINGS["tank_capacity_l"],
                    DEFAULT_SETTINGS["min_work_speed_kmh"],
                    DEFAULT_SETTINGS["min_work_flow_l_min"],
                    iso_utc(),
                ),
            )
        db.execute(
            "INSERT OR IGNORE INTO sprayer_control (id, left_enabled, right_enabled, updated_at) VALUES (1, 0, 0, ?)",
            (iso_utc(),),
        )


def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row else None


def get_settings(db: sqlite3.Connection) -> dict[str, Any]:
    row = db.execute("SELECT * FROM settings WHERE id = 1").fetchone()
    return row_to_dict(row) or DEFAULT_SETTINGS.copy()


def get_active_session(db: sqlite3.Connection) -> sqlite3.Row | None:
    return db.execute(
        "SELECT * FROM sessions WHERE status = 'active' ORDER BY id DESC LIMIT 1"
    ).fetchone()


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius = 6_371_000.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return radius * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def verify_api_key() -> Response | None:
    if not API_KEY:
        return None
    provided = request.headers.get("X-API-Key", "")
    if provided != API_KEY:
        return jsonify({"ok": False, "error": "API key no válida"}), 401
    return None


def build_alarms(current: dict[str, Any] | None, session: dict[str, Any] | None, settings: dict[str, Any]) -> list[dict[str, str]]:
    alarms: list[dict[str, str]] = []
    if not current or not session:
        return alarms

    p1 = numeric(current.get("pressure_1_bar"))
    p2_raw = current.get("pressure_2_bar")
    p2 = numeric(p2_raw) if p2_raw is not None else None
    target = numeric(session.get("target_pressure_bar"), settings["target_pressure_bar"])
    tolerance = numeric(settings.get("pressure_tolerance_bar"), 1.5)

    if current.get("is_working") and abs(p1 - target) > tolerance:
        alarms.append({
            "level": "warning",
            "message": f"Presión 1 fuera de objetivo: {p1:.1f} bar (objetivo {target:.1f})",
        })
    if p2 is not None and current.get("is_working") and abs(p1 - p2) > numeric(settings.get("pressure_difference_alarm_bar"), 2.0):
        alarms.append({
            "level": "danger",
            "message": f"Diferencia elevada entre ramales: {abs(p1 - p2):.1f} bar",
        })
    if numeric(current.get("flow_l_min")) > settings["min_work_flow_l_min"] and numeric(current.get("speed_kmh")) < settings["min_work_speed_kmh"]:
        alarms.append({
            "level": "danger",
            "message": "Hay caudal con el vehículo prácticamente parado",
        })

    remaining = numeric(session.get("tank_initial_l")) - numeric(session.get("liters_applied"))
    if session.get("tank_initial_l", 0) and remaining <= session["tank_initial_l"] * 0.1:
        alarms.append({
            "level": "warning",
            "message": f"Depósito bajo: quedan aproximadamente {max(0, remaining):.0f} L",
        })
    return alarms


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/simulador")
def simulator():
    """Simulador interactivo de una placa ESP32 con WiFi y sensores."""
    return render_template("simulator.html")


@app.get("/api/status")
def api_status():
    with db_connection() as db:
        settings = get_settings(db)
        session_row = get_active_session(db)
        session = row_to_dict(session_row)
        current = None
        recent: list[dict[str, Any]] = []
        if session:
            current_row = db.execute(
                "SELECT * FROM telemetry WHERE session_id = ? ORDER BY id DESC LIMIT 1",
                (session["id"],),
            ).fetchone()
            current = row_to_dict(current_row)
            recent_rows = db.execute(
                """
                SELECT timestamp, pressure_1_bar, pressure_2_bar, flow_l_min,
                       speed_kmh, latitude, longitude, l_ha, is_working
                FROM telemetry
                WHERE session_id = ?
                ORDER BY id DESC LIMIT 120
                """,
                (session["id"],),
            ).fetchall()
            recent = [dict(row) for row in reversed(recent_rows)]

        alarms = build_alarms(current, session, settings)
        if session:
            session["tank_remaining_l"] = max(0.0, session["tank_initial_l"] - session["liters_applied"])
            session["average_l_ha"] = (
                session["liters_applied"] / session["area_ha"] if session["area_ha"] > 0.0001 else None
            )

        device_location = row_to_dict(db.execute(
            "SELECT * FROM device_location WHERE id = 1"
        ).fetchone())
        if device_location:
            age = (utc_now() - parse_timestamp(device_location["timestamp"])).total_seconds()
            device_location["active"] = 0 <= age <= 10
            device_location["age_seconds"] = max(0, round(age, 1))
        control = row_to_dict(db.execute("SELECT * FROM sprayer_control WHERE id = 1").fetchone())
        if control:
            control["left_enabled"] = bool(control["left_enabled"])
            control["right_enabled"] = bool(control["right_enabled"])

        return jsonify({
            "ok": True,
            "server_time": iso_utc(),
            "settings": settings,
            "session": session,
            "current": current,
            "recent": recent,
            "alarms": alarms,
            "device_location": device_location,
            "control": control,
        })


@app.route("/api/control", methods=["GET", "POST"])
def api_control():
    with db_connection() as db:
        if request.method == "POST":
            payload = request.get_json(silent=True) or {}
            current = db.execute("SELECT * FROM sprayer_control WHERE id = 1").fetchone()
            left = bool(payload.get("left_enabled", current["left_enabled"]))
            right = bool(payload.get("right_enabled", current["right_enabled"]))
            db.execute(
                "UPDATE sprayer_control SET left_enabled = ?, right_enabled = ?, updated_at = ? WHERE id = 1",
                (int(left), int(right), iso_utc()),
            )
        row = db.execute("SELECT * FROM sprayer_control WHERE id = 1").fetchone()
        return jsonify({
            "ok": True,
            "left_enabled": bool(row["left_enabled"]),
            "right_enabled": bool(row["right_enabled"]),
            "updated_at": row["updated_at"],
        })


@app.post("/api/device-location")
def api_device_location():
    """Receive GPS data from the phone/tablet displaying the application."""
    payload = request.get_json(silent=True) or {}
    lat_raw = payload.get("latitude")
    lon_raw = payload.get("longitude")
    if lat_raw in (None, "") or lon_raw in (None, ""):
        return jsonify({"ok": False, "error": "Faltan latitud o longitud"}), 400

    lat = numeric(lat_raw, 0.0, -90.0, 90.0)
    lon = numeric(lon_raw, 0.0, -180.0, 180.0)
    speed = numeric(payload.get("speed_kmh"), 0.0, 0.0, 100.0)
    accuracy_raw = payload.get("accuracy_m")
    accuracy = numeric(accuracy_raw, 0.0, 0.0, 10_000.0) if accuracy_raw not in (None, "") else None
    timestamp = iso_utc()
    with db_connection() as db:
        db.execute(
            """
            INSERT INTO device_location (id, timestamp, latitude, longitude, speed_kmh, accuracy_m)
            VALUES (1, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET timestamp = excluded.timestamp,
                latitude = excluded.latitude, longitude = excluded.longitude,
                speed_kmh = excluded.speed_kmh, accuracy_m = excluded.accuracy_m
            """,
            (timestamp, lat, lon, speed, accuracy),
        )
    return jsonify({"ok": True})


@app.post("/api/config")
def api_config():
    payload = request.get_json(silent=True) or {}
    values = {
        "work_width_m": numeric(payload.get("work_width_m"), 8.0, 0.1, 100.0),
        "target_l_ha": numeric(payload.get("target_l_ha"), 300.0, 1.0, 5000.0),
        "target_pressure_bar": numeric(payload.get("target_pressure_bar"), 10.0, 0.0, 100.0),
        "pressure_tolerance_bar": numeric(payload.get("pressure_tolerance_bar"), 1.5, 0.1, 30.0),
        "pressure_difference_alarm_bar": numeric(payload.get("pressure_difference_alarm_bar"), 2.0, 0.1, 30.0),
        "tank_capacity_l": numeric(payload.get("tank_capacity_l"), 600.0, 1.0, 10000.0),
        "min_work_speed_kmh": numeric(payload.get("min_work_speed_kmh"), 0.8, 0.0, 20.0),
        "min_work_flow_l_min": numeric(payload.get("min_work_flow_l_min"), 0.5, 0.0, 500.0),
    }
    with db_connection() as db:
        db.execute(
            """
            UPDATE settings SET
                work_width_m = ?, target_l_ha = ?, target_pressure_bar = ?,
                pressure_tolerance_bar = ?, pressure_difference_alarm_bar = ?,
                tank_capacity_l = ?, min_work_speed_kmh = ?, min_work_flow_l_min = ?,
                updated_at = ?
            WHERE id = 1
            """,
            (
                values["work_width_m"], values["target_l_ha"], values["target_pressure_bar"],
                values["pressure_tolerance_bar"], values["pressure_difference_alarm_bar"],
                values["tank_capacity_l"], values["min_work_speed_kmh"],
                values["min_work_flow_l_min"], iso_utc(),
            ),
        )
    return jsonify({"ok": True, "settings": values})


@app.post("/api/session/start")
def api_session_start():
    payload = request.get_json(silent=True) or {}
    with db_connection() as db:
        current = get_active_session(db)
        if current:
            return jsonify({"ok": False, "error": "Ya hay un tratamiento activo"}), 409
        settings = get_settings(db)
        tank_initial_l = numeric(payload.get("tank_initial_l"), settings["tank_capacity_l"], 0.0, 10000.0)
        cursor = db.execute(
            """
            INSERT INTO sessions (
                parcel, product, operator, started_at, status,
                work_width_m, target_l_ha, target_pressure_bar, tank_initial_l
            ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
            """,
            (
                str(payload.get("parcel") or "Parcela sin nombre").strip()[:120],
                str(payload.get("product") or "Sin especificar").strip()[:120],
                str(payload.get("operator") or "Sin especificar").strip()[:120],
                iso_utc(),
                numeric(payload.get("work_width_m"), settings["work_width_m"], 0.1, 100.0),
                numeric(payload.get("target_l_ha"), settings["target_l_ha"], 1.0, 5000.0),
                numeric(payload.get("target_pressure_bar"), settings["target_pressure_bar"], 0.0, 100.0),
                tank_initial_l,
            ),
        )
        session_id = cursor.lastrowid
    return jsonify({"ok": True, "session_id": session_id})


@app.post("/api/session/stop")
def api_session_stop():
    with db_connection() as db:
        current = get_active_session(db)
        if not current:
            return jsonify({"ok": False, "error": "No hay un tratamiento activo"}), 404
        db.execute(
            "UPDATE sessions SET status = 'completed', ended_at = ? WHERE id = ?",
            (iso_utc(), current["id"]),
        )
        db.execute(
            "UPDATE sprayer_control SET left_enabled = 0, right_enabled = 0, updated_at = ? WHERE id = 1",
            (iso_utc(),),
        )
    return jsonify({"ok": True})


@app.post("/api/session/tank")
def api_session_tank():
    payload = request.get_json(silent=True) or {}
    if payload.get("remaining_l") in (None, ""):
        return jsonify({"ok": False, "error": "Indica los litros actuales del depósito"}), 400
    remaining_l = numeric(payload.get("remaining_l"), 0.0, 0.0, 10_000.0)
    with db_connection() as db:
        session = get_active_session(db)
        if not session:
            return jsonify({"ok": False, "error": "No hay un tratamiento activo"}), 409
        # El total inicial equivalente conserva los litros ya aplicados y ajusta el restante.
        tank_initial_l = numeric(session["liters_applied"]) + remaining_l
        db.execute("UPDATE sessions SET tank_initial_l = ? WHERE id = ?", (tank_initial_l, session["id"]))
    return jsonify({"ok": True, "remaining_l": remaining_l})


@app.post("/api/telemetry")
def api_telemetry():
    auth_error = verify_api_key()
    if auth_error:
        return auth_error

    payload = request.get_json(silent=True) or {}
    timestamp_dt = parse_timestamp(payload.get("timestamp"))
    timestamp = iso_utc(timestamp_dt)
    pressure_1 = numeric(payload.get("pressure_1_bar"), 0.0, 0.0, 100.0)
    pressure_2 = payload.get("pressure_2_bar")
    pressure_2 = numeric(pressure_2, 0.0, 0.0, 100.0) if pressure_2 not in (None, "") else None
    flow = numeric(payload.get("flow_l_min"), 0.0, 0.0, 1000.0)
    speed = numeric(payload.get("speed_kmh"), 0.0, 0.0, 100.0)
    lat = payload.get("latitude", payload.get("lat"))
    lon = payload.get("longitude", payload.get("lon"))
    lat = numeric(lat, 0.0, -90.0, 90.0) if lat not in (None, "") else None
    lon = numeric(lon, 0.0, -180.0, 180.0) if lon not in (None, "") else None
    source = str(payload.get("source") or "sensor")[:30]

    with db_connection() as db:
        settings = get_settings(db)
        session = get_active_session(db)
        if not session:
            return jsonify({"ok": False, "error": "Inicia un tratamiento antes de enviar datos"}), 409

        # The GPS of the device displaying the app takes precedence while fresh.
        device_gps = db.execute("SELECT * FROM device_location WHERE id = 1").fetchone()
        if device_gps:
            gps_age = (timestamp_dt - parse_timestamp(device_gps["timestamp"])).total_seconds()
            if -2 <= gps_age <= 10:
                speed = numeric(device_gps["speed_kmh"], 0.0, 0.0, 100.0)
                lat = device_gps["latitude"]
                lon = device_gps["longitude"]
                source = f"{source}+device-gps"[:30]

        dt_seconds = 0.0
        if session["last_sample_at"]:
            previous_dt = parse_timestamp(session["last_sample_at"])
            dt_seconds = max(0.0, min(5.0, (timestamp_dt - previous_dt).total_seconds()))

        is_working = int(
            flow >= settings["min_work_flow_l_min"]
            and speed >= settings["min_work_speed_kmh"]
        )

        liters_delta = flow * dt_seconds / 60.0 if flow >= settings["min_work_flow_l_min"] else 0.0
        speed_distance = (speed / 3.6) * dt_seconds
        distance_delta = speed_distance

        if lat is not None and lon is not None and session["last_lat"] is not None and session["last_lon"] is not None:
            gps_distance = haversine_m(session["last_lat"], session["last_lon"], lat, lon)
            plausible_limit = max(15.0, speed_distance * 3.0 + 5.0)
            if 0.5 <= gps_distance <= plausible_limit:
                distance_delta = gps_distance
            elif gps_distance < 0.5:
                distance_delta = 0.0

        work_width = numeric(session["work_width_m"], settings["work_width_m"], 0.1)
        area_delta = distance_delta * work_width / 10_000.0 if is_working else 0.0
        l_ha = (flow * 600.0 / (speed * work_width)) if speed > 0.2 and work_width > 0 else None

        db.execute(
            """
            INSERT INTO telemetry (
                session_id, timestamp, pressure_1_bar, pressure_2_bar,
                flow_l_min, speed_kmh, latitude, longitude, l_ha,
                liters_delta, area_delta_ha, distance_delta_m, is_working, source
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session["id"], timestamp, pressure_1, pressure_2,
                flow, speed, lat, lon, l_ha,
                liters_delta, area_delta, distance_delta, is_working, source,
            ),
        )
        db.execute(
            """
            UPDATE sessions SET
                liters_applied = liters_applied + ?,
                area_ha = area_ha + ?,
                distance_m = distance_m + ?,
                work_seconds = work_seconds + ?,
                last_sample_at = ?,
                last_lat = COALESCE(?, last_lat),
                last_lon = COALESCE(?, last_lon)
            WHERE id = ?
            """,
            (
                liters_delta,
                area_delta,
                distance_delta if is_working else 0.0,
                dt_seconds if is_working else 0.0,
                timestamp,
                lat,
                lon,
                session["id"],
            ),
        )

    return jsonify({
        "ok": True,
        "calculated": {
            "l_ha": l_ha,
            "liters_delta": liters_delta,
            "area_delta_ha": area_delta,
            "distance_delta_m": distance_delta,
            "is_working": bool(is_working),
        },
    })


@app.post("/api/demo/sample")
def api_demo_sample():
    """Genera una muestra realista para probar la interfaz sin hardware."""
    with db_connection() as db:
        settings = get_settings(db)
        session = get_active_session(db)
        if not session:
            return jsonify({"ok": False, "error": "Inicia un tratamiento para usar el simulador"}), 409
        latest = db.execute(
            "SELECT * FROM telemetry WHERE session_id = ? ORDER BY id DESC LIMIT 1",
            (session["id"],),
        ).fetchone()

    target_pressure = numeric(session["target_pressure_bar"], settings["target_pressure_bar"])
    speed = max(0.0, random.gauss(5.5, 0.35))
    pressure_1 = max(0.0, random.gauss(target_pressure, 0.35))
    pressure_2 = max(0.0, pressure_1 + random.gauss(-0.15, 0.18))
    target_flow = session["target_l_ha"] * speed * session["work_width_m"] / 600.0
    flow = max(0.0, random.gauss(target_flow, max(0.15, target_flow * 0.025)))

    if latest and latest["latitude"] is not None and latest["longitude"] is not None:
        lat = latest["latitude"]
        lon = latest["longitude"]
    else:
        lat = 41.6488
        lon = -0.8891

    meters = speed / 3.6
    heading = 0.4 + (session["id"] % 8) * 0.12
    lat += (meters * math.cos(heading)) / 111_320.0
    lon += (meters * math.sin(heading)) / (111_320.0 * max(0.1, math.cos(math.radians(lat))))

    with app.test_request_context(
        "/api/telemetry",
        method="POST",
        json={
            "timestamp": iso_utc(),
            "pressure_1_bar": pressure_1,
            "pressure_2_bar": pressure_2,
            "flow_l_min": flow,
            "speed_kmh": speed,
            "latitude": lat,
            "longitude": lon,
            "source": "demo",
        },
        headers={"X-API-Key": API_KEY} if API_KEY else None,
    ):
        return api_telemetry()


@app.get("/api/sessions")
def api_sessions():
    with db_connection() as db:
        rows = db.execute(
            """
            SELECT id, parcel, product, operator, started_at, ended_at, status,
                   liters_applied, area_ha, distance_m,
                   CASE WHEN area_ha > 0.0001 THEN liters_applied / area_ha ELSE NULL END AS average_l_ha
            FROM sessions ORDER BY id DESC LIMIT 50
            """
        ).fetchall()
    return jsonify({"ok": True, "sessions": [dict(row) for row in rows]})


@app.get("/api/session/<int:session_id>/export.csv")
def api_export_csv(session_id: int):
    with db_connection() as db:
        session = db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if not session:
            return jsonify({"ok": False, "error": "Tratamiento no encontrado"}), 404
        rows = db.execute(
            "SELECT * FROM telemetry WHERE session_id = ? ORDER BY id",
            (session_id,),
        ).fetchall()

    output = io.StringIO()
    writer = csv.writer(output, delimiter=";")
    writer.writerow([
        "fecha_hora", "presion_1_bar", "presion_2_bar", "caudal_l_min",
        "velocidad_kmh", "latitud", "longitud", "litros_hectarea",
        "litros_intervalo", "area_intervalo_ha", "trabajando", "origen",
    ])
    for row in rows:
        writer.writerow([
            row["timestamp"], row["pressure_1_bar"], row["pressure_2_bar"],
            row["flow_l_min"], row["speed_kmh"], row["latitude"], row["longitude"],
            row["l_ha"], row["liters_delta"], row["area_delta_ha"],
            row["is_working"], row["source"],
        ])

    filename = f"tratamiento_{session_id}_{session['parcel'].replace(' ', '_')}.csv"
    return Response(
        "\ufeff" + output.getvalue(),
        mimetype="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/health")
def health():
    return jsonify({"ok": True, "time": iso_utc(), "database": str(DB_PATH)})


init_db()

if __name__ == "__main__":
    host = os.environ.get("ATOMIZADOR_HOST", "0.0.0.0")
    port = int(os.environ.get("ATOMIZADOR_PORT", "5055"))
    debug = os.environ.get("ATOMIZADOR_DEBUG", "0") == "1"
    app.run(host=host, port=port, debug=debug)
