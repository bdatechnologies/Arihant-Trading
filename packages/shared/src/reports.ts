/**
 * Cross-module management reports (Scope Blueprint §36 Tender Reporting, §34 Service Dashboard, §40 Standardised
 * Expense Reporting, §42–44 Productivity & Performance, §45 Management Command). Responses of GET /reports/*.
 *
 * Every figure is counted from the operational records the modules already write — nothing is re-entered for
 * reporting. Rates are null when their denominator is 0 (never a fake 0 % / 100 %). Money is in rupees.
 */
import type { UserRole } from './enums.js';

export type ReportKey = 'pipeline' | 'service' | 'expenses' | 'productivity' | 'mis' | 'securities' | 'sheets';

/**
 * Who may open each report (the API's @Roles guard and the web tabs both read this). Territory scoping is applied
 * server-side on top: a regional manager always sees their own zone / team only.
 */
export const REPORT_ROLES: Record<ReportKey, readonly UserRole[]> = {
  pipeline: ['management', 'admin', 'regional_manager', 'tender_team'],
  service: ['management', 'admin', 'regional_manager'],
  expenses: ['management', 'admin', 'accounts', 'regional_manager'],
  productivity: ['management', 'admin', 'accounts', 'regional_manager'],
  // Tender team processes EMDs, Accounts accounts for EMD / PBG, the regional manager tracks their zone's (RBAC spec §2).
  mis: ['management', 'admin', 'regional_manager', 'tender_team', 'accounts'],
  securities: ['management', 'admin', 'regional_manager', 'tender_team', 'accounts'],
  // The workbook sheets; each sheet narrows further (SHEETS[].roles).
  sheets: ['management', 'admin', 'regional_manager', 'tender_team', 'accounts'],
};

export function canViewReport(role: UserRole | string | null | undefined, report: ReportKey): boolean {
  return !!role && (REPORT_ROLES[report] as readonly string[]).includes(role);
}

export interface ReportPeriod {
  /** IST calendar day, inclusive. */
  from: string;
  /** IST calendar day, inclusive. */
  to: string;
}

/** A rate with the counts it was computed from, so a screen can show "7 / 12 (58.3 %)". */
export interface ReportRate {
  part: number;
  whole: number;
  /** part ÷ whole × 100, one decimal; null when whole is 0. */
  rate: number | null;
}

/** Territory picker state: management / admin may choose a zone and region; a regional manager is locked to theirs. */
export interface ReportTerritoryFilters {
  zone_id: string | null;
  region_id: string | null;
  can_pick_zone: boolean;
  can_pick_region: boolean;
  zones: { id: string; name: string; code: string | null }[];
  regions: { id: string; name: string; zone_id: string | null }[];
}

