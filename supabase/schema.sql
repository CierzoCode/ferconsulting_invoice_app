-- Supabase schema para la app de facturación Ferconsulting.
-- Ejecutar en SQL Editor antes de seed.sql.
create extension if not exists pgcrypto;

create table if not exists public.invoice_counters (
  year integer primary key,
  prefix text not null default 'FAC-',
  next_sequence integer not null default 1,
  updated_at timestamptz not null default now()
);

create table if not exists public.clients (
  id bigserial primary key,
  source_key text unique,
  source_row integer,
  external_code text,
  name text not null,
  tax_id text,
  address text,
  postal_code text,
  city text,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists clients_name_idx on public.clients using gin (to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(tax_id,'') || ' ' || coalesce(city,'')));

create table if not exists public.services (
  id bigserial primary key,
  source_key text unique,
  source_row integer,
  code text,
  name text not null,
  unit text,
  unit_price numeric(14,4) not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists services_name_idx on public.services using gin (to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(unit,'')));

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_number text not null unique,
  fiscal_year integer not null,
  sequence integer not null,
  invoice_date date not null,
  client_id bigint references public.clients(id),
  client_name text not null,
  client_tax_id text,
  client_address text,
  client_postal_code text,
  client_city text,
  client_email text,
  payment_method text,
  delivery_method text,
  subtotal numeric(14,2) not null default 0,
  vat_rate numeric(8,4) not null default 0.21,
  vat_amount numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,
  status text not null default 'registered',
  notes text,
  sent_by text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create index if not exists invoices_date_idx on public.invoices(invoice_date desc);
create index if not exists invoices_client_idx on public.invoices(client_name);

alter table public.invoices add column if not exists delivery_method text;
alter table public.invoices add column if not exists sent_by text;
alter table public.invoices add column if not exists sent_at timestamptz;
alter table public.invoices add column if not exists updated_at timestamptz;

create table if not exists public.invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  line_number integer not null,
  service_id bigint references public.services(id),
  description text not null,
  quantity numeric(14,3) not null default 0,
  unit text,
  unit_price numeric(14,4) not null default 0,
  discount_rate numeric(8,4) not null default 0,
  amount numeric(14,2) not null default 0,
  created_at timestamptz not null default now()
);

create or replace function public.reserve_invoice_number(p_year integer, p_prefix text default 'FAC-')
returns table(sequence integer, invoice_number text)
language plpgsql
security definer
as $$
declare
  v_sequence integer;
  v_prefix text;
begin
  insert into public.invoice_counters(year, prefix, next_sequence)
  values (p_year, p_prefix, 1)
  on conflict (year) do nothing;

  update public.invoice_counters
     set next_sequence = next_sequence + 1,
         updated_at = now()
   where year = p_year
   returning next_sequence - 1, prefix into v_sequence, v_prefix;

  return query select v_sequence, v_prefix || p_year::text || '.' || v_sequence::text;
end;
$$;

notify pgrst, 'reload schema';
