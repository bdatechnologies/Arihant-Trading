'use client';

/**
 * Shared pieces of the management reports hub (/reports/*): the report tabs, the URL-backed period / territory
 * filters, the data hook and the CSV export. Every figure comes from GET /reports/* — the pages only lay it out.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { BarChart3, CalendarDays, ChevronDown, ClipboardList, FileSpreadsheet, Gauge, Receipt, TableProperties, Wrench } from 'lucide-react';
import { canViewReport, formatIndianCurrency, type ReportKey, type ReportRate, type ReportTerritoryFilters } from '@arihant/shared';
import { api } from '@/lib/api';
import { addIsoDays, istToday } from '@/lib/ist-date';
import { FilterBar, FilterMenu, Input, Select, Tabs } from '@/components/ui';
import { useUrlFilters } from '@/app/(app)/expenses/_lib/use-url-filters';

/** Raw record registers (the original consolidated reports page). */
export const REGISTER_ROLES = ['management', 'regional_manager', 'tender_team', 'accounts', 'admin'];

export const REPORT_TABS: { key: ReportKey | 'registers'; href: string; label: string; icon: React.ReactNode }[] = [
  { key: 'pipeline', href: '/reports/pipeline', label: 'Sales pipeline', icon: <BarChart3 className="h-3.5 w-3.5" /> },
  { key: 'service', href: '/reports/service', label: 'Service', icon: <Wrench className="h-3.5 w-3.5" /> },
  { key: 'expenses', href: '/reports/expenses', label: 'Expenses', icon: <Receipt className="h-3.5 w-3.5" /> },
  { key: 'productivity', href: '/reports/productivity', label: 'Productivity', icon: <Gauge className="h-3.5 w-3.5" /> },
  { key: 'sheets', href: '/reports/dashboards', label: 'Dashboards', icon: <FileSpreadsheet className="h-3.5 w-3.5" /> },
  { key: 'registers', href: '/reports/registers', label: 'Registers', icon: <TableProperties className="h-3.5 w-3.5" /> },
];

export const canOpen = (role: string | undefined, key: ReportKey | 'registers') =>
  key === 'registers' ? !!role && REGISTER_ROLES.includes(role) : canViewReport(role, key);

/** The report tabs this role may open; the current one highlighted. */
export const ReportsNav: React.FC<{ role: string | undefined }> = ({ role }) => {
  const router = useRouter();
  const pathname = usePathname();
  const tabs = REPORT_TABS.filter((t) => canOpen(role, t.key));
  const active = tabs.find((t) => pathname.startsWith(t.href))?.key ?? '';
  // Switching report keeps the period and territory already picked (the rest of the query belongs to the report).
  const go = (id: string) => {
    const t = tabs.find((x) => x.key === id);
    if (!t || t.key === active) return;
    const now = new URLSearchParams(window.location.search);
    const keep = new URLSearchParams();
    for (const k of BASE_KEYS) {
      const v = now.get(k);
      if (v) keep.set(k, v);
    }
    const q = keep.toString();
    router.push(q ? `${t.href}?${q}` : t.href, { scroll: false });
  };
  // One strip of report tabs at every width; on a phone it swipes sideways and keeps the open report in view. The
  // page's Export button docks into this row (beside the tabs on a wide screen, under them on a narrow one).
  return (
    <div data-reports-nav className="min-w-0">
      <Tabs variant="underline" activeTab={active} onChange={go} tabs={tabs.map((t) => ({ id: t.key, label: t.label, icon: t.icon }))} />
    </div>
  );
};

export const ReportsDenied: React.FC = () => (
  <div className="rounded-[14px] border border-[#DCD8CE] bg-white p-8 text-center">
    <ClipboardList className="mx-auto h-8 w-8 text-[#6B7280]" aria-hidden />
    <p className="mt-3 font-serif text-lg text-[#14213D]">This report is not available for your role</p>
    <p className="mt-1 text-xs text-[#4A5568]">Pick another report above, or ask an administrator for access.</p>
  </div>
);

/* ------------------------------------------------------------------------------------------------ period presets -- */

const fyStart = (day: string) => (day.slice(5, 7) >= '04' ? `${day.slice(0, 4)}-04-01` : `${Number(day.slice(0, 4)) - 1}-04-01`);
const monthStart = (day: string) => `${day.slice(0, 7)}-01`;
/** First day of the Indian-FY quarter (Apr–Jun, Jul–Sep, Oct–Dec, Jan–Mar) `day` is in. */
const quarterStart = (day: string) => {
  const m = Number(day.slice(5, 7));
  const qm = m >= 4 ? 4 + Math.floor((m - 4) / 3) * 3 : 1;
  return `${day.slice(0, 4)}-${String(qm).padStart(2, '0')}-01`;
};

