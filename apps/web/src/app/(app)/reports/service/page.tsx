'use client';

/**
 * Report 2 — Service closure time & repeat complaints (GET /reports/service, Blueprint §34): the desk's live position,
 * closure time (average / median / slow tail), SLA compliance, repeat complaints and where they cluster, the monthly
 * trend and an engineer / region / zone / priority breakdown. Filters live in the URL.
 */
import React, { Suspense } from 'react';
import { AlertTriangle, Clock, Download, Map as MapIcon, MapPin, RefreshCw, Repeat, ShieldCheck, Users, Wrench } from 'lucide-react';
import type { ServiceBreakdownRow, ServiceReportDto, ServiceReportGroupBy } from '@arihant/shared';
import { useAuth } from '@/lib/auth-context';
import {
  BarList,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  InfoCallout,
  PageContainer,
  PageHeader,
  PageLoader,
  StatCard,
  StatGrid,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';
import { ReportSwitch, PhoneRows, ReportBody, FactList, ReportFilterBar, ReportsDenied, canOpen, downloadCsv, fmtDay, pctText, useReport, useReportFilters } from '../_lib/report-ui';

const GROUP_LABEL: Record<ServiceReportGroupBy, string> = { engineer: 'Engineer', region: 'Region', zone: 'Zone', priority: 'Priority' };
const dayText = (d: number | null) => (d === null ? '—' : `${d} d`);
const monthLabel = (m: string) => new Date(`${m}-01T00:00:00+05:30`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

type Col = { label: string; title: string; get: (r: ServiceBreakdownRow) => string | number; csv?: (r: ServiceBreakdownRow) => string | number | null; warn?: (r: ServiceBreakdownRow) => boolean };
const COLUMNS: Col[] = [
  { label: 'Received', title: 'Complaints received in the period', get: (r) => r.received },
  { label: 'Closed', title: 'Tickets closed in the period', get: (r) => r.closed },
  { label: 'Avg closure', title: 'Average days from complaint received to closure (closed in the period)', get: (r) => dayText(r.avg_closure_days), csv: (r) => r.avg_closure_days },
  { label: 'Median', title: 'Median closure days (closed in the period)', get: (r) => dayText(r.median_closure_days), csv: (r) => r.median_closure_days },
  { label: 'Within SLA', title: 'Closed in the period and resolved by the resolution deadline', get: (r) => pctText(r.within_sla_rate), csv: (r) => r.within_sla_rate },
  { label: 'Repeats', title: 'Repeat complaints received in the period', get: (r) => r.repeats, warn: (r) => r.repeats > 0 },
  { label: 'Open now', title: 'Pending right now', get: (r) => r.open },
  { label: 'Overdue now', title: 'Overdue right now (visit day or resolution deadline passed, clock running)', get: (r) => r.overdue, warn: (r) => r.overdue > 0 },
];

function ServiceReport() {
  const { user } = useAuth();
  const allowed = canOpen(user?.role, 'service');
  const filters = useReportFilters(['group_by']);
  const groupBy = (['engineer', 'region', 'zone', 'priority'].includes(filters.values.group_by) ? filters.values.group_by : 'engineer') as ServiceReportGroupBy;
  const { data, loading, error, reload } = useReport<ServiceReportDto>('/reports/service', { ...filters.query, from: filters.from, to: filters.to }, allowed && !filters.invalid);

  if (!user) return <PageLoader rows={4} label="Loading report" />;
  if (!allowed) {
    return (
      <>
        <ReportsDenied />
      </>
    );
  }

  const exportCsv = () => {
    if (!data) return;
    const line = (r: ServiceBreakdownRow) => [r.label, r.detail ?? '', ...COLUMNS.map((c) => (c.csv ? c.csv(r) : c.get(r)))];
    downloadCsv(
      `Arihant_Service_Report_by_${GROUP_LABEL[data.group_by]}_${data.period.from}_to_${data.period.to}`,
      [GROUP_LABEL[data.group_by], data.group_by === 'engineer' ? 'Region' : 'Zone', ...COLUMNS.map((c) => c.label)],
      [...data.breakdown.rows.map(line), line(data.breakdown.totals)],
    );
  };

  const s = data?.snapshot;
  const c = data?.closure;
  const trendMax = Math.max(1, ...(data?.trend ?? []).map((t) => Math.max(t.received, t.closed)));

  return (
    <>
      <PageHeader
        title="Service closure & repeat complaints report"
        actions={
          <Button variant="outline" size="sm" leftIcon={<Download className="h-4 w-4" />} onClick={exportCsv} disabled={!data}>
            Export CSV
          </Button>
        }
      />
      <ReportFilterBar filters={filters} territory={data?.filters} />

      {error && (
        <InfoCallout variant="danger" title="Could not load the service report">
          <p>{error}</p>
          <Button variant="secondary" size="xs" className="mt-2" leftIcon={<RefreshCw className="h-3.5 w-3.5" />} onClick={reload}>
            Try again
          </Button>
        </InfoCallout>
      )}

      {!data || !s || !c ? (
        loading ? <PageLoader rows={5} label="Building the service report" /> : null
      ) : (
        <ReportBody main={[0, 1]} loading={loading}>
          <StatGrid cols={4} className="report-kpis gap-3">
            <StatCard title="Complaints received" value={c.received} icon={<Wrench className="h-4 w-4" />} variant="primary" />
            <StatCard
              title="Average closure"
              value={dayText(c.avg_closure_days)}
              icon={<Clock className="h-4 w-4" />}
              variant="primary"
            />
            <StatCard title="Closed within SLA" value={pctText(c.within_sla.rate)} icon={<ShieldCheck className="h-4 w-4" />} variant="emerald" />
            <StatCard
              title="Repeat complaints"
              value={c.repeats}
              icon={<Repeat className="h-4 w-4" />}
              variant={c.repeats > 0 ? 'rose' : 'default'}
            />
          </StatGrid>

          {/* Live position of the desk — same definitions as the Service Desk tiles. */}
          <Card>
            <CardHeader className="flex-col items-start gap-0">
              <CardTitle>Service desk right now</CardTitle>
            </CardHeader>
            <CardContent>
              <FactList
                className="xl:grid-cols-4"
                items={[
                  ['New, not triaged', s.new],
                  ['Pending', s.pending],
                  ['With an engineer', s.assigned],
                  ['Overdue', s.overdue, s.overdue > 0 ? 'bad' : 'default'],
                  ['Awaiting parts', s.awaiting_parts, s.awaiting_parts > 0 ? 'warn' : 'default'],
                  ['Escalated / revisit', s.escalated, s.escalated > 0 ? 'warn' : 'default'],
                  ['SLA breached', s.sla_breached, s.sla_breached > 0 ? 'bad' : 'default'],
                ]}
              />
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-5">
            <Card className="lg:col-span-3">
              <CardHeader className="flex-col items-start gap-0">
                <CardTitle>Monthly trend</CardTitle>
              </CardHeader>
              <CardContent>
                <PhoneRows
                  label="Monthly trend"
                  rows={data.trend.map((t) => ({
                    key: t.month,
                    title: monthLabel(t.month),
                    dim: !t.received && !t.closed && !t.repeats,
                    sub: t.repeats ? <span className="font-semibold text-[#881337]">{t.repeats} repeat {t.repeats === 1 ? 'complaint' : 'complaints'}</span> : undefined,
                    figures: [
                      { label: 'In', value: t.received },
                      { label: 'Closed', value: t.closed },
                      { label: 'Avg', value: dayText(t.avg_closure_days) },
                    ],
                  }))}
                />
                <div className="max-sm:hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Month</TableHead>
                      <TableHead className="w-[40%]">Received / closed</TableHead>
                      <TableHead className="text-right">Avg closure</TableHead>
                      <TableHead className="text-right">Repeats</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.trend.map((t) => (
                      <TableRow key={t.month}>
                        <TableCell className="whitespace-nowrap font-medium text-[#14213D]">{monthLabel(t.month)}</TableCell>
                        <TableCell>
                          <div className="space-y-1" aria-label={`${t.received} received, ${t.closed} closed`}>
                            <div className="flex items-center gap-2">
                              <span className="block h-2 rounded-r bg-[#0F5E63]" style={{ width: `${(t.received / trendMax) * 100}%`, minWidth: t.received ? 3 : 0 }} />
                              <span className="font-mono text-[11px] text-[#14213D]">{t.received}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="block h-2 rounded-r bg-[#9A3412]/70" style={{ width: `${(t.closed / trendMax) * 100}%`, minWidth: t.closed ? 3 : 0 }} />
                              <span className="font-mono text-[11px] text-[#4A5568]">{t.closed}</span>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-mono">{dayText(t.avg_closure_days)}</TableCell>
                        <TableCell className={`text-right font-mono ${t.repeats ? 'font-bold text-[#881337]' : ''}`}>{t.repeats}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
                <p className="mt-2 flex items-center gap-4 text-[11px] text-[#4A5568] max-sm:hidden">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-3 rounded-sm bg-[#0F5E63]" aria-hidden /> Received
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-3 rounded-sm bg-[#9A3412]/70" aria-hidden /> Closed
                  </span>
                </p>
              </CardContent>
            </Card>

            <div className="space-y-4 lg:col-span-2">
              <Card>
                <CardHeader className="flex-col items-start gap-0">
                  <CardTitle>Closure time by priority</CardTitle>
                </CardHeader>
                <CardContent>
                  <BarList
                    label="Average closure hours by priority"
                    items={data.closure_by_priority.map((p) => ({
                      key: p.priority,
                      label: p.priority.charAt(0).toUpperCase() + p.priority.slice(1),
                      value: p.avg_hours ?? 0,
                      display: `${p.avg_hours ?? '—'} h · ${p.closed}`,
                      detail: `${p.closed} closed`,
                    }))}
                    emptyText="No tickets closed in this period."
                  />
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex-col items-start gap-0">
                  <CardTitle>Complaints by problem category</CardTitle>
                </CardHeader>
                <CardContent>
                  <BarList
                    label="Complaints received by problem category"
                    items={data.repeat_by_category.map((x) => ({ key: x.category, label: x.category, value: x.received, display: `${x.received} (${x.repeats})` }))}
                    emptyText="No complaints received in this period."
                  />
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Where complaints keep coming back */}
          <Card>
            <CardHeader className="flex-col items-start gap-0">
              <CardTitle>Repeat complaint hotspots</CardTitle>
            </CardHeader>
            <CardContent>
              {data.hotspots.length === 0 ? (
                <p className="py-4 text-center text-xs text-[#6B7280]">No equipment came back more than once in this period.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Customer</TableHead>
                      <TableHead>Equipment</TableHead>
                      <TableHead className="text-right">Complaints</TableHead>
                      <TableHead className="text-right">Repeats</TableHead>
                      <TableHead className="text-right">Still open</TableHead>
                      <TableHead>Last received</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.hotspots.map((h) => (
                      <TableRow key={`${h.organisation_id}-${h.equipment}`}>
                        <TableCell className="font-semibold text-[#14213D]">{h.organisation_name}</TableCell>
                        <TableCell className="font-mono text-[#4A5568]">{h.equipment}</TableCell>
                        <TableCell className="text-right font-mono">{h.tickets}</TableCell>
                        <TableCell className={`text-right font-mono ${h.repeats ? 'font-bold text-[#881337]' : ''}`}>{h.repeats}</TableCell>
                        <TableCell className="text-right font-mono">{h.open}</TableCell>
                        <TableCell className="whitespace-nowrap font-mono">{fmtDay(h.last_received)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {/* Engineer / territory / priority breakdown */}
          <Card>
            <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between max-sm:flex-row max-sm:items-center">
              <div className="min-w-0">
                <CardTitle>{GROUP_LABEL[groupBy]}-wise breakdown</CardTitle>
              </div>
              <ReportSwitch
                  label="Group by"
                  value={groupBy}
                  onChange={(id) => filters.set({ group_by: id === 'engineer' ? null : id })}
                  options={[
                    { id: 'engineer', label: 'Engineer', icon: <Users className="h-3.5 w-3.5" /> },
                    { id: 'region', label: 'Region', icon: <MapPin className="h-3.5 w-3.5" /> },
                    { id: 'zone', label: 'Zone', icon: <MapIcon className="h-3.5 w-3.5" /> },
                    { id: 'priority', label: 'Priority', icon: <AlertTriangle className="h-3.5 w-3.5" /> },
                  ]}
                />
            </CardHeader>
            <CardContent>
              <PhoneRows
                label={`${GROUP_LABEL[data.group_by]}-wise breakdown`}
                rows={[...data.breakdown.rows.map((row) => ({ ...row, total: false })), { ...data.breakdown.totals, key: 'total', label: 'Total', detail: null, total: true }].map((row) => ({
                  key: row.key,
                  title: row.label,
                  sub: row.detail || undefined,
                  total: row.total,
                  figures: [
                    { label: 'In', value: row.received },
                    { label: 'Closed', value: row.closed },
                    { label: 'Overdue', value: row.overdue, tone: row.overdue > 0 ? ('bad' as const) : undefined },
                  ],
                  details: COLUMNS.map((c) => [c.label, c.get(row), c.warn?.(row) ? ('bad' as const) : undefined] as const),
                }))}
              />
              <div className="max-sm:hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="sticky left-0 z-10 min-w-[160px] bg-[#FBFAF7]">{GROUP_LABEL[data.group_by]}</TableHead>
                    {COLUMNS.map((col) => (
                      <TableHead key={col.label} title={col.title} className="px-2 text-right normal-case tracking-normal whitespace-nowrap">
                        {col.label}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.breakdown.rows.map((row) => (
                    <TableRow key={row.key}>
                      <TableCell className="sticky left-0 z-[1] bg-white whitespace-nowrap">
                        <div className="font-semibold text-[#14213D]">{row.label}</div>
                        {row.detail && <div className="text-[10px] text-[#4A5568]">{row.detail}</div>}
                      </TableCell>
                      {COLUMNS.map((col) => (
                        <TableCell key={col.label} className={`px-2 text-right font-mono whitespace-nowrap ${col.warn?.(row) ? 'font-bold text-[#881337]' : ''}`}>
                          {col.get(row)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                  <TableRow className="border-t-2 border-[#DCD8CE] bg-[#FBFAF7] hover:bg-[#FBFAF7]">
                    <TableCell className="sticky left-0 z-[1] bg-[#FBFAF7] font-bold text-[#14213D]">Total</TableCell>
                    {COLUMNS.map((col) => (
                      <TableCell key={col.label} className="px-2 text-right font-mono font-bold whitespace-nowrap">
                        {col.get(data.breakdown.totals)}
                      </TableCell>
                    ))}
                  </TableRow>
                </TableBody>
              </Table>
            </div>
            </CardContent>
          </Card>

        </ReportBody>
      )}
    </>
  );
}

export default function ServiceReportPage() {
  return (
    <PageContainer>
      <Suspense fallback={<PageLoader rows={5} label="Loading report" />}>
        <ServiceReport />
      </Suspense>
    </PageContainer>
  );
}
