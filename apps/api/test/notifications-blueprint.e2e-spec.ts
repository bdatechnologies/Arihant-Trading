/**
 * Blueprint "Notifications & Escalations" — the 14 automated notifications, each triggered for real (API call or the
 * scheduled job that owns it) and checked in the `notifications` table: who gets it, and who must not (the person who
 * acted, a closed record, a deactivated user). Scheduled reminders are checked to fire once, not on every run.
 *
 * Channels: every notification is an in-app row pushed over the websocket; email / WhatsApp are to be decided in the
 * technical design and are not part of this suite.
 *
 * Uses seeded users (Vikram Sharma is Amit Verma's reporting manager) plus two temporary users, and a North-zone
 * customer. Everything it creates is removed afterwards.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { Kysely, sql } from 'kysely';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/common/app-setup';
import { KYSELY_DB } from '../src/common/database/database.module';
import { OutboxService } from '../src/common/outbox/outbox.service';
import { DeadlineRemindersJob } from '../src/jobs/deadline-reminders.job';
import { TaskJobsService } from '../src/modules/tasks/task-jobs.service';
import { ProposalsSchedulerService } from '../src/modules/proposals/proposals-scheduler.service';
import { addIsoDays, todayInKolkata } from '@arihant/shared';

jest.setTimeout(180000);

const today = todayInKolkata();
const day = (n: number) => addIsoDays(today, n);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TAG = `ZZNOTIF${Date.now()}`;
const PNG = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(randomUUID())]);

describe('Blueprint notifications — every automated notification reaches the right people', () => {
  let app: INestApplication;
  let db: Kysely<any>;
  let outbox: OutboxService;
  type Who = { token: string; id: string };
  const u: Record<string, Who> = {};
  const created: Record<string, string[]> = {};
  const track = (table: string, id: string) => ((created[table] ||= []).push(id), id);
  let org = '';
  let category = '';

  const http = () => request(app.getHttpServer());
  const bearer = (w: Who) => ({ Authorization: `Bearer ${w.token}` });
  const q = async (text: string) => (await sql.raw(text).execute(db)).rows as any[];
  async function login(email: string): Promise<Who> {
    const r = await http().post('/api/auth/login').send({ email, password: 'password123' });
    if (r.status !== 200) throw new Error(`login ${email} → ${r.status}`);
    return { token: r.body.accessToken || r.body.token, id: r.body.user.id };
  }

  /** Notifications one user has for one record (optionally of one type). */
  const notes = (userId: string, entityId: string, type?: string) =>
    q(`select type, title, body from notifications where user_id = '${userId}' and entity_id = '${entityId}'${type ? ` and type = '${type}'` : ''}`);
  /** Waits for listeners (direct events) and drains the outbox (queued events) until the notification shows up. */
  async function arrives(who: Who, entityId: string, type: string) {
    for (let i = 0; i < 60; i++) {
      await outbox.processPendingEvents().catch(() => 0);
      const rows = await notes(who.id, entityId, type);
      if (rows.length) return rows;
      await sleep(150);
    }
    throw new Error(`no "${type}" notification for ${who.id} on ${entityId}`);
  }
  /** Lets every pending listener and queued event finish, so an absence can be asserted. */
  async function settle() {
    for (let i = 0; i < 4; i++) {
      await outbox.processPendingEvents().catch(() => 0);
      await sleep(200);
    }
  }
  /** Moves a timestamp the API would refuse (a past deadline), bypassing the guard triggers. */
  const rewrite = (table: string, id: string, set: string) =>
    db.connection().execute(async (c) => {
      await sql`set session_replication_role = replica`.execute(c);
      await sql.raw(`update ${table} set ${set} where id = '${id}'`).execute(c);
      await sql`set session_replication_role = default`.execute(c);
    });

  async function task(assignee: Who, deadline = day(5)) {
    const r = await http().post('/api/tasks').set(bearer(u.rmN)).send({ title: `${TAG} task`, category_id: category, deadline, assignee_ids: [assignee.id] });
    expect(r.status).toBe(201);
    return track('tasks', r.body.data[0].id);
  }
  async function visit(by: Who, plannedDate: string, assignedTo?: Who) {
    const r = await http().post('/api/visits').set(bearer(by)).send({ organisation_id: org, planned_date: plannedDate, purpose: `${TAG} visit`, ...(assignedTo ? { assigned_to: assignedTo.id } : {}) });
    expect(r.status).toBe(201);
    return track('visits', r.body.id);
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    db = app.get(KYSELY_DB);
    outbox = app.get(OutboxService);
    for (const [k, email] of Object.entries({
      mgmt: 'mgmt@arihant.com',
      rmN: 'regmgr.north@arihant.com',
      sales: 'sales.delhi@arihant.com',
      demo: 'demo@arihant.com',
      accounts: 'accounts@arihant.com',
    })) u[k] = await login(email);
    // Amit Verma reports to Vikram Sharma — the line every "manager hears" assertion relies on.
    await q(`update users set reporting_manager_id = '${u.rmN.id}' where id = '${u.sales.id}'`);
    org = (await q(`select o.id from organisations o join zones z on z.id = o.zone_id where z.code = 'N' and o.id <> '00000000-0000-4000-8000-0000000000a1' order by o.name limit 1`))[0].id;
    category = (await http().get('/api/task-categories').set(bearer(u.rmN))).body.find((c: any) => c.code === 'GENERAL').id;

    // A rep whose manager has left: nobody may be notified on the departed manager's behalf.
    const hash = await bcrypt.hash('password123', 10);
    const gone = track('users', randomUUID());
    const rep = track('users', randomUUID());
    await q(`insert into users (id, full_name, email, role, password_hash, is_active) values ('${gone}', 'Zz Gone Manager', '${TAG.toLowerCase()}.gone@test.local', 'regional_manager', '${hash}', false)`);
    await q(`insert into users (id, full_name, email, role, password_hash, reporting_manager_id) values ('${rep}', 'Zz Orphan Rep', '${TAG.toLowerCase()}.rep@test.local', 'sales', '${hash}', '${gone}')`);
    u.gone = { token: '', id: gone };
    u.rep = await login(`${TAG.toLowerCase()}.rep@test.local`);
  });

  afterAll(async () => {
    if (db) {
      const all = Object.values(created).flat();
      await db.connection().execute(async (c) => {
        await sql`set session_replication_role = replica`.execute(c);
        const list = (ids: string[] = []) => (ids.length ? ids.map((i) => `'${i}'`).join(',') : `'00000000-0000-0000-0000-000000000000'`);
        const run = (text: string) => sql.raw(text).execute(c);
        await run(`delete from notifications where entity_id in (${list(all)}) or user_id in (${list(created.users)})`);
        await run(`delete from outbox_events where aggregate_id in (${list(all)})`);
        await run(`delete from scheduler_dedupe where proposal_id in (${list(created.proposals)})`);
        for (const t of ['task_updates', 'task_notification_log', 'task_assignment_history', 'task_deadline_changes', 'task_blockers', 'task_escalations']) {
          await run(`delete from ${t} where task_id in (${list(created.tasks)})`);
        }
        await run(`delete from tasks where id in (${list(created.tasks)})`);
        await run(`delete from demo_reservations where demo_id in (${list(created.demos)})`);
        await run(`delete from demos where id in (${list(created.demos)})`);
        await run(`delete from visits where id in (${list(created.visits)}) or assigned_to in (${list(created.users)})`);
        await run(`delete from follow_ups where id in (${list(created.follow_ups)})`);
        await run(`delete from leads where id in (${list(created.leads)})`);
        await run(`delete from proposals where id in (${list(created.proposals)})`);
        await run(`delete from tenders where id in (${list(created.tenders)})`);
        await run(`delete from service_tickets where id in (${list(created.service_tickets)})`);
        await run(`delete from expense_attachments where item_id in (select id from expense_items where claim_id in (${list(created.expense_claims)}))`);
        await run(`delete from expense_items where claim_id in (${list(created.expense_claims)})`);
        await run(`delete from expense_claims where id in (${list(created.expense_claims)})`);
        await run(`delete from audit_log where entity_id in (${list(all)})`);
        await run(`delete from users where id in (${list(created.users)})`);
        await sql`set session_replication_role = default`.execute(c);
      });
    }
    await app?.close();
  });

  // ------------------------------------------------------------------ tasks
  describe('tasks', () => {
    it('1. new task: the assignee hears, the manager who assigned it does not', async () => {
      const id = await task(u.sales);
      const [n] = await arrives(u.sales, id, 'task_assigned');
      expect(n.title).toMatch(/^New task:/);
      await settle();
      expect(await notes(u.rmN.id, id, 'task_assigned')).toHaveLength(0);
    });

    it('2. task deadline approaching: one reminder to the assignee, not one per run', async () => {
      const id = await task(u.sales);
      await rewrite('tasks', id, `deadline = now() + interval '3 hours'`);
      const jobs = app.get(TaskJobsService);
      await jobs.reminders();
      const [n] = await arrives(u.sales, id, 'task_due');
      expect(n.title).toMatch(/^Due in \dh:/);
      await jobs.reminders();
      await settle();
      expect(await notes(u.sales.id, id, 'task_due')).toHaveLength(1);
    });

    it('3. task overdue: the assignee and their manager, once', async () => {
      const id = await task(u.sales);
      await rewrite('tasks', id, `deadline = now() - interval '1 hour', original_deadline = now() - interval '1 hour'`);
      const jobs = app.get(TaskJobsService);
      await jobs.overdue();
      expect((await arrives(u.sales, id, 'task_overdue'))[0].title).toMatch(/^Overdue:/);
      expect((await arrives(u.rmN, id, 'task_overdue'))[0].title).toMatch(/^Team task overdue:/);
      await jobs.overdue();
      await settle();
      expect(await notes(u.sales.id, id, 'task_overdue')).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------ follow-ups
  describe('lead follow-ups', () => {
    const lead = async (status: string) => track('leads', (await q(`insert into leads (organisation_id, assigned_to, lead_type, lead_status) values ('${org}', '${u.sales.id}', 'fresh', '${status}') returning id`))[0].id);
    const followUp = async (leadId: string, due: string) =>
      track('follow_ups', (await q(`insert into follow_ups (lead_id, organisation_id, assigned_to, status, due_date) values ('${leadId}', '${org}', '${u.sales.id}', 'pending', '${due}') returning id`))[0].id);

    it('4. follow-up due: due today on an open lead reminds the owner once; a converted lead’s leftover does not', async () => {
      const open = await followUp(await lead('contacted'), today);
      const closed = await followUp(await lead('converted'), today);
      const job = app.get(DeadlineRemindersJob);
      await job.checkLeadFollowupsDue();
      const [n] = await arrives(u.sales, open, 'followup_due');
      expect(n.title).toMatch(/^Follow-up due today:/);
      await job.checkLeadFollowupsDue();
      await settle();
      expect(await notes(u.sales.id, open, 'followup_due')).toHaveLength(1);
      expect(await notes(u.sales.id, closed)).toHaveLength(0);
    });

    it('follow-up overdue: only on open leads', async () => {
      const open = await followUp(await lead('demo'), day(-2));
      const closed = await followUp(await lead('won'), day(-2));
      await app.get(DeadlineRemindersJob).checkLeadFollowupsOverdue();
      await arrives(u.sales, open, 'followup_overdue');
      await settle();
      expect(await notes(u.sales.id, closed)).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------ visits
  describe('field visits', () => {
    it('5. visit planned: the employee’s manager hears; the employee who planned it does not', async () => {
      const id = await visit(u.sales, day(21));
      const [n] = await arrives(u.rmN, id, 'visit_planned');
      expect(n.title).toMatch(/^Visit planned: Amit Verma →/);
      await settle();
      expect(await notes(u.sales.id, id)).toHaveLength(0);
    });

    it('7. additional visit assigned by the manager: the employee hears, the manager who did it does not', async () => {
      const id = await visit(u.rmN, day(22), u.sales);
      const [n] = await arrives(u.sales, id, 'visit_planned');
      expect(n.title).toMatch(/^New visit assigned to you:/);
      expect(n.body).toMatch(/^Vikram Sharma added a visit/);
      await settle();
      expect(await notes(u.rmN.id, id)).toHaveLength(0);
    });

    it('7. planned by management for the employee: the employee and their manager both hear', async () => {
      const id = await visit(u.mgmt, day(23), u.sales);
      await arrives(u.sales, id, 'visit_planned');
      const [m] = await arrives(u.rmN, id, 'visit_planned');
      expect(m.body).toMatch(/planned a visit for Amit Verma/);
      await settle();
      expect(await notes(u.mgmt.id, id)).toHaveLength(0);
    });

    it('7. manager "also meet" instruction on a planned visit reaches the employee', async () => {
      const id = await visit(u.sales, day(24));
      expect((await http().post(`/api/visits/${id}/intervention`).set(bearer(u.rmN)).send({ instructions: 'Also meet the Commandant about the DFMD AMC.' })).status).toBe(201);
      await arrives(u.sales, id, 'visit_intervention');
    });

    it('6. rescheduled by the employee: the manager hears it was the employee', async () => {
      const id = await visit(u.sales, day(25));
      expect((await http().post(`/api/visits/${id}/reschedule`).set(bearer(u.sales)).send({ new_date: day(26), reason: 'Customer asked for a later date.' })).status).toBe(201);
      const [n] = await arrives(u.rmN, id, 'visit_rescheduled');
      expect(n.title).toBe('Field Visit Rescheduled by Employee');
      await settle();
      expect(await notes(u.sales.id, id, 'visit_rescheduled')).toHaveLength(0);
    });

    it('6. cancelled by the manager: the employee whose plan changed hears; the manager is not told “by employee”', async () => {
      const id = await visit(u.sales, day(27));
      expect((await http().post(`/api/visits/${id}/cancel`).set(bearer(u.rmN)).send({ reason: 'Covered by the zonal review meeting instead.' })).status).toBe(201);
      const [n] = await arrives(u.sales, id, 'visit_cancelled');
      expect(n.title).toMatch(/^Your visit was cancelled:/);
      expect(n.body).toMatch(/^Vikram Sharma cancelled your visit/);
      await settle();
      expect(await notes(u.rmN.id, id, 'visit_cancelled')).toHaveLength(0);
    });

    it('a deactivated manager is never notified (and planning still works)', async () => {
      const id = await visit(u.rep, day(28));
      await settle();
      expect(await notes(u.gone.id, id)).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------ demos
  describe('demos', () => {
    const demo = async (requested: string) => {
      const r = await http().post('/api/demos').set(bearer(u.sales)).send({ organisation_id: org, requested_date: requested, location: 'Delhi', purpose: `${TAG} demo ${requested}` });
      expect(r.status).toBe(201);
      return track('demos', r.body.id);
    };

    it('8. demo requested: the demo team and management hear; the requester does not', async () => {
      const id = await demo(day(30));
      await arrives(u.demo, id, 'demo_requested');
      await arrives(u.mgmt, id, 'demo_requested');
      await settle();
      expect(await notes(u.sales.id, id, 'demo_requested')).toHaveLength(0);
    });

    it('9. equipment conflict: booking a unit already reserved for overlapping days alerts management', async () => {
      const units = (await http().get('/api/demos/equipment').set(bearer(u.demo))).body as any[];
      const busy = new Set((await q(`select equipment_id from demo_reservations where reserved_to >= '${day(60)}' and reserved_from <= '${day(64)}'`)).map((r) => r.equipment_id));
      const unit = units.find((x) => !busy.has(x.id));
      expect(unit).toBeTruthy();
      const a = await demo(day(60));
      const b = await demo(day(61));
      const reserve = (id: string, from: string, to: string) => http().post(`/api/demos/${id}/reserve`).set(bearer(u.demo)).send({ equipment_id: unit.id, reserved_from: from, reserved_to: to });
      expect((await reserve(a, day(60), day(62))).status).toBe(201);
      expect((await reserve(b, day(61), day(63))).status).toBe(409);
      for (let i = 0; i < 40; i++) {
        const rows = await q(`select user_id from notifications where type = 'demo_equipment_conflict' and entity_id in ('${a}', '${b}')`);
        if (rows.some((r) => r.user_id === u.mgmt.id)) break;
        if (i === 39) throw new Error('no equipment conflict notification for management');
        await sleep(150);
      }
      await settle();
      expect(await q(`select 1 from notifications where type = 'demo_equipment_conflict' and entity_id in ('${a}', '${b}') and user_id = '${u.demo.id}'`)).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------ tenders
  describe('tenders', () => {
    let tender = '';
    beforeAll(async () => {
      const r = await http()
        .post('/api/tenders')
        .set(bearer(u.mgmt))
        .send({ tender_no: `${TAG}/BID`, organisation_id: org, category: 'pq', publication_date: day(-10), submission_deadline: `${day(1)}T17:00:00+05:30`, assigned_person_id: u.sales.id, estimated_value: 1500000 });
      expect(r.status).toBe(201);
      tender = track('tenders', r.body.id);
    });

    it('10. tender awaiting approval: every management user hears', async () => {
      expect((await http().post(`/api/tenders/${tender}/approval-request`).set(bearer(u.sales)).send({ remarks: 'Requesting go / no-go for this bid.' })).status).toBe(201);
      await arrives(u.mgmt, tender, 'tender_approval');
    });

    it('11. tender deadline approaching: the bid owner, once', async () => {
      const job = app.get(DeadlineRemindersJob);
      await job.checkTenderDeadlines();
      await arrives(u.sales, tender, 'tender_deadline');
      await job.checkTenderDeadlines();
      await settle();
      expect(await notes(u.sales.id, tender, 'tender_deadline')).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------ proposals
  it('12. proposal follow-up due: the follow-up owner, on the day', async () => {
    const id = track(
      'proposals',
      (await q(`insert into proposals (organisation_id, responsible_person_id, follow_up_owner_id, status, request_date, sent_date, next_follow_up_date)
                values ('${org}', '${u.sales.id}', '${u.sales.id}', 'SENT_TO_CUSTOMER', '${day(-10)}', '${day(-5)}', '${today}') returning id`))[0].id,
    );
    await app.get(ProposalsSchedulerService).runHourlyAlertEngine();
    let rows: any[] = [];
    for (let i = 0; i < 40 && !rows.length; i++) {
      await outbox.processPendingEvents().catch(() => 0);
      rows = await q(`select title from notifications where user_id = '${u.sales.id}' and entity_id = '${id}' and title like 'Follow-up Due Today%'`);
      if (!rows.length) await sleep(150);
    }
    expect(rows).toHaveLength(1);
  });

  // ------------------------------------------------------------------ service
  it('13. service ticket overdue: management hears when the SLA passes, once', async () => {
    const r = await http().post('/api/service/tickets').set(bearer(u.mgmt)).send({ organisation_id: org, complaint: `${TAG} conveyor drive unit stopped`, equipment_serial: `${TAG}-SN`, priority: 'medium' });
    expect(r.status).toBe(201);
    const id = track('service_tickets', r.body.id);
    await q(`update service_tickets set sla_response_due_at = now() - interval '5 minutes' where id = '${id}'`);
    expect((await http().post('/api/service/maintenance/sweep').set(bearer(u.mgmt))).status).toBe(201);
    const [n] = await arrives(u.mgmt, id, 'service_sla_breached');
    expect(n.title).toMatch(/SLA response breached/);
    await http().post('/api/service/maintenance/sweep').set(bearer(u.mgmt));
    await settle();
    expect(await notes(u.mgmt.id, id, 'service_sla_breached')).toHaveLength(1);
  });

  // ------------------------------------------------------------------ expenses
  it('14. expense awaiting approval: the manager on submit, then accounts once the manager approves', async () => {
    const cats = Object.fromEntries(((await http().get('/api/expense-categories').set(bearer(u.sales))).body as any[]).map((c) => [c.code, c.id]));
    const claim = await http().post('/api/expense-claims').set(bearer(u.sales)).send({ title: `${TAG} claim` });
    expect(claim.status).toBe(201);
    const id = track('expense_claims', claim.body.id);
    const item = await http()
      .post(`/api/expense-claims/${id}/items`)
      .set(bearer(u.sales))
      .send({ expense_date: day(-2), category_id: cats.TRAVEL, amount: 400 + Math.floor(Math.random() * 500), purpose: 'Train to client site', category_details: { from: 'Delhi', to: 'Lucknow', mode: 'train' } });
    expect(item.status).toBe(201);
    expect((await http().post(`/api/expense-items/${item.body.item.id}/attachments`).set(bearer(u.sales)).attach('file', PNG(), 'receipt.png')).status).toBe(201);
    const version = async () => (await http().get(`/api/expense-claims/${id}`).set(bearer(u.sales))).body.version;
    expect((await http().post(`/api/expense-claims/${id}/submit`).set(bearer(u.sales)).send({ version: await version() })).status).toBe(200);
    await arrives(u.rmN, id, 'expense_approval');

    expect((await http().post(`/api/expense-claims/${id}/manager-approve`).set(bearer(u.rmN)).send({ version: await version() })).status).toBe(200);
    await arrives(u.accounts, id, 'expense_accounts');
  });

  // ------------------------------------------------------------------ the in-app inbox
  it('the inbox files visit, demo, service and follow-up alerts under their own categories, not "System"', async () => {
    const types = async (who: Who, category: string) => ((await http().get('/api/notifications').query({ category, limit: 100 }).set(bearer(who))).body.data as any[]).map((n) => n.type);
    expect(await types(u.sales, 'visit')).toEqual(expect.arrayContaining(['visit_cancelled', 'visit_planned', 'visit_intervention']));
    expect(await types(u.sales, 'lead')).toEqual(expect.arrayContaining(['followup_due', 'followup_overdue']));
    expect(await types(u.mgmt, 'demo')).toContain('demo_requested');
    expect(await types(u.mgmt, 'service')).toContain('service_sla_breached');
    const system = [...(await types(u.sales, 'system')), ...(await types(u.mgmt, 'system'))];
    expect(system.filter((t) => /visit|demo|service|followup_/.test(t))).toEqual([]);
    const summary = (await http().get('/api/notifications/summary').set(bearer(u.sales))).body;
    expect(summary.byType.visit).toBeGreaterThan(0);
  });

  it('each person sees only their own notifications, and can mark them read', async () => {
    const id = await task(u.sales);
    await arrives(u.sales, id, 'task_assigned');
    const mine = (await http().get('/api/notifications').set(bearer(u.sales))).body;
    const list = Array.isArray(mine) ? mine : mine.data;
    const row = list.find((n: any) => n.entity_id === id);
    expect(row).toBeTruthy();
    expect(list.every((n: any) => n.user_id === undefined || n.user_id === u.sales.id)).toBe(true);
    const theirs = (await http().get('/api/notifications').set(bearer(u.rmN))).body;
    expect((Array.isArray(theirs) ? theirs : theirs.data).some((n: any) => n.id === row.id)).toBe(false);
    expect((await http().patch(`/api/notifications/${row.id}/read`).set(bearer(u.rmN))).status).toBeGreaterThanOrEqual(400);
    expect((await http().patch(`/api/notifications/${row.id}/read`).set(bearer(u.sales))).status).toBe(200);
    expect((await q(`select is_read from notifications where id = '${row.id}'`))[0].is_read).toBe(true);
  });
});
