from __future__ import annotations

import json
import os
import base64
import hashlib
import hmac
import secrets
from copy import deepcopy
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Optional
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, ConfigDict, Field, field_validator

try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"

app = FastAPI(title="Ferconsulting Facturación", version="1.0.0")
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))


def read_json(name: str, default: Any) -> Any:
    path = DATA_DIR / name
    if not path.exists():
        return deepcopy(default)
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(name: str, payload: Any) -> None:
    path = DATA_DIR / name
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


SETTINGS = read_json("settings.json", {})
COMPANY = SETTINGS.get("company", {})
VAT_RATE = float(SETTINGS.get("vat_rate", 0.21))
SESSION_COOKIE = "fer_session"
SESSION_MAX_AGE_SECONDS = int(os.getenv("SESSION_MAX_AGE_SECONDS", "28800"))
SESSION_SECRET = os.getenv("SESSION_SECRET") or os.getenv("SECRET_KEY") or "dev-ferconsulting-change-me"
HASH_PREFIX = "pbkdf2_sha256"
VALID_PAYMENT_METHODS = {"", "TRANSFERENCIA ES15 2100 3586 5022 0012 1937 LA CAIXA", "GIRO"}
VALID_DELIVERY_METHODS = {"", "email", "postal"}
VALID_ROLES = {"admin", "gestor", "lectura"}
DEFAULT_ADMIN_PASSWORD = os.getenv("DEFAULT_ADMIN_PASSWORD", "Cambia-Admin-2026!")
DEFAULT_NEW_USER_PASSWORD = os.getenv("DEFAULT_NEW_USER_PASSWORD", "Cambia-Usuario-2026!")


class InvoiceItemIn(BaseModel):
    service_id: Optional[int] = None
    description: str = ""
    quantity: float = 0
    unit: str = ""
    unit_price: float = 0
    discount_rate: float = Field(default=0, ge=0, le=1)

    @field_validator("description", "unit", mode="before")
    @classmethod
    def clean_text(cls, value):
        return "" if value is None else str(value).strip()

    @field_validator("quantity")
    @classmethod
    def non_negative_number(cls, value):
        if float(value or 0) < 0:
            raise ValueError("Debe ser un valor positivo.")
        return value


class ClientSnapshot(BaseModel):
    id: Optional[int] = None
    name: str = ""
    tax_id: str = ""
    address: str = ""
    postal_code: str = ""
    city: str = ""
    email: str = ""
    default_payment_method: str = ""
    default_delivery_method: str = ""

    @field_validator(
        "name",
        "tax_id",
        "address",
        "postal_code",
        "city",
        "email",
        "default_payment_method",
        "default_delivery_method",
        mode="before",
    )
    @classmethod
    def empty_if_none(cls, value):
        return "" if value is None else str(value).strip()

    @field_validator("email")
    @classmethod
    def valid_email_or_empty(cls, value):
        if value and "@" not in value:
            raise ValueError("Email no valido.")
        return value


class InvoiceIn(BaseModel):
    model_config = ConfigDict(extra="ignore")

    invoice_type: str = "invoice"
    invoice_date: Optional[date] = None
    fiscal_year: int = int(SETTINGS.get("fiscal_year", date.today().year))
    client: ClientSnapshot
    items: list[InvoiceItemIn]
    vat_rate: float = VAT_RATE
    payment_method: str = SETTINGS.get("default_payment_method", "TRANSFERENCIA")
    delivery_method: str = "email"
    notes: str = ""

    @field_validator("invoice_type")
    @classmethod
    def valid_invoice_type(cls, value):
        value = clean_invoice_type(value)
        if value not in VALID_INVOICE_TYPES:
            raise ValueError("Tipo de factura no valido.")
        return value

    @field_validator("delivery_method")
    @classmethod
    def valid_delivery_method(cls, value):
        value = (value or "").strip()
        if value not in VALID_DELIVERY_METHODS:
            raise ValueError("Metodo de envio no valido.")
        return value

    @field_validator("payment_method")
    @classmethod
    def valid_payment_method(cls, value):
        value = (value or "").strip()
        if value not in VALID_PAYMENT_METHODS:
            raise ValueError("Metodo de pago no valido.")
        return value

    @field_validator("vat_rate")
    @classmethod
    def valid_vat_rate(cls, value):
        value = float(value)
        if value < 0 or value > 1:
            raise ValueError("IVA no valido.")
        return value


class LoginIn(BaseModel):
    username: str
    password: str


class DeleteInvoiceIn(LoginIn):
    pass


class ClientIn(BaseModel):
    id: Optional[int] = None
    external_code: str = ""
    name: str
    tax_id: str = ""
    address: str = ""
    postal_code: str = ""
    city: str = ""
    email: str = ""
    default_payment_method: str = ""
    default_delivery_method: str = ""

    @field_validator(
        "external_code",
        "tax_id",
        "address",
        "postal_code",
        "city",
        "email",
        "default_payment_method",
        "default_delivery_method",
        mode="before",
    )
    @classmethod
    def empty_if_none(cls, value):
        return "" if value is None else str(value).strip()

    @field_validator("email")
    @classmethod
    def valid_email_or_empty(cls, value):
        if value and "@" not in value:
            raise ValueError("Email no valido.")
        return value

    @field_validator("default_payment_method")
    @classmethod
    def valid_default_payment_method(cls, value):
        if value not in VALID_PAYMENT_METHODS:
            raise ValueError("Metodo de pago no valido.")
        return value

    @field_validator("default_delivery_method")
    @classmethod
    def valid_default_delivery_method(cls, value):
        if value not in VALID_DELIVERY_METHODS:
            raise ValueError("Metodo de envio no valido.")
        return value


class ServiceIn(BaseModel):
    id: Optional[int] = None
    code: str = ""
    name: str
    unit: str = ""
    unit_price: float = 0
    active: bool = True

    @field_validator("code", "name", "unit", mode="before")
    @classmethod
    def clean_text(cls, value):
        return "" if value is None else str(value).strip()



