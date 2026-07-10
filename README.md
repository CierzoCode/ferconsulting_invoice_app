# Ferconsulting Invoice App

Proyecto generado desde `Factura Ferconsulting 2026.xlsm` para replicar la hoja de facturación como aplicación web Python + HTML + CSS + JavaScript, preparado para Supabase y Vercel.

## Qué incluye

- Backend FastAPI en `main.py`.
- Frontend en `templates/index.html`, `static/css/styles.css` y `static/js/app.js`.
- Datos exportados del Excel en `data/`:
  - `191` clientes desde la hoja CLIENTES.
  - `95` servicios desde la hoja SERVICIOS.
  - Libreta histórica desde la hoja LIBRETA.
- SQL para Supabase en `supabase/schema.sql` y `supabase/seed.sql`.
- Entrada serverless para Vercel en `api/index.py` y `vercel.json`.
- Análisis de fórmulas y macros en `ANALISIS_EXCEL.md`.

## Ejecución local

```bash
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload
```

Abre `http://127.0.0.1:8000`.

La pantalla inicial permite entrar en **Fer-consulting** o en **FINCAS LASHERAS BLANCO S.L.**. Cada empresa mantiene separados sus maestros, usuarios, numeracion, facturas, lineas, precios y auditoria en Supabase.

La aplicacion funciona exclusivamente con Supabase. Si faltan las variables de conexion o las tablas, devuelve un error de configuracion y no utiliza archivos JSON locales como respaldo.

## Crear tablas en Supabase

1. En Supabase, abre **SQL Editor**.
2. Ejecuta `supabase/schema.sql`.
3. Ejecuta `supabase/seed.sql`.
4. Ejecuta `supabase/lasheras_schema.sql` para crear las tablas independientes de FINCAS LASHERAS BLANCO S.L.
5. Ejecuta `supabase/lasheras_clients_seed.sql` para dar de alta los clientes del Excel de Fincas.
6. Copia `.env.example` a `.env` y rellena:

```bash
SUPABASE_URL=https://tu-proyecto.supabase.co
SUPABASE_SERVICE_ROLE_KEY=tu_service_role_key
INVOICE_PREFIX=FAC-
```

> No publiques `SUPABASE_SERVICE_ROLE_KEY` en el frontend. Esta app solo la usa en servidor.

## Despliegue en Vercel

1. Sube este proyecto a GitHub.
2. Importa el repositorio en Vercel.
3. Configura las variables de entorno `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` e `INVOICE_PREFIX`.
4. Despliega. `vercel.json` dirige todo el tráfico a `api/index.py`, que expone la app FastAPI.

## Equivalencias con el Excel

- Macro `PDF`: botón **1º Crear PDF**, usando `window.print()` con CSS de impresión.
- Macro `REGISTRO`: botón **2º Registrar factura**, que guarda factura, reserva/incrementa número y limpia el formulario.
- Fórmulas de búsqueda: `VLOOKUP` reemplazado por búsqueda de cliente/servicio en JSON o Supabase.
- Fórmulas de totales: implementadas en JavaScript y recalculadas en Python al registrar para evitar inconsistencias.
