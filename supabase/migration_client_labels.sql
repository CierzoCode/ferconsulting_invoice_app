-- Migracion necesaria para guardar Provincia y Telefono en las etiquetas A4.
-- Es idempotente: se puede ejecutar varias veces sin perder datos.
begin;

alter table public.clients
  add column if not exists province text,
  add column if not exists phone text;

alter table public.lasheras_clients
  add column if not exists province text,
  add column if not exists phone text;

commit;
notify pgrst, 'reload schema';