class UserIn(BaseModel):
    id: Optional[int] = None
    username: str
    password: str = ""
    email: str = ""
    role: str = "admin"
    active: bool = True

    @field_validator("username", "password", "email", "role", mode="before")
    @classmethod
    def clean_text(cls, value):
        return "" if value is None else str(value).strip()

    @field_validator("email")
    @classmethod
    def valid_user_email_or_empty(cls, value):
        if value and "@" not in value:
            raise ValueError("Email no valido.")
        return value

    @field_validator("role")
    @classmethod
    def valid_role(cls, value):
        value = (value or "admin").casefold()
        if value not in VALID_ROLES:
            raise ValueError("Rol no valido.")
        return value


class InvoiceCounterIn(BaseModel):
    fiscal_year: int = Field(default_factory=lambda: date.today().year, ge=2000, le=2100)
    prefix: str = "FAC-"
    next_sequence: int = Field(ge=1)


class InvoiceUpdateIn(InvoiceIn):
    status: str = "pendiente_envio"
    sent_by: str = ""
    sent_at: Optional[str] = None


class InvoiceStatusIn(BaseModel):
    status: str

    @field_validator("status")
    @classmethod
    def valid_status(cls, value):
        value = (value or "").strip().casefold()
        if value not in VALID_STATUSES:
            raise ValueError("Estado no valido.")
        return value


def money(value: float) -> float:
    return round(float(value or 0), 2)


VALID_INVOICE_TYPES = {"invoice", "proforma"}
VALID_STATUSES = {"proforma", "pendiente_envio", "enviada", "pagada"}


def clean_invoice_type(value: str) -> str:
    value = (value or "invoice").strip().casefold()
    return value if value in VALID_INVOICE_TYPES else "invoice"


def clean_status(value: str, invoice_type: str = "invoice") -> str:
    fallback = "proforma" if invoice_type == "proforma" else "pendiente_envio"
    value = (value or fallback).strip().casefold()
    return value if value in VALID_STATUSES else fallback


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    derived = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 260000)
    return f"{HASH_PREFIX}${base64.b64encode(salt).decode()}${base64.b64encode(derived).decode()}"


def verify_password(password: str, stored: str) -> bool:
    stored = stored or ""
    if stored.startswith(f"{HASH_PREFIX}$"):
        try:
            _, salt_b64, hash_b64 = stored.split("$", 2)
            salt = base64.b64decode(salt_b64.encode())
            expected = base64.b64decode(hash_b64.encode())
            derived = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 260000)
            return hmac.compare_digest(derived, expected)
        except Exception:
            return False
    return hmac.compare_digest(stored, password)


def password_is_hashed(password: str) -> bool:
    return bool(password and password.startswith(f"{HASH_PREFIX}$"))


def default_admin_user() -> dict[str, Any]:
    return {
        "id": 1,
        "username": "Admin",
        "password": hash_password(DEFAULT_ADMIN_PASSWORD),
        "email": SETTINGS.get("company", {}).get("email", ""),
        "role": "admin",
        "active": True,
    }


def load_clients() -> list[dict[str, Any]]:
    store = globals().get("supabase_store")
    if store and store.available():
        return store.list_clients()
    return read_json("clients.json", [])


def load_services() -> list[dict[str, Any]]:
    store = globals().get("supabase_store")
    if store and store.available():
        return store.list_services()
    return read_json("services.json", [])


def load_client_prices() -> list[dict[str, Any]]:
    store = globals().get("supabase_store")
    if store and store.available():
        return store.list_client_prices()
    return read_json("client_prices.json", [])


def load_users() -> list[dict[str, Any]]:
    store = globals().get("supabase_store")
    if store and store.available():
        return store.list_users()
    users = read_json("users.json", [])
    if users:
        return users
    users = [default_admin_user()]
    write_json("users.json", users)
    return users


def authenticate_user(username: str, password: str, require_admin: bool = False) -> dict[str, Any]:
    normalized_username = username.strip().casefold()
    for user in load_users():
        if not user.get("active", True):
            continue
        if user.get("username", "").casefold() != normalized_username or not verify_password(password, user.get("password", "")):
            continue
        if not password_is_hashed(user.get("password", "")):
            migrate_user_password(user, password)
            user["password"] = hash_password(password)
        if require_admin and user.get("role", "admin").casefold() != "admin":
            raise HTTPException(status_code=403, detail="El usuario no tiene permisos para borrar facturas.")
        return user
    raise HTTPException(status_code=401, detail="Usuario o contrasena incorrectos.")


def migrate_user_password(user: dict[str, Any], password: str) -> None:
    data = {**user, "password": hash_password(password)}
    user_id = int(user.get("id") or 0)
    try:
        if supabase_store.available():
            supabase_store.save_user(data, user_id)
        else:
            upsert_json_row("users.json", data, user_id)
    except Exception:
        pass


