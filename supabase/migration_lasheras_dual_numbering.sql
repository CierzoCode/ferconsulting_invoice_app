-- Dos series independientes para las facturas de FINCAS LASHERAS BLANCO:
--   numerica: 125, 126, 127...
--   serie S-: S-1, S-2, S-3...
-- La migracion es idempotente y conserva el siguiente numero de la serie actual.
begin;

create table if not exists public.lasheras_s_invoice_counters
  (like public.invoice_counters including all);

alter table public.lasheras_invoices
  add column if not exists invoice_series text not null default 'numeric';

update public.lasheras_invoices
   set invoice_series = case
     when invoice_number ilike 'S-%' then 's'
     when invoice_type = 'proforma' then 'proforma'
     else 'numeric'
   end;

update public.lasheras_invoice_counters
   set prefix = '', updated_at = now();

insert into public.lasheras_s_invoice_counters(year, prefix, next_sequence)
values (2026, 'S-', 1)
on conflict (year) do nothing;

create or replace function public.reserve_lasheras_invoice_number(p_year integer, p_prefix text default '')
returns table(sequence integer, invoice_number text)
language plpgsql
security definer
as $$
declare
  v_sequence integer;
begin
  insert into public.lasheras_invoice_counters(year, prefix, next_sequence)
  values (p_year, '', 1)
  on conflict (year) do nothing;

  update public.lasheras_invoice_counters
     set next_sequence = next_sequence + 1,
         prefix = '',
         updated_at = now()
   where year = p_year
   returning next_sequence - 1 into v_sequence;

  return query select v_sequence, v_sequence::text;
end;
$$;

create or replace function public.reserve_lasheras_s_invoice_number(p_year integer)
returns table(sequence integer, invoice_number text)
language plpgsql
security definer
as $$
declare
  v_sequence integer;
begin
  insert into public.lasheras_s_invoice_counters(year, prefix, next_sequence)
  values (p_year, 'S-', 1)
  on conflict (year) do nothing;

  update public.lasheras_s_invoice_counters
     set next_sequence = next_sequence + 1,
         prefix = 'S-',
         updated_at = now()
   where year = p_year
   returning next_sequence - 1 into v_sequence;

  return query select v_sequence, 'S-' || v_sequence::text;
end;
$$;

commit;
notify pgrst, 'reload schema';
