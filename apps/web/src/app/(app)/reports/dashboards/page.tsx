'use client';

/**
 * Report 7 — Dashboards (GET /reports/sheets/:key): the client's "ALL DASHBOARDS" workbook, one sheet at a time, with
 * the workbook's own column headings, filled live from the records BOS already holds. Every sheet exports to CSV with
 * the same headings, so the familiar Excel layout comes straight out of the system — nothing is re-typed.
 */
import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ChevronDown, Download, FileSpreadsheet, RefreshCw } from 'lucide-react';
import {
  SHEETS,
  SHEET_GROUP_LABELS,
  TENDER_FINANCIAL_INSTRUMENT_STATUSES,
  canViewSheet,
  formatINR,
  type SheetCell,
  type SheetColumn,
  type SheetDto,
  type SheetGroup,
  type SheetKey,
} from '@arihant/shared';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';
import {
  Badge,
  Button,
  Card,
  InfoCallout,
  Input,
  PageContainer,
  PageHeader,
  PageLoader,
  Pagination,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toneFor,
} from '@/components/ui';
import { PhoneRows, ReportFilterBar, ReportsDenied, canOpen, downloadCsv, fmtDay, useReport, useReportFilters, type PhoneRow } from '../_lib/report-ui';

const EXTRA_KEYS = ['sheet', 'search', 'status', 'page'] as const;
const PAGE_SIZE = 50;
const EXPORT_LIMIT = 2000;

const BADGE_TONE: Record<string, 'success' | 'warning' | 'danger' | 'default' | 'outline'> = {
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  info: 'default',
  neutral: 'outline',
};

/** A cell as text — the screen and the CSV show the same value. */
function cellText(c: SheetColumn, v: SheetCell): string {
  if (v === null || v === undefined || v === '') return '';
  switch (c.kind) {
    case 'money':
      return formatINR(Number(v));
    case 'number':
      return Number(v).toLocaleString('en-IN');
    case 'percent':
      return `${v}%`;
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? fmtDay(String(v)) : String(v);
    default:
      return String(v);
  }
}

/** CSV value: numbers stay numbers (so Excel can sum them), dates stay ISO. */
function csvValue(c: SheetColumn, v: SheetCell): string | number | null {
  if (v === null || v === undefined) return null;
  if (c.kind === 'money' || c.kind === 'number' || c.kind === 'percent') return Number(v);
  return String(v);
}

const firstOf = (cols: SheetColumn[], cells: Record<string, SheetCell>, keys: string[]) => {
  for (const k of keys) {
    const c = cols.find((x) => x.key === k);
    const v = c ? cellText(c, cells[k]) : '';
    // "Indian Army / Indian Army" (customer and department the same) reads once
    if (v) return v.replace(/^(.+?) \/ \1$/, '$1');
  }
  return '';
};
const shortLabel = (c: SheetColumn) => (c.label.length <= 10 ? c.label : c.kind === 'money' ? 'Amount' : c.kind === 'number' ? 'Qty' : c.kind === 'percent' ? 'Rate' : c.label.slice(0, 10));

/**
 * A workbook row as one phone line: who (customer / department), what (item), then person · zone · reference; the
 * status and the main amount (or quantity) on the right. MIS sheets (figures per zone / person / product) show the
 * name and their first three figures. Tapping opens the record, or shows every column when the row has none.
 */
function sheetPhoneRow(cols: SheetColumn[], r: SheetDto['rows'][number], mis: boolean, open: (href: string) => void): PhoneRow {
  const details = cols.map((c) => [c.label, cellText(c, r.cells[c.key]) || '—'] as const);
  if (mis) {
    const figs = cols.filter((c) => c.kind === 'number' || c.kind === 'percent' || c.kind === 'money').slice(0, 3);
    return {
      key: r.id,
      title: firstOf(cols, r.cells, ['label']) || '—',
      sub: firstOf(cols, r.cells, ['sub']) || undefined,
      figures: figs.map((c) => ({ label: shortLabel(c), value: cellText(c, r.cells[c.key]) || '0' })),
      details,
    };
  }
  const status = cols.find((c) => c.kind === 'status');
  const statusText = status ? cellText(status, r.cells[status.key]) : '';
  const amount = cols.find((c) => c.kind === 'money' && Number(r.cells[c.key]) > 0) ?? cols.find((c) => c.kind === 'number' && Number(r.cells[c.key]) > 0);
  return {
    key: r.id,
    title: firstOf(cols, r.cells, ['customer', 'department', 'employee', 'location']) || '—',
    sub: firstOf(cols, r.cells, ['item', 'equipment', 'description', 'type', 'complaint']) || undefined,
    meta:
      [
        firstOf(cols, r.cells, ['person', 'engineer', 'conducted_by']),
        firstOf(cols, r.cells, ['zone']),
        firstOf(cols, r.cells, ['bid_no', 'po_no', 'quotation_no', 'ticket_no']),
      ]
        .filter(Boolean)
        .join(' · ') || undefined,
    badge: statusText ? (
      <Badge variant={BADGE_TONE[toneFor(statusText)] ?? 'outline'} size="sm">
        {statusText}
      </Badge>
    ) : undefined,
    figures: amount ? [{ label: shortLabel(amount), value: cellText(amount, r.cells[amount.key]) }] : undefined,
    onOpen: r.link ? () => open(r.link!) : undefined,
    details: r.link ? undefined : details,
  };
}

