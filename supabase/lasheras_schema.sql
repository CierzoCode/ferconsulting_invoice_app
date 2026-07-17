-- Tablas independientes para FINCAS LASHERAS BLANCO S.L.
-- Ejecutar despues de supabase/schema.sql.
begin;

create table if not exists public.lasheras_invoice_counters
  (like public.invoice_counters including all);
create table if not exists public.lasheras_proforma_counters
  (like public.proforma_counters including all);
create table if not exists public.lasheras_clients
  (like public.clients including all);
alter table public.lasheras_clients add column if not exists country_code text;
create table if not exists public.lasheras_services
  (like public.services including all);
create table if not exists public.lasheras_users
  (like public.users including all);

create sequence if not exists public.lasheras_clients_id_seq;
alter sequence public.lasheras_clients_id_seq owned by public.lasheras_clients.id;
alter table public.lasheras_clients alter column id set default nextval('public.lasheras_clients_id_seq');

create sequence if not exists public.lasheras_services_id_seq;
alter sequence public.lasheras_services_id_seq owned by public.lasheras_services.id;
alter table public.lasheras_services alter column id set default nextval('public.lasheras_services_id_seq');

create sequence if not exists public.lasheras_users_id_seq;
alter sequence public.lasheras_users_id_seq owned by public.lasheras_users.id;
alter table public.lasheras_users alter column id set default nextval('public.lasheras_users_id_seq');

create table if not exists public.lasheras_client_prices
  (like public.client_prices including all);
create sequence if not exists public.lasheras_client_prices_id_seq;
alter sequence public.lasheras_client_prices_id_seq owned by public.lasheras_client_prices.id;
alter table public.lasheras_client_prices alter column id set default nextval('public.lasheras_client_prices_id_seq');

create table if not exists public.lasheras_invoices
  (like public.invoices including all);
alter table public.lasheras_invoices add column if not exists withholding_rate numeric(8,4) not null default 0;
alter table public.lasheras_invoices add column if not exists withholding_amount numeric(14,2) not null default 0;
create table if not exists public.lasheras_audit_log
  (like public.audit_log including all);
create table if not exists public.lasheras_invoice_items
  (like public.invoice_items including all);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'lasheras_client_prices_client_fk') then
    alter table public.lasheras_client_prices add constraint lasheras_client_prices_client_fk foreign key (client_id) references public.lasheras_clients(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'lasheras_client_prices_service_fk') then
    alter table public.lasheras_client_prices add constraint lasheras_client_prices_service_fk foreign key (service_id) references public.lasheras_services(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'lasheras_invoices_client_fk') then
    alter table public.lasheras_invoices add constraint lasheras_invoices_client_fk foreign key (client_id) references public.lasheras_clients(id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'lasheras_invoices_deleted_by_fk') then
    alter table public.lasheras_invoices add constraint lasheras_invoices_deleted_by_fk foreign key (deleted_by) references public.lasheras_users(id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'lasheras_audit_log_user_fk') then
    alter table public.lasheras_audit_log add constraint lasheras_audit_log_user_fk foreign key (user_id) references public.lasheras_users(id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'lasheras_invoice_items_invoice_fk') then
    alter table public.lasheras_invoice_items add constraint lasheras_invoice_items_invoice_fk foreign key (invoice_id) references public.lasheras_invoices(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'lasheras_invoice_items_service_fk') then
    alter table public.lasheras_invoice_items add constraint lasheras_invoice_items_service_fk foreign key (service_id) references public.lasheras_services(id);
  end if;
end $$;

create or replace function public.reserve_lasheras_invoice_number(p_year integer, p_prefix text default 'FAC-')
returns table(sequence integer, invoice_number text)
language plpgsql
security definer
as $$
declare
  v_sequence integer;
  v_prefix text;
begin
  insert into public.lasheras_invoice_counters(year, prefix, next_sequence)
  values (p_year, p_prefix, 1)
  on conflict (year) do nothing;

  update public.lasheras_invoice_counters
     set next_sequence = next_sequence + 1, updated_at = now()
   where year = p_year
   returning next_sequence - 1, prefix into v_sequence, v_prefix;

  return query select v_sequence, v_prefix || p_year::text || '.' || v_sequence::text;
end;
$$;

create or replace function public.reserve_lasheras_proforma_number(p_year integer, p_prefix text default 'PRO-')
returns table(sequence integer, invoice_number text)
language plpgsql
security definer
as $$
declare
  v_sequence integer;
  v_prefix text;
begin
  insert into public.lasheras_proforma_counters(year, prefix, next_sequence)
  values (p_year, p_prefix, 1)
  on conflict (year) do nothing;

  update public.lasheras_proforma_counters
     set next_sequence = next_sequence + 1, prefix = p_prefix, updated_at = now()
   where year = p_year
   returning next_sequence - 1, prefix into v_sequence, v_prefix;

  return query select v_sequence, v_prefix || p_year::text || '.' || v_sequence::text;
end;
$$;

insert into public.lasheras_invoice_counters(year, prefix, next_sequence)
values (2026, 'FAC-', 104) on conflict (year) do update
set next_sequence = greatest(public.lasheras_invoice_counters.next_sequence, excluded.next_sequence), updated_at = now();
insert into public.lasheras_proforma_counters(year, prefix, next_sequence)
values (2026, 'PRO-', 1) on conflict (year) do nothing;
insert into public.lasheras_users(id, username, password, email, role, active)
values (1, 'Admin', 'pbkdf2_sha256$bwL6NSzDTrymn1K8fC14/Q==$YQLfo9ihvPeuEvsr7mZMpU2NDH5PhNoIUe41bOL8U4w=', '', 'admin', true)
on conflict (username) do nothing;
select setval('public.lasheras_users_id_seq', greatest((select coalesce(max(id), 1) from public.lasheras_users), 1));

commit;
notify pgrst, 'reload schema';
