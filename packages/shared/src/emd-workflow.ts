/**
 * EMD & performance security lifecycle (ALL DASHBOARDS → "EMD" and "Performance security" sheets; migration 050).
 *
 * One guarded state machine for every money instrument on a tender — EMD, tender fee, PBG and security deposit:
 *
 *   Requested ──approve──▶ Approved ──issue──▶ Issued ──submit──▶ Submitted ──mark_refund_due──▶ Refund Due ──record_refund──▶ Refunded
 *       │ reject               │ cancel                                                                  (PBG / SD) ──release──▶ Released
 *       ▼                      ▼                      Issued / Submitted / Refund Due ──forfeit──▶ Forfeited, ──mark_expired──▶ Expired
 *    Rejected              Cancelled                  Issued / Submitted / Refund Due ──extend──▶ (same status, later expiry)
 *
 * Who may take each step follows the RBAC spec: Management approves (and alone forfeits), Accounts issues and books
 * the refund (EMD / PBG accounting), the Tender team submits the instrument with the bid (EMD processing).
 *
 * The system also moves instruments when the tender itself moves (see TENDER_STAGE_EFFECTS): a submitted bid carries
 * its issued EMD; a lost / cancelled / internally rejected bid sends paid EMDs to Refund Due and cancels unpaid ones;
 * on a won bid the EMD comes back once the PBG is submitted.
 *
 * The API (POST /tenders/:id/financial-instruments/:instrumentId/transition) and the web forms both read this file, so
 * a button the screen offers is a move the server accepts.
 */
import type { TenderFinancialInstrumentStatus, UserRole } from './enums.js';

type Status = TenderFinancialInstrumentStatus;

export type InstrumentAction =
  | 'approve'
  | 'reject'
  | 'cancel'
  | 'issue'
  | 'submit'
  | 'mark_refund_due'
  | 'record_refund'
  | 'release'
  | 'forfeit'
  | 'extend'
  | 'mark_expired';

/** Facts a step may need. `reason` is stored as the closure reason (reject / cancel / forfeit) or the history note. */
export type InstrumentField =
  | 'amount'
  | 'mode'
  | 'bank'
  | 'reference_number'
  | 'issue_date'
  | 'expiry_date'
  | 'in_favour_of'
  | 'received_date'
  | 'receipt_reference'
  | 'reason';

/** "EMD Form" on the sheet: how the money was put up. */
export const EMD_FORMS = ['Online', 'DD', 'BG', 'FDR', 'Bankers Cheque', 'Insurance Surety Bond'] as const;
export type EmdForm = (typeof EMD_FORMS)[number];

export const EMD_FORM_LABELS: Record<EmdForm, string> = {
  Online: 'Online transfer (NEFT / RTGS / GeM)',
  DD: 'Demand Draft (DD)',
  BG: 'Bank Guarantee (BG)',
  FDR: 'Fixed Deposit Receipt (FDR)',
  'Bankers Cheque': "Banker's Cheque",
  'Insurance Surety Bond': 'Insurance Surety Bond',
};

/** Forms the bank enforces a validity date on — they must carry an expiry, and can be extended. */
export const FORMS_WITH_EXPIRY: readonly string[] = ['DD', 'BG', 'FDR', 'Bankers Cheque', 'Insurance Surety Bond'];
/** Forms drawn on a named bank (an online transfer names its bank optionally). */
export const FORMS_WITH_BANK: readonly string[] = ['DD', 'BG', 'FDR', 'Bankers Cheque'];

/** Instruments the customer returns; a tender fee is spent. */
export const REFUNDABLE_INSTRUMENT_TYPES: readonly string[] = ['EMD', 'PBG', 'Security Deposit'];
/** Performance security: returned ("released") at contract end rather than refunded on the result. */
export const PERFORMANCE_INSTRUMENT_TYPES: readonly string[] = ['PBG', 'Security Deposit'];

/** Money is with the customer (blocked) — expiry matters. */
export const INSTRUMENT_LIVE_STATUSES: readonly Status[] = ['Issued', 'Submitted', 'Refund Due'];
/** Not paid yet. */
export const INSTRUMENT_UNPAID_STATUSES: readonly Status[] = ['Requested', 'Approved'];
/** The record's journey is over. */
export const INSTRUMENT_CLOSED_STATUSES: readonly Status[] = ['Rejected', 'Cancelled', 'Refunded', 'Released', 'Forfeited', 'Expired'];