const Cell: React.FC<{ col: SheetColumn; value: SheetCell }> = ({ col, value }) => {
  const text = cellText(col, value);
  if (!text) return <span className="text-[#6B7280]">—</span>;
  if (col.kind === 'status') {
    return (
      <Badge variant={BADGE_TONE[toneFor(text)] ?? 'outline'} size="sm">
        {text}
      </Badge>
    );
  }
  if (col.kind === 'yesno') {
    return <span className={`font-semibold ${text === 'Yes' ? 'text-[#0F5E63]' : 'text-[#9A3412]'}`}>{text}</span>;
  }
  if (col.kind === 'money' || col.kind === 'number' || col.kind === 'percent' || col.kind === 'date') {
    return <span className="whitespace-nowrap font-mono">{text}</span>;
  }
  return (
    <span className="line-clamp-2 min-w-[8rem] max-w-[22rem]" title={text}>
      {text}
    </span>
  );
};

/**
 * The workbook's sheets behind one button: the current sheet and its group, opening every sheet grouped the way the
 * workbook groups them (four columns on a wide screen, one on a phone).
 */
const SheetPicker: React.FC<{
  groups: { g: SheetGroup; items: (typeof SHEETS)[number][] }[];
  current: (typeof SHEETS)[number];
  onPick: (key: SheetKey) => void;
}> = ({ groups, current, onPick }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="flex w-full items-center gap-3 rounded-[14px] border border-[#DCD8CE] bg-white p-3 text-left shadow-2xs transition-colors hover:border-[#0F5E63] sm:w-auto sm:min-w-[340px]"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#E3EFEE] text-[#0F5E63]">
          <FileSpreadsheet className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[10px] font-semibold uppercase tracking-wider text-[#6B7280]">{SHEET_GROUP_LABELS[current.group]}</span>
          <span className="block truncate font-serif text-base font-semibold text-[#14213D]">{current.title}</span>
        </span>
        <span className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-[#C9C4B8] px-2.5 py-1.5 text-[11px] font-semibold text-[#0F5E63]">
          Change sheet
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Workbook sheets"
          className="absolute left-0 z-40 mt-2 max-h-[70vh] w-[min(920px,calc(100vw-32px))] overflow-y-auto rounded-[14px] border border-[#DCD8CE] bg-white p-3 shadow-lg custom-scrollbar"
        >
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {groups.map(({ g, items }) => (
              <div key={g}>
                <p className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#6B7280]">{SHEET_GROUP_LABELS[g]}</p>
                <ul className="space-y-0.5">
                  {items.map((sh) => {
                    const on = sh.key === current.key;
                    return (
                      <li key={sh.key}>
                        <button
                          type="button"
                          onClick={() => {
                            onPick(sh.key);
                            setOpen(false);
                          }}
                          aria-current={on ? 'page' : undefined}
                          className={`flex min-h-10 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                            on ? 'bg-[#E3EFEE] font-semibold text-[#0F5E63]' : 'text-[#14213D] hover:bg-[#FBFAF7]'
                          }`}
                        >
                          <span className="flex h-4 w-4 shrink-0 items-center justify-center">{on && <Check className="h-3.5 w-3.5" />}</span>
                          <span className="min-w-0 flex-1">{sh.title}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

function DashboardSheets() {
  const router = useRouter();
  const { user } = useAuth();
  const allowed = canOpen(user?.role, 'sheets');
  const filters = useReportFilters(EXTRA_KEYS);
  const sheets = useMemo(() => SHEETS.filter((s) => canViewSheet(user?.role, s.key)), [user?.role]);
  const def = sheets.find((s) => s.key === filters.values.sheet) ?? sheets[0];
  const isRegister = def ? def.period_basis === null : false;
  const instrumentSheet = def?.key === 'emd' || def?.key === 'performance_security';
  const page = Math.max(1, Number(filters.values.page) || 1);
  const [searchDraft, setSearchDraft] = useState(filters.values.search ?? '');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const query = useMemo(() => {
    const q: Record<string, string> = { ...filters.query, from: filters.from, to: filters.to, page: String(page), limit: String(PAGE_SIZE) };
    delete q.sheet;
    if (!instrumentSheet) delete q.status;
    return q;
  }, [filters.query, filters.from, filters.to, page, instrumentSheet]);
  const { data, loading, error, reload } = useReport<SheetDto>(`/reports/sheets/${def?.key ?? 'tenders'}`, query, allowed && !!def && !filters.invalid);
  // A response for the sheet on screen (the previous sheet's rows never show under a new sheet's headings).
  const shown = data && def && data.key === def.key ? data : null;

  if (!user) return <PageLoader rows={4} label="Loading dashboards" />;
  if (!allowed || !def) {
    return (
      <>
        <ReportsDenied />
      </>
    );
  }

  const pick = (key: SheetKey) => {
    setSearchDraft('');
    filters.set({ sheet: key, search: null, status: null, page: null });
  };
  const applySearch = (e?: React.FormEvent) => {
    e?.preventDefault();
    filters.set({ search: searchDraft.trim() || null });
  };

  const exportCsv = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const all = await api.get<SheetDto>(`/reports/sheets/${def.key}`, { ...query, page: '1', limit: String(EXPORT_LIMIT) });
      const rows = all.rows.map((r) => all.columns.map((c) => csvValue(c, r.cells[c.key])));
      if (all.totals) rows.push(all.columns.map((c, i) => (i === 0 ? 'Total' : c.key in all.totals! ? csvValue(c, all.totals![c.key]) : null)));
      const span = all.period ? `_${all.period.from}_to_${all.period.to}` : '';
      downloadCsv(`Arihant_${def.title.replace(/[^A-Za-z0-9]+/g, '_')}${span}`, all.columns.map((c) => c.label), rows);
      if (all.total > all.rows.length) setExportError(`Exported the first ${all.rows.length} of ${all.total} rows — narrow the period or zone for the rest.`);
    } catch (e: unknown) {
      setExportError(e instanceof Error ? e.message : 'Could not export this sheet.');
    } finally {
      setExporting(false);
    }
  };

  const groups = (Object.keys(SHEET_GROUP_LABELS) as SheetGroup[]).map((g) => ({ g, items: sheets.filter((s) => s.group === g) })).filter((x) => x.items.length);
  const totals = shown?.totals;
  const misSheet = def.group === 'mis';
  const phoneRows: PhoneRow[] = shown ? shown.rows.map((r) => sheetPhoneRow(shown.columns, r, misSheet, (href) => router.push(href))) : [];
  if (shown && totals) {
    const figs = shown.columns.filter((c) => c.key in totals && c.kind !== 'text' && Number(totals[c.key]) !== 0).slice(0, misSheet ? 3 : 1);
    if (figs.length)
      phoneRows.push({ key: 'total', total: true, title: misSheet ? 'Total' : `Total (${shown.total} rows)`, figures: figs.map((c) => ({ label: shortLabel(c), value: cellText(c, totals[c.key]) })) });
  }

  return (
    <>
      <PageHeader title="Dashboards" icon={<FileSpreadsheet className="h-5 w-5" />} />

      <div className="space-y-4">
        <SheetPicker groups={groups} current={def} onPick={pick} />

        <div className="min-w-0 space-y-4">
          <ReportFilterBar filters={filters} territory={shown?.filters ?? data?.filters}>
            <form onSubmit={applySearch} className="col-span-2 sm:col-span-1 lg:w-[260px]">
              <Input
                label="Search"
                value={searchDraft}
                onChange={(e) => setSearchDraft(e.target.value)}
                onBlur={() => (searchDraft.trim() || '') !== (filters.values.search || '') && applySearch()}
                placeholder={misSheet ? 'Filter rows' : 'Bid no., customer, item, person'}
                helperText="Press Enter to search"
              />
            </form>
            {instrumentSheet && (
              <div className="col-span-2 sm:col-span-1 lg:w-[190px]">
                <Select label="Status" value={filters.values.status ?? ''} onChange={(e) => filters.set({ status: e.target.value || null })}>
                  <option value="">All statuses</option>
                  {TENDER_FINANCIAL_INSTRUMENT_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </ReportFilterBar>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              {/* phones already show the title in the sheet picker */}
              <h2 className="font-serif text-lg font-semibold text-[#14213D] max-sm:sr-only">{def.title}</h2>
              <p className="text-xs text-[#4A5568]">
                {shown && (
                  <>
                    <strong className="font-mono text-[#14213D]">{shown.total.toLocaleString('en-IN')}</strong> {shown.total === 1 ? 'row' : 'rows'}
                  </>
                )}
              </p>
            </div>
            <Button variant="outline" size="sm" leftIcon={<Download className="h-4 w-4" />} onClick={exportCsv} isLoading={exporting} disabled={!shown} className="shrink-0 max-sm:w-full">
              Export CSV
            </Button>
          </div>

          {exportError && (
            <InfoCallout variant="warning" title="Export" onClose={() => setExportError(null)}>
              {exportError}
            </InfoCallout>
          )}
          {error && (
            <InfoCallout variant="danger" title="Could not load this sheet">
              <p>{error}</p>
              <Button variant="secondary" size="xs" className="mt-2" leftIcon={<RefreshCw className="h-3.5 w-3.5" />} onClick={reload}>
                Try again
              </Button>
            </InfoCallout>
          )}

          {!shown ? (
            loading ? <PageLoader rows={6} label={`Building ${def.title}`} /> : null
          ) : (
            <Card className={`overflow-hidden p-0 transition-opacity ${loading ? 'opacity-60' : ''}`} aria-busy={loading}>
              {shown.rows.length === 0 ? (
                <p className="p-10 text-center text-sm text-[#4A5568]">
                  Nothing in this sheet for the {isRegister ? 'filters' : 'period and filters'} picked.
                </p>
              ) : (
                <>
                <div className="px-3 sm:hidden">
                  <PhoneRows label={def.title} rows={phoneRows} />
                </div>
                <div className="max-h-[70vh] overflow-auto custom-scrollbar max-sm:hidden">
                  <Table>
                    <TableHeader className="sticky top-0 z-10">
                      <TableRow className="bg-[#FBFAF7]">
                        {!misSheet && <TableHead className="w-10 text-right">Sr.</TableHead>}
                        {shown.columns.map((c) => (
                          <TableHead
                            key={c.key}
                            className={`whitespace-nowrap ${c.kind === 'money' || c.kind === 'number' || c.kind === 'percent' ? 'text-right' : ''}`}
                          >
                            {c.label}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {shown.rows.map((r, i) => (
                        <TableRow
                          key={r.id}
                          className={r.link ? 'cursor-pointer hover:bg-[#FBFAF7]' : undefined}
                          onClick={r.link ? () => router.push(r.link!) : undefined}
                          tabIndex={r.link ? 0 : undefined}
                          onKeyDown={r.link ? (e) => e.key === 'Enter' && router.push(r.link!) : undefined}
                        >
                          {!misSheet && <TableCell className="text-right font-mono text-[11px] text-[#6B7280]">{(shown.page - 1) * shown.limit + i + 1}</TableCell>}
                          {shown.columns.map((c) => (
                            <TableCell
                              key={c.key}
                              className={`align-top text-xs ${c.kind === 'money' || c.kind === 'number' || c.kind === 'percent' ? 'text-right' : ''}`}
                            >
                              <Cell col={c} value={r.cells[c.key]} />
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                      {totals && (
                        <TableRow className="bg-[#FBFAF7] font-semibold">
                          {!misSheet && <TableCell />}
                          {shown.columns.map((c, i) => (
                            <TableCell key={c.key} className={`text-xs ${c.kind === 'money' || c.kind === 'number' || c.kind === 'percent' ? 'text-right' : ''}`}>
                              {i === 0 ? (
                                <span className="font-serif text-[#14213D]">{misSheet ? 'Total' : `Total (${shown.total} rows)`}</span>
                              ) : c.key in totals && c.kind !== 'text' ? (
                                <Cell col={c} value={totals[c.key]} />
                              ) : null}
                            </TableCell>
                          ))}
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
                </>
              )}
              {shown.totalPages > 1 && (
                <div className="border-t border-[#ECE9E2] p-3">
                  <Pagination page={shown.page} totalPages={shown.totalPages} total={shown.total} limit={shown.limit} onPage={(p) => filters.set({ page: p > 1 ? String(p) : null })} noun="rows" disabled={loading} />
                </div>
              )}
            </Card>
          )}

        </div>
      </div>
    </>
  );
}

export default function DashboardsReportPage() {
  return (
    <PageContainer>
      <Suspense fallback={<PageLoader rows={5} label="Loading dashboards" />}>
        <DashboardSheets />
      </Suspense>
    </PageContainer>
  );
}
