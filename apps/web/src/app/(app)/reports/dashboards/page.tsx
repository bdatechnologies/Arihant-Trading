'use client';

/**
 * Report 7 — Dashboards (GET /reports/sheets/:key): the client's "ALL DASHBOARDS" workbook, one sheet at a time, with
 * the workbook's own column headings, filled live from the records BOS already holds. Every sheet exports to CSV with
 * the same headings, so the familiar Excel layout comes straight out of the system — nothing is re-typed.
 */
import React, { Suspense, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Download, FileSpreadsheet, RefreshCw } from 'lucide-react';
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
import { ReportFilterBar, ReportNotes, ReportsDenied, ReportsNav, canOpen, downloadCsv, fmtDay, useReport, useReportFilters } from '../_lib/report-ui';

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
        <ReportsNav role={user.role} />
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

  return (
    <>
      <PageHeader
        title="Dashboards"
        icon={<FileSpreadsheet className="h-5 w-5" />}
        actions={
          <Button variant="outline" size="sm" leftIcon={<Download className="h-4 w-4" />} onClick={exportCsv} isLoading={exporting} disabled={!shown}>
            Export CSV
          </Button>
        }
      />
      <ReportsNav role={user.role} />

      <div className="grid gap-4 lg:grid-cols-[230px_minmax(0,1fr)]">
        {/* Sheet picker: a select on a phone, the workbook's sheet list beside the table on a wide screen. */}
        <div className="lg:hidden">
          <Select label="Sheet" value={def.key} onChange={(e) => pick(e.target.value as SheetKey)}>
            {groups.map(({ g, items }) => (
              <optgroup key={g} label={SHEET_GROUP_LABELS[g]}>
                {items.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.title}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </div>
        <nav aria-label="Workbook sheets" className="hidden lg:block">
          <Card className="sticky top-4 space-y-3 p-3">
            {groups.map(({ g, items }) => (
              <div key={g}>
                <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[#6B7280]">{SHEET_GROUP_LABELS[g]}</p>
                <ul className="space-y-0.5">
                  {items.map((s) => {
                    const on = s.key === def.key;
                    return (
                      <li key={s.key}>
                        <button
                          type="button"
                          onClick={() => pick(s.key)}
                          aria-current={on ? 'page' : undefined}
                          className={`w-full rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                            on ? 'bg-[#E3EFEE] font-semibold text-[#0F5E63]' : 'text-[#14213D] hover:bg-[#FBFAF7]'
                          }`}
                        >
                          {s.title}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </Card>
        </nav>

        <div className="min-w-0 space-y-4">
          <ReportFilterBar filters={filters} territory={shown?.filters ?? data?.filters}>
            <form onSubmit={applySearch} className="lg:w-[240px]">
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
              <div className="lg:w-[190px]">
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

          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 className="font-serif text-lg font-semibold text-[#14213D]">{def.title}</h2>
              <p className="text-xs text-[#4A5568]">
                {isRegister
                  ? 'Register of every instrument (the period does not apply) — money with the buyer first, soonest expiry first.'
                  : `Period by ${def.period_basis?.charAt(0).toLowerCase()}${def.period_basis?.slice(1)}.`}
              </p>
            </div>
            {shown && (
              <p className="text-xs text-[#4A5568]">
                <strong className="font-mono text-[#14213D]">{shown.total.toLocaleString('en-IN')}</strong> {shown.total === 1 ? 'row' : 'rows'}
              </p>
            )}
          </div>

          {def.not_tracked.length > 0 && (
            <InfoCallout variant="neutral" title="Workbook columns BOS does not hold">
              {def.not_tracked.join(', ')} — {misSheet || def.key === 'deliveries' || def.key === 'orders' ? 'invoices, payments and tax details stay in Tally (Blueprint: BOS is not the accounting system)' : 'not captured in BOS yet'}, so
              they are left out rather than shown blank.
            </InfoCallout>
          )}
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
                <div className="max-h-[70vh] overflow-auto custom-scrollbar">
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
              )}
              {shown.totalPages > 1 && (
                <div className="border-t border-[#ECE9E2] p-3">
                  <Pagination page={shown.page} totalPages={shown.totalPages} total={shown.total} limit={shown.limit} onPage={(p) => filters.set({ page: p > 1 ? String(p) : null })} noun="rows" disabled={loading} />
                </div>
              )}
            </Card>
          )}

          <ReportNotes>
            Each sheet is counted from the records the modules already hold, in your territory. Money columns are totalled over
            every row in the filters, not only the page on screen. EMD and performance security follow the EMD workflow
            (requested → approved → issued → submitted → refund due → refunded / released); “Receiving” is Yes once the money is
            back. Pipeline weighting: high 75 %, medium 50 %, low 25 %. MIS sheets use the Business MIS rules (tenders by
            identified / submitted / result date, orders by result or conversion date, open items as of now). Click a row to
            open the record.
          </ReportNotes>
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
