'use client';

import React, { useState, useCallback, useRef } from 'react';
import {
  Card,
  Button,
  Badge,
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
  InfoCallout,
  Spinner,
  RecordViews,
  RecordTable,
  type RecordItem,
  type RecordTone,
  type BoardLane,
} from '@/components/ui';
import { IndianRupee, Clock, AlertTriangle, ExternalLink, FileCheck, Hourglass } from 'lucide-react';
import { api } from '@/lib/api';
import { istToday } from '@/lib/ist-date';
import { useInfiniteList } from '@/lib/use-infinite-list';
import {
  formatTaskDate,
  instrumentActionsFor,
  instrumentStatusLabel,
  TENDER_FINANCIAL_INSTRUMENT_STATUSES,
} from '@arihant/shared';
import { InstrumentWorkflowModal, instrumentTone, istDayOf, type InstrumentRecord } from './InstrumentWorkflowModal';

interface FinanceEmdViewProps {
  currentUser: any;
  onOpenDossier: (tenderId: string) => void;
}

/** Instruments fetched per page while the list scrolls. */
const EMD_PAGE_SIZE = 25;

/** The view picked above the list; GET /tenders/finance/emd-tracking filters by it (`filter`). */
type EmdFilter = 'action' | 'expiring' | 'refund_due' | 'blocked' | 'pbg' | 'all';

/**
 * Page 1 of GET /tenders/finance/emd-tracking also carries the KPI totals and each view's count, summed over every
 * instrument in scope (never over the rows loaded so far).
 */
interface EmdSummary {
  total_emd_blocked: number;
  total_refund_due: number;
  total_pbg_held: number;
  refund_due_count: number;
  refund_aging_over_30_count: number;
  active_pbg_count: number;
  action_count: number;
  expiring_count: number;
  counts: Record<EmdFilter, number>;
}

/** Board lanes: one per instrument status. */
const STATUS_LANES: BoardLane[] = TENDER_FINANCIAL_INSTRUMENT_STATUSES.map((s) => ({ key: s, label: s, tone: statusTone(s) }));

function statusTone(status?: string | null): RecordTone {
  if (status === 'Refund Due' || status === 'Requested' || status === 'Approved') return 'warning';
  if (status === 'Refunded' || status === 'Released') return 'success';
  if (status === 'Forfeited' || status === 'Rejected') return 'danger';
  return 'neutral';
}

const errorText = (err: any, fallback: string) => {
  const m = err?.message ?? err?.data?.message;
  return Array.isArray(m) ? m.join(', ') : m || fallback;
};