def session_signature(payload: str) -> str:
    return hmac.new(SESSION_SECRET.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()


def create_session_token(user: dict[str, Any]) -> str:
    expires_at = int((datetime.utcnow() + timedelta(seconds=SESSION_MAX_AGE_SECONDS)).timestamp())
    payload = {
        "uid": user.get("id"),
        "username": user.get("username"),
        "role": user.get("role", "admin"),
        "exp": expires_at,
    }
    payload_b64 = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode()
    return f"{payload_b64}.{session_signature(payload_b64)}"


def decode_session_token(token: str) -> dict[str, Any]:
    try:
        payload_b64, signature = token.split(".", 1)
        if not hmac.compare_digest(signature, session_signature(payload_b64)):
            raise ValueError("bad signature")
        payload = json.loads(base64.urlsafe_b64decode(payload_b64.encode()).decode())
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Sesion no valida.") from exc
    if int(payload.get("exp") or 0) < int(datetime.utcnow().timestamp()):
        raise HTTPException(status_code=401, detail="Sesion caducada.")
    return payload


def public_user(user: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in user.items() if k != "password"}


def current_user(request: Request) -> dict[str, Any]:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise HTTPException(status_code=401, detail="Inicia sesion.")
    session = decode_session_token(token)
    for user in load_users():
        if str(user.get("id")) == str(session.get("uid")) and user.get("active", True):
            return user
    raise HTTPException(status_code=401, detail="Usuario no valido.")


def require_roles(*roles: str):
    allowed = {role.casefold() for role in roles}

    def dependency(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
        if user.get("role", "admin").casefold() not in allowed:
            raise HTTPException(status_code=403, detail="No tienes permisos para esta accion.")
        return user

    return dependency


def request_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    return forwarded.split(",")[0].strip() or (request.client.host if request.client else "")


def audit_log(action: str, user: Optional[dict[str, Any]], request: Optional[Request], entity: str, entity_id: Any, details: Optional[dict[str, Any]] = None) -> None:
    entry = {
        "id": str(uuid4()),
        "action": action,
        "entity": entity,
        "entity_id": str(entity_id or ""),
        "user_id": user.get("id") if user else None,
        "username": user.get("username") if user else "",
        "ip": request_ip(request) if request else "",
        "details": details or {},
        "created_at": datetime.utcnow().isoformat() + "Z",
    }
    try:
        if supabase_store.available():
            supabase_store.write_audit_log(entry)
        else:
            rows = read_json("audit_log.json", [])
            rows.append(entry)
            write_json("audit_log.json", rows[-1000:])
    except Exception:
        pass


def next_id(rows: list[dict[str, Any]]) -> int:
    return max([int(row.get("id") or 0) for row in rows] or [0]) + 1


def upsert_json_row(filename: str, payload: dict[str, Any], row_id: Optional[int] = None) -> dict[str, Any]:
    rows = read_json(filename, [])
    if row_id is None:
        payload["id"] = next_id(rows)
        rows.append(payload)
    else:
        for index, row in enumerate(rows):
            if int(row.get("id") or 0) == int(row_id):
                payload["id"] = row_id
                rows[index] = {**row, **payload}
                break
        else:
            raise HTTPException(status_code=404, detail="Registro no encontrado.")
    write_json(filename, rows)
    return payload


def delete_json_row(filename: str, row_id: int) -> dict[str, Any]:
    rows = read_json(filename, [])
    remaining = [row for row in rows if int(row.get("id") or 0) != int(row_id)]
    if len(remaining) == len(rows):
        raise HTTPException(status_code=404, detail="Registro no encontrado.")
    write_json(filename, remaining)
    return {"ok": True}


def same_key(left: Any, right: Any) -> bool:
    return str(left or "").strip().casefold() == str(right or "").strip().casefold()


def update_client_price_history(client: ClientSnapshot, items: list[dict[str, Any]]) -> None:
    store = globals().get("supabase_store")
    if store and store.available():
        store.upsert_client_prices(client, items)
        return
    prices = load_client_prices()
    now = datetime.utcnow().isoformat() + "Z"
    for item in items:
        if not item.get("description") or float(item.get("unit_price") or 0) <= 0:
            continue
        matched_index = None
        for index, row in enumerate(prices):
            same_client = (
                client.id is not None and row.get("client_id") == client.id
            ) or (
                client.id is None and same_key(row.get("client_name"), client.name)
            )
            same_service = (
                item.get("service_id") is not None and row.get("service_id") == item.get("service_id")
            ) or (
                item.get("service_id") is None and same_key(row.get("service_name"), item.get("description"))
            )
            if same_client and same_service:
                matched_index = index
                break
        payload = {
            "id": prices[matched_index]["id"] if matched_index is not None else next_id(prices),
            "client_id": client.id,
            "client_name": client.name,
            "service_id": item.get("service_id"),
            "service_name": item.get("description"),
            "unit": item.get("unit", ""),
            "unit_price": money(item.get("unit_price") or 0),
            "updated_at": now,
        }
        if matched_index is None:
            prices.append(payload)
        else:
            prices[matched_index] = {**prices[matched_index], **payload}
    write_json("client_prices.json", prices)


def next_invoice_preview() -> dict[str, Any]:
    store = globals().get("supabase_store")
    if store and store.available():
        fiscal_year = int(SETTINGS.get("fiscal_year", date.today().year))
        return store.preview_invoice_number(fiscal_year)
    settings = read_json("settings.json", SETTINGS)
    fiscal_year = int(settings.get("fiscal_year", date.today().year))
    prefix = settings.get("invoice_prefix", "FAC-")
    sequence = int(settings.get("next_invoice_sequence", 1))
    return {
        "fiscal_year": fiscal_year,
        "prefix": prefix,
        "sequence": sequence,
        "invoice_number": f"{prefix}{fiscal_year}.{sequence}",
    }


def next_proforma_preview() -> dict[str, Any]:
    fiscal_year = int(SETTINGS.get("fiscal_year", date.today().year))
    store = globals().get("supabase_store")
    if store and store.available():
        return store.preview_proforma_number(fiscal_year)
    settings = read_json("settings.json", SETTINGS)
    prefix = settings.get("proforma_prefix", "PRO-")
    sequence = int(settings.get("next_proforma_sequence", 1))
    return {
        "proforma_prefix": prefix,
        "proforma_sequence": sequence,
        "proforma_number": f"{prefix}{fiscal_year}.{sequence}",
    }


def calculate_invoice(payload: InvoiceIn) -> dict[str, Any]:
    cleaned_items = []
    subtotal = 0.0
    for i, item in enumerate(payload.items, start=1):
        quantity = max(float(item.quantity or 0), 0)
        unit_price = max(float(item.unit_price or 0), 0)
        discount_rate = min(max(float(item.discount_rate or 0), 0), 1)
        description = item.description.strip()
        if not description and quantity == 0 and unit_price == 0:
            continue
        amount = money(quantity * unit_price * (1 - discount_rate))
        subtotal += amount
        cleaned_items.append({
            "line_number": len(cleaned_items) + 1,
            "service_id": item.service_id,
            "description": description,
            "quantity": quantity,
            "unit": item.unit.strip(),
            "unit_price": unit_price,
            "discount_rate": discount_rate,
            "amount": amount,
        })
    subtotal = money(subtotal)
    vat_rate = float(payload.vat_rate if payload.vat_rate is not None else VAT_RATE)
    vat_amount = money(subtotal * vat_rate)
    total = money(subtotal + vat_amount)
    return {
        "items": cleaned_items,
        "subtotal": subtotal,
        "vat_rate": vat_rate,
        "vat_amount": vat_amount,
        "total": total,
    }


class LocalStore:
    def reserve_invoice_number(self, fiscal_year: int) -> dict[str, Any]:
        settings = read_json("settings.json", SETTINGS)
        prefix = settings.get("invoice_prefix", "FAC-")
        sequence = int(settings.get("next_invoice_sequence", 1))
        return {"sequence": sequence, "invoice_number": f"{prefix}{fiscal_year}.{sequence}"}

    def reserve_proforma_number(self, fiscal_year: int) -> dict[str, Any]:
        settings = read_json("settings.json", SETTINGS)
        prefix = settings.get("proforma_prefix", "PRO-")
        sequence = int(settings.get("next_proforma_sequence", 1))
        settings["next_proforma_sequence"] = sequence + 1
        write_json("settings.json", settings)
        return {"sequence": sequence, "invoice_number": f"{prefix}{fiscal_year}.{sequence}", "prefix": prefix, "fiscal_year": fiscal_year}

    def commit_sequence(self, sequence: int) -> None:
        settings = read_json("settings.json", SETTINGS)
        settings["next_invoice_sequence"] = int(sequence) + 1
        write_json("settings.json", settings)

    def set_invoice_counter(self, payload: InvoiceCounterIn) -> dict[str, Any]:
        settings = read_json("settings.json", SETTINGS)
        settings["fiscal_year"] = payload.fiscal_year
        settings["invoice_prefix"] = payload.prefix
        settings["next_invoice_sequence"] = payload.next_sequence
        write_json("settings.json", settings)
        return {
            "fiscal_year": payload.fiscal_year,
            "prefix": payload.prefix,
            "sequence": payload.next_sequence,
            "invoice_number": f"{payload.prefix}{payload.fiscal_year}.{payload.next_sequence}",
        }

    def save_invoice(self, invoice: dict[str, Any]) -> dict[str, Any]:
        invoices = read_json("local_invoices.json", [])
        invoices.append(invoice)
        write_json("local_invoices.json", invoices)
        return invoice

    def list_invoices(self) -> list[dict[str, Any]]:
        return list(reversed([invoice for invoice in read_json("local_invoices.json", []) if not invoice.get("deleted_at")]))

    def get_invoice(self, invoice_id: str) -> dict[str, Any]:
        for invoice in read_json("local_invoices.json", []):
            if invoice.get("id") == invoice_id and not invoice.get("deleted_at"):
                return invoice
        raise HTTPException(status_code=404, detail="Factura no encontrada.")

    def update_invoice(self, invoice_id: str, invoice: dict[str, Any]) -> dict[str, Any]:
        invoices = read_json("local_invoices.json", [])
        for index, current in enumerate(invoices):
            if current.get("id") == invoice_id:
                invoices[index] = {**current, **invoice, "id": invoice_id}
                write_json("local_invoices.json", invoices)
                return invoices[index]
        raise HTTPException(status_code=404, detail="Factura no encontrada.")

    def update_invoice_status(self, invoice_id: str, status: str) -> dict[str, Any]:
        invoices = read_json("local_invoices.json", [])
        for index, current in enumerate(invoices):
            if current.get("id") == invoice_id:
                invoices[index] = {**current, "status": status, "updated_at": datetime.utcnow().isoformat() + "Z"}
                write_json("local_invoices.json", invoices)
                return invoices[index]
        raise HTTPException(status_code=404, detail="Factura no encontrada.")

    def delete_invoice(self, invoice_id: str, deleted_by: Optional[int] = None) -> dict[str, Any]:
        invoices = read_json("local_invoices.json", [])
        for index, invoice in enumerate(invoices):
            if invoice.get("id") == invoice_id and not invoice.get("deleted_at"):
                invoices[index] = {
                    **invoice,
                    "deleted_at": datetime.utcnow().isoformat() + "Z",
                    "deleted_by": deleted_by,
                    "updated_at": datetime.utcnow().isoformat() + "Z",
                }
                write_json("local_invoices.json", invoices)
                return {"ok": True}
        raise HTTPException(status_code=404, detail="Factura no encontrada.")

    def update_client_defaults(self, client_id: Optional[int], payment_method: str, delivery_method: str) -> None:
        if client_id is None:
            return
        clients = read_json("clients.json", [])
        for index, client in enumerate(clients):
            if int(client.get("id") or 0) == int(client_id):
                clients[index] = {
                    **client,
                    "default_payment_method": payment_method,
                    "default_delivery_method": delivery_method,
                }
                write_json("clients.json", clients)
                return


class SupabaseStore:
    def __init__(self) -> None:
        self.url = os.getenv("SUPABASE_URL", "")
        self.key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", os.getenv("SUPABASE_KEY", ""))
        self._client = None
        self._available: Optional[bool] = None

    @property
    def configured(self) -> bool:
        return bool(self.url and self.key)

    def available(self) -> bool:
        if not self.configured:
            return False
        if self._available is not None:
            return self._available
        try:
            self.client().table("invoices").select("id").limit(1).execute()
            self._available = True
        except Exception:
            self._available = False
        return self._available

    def client(self):
        if self._client is None:
            try:
                from supabase import create_client
            except Exception as exc:
                raise HTTPException(status_code=500, detail="Falta instalar el paquete supabase. Ejecuta: pip install -r requirements.txt") from exc
            self._client = create_client(self.url, self.key)
        return self._client

    def reserve_invoice_number(self, fiscal_year: int) -> dict[str, Any]:
        prefix = os.getenv("INVOICE_PREFIX", SETTINGS.get("invoice_prefix", "FAC-"))
        result = self.client().rpc("reserve_invoice_number", {"p_year": fiscal_year, "p_prefix": prefix}).execute()
        data = result.data[0] if isinstance(result.data, list) else result.data
        return {"sequence": int(data["sequence"]), "invoice_number": data["invoice_number"]}

    def reserve_proforma_number(self, fiscal_year: int) -> dict[str, Any]:
        prefix = os.getenv("PROFORMA_PREFIX", SETTINGS.get("proforma_prefix", "PRO-"))
        try:
            result = self.client().rpc("reserve_proforma_number", {"p_year": fiscal_year, "p_prefix": prefix}).execute()
        except Exception as exc:
            raise HTTPException(status_code=500, detail="Falta ejecutar el SQL actualizado de Supabase para activar proformas.") from exc
        data = result.data[0] if isinstance(result.data, list) else result.data
        return {"sequence": int(data["sequence"]), "invoice_number": data["invoice_number"], "prefix": prefix, "fiscal_year": fiscal_year}

    def preview_invoice_number(self, fiscal_year: int) -> dict[str, Any]:
        prefix = os.getenv("INVOICE_PREFIX", SETTINGS.get("invoice_prefix", "FAC-"))
        result = self.client().table("invoice_counters").select("next_sequence,prefix").eq("year", fiscal_year).limit(1).execute()
        row = (result.data or [{}])[0]
        sequence = int(row.get("next_sequence") or 1)
        prefix = row.get("prefix") or prefix
        return {
            "fiscal_year": fiscal_year,
            "prefix": prefix,
            "sequence": sequence,
            "invoice_number": f"{prefix}{fiscal_year}.{sequence}",
        }

    def preview_proforma_number(self, fiscal_year: int) -> dict[str, Any]:
        prefix = os.getenv("PROFORMA_PREFIX", SETTINGS.get("proforma_prefix", "PRO-"))
        try:
            result = self.client().table("proforma_counters").select("next_sequence,prefix").eq("year", fiscal_year).limit(1).execute()
            row = (result.data or [{}])[0]
            sequence = int(row.get("next_sequence") or 1)
            prefix = row.get("prefix") or prefix
        except Exception:
            sequence = 1
        return {
            "proforma_prefix": prefix,
            "proforma_sequence": sequence,
            "proforma_number": f"{prefix}{fiscal_year}.{sequence}",
        }

    def set_invoice_counter(self, payload: InvoiceCounterIn) -> dict[str, Any]:
        row = {
            "year": payload.fiscal_year,
            "prefix": payload.prefix,
            "next_sequence": payload.next_sequence,
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }
        self.client().table("invoice_counters").upsert(row, on_conflict="year").execute()
        return {
            "fiscal_year": payload.fiscal_year,
            "prefix": payload.prefix,
            "sequence": payload.next_sequence,
            "invoice_number": f"{payload.prefix}{payload.fiscal_year}.{payload.next_sequence}",
        }

    def _list_table(self, table: str, order: str = "id") -> list[dict[str, Any]]:
        result = self.client().table(table).select("*").order(order).execute()
        return result.data or []

    def _upsert_table_row(self, table: str, payload: dict[str, Any], row_id: Optional[int] = None) -> dict[str, Any]:
        clean_payload = deepcopy(payload)
        if row_id is None:
            inserted = self.client().table(table).insert(clean_payload).execute().data
            if not inserted:
                raise HTTPException(status_code=500, detail="No se ha podido guardar el registro.")
            return inserted[0]
        clean_payload["updated_at"] = datetime.utcnow().isoformat() + "Z"
        updated = self.client().table(table).update(clean_payload).eq("id", row_id).execute().data
        if not updated:
            raise HTTPException(status_code=404, detail="Registro no encontrado.")
        return updated[0]

    def _delete_table_row(self, table: str, row_id: int) -> dict[str, Any]:
        deleted = self.client().table(table).delete().eq("id", row_id).execute().data
        if deleted is not None and len(deleted) == 0:
            raise HTTPException(status_code=404, detail="Registro no encontrado.")
        return {"ok": True}

    def write_audit_log(self, entry: dict[str, Any]) -> None:
        self.client().table("audit_log").insert(entry).execute()

    def list_clients(self) -> list[dict[str, Any]]:
        return self._list_table("clients")

    def list_services(self) -> list[dict[str, Any]]:
        return self._list_table("services")

    def list_client_prices(self) -> list[dict[str, Any]]:
        try:
            return self._list_table("client_prices")
        except Exception:
            return read_json("client_prices.json", [])

    def list_users(self) -> list[dict[str, Any]]:
        try:
            users = self._list_table("users")
        except Exception:
            return read_json("users.json", [default_admin_user()])
        if users:
            return users
        self._upsert_table_row("users", default_admin_user())
        return self._list_table("users")

    def save_client(self, payload: dict[str, Any], row_id: Optional[int] = None) -> dict[str, Any]:
        return self._upsert_table_row("clients", payload, row_id)

    def save_service(self, payload: dict[str, Any], row_id: Optional[int] = None) -> dict[str, Any]:
        return self._upsert_table_row("services", payload, row_id)

    def save_user(self, payload: dict[str, Any], row_id: Optional[int] = None) -> dict[str, Any]:
        return self._upsert_table_row("users", payload, row_id)

    def delete_client(self, row_id: int) -> dict[str, Any]:
        return self._delete_table_row("clients", row_id)

    def delete_service(self, row_id: int) -> dict[str, Any]:
        return self._delete_table_row("services", row_id)

    def delete_user(self, row_id: int) -> dict[str, Any]:
        return self._delete_table_row("users", row_id)

    def upsert_client_prices(self, client: ClientSnapshot, items: list[dict[str, Any]]) -> None:
        try:
            now = datetime.utcnow().isoformat() + "Z"
            for item in items:
                if not item.get("description") or float(item.get("unit_price") or 0) <= 0:
                    continue
                query = self.client().table("client_prices").select("*").limit(1)
                if client.id is not None:
                    query = query.eq("client_id", client.id)
                else:
                    query = query.eq("client_name", client.name)
                if item.get("service_id") is not None:
                    query = query.eq("service_id", item.get("service_id"))
                else:
                    query = query.eq("service_name", item.get("description"))
                existing = query.execute().data or []
                payload = {
                    "client_id": client.id,
                    "client_name": client.name,
                    "service_id": item.get("service_id"),
                    "service_name": item.get("description"),
                    "unit": item.get("unit", ""),
                    "unit_price": money(item.get("unit_price") or 0),
                    "updated_at": now,
                }
                if existing:
                    self.client().table("client_prices").update(payload).eq("id", existing[0]["id"]).execute()
                else:
                    self.client().table("client_prices").insert(payload).execute()
        except Exception:
            pass

    def save_invoice(self, invoice: dict[str, Any]) -> dict[str, Any]:
        items = invoice.pop("items")
        sb = self.client()
        inserted = sb.table("invoices").insert(invoice).execute().data[0]
        invoice_id = inserted["id"]
        for item in items:
            item["invoice_id"] = invoice_id
        if items:
            sb.table("invoice_items").insert(items).execute()
        inserted["items"] = items
        return inserted

    def list_invoices(self) -> list[dict[str, Any]]:
        try:
            result = self.client().table("invoices").select("*").is_("deleted_at", "null").order("created_at", desc=True).limit(50).execute()
        except Exception as exc:
            if "deleted_at" not in str(exc):
                raise
            result = self.client().table("invoices").select("*").order("created_at", desc=True).limit(50).execute()
        return result.data or []

    def get_invoice(self, invoice_id: str) -> dict[str, Any]:
        try:
            invoice_result = self.client().table("invoices").select("*").eq("id", invoice_id).is_("deleted_at", "null").limit(1).execute()
        except Exception as exc:
            if "deleted_at" not in str(exc):
                raise
            invoice_result = self.client().table("invoices").select("*").eq("id", invoice_id).limit(1).execute()
        if not invoice_result.data:
            raise HTTPException(status_code=404, detail="Factura no encontrada.")
        invoice = invoice_result.data[0]
        items_result = self.client().table("invoice_items").select("*").eq("invoice_id", invoice_id).order("line_number").execute()
        invoice["items"] = items_result.data or []
        return invoice

    def update_invoice(self, invoice_id: str, invoice: dict[str, Any]) -> dict[str, Any]:
        items = invoice.pop("items")
        sb = self.client()
        existing = self.get_invoice(invoice_id)
        invoice["updated_at"] = datetime.utcnow().isoformat() + "Z"
        updated = sb.table("invoices").update(invoice).eq("id", invoice_id).execute().data
        if not updated:
            raise HTTPException(status_code=404, detail="Factura no encontrada.")
        sb.table("invoice_items").delete().eq("invoice_id", invoice_id).execute()
        for item in items:
            item["invoice_id"] = invoice_id
        if items:
            sb.table("invoice_items").insert(items).execute()
        saved = {**existing, **updated[0], "items": items}
        return saved

    def update_invoice_status(self, invoice_id: str, status: str) -> dict[str, Any]:
        updated = self.client().table("invoices").update({
            "status": status,
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }).eq("id", invoice_id).execute().data
        if not updated:
            raise HTTPException(status_code=404, detail="Factura no encontrada.")
        return updated[0]

    def delete_invoice(self, invoice_id: str, deleted_by: Optional[int] = None) -> dict[str, Any]:
        try:
            deleted = self.client().table("invoices").update({
                "deleted_at": datetime.utcnow().isoformat() + "Z",
                "deleted_by": deleted_by,
                "updated_at": datetime.utcnow().isoformat() + "Z",
            }).eq("id", invoice_id).is_("deleted_at", "null").execute().data
        except Exception as exc:
            if "deleted_at" not in str(exc):
                raise
            raise HTTPException(status_code=500, detail="Falta ejecutar el SQL actualizado de Supabase para activar el borrado logico.") from exc
        if deleted is not None and len(deleted) == 0:
            raise HTTPException(status_code=404, detail="Factura no encontrada.")
        return {"ok": True}

    def update_client_defaults(self, client_id: Optional[int], payment_method: str, delivery_method: str) -> None:
        if client_id is None:
            return
        try:
            self.client().table("clients").update({
                "default_payment_method": payment_method,
                "default_delivery_method": delivery_method,
                "updated_at": datetime.utcnow().isoformat() + "Z",
            }).eq("id", client_id).execute()
        except Exception:
            pass


local_store = LocalStore()
supabase_store = SupabaseStore()


def active_store():
    return supabase_store if supabase_store.available() else local_store


def storage_name() -> str:
    return "supabase" if isinstance(active_store(), SupabaseStore) else "local-json"


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request, "company": COMPANY})


