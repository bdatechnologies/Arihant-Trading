'use client';

/**
 * Report 4 — Employee productivity indicators (GET /reports/productivity, Blueprint §42–43): each person's Module 8
 * task evidence (same figures as Team Performance) beside the work they logged in visits, follow-ups, sales, demos,
 * service and expenses over the period, with factual attention flags. Evidence only — no scores or pay advice.
 */
import React, { Suspense } from 'react';
import Link from 'next/link';
import { AlertTriangle, CheckCircle2, Download, FileSearch, RefreshCw, Timer, Users } from 'lucide-react';
import type { ProductivityReportDto, ProductivityRow } from '@arihant/shared';
import { formatINR } from '@arihant/shared';
import { useAuth } from '@/lib/auth-context';
import {
  Badge,
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
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';
import { PhoneRows, ReportBody, FactList, ReportFilterBar, ReportsDenied, canOpen, downloadCsv, money, pctText, useReport, useReportFilters } from '../_lib/report-ui';

const roleLabel = (r: string) => {
  const t = r.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

type Col = { label: string; title: string; get: (r: Pick<ProductivityRow, 'tasks' | 'activity'>) => string | number; csv?: (r: Pick<ProductivityRow, 'tasks' | 'activity'>) => string | number | null; warn?: (r: Pick<ProductivityRow, 'tasks' | 'activity'>) => boolean };
const COLUMNS: { name: string; cols: Col[] }[] = [
  {
    name: 'Tasks',
    cols: [
      { label: 'Due', title: 'Tasks due (original deadline) in the period', get: (r) => r.tasks.assigned },
      { label: 'Done', title: 'Completed', get: (r) => r.tasks.completed },
      { label: 'On time', title: 'Completed on time ÷ completed', get: (r) => pctText(r.tasks.on_time_pct), csv: (r) => r.tasks.on_time_pct },
      { label: 'Overdue', title: 'Open and past deadline right now', get: (r) => r.tasks.overdue_now, warn: (r) => r.tasks.overdue_now > 0 },
      { label: 'Excused', title: 'Blockers accepted by the manager', get: (r) => r.tasks.approved_blockers },
      { label: 'Unapproved', title: 'Late without an accepted blocker, open past deadline, or blocker rejected', get: (r) => r.tasks.unapproved_delays, warn: (r) => r.tasks.unapproved_delays > 0 },
    ],
  },
  {
    name: 'Field & sales',
    cols: [
      { label: 'Visits', title: 'Visits completed / planned in the period', get: (r) => `${r.activity.visits_completed}/${r.activity.visits_planned}`, csv: (r) => r.activity.visits_completed },
      { label: 'Interactions', title: 'Customer interactions logged', get: (r) => r.activity.interactions },
      { label: 'F/U', title: 'Lead follow-ups completed', get: (r) => r.activity.followups_done },
      { label: 'Leads', title: 'Leads created', get: (r) => r.activity.leads_created },
      { label: 'Proposals', title: 'Proposals sent', get: (r) => r.activity.proposals_sent },
      { label: 'Bids', title: 'Tenders submitted', get: (r) => r.activity.tenders_submitted },
    ],
  },
  {
    name: 'Demo & service',
    cols: [
      { label: 'Demos', title: 'Completed demos conducted (engineer or coordinator)', get: (r) => r.activity.demos_conducted },
      { label: 'Tickets', title: 'Service tickets closed', get: (r) => r.activity.tickets_closed },
      { label: 'Avg closure', title: 'Average days to close their tickets', get: (r) => (r.activity.avg_closure_days === null ? '—' : `${r.activity.avg_closure_days} d`), csv: (r) => r.activity.avg_closure_days },
    ],
  },
  {
    name: 'Expenses',
    cols: [{ label: 'Claimed', title: 'Claimed on non-draft expense lines dated in the period', get: (r) => formatINR(r.activity.expenses_claimed), csv: (r) => r.activity.expenses_claimed }],
  },
];
const EDGE = 'border-l border-[#ECE9E2]';

function ProductivityReport() {
  const { user } = useAuth();
  const allowed = canOpen(user?.role, 'productivity');
  const filters = useReportFilters(['role']);
  const { data, loading, error, reload } = useReport<ProductivityReportDto>('/reports/productivity', { ...filters.query, from: filters.from, to: filters.to }, allowed && !filters.invalid);

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
    const flat = COLUMNS.flatMap((g) => g.cols.map((c) => ({ ...c, head: `${g.name} – ${c.label}` })));
    const line = (r: ProductivityRow) => [r.name, roleLabel(r.role), r.region_name ?? '', r.manager ?? '', ...flat.map((c) => (c.csv ? c.csv(r) : c.get(r))), r.attention.join('; ')];
    downloadCsv(`Arihant_Employee_Productivity_${data.period.from}_to_${data.period.to}`, ['Employee', 'Role', 'Region', 'Reporting manager', ...flat.map((c) => c.head), 'Needs attention'], data.rows.map(line));
  };
  const t = data?.totals;

  return (
    <>
      <PageHeader
        title="Employee productivity report"
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/performance/team">
              <Button variant="secondary" size="sm" leftIcon={<FileSearch className="h-4 w-4" />}>
                Task evidence
              </Button>
            </Link>
            <Button variant="outline" size="sm" leftIcon={<Download className="h-4 w-4" />} onClick={exportCsv} disabled={!data}>
              Export CSV
            </Button>
          </div>
        }
      />
      <ReportFilterBar filters={filters} territory={data?.filters}>
        <div className="lg:w-[200px]">
          <Select label="Role" value={data?.role ?? ''} onChange={(e) => filters.set({ role: e.target.value || null })}>
            <option value="">All roles</option>
            {(data?.roles ?? []).map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </Select>
        </div>
      </ReportFilterBar>

      {error && (
        <InfoCallout variant="danger" title="Could not load the productivity report">
          <p>{error}</p>
          <Button variant="secondary" size="xs" className="mt-2" leftIcon={<RefreshCw className="h-3.5 w-3.5" />} onClick={reload}>
            Try again
          </Button>
        </InfoCallout>
      )}

      {!data || !t ? (
        loading ? <PageLoader rows={5} label="Building the productivity report" /> : null
      ) : (
        <ReportBody main={[0, 2]} loading={loading}>
          <StatGrid cols={4} className="report-kpis gap-3">
            <StatCard
              title={data.scope === 'all' ? 'Employees' : 'Your team'}
              value={t.employees}
              icon={<Users className="h-4 w-4" />}
              variant="primary"
            />
            <StatCard title="On-time completion" value={pctText(t.tasks.on_time_pct)} icon={<CheckCircle2 className="h-4 w-4" />} variant="emerald" />
            <StatCard title="Overdue now" value={t.tasks.overdue_now} icon={<Timer className="h-4 w-4" />} variant={t.tasks.overdue_now > 0 ? 'rose' : 'default'} />
            <StatCard
              title="Unapproved delays"
              value={t.tasks.unapproved_delays}
              icon={<AlertTriangle className="h-4 w-4" />}
              variant={t.tasks.unapproved_delays > 0 ? 'amber' : 'default'}
            />
          </StatGrid>

          <Card>
            <CardHeader className="flex-col items-start gap-0">
              <CardTitle>Work logged in the period</CardTitle>
            </CardHeader>
            <CardContent>
              <FactList
                className="xl:grid-cols-3 2xl:grid-cols-5"
                items={[
                  ['Visits completed', `${t.activity.visits_completed} / ${t.activity.visits_planned}`],
                  ['Interactions', t.activity.interactions],
                  ['Follow-ups done', t.activity.followups_done],
                  ['Leads created', t.activity.leads_created],
                  ['Proposals sent', t.activity.proposals_sent],
                  ['Bids submitted', t.activity.tenders_submitted],
                  ['Demos conducted', t.activity.demos_conducted],
                  ['Tickets closed', t.activity.tickets_closed],
                  ['Avg ticket closure', t.activity.avg_closure_days === null ? '—' : `${t.activity.avg_closure_days} d`],
                  ['Expenses claimed', money(t.activity.expenses_claimed)],
                ]}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-col items-start gap-0">
              <CardTitle>By employee</CardTitle>
            </CardHeader>
            <CardContent>
              {data.rows.length === 0 ? (
                <p className="py-6 text-center text-xs text-[#6B7280]">No employees in this scope.</p>
              ) : (
                <>
                <PhoneRows
                  label="By employee"
                  rows={[
                    ...data.rows.map((r) => ({
                      key: r.employee_id,
                      title: (
                        <>
                          {r.name}
                          {!r.is_active && <span className="ml-1 text-[10px] font-normal text-[#6B7280]">(inactive)</span>}
                        </>
                      ),
                      sub: [roleLabel(r.role), r.region_name].filter(Boolean).join(' · '),
                      meta: r.attention.length ? <span className="font-semibold text-[#9A3412]">{r.attention.join(' · ')}</span> : undefined,
                      figures: [
                        { label: 'Due', value: r.tasks.assigned },
                        { label: 'On time', value: pctText(r.tasks.on_time_pct) },
                        { label: 'Overdue', value: r.tasks.overdue_now, tone: r.tasks.overdue_now > 0 ? ('bad' as const) : undefined },
                      ],
                      details: COLUMNS.flatMap((g) => g.cols.map((c) => [`${g.name} · ${c.label}`, c.get(r), c.warn?.(r) ? ('bad' as const) : undefined] as const)),
                    })),
                    {
                      key: 'total',
                      total: true,
                      title: 'Total',
                      sub: `${t.needing_attention} ${t.needing_attention === 1 ? 'person needs' : 'people need'} attention`,
                      figures: [
                        { label: 'Due', value: t.tasks.assigned },
                        { label: 'On time', value: pctText(t.tasks.on_time_pct) },
                        { label: 'Overdue', value: t.tasks.overdue_now, tone: t.tasks.overdue_now > 0 ? ('bad' as const) : undefined },
                      ],
                    },
                  ]}
                />
                <div className="max-sm:hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead rowSpan={2} className="sticky left-0 z-10 min-w-[180px] bg-[#FBFAF7]">
                        Employee
                      </TableHead>
                      {COLUMNS.map((g) => (
                        <TableHead key={g.name} colSpan={g.cols.length} className={`text-center text-[#14213D] ${EDGE}`}>
                          {g.name}
                        </TableHead>
                      ))}
                      <TableHead rowSpan={2} className={`min-w-[200px] ${EDGE}`}>
                        Needs attention
                      </TableHead>
                    </TableRow>
                    <TableRow>
                      {COLUMNS.flatMap((g) =>
                        g.cols.map((c, i) => (
                          <TableHead key={`${g.name}-${c.label}`} title={c.title} className={`px-2 text-right normal-case tracking-normal whitespace-nowrap ${i === 0 ? EDGE : ''}`}>
                            {c.label}
                          </TableHead>
                        )),
                      )}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.rows.map((r) => (
                      <TableRow key={r.employee_id}>
                        <TableCell className="sticky left-0 z-[1] bg-white whitespace-nowrap">
                          <div className="font-semibold text-[#14213D]">
                            {r.name}
                            {!r.is_active && <span className="ml-1.5 text-[10px] font-normal text-[#6B7280]">(inactive)</span>}
                          </div>
                          <div className="text-[10px] text-[#4A5568]">{[roleLabel(r.role), r.region_name].filter(Boolean).join(' · ')}</div>
                        </TableCell>
                        {COLUMNS.flatMap((g) =>
                          g.cols.map((c, i) => (
                            <TableCell key={`${g.name}-${c.label}`} className={`px-2 text-right font-mono whitespace-nowrap ${i === 0 ? EDGE : ''} ${c.warn?.(r) ? 'font-bold text-[#881337]' : ''}`}>
                              {c.get(r)}
                            </TableCell>
                          )),
                        )}
                        <TableCell className={EDGE}>
                          {r.attention.length === 0 ? (
                            <span className="text-[#6B7280]">—</span>
                          ) : (
                            <div className="flex flex-wrap gap-1">
                              {r.attention.map((a) => (
                                <Badge key={a} variant={/overdue|repeated/i.test(a) ? 'danger' : 'warning'} size="sm">
                                  {a}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="border-t-2 border-[#DCD8CE] bg-[#FBFAF7] hover:bg-[#FBFAF7]">
                      <TableCell className="sticky left-0 z-[1] bg-[#FBFAF7] font-bold text-[#14213D]">Total</TableCell>
                      {COLUMNS.flatMap((g) =>
                        g.cols.map((c, i) => (
                          <TableCell key={`${g.name}-${c.label}`} className={`px-2 text-right font-mono font-bold whitespace-nowrap ${i === 0 ? EDGE : ''}`}>
                            {c.get(t)}
                          </TableCell>
                        )),
                      )}
                      <TableCell className={`${EDGE} text-xs text-[#4A5568]`}>{t.needing_attention} people</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
                </>
              )}
            </CardContent>
          </Card>

        </ReportBody>
      )}
    </>
  );
}

export default function ProductivityReportPage() {
  return (
    <PageContainer>
      <Suspense fallback={<PageLoader rows={5} label="Loading report" />}>
        <ProductivityReport />
      </Suspense>
    </PageContainer>
  );
}
