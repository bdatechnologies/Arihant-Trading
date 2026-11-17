-- Down 050: drop the EMD workflow trail and columns; Rejected / Cancelled instruments fall back to Forfeited / Expired
-- so the old status check can be restored.
drop trigger if exists trg_tender_fin_instrument_history_immutable on tender_financial_instrument_history;
drop function if exists tender_fin_instrument_history_immutable();
drop table if exists tender_financial_instrument_history;
drop index if exists idx_tender_fin_instruments_live_expiry;

update tender_financial_instruments set status = 'Expired' where status in ('Rejected', 'Cancelled');
alter table tender_financial_instruments drop constraint if exists tender_financial_instruments_status_check;
alter table tender_financial_instruments add constraint tender_financial_instruments_status_check
  check (status in ('Requested', 'Approved', 'Issued', 'Submitted', 'Refund Due', 'Refunded', 'Forfeited', 'Released', 'Expired'));

alter table tender_financial_instruments
  drop column if exists requested_by,
  drop column if exists required_by,
  drop column if exists in_favour_of,
  drop column if exists approved_by,
  drop column if exists approved_at,
  drop column if exists issued_by,
  drop column if exists issued_at,
  drop column if exists submitted_at,
  drop column if exists refund_due_on,
  drop column if exists received_date,
  drop column if exists receipt_reference,
  drop column if exists closure_reason,
  drop column if exists extension_count;