export function FinanceEmdView({
  currentUser,
  onOpenDossier,
}: FinanceEmdViewProps) {
  const [data, setData] = useState<EmdSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<EmdFilter>('action');

  // Accounts can't load a tender (GET /tenders/:id), so the tender number is plain text for them.
  const canOpenDossier = currentUser?.role !== 'accounts';
  const role: string | undefined = currentUser?.role;
  const today = istToday();
  /** Steps this role may take on an instrument now (the shared EMD workflow). */
  const stepsFor = (inst: any) =>
    instrumentActionsFor({ ...inst, issue_date: istDayOf(inst.issue_date), expiry_date: istDayOf(inst.expiry_date) }, role, today);

  // The instrument whose workflow dialog is open.
  const [selectedInstrument, setSelectedInstrument] = useState<InstrumentRecord | null>(null);

  // The picked view's instruments, one page per request, appended as the list scrolls (the server filters by view).
  // Page 1 also carries the KPI totals; the hook swallows fetch errors, so page 1 reports its own here. An answer for
  // a view the user has already left must not overwrite the current view's totals or error.
  const shownFilter = useRef(filterType);
  shownFilter.current = filterType;
  const fetchInstrumentsPage = useCallback(
    async (page: number) => {
      try {
        const res = await api.get('/tenders/finance/emd-tracking', { page, limit: EMD_PAGE_SIZE, filter: filterType });
        if (page === 1 && shownFilter.current === filterType) {
          setData(res && typeof res === 'object' ? res : null);
          setError(null);
        }
        return res;
      } catch (err: any) {
        console.error('Failed to load finance EMD tracking:', err);
        if (page === 1 && shownFilter.current === filterType) setError(errorText(err, 'Could not load Finance EMD tracking.'));
        throw err;
      }
    },
    [filterType],
  );
  const instruments = useInfiniteList<any>(fetchInstrumentsPage);
  const { rows: displayedList, total: displayedTotal, loading, refresh: loadData } = instruments;

  const handleOpenStatusModal = (inst: any) => setSelectedInstrument(inst as InstrumentRecord);

  const formatCurrency = (val: number | null | undefined) => {
    if (val === null || val === undefined || isNaN(val)) return '—';
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 0,
    }).format(val);
  };

  const counts = data?.counts;
  const viewLabel: Record<EmdFilter, string> = {
    action: 'waiting on approval or payment',
    expiring: 'expiring within 30 days',
    refund_due: 'refunds due',
    blocked: 'active EMDs',
    pbg: 'performance securities',
    all: 'instruments',
  };

  // The loaded instruments as RecordViews items (phone list, Cards, Board); the table below shows the same rows.
  const instrumentRecords: RecordItem[] = displayedList.map((inst: any) => {
    const refundDue = inst.status === 'Refund Due';
    const daysPending = typeof inst.days_pending === 'number' ? inst.days_pending : null;
    return {
      key: inst.id,
      code: inst.tender_number || inst.tender_no || 'Tender',
      title: `${inst.instrument_type} · ${inst.organisation_name || 'Department'}`,
      subtitle: [inst.mode || 'Online', inst.bank].filter(Boolean).join(' · '),
      status: { label: instrumentStatusLabel(inst.instrument_type, inst.status), tone: statusTone(inst.status) },
      badges:
        refundDue && daysPending !== null
          ? [{ label: `${daysPending} day${daysPending === 1 ? '' : 's'} pending`, tone: daysPending > 30 ? 'danger' : 'warning' }]
          : undefined,
      due:
        !refundDue && inst.expiry_date
          ? { date: istDayOf(inst.expiry_date) || inst.expiry_date, label: 'Expires', done: !['Issued', 'Submitted'].includes(inst.status) }
          : undefined,
      value: formatCurrency(inst.amount),
      facts: [
        { label: 'Reference No.', value: inst.reference_number || '—' },
        { label: 'Requested by', value: inst.requested_by_name || '—' },
        { label: 'Remarks', value: inst.closure_reason || inst.remarks || '—' },
      ],
      primary: { label: stepsFor(inst).length ? 'Next step' : 'View', onClick: () => handleOpenStatusModal(inst) },
      onOpen: canOpenDossier && inst.tender_id ? () => onOpenDossier(inst.tender_id) : undefined,
    };
  });
  const statusById = new Map<string, string>(displayedList.map((inst: any) => [inst.id, inst.status]));

  const instrumentTable = (
    <Table>
      <TableHeader>
        <TableRow className="bg-[#FBFAF7]">
          <TableHead>Tender & Buyer</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Mode / Bank</TableHead>
          <TableHead>Reference No.</TableHead>
          <TableHead>Amount</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Aging / Expiry</TableHead>
          <TableHead className="text-right">Action</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {displayedList.map((inst: any) => {
          // Refund aging is computed by the server from when the instrument entered Refund Due.
          const daysPending =
            typeof inst.days_pending === 'number' ? inst.days_pending : null;

          return (
            <TableRow key={inst.id} className="hover:bg-[#FBFAF7]">
              <TableCell>
                <div className="space-y-0.5">
                  {canOpenDossier && inst.tender_id ? (
                    <button
                      onClick={() => onOpenDossier(inst.tender_id)}
                      className="font-mono text-xs font-semibold text-[#0F5E63] hover:underline text-left"
                    >
                      {inst.tender_number || inst.tender_no || 'Tender'}
                    </button>
                  ) : (
                    <span className="font-mono text-xs font-semibold text-[#14213D]">
                      {inst.tender_number || inst.tender_no || 'Tender'}
                    </span>
                  )}
                  <div className="text-[11px] text-[#4A5568] truncate max-w-[200px]">
                    {inst.organisation_name || 'Department'}
                  </div>
                </div>
              </TableCell>

              <TableCell>
                <Badge
                  variant={
                    inst.instrument_type === 'EMD'
                      ? 'default'
                      : inst.instrument_type === 'PBG'
                        ? 'cyber'
                        : 'outline'
                  }
                  size="sm"
                >
                  {inst.instrument_type}
                </Badge>
              </TableCell>

              <TableCell className="text-xs">
                <div className="font-medium text-[#14213D]">
                  {inst.mode || 'Online'}
                </div>
                <div className="text-[10px] text-[#4A5568]">
                  {inst.bank || '—'}
                </div>
              </TableCell>

              <TableCell className="text-xs text-[#4A5568]">
                <div className="font-mono">{inst.reference_number || '—'}</div>
                {inst.remarks && (
                  <div className="text-[10px] text-[#6B7280] truncate max-w-[180px]" title={inst.remarks}>
                    {inst.remarks}
                  </div>
                )}
              </TableCell>

              <TableCell className="font-mono text-xs font-semibold text-[#14213D]">
                {formatCurrency(inst.amount)}
              </TableCell>

              <TableCell>
                <Badge variant={instrumentTone(inst.status)} size="sm">
                  {instrumentStatusLabel(inst.instrument_type, inst.status)}
                </Badge>
                {(inst.status === 'Requested' || inst.status === 'Approved') && inst.required_by && (
                  <div className="mt-0.5 text-[10px] text-[#6B7280]">Needed by {formatTaskDate(istDayOf(inst.required_by) || inst.required_by)}</div>
                )}
              </TableCell>

              <TableCell className="text-xs">
                {inst.status === 'Refund Due' ? (
                  daysPending !== null ? (
                    <span
                      className={`font-semibold ${
                        daysPending > 30 ? 'text-[#700F2D]' : 'text-[#7C2D12]'
                      }`}
                      title={`Days since this instrument moved to Refund Due${inst.aging_bucket ? ` (${inst.aging_bucket})` : ''}`}
                    >
                      <span className="font-mono">{daysPending}</span> day{daysPending === 1 ? '' : 's'} pending
                    </span>
                  ) : (
                    <span className="text-[#6B7280]">Refund due</span>
                  )
                ) : inst.expiry_date ? (
                  <span className="font-mono text-[#4A5568]">
                    Exp: {formatTaskDate(istDayOf(inst.expiry_date) || inst.expiry_date)}
                    {typeof inst.days_to_expiry === 'number' && inst.days_to_expiry <= 30 && ['Issued', 'Submitted'].includes(inst.status) && (
                      <span className={`ml-1 font-semibold ${inst.days_to_expiry < 0 ? 'text-[#881337]' : 'text-[#9A3412]'}`}>
                        ({inst.days_to_expiry < 0 ? 'lapsed' : `${inst.days_to_expiry}d`})
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="text-[#6B7280]">—</span>
                )}
              </TableCell>

              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-1.5">
                  <Button size="xs" variant={stepsFor(inst).length ? 'primary' : 'outline'} onClick={() => handleOpenStatusModal(inst)}>
                    {stepsFor(inst).length ? 'Next step' : 'View'}
                  </Button>
                  {canOpenDossier && inst.tender_id && (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => onOpenDossier(inst.tender_id)}
                      aria-label="Open tender dossier"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-5 rounded-[14px] bg-white border border-[#DCD8CE] shadow-sm">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="p-2 rounded-lg bg-[#E3EFEE] text-[#0F5E63]">
              <IndianRupee className="w-5 h-5" />
            </span>
            <h2 className="text-xl font-serif font-bold text-[#14213D]">
              Finance & Tender Security Repository
            </h2>
          </div>
          <p className="text-xs text-[#4A5568]">
            Bank guarantees, EMD deposit recovery, refund aging schedules, and tender fee accounting.
          </p>
        </div>

      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="p-4 bg-white border-[#DCD8CE]">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold text-[#4A5568] uppercase tracking-wider">
              Total EMD Blocked
            </span>
            <span className="p-1.5 rounded-lg bg-[#E3EFEE] text-[#0F5E63]">
              <IndianRupee className="w-4 h-4" />
            </span>
          </div>
          <div className="mt-2 text-2xl font-serif font-bold font-mono text-[#0F5E63]">
            {formatCurrency(data?.total_emd_blocked || 0)}
          </div>
          <p className="mt-1 text-[11px] text-[#4A5568]">
            Actively committed in submitted tenders
          </p>
        </Card>

        <Card className="p-4 bg-white border-[#DCD8CE]">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold text-[#4A5568] uppercase tracking-wider">
              Refunds Due
            </span>
            <span className="p-1.5 rounded-lg bg-[#FBEBDD] text-[#9A3412]">
              <Clock className="w-4 h-4" />
            </span>
          </div>
          <div className="mt-2 text-2xl font-serif font-bold font-mono text-[#9A3412]">
            {formatCurrency(data?.total_refund_due || 0)}
          </div>
          <p className="mt-1 text-[11px] text-[#4A5568]">
            {data?.refund_due_count || 0} awaiting recovery
            {data?.refund_aging_over_30_count ? <span className="text-[#881337] font-medium"> · {data.refund_aging_over_30_count} over 30 days</span> : null}
          </p>
        </Card>

        <Card className="p-4 bg-white border-[#DCD8CE]">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold text-[#4A5568] uppercase tracking-wider">
              Waiting on someone
            </span>
            <span className="p-1.5 rounded-lg bg-[#FFF8EB] text-[#A15C07]">
              <Hourglass className="w-4 h-4" />
            </span>
          </div>
          <div className="mt-2 text-2xl font-serif font-bold font-mono text-[#14213D]">
            {data?.action_count || 0}
          </div>
          <p className="mt-1 text-[11px] text-[#4A5568]">
            Requests awaiting approval or payment
          </p>
        </Card>

        <Card className="p-4 bg-white border-[#DCD8CE]">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold text-[#4A5568] uppercase tracking-wider">
              Performance security held
            </span>
            <span className="p-1.5 rounded-lg bg-[#ECE9E2] text-[#14213D]">
              <FileCheck className="w-4 h-4" />
            </span>
          </div>
          <div className="mt-2 text-2xl font-serif font-bold font-mono text-[#14213D]">
            {formatCurrency(data?.total_pbg_held || 0)}
          </div>
          <p className="mt-1 text-[11px] text-[#4A5568]">
            {data?.active_pbg_count || 0} PBG / security deposits with buyers
          </p>
        </Card>
      </div>

      {((data?.expiring_count || 0) > 0 || (data?.refund_aging_over_30_count || 0) > 0) && (
        <InfoCallout variant="warning" title="Needs follow-up">
          {[
            data?.expiring_count ? `${data.expiring_count} instrument${data.expiring_count === 1 ? '' : 's'} with buyers expire within 30 days (or have lapsed)` : null,
            data?.refund_aging_over_30_count ? `${data.refund_aging_over_30_count} EMD refund${data.refund_aging_over_30_count === 1 ? '' : 's'} pending over 30 days` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
          .
        </InfoCallout>
      )}

      {/* Filter Segmented Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-1 bg-white p-1 rounded-lg border border-[#DCD8CE]">
          {(
            [
              ['action', 'Needs action', data?.action_count],
              ['expiring', 'Expiring', data?.expiring_count],
              ['refund_due', 'Refunds due', data?.refund_due_count],
              ['blocked', 'Active EMDs', counts?.blocked],
              ['pbg', 'PBG / security', counts?.pbg],
              ['all', 'All', counts?.all],
            ] as [EmdFilter, string, number | undefined][]
          ).map(([key, label, n]) => (
            <button
              key={key}
              onClick={() => setFilterType(key)}
              aria-pressed={filterType === key}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                filterType === key ? 'bg-[#0F5E63] text-white shadow-sm' : 'text-[#4A5568] hover:text-[#14213D]'
              }`}
            >
              {label}
              {typeof n === 'number' ? ` (${n})` : ''}
            </button>
          ))}
        </div>
      </div>

      {/* Instruments: one page at a time, the next page loads as the list scrolls. A newly picked view shows the loader
          rather than the previous view's rows until its first page arrives. */}
      {loading ? (
        <Card className="p-12 flex items-center justify-center gap-2 text-sm text-[#4A5568] bg-white border-[#DCD8CE]">
          <Spinner size="xs" />
          Loading financial records...
        </Card>
      ) : error ? (
        <InfoCallout variant="danger" title="Error">
          {error}
        </InfoCallout>
      ) : displayedList.length === 0 ? (
        <Card className="p-12 text-center text-xs text-[#4A5568] bg-white border-[#DCD8CE]">
          No instruments found for this category filter.
        </Card>
      ) : (
        <RecordViews
          storageKey="tender-finance-emd"
          defaultView="list"
          items={instrumentRecords}
          lanes={STATUS_LANES}
          laneOf={(i) => statusById.get(i.key) || 'Requested'}
          list={<RecordTable items={instrumentRecords}>{instrumentTable}</RecordTable>}
          summary={
            <>
              <strong className="text-[#14213D]">{displayedList.length}</strong> of{' '}
              <strong className="text-[#14213D]">{displayedTotal}</strong> {viewLabel[filterType]}
            </>
          }
          empty="No instruments found for this category filter."
          onLoadMore={instruments.loadMore}
          hasMore={instruments.hasMore}
          loadingMore={instruments.loadingMore}
        />
      )}

      <InstrumentWorkflowModal
        instrument={selectedInstrument}
        role={role}
        onClose={() => setSelectedInstrument(null)}
        onChanged={() => void loadData()}
      />
    </div>
  );
}
