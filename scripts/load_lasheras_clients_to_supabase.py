from __future__ import annotations

import os

from dotenv import load_dotenv
from supabase import create_client

from generate_lasheras_clients_seed import SOURCE, clean, split_postal_city

import openpyxl


def main() -> None:
    load_dotenv(SOURCE.parents[1] / ".env")
    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    supabase = create_client(url, key)

    try:
        supabase.table("lasheras_clients").select("id,country_code").limit(1).execute()
        supports_country = True
    except Exception:
        supports_country = False

    workbook = openpyxl.load_workbook(SOURCE, read_only=True, data_only=True)
    sheet = workbook["Lista de Clientes"]
    clients: list[dict] = []
    skipped: list[int] = []

    for source_row, row in enumerate(sheet.iter_rows(min_row=2, values_only=True), start=2):
        number, name, address, postal_city, country_code, tax_id = row
        name = clean(name)
        if not name:
            skipped.append(source_row)
            continue
        postal_code, city = split_postal_city(postal_city)
        client = {
            "source_key": f"FINCAS_CLIENTES:{clean(number)}",
            "source_row": source_row,
            "external_code": clean(number) or None,
            "name": name,
            "tax_id": clean(tax_id) or None,
            "address": clean(address) or None,
            "postal_code": postal_code or None,
            "city": city or None,
        }
        if supports_country:
            client["country_code"] = clean(country_code) or None
        clients.append(client)

    for start in range(0, len(clients), 200):
        supabase.table("lasheras_clients").upsert(
            clients[start:start + 200], on_conflict="source_key"
        ).execute()

    result = supabase.table("lasheras_clients").select("id", count="exact").limit(1).execute()
    print(f"Clientes enviados: {len(clients)}")
    print(f"Clientes en Supabase: {result.count}")
    print(f"Filas omitidas sin nombre: {', '.join(map(str, skipped))}")
    if not supports_country:
        print("Aviso: country_code se cargara al ejecutar la migracion y volver a lanzar este script.")


if __name__ == "__main__":
    main()
