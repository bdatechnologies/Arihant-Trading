'use client';

/**
 * One EMD / PBG / security deposit / tender fee and its workflow (packages/shared/src/emd-workflow.ts): where it is on
 * its path, the steps the signed-in role may take now (each with the facts it needs), and its append-only trail.
 * Used by the Finance & EMD desk and the tender dossier, so both offer exactly the moves the API accepts.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { BadgeCheck, Banknote, CircleDollarSign, FileCheck, Hourglass, RotateCcw, Send, ShieldCheck } from 'lucide-react';
import {
  EMD_FORMS,
  EMD_FORM_LABELS,
  INSTRUMENT_ACTIONS,
  INSTRUMENT_FIELD_LABELS,
  formatINR,
  instrumentActionRequired,
  instrumentActionsFor,
  instrumentMainPath,
  instrumentReceiving,
  instrumentStatusLabel,
  validateInstrumentAction,
  type InstrumentActionDef,
  type InstrumentField,
  type InstrumentHistoryEntry,
  type InstrumentInput,
} from '@arihant/shared';
import { api } from '@/lib/api';
import { istToday } from '@/lib/ist-date';
import { Badge, Button, InfoCallout, Input, Modal, Select, Spinner, StepTrack, Textarea, formatDateIN, type TrackStep } from '@/components/ui';

export interface InstrumentRecord {
  id: string;
  tender_id: string;
  instrument_type: string;
  status: string;
  amount?: number | string | null;
  mode?: string | null;
  bank?: string | null;
  reference_number?: string | null;
  issue_date?: string | null;
  expiry_date?: string | null;
  in_favour_of?: string | null;
  required_by?: string | null;
  received_date?: string | null;
  receipt_reference?: string | null;
  closure_reason?: string | null;
  remarks?: string | null;
  requested_by_name?: string | null;
  approved_by_name?: string | null;
  issued_by_name?: string | null;
  updated_at?: string | null;
  tender_number?: string | null;
  tender_no?: string | null;
}

/** A DATE column arrives as an instant (local midnight): its IST calendar day. */
export const istDayOf = (v: unknown): string | null => {
  if (!v) return null;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
};

const ROLE_LABELS: Record<string, string> = {
  management: 'Management',
  admin: 'Admin',
  accounts: 'Accounts',
  tender_team: 'Tender team',
  regional_manager: 'Regional manager',
};

const STEP_ICONS: Record<string, TrackStep['icon']> = {
  Requested: Hourglass,
  Approved: BadgeCheck,
  Issued: Banknote,
  Submitted: Send,
  'Refund Due': RotateCcw,
  Refunded: CircleDollarSign,
  Released: ShieldCheck,
};

const ACTION_LABELS: Record<string, string> = {
  request: 'Requested',
  record: 'Recorded as paid',
  edit: 'Details corrected',
  auto_submit: 'Submitted with the bid (automatic)',
  auto_refund_due: 'Refund due (automatic)',
  auto_cancel: 'Cancelled (automatic)',
  ...Object.fromEntries(INSTRUMENT_ACTIONS.map((a) => [a.action, a.done])),
};

const CHANGE_LABELS: Record<string, string> = {
  ...INSTRUMENT_FIELD_LABELS,
  closure_reason: 'Reason',
  refund_due_on: 'Refund due from',
  extension_count: 'Extensions',
  approved_by: 'Approved by',
  issued_by: 'Issued by',
  required_by: 'Needed by',
  remarks: 'Remarks',
  finance_owner_id: 'Finance owner',
};

export function instrumentTone(status?: string | null): 'success' | 'warning' | 'danger' | 'default' | 'outline' {
  if (status === 'Refunded' || status === 'Released') return 'success';
  if (status === 'Refund Due' || status === 'Requested' || status === 'Approved') return 'warning';
  if (status === 'Forfeited' || status === 'Rejected') return 'danger';
  if (status === 'Cancelled' || status === 'Expired') return 'outline';
  return 'default';
}

const money = (v: unknown) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? '—' : formatINR(Number(v)));
const day = (v: unknown) => (istDayOf(v) ? formatDateIN(istDayOf(v)!) : '—');
const errorText = (err: any, fallback: string) => {
  const m = err?.message ?? err?.data?.message;
  return Array.isArray(m) ? m.join(', ') : m || fallback;
};