export function periodPresets(today = istToday()) {
  const lastMonthEnd = addIsoDays(monthStart(today), -1);
  const lastFyEnd = addIsoDays(fyStart(today), -1);
  return [
    { key: 'month', label: 'This month', from: monthStart(today), to: today },
    { key: 'last_month', label: 'Last month', from: monthStart(lastMonthEnd), to: lastMonthEnd },
    { key: 'quarter', label: 'This quarter', from: quarterStart(today), to: today },
    { key: 'fy', label: 'Financial year to date', from: fyStart(today), to: today },
    { key: 'last_fy', label: 'Last financial year', from: fyStart(lastFyEnd), to: lastFyEnd },
  ];
}

/* --------------------------------------------------------------------------------------------------- filters -- */

const BASE_KEYS = ['from', 'to', 'zone_id', 'region_id'] as const;

/**
 * Report filters held in the URL (shareable, survive refresh). Default period: financial year to date, the same
 * default the API applies, so an empty query string and the shown dates always agree.
 */
export function useReportFilters<K extends string>(extra: readonly K[] = []) {
  const keys = useMemo(() => [...BASE_KEYS, ...extra], [extra]);
  const f = useUrlFilters(keys as readonly (K | (typeof BASE_KEYS)[number])[]);
  const fy = periodPresets().find((p) => p.key === 'fy')!;
  const from = f.values.from || fy.from;
  const to = f.values.to || fy.to;
  const query = useMemo(() => {
    const q: Record<string, string> = {};
    for (const [k, v] of Object.entries(f.values)) if (v) q[k] = v as string;
    return q;
  }, [f.values]);
  return { ...f, from, to, query, invalid: from > to };
}

/** What the filter bar reads from useReportFilters. */
export interface ReportFilterState {
  from: string;
  to: string;
  invalid: boolean;
  set: (patch: Partial<Record<(typeof BASE_KEYS)[number], string | null>>) => void;
}

