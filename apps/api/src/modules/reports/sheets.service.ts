import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Kysely, sql, type RawBuilder } from 'kysely';
import {
  LEAD_PROBABILITY_PCT,
  SERVICE_STATUS_LABELS,
  TENDER_FINANCIAL_INSTRUMENT_STATUSES,
  canViewSheet,
  instrumentReceiving,
  instrumentStatusLabel,
  sheetDef,
  type AuthUser,
  type Database,
  type MisGroupBy,
  type MisRow,
  type SheetCell,
  type SheetDef,
  type SheetDto,
  type SheetKey,
  type SheetRow,
} from '@arihant/shared';
import { KYSELY_DB } from '../../common/database/database.module.js';
import {
  DEMO_DAY,
  PROPOSAL_ORG,
  PROPOSAL_OUTCOME_DAY,
  PROPOSAL_OWNER,
  TENDER_OWNER,
  TENDER_RESULT_DAY,
  TENDER_ROW,
  istDay,
  territoryLeads,
  territoryTenders,
} from '../dashboard/dashboard-metrics.js';
import { ExpenseReportsService } from '../expense-management/expense-reports.service.js';
import { ServiceService } from '../service/service.service.js';
import { MisReportService } from './mis-report.service.js';
import { isNational, num, parseReportPeriod, resolveTerritory, territoryOwned, type ResolvedTerritory } from './report-scope.js';

type Cond = RawBuilder<unknown>;
type Row = Record<string, any>;

const MAX_LIMIT = 2000;
const MIS_GROUP: Partial<Record<SheetKey, MisGroupBy>> = { zone_mis: 'zone', person_mis: 'person', state_mis: 'state', product_mis: 'product' };
const TENDER_VALUE = sql`greatest(coalesce(t.tender_value, t.estimated_value, 0), 0)`;
const DELIVERED = ['delivered', 'installed', 'handover_completed'];
const LIVE_INSTRUMENT = ['Issued', 'Submitted', 'Refund Due'];
const UNPAID_INSTRUMENT = ['Requested', 'Approved'];
/** "Org / Department" without a dangling slash. */
const customerOf = (org: Cond, dept: Cond) => sql`concat_ws(' / ', nullif(trim(${org}), ''), nullif(trim(${dept}), ''))`;
const stateOf = (orgState: Cond, own: Cond = sql`null`) => sql`coalesce(nullif(trim(${orgState}), ''), nullif(trim(${own}), ''))`;
const pretty = (v: unknown) =>
  v === null || v === undefined || v === '' ? null : String(v).replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

interface Ctx {
  user: AuthUser;
  def: SheetDef;
  scope: ResolvedTerritory;
  from: string;
  to: string;
  inP: (day: Cond) => Cond;
  search: string;
  like: string;
  status: string | null;
  limit: number;
  page: number;
}

/**
 * Report 7 — the client's "ALL DASHBOARDS" workbook (GET /reports/sheets/:key): each sheet's own columns, filled from
 * the records the modules already hold (enter once, use everywhere). Column definitions are shared (SHEETS), so the
 * screen, the CSV export and this service agree on every heading.
 *
 * Scope follows the module reports: tender-based sheets use the tender territory (territoryTenders), demos / proposals
 * / deliveries their customer's territory or owner (territoryOwned), leads the lead territory, service tickets the
 * Service Desk scope and expenses the claim scope. Registers (EMD, performance security) list every instrument; the
 * other sheets take the period on their own date (SheetDef.period_basis).
 *
 * Query: from, to, zone_id, region_id, search, status (EMD / PBG sheets), page, limit (max 2000 — export).
 */
@Injectable()
export class SheetsService {
  constructor(
    @Inject(KYSELY_DB) private readonly db: Kysely<Database>,
    private readonly mis: MisReportService,
    private readonly service: ServiceService,
    private readonly expenses: ExpenseReportsService,
  ) {}