@app.get("/api/session")
def session_info(user: dict[str, Any] = Depends(current_user)):
    return {"user": public_user(user)}


@app.post("/api/logout")
def logout(response: Response):
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


@app.get("/api/bootstrap")
def bootstrap(user: dict[str, Any] = Depends(require_roles("admin", "gestor", "lectura"))):
    return {
        "company": COMPANY,
        "settings": {**SETTINGS, **next_invoice_preview(), **next_proforma_preview()},
        "clients": load_clients(),
        "services": load_services(),
        "client_prices": load_client_prices(),
        "users": [public_user(user) for user in load_users()] if user.get("role") == "admin" else [],
        "storage": storage_name(),
    }


@app.post("/api/login")
def login(payload: LoginIn, response: Response, request: Request):
    user = authenticate_user(payload.username, payload.password)
    token = create_session_token(user)
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=SESSION_MAX_AGE_SECONDS,
        httponly=True,
        secure=request.url.scheme == "https",
        samesite="lax",
        path="/",
    )
    audit_log("login", user, request, "user", user.get("id"))
    safe_user = public_user(user)
    return {"ok": True, "user": safe_user}


@app.get("/api/clients")
def clients(q: str = "", user: dict[str, Any] = Depends(require_roles("admin", "gestor", "lectura"))):
    data = load_clients()
    if q:
        qn = q.casefold()
        data = [c for c in data if qn in (c.get("name", "") + " " + c.get("tax_id", "") + " " + c.get("city", "")).casefold()]
    return data[:100]


