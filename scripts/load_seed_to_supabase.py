"""Carga clientes y servicios a Supabase usando data/*.json.
Requiere variables SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
from supabase import create_client

ROOT = Path(__file__).resolve().parents[1]
url = os.environ['SUPABASE_URL']
key = os.environ['SUPABASE_SERVICE_ROLE_KEY']
sb = create_client(url, key)

for table, file in [('clients', 'clients.json'), ('services', 'services.json')]:
    rows = json.loads((ROOT / 'data' / file).read_text(encoding='utf-8'))
    for start in range(0, len(rows), 500):
        batch = rows[start:start+500]
        sb.table(table).upsert(batch, on_conflict='source_key').execute()
    print(f'{table}: {len(rows)} registros cargados')