export interface ReportCount {
  key: string;
  label: string;
  count: number;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Report 1 — Sales pipeline & conversion (leads → visits → demos → proposals → tenders)                              */
/* ------------------------------------------------------------------------------------------------------------------ */

export type PipelineGroupBy = 'zone' | 'region' | 'salesperson';
export type PipelineModuleKey = 'leads' | 'visits' | 'demos' | 'proposals' | 'tenders';

export interface PipelineStage {
  /** Stored status code. */
  key: string;
  label: string;
  count: number;
  /** ₹ value of the records at this stage (lead value, proposal quoted value, tender value); null where not tracked. */
  value: number | null;
  /** The stage ends the record's journey (won / lost / converted / cancelled / completed …). */
  terminal: boolean;
}

/** One module's records in the period, by their current stage (workflow order). */
export interface PipelineModule {
  key: PipelineModuleKey;
  label: string;
  /** Which date puts a record in the period, e.g. "Created", "Planned date". */
  period_basis: string;
  total: number;
  value: number | null;
  stages: PipelineStage[];
}

/**
 * Lead journey: of the leads created in the period, how many reached each touchpoint. Visits and tenders are matched
 * through the lead's customer organisation (on or after the lead's creation); demos and proposals through the lead,
 * else the organisation. Each step is a share of the leads created — a lead can skip a step.
 */
export interface PipelineJourneyStep {
  key: 'created' | 'visited' | 'demo' | 'proposal' | 'tender' | 'converted';
  label: string;
  count: number;
  /** count ÷ leads created × 100; null when no leads were created. */
  share: number | null;
}

export interface PipelineRates {
  /** Leads created in the period that are now converted / won ÷ leads created in the period (Module 9 definition). */
  lead_conversion: ReportRate;
  /** Visits planned in the period: completed ÷ not cancelled. */
  visit_completion: ReportRate;
  /** Demos held in the period: latest outcome "success" ÷ completed. */
  demo_success: ReportRate;
  /** Proposals decided in the period (outcome date): converted ÷ (converted + lost). */
  proposal_win: ReportRate;
  /** Tenders decided in the period (result date): won ÷ (won + lost) (Module 9 definition). */
  tender_win: ReportRate;
}

export interface PipelineValues {
  /** ₹ value of every open lead in scope right now (snapshot). */
  open_leads: number;
  /** ₹ quoted value of proposals still in play right now (snapshot). */
  open_proposals: number;
  /** ₹ value of live tenders (not won / lost / cancelled / rejected) right now (snapshot). */
  live_tenders: number;
  /** ₹ value of tenders won in the period. */
  tenders_won: number;
  /** ₹ quoted value of proposals converted in the period. */
  proposals_converted: number;
}

/** Blueprint §36 Tender Reporting (the PQ and General / MHA counts requested by Vikas). */
export interface TenderReportFigures {
  /** Tenders identified (created) in the period. */
  identified: number;
  pq: number;
  general_mha: number;
  other: number;
  /** Identified in the period and taken up (past identification / approval, not rejected internally). */
  worked_upon: number;
  /** Submitted in the period (status at or past submission). */
  submitted: number;
  /** Result in the period. */
  won: number;
  lost: number;
  /** Identified in the period and still undecided (not won / lost / cancelled / rejected). */
  pending: number;
  win_rate: number | null;
}

export interface PipelineLossReasons {
  leads: ReportCount[];
  demos: ReportCount[];
  proposals: ReportCount[];
  tenders: ReportCount[];
}

/** One zone / region / salesperson. Each record is attributed to one owner and one territory, so rows add up. */
export interface PipelineBreakdownRow {
  /** Zone / region / user id; 'none' for records with no territory or owner. */
  key: string;
  label: string;
  zone_name: string | null;
  region_name: string | null;
  leads_created: number;
  leads_converted: number;
  lead_conversion_rate: number | null;
  /** Open leads right now (snapshot). */
  open_leads: number;
  /** ₹ value of open leads right now (snapshot). */
  open_lead_value: number;
  visits_completed: number;
  demos_completed: number;
  demos_successful: number;
  proposals_sent: number;
  proposals_converted: number;
  proposals_lost: number;
  tenders_submitted: number;
  tenders_won: number;
  tenders_lost: number;
  tender_win_rate: number | null;
  /** ₹ value of tenders won in the period. */
  tender_won_value: number;
  /** ₹ value of live tenders right now (snapshot). */
  live_tender_value: number;
}

export interface SalesPipelineReportDto {
  period: ReportPeriod;
  group_by: PipelineGroupBy;
  filters: ReportTerritoryFilters;
  rates: PipelineRates;
  values: PipelineValues;
  journey: PipelineJourneyStep[];
  modules: PipelineModule[];
  tender: TenderReportFigures;
  loss_reasons: PipelineLossReasons;
  breakdown: {
    rows: PipelineBreakdownRow[];
    totals: PipelineBreakdownRow;
  };
  generated_at: string;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Report 2 — Service closure time & repeat complaints (Blueprint §34)                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

export type ServiceReportGroupBy = 'engineer' | 'region' | 'zone' | 'priority';

/** Right now, in scope (same definitions as the Service Desk tiles). */
export interface ServiceSnapshot {
  new: number;
  /** Every ticket not resolved / report submitted / closed / cancelled. */
  pending: number;
  /** Pending with an engineer assigned. */
  assigned: number;
  /** Pending, SLA clock running, and the planned visit day or the resolution deadline has passed. */
  overdue: number;
  awaiting_parts: number;
  escalated: number;
  /** Pending, clock running, resolution deadline passed. */
  sla_breached: number;
}

export interface ServiceClosureFigures {
  /** Tickets received (complaint received day) in the period. */
  received: number;
  /** Tickets closed (closed_at) in the period. */
  closed: number;
  /** Work finished (resolved / report submitted / closed) in the period. */
  completed: number;
  /** Closure time (received → closed) over tickets closed in the period, in days to one decimal. */
  avg_closure_days: number | null;
  median_closure_days: number | null;
  /** 90th percentile closure time — the slow tail. */
  p90_closure_days: number | null;
  /** Closed in the period with a resolution deadline: resolved (else closed) on or before it. */
  within_sla: ReportRate;
  /** Received in the period and flagged a repeat complaint (same customer + serial / product inside the window). */
  repeats: number;
  repeat_rate: number | null;
}

export interface ServiceBreakdownRow {
  /** Engineer / region / zone id or priority code; 'none' when not set. */
  key: string;
  label: string;
  detail: string | null;
  received: number;
  closed: number;
  avg_closure_days: number | null;
  median_closure_days: number | null;
  within_sla_rate: number | null;
  repeats: number;
  /** Snapshot: pending right now. */
  open: number;
  /** Snapshot: overdue right now. */
  overdue: number;
}

export interface ServiceTrendPoint {
  /** 'YYYY-MM' */
  month: string;
  received: number;
  closed: number;
  avg_closure_days: number | null;
  repeats: number;
}

/** A customer site where the same equipment keeps coming back. */
export interface ServiceRepeatHotspot {
  organisation_id: string;
  organisation_name: string;
  /** Serial number, else the product name. */
  equipment: string;
  /** Tickets received in the period for this customer + equipment. */
  tickets: number;
  repeats: number;
  /** Of those, still pending. */
  open: number;
  last_received: string;
}

export interface ServiceReportDto {
  period: ReportPeriod;
  group_by: ServiceReportGroupBy;
  filters: ReportTerritoryFilters;
  snapshot: ServiceSnapshot;
  closure: ServiceClosureFigures;
  /** Closed in the period, by priority: average closure in hours (same-day closures do not round to 0). */
  closure_by_priority: { priority: string; closed: number; avg_hours: number | null }[];
  repeat_by_category: { category: string; received: number; repeats: number }[];
  hotspots: ServiceRepeatHotspot[];
  trend: ServiceTrendPoint[];
  breakdown: { rows: ServiceBreakdownRow[]; totals: ServiceBreakdownRow };
  /** Repeat complaint window from the service settings (days). */
  repeat_window_days: number;
  generated_at: string;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Report 3 — Expense breakdown (Blueprint §40 Standardised Expense Reporting)                                       */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The §40 filters (employee, trip, customer, date, category, region, approval status) plus month as pivots. */
export type ExpenseReportGroupBy = 'employee' | 'trip' | 'customer' | 'date' | 'month' | 'category' | 'region' | 'status';

export interface ExpenseAmounts {
  /** Expense lines. */
  items: number;
  /** Distinct claims. */
  claims: number;
  /** ₹ claimed (line amounts). */
  claimed: number;
  /** ₹ approved so far (manager / accounts approved line amounts). */
  approved: number;
  /** ₹ claimed on claims still in review or clarification. */
  pending: number;
  /** ₹ claimed on rejected / withdrawn claims. */
  rejected: number;
  /** ₹ approved on processed (paid) claims. */
  paid: number;
}

export interface ExpenseBreakdownRow extends ExpenseAmounts {
  /** Group value (id, date, status code); 'none' when not set (e.g. a line with no customer). */
  key: string;
  label: string;
  detail: string | null;
  /** Distinct employees in the group. */
  employees: number;
}

export interface ExpenseReportDto {
  period: ReportPeriod;
  group_by: ExpenseReportGroupBy;
  filters: ReportTerritoryFilters;
  /** Claim statuses applied (empty = every non-draft status). */
  statuses: string[];
  totals: ExpenseAmounts & {
    employees: number;
    /** claimed ÷ distinct claims. */
    avg_per_claim: number | null;
    /** approved ÷ claimed on claims that finished review (approved, paid or rejected), as a %. */
    approval_rate: number | null;
  };
  /** Claimed amount per approval stage (Stage 1 · Manager, Clarification, Stage 2 · Accounts, Settled, Rejected). */
  stages: { key: string; label: string; claims: number; amount: number }[];
  /** Category mix of the period, whatever the grouping. */
  categories: { key: string; label: string; amount: number }[];
  rows: ExpenseBreakdownRow[];
  generated_at: string;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Report 4 — Employee productivity indicators (Blueprint §42–43, Module 8 evidence + cross-module activity)          */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Task evidence for the period — the Module 8 accountability figures, unchanged (same rules as Team Performance). */
export interface ProductivityTaskFigures {
  /** Tasks due (original deadline) in the period, cancelled / backlog excluded. */
  assigned: number;
  completed: number;
  on_time: number;
  late_excused: number;
  late_unexcused: number;
  /** on_time ÷ completed × 100. */
  on_time_pct: number | null;
  /** Open and past deadline right now. */
  overdue_now: number;
  /** Open tasks without a progress update inside their priority's window, right now. */
  no_update: number;
  /** Blockers accepted by the manager (excused delays). */
  approved_blockers: number;
  /** Late without an accepted blocker, still open past deadline, or blocker rejected. */
  unapproved_delays: number;
  /** Reworked or reopened. */
  incomplete_work: number;
  /** Late-unexcused completions inside the repeated-delay window reached the threshold, or excessive extensions. */
  repeated_delay_flag: boolean;
}

/** Work logged in the other modules in the period (each on its own date rule, as on the module's own reports). */
export interface ProductivityActivity {
  visits_planned: number;
  visits_completed: number;
  interactions: number;
  followups_done: number;
  leads_created: number;
  proposals_sent: number;
  tenders_submitted: number;
  /** Completed demos the person conducted (assigned engineer or coordinator). */
  demos_conducted: number;
  /** Service tickets assigned to them and closed in the period. */
  tickets_closed: number;
  avg_closure_days: number | null;
  /** ₹ claimed on their non-draft expense lines dated in the period. */
  expenses_claimed: number;
}

export interface ProductivityRow {
  employee_id: string;
  name: string;
  role: string;
  is_active: boolean;
  department: string | null;
  manager: string | null;
  region_name: string | null;
  zone_name: string | null;
  tasks: ProductivityTaskFigures;
  activity: ProductivityActivity;
  /** Factual reasons this person may need a manager's attention (never a score or a pay recommendation). */
  attention: string[];
}

export interface ProductivityReportDto {
  period: ReportPeriod;
  /** 'all' for management / admin / accounts, 'team' for a manager's own team. */
  scope: 'all' | 'team';
  filters: ReportTerritoryFilters;
  /** Roles present in scope, for the role filter. */
  roles: string[];
  role: string | null;
  totals: { employees: number; needing_attention: number; tasks: ProductivityTaskFigures; activity: ProductivityActivity };
  rows: ProductivityRow[];
  settings: { repeated_delay_threshold: number; repeated_delay_window_days: number };
  generated_at: string;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Report 5 — Business MIS (zone / person / state / product)                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

export type MisGroupBy = 'zone' | 'person' | 'state' | 'product';

/**
 * One MIS line. Flows count in the period (tenders by identified / submitted / result date, orders by result or
 * conversion date, service cases by closed date); snapshots (evaluation, deliveries, open cases, follow-ups, money
 * held) are as of now.
 */
export interface MisFigures {
  /** Tenders identified (logged) in the period. */
  tenders_total: number;
  tenders_submitted: number;
  /** Now in technical or commercial evaluation. */
  tenders_under_evaluation: number;
  /** Now submitted (or PQ submitted) with evaluation not yet started. */
  tenders_result_awaited: number;
  tenders_won: number;
  tenders_lost: number;
  /** won ÷ (won + lost); null when nothing was decided. */
  win_rate: number | null;
  /** Value of the tenders identified in the period. */
  tender_value: number;
  /** Units asked for across the tenders identified in the period. */
  tender_quantity: number;
  /** Tenders won plus proposals converted to a purchase order in the period. */
  orders: number;
  /** Awarded value of the tenders won (else the tender value) plus the quoted value of converted proposals. */
  order_value: number;
  /** Deliveries scheduled, dispatched or in transit. */
  pending_deliveries: number;
  open_service_cases: number;
  /** Closed in the period (same rule as the Service report). */
  closed_service_cases: number;
  pending_follow_ups: number;
  /** EMD paid out and not back yet (issued, submitted or refund due). */
  emd_blocked: number;
  /** Of that, EMD the customer now owes back (bid lost or cancelled). */
  emd_refund_due: number;
  /** Performance bank guarantees and security deposits issued, submitted or due back. */
  security_held: number;
}

export interface MisRow extends MisFigures {
  key: string;
  label: string;
  /** Person: region · zone. Product: its category. Otherwise null. */
  sub: string | null;
}

export interface MisReportDto {
  period: ReportPeriod;
  group_by: MisGroupBy;
  filters: ReportTerritoryFilters;
  rows: MisRow[];
  totals: MisRow;
  generated_at: string;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Report 6 — EMD & performance security register                                                                     */
/* ------------------------------------------------------------------------------------------------------------------ */

/** EMD, or performance security (PBG and security deposits). */
export type SecurityKind = 'emd' | 'performance';
/** Where the money is: not paid yet, with the customer, owed back, back with us, or gone (forfeited / expired). */
export type SecurityState = 'pending' | 'held' | 'refund_due' | 'returned' | 'closed';

export const SECURITY_STATE_STATUSES: Record<SecurityState, readonly string[]> = {
  pending: ['Requested', 'Approved'],
  held: ['Issued', 'Submitted'],
  refund_due: ['Refund Due'],
  returned: ['Refunded', 'Released'],
  closed: ['Forfeited', 'Expired'],
};

export const SECURITY_STATE_LABELS: Record<SecurityState, string> = {
  pending: 'Not paid yet',
  held: 'With customer',
  refund_due: 'Refund due',
  returned: 'Returned',
  closed: 'Forfeited / expired',
};

export interface SecurityRegisterRow {
  id: string;
  tender_id: string;
  instrument_type: string;
  status: string;
  state: SecurityState;
  amount: number | null;
  /** How it was paid: Online, DD, BG, FDR … */
  mode: string | null;
  bank: string | null;
  reference_number: string | null;
  issue_date: string | null;
  expiry_date: string | null;
  /** Days from today to expiry; negative once expired; null without an expiry date. */
  days_to_expiry: number | null;
  remarks: string | null;
  tender_no: string | null;
  tender_title: string | null;
  tender_status: string | null;
  bid_date: string | null;
  /** PO / LoA / order number from the tender result. */
  contract_no: string | null;
  contract_date: string | null;
  customer: string | null;
  department: string | null;
  state_name: string | null;
  zone_name: string | null;
  item: string | null;
  quantity: number | null;
  owner_name: string | null;
  finance_owner_name: string | null;
}

export interface SecurityStateTotal {
  count: number;
  amount: number;
}

export interface SecurityRegisterDto {
  kind: SecurityKind;
  /** null = every state. */
  state: SecurityState | null;
  filters: ReportTerritoryFilters;
  /** Per state for this kind, territory and search (ignores the state filter). */
  by_state: Record<SecurityState, SecurityStateTotal>;
  /** Held or refund due, expiring within 30 days (or already expired). */
  expiring: SecurityStateTotal;
  data: SecurityRegisterRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  generated_at: string;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Report 7 — Dashboard sheets (the client's "ALL DASHBOARDS" workbook, one sheet per register / MIS table)             */
/* ------------------------------------------------------------------------------------------------------------------ */

export type SheetKey =
  | 'tenders'
  | 'emd'
  | 'performance_security'
  | 'demonstrations'
  | 'orders'
  | 'deliveries'
  | 'service'
  | 'zone_mis'
  | 'person_mis'
  | 'state_mis'
  | 'product_mis'
  | 'pipeline'
  | 'quotations'
  | 'expenses';

export type SheetGroup = 'bids' | 'execution' | 'mis' | 'sales';

export const SHEET_GROUP_LABELS: Record<SheetGroup, string> = {
  bids: 'Bids & securities',
  execution: 'Orders & execution',
  mis: 'MIS',
  sales: 'Sales & expenses',
};

/** money = ₹, percent = 0–100 one decimal, yesno = 'Yes' / 'No' / blank, status = a badge. */
export type SheetCellKind = 'text' | 'date' | 'money' | 'number' | 'percent' | 'yesno' | 'status';

export interface SheetColumn {
  key: string;
  /** The workbook's own column heading. */
  label: string;
  kind: SheetCellKind;
}

export interface SheetDef {
  key: SheetKey;
  /** The workbook's sheet heading. */
  title: string;
  group: SheetGroup;
  /** Which date puts a row in the period; null = a register of every open item (no period). */
  period_basis: string | null;
  columns: SheetColumn[];
  /** Workbook columns this sheet cannot fill because BOS does not hold that data (Tally, inventory …). */
  not_tracked: string[];
  roles: readonly UserRole[];
}

const col = (key: string, label: string, kind: SheetCellKind = 'text'): SheetColumn => ({ key, label, kind });
const SHEET_ALL: UserRole[] = ['management', 'admin', 'regional_manager', 'tender_team', 'accounts'];
const MIS_COLUMNS = (first: SheetColumn[]): SheetColumn[] => [
  ...first,
  col('tenders_total', 'Total Tenders', 'number'),
  col('tenders_submitted', 'Tenders Submitted', 'number'),
  col('tenders_under_evaluation', 'Tenders Under Evaluation', 'number'),
  col('tenders_won', 'Tenders Won', 'number'),
  col('tenders_lost', 'Tenders Lost', 'number'),
  col('tenders_result_awaited', 'Tenders Result Awaited', 'number'),
  col('win_rate', 'Win Rate %', 'percent'),
  col('tender_value', 'Total Tender Value', 'money'),
  col('orders', 'Total Orders', 'number'),
  col('order_value', 'Total Order Value', 'money'),
  col('pending_deliveries', 'Pending Deliveries', 'number'),
  col('open_service_cases', 'Open Service Cases', 'number'),
  col('closed_service_cases', 'Closed Service Cases', 'number'),
  col('emd_blocked', 'EMD Blocked Amount', 'money'),
  col('security_held', 'Performance Security Blocked', 'money'),
];
const MIS_NOT_TRACKED = ['Total Invoice Value', 'Payment Received', 'Outstanding Amount', 'Pending Delivery Value'];

/** Every sheet, in workbook order. The API fills the columns; the web lays them out and exports them as-is. */
export const SHEETS: readonly SheetDef[] = [
  {
    key: 'tenders',
    title: 'Tenders details',
    group: 'bids',
    period_basis: 'Bid issue date (else the day it was logged)',
    roles: SHEET_ALL,
    not_tracked: ['Participants'],
    columns: [
      col('zone', 'Zone'),
      col('person', 'Name of the Person Handling'),
      col('customer', 'Customer / Department'),
      col('state', 'State'),
      col('equipment', 'Name of Equipment'),
      col('quantity', 'Quantity', 'number'),
      col('bid_no', 'BID NO'),
      col('issue_date', 'Bid Issue Date', 'date'),
      col('closing_date', 'Bid closing Date', 'date'),
      col('prebid_date', 'Pre-Bid Date', 'date'),
      col('corrigendum_date', 'Corrigendum / Representation Date', 'date'),
      col('ra', 'RA (YES/NO)', 'yesno'),
      col('oem_turnover', 'OEM Turnover requirement'),
      col('bidder_turnover', 'Bidder Turnover requirement'),
      col('emd', 'EMD', 'money'),
      col('stage', 'Stage', 'status'),
      col('remark', 'Remark'),
    ],
  },
  {
    key: 'emd',
    title: 'EMD (Earnest Money Deposit)',
    group: 'bids',
    period_basis: null,
    roles: SHEET_ALL,
    not_tracked: [],
    columns: [
      col('zone', 'Zone'),
      col('person', 'Name of the Person Handling'),
      col('issue_date', 'Date of Issue', 'date'),
      col('form', 'EMD Form'),
      col('details', 'EMD Details'),
      col('bid_no', 'Bid No.'),
      col('bid_date', 'Bid Date', 'date'),
      col('department', 'Name of Department'),
      col('state', 'State'),
      col('item', 'Item'),
      col('quantity', 'Quantity', 'number'),
      col('amount', 'EMD Amount', 'money'),
      col('expiry_date', 'Exp. Date', 'date'),
      col('receiving', 'EMD Receiving (Yes/No)', 'yesno'),
      col('status', 'Status', 'status'),
      col('remark', 'Remark'),
    ],
  },
  {
    key: 'performance_security',
    title: 'Performance security',
    group: 'bids',
    period_basis: null,
    roles: SHEET_ALL,
    not_tracked: [],
    columns: [
      col('zone', 'Zone'),
      col('person', 'Name of the Person Handling'),
      col('issue_date', 'Date of Issue', 'date'),
      col('details', 'Performance security Details'),
      col('bid_no', 'Bid No.'),
      col('contract_no', 'Contract No.'),
      col('bid_date', 'Bid Date', 'date'),
      col('contract_date', 'Contract Date', 'date'),
      col('department', 'Name of Department'),
      col('state', 'State'),
      col('item', 'Item'),
      col('quantity', 'Quantity', 'number'),
      col('amount', 'Performance security Amount', 'money'),
      col('expiry_date', 'Exp. Date', 'date'),
      col('receiving', 'Performance Security Receiving (Yes/No)', 'yesno'),
      col('status', 'Status', 'status'),
      col('remark', 'Remark'),
    ],
  },
  {
    key: 'demonstrations',
    title: 'Demonstration report',
    group: 'bids',
    period_basis: 'Demo date (confirmed, else requested)',
    roles: ['management', 'admin', 'regional_manager', 'tender_team'],
    not_tracked: [],
    columns: [
      col('zone', 'Zone'),
      col('date', 'Date', 'date'),
      col('customer', 'Customer / Department'),
      col('state', 'State'),
      col('location', 'Demonstration Location'),
      col('tender', 'Tender Details'),
      col('equipment', 'Equipment Demonstrated'),
      col('conducted_by', 'Conducted By'),
      col('aspects', 'Operational Aspects Shown'),
      col('feedback', 'Participants / Committee Member Feedback / Observations'),
      col('audience', 'Name / Designation / Department / Mobile'),
      col('remarks', 'Remarks'),
      col('negative', 'Any Negative Feedback'),
      col('report', 'Demonstration Report (Yes/No)', 'yesno'),
      col('suggestions', 'Suggestions from the Department'),
      col('status', 'Status', 'status'),
      col('remark', 'Remark'),
    ],
  },
  {
    key: 'orders',
    title: 'Order details',
    group: 'execution',
    period_basis: 'Order date (bid result / proposal conversion)',
    roles: ['management', 'admin', 'regional_manager', 'tender_team', 'accounts'],
    not_tracked: ['GST %', 'HSN Code', 'Warranty Period'],
    columns: [
      col('zone', 'Zone'),
      col('person', 'Name of Person Handling'),
      col('customer', 'Customer / Department'),
      col('state', 'State'),
      col('bid_no', 'Bid No.'),
      col('po_no', 'Contract / PO No.'),
      col('po_date', 'Contract / PO Date', 'date'),
      col('item', 'Item / Equipment Name'),
      col('make', 'Make'),
      col('model', 'Model'),
      col('quantity', 'Quantity Ordered', 'number'),
      col('unit_rate', 'Unit Rate', 'money'),
      col('value', 'Total Order Value', 'money'),
      col('source', 'Order Source'),
    ],
  },
  {
    key: 'deliveries',
    title: 'Delivery report',
    group: 'execution',
    period_basis: 'Delivery date',
    roles: ['management', 'admin', 'regional_manager', 'tender_team', 'accounts'],
    not_tracked: ['Invoice No. & Date', 'Challan No. & Date'],
    columns: [
      col('zone', 'Zone'),
      col('person', 'Name of the Person Handling'),
      col('date', 'Delivery Date', 'date'),
      col('customer', 'Customer / Department'),
      col('state', 'State'),
      col('bid_no', 'Bid No.'),
      col('po_no', 'Contract / PO No.'),
      col('item', 'Item / Equipment Name'),
      col('qty_ordered', 'Quantity Ordered', 'number'),
      col('qty_delivered', 'Quantity Delivered', 'number'),
      col('location', 'Delivery Location'),
      col('report', 'Delivery Report (Yes/No)', 'yesno'),
      col('status', 'Status', 'status'),
      col('remark', 'Remark'),
    ],
  },
  {
    key: 'service',
    title: 'Service report',
    group: 'execution',
    period_basis: 'Complaint received date',
    roles: ['management', 'admin', 'regional_manager'],
    not_tracked: [],
    columns: [
      col('zone', 'Zone'),
      col('date', 'Service Date', 'date'),
      col('customer', 'Customer / Department'),
      col('state', 'State'),
      col('bid_no', 'Bid No.'),
      col('po_no', 'Contract / PO No.'),
      col('item', 'Item / Equipment Name'),
      col('serial', 'Serial No.'),
      col('ticket_no', 'Complaint / Service Request No.'),
      col('complaint', 'Nature of Complaint'),
      col('action', 'Service Action Taken'),
      col('engineer', 'Service Engineer Name'),
      col('report', 'Service Report (Yes/No)', 'yesno'),
      col('status', 'Service Status / Remarks', 'status'),
    ],
  },
  {
    key: 'zone_mis',
    title: 'Zone-wise MIS',
    group: 'mis',
    period_basis: 'Tenders identified / submitted / decided, orders and closed cases in the period; open items as of now',
    roles: ['management', 'admin', 'regional_manager', 'tender_team', 'accounts'],
    not_tracked: MIS_NOT_TRACKED,
    columns: MIS_COLUMNS([col('label', 'Zone')]),
  },
  {
    key: 'person_mis',
    title: 'Person-wise performance MIS',
    group: 'mis',
    period_basis: 'Tenders identified / submitted / decided, orders and closed cases in the period; open items as of now',
    roles: ['management', 'admin', 'regional_manager', 'tender_team', 'accounts'],
    not_tracked: ['Invoice Value', 'Payment Received', 'Outstanding Payment'],
    columns: [
      col('sub', 'Zone'),
      col('label', 'Name of Person Handling'),
      col('tenders_total', 'Total Tenders', 'number'),
      col('tenders_submitted', 'Submitted Tenders', 'number'),
      col('tenders_under_evaluation', 'Tenders Under Evaluation', 'number'),
      col('tenders_won', 'Won Tenders', 'number'),
      col('tenders_lost', 'Lost Tenders', 'number'),
      col('tenders_result_awaited', 'Result Awaited', 'number'),
      col('win_rate', 'Conversion %', 'percent'),
      col('tender_value', 'Total Tender Value', 'money'),
      col('orders', 'Total Orders', 'number'),
      col('order_value', 'Total Order Value', 'money'),
      col('pending_follow_ups', 'Pending Follow-ups', 'number'),
      col('pending_deliveries', 'Pending Deliveries', 'number'),
      col('open_service_cases', 'Open Service Cases', 'number'),
      col('emd_blocked', 'EMD Pending Return', 'money'),
      col('security_held', 'Performance Security Active', 'money'),
    ],
  },
  {
    key: 'state_mis',
    title: 'State-wise MIS',
    group: 'mis',
    period_basis: 'Tenders identified / submitted / decided, orders and closed cases in the period; open items as of now',
    roles: ['management', 'admin', 'regional_manager', 'tender_team', 'accounts'],
    not_tracked: MIS_NOT_TRACKED,
    columns: MIS_COLUMNS([col('label', 'State')]),
  },
  {
    key: 'product_mis',
    title: 'Product-wise business dashboard',
    group: 'mis',
    period_basis: 'Tenders identified / submitted / decided and orders in the period; open items as of now',
    roles: ['management', 'admin', 'regional_manager', 'tender_team', 'accounts'],
    not_tracked: ['Ordered Quantity', 'Delivered Quantity', 'Balance Quantity', 'Invoice Value', 'Payment Received', 'Outstanding Amount', 'AMC Potential'],
    columns: [
      col('label', 'Equipment Name'),
      col('sub', 'Category'),
      col('tenders_submitted', 'Total Tender Participated', 'number'),
      col('tender_quantity', 'Tender Quantity', 'number'),
      col('tenders_won', 'Tenders Won', 'number'),
      col('win_rate', 'Win Rate %', 'percent'),
      col('orders', 'Total Orders', 'number'),
      col('order_value', 'Order Value', 'money'),
      col('pending_deliveries', 'Pending Deliveries', 'number'),
      col('open_service_cases', 'Open Service Cases', 'number'),
    ],
  },
  {
    key: 'pipeline',
    title: 'Sales pipeline dashboard',
    group: 'sales',
    period_basis: 'Date identified (lead created)',
    roles: ['management', 'admin', 'regional_manager'],
    not_tracked: [],
    columns: [
      col('date', 'Date Identified', 'date'),
      col('zone', 'Zone'),
      col('person', 'Responsible Person'),
      col('customer', 'Customer / Department'),
      col('state', 'State'),
      col('description', 'Opportunity Description'),
      col('equipment', 'Equipment'),
      col('quantity', 'Expected Quantity', 'number'),
      col('value', 'Estimated Value', 'money'),
      col('tender_date', 'Expected Tender Date', 'date'),
      col('probability', 'Probability %', 'percent'),
      col('weighted', 'Weighted Value', 'money'),
      col('stage', 'Opportunity Stage', 'status'),
      col('order_date', 'Expected Order Date'),
      col('next_action', 'Next Action'),
      col('followup_date', 'Follow-up Date', 'date'),
    ],
  },
  {
    key: 'quotations',
    title: 'Quotation / price bid dashboard',
    group: 'sales',
    period_basis: 'Quotation requested date',
    roles: ['management', 'admin', 'regional_manager', 'tender_team'],
    not_tracked: ['Basic Value', 'GST'],
    columns: [
      col('zone', 'Zone'),
      col('person', 'Responsible Person'),
      col('customer', 'Customer / Department'),
      col('state', 'State'),
      col('quotation_no', 'Quotation No.'),
      col('date', 'Quotation Date', 'date'),
      col('validity', 'Validity Date', 'date'),
      col('equipment', 'Equipment'),
      col('quantity', 'Quantity', 'number'),
      col('value', 'Total Quotation Value', 'money'),
      col('status', 'Quotation Status', 'status'),
      col('followup_date', 'Follow-up Date', 'date'),
      col('remark', 'Remarks'),
    ],
  },
  {
    key: 'expenses',
    title: 'Expense and travel dashboard',
    group: 'sales',
    period_basis: 'Expense date',
    roles: ['management', 'admin', 'accounts', 'regional_manager'],
    not_tracked: ['Advance Received', 'Balance Amount'],
    columns: [
      col('date', 'Date', 'date'),
      col('employee', 'Employee Name'),
      col('zone', 'Zone'),
      col('department', 'Department'),
      col('type', 'Expense Type'),
      col('customer', 'Customer / Project'),
      col('from', 'Travel From'),
      col('to', 'Travel To'),
      col('amount', 'Expense Amount', 'money'),
      col('reimbursed', 'Amount Reimbursed', 'money'),
      col('status', 'Approval Status', 'status'),
      col('approved_by', 'Approved By'),
      col('remark', 'Remarks'),
    ],
  },
];

export function sheetDef(key: string): SheetDef | undefined {
  return SHEETS.find((s) => s.key === key);
}

export function canViewSheet(role: UserRole | string | null | undefined, key: SheetKey): boolean {
  const def = sheetDef(key);
  return !!role && !!def && (def.roles as readonly string[]).includes(role);
}

/** Lead probability band → the % the pipeline sheet weights its value by. */
export const LEAD_PROBABILITY_PCT: Record<string, number> = { high: 75, medium: 50, low: 25 };

export type SheetCell = string | number | null;

export interface SheetRow {
  id: string;
  /** Where the row opens in BOS (the tender dossier, demo, ticket …). */
  link: string | null;
  cells: Record<string, SheetCell>;
}

/** GET /reports/sheets/:key */
export interface SheetDto {
  key: SheetKey;
  title: string;
  period: ReportPeriod | null;
  filters: ReportTerritoryFilters;
  columns: SheetColumn[];
  not_tracked: string[];
  period_basis: string | null;
  rows: SheetRow[];
  /** Column totals for money / number columns (MIS sheets: the totals row). */
  totals: Record<string, SheetCell> | null;
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  generated_at: string;
}