@app.get("/api/services")
def services(q: str = "", user: dict[str, Any] = Depends(require_roles("admin", "gestor", "lectura"))):
    data = load_services()
    if q:
        qn = q.casefold()
        data = [s for s in data if qn in (s.get("name", "") + " " + s.get("unit", "")).casefold()]
    return data[:100]


@app.post("/api/calculate")
def calculate(payload: InvoiceIn, user: dict[str, Any] = Depends(require_roles("admin", "gestor"))):
    return calculate_invoice(payload)


@app.post("/api/invoices")
def create_invoice(payload: InvoiceIn, request: Request, user: dict[str, Any] = Depends(require_roles("admin", "gestor"))):
    calculations = calculate_invoice(payload)
    if not payload.client.name.strip():
        raise HTTPException(status_code=400, detail="Selecciona un cliente antes de registrar la factura.")
    if payload.delivery_method == "email" and not payload.client.email.strip():
        raise HTTPException(status_code=400, detail="El cliente no tiene email para usar envio por email.")
    if not calculations["items"]:
        raise HTTPException(status_code=400, detail="Añade al menos una línea de factura.")

    store = active_store()
    invoice_type = clean_invoice_type(payload.invoice_type)
    reserved = store.reserve_proforma_number(payload.fiscal_year) if invoice_type == "proforma" else store.reserve_invoice_number(payload.fiscal_year)
    invoice_id = str(uuid4())
    today = payload.invoice_date or date.today()

    invoice = {
        "id": invoice_id,
        "invoice_type": invoice_type,
        "invoice_number": reserved["invoice_number"],
        "fiscal_year": payload.fiscal_year,
        "sequence": reserved["sequence"],
        "invoice_date": today.isoformat(),
        "client_id": payload.client.id,
        "client_name": payload.client.name,
        "client_tax_id": payload.client.tax_id,
        "client_address": payload.client.address,
        "client_postal_code": payload.client.postal_code,
        "client_city": payload.client.city,
        "client_email": payload.client.email,
        "payment_method": payload.payment_method,
        "delivery_method": payload.delivery_method,
        "subtotal": calculations["subtotal"],
        "vat_rate": calculations["vat_rate"],
        "vat_amount": calculations["vat_amount"],
        "total": calculations["total"],
        "status": clean_status("proforma" if invoice_type == "proforma" else "pendiente_envio", invoice_type),
        "notes": payload.notes,
        "sent_by": "",
        "sent_at": None,
        "created_at": datetime.utcnow().isoformat() + "Z",
        "items": calculations["items"],
    }
    saved = store.save_invoice(deepcopy(invoice))
    if isinstance(store, LocalStore) and invoice_type == "invoice":
        store.commit_sequence(reserved["sequence"])
    store.update_client_defaults(payload.client.id, payload.payment_method, payload.delivery_method)
    update_client_price_history(payload.client, calculations["items"])
    audit_log("create", user, request, "invoice", saved.get("id"), {"invoice_number": saved.get("invoice_number")})
    return {"invoice": saved, "next": next_invoice_preview(), "proforma_next": next_proforma_preview(), "storage": storage_name()}


