from __future__ import annotations

import json
import os
from copy import deepcopy
from datetime import date, datetime
from pathlib import Path
from typing import Any, Optional
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request
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


class InvoiceItemIn(BaseModel):
    service_id: Optional[int] = None
    description: str = ""
    quantity: float = 0
    unit: str = ""
    unit_price: float = 0
    discount_rate: float = Field(default=0, ge=0, le=1)


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
        return "" if value is None else value


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


class LoginIn(BaseModel):
    username: str
    password: str


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
        return "" if value is None else value


class ServiceIn(BaseModel):
    id: Optional[int] = None
    code: str = ""
    name: str
    unit: str = ""
    unit_price: float = 0
    active: bool = True


class UserIn(BaseModel):
    id: Optional[int] = None
    username: str
    password: str = ""
    email: str = ""
    role: str = "admin"
    active: bool = True


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


def default_admin_user() -> dict[str, Any]:
    return {
        "id": 1,
        "username": "Admin",
        "password": "1234",
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
        return list(reversed(read_json("local_invoices.json", [])))

    def get_invoice(self, invoice_id: str) -> dict[str, Any]:
        for invoice in read_json("local_invoices.json", []):
            if invoice.get("id") == invoice_id:
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
        result = self.client().table("invoices").select("*").order("created_at", desc=True).limit(50).execute()
        return result.data or []

    def get_invoice(self, invoice_id: str) -> dict[str, Any]:
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


@app.get("/api/bootstrap")
def bootstrap():
    return {
        "company": COMPANY,
        "settings": {**SETTINGS, **next_invoice_preview(), **next_proforma_preview()},
        "clients": load_clients(),
        "services": load_services(),
        "client_prices": load_client_prices(),
        "users": [{k: v for k, v in user.items() if k != "password"} for user in load_users()],
        "storage": storage_name(),
    }


@app.post("/api/login")
def login(payload: LoginIn):
    username = payload.username.strip().casefold()
    for user in load_users():
        if user.get("active", True) and user.get("username", "").casefold() == username and user.get("password") == payload.password:
            safe_user = {k: v for k, v in user.items() if k != "password"}
            return {"ok": True, "user": safe_user}
    raise HTTPException(status_code=401, detail="Usuario o contraseña incorrectos.")


@app.get("/api/clients")
def clients(q: str = ""):
    data = load_clients()
    if q:
        qn = q.casefold()
        data = [c for c in data if qn in (c.get("name", "") + " " + c.get("tax_id", "") + " " + c.get("city", "")).casefold()]
    return data[:100]


@app.get("/api/services")
def services(q: str = ""):
    data = load_services()
    if q:
        qn = q.casefold()
        data = [s for s in data if qn in (s.get("name", "") + " " + s.get("unit", "")).casefold()]
    return data[:100]


@app.post("/api/calculate")
def calculate(payload: InvoiceIn):
    return calculate_invoice(payload)


@app.post("/api/invoices")
def create_invoice(payload: InvoiceIn):
    calculations = calculate_invoice(payload)
    if not payload.client.name.strip():
        raise HTTPException(status_code=400, detail="Selecciona un cliente antes de registrar la factura.")
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
    return {"invoice": saved, "next": next_invoice_preview(), "proforma_next": next_proforma_preview(), "storage": storage_name()}


@app.get("/api/invoices")
def list_invoices():
    return active_store().list_invoices()


@app.get("/api/invoices/{invoice_id}")
def get_invoice(invoice_id: str):
    if False and not isinstance(active_store(), LocalStore):
        raise HTTPException(status_code=501, detail="La edición detallada solo está implementada en modo local JSON.")
    return active_store().get_invoice(invoice_id)


@app.put("/api/invoices/{invoice_id}")
def update_invoice(invoice_id: str, payload: InvoiceUpdateIn):
    if False and not isinstance(active_store(), LocalStore):
        raise HTTPException(status_code=501, detail="La edición de facturas solo está implementada en modo local JSON.")
    calculations = calculate_invoice(payload)
    if not payload.client.name.strip():
        raise HTTPException(status_code=400, detail="Selecciona un cliente antes de guardar la factura.")
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
    return {"invoice": saved}


@app.put("/api/invoices/{invoice_id}/status")
def update_invoice_status(invoice_id: str, payload: InvoiceStatusIn):
    status = clean_status(payload.status)
    return active_store().update_invoice_status(invoice_id, status)


@app.get("/api/config")
def config():
    return {
        "clients": load_clients(),
        "services": load_services(),
        "client_prices": load_client_prices(),
        "users": [{k: v for k, v in user.items() if k != "password"} for user in load_users()],
        "invoices": active_store().list_invoices(),
        "settings": {**SETTINGS, **next_invoice_preview(), **next_proforma_preview()},
    }


@app.put("/api/config/invoice-counter")
def update_invoice_counter(payload: InvoiceCounterIn):
    prefix = payload.prefix.strip() or "FAC-"
    counter = InvoiceCounterIn(
        fiscal_year=payload.fiscal_year,
        prefix=prefix,
        next_sequence=payload.next_sequence,
    )
    updated = active_store().set_invoice_counter(counter)
    return {"settings": {**SETTINGS, **updated}, "storage": storage_name()}


@app.post("/api/config/clients")
def create_client(payload: ClientIn):
    data = payload.model_dump(exclude_none=True)
    if supabase_store.available():
        return supabase_store.save_client(data)
    return upsert_json_row("clients.json", data)


@app.put("/api/config/clients/{client_id}")
def update_client(client_id: int, payload: ClientIn):
    data = payload.model_dump(exclude_none=True)
    if supabase_store.available():
        return supabase_store.save_client(data, client_id)
    return upsert_json_row("clients.json", data, client_id)


@app.delete("/api/config/clients/{client_id}")
def delete_client(client_id: int):
    if supabase_store.available():
        return supabase_store.delete_client(client_id)
    return delete_json_row("clients.json", client_id)


@app.post("/api/config/services")
def create_service(payload: ServiceIn):
    data = payload.model_dump(exclude_none=True)
    if supabase_store.available():
        return supabase_store.save_service(data)
    return upsert_json_row("services.json", data)


@app.put("/api/config/services/{service_id}")
def update_service(service_id: int, payload: ServiceIn):
    data = payload.model_dump(exclude_none=True)
    if supabase_store.available():
        return supabase_store.save_service(data, service_id)
    return upsert_json_row("services.json", data, service_id)


@app.delete("/api/config/services/{service_id}")
def delete_service(service_id: int):
    if supabase_store.available():
        return supabase_store.delete_service(service_id)
    return delete_json_row("services.json", service_id)


@app.post("/api/config/users")
def create_user(payload: UserIn):
    user = payload.model_dump(exclude_none=True)
    if not user.get("password"):
        user["password"] = "1234"
    if supabase_store.available():
        saved = supabase_store.save_user(user)
    else:
        saved = upsert_json_row("users.json", user)
    return {k: v for k, v in saved.items() if k != "password"}


@app.put("/api/config/users/{user_id}")
def update_user(user_id: int, payload: UserIn):
    current = next((u for u in load_users() if int(u.get("id") or 0) == int(user_id)), None)
    if current is None:
        raise HTTPException(status_code=404, detail="Usuario no encontrado.")
    user = payload.model_dump(exclude_none=True)
    if not user.get("password"):
        user["password"] = current.get("password", "1234")
    if supabase_store.available():
        saved = supabase_store.save_user(user, user_id)
    else:
        saved = upsert_json_row("users.json", user, user_id)
    return {k: v for k, v in saved.items() if k != "password"}


@app.delete("/api/config/users/{user_id}")
def delete_user(user_id: int):
    if supabase_store.available():
        return supabase_store.delete_user(user_id)
    return delete_json_row("users.json", user_id)


@app.get("/api/health")
def health():
    return {"ok": True, "storage": storage_name(), "supabase_configured": supabase_store.configured}