export interface InstrumentActionDef {
  action: InstrumentAction;
  /** Button / form title. */
  label: string;
  /** Past tense for the history trail ("Approved", "Refund received"). */
  done: string;
  /** What the step means, shown on the form. */
  hint: string;
  from: readonly Status[];
  /** null = the status stays (extend). */
  to: Status | null;
  roles: readonly UserRole[];
  /** Instrument types the step applies to; omitted = every type. */
  types?: readonly string[];
  /** Always-required fields (form-dependent ones come from instrumentActionFields). */
  requires: readonly InstrumentField[];
  /** Fields the form shows (required first, then optional). */
  fields: readonly InstrumentField[];
  tone: 'primary' | 'secondary' | 'danger';
}

const MGMT: UserRole[] = ['management', 'admin'];
const FINANCE: UserRole[] = ['accounts', 'management', 'admin'];
const BID_DESK: UserRole[] = ['tender_team', 'management', 'admin'];

export const INSTRUMENT_ACTIONS: readonly InstrumentActionDef[] = [
  {
    action: 'approve',
    label: 'Approve request',
    done: 'Approved',
    hint: 'Clears the request for Accounts to arrange the money.',
    from: ['Requested'],
    to: 'Approved',
    roles: MGMT,
    requires: ['amount'],
    fields: ['amount', 'mode', 'reason'],
    tone: 'primary',
  },
  {
    action: 'reject',
    label: 'Reject request',
    done: 'Rejected',
    hint: 'Turns the request down. Nothing is paid.',
    from: ['Requested'],
    to: 'Rejected',
    roles: MGMT,
    requires: ['reason'],
    fields: ['reason'],
    tone: 'danger',
  },
  {
    action: 'cancel',
    label: 'Cancel request',
    done: 'Cancelled',
    hint: 'Withdraws a request that was never paid (bid dropped, exemption obtained, raised twice).',
    from: ['Requested', 'Approved'],
    to: 'Cancelled',
    roles: [...BID_DESK, 'accounts'],
    requires: ['reason'],
    fields: ['reason'],
    tone: 'danger',
  },
  {
    action: 'issue',
    label: 'Record issue / payment',
    done: 'Issued',
    hint: 'Accounts has paid or drawn the instrument. Record its number, bank and validity.',
    from: ['Approved'],
    to: 'Issued',
    roles: FINANCE,
    requires: ['amount', 'mode', 'issue_date', 'reference_number'],
    fields: ['amount', 'mode', 'issue_date', 'reference_number', 'bank', 'expiry_date', 'in_favour_of', 'reason'],
    tone: 'primary',
  },
  {
    action: 'submit',
    label: 'Mark submitted with bid',
    done: 'Submitted',
    hint: 'The instrument has gone to the buyer with the bid (uploaded on the portal or handed over).',
    from: ['Issued'],
    to: 'Submitted',
    roles: BID_DESK,
    requires: [],
    fields: ['reason'],
    tone: 'primary',
  },
  {
    action: 'mark_refund_due',
    label: 'Mark refund due',
    done: 'Refund due',
    hint: 'The buyer now owes the money back (bid lost or cancelled, or the PBG is in on a won bid).',
    from: ['Issued', 'Submitted'],
    to: 'Refund Due',
    roles: [...FINANCE, 'tender_team'],
    types: REFUNDABLE_INSTRUMENT_TYPES,
    requires: [],
    fields: ['reason'],
    tone: 'secondary',
  },
  {
    action: 'record_refund',
    label: 'Record refund received',
    done: 'Refund received',
    hint: 'The money is back in our account. Record the day and the credit reference (UTR / returned DD number).',
    from: ['Refund Due'],
    to: 'Refunded',
    roles: FINANCE,
    types: ['EMD'],
    requires: ['received_date', 'receipt_reference'],
    fields: ['received_date', 'receipt_reference', 'reason'],
    tone: 'primary',
  },
  {
    action: 'release',
    label: 'Record released / returned',
    done: 'Released',
    hint: 'The buyer has released the guarantee or returned the deposit at contract end.',
    from: ['Submitted', 'Refund Due'],
    to: 'Released',
    roles: FINANCE,
    types: PERFORMANCE_INSTRUMENT_TYPES,
    requires: ['received_date'],
    fields: ['received_date', 'receipt_reference', 'reason'],
    tone: 'primary',
  },
  {
    action: 'extend',
    label: 'Extend validity',
    done: 'Validity extended',
    hint: 'The bank has renewed the instrument. Record the new expiry date.',
    from: ['Issued', 'Submitted', 'Refund Due'],
    to: null,
    roles: FINANCE,
    requires: ['expiry_date'],
    fields: ['expiry_date', 'reference_number', 'reason'],
    tone: 'secondary',
  },
  {
    action: 'mark_expired',
    label: 'Mark expired',
    done: 'Expired',
    hint: 'The validity lapsed without the instrument being returned; the bank liability has ended.',
    from: ['Issued', 'Submitted', 'Refund Due'],
    to: 'Expired',
    roles: FINANCE,
    requires: ['reason'],
    fields: ['reason'],
    tone: 'secondary',
  },
  {
    action: 'forfeit',
    label: 'Forfeit',
    done: 'Forfeited',
    hint: 'The buyer has kept the money (bid withdrawn, PBG not furnished, contract default).',
    from: ['Issued', 'Submitted', 'Refund Due'],
    to: 'Forfeited',
    roles: MGMT,
    types: REFUNDABLE_INSTRUMENT_TYPES,
    requires: ['reason'],
    fields: ['reason'],
    tone: 'danger',
  },
];