@app.get("/api/invoices")
def list_invoices(user: dict[str, Any] = Depends(require_roles("admin", "gestor", "lectura"))):
    return active_store().list_invoices()


@app.get("/api/invoices/{invoice_id}")
def get_invoice(invoice_id: str, user: dict[str, Any] = Depends(require_roles("admin", "gestor", "lectura"))):
    if False and not isinstance(active_store(), LocalStore):
        raise HTTPException(status_code=501, detail="La edición detallada solo está implementada en modo local JSON.")
    return active_store().get_invoice(invoice_id)


@app.put("/api/invoices/{invoice_id}")
def update_invoice(invoice_id: str, payload: InvoiceUpdateIn, request: Request, user: dict[str, Any] = Depends(require_roles("admin", "gestor"))):
    if False and not isinstance(active_store(), LocalStore):
        raise HTTPException(status_code=501, detail="La edición de facturas solo está implementada en modo local JSON.")
    calculations = calculate_invoice(payload)
    if not payload.client.name.strip():
        raise HTTPException(status_code=400, detail="Selecciona un cliente antes de guardar la factura.")
    if payload.delivery_method == "email" and not payload.client.email.strip():
        raise HTTPException(status_code=400, detail="El cliente no tiene email para usar envio por email.")
    if not calculations["items"]:
        raise HTTPException(status_code=400, detail="Añade al menos una línea de factura.")
    store = active_store()
    current = store.get_invoice(invoice_id)
    invoice = {
        "invoice_type": clean_invoice_type(payload.invoice_type),
        "invoice_number": current.get("invoice_number"),
        "fiscal_year": payload.fiscal_year,
        "sequence": current.get("sequence"),
        "invoice_date": (payload.invoice_date or date.today()).isoformat(),
        "client_id": payload.client.id,
        "client_name": payload.client.name,
        "client_tax_id": payload.client.tax_id,
        "client_address": payload.client.address,
        "client_postal_code": payload.client.postal_code,
        "client_city": payload.client.city,
        "client_email": payload.client.email,
        "payment_method": payload.payment_method,
        "delivery_method": payload.delivery_method,
        "subtotal": calculations["subtotal"],
        "vat_rate": calculations["vat_rate"],
        "vat_amount": calculations["vat_amount"],
        "total": calculations["total"],
        "status": clean_status(payload.status, clean_invoice_type(payload.invoice_type)),
        "notes": payload.notes,
        "sent_by": payload.sent_by,
        "sent_at": payload.sent_at or None,
        "updated_at": datetime.utcnow().isoformat() + "Z",
        "items": calculations["items"],
    }
    saved = store.update_invoice(invoice_id, invoice)
    store.update_client_defaults(payload.client.id, payload.payment_method, payload.delivery_method)
    update_client_price_history(payload.client, calculations["items"])
    audit_log("update", user, request, "invoice", invoice_id, {"invoice_number": saved.get("invoice_number")})
    return {"invoice": saved}