  async report(user: AuthUser, key: string, q: Record<string, unknown>): Promise<SheetDto> {
    const def = sheetDef(key);
    if (!def) throw new BadRequestException(`Unknown sheet "${key}"`);
    if (!canViewSheet(user.role, def.key)) throw new ForbiddenException('This sheet is not available for your role');

    const period = parseReportPeriod(q.from, q.to);
    const scope = await resolveTerritory(this.db, user, q.zone_id, q.region_id);
    const search = typeof q.search === 'string' ? q.search.trim().slice(0, 100) : '';
    const status = typeof q.status === 'string' && (TENDER_FINANCIAL_INSTRUMENT_STATUSES as string[]).includes(q.status) ? q.status : null;
    const ctx: Ctx = {
      user,
      def,
      scope,
      from: period.from,
      to: period.to,
      inP: (day) => sql`${day} between ${period.from}::date and ${period.to}::date`,
      search,
      like: `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
      status,
      limit: Math.min(Math.max(Math.trunc(num(q.limit)) || 50, 1), MAX_LIMIT),
      page: Math.max(Math.trunc(num(q.page)) || 1, 1),
    };

    const mis = MIS_GROUP[def.key];
    const result = mis
      ? await this.misSheet(ctx, mis, q)
      : await ({
          tenders: () => this.tenders(ctx),
          emd: () => this.instruments(ctx, ['EMD']),
          performance_security: () => this.instruments(ctx, ['PBG', 'Security Deposit']),
          demonstrations: () => this.demonstrations(ctx),
          orders: () => this.orders(ctx),
          deliveries: () => this.deliveries(ctx),
          service: () => this.serviceSheet(ctx),
          pipeline: () => this.pipeline(ctx),
          quotations: () => this.quotations(ctx),
          expenses: () => this.expenseSheet(ctx),
        } as Record<string, () => Promise<{ rows: SheetRow[]; total: number; totals?: Record<string, SheetCell> | null }>>)[def.key]();

    return {
      key: def.key,
      title: def.title,
      period: def.period_basis ? period : null,
      filters: scope.filters,
      columns: def.columns,
      not_tracked: def.not_tracked,
      period_basis: def.period_basis,
      rows: result.rows,
      totals: result.totals ?? null,
      total: result.total,
      page: mis ? 1 : ctx.page,
      limit: mis ? Math.max(result.total, 1) : ctx.limit,
      totalPages: mis ? 1 : Math.max(1, Math.ceil(result.total / ctx.limit)),
      generated_at: new Date().toISOString(),
    };
  }

  /* ------------------------------------------------------------------------------------------------- helpers -- */

  /** Runs `select <cols>, count(*) over() … <from> where <where> order by … limit/offset` and sums money / number columns. */
  private async page(ctx: Ctx, query: { select: Cond; from: Cond; where: Cond; order: Cond; computed?: string[] }) {
    // Money columns are totalled in SQL, except a rate and the ones filled in after the query (`computed`).
    const sums = ctx.def.columns.filter((c) => c.kind === 'money' && c.key !== 'unit_rate' && !query.computed?.includes(c.key));
    const [list, agg] = await Promise.all([
      sql<Row>`select ${query.select}, count(*) over()::int as _total ${query.from} where ${query.where}
        order by ${query.order} limit ${ctx.limit} offset ${(ctx.page - 1) * ctx.limit}`.execute(this.db),
      sums.length
        ? sql<Row>`select ${sql.join(sums.map((c) => sql`coalesce(sum(s.${sql.ref(c.key)}), 0)::float as ${sql.ref(c.key)}`))}
            from (select ${query.select} ${query.from} where ${query.where}) s`.execute(this.db)
        : Promise.resolve({ rows: [] as Row[] }),
    ]);
    const totals: Record<string, SheetCell> | null = sums.length ? Object.fromEntries(sums.map((c) => [c.key, Math.round(num(agg.rows[0]?.[c.key]))])) : null;
    return { rows: list.rows, total: num(list.rows[0]?._total), totals };
  }

  /** Keeps the sheet's columns only, numbers as numbers. */
  private toRow(ctx: Ctx, r: Row, link: string | null): SheetRow {
    const cells: Record<string, SheetCell> = {};
    for (const c of ctx.def.columns) {
      const v = r[c.key];
      if (v === undefined || v === null || v === '') cells[c.key] = null;
      else if (c.kind === 'money' || c.kind === 'number' || c.kind === 'percent') cells[c.key] = Number.isFinite(Number(v)) ? Number(v) : null;
      else if (c.kind === 'date') cells[c.key] = String(v instanceof Date ? v.toISOString() : v).slice(0, 10);
      else cells[c.key] = String(v);
    }
    return { id: String(r.id), link, cells };
  }

  private searchAny(ctx: Ctx, cols: Cond[]): Cond {
    if (!ctx.search) return sql`true`;
    return sql`(${sql.join(cols.map((c) => sql`${c} ilike ${ctx.like}`), sql` or `)})`;
  }

  /* ------------------------------------------------------------------------------------------------- sheets -- */

  /** TENDERS DETAILS — every bid identified in the period with its dates, eligibility and EMD. */
  private async tenders(ctx: Ctx) {
    const issueDay = sql`coalesce(t.publication_date, ${istDay(sql`t.created_at`)})`;
    const res = await this.page(ctx, {
      select: sql`t.id, z.name as zone, ow.full_name as person,
        ${customerOf(sql`o.name`, sql`coalesce(t.department, o.department)`)} as customer,
        ${stateOf(sql`o.state`, sql`t.state`)} as state, coalesce(pr.name, t.requirement_text) as equipment, t.quantity,
        coalesce(t.tender_no, t.tender_number) as bid_no, coalesce(t.publication_date, t.publish_date)::text as issue_date,
        ${istDay(sql`coalesce(t.submission_deadline, t.bid_closing_date)`)}::text as closing_date,
        coalesce(${istDay(sql`t.pre_bid_meeting_date`)}, t.prebid_date)::text as prebid_date,
        coalesce(cg.issued_date::text, nullif(trim(t.corrigendum_date), '')) as corrigendum_date,
        case when t.tender_type = 'Reverse Auction' then 'Yes' else 'No' end as ra,
        t.oem_turnover, t.bidder_turnover,
        case when coalesce(t.emd_required, false) then nullif(coalesce(t.emd_amount, t.emd_fee), 0) end as emd,
        t.status::text as stage,
        concat_ws(' · ', nullif(trim(t.remarks), ''),
          case when not coalesce(t.emd_required, false) and nullif(trim(t.emd_exemption_reason), '') is not null then 'EMD exempt: ' || t.emd_exemption_reason end) as remark`,
      from: sql`from tenders t
        left join organisations o on o.id = t.organisation_id
        left join products pr on pr.id = t.product_id
        left join users ow on ow.id = ${TENDER_OWNER}
        left join zones z on z.id = coalesce(t.zone_id, o.zone_id)
        left join lateral (select c.issued_date from tender_corrigenda c where c.tender_id = t.id order by c.issued_date desc, c.created_at desc limit 1) cg on true`,
      where: sql`${TENDER_ROW} and ${territoryTenders(ctx.scope.territory)} and ${ctx.inP(issueDay)}
        and ${this.searchAny(ctx, [sql`t.tender_no`, sql`t.tender_number`, sql`t.tender_title`, sql`o.name`, sql`t.department`, sql`pr.name`, sql`t.requirement_text`, sql`ow.full_name`])}`,
      order: sql`coalesce(t.submission_deadline, t.bid_closing_date) desc nulls last, t.created_at desc`,
    });
    return { ...res, rows: res.rows.map((r) => this.toRow(ctx, { ...r, stage: pretty(r.stage) }, `/tenders?highlight=${r.id}`)) };
  }

  /** EMD / PERFORMANCE SECURITY — every instrument of these types: money with the buyer first, soonest expiry first. */
  private async instruments(ctx: Ctx, types: string[]) {
    const res = await this.page(ctx, {
      select: sql`i.id, i.tender_id, i.instrument_type, z.name as zone, ow.full_name as person, i.issue_date::text as issue_date, i.mode as form,
        concat_ws(' · ', nullif(trim(i.reference_number), ''), nullif(trim(i.bank), ''),
          case when nullif(trim(i.in_favour_of), '') is not null then 'favouring ' || i.in_favour_of end,
          case when ${types.includes('EMD') ? sql`false` : sql`true`} then i.instrument_type end) as details,
        coalesce(t.tender_no, t.tender_number) as bid_no,
        coalesce(t.submission_date, ${istDay(sql`coalesce(t.submission_deadline, t.bid_closing_date)`)})::text as bid_date,
        coalesce(r.po_number, r.order_number, r.loa_number) as contract_no, coalesce(r.loa_date, r.result_date)::text as contract_date,
        coalesce(nullif(trim(t.department), ''), nullif(trim(o.department), ''), o.name) as department,
        ${stateOf(sql`o.state`, sql`t.state`)} as state, coalesce(pr.name, t.requirement_text) as item, t.quantity,
        i.amount, i.expiry_date::text as expiry_date, i.status,
        concat_ws(' · ', nullif(trim(i.closure_reason), ''), nullif(trim(i.remarks), ''),
          case when i.received_date is not null then 'Received ' || to_char(i.received_date, 'DD Mon YYYY') || coalesce(' (' || nullif(trim(i.receipt_reference), '') || ')', '') end) as remark`,
      from: sql`from tender_financial_instruments i
        join tenders t on t.id = i.tender_id
        left join organisations o on o.id = t.organisation_id
        left join products pr on pr.id = t.product_id
        left join users ow on ow.id = ${TENDER_OWNER}
        left join zones z on z.id = coalesce(t.zone_id, o.zone_id)
        left join lateral (select x.po_number, x.order_number, x.loa_number, x.loa_date, x.result_date from tender_results x where x.tender_id = t.id order by x.created_at desc limit 1) r on true`,
      where: sql`${TENDER_ROW} and ${territoryTenders(ctx.scope.territory)} and i.instrument_type = any(${types}::text[])
        and ${ctx.status ? sql`i.status = ${ctx.status}` : sql`true`}
        and ${this.searchAny(ctx, [sql`t.tender_no`, sql`t.tender_number`, sql`o.name`, sql`t.department`, sql`i.reference_number`, sql`i.bank`, sql`pr.name`, sql`ow.full_name`])}`,
      order: sql`(i.status = any(${LIVE_INSTRUMENT}::text[])) desc, (i.status = any(${UNPAID_INSTRUMENT}::text[])) desc,
        i.expiry_date asc nulls last, i.created_at desc`,
    });
    return {
      ...res,
      rows: res.rows.map((r) =>
        this.toRow(ctx, { ...r, receiving: instrumentReceiving(r.status) || null, status: instrumentStatusLabel(r.instrument_type, r.status) }, `/tenders?highlight=${r.tender_id}`),
      ),
    };
  }

  /** DEMONSTRATION REPORT — demos in the period with the latest outcome report. */
  private async demonstrations(ctx: Ctx) {
    const res = await this.page(ctx, {
      select: sql`d.id, z.name as zone, ${DEMO_DAY}::text as date, ${customerOf(sql`o.name`, sql`o.department`)} as customer,
        ${stateOf(sql`o.state`)} as state, d.location, coalesce(t.tender_no, t.tender_number) as tender,
        concat_ws(' — ', pr.name, nullif(trim(d.equipment_required), '')) as equipment,
        concat_ws(', ', en.full_name, case when co.id is distinct from en.id then co.full_name end) as conducted_by,
        d.purpose as aspects, oc.customer_response as feedback, d.expected_audience as audience, oc.remarks,
        case when oc.result = 'failure' or nullif(trim(oc.failure_reason), '') is not null then coalesce(nullif(trim(oc.failure_reason), ''), 'Unsuccessful') end as negative,
        case when oc.id is not null then 'Yes' when d.status = 'completed' then 'No' end as report,
        oc.next_step as suggestions, d.status::text as status, d.remarks as remark`,
      from: sql`from demos d
        left join organisations o on o.id = d.organisation_id
        left join users ow on ow.id = d.requested_by
        left join zones z on z.id = coalesce(o.zone_id, ow.zone_id)
        left join products pr on pr.id = d.product_id
        left join tenders t on t.id = d.tender_id
        left join users en on en.id = d.assigned_to
        left join users co on co.id = d.coordinator_id
        left join lateral (select x.id, x.customer_response, x.remarks, x.result, x.failure_reason, x.next_step from demo_outcomes x where x.demo_id = d.id order by x.created_at desc limit 1) oc on true`,
      where: sql`${territoryOwned(ctx.scope.territory, sql`d.requested_by`)} and ${ctx.inP(DEMO_DAY)}
        and ${this.searchAny(ctx, [sql`d.demo_no`, sql`o.name`, sql`d.location`, sql`pr.name`, sql`t.tender_no`, sql`en.full_name`])}`,
      order: sql`${DEMO_DAY} desc, d.created_at desc`,
    });
    return { ...res, rows: res.rows.map((r) => this.toRow(ctx, { ...r, status: pretty(r.status) }, `/demos?open=${r.id}`)) };
  }

  /** ORDER DETAILS — won bids and proposals converted to a PO in the period. */
  private async orders(ctx: Ctx) {
    const t = ctx.scope.territory;
    const union = sql`
      select 't-' || t.id as id, t.id as tender_id, null::uuid as proposal_id, z.name as zone, ow.full_name as person,
        ${customerOf(sql`o.name`, sql`coalesce(t.department, o.department)`)} as customer, ${stateOf(sql`o.state`, sql`t.state`)} as state,
        coalesce(t.tender_no, t.tender_number) as bid_no, coalesce(r.po_number, r.order_number, r.loa_number) as po_no,
        coalesce(r.loa_date, r.result_date, t.result_date)::text as po_date, coalesce(pr.name, t.requirement_text) as item, pr.make, dm.model,
        coalesce(aw.qty, t.quantity) as quantity, coalesce(nullif(r.awarded_value, 0), ${TENDER_VALUE}) as value, 'Tender won' as source
      from tenders t
        left join organisations o on o.id = t.organisation_id left join products pr on pr.id = t.product_id
        left join users ow on ow.id = ${TENDER_OWNER} left join zones z on z.id = coalesce(t.zone_id, o.zone_id)
        left join lateral (select x.po_number, x.order_number, x.loa_number, x.loa_date, x.result_date, x.awarded_value from tender_results x where x.tender_id = t.id order by x.created_at desc limit 1) r on true
        left join lateral (select nullif(sum(coalesce(li.awarded_quantity, li.quantity)), 0) as qty from tender_line_items li where li.tender_id = t.id and li.awarded) aw on true
        left join lateral (select dl.model from deliveries dl where dl.tender_id = t.id and nullif(trim(dl.model), '') is not null order by dl.created_at limit 1) dm on true
      where ${TENDER_ROW} and t.status = 'won' and ${territoryTenders(t)} and ${ctx.inP(TENDER_RESULT_DAY)}
      union all
      select 'p-' || p.id, null::uuid, p.id, z.name, ow.full_name, ${customerOf(sql`o.name`, sql`o.department`)}, ${stateOf(sql`o.state`)},
        null, coalesce(nullif(trim(p.converted_reference), ''), p.conversion_reference), ${PROPOSAL_OUTCOME_DAY}::text,
        pr.name, pr.make, dm.model, p.quantity, greatest(coalesce(p.quoted_value, 0), 0), 'Proposal converted'
      from proposals p
        left join organisations o on o.id = ${PROPOSAL_ORG} left join products pr on pr.id = p.product_id
        left join users ow on ow.id = ${PROPOSAL_OWNER} left join zones z on z.id = coalesce(o.zone_id, ow.zone_id)
        left join lateral (select dl.model from deliveries dl where dl.proposal_id = p.id and nullif(trim(dl.model), '') is not null order by dl.created_at limit 1) dm on true
      where coalesce(p.is_deleted, false) = false and upper(coalesce(p.status, '')) = 'CONVERTED'
        and ${ctx.inP(PROPOSAL_OUTCOME_DAY)} and ${territoryOwned(t, PROPOSAL_OWNER)}`;
    const res = await this.page(ctx, {
      select: sql`s.*, case when coalesce(s.quantity, 0) > 0 then round(s.value / s.quantity) end as unit_rate`,
      from: sql`from (${union}) s`,
      where: this.searchAny(ctx, [sql`s.customer`, sql`s.bid_no`, sql`s.po_no`, sql`s.item`, sql`s.person`]),
      order: sql`s.po_date desc nulls last, s.id`,
    });
    return {
      ...res,
      rows: res.rows.map((r) => this.toRow(ctx, r, r.tender_id ? `/tenders?highlight=${r.tender_id}` : `/proposals?open=${r.proposal_id}`)),
    };
  }

  /** DELIVERY REPORT — dispatches in the period with the order they fulfil and how much of it is delivered. */
  private async deliveries(ctx: Ctx) {
    const owner = sql`coalesce(${TENDER_OWNER}, ${PROPOSAL_OWNER}, d.assigned_to)`;
    const res = await this.page(ctx, {
      select: sql`d.id, z.name as zone, ow.full_name as person, d.delivery_date::text as date,
        ${customerOf(sql`o.name`, sql`o.department`)} as customer, ${stateOf(sql`o.state`)} as state,
        coalesce(t.tender_no, t.tender_number) as bid_no,
        coalesce(nullif(trim(d.order_reference), ''), r.po_number, r.order_number, p.converted_reference) as po_no,
        concat_ws(' — ', pr.name, nullif(trim(d.model), '')) as item, coalesce(t.quantity, p.quantity) as qty_ordered,
        dq.n as qty_delivered, d.delivery_location as location,
        case when nullif(trim(d.document_url), '') is not null then 'Yes' when d.status::text = any(${DELIVERED}::text[]) then 'No' end as report,
        d.status::text as status, concat_ws(' · ', nullif(trim(d.remarks), ''), case when d.equipment_serial is not null then 'S/N ' || d.equipment_serial end) as remark`,
      from: sql`from deliveries d
        left join organisations o on o.id = d.organisation_id
        left join tenders t on t.id = d.tender_id
        left join proposals p on p.id = d.proposal_id
        left join products pr on pr.id = d.product_id
        left join users ow on ow.id = ${owner}
        left join zones z on z.id = coalesce(o.zone_id, ow.zone_id)
        left join lateral (select x.po_number, x.order_number from tender_results x where x.tender_id = t.id order by x.created_at desc limit 1) r on true
        left join lateral (select count(*)::int as n from deliveries x where x.status::text = any(${DELIVERED}::text[])
          and case when d.tender_id is not null then x.tender_id = d.tender_id when d.proposal_id is not null then x.proposal_id = d.proposal_id else x.id = d.id end) dq on true`,
      where: sql`${territoryOwned(ctx.scope.territory, owner)} and ${ctx.inP(sql`d.delivery_date::date`)}
        and ${this.searchAny(ctx, [sql`d.delivery_no`, sql`o.name`, sql`d.order_reference`, sql`t.tender_no`, sql`pr.name`, sql`d.equipment_serial`, sql`d.delivery_location`])}`,
      order: sql`d.delivery_date desc, d.created_at desc`,
    });
    return { ...res, rows: res.rows.map((r) => this.toRow(ctx, { ...r, status: pretty(r.status) }, `/deliveries?open=${r.id}`)) };
  }

  /** SERVICE REPORT — complaints received in the period, in the Service Desk's own scope, with the latest report. */
  private async serviceSheet(ctx: Ctx) {
    const f = ctx.scope.filters;
    let base = this.db
      .selectFrom('service_tickets')
      .innerJoin('organisations', 'organisations.id', 'service_tickets.organisation_id')
      .leftJoin('regions as tr', 'tr.id', 'service_tickets.region_id')
      .where('service_tickets.deleted_at', 'is', null);
    const scope = this.service.scopeWhere(ctx.user);
    if (scope) base = base.where(scope as any);
    if (isNational(ctx.user) && f.zone_id) base = base.where(sql<boolean>`(organisations.zone_id = ${f.zone_id} or tr.zone_id = ${f.zone_id})`);
    if (f.region_id) base = base.where(sql<boolean>`(organisations.region_id = ${f.region_id} or service_tickets.region_id = ${f.region_id})`);
    const received = sql`coalesce(service_tickets.received_date, ${istDay(sql`service_tickets.created_at`)})`;
    base = base.where(sql<boolean>`${ctx.inP(received)}`);
    const ids = base.select('service_tickets.id');

    const res = await this.page(ctx, {
      select: sql`st.id, z.name as zone, coalesce(st.received_date, ${istDay(sql`st.created_at`)})::text as date,
        ${customerOf(sql`o.name`, sql`o.department`)} as customer, ${stateOf(sql`o.state`)} as state,
        coalesce(dt.tender_no, dt.tender_number) as bid_no, dl.order_reference as po_no, pr.name as item,
        coalesce(st.equipment_serial, st.serial_number) as serial, coalesce(st.ticket_number, st.ticket_no) as ticket_no,
        concat_ws(' — ', nullif(trim(st.problem_category), ''), coalesce(st.complaint, st.complaint_description)) as complaint,
        rp.action_taken as action, en.full_name as engineer,
        case when rp.id is not null then 'Yes' when st.status in ('resolved', 'report_submitted', 'closed') then 'No' end as report,
        st.status::text as status`,
      from: sql`from service_tickets st
        join organisations o on o.id = st.organisation_id
        left join regions tr on tr.id = st.region_id
        left join zones z on z.id = coalesce(o.zone_id, tr.zone_id)
        left join products pr on pr.id = st.product_id
        left join users en on en.id = st.assigned_to
        left join lateral (select x.id, x.action_taken from service_reports x where x.ticket_id = st.id order by x.created_at desc limit 1) rp on true
        left join lateral (select y.tender_id, y.proposal_id, y.order_reference from deliveries y
          where nullif(trim(y.equipment_serial), '') is not null and y.equipment_serial = coalesce(st.equipment_serial, st.serial_number) order by y.delivery_date desc limit 1) dl on true
        left join tenders dt on dt.id = dl.tender_id`,
      where: sql`st.id in (${ids}) and ${this.searchAny(ctx, [sql`st.ticket_no`, sql`st.ticket_number`, sql`o.name`, sql`st.equipment_serial`, sql`pr.name`, sql`st.complaint`, sql`en.full_name`])}`,
      order: sql`coalesce(st.received_date, ${istDay(sql`st.created_at`)}) desc, st.created_at desc`,
    });
    return {
      ...res,
      rows: res.rows.map((r) =>
        this.toRow(ctx, { ...r, status: (SERVICE_STATUS_LABELS as Record<string, string>)[r.status] ?? pretty(r.status) }, `/service?open=${r.id}`),
      ),
    };
  }

  /** SALES PIPELINE — leads identified in the period with value, probability and the next step. */
  private async pipeline(ctx: Ctx) {
    const res = await this.page(ctx, {
      select: sql`l.id, ${istDay(sql`l.created_at`)}::text as date, z.name as zone, ow.full_name as person,
        ${customerOf(sql`o.name`, sql`coalesce(l.department, o.department)`)} as customer, ${stateOf(sql`o.state`)} as state,
        l.remarks as description, pr.name as equipment, l.qty as quantity,
        round(greatest(coalesce(l.value_lakh, 0), 0) * 100000) as value, lt.deadline::text as tender_date,
        lower(l.probability::text) as probability_band, coalesce(l.lead_status, l.status) as stage,
        coalesce(nullif(trim(l.booking_month), ''), nullif(trim(l.bill_qtr), '')) as order_date,
        fu.remarks as next_action, coalesce(fu.due_date, l.next_followup_date)::text as followup_date`,
      from: sql`from leads l
        left join organisations o on o.id = l.organisation_id
        left join users ow on ow.id = l.assigned_to
        left join zones z on z.id = coalesce(o.zone_id, ow.zone_id)
        left join products pr on pr.id = l.product_id
        left join lateral (select f.due_date, f.remarks from follow_ups f where f.lead_id = l.id and f.status = 'pending' order by f.due_date asc limit 1) fu on true
        left join lateral (select ${istDay(sql`coalesce(t.submission_deadline, t.bid_closing_date)`)} as deadline from tenders t
          where ${TENDER_ROW} and t.organisation_id = l.organisation_id and (l.product_id is null or t.product_id = l.product_id)
            and t.status::text not in ('won', 'lost', 'cancelled', 'rejected_internally')
          order by coalesce(t.submission_deadline, t.bid_closing_date) asc nulls last limit 1) lt on true`,
      where: sql`${territoryLeads(ctx.scope.territory)} and ${ctx.inP(istDay(sql`l.created_at`))}
        and ${this.searchAny(ctx, [sql`o.name`, sql`l.department`, sql`pr.name`, sql`l.remarks`, sql`ow.full_name`])}`,
      order: sql`l.created_at desc`,
      computed: ['weighted'],
    });
    let weighted = 0;
    const rows = res.rows.map((r) => {
      const pct = LEAD_PROBABILITY_PCT[r.probability_band] ?? null;
      const w = pct !== null && r.value !== null ? Math.round((Number(r.value) * pct) / 100) : null;
      return this.toRow(ctx, { ...r, probability: pct, weighted: w, stage: pretty(r.stage) }, `/leads?open=${r.id}`);
    });
    // Weighted value is computed per row (probability band → %), so its total is summed over every row in scope.
    if (res.totals) {
      const all = await sql<Row>`select lower(l.probability::text) as band, coalesce(sum(greatest(coalesce(l.value_lakh, 0), 0) * 100000), 0)::float as v
        from leads l left join organisations o on o.id = l.organisation_id left join users ow on ow.id = l.assigned_to left join products pr on pr.id = l.product_id
        where ${territoryLeads(ctx.scope.territory)} and ${ctx.inP(istDay(sql`l.created_at`))}
          and ${this.searchAny(ctx, [sql`o.name`, sql`l.department`, sql`pr.name`, sql`l.remarks`, sql`ow.full_name`])}
        group by 1`.execute(this.db);
      for (const b of all.rows) weighted += (num(b.v) * (LEAD_PROBABILITY_PCT[b.band] ?? 0)) / 100;
      res.totals.weighted = Math.round(weighted);
    }
    return { ...res, rows };
  }

  /** QUOTATION / PRICE BID — proposals requested in the period. */
  private async quotations(ctx: Ctx) {
    const day = sql`coalesce(p.request_date, ${istDay(sql`p.created_at`)})`;
    const res = await this.page(ctx, {
      select: sql`p.id, z.name as zone, ow.full_name as person, ${customerOf(sql`o.name`, sql`o.department`)} as customer,
        ${stateOf(sql`o.state`)} as state, coalesce(p.proposal_number, p.proposal_no) as quotation_no,
        coalesce(p.sent_date, p.request_date)::text as date, p.validity_date::text as validity, pr.name as equipment, p.quantity,
        p.quoted_value as value, p.status, coalesce(p.next_follow_up_date, p.next_followup)::text as followup_date,
        coalesce(nullif(trim(p.lost_remarks), ''), nullif(trim(p.remarks), '')) as remark`,
      from: sql`from proposals p
        left join organisations o on o.id = ${PROPOSAL_ORG}
        left join users ow on ow.id = ${PROPOSAL_OWNER}
        left join zones z on z.id = coalesce(o.zone_id, ow.zone_id)
        left join products pr on pr.id = p.product_id`,
      where: sql`coalesce(p.is_deleted, false) = false and ${territoryOwned(ctx.scope.territory, PROPOSAL_OWNER)} and ${ctx.inP(day)}
        and ${this.searchAny(ctx, [sql`p.proposal_number`, sql`p.proposal_no`, sql`o.name`, sql`pr.name`, sql`ow.full_name`])}`,
      order: sql`${day} desc, p.created_at desc`,
    });
    return { ...res, rows: res.rows.map((r) => this.toRow(ctx, { ...r, status: pretty(r.status) }, `/proposals?open=${r.id}`)) };
  }

  /** EXPENSE AND TRAVEL — expense lines dated in the period, in the caller's claim scope. */
  private async expenseSheet(ctx: Ctx) {
    const f = ctx.scope.filters;
    let regionIds: string[] | undefined;
    if (f.region_id) regionIds = [f.region_id];
    else if (isNational(ctx.user) && f.zone_id) {
      regionIds = f.regions.map((r) => r.id);
      if (!regionIds.length) regionIds = ['00000000-0000-0000-0000-000000000000'];
    }
    const filters = this.expenses.parse({ date_from: ctx.from, date_to: ctx.to, date_field: 'expense_date', region_ids: regionIds });
    const ids = this.expenses.baseItems(filters, ctx.user).select('i.id');

    const res = await this.page(ctx, {
      select: sql`i.id, c.id as claim_id, i.expense_date::text as date, emp.full_name as employee, z.name as zone, dep.name as department,
        coalesce(i.category_name, ec.name) as type, coalesce(o.name, pj.name) as customer,
        i.category_details->>'from' as "from", i.category_details->>'to' as "to", i.amount,
        case when c.status = 'processed' then coalesce(i.approved_amount, 0) end as reimbursed, c.status::text as status,
        coalesce(mgr.full_name) as approved_by, coalesce(nullif(trim(i.purpose), ''), nullif(trim(i.remarks), '')) as remark`,
      from: sql`from expense_items i
        join expense_claims c on c.id = i.claim_id
        left join users emp on emp.id = c.employee_id
        left join regions rg on rg.id = coalesce(c.region_id, emp.region_id)
        left join zones z on z.id = coalesce(rg.zone_id, emp.zone_id)
        left join departments dep on dep.id = emp.department_id
        left join expense_categories ec on ec.id = i.category_id
        left join organisations o on o.id = i.customer_id
        left join projects pj on pj.id = i.project_id
        left join users mgr on mgr.id = c.manager_id`,
      where: sql`i.id in (${ids}) and ${this.searchAny(ctx, [sql`emp.full_name`, sql`c.claim_number`, sql`o.name`, sql`i.category_name`, sql`i.purpose`])}`,
      order: sql`i.expense_date desc, i.created_at desc`,
    });
    return {
      ...res,
      rows: res.rows.map((r) => this.toRow(ctx, { ...r, status: pretty(r.status) }, `/expenses?open=${r.claim_id}`)),
    };
  }

  /** Zone / person / state / product MIS — the Business MIS report laid out as the workbook's table. */
  private async misSheet(ctx: Ctx, groupBy: MisGroupBy, q: Record<string, unknown>) {
    const res = await this.mis.report(ctx.user, { ...q, group_by: groupBy });
    const cell = (r: MisRow) => this.toRow(ctx, r as unknown as Row, null);
    const rows = res.rows
      .filter((r) => !ctx.search || `${r.label} ${r.sub ?? ''}`.toLowerCase().includes(ctx.search.toLowerCase()))
      .map((r) => ({ ...cell({ ...r, id: r.key } as any), id: r.key }));
    return { rows, total: rows.length, totals: cell({ ...res.totals, id: 'total', label: 'Total', sub: null } as any).cells };
  }
}
