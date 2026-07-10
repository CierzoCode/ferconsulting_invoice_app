from __future__ import annotations

import re
from pathlib import Path

import openpyxl


BASE_DIR = Path(__file__).resolve().parents[1]
SOURCE = BASE_DIR / "Fincas datos" / "clientes fincas.xlsx"
OUTPUT = BASE_DIR / "supabase" / "lasheras_clients_seed.sql"


def clean(value) -> str:
    return "" if value is None else str(value).strip()


def sql_text(value: str) -> str:
    return "null" if not value else "'" + value.replace("'", "''") + "'"


def split_postal_city(value: str) -> tuple[str, str]:
    value = clean(value)
    if value.upper() == "500280 CALATORAO":
        return "50280", "CALATORAO"
    match = re.match(r"^(\d{4,5})(?:\s+|$)(.*)$", value)
    if not match:
        return "", value
    return match.group(1), match.group(2).strip()


def main() -> None:
    workbook = openpyxl.load_workbook(SOURCE, read_only=True, data_only=True)
    sheet = workbook["Lista de Clientes"]
    records: list[str] = []
    skipped: list[int] = []

    for source_row, row in enumerate(sheet.iter_rows(min_row=2, values_only=True), start=2):
        number, name, address, postal_city, country_code, tax_id = row
        name = clean(name)
        if not name:
            skipped.append(source_row)
            continue
        postal_code, city = split_postal_city(postal_city)
        source_key = f"FINCAS_CLIENTES:{clean(number)}"
        values = (
            sql_text(source_key),
            str(source_row),
            sql_text(clean(number)),
            sql_text(name),
            sql_text(clean(tax_id)),
            sql_text(clean(address)),
            sql_text(postal_code),
            sql_text(city),
            sql_text(clean(country_code)),
        )
        records.append("  (" + ", ".join(values) + ")")

    sql = f"""-- Generado desde: Fincas datos/clientes fincas.xlsx
-- Clientes validos: {len(records)}. Filas omitidas por no tener nombre: {', '.join(map(str, skipped))}.
begin;

insert into public.lasheras_clients
  (source_key, source_row, external_code, name, tax_id, address, postal_code, city, country_code)
values
{',\n'.join(records)}
on conflict (source_key) do update set
  source_row = excluded.source_row,
  external_code = excluded.external_code,
  name = excluded.name,
  tax_id = excluded.tax_id,
  address = excluded.address,
  postal_code = excluded.postal_code,
  city = excluded.city,
  country_code = excluded.country_code,
  updated_at = now();

select setval(
  'public.lasheras_clients_id_seq',
  greatest((select coalesce(max(id), 1) from public.lasheras_clients), 1)
);

commit;
"""
    OUTPUT.write_text(sql, encoding="utf-8")
    print(f"Generados {len(records)} clientes en {OUTPUT}")


if __name__ == "__main__":
    main()