@app.put("/api/invoices/{invoice_id}/status")
def update_invoice_status(invoice_id: str, payload: InvoiceStatusIn, request: Request, user: dict[str, Any] = Depends(require_roles("admin", "gestor"))):
    status = clean_status(payload.status)
    saved = active_store().update_invoice_status(invoice_id, status)
    audit_log("status", user, request, "invoice", invoice_id, {"status": status})
    return saved


@app.delete("/api/invoices/{invoice_id}")
def delete_invoice(invoice_id: str, payload: DeleteInvoiceIn, request: Request, user: dict[str, Any] = Depends(require_roles("admin"))):
    confirmed_user = authenticate_user(payload.username, payload.password, require_admin=True)
    if str(confirmed_user.get("id")) != str(user.get("id")):
        raise HTTPException(status_code=403, detail="Confirma con el mismo usuario de la sesion.")
    result = active_store().delete_invoice(invoice_id, user.get("id"))
    audit_log("delete", user, request, "invoice", invoice_id)
    return result


@app.get("/api/config")
def config(user: dict[str, Any] = Depends(require_roles("admin", "gestor", "lectura"))):
    return {
        "clients": load_clients(),
        "services": load_services(),
        "client_prices": load_client_prices(),
        "users": [public_user(user) for user in load_users()] if user.get("role") == "admin" else [],
        "invoices": active_store().list_invoices(),
        "settings": {**SETTINGS, **next_invoice_preview(), **next_proforma_preview()},
    }