export const INSTRUMENT_FIELD_LABELS: Record<InstrumentField, string> = {
  amount: 'Amount (₹)',
  mode: 'EMD form',
  bank: 'Bank',
  reference_number: 'Instrument / UTR number',
  issue_date: 'Date of issue',
  expiry_date: 'Expiry date',
  in_favour_of: 'In favour of',
  received_date: 'Received back on',
  receipt_reference: 'Credit reference (UTR / returned DD no.)',
  reason: 'Note',
};

/** The instrument facts the machine looks at. */
export interface InstrumentLike {
  instrument_type: string;
  status: string;
  mode?: string | null;
  amount?: number | string | null;
  bank?: string | null;
  reference_number?: string | null;
  in_favour_of?: string | null;
  issue_date?: string | null;
  expiry_date?: string | null;
}

export type InstrumentInput = Partial<Record<InstrumentField, string | number | null | undefined>>;

export function instrumentActionDef(action: string): InstrumentActionDef | undefined {
  return INSTRUMENT_ACTIONS.find((a) => a.action === action);
}

/** Expiry can only be extended on a form that has one. */
const formHasExpiry = (mode: unknown) => FORMS_WITH_EXPIRY.includes(String(mode ?? ''));

/** The steps this role may take on this instrument now. */
export function instrumentActionsFor(inst: InstrumentLike, role: UserRole | string | null | undefined, today?: string): InstrumentActionDef[] {
  if (!role) return [];
  return INSTRUMENT_ACTIONS.filter((a) => {
    if (!a.from.includes(inst.status as Status)) return false;
    if (!(a.roles as readonly string[]).includes(role)) return false;
    if (a.types && !a.types.includes(inst.instrument_type)) return false;
    if (a.action === 'extend' && !formHasExpiry(inst.mode)) return false;
    // "Expired" only once the validity has actually run out.
    if (a.action === 'mark_expired' && (!inst.expiry_date || !today || String(inst.expiry_date).slice(0, 10) >= today)) return false;
    return true;
  });
}

/** Required fields for a step, including the ones the chosen form adds (bank, expiry). */
export function instrumentActionRequired(def: InstrumentActionDef, inst: InstrumentLike, input: InstrumentInput = {}): InstrumentField[] {
  const req = new Set<InstrumentField>(def.requires);
  if (def.action === 'issue') {
    const mode = String(input.mode ?? inst.mode ?? '');
    if (FORMS_WITH_BANK.includes(mode)) req.add('bank');
    if (FORMS_WITH_EXPIRY.includes(mode)) req.add('expiry_date');
  }
  return [...req];
}

const present = (v: unknown) => v !== undefined && v !== null && String(v).trim() !== '';
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Checks a step against the machine: allowed from this status, by this role, for this type, with the facts it needs.
 * Returns the problems in plain words (empty = the step may go ahead).
 */