/** Period presets (dates only for a custom range), then zone / region when the caller may pick them. `children` adds report-specific controls. */
export const ReportFilterBar: React.FC<{
  filters: ReportFilterState;
  territory?: ReportTerritoryFilters | null;
  children?: React.ReactNode;
}> = ({ filters: f, territory, children }) => {
  const presets = periodPresets();
  const matched = presets.find((p) => p.from === f.from && p.to === f.to)?.key;
  // "Custom range" stays picked (and its dates shown) even when the dates happen to match a preset.
  const [custom, setCustom] = useState(!matched);
  useEffect(() => {
    if (!matched) setCustom(true);
  }, [matched]);
  const preset = custom || !matched ? 'custom' : matched;
  const zoneId = territory?.zone_id ?? '';
  const regions = (territory?.regions ?? []).filter((r) => !zoneId || r.zone_id === zoneId);
  // Phones: the filters fold into one summary line ("FY to date · 01 Apr – 17 Nov · North") until tapped.
  const [openOnPhone, setOpenOnPhone] = useState(false);
  const periodName = preset === 'custom' ? 'Custom range' : presets.find((p) => p.key === preset)?.label;
  const zoneName = territory?.zones.find((z) => z.id === zoneId)?.name;
  const regionName = territory?.regions?.find((r) => r.id === territory?.region_id)?.name;
  const place = [zoneName, regionName].filter(Boolean).join(' · ') || (territory?.can_pick_zone ? 'All zones' : '');
  return (
    <FilterBar className="max-sm:p-3">
      <button
        type="button"
        onClick={() => setOpenOnPhone((o) => !o)}
        aria-expanded={openOnPhone}
        className="flex w-full items-center gap-2.5 text-left sm:hidden"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#E3EFEE] text-[#0F5E63]">
          <CalendarDays className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold text-[#14213D]">{periodName}</span>
          <span className="block truncate font-mono text-[10px] text-[#4A5568]">
            {fmtDay(f.from)} – {fmtDay(f.to)}
            {place && ` · ${place}`}
          </span>
        </span>
        <span className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-[#C9C4B8] bg-white px-2.5 py-1.5 text-[11px] font-semibold text-[#0F5E63]">
          {openOnPhone ? 'Done' : 'Change'}
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${openOnPhone ? 'rotate-180' : ''}`} />
        </span>
      </button>
      <div className={`${openOnPhone ? 'grid' : 'hidden sm:grid'} grid-cols-2 gap-3 max-sm:border-t max-sm:border-[#ECE9E2] max-sm:pt-3 lg:flex lg:flex-wrap lg:items-end`}>
        <div className="col-span-2 sm:col-span-1 lg:w-[210px]">
          <Select
            label="Period"
            value={preset}
            helperText={preset === 'custom' ? undefined : `${fmtDay(f.from)} – ${fmtDay(f.to)}`}
            onChange={(e) => {
              if (e.target.value === 'custom') return setCustom(true);
              const p = presets.find((x) => x.key === e.target.value);
              if (p) {
                setCustom(false);
                f.set({ from: p.from, to: p.to });
              }
            }}
          >
            {presets.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
            <option value="custom">Custom range</option>
          </Select>
        </div>
        {preset === 'custom' && (
          <div className="col-span-2 grid grid-cols-2 gap-2 lg:w-[300px]">
            <Input label="From" type="date" value={f.from} max={f.to} onChange={(e) => e.target.value && f.set({ from: e.target.value })} />
            <Input label="To" type="date" value={f.to} min={f.from} onChange={(e) => e.target.value && f.set({ to: e.target.value })} />
          </div>
        )}
        {territory?.can_pick_zone && (
          <div className="min-w-0 lg:w-[190px]">
            <Select label="Zone" value={zoneId} onChange={(e) => f.set({ zone_id: e.target.value || null, region_id: null })}>
              <option value="">All zones</option>
              {territory.zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
            </Select>
          </div>
        )}
        {territory?.can_pick_region && regions.length > 0 && (
          <div className="min-w-0 lg:w-[200px]">
            <Select label="Region" value={territory.region_id ?? ''} onChange={(e) => f.set({ region_id: e.target.value || null })}>
              <option value="">{territory.can_pick_zone ? 'All regions' : 'Whole territory'}</option>
              {regions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </div>
        )}
        {children}
      </div>
      {f.invalid && <p className="text-xs text-[#881337]">“From” must be on or before “To”.</p>}
    </FilterBar>
  );
};

/* ------------------------------------------------------------------------------------------- phone summary -- */

/**
 * A report's sections. On a phone only the `main` ones show (by position: the headline figures and the one section
 * that matters most); the rest fold behind "Show full report" and come back in their own places when opened. Tablets
 * and desktops always show everything.
 */
export const ReportBody: React.FC<{ main: number[]; loading?: boolean; children: React.ReactNode }> = ({ main, loading, children }) => {
  const [open, setOpen] = useState(false);
  const items = React.Children.toArray(children).filter(Boolean);
  const folded = items.length - items.filter((_, i) => main.includes(i)).length;
  return (
    <div className={`report-body space-y-6 transition-opacity max-sm:space-y-3 ${loading ? 'opacity-60' : ''}`} aria-busy={loading}>
      {items.map((child, i) => (main.includes(i) ? child : <div key={i} className={open ? '' : 'max-sm:hidden'}>{child}</div>))}
      {folded > 0 && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex min-h-11 w-full items-center justify-center gap-2 rounded-[14px] border border-[#C9C4B8] bg-white px-4 text-sm font-semibold text-[#0F5E63] shadow-2xs sm:hidden"
        >
          {open ? 'Show less' : 'Show full report'}
          {!open && <span className="rounded-full bg-[#E3EFEE] px-2 py-0.5 text-[11px]">{folded} more</span>}
          <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------------------------------------ fact list -- */

type FactTone = 'default' | 'good' | 'warn' | 'bad';
const TONE: Record<FactTone, string> = {
  default: 'text-[#14213D]',
  good: 'text-[#0F5E63]',
  warn: 'text-[#9A3412]',
  bad: 'text-[#881337]',
};

/** Label / value pairs in a ruled list — secondary figures that do not need a card each. */
export const FactList: React.FC<{ items: readonly (readonly [string, React.ReactNode, FactTone?])[]; className?: string }> = ({ items, className }) => (
  <dl className={`grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2 ${className ?? ''}`}>
    {items.map(([label, value, tone]) => (
      <div key={label} className="flex items-baseline justify-between gap-2 border-b border-[#ECE9E2] py-1.5">
        <dt className="text-[#4A5568]">{label}</dt>
        <dd className={`font-mono font-semibold ${TONE[tone ?? 'default']}`}>{value}</dd>
      </div>
    ))}
  </dl>
);

/* ------------------------------------------------------------------------------------------------ phone rows -- */

/** One line of a report table as a phone shows it: a name, two or three headline figures, the rest on tap. */
export interface PhoneRow {
  key: string;
  title: React.ReactNode;
  sub?: React.ReactNode;
  meta?: React.ReactNode;
  figures?: { label: string; value: React.ReactNode; tone?: FactTone }[];
  badge?: React.ReactNode;
  /** every figure, shown under the row when it is tapped */
  details?: readonly (readonly [string, React.ReactNode, FactTone?])[];
  /** opens the record instead of expanding */
  onOpen?: () => void;
  total?: boolean;
  /** a row with nothing in it (a quiet month): shown faded */
  dim?: boolean;
}

/**
 * Phones only: a report table as a plain list — the wide table stays on tablets and desktops (hide it below `sm`).
 * Each row reads at a glance; tapping one shows all its figures (or opens the record).
 */
export const PhoneRows: React.FC<{ rows: PhoneRow[]; label: string }> = ({ rows, label }) => {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ul aria-label={label} className="divide-y divide-[#ECE9E2] sm:hidden">
      {rows.map((r) => {
        const expandable = !r.onOpen && !!r.details?.length;
        const isOpen = open === r.key;
        const body = (
          <>
            <span className="min-w-0 flex-1">
              <span className={`block truncate text-[13px] text-[#14213D] ${r.total ? 'font-bold' : 'font-semibold'}`}>{r.title}</span>
              {r.sub && <span className="block truncate text-[11px] text-[#4A5568]">{r.sub}</span>}
              {r.meta && <span className="block truncate text-[10px] text-[#6B7280]">{r.meta}</span>}
              {r.badge && <span className="mt-1 block">{r.badge}</span>}
            </span>
            {r.figures?.map((f) => (
              <span key={f.label} className="shrink-0 text-right">
                <span className={`block font-mono text-[13px] font-semibold ${TONE[f.tone ?? 'default']}`}>{f.value}</span>
                <span className="block text-[9px] font-medium uppercase tracking-wide text-[#6B7280]">{f.label}</span>
              </span>
            ))}
            {(expandable || r.onOpen) && (
              <ChevronDown className={`h-4 w-4 shrink-0 text-[#6B7280] transition-transform ${r.onOpen ? '-rotate-90' : isOpen ? 'rotate-180' : ''}`} />
            )}
          </>
        );
        const cls = `flex w-full items-center gap-3 py-3 text-left ${r.total ? 'rounded-lg bg-[#FBFAF7] px-2' : ''} ${r.dim ? 'opacity-45' : ''}`;
        return (
          <li key={r.key}>
            {expandable || r.onOpen ? (
              <button type="button" className={cls} aria-expanded={expandable ? isOpen : undefined} onClick={() => (r.onOpen ? r.onOpen() : setOpen(isOpen ? null : r.key))}>
                {body}
              </button>
            ) : (
              <div className={cls}>{body}</div>
            )}
            {expandable && isOpen && <FactList items={r.details!} className="pb-3" />}
          </li>
        );
      })}
    </ul>
  );
};

/**
 * A report card's view switch (Zone / Region / Salesperson …): segmented buttons on a wide screen (1280px+, where they
 * fit), one plain "Zone ▾" button below that — a bottom sheet on a phone — so there is never a strip with scroll arrows.
 */
export const ReportSwitch: React.FC<{
  label: string;
  value: string;
  options: { id: string; label: string; count?: number; icon?: React.ReactNode }[];
  onChange: (id: string) => void;
}> = ({ label, value, options, onChange }) => (
  <>
    <div className="max-w-full max-xl:hidden">
      <Tabs variant="segmented" size="sm" activeTab={value} onChange={onChange} tabs={options} />
    </div>
    <FilterMenu
      label={label}
      compactOnPhone
      dock={false}
      neutralKeys={[]}
      align="right"
      className="shrink-0 xl:hidden"
      options={options.map((o) => ({ key: o.id, label: o.label, count: o.count, icon: o.icon, active: o.id === value, onSelect: () => onChange(o.id) }))}
    />
  </>
);


/* ------------------------------------------------------------------------------------------------------ data -- */

/** GET a report; keeps the last result on screen while a new filter loads. */
export function useReport<T>(path: string, query: Record<string, string>, enabled: boolean) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(query);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .get<T>(path, JSON.parse(key))
      .then((r) => alive && setData(r))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : 'Could not load this report.'))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [path, key, enabled, nonce]);
  return { data, loading, error, reload: () => setNonce((n) => n + 1) };
}

/* ------------------------------------------------------------------------------------------------ formatting -- */

/** ₹ in Lakh / Crore once it is large enough to need it. */
export const money = (v: number | null | undefined) => formatIndianCurrency(v ?? 0, true);
export const pctText = (r: number | null | undefined) => (r === null || r === undefined ? '—' : `${r}%`);
export const rateSub = (r: ReportRate, of: string) => (r.whole > 0 ? `${r.part} of ${r.whole} ${of}` : `No ${of} in this period`);
export const fmtDay = (d: string) =>
  new Date(`${d}T00:00:00+05:30`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

/** Downloads rows as a UTF-8 CSV (Excel-safe: BOM, quoted cells, formula-injection guard). */
export function downloadCsv(fileName: string, header: string[], rows: (string | number | null | undefined)[][]) {
  const esc = (v: string | number | null | undefined) => {
    if (v === null || v === undefined) return '""';
    const s = String(v);
    const safe = typeof v !== 'number' && /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const csv = '﻿' + [header, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${fileName}_${istToday()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