@app.put("/api/config/invoice-counter")
def update_invoice_counter(payload: InvoiceCounterIn, request: Request, user: dict[str, Any] = Depends(require_roles("admin"))):
    prefix = payload.prefix.strip() or "FAC-"
    counter = InvoiceCounterIn(
        fiscal_year=payload.fiscal_year,
        prefix=prefix,
        next_sequence=payload.next_sequence,
    )
    updated = active_store().set_invoice_counter(counter)
    audit_log("update", user, request, "invoice_counter", payload.fiscal_year, updated)
    return {"settings": {**SETTINGS, **updated}, "storage": storage_name()}


@app.post("/api/config/clients")
def create_client(payload: ClientIn, request: Request, user: dict[str, Any] = Depends(require_roles("admin", "gestor"))):
    data = payload.model_dump(exclude_none=True)
    if supabase_store.available():
        saved = supabase_store.save_client(data)
    else:
        saved = upsert_json_row("clients.json", data)
    audit_log("create", user, request, "client", saved.get("id"), {"name": saved.get("name")})
    return saved


@app.put("/api/config/clients/{client_id}")
def update_client(client_id: int, payload: ClientIn, request: Request, user: dict[str, Any] = Depends(require_roles("admin", "gestor"))):
    data = payload.model_dump(exclude_none=True)
    if supabase_store.available():
        saved = supabase_store.save_client(data, client_id)
    else:
        saved = upsert_json_row("clients.json", data, client_id)
    audit_log("update", user, request, "client", client_id, {"name": saved.get("name")})
    return saved


@app.delete("/api/config/clients/{client_id}")
def delete_client(client_id: int, request: Request, user: dict[str, Any] = Depends(require_roles("admin"))):
    if supabase_store.available():
        result = supabase_store.delete_client(client_id)
    else:
        result = delete_json_row("clients.json", client_id)
    audit_log("delete", user, request, "client", client_id)
    return result


@app.post("/api/config/services")
def create_service(payload: ServiceIn, request: Request, user: dict[str, Any] = Depends(require_roles("admin", "gestor"))):
    data = payload.model_dump(exclude_none=True)
    if supabase_store.available():
        saved = supabase_store.save_service(data)
    else:
        saved = upsert_json_row("services.json", data)
    audit_log("create", user, request, "service", saved.get("id"), {"name": saved.get("name")})
    return saved


@app.put("/api/config/services/{service_id}")
def update_service(service_id: int, payload: ServiceIn, request: Request, user: dict[str, Any] = Depends(require_roles("admin", "gestor"))):
    data = payload.model_dump(exclude_none=True)
    if supabase_store.available():
        saved = supabase_store.save_service(data, service_id)
    else:
        saved = upsert_json_row("services.json", data, service_id)
    audit_log("update", user, request, "service", service_id, {"name": saved.get("name")})
    return saved


@app.delete("/api/config/services/{service_id}")
def delete_service(service_id: int, request: Request, user: dict[str, Any] = Depends(require_roles("admin"))):
    if supabase_store.available():
        result = supabase_store.delete_service(service_id)
    else:
        result = delete_json_row("services.json", service_id)
    audit_log("delete", user, request, "service", service_id)
    return result


@app.post("/api/config/users")
def create_user(payload: UserIn, request: Request, user: dict[str, Any] = Depends(require_roles("admin"))):
    new_user = payload.model_dump(exclude_none=True)
    if not new_user.get("password"):
        new_user["password"] = DEFAULT_NEW_USER_PASSWORD
    new_user["password"] = hash_password(new_user["password"])
    if supabase_store.available():
        saved = supabase_store.save_user(new_user)
    else:
        saved = upsert_json_row("users.json", new_user)
    audit_log("create", user, request, "user", saved.get("id"), {"username": saved.get("username")})
    return {k: v for k, v in saved.items() if k != "password"}


@app.put("/api/config/users/{user_id}")
def update_user(user_id: int, payload: UserIn, request: Request, user: dict[str, Any] = Depends(require_roles("admin"))):
    current = next((u for u in load_users() if int(u.get("id") or 0) == int(user_id)), None)
    if current is None:
        raise HTTPException(status_code=404, detail="Usuario no encontrado.")
    saved_user = payload.model_dump(exclude_none=True)
    if not saved_user.get("password"):
        saved_user["password"] = current.get("password", hash_password(DEFAULT_NEW_USER_PASSWORD))
    else:
        saved_user["password"] = hash_password(saved_user["password"])
    if supabase_store.available():
        saved = supabase_store.save_user(saved_user, user_id)
    else:
        saved = upsert_json_row("users.json", saved_user, user_id)
    audit_log("update", user, request, "user", user_id, {"username": saved.get("username")})
    return {k: v for k, v in saved.items() if k != "password"}


@app.delete("/api/config/users/{user_id}")
def delete_user(user_id: int, request: Request, user: dict[str, Any] = Depends(require_roles("admin"))):
    if str(user.get("id")) == str(user_id):
        raise HTTPException(status_code=400, detail="No puedes borrar tu propio usuario.")
    if supabase_store.available():
        result = supabase_store.delete_user(user_id)
    else:
        result = delete_json_row("users.json", user_id)
    audit_log("delete", user, request, "user", user_id)
    return result


@app.get("/api/health")
def health():
    return {"ok": True, "storage": storage_name(), "supabase_configured": supabase_store.configured}