export function validateInstrumentAction(
  action: string,
  inst: InstrumentLike,
  input: InstrumentInput,
  role: UserRole | string | null | undefined,
  today: string,
): string[] {
  const def = instrumentActionDef(action);
  if (!def) return [`Unknown step "${action}".`];
  if (!def.from.includes(inst.status as Status)) {
    return [`"${def.label}" is not possible while the ${inst.instrument_type} is ${inst.status}.`];
  }
  if (def.types && !def.types.includes(inst.instrument_type)) return [`"${def.label}" does not apply to a ${inst.instrument_type}.`];
  if (!role || !(def.roles as readonly string[]).includes(role)) return [`Your role cannot "${def.label.toLowerCase()}".`];

  const errors: string[] = [];
  // Stored facts, overlaid by whatever the step supplies (an omitted field keeps the stored value).
  const given = Object.fromEntries(Object.entries(input).filter(([, v]) => present(v))) as InstrumentInput;
  const merged: InstrumentInput = {
    amount: inst.amount,
    mode: inst.mode,
    bank: inst.bank,
    reference_number: inst.reference_number,
    in_favour_of: inst.in_favour_of,
    issue_date: inst.issue_date,
    // A new expiry is the point of an extension; the stored one cannot stand in for it.
    expiry_date: def.action === 'extend' ? undefined : inst.expiry_date,
    ...given,
  };
  for (const f of instrumentActionRequired(def, inst, input)) {
    if (!present(merged[f])) errors.push(`${INSTRUMENT_FIELD_LABELS[f]} is required.`);
  }

  if (present(merged.amount) && !(Number(merged.amount) > 0)) errors.push('Amount must be greater than zero.');
  if (present(input.mode) && !(EMD_FORMS as readonly string[]).includes(String(input.mode))) errors.push(`EMD form must be one of: ${EMD_FORMS.join(', ')}.`);
  for (const f of ['issue_date', 'expiry_date', 'received_date'] as const) {
    if (present(input[f]) && !ISO_DAY.test(String(input[f]))) errors.push(`${INSTRUMENT_FIELD_LABELS[f]} must be a date (YYYY-MM-DD).`);
  }
  const issue = present(merged.issue_date) ? String(merged.issue_date).slice(0, 10) : null;
  if (def.action === 'issue' && issue && issue > today) errors.push('Date of issue cannot be in the future.');
  if (present(input.expiry_date) && issue && String(input.expiry_date) <= issue) errors.push('Expiry date must be after the date of issue.');
  if (def.action === 'extend' && present(input.expiry_date) && inst.expiry_date && String(input.expiry_date) <= String(inst.expiry_date).slice(0, 10)) {
    errors.push('The new expiry date must be later than the current one.');
  }
  if (present(input.received_date)) {
    if (String(input.received_date) > today) errors.push('Received date cannot be in the future.');
    if (issue && String(input.received_date) < issue) errors.push('Received date cannot be before the date of issue.');
  }
  if (def.action === 'mark_expired' && (!inst.expiry_date || String(inst.expiry_date).slice(0, 10) >= today)) {
    errors.push('Only an instrument whose expiry date has passed can be marked expired.');
  }
  return errors;
}

/** How an instrument may start: a request, or (Finance only) recording one already paid outside the system. */
export const INSTRUMENT_INITIAL_STATUSES: readonly Status[] = ['Requested', 'Issued', 'Submitted'];
export const INSTRUMENT_RECORD_PAID_ROLES: readonly UserRole[] = FINANCE;

/** Stage names as the tender workflow stores them (upper case), and what each does to the tender's instruments. */
export const TENDER_STAGE_EFFECTS: Record<string, { refundDue?: boolean; cancelUnpaid?: boolean; submitIssued?: boolean; note: string }> = {
  PQ_SUBMITTED: { submitIssued: true, note: 'Submitted with the PQ bid' },
  TENDER_SUBMITTED: { submitIssued: true, note: 'Submitted with the bid' },
  LOST: { refundDue: true, cancelUnpaid: true, note: 'Bid lost' },
  CANCELLED: { refundDue: true, cancelUnpaid: true, note: 'Tender cancelled' },
  REJECTED_INTERNALLY: { refundDue: true, cancelUnpaid: true, note: 'Bid rejected internally' },
};

/** Sheet column "EMD Receiving (Yes/No)": Yes once the money is back, No while it is owed, blank before that. */
export function instrumentReceiving(status: string | null | undefined): 'Yes' | 'No' | '' {
  if (status === 'Refunded' || status === 'Released') return 'Yes';
  if (status === 'Refund Due' || status === 'Expired' || status === 'Forfeited') return 'No';
  return '';
}

/** Display label: a performance security is "released", not "refunded". */
export function instrumentStatusLabel(type: string | null | undefined, status: string | null | undefined): string {
  if (!status) return '—';
  if (status === 'Refund Due' && PERFORMANCE_INSTRUMENT_TYPES.includes(String(type))) return 'Release Due';
  return status;
}

/** The happy path shown as a stepper for each type. */
export function instrumentMainPath(type: string): Status[] {
  if (type === 'Tender Fee') return ['Requested', 'Approved', 'Issued', 'Submitted'];
  if (PERFORMANCE_INSTRUMENT_TYPES.includes(type)) return ['Requested', 'Approved', 'Issued', 'Submitted', 'Released'];
  return ['Requested', 'Approved', 'Issued', 'Submitted', 'Refund Due', 'Refunded'];
}

/** One row of GET /tenders/:id/financial-instruments/:instrumentId/history. */
export interface InstrumentHistoryEntry {
  id: string;
  action: string;
  from_status: string | null;
  to_status: string;
  note: string | null;
  changes: Record<string, { from: unknown; to: unknown }>;
  changed_by: string | null;
  changed_by_name: string | null;
  changed_at: string;
}