/** Pre-fills a step's form from the stored facts (dates as IST days). */
function initialForm(def: InstrumentActionDef, inst: InstrumentRecord): Record<InstrumentField, string> {
  const today = istToday();
  const f = {} as Record<InstrumentField, string>;
  for (const field of def.fields) {
    if (field === 'reason') f.reason = '';
    else if (field === 'issue_date') f.issue_date = istDayOf(inst.issue_date) || today;
    else if (field === 'received_date') f.received_date = today;
    else if (field === 'expiry_date') f.expiry_date = def.action === 'extend' ? '' : istDayOf(inst.expiry_date) || '';
    else if (field === 'amount') f.amount = inst.amount === null || inst.amount === undefined ? '' : String(Number(inst.amount));
    else if (field === 'mode') f.mode = inst.mode || 'Online';
    else f[field] = String((inst as any)[field] ?? '');
  }
  return f;
}

export const InstrumentWorkflowModal: React.FC<{
  instrument: InstrumentRecord | null;
  role: string | undefined;
  onClose: () => void;
  /** After a step is saved (the caller reloads its list / dossier). */
  onChanged: () => void;
}> = ({ instrument: inst, role, onClose, onChanged }) => {
  const today = istToday();
  const [history, setHistory] = useState<InstrumentHistoryEntry[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [active, setActive] = useState<InstrumentActionDef | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shape = useMemo(
    () =>
      inst
        ? { ...inst, issue_date: istDayOf(inst.issue_date), expiry_date: istDayOf(inst.expiry_date) }
        : null,
    [inst],
  );
  const actions = useMemo(() => (shape ? instrumentActionsFor(shape, role, today) : []), [shape, role, today]);

  useEffect(() => {
    setActive(null);
    setError(null);
    setHistory(null);
    setHistoryError(null);
    if (!inst) return;
    let live = true;
    api
      .get(`/tenders/${inst.tender_id}/financial-instruments/${inst.id}/history`)
      .then((rows: InstrumentHistoryEntry[]) => live && setHistory(Array.isArray(rows) ? rows : []))
      .catch((err: any) => live && setHistoryError(errorText(err, 'Could not load the history.')));
    return () => {
      live = false;
    };
  }, [inst]);

  if (!inst || !shape) return null;

  const path = instrumentMainPath(inst.instrument_type);
  const onPath = path.indexOf(inst.status as any);
  const steps: TrackStep[] = path.map((s) => ({ key: s, label: instrumentStatusLabel(inst.instrument_type, s), icon: STEP_ICONS[s] ?? FileCheck }));
  const offPath = onPath < 0;
  const isLast = onPath === path.length - 1;
  // Who acts next when this role has nothing to do here.
  const waitingOn = [
    ...new Set(
      INSTRUMENT_ACTIONS.filter((a) => a.from.includes(inst.status as any) && (!a.types || a.types.includes(inst.instrument_type)) && a.tone === 'primary').flatMap(
        (a) => a.roles.filter((r) => r !== 'admin').map((r) => ROLE_LABELS[r] ?? r),
      ),
    ),
  ];

  const input: InstrumentInput = Object.fromEntries(
    Object.entries(form).map(([k, v]) => [k, k === 'amount' ? (v.trim() === '' ? undefined : Number(v)) : v.trim() || undefined]),
  );
  const required = active ? instrumentActionRequired(active, shape, input) : [];
  const problems = active ? validateInstrumentAction(active.action, shape, input, role, today) : [];

  const start = (def: InstrumentActionDef) => {
    setActive(def);
    setForm(initialForm(def, inst));
    setError(null);
  };

  const save = async () => {
    if (!active) return;
    if (problems.length) {
      setError(problems.join(' '));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.post(`/tenders/${inst.tender_id}/financial-instruments/${inst.id}/transition`, {
        action: active.action,
        ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
        expected_updated_at: inst.updated_at || undefined,
      });
      onChanged();
      onClose();
    } catch (err: any) {
      setError(errorText(err, 'The step was not saved.'));
    } finally {
      setSaving(false);
    }
  };

  const field = (f: InstrumentField) => {
    const label = INSTRUMENT_FIELD_LABELS[f];
    const req = required.includes(f);
    const set = (v: string) => setForm((prev) => ({ ...prev, [f]: v }));
    if (f === 'reason') {
      const needed = active?.requires.includes('reason');
      return (
        <Textarea
          key={f}
          label={needed ? 'Reason' : 'Note (optional)'}
          required={needed}
          rows={2}
          value={form.reason ?? ''}
          onChange={(e) => set(e.target.value)}
          placeholder={needed ? 'Why — it goes on the record' : 'Anything the next person should know'}
        />
      );
    }
    if (f === 'mode') {
      return (
        <Select
          key={f}
          label={label}
          required={req}
          value={form.mode ?? ''}
          onChange={(e) => set(e.target.value)}
          searchable={false}
          options={EMD_FORMS.map((m) => ({ value: m, label: EMD_FORM_LABELS[m] }))}
        />
      );
    }
    const isDate = f === 'issue_date' || f === 'expiry_date' || f === 'received_date';
    return (
      <Input
        key={f}
        label={label}
        required={req}
        type={isDate ? 'date' : f === 'amount' ? 'number' : 'text'}
        min={f === 'amount' ? '1' : f === 'expiry_date' ? form.issue_date || istDayOf(inst.issue_date) || undefined : undefined}
        max={f === 'issue_date' || f === 'received_date' ? today : undefined}
        value={form[f] ?? ''}
        onChange={(e) => set(e.target.value)}
        className={f === 'reference_number' || f === 'receipt_reference' || f === 'amount' ? 'font-mono' : undefined}
        helperText={
          f === 'expiry_date' && active?.action === 'extend' && inst.expiry_date
            ? `Currently ${day(inst.expiry_date)}`
            : f === 'bank' && req
              ? 'A DD, BG, FDR or banker’s cheque names its bank.'
              : undefined
        }
      />
    );
  };

  const receiving = instrumentReceiving(inst.status);
  const facts: [string, React.ReactNode][] = [
    ['Amount', <span className="font-mono font-semibold text-[#14213D]">{money(inst.amount)}</span>],
    ['EMD form', inst.mode ? EMD_FORM_LABELS[inst.mode as keyof typeof EMD_FORM_LABELS] ?? inst.mode : '—'],
    ['Bank', inst.bank || '—'],
    ['Instrument / UTR no.', <span className="font-mono">{inst.reference_number || '—'}</span>],
    ['Date of issue', day(inst.issue_date)],
    ['Expiry', day(inst.expiry_date)],
    ['In favour of', inst.in_favour_of || '—'],
    ['Needed by', day(inst.required_by)],
    ['Received back', receiving === 'Yes' ? `${day(inst.received_date)}${inst.receipt_reference ? ` · ${inst.receipt_reference}` : ''}` : receiving || '—'],
  ];

  return (
    <Modal
      isOpen
      onClose={saving ? () => {} : onClose}
      title={`${inst.instrument_type} · ${inst.tender_number || inst.tender_no || 'Tender'}`}
      description="Each step records who did it and when. Steps you cannot take are done by the role shown."
      maxWidth="2xl"
    >
      <div className="space-y-5 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={instrumentTone(inst.status)} size="sm">
            {instrumentStatusLabel(inst.instrument_type, inst.status)}
          </Badge>
          {inst.closure_reason && <span className="text-[#4A5568]">Reason: {inst.closure_reason}</span>}
        </div>

        <StepTrack
          steps={steps}
          current={offPath ? -1 : onPath}
          complete={isLast}
          tone={inst.status === 'Requested' || inst.status === 'Approved' || inst.status === 'Refund Due' ? 'warning' : 'primary'}
          label={`${inst.instrument_type} progress`}
        />
        {offPath && (
          <InfoCallout variant={inst.status === 'Forfeited' || inst.status === 'Rejected' ? 'danger' : 'neutral'} title={`Closed: ${inst.status}`}>
            This {inst.instrument_type} left the usual path{inst.closure_reason ? ` — ${inst.closure_reason}` : ''}.
          </InfoCallout>
        )}

        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 rounded-[14px] border border-[#ECE9E2] bg-[#FBFAF7] p-3 sm:grid-cols-3">
          {facts.map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-[10px] font-semibold uppercase tracking-wider text-[#6B7280]">{k}</dt>
              <dd className="truncate text-[#14213D]">{v}</dd>
            </div>
          ))}
        </dl>

        {active ? (
          <div className="space-y-3 rounded-[14px] border border-[#DCD8CE] bg-white p-4">
            <div>
              <p className="font-serif text-sm font-semibold text-[#14213D]">{active.label}</p>
              <p className="text-[11px] text-[#4A5568]">{active.hint}</p>
            </div>
            {error && (
              <InfoCallout variant="danger" title="Not saved" onClose={() => setError(null)}>
                {error}
              </InfoCallout>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{active.fields.filter((f) => f !== 'reason').map(field)}</div>
            {active.fields.includes('reason') && field('reason')}
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[#ECE9E2] pt-3">
              <Button variant="outline" size="sm" onClick={() => setActive(null)} disabled={saving}>
                Back
              </Button>
              <Button variant={active.tone === 'danger' ? 'danger' : 'primary'} size="sm" onClick={save} isLoading={saving} disabled={problems.length > 0}>
                {active.label}
              </Button>
            </div>
            {problems.length > 0 && <p className="text-right text-[11px] text-[#4A5568]">{problems[0]}</p>}
          </div>
        ) : actions.length ? (
          <div className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-[#4A5568]">Next step</p>
            <div className="flex flex-wrap gap-2">
              {actions.map((a) => (
                <Button
                  key={a.action}
                  size="sm"
                  variant={a.tone === 'primary' ? 'primary' : a.tone === 'danger' ? 'outline' : 'secondary'}
                  className={a.tone === 'danger' ? 'text-[#881337]' : undefined}
                  onClick={() => start(a)}
                >
                  {a.label}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          <InfoCallout variant="neutral" title={waitingOn.length ? 'Waiting on another team' : 'Nothing left to do'}>
            {waitingOn.length
              ? `The next step is for ${waitingOn.join(' / ')}.`
              : `This ${inst.instrument_type} is ${instrumentStatusLabel(inst.instrument_type, inst.status).toLowerCase()}; its record is complete.`}
          </InfoCallout>
        )}

        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-[#4A5568]">History</p>
          {historyError ? (
            <InfoCallout variant="danger">{historyError}</InfoCallout>
          ) : !history ? (
            <div className="flex items-center gap-2 text-[#4A5568]">
              <Spinner size="xs" /> Loading history…
            </div>
          ) : history.length === 0 ? (
            <p className="text-[#6B7280]">No steps recorded yet.</p>
          ) : (
            <ol className="space-y-2 border-l border-[#DCD8CE] pl-4">
              {history
                .slice()
                .reverse()
                .map((h) => {
                  const changes = Object.entries(h.changes || {}).filter(([k]) => !['approved_by', 'issued_by', 'extension_count'].includes(k));
                  return (
                    <li key={h.id} className="relative">
                      <span aria-hidden className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full border-2 border-white bg-[#0F5E63]" />
                      <p className="text-[#14213D]">
                        <span className="font-semibold">{ACTION_LABELS[h.action] ?? h.action}</span>
                        {h.from_status !== h.to_status && h.from_status && (
                          <span className="text-[#4A5568]">
                            {' '}
                            · {instrumentStatusLabel(inst.instrument_type, h.from_status)} → {instrumentStatusLabel(inst.instrument_type, h.to_status)}
                          </span>
                        )}
                      </p>
                      <p className="text-[11px] text-[#6B7280]">
                        {h.changed_by_name || 'System'} ·{' '}
                        <span className="font-mono">
                          {new Date(h.changed_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}
                        </span>
                      </p>
                      {h.note && <p className="mt-0.5 text-[#4A5568]">“{h.note}”</p>}
                      {changes.length > 0 && (
                        <p className="mt-0.5 text-[11px] text-[#4A5568]">
                          {changes
                            .map(([k, v]) => `${CHANGE_LABELS[k] ?? k}: ${v.to === null || v.to === '' ? '—' : String(v.to)}`)
                            .join(' · ')}
                        </p>
                      )}
                    </li>
                  );
                })}
            </ol>
          )}
        </div>
      </div>
    </Modal>
  );
};

