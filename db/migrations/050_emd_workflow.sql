-- =====================================================================
-- Migration 050: EMD & performance security workflow (ALL DASHBOARDS sheet → "EMD" / "Performance security")
--
-- tender_financial_instruments held a free-text status anyone with edit rights could set to any value. EMDs, PBGs
-- and security deposits now follow one guarded lifecycle (packages/shared/src/emd-workflow.ts):
--
--   Requested → Approved → Issued → Submitted → Refund Due → Refunded / Released
--        ↘ Rejected   ↘ Cancelled (never paid)        ↘ Forfeited / Expired
--
-- Each step records who did it and the facts it needs (issue date, UTR / DD / BG number, bank, expiry, refund
-- receipt), and writes one row to tender_financial_instrument_history — an append-only trail (UPDATE is refused).
-- Idempotent: safe to re-run.
-- =====================================================================

-- 1. Two closing states for money that was never paid: an approver turned the request down, or the bid was
--    dropped / lost before the EMD went out.
alter table tender_financial_instruments drop constraint if exists tender_financial_instruments_status_check;
alter table tender_financial_instruments add constraint tender_financial_instruments_status_check
  check (status in ('Requested', 'Approved', 'Rejected', 'Cancelled', 'Issued', 'Submitted', 'Refund Due', 'Refunded', 'Forfeited', 'Released', 'Expired'));

-- 2. Who did each step, and the facts each step needs.
alter table tender_financial_instruments add column if not exists requested_by uuid references users(id);
-- The day the instrument must be in hand (the bid closing day for an EMD, the LoA deadline for a PBG).
alter table tender_financial_instruments add column if not exists required_by date;
-- Beneficiary the DD / BG / FDR is drawn in favour of (e.g. "PAO, CRPF, New Delhi").
alter table tender_financial_instruments add column if not exists in_favour_of text;
alter table tender_financial_instruments add column if not exists approved_by uuid references users(id);
alter table tender_financial_instruments add column if not exists approved_at timestamptz;
alter table tender_financial_instruments add column if not exists issued_by uuid references users(id);
alter table tender_financial_instruments add column if not exists issued_at timestamptz;
alter table tender_financial_instruments add column if not exists submitted_at timestamptz;
-- IST day the money fell due back to us (bid lost / cancelled, or PBG submitted on a won bid). Refund ageing runs from it.
alter table tender_financial_instruments add column if not exists refund_due_on date;
-- The money came back (EMD refunded to our account, BG returned / released): "EMD Receiving = Yes".
alter table tender_financial_instruments add column if not exists received_date date;
alter table tender_financial_instruments add column if not exists receipt_reference text;
-- Why a request was rejected or cancelled, or why the money was forfeited.
alter table tender_financial_instruments add column if not exists closure_reason text;
alter table tender_financial_instruments add column if not exists extension_count integer not null default 0;

create index if not exists idx_tender_fin_instruments_live_expiry
  on tender_financial_instruments (expiry_date)
  where status in ('Issued', 'Submitted', 'Refund Due');

-- 3. Append-only lifecycle trail.
create table if not exists tender_financial_instrument_history (
  id            uuid primary key default gen_random_uuid(),
  instrument_id uuid not null references tender_financial_instruments(id) on delete cascade,
  tender_id     uuid not null references tenders(id) on delete cascade,
  -- Workflow action code (request, approve, issue, submit, mark_refund_due, record_refund, release, forfeit, extend,
  -- mark_expired, reject, cancel, edit) or 'auto_*' for a move the system made from the tender's own stage.
  action        text not null,
  from_status   text,
  to_status     text not null,
  note          text,
  -- Fields the step set: { field: { from, to } }.
  changes       jsonb not null default '{}'::jsonb,
  -- NULL when the system made the move (tender lost / cancelled / submitted, PBG submitted on a won bid).
  changed_by    uuid references users(id),
  changed_at    timestamptz not null default now()
);

create index if not exists idx_tender_fin_instrument_history_iid on tender_financial_instrument_history (instrument_id, changed_at);
create index if not exists idx_tender_fin_instrument_history_tid on tender_financial_instrument_history (tender_id, changed_at desc);

create or replace function tender_fin_instrument_history_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'tender_financial_instrument_history is append-only';
end;
$$;

drop trigger if exists trg_tender_fin_instrument_history_immutable on tender_financial_instrument_history;
create trigger trg_tender_fin_instrument_history_immutable
  before update on tender_financial_instrument_history
  for each row execute function tender_fin_instrument_history_immutable();

-- 4. Backfill: refund ageing start for instruments already due back, and one opening history row per instrument so
--    every trail starts at the record's creation.
update tender_financial_instruments i
   set refund_due_on = coalesce(t.result_date, (i.updated_at at time zone 'Asia/Kolkata')::date)
  from tenders t
 where t.id = i.tender_id
   and i.status = 'Refund Due'
   and i.refund_due_on is null;

update tender_financial_instruments
   set received_date = (updated_at at time zone 'Asia/Kolkata')::date
 where status in ('Refunded', 'Released')
   and received_date is null;

insert into tender_financial_instrument_history (instrument_id, tender_id, action, from_status, to_status, note, changed_at)
select i.id, i.tender_id, 'request', null, i.status, 'Recorded before the EMD workflow (migration 050)', i.created_at
  from tender_financial_instruments i
 where not exists (select 1 from tender_financial_instrument_history h where h.instrument_id = i.id);
