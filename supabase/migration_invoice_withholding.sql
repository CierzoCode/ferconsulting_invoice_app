-- Migracion necesaria para registrar el importe de retencion en las facturas.
-- Es idempotente: se puede ejecutar varias veces sin perder datos.
begin;

alter table public.invoices
  add column if not exists withholding_rate numeric(8,4) not null default 0,
  add column if not exists withholding_amount numeric(14,2) not null default 0;

alter table public.lasheras_invoices
  add column if not exists withholding_rate numeric(8,4) not null default 0,
  add column if not exists withholding_amount numeric(14,2) not null default 0;

commit;
notify pgrst, 'reload schema';
