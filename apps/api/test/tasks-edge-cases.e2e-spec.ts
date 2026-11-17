/**
 * Edge cases for the blocker workflow, the accountability dashboard and performance evidence / reviews — the
 * regressions found in an adversarial pass, plus the boundary rules around them:
 *   - text with a lone "<" / ">" ("<50% on time") is stored as written; only real HTML tags are stripped
 *   - revising a locked review keeps the original in the evidence until the new version is submitted
 *   - one late task whose blocker was rejected is ONE unapproved delay, not two
 *   - reversed periods / unknown departments / malformed filters are 4xx, never a silent fallback
 *   - "%" and "_" in a search are literal characters
 *   - a task cannot be escalated twice to the same person while that escalation is open
 * Uses an isolated temporary team; everything it creates is removed afterwards.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { Kysely, sql } from 'kysely';
import { AppModule } from '../src/app.module';
import { TASK_DB } from '../src/modules/tasks/task-db';
import { loadTaskConfig } from '../src/modules/tasks/task.config';
import { todayInKolkata, type Database } from '@arihant/shared';
import { configureApp } from '../src/common/app-setup';

jest.setTimeout(120000);

const today = todayInKolkata();
const day = (n: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const vendor = { blocker_type: 'vendor_dependency', vendor_name: 'BEL', description: 'Waiting on the vendor quote since Monday.' };

describe('Tasks — blocker / accountability / evidence edge cases (e2e)', () => {
  let app: INestApplication;
  let db: Kysely<Database>;
  type Who = { token: string; id: string };
  const u: Record<string, Who> = {};
  const tempUserIds: string[] = [];
  const cat: Record<string, string> = {};

  const http = () => request(app.getHttpServer());
  const bearer = (w: Who) => ({ Authorization: `Bearer ${w.token}` });
  async function login(email: string): Promise<Who> {
    const res = await http().post('/api/auth/login').send({ email, password: 'password123' });
    if (res.status !== 200) throw new Error(`login ${email} → ${res.status}`);
    return { token: res.body.accessToken || res.body.token, id: res.body.user.id };
  }
  const get = (w: Who, id: string) => http().get(`/api/tasks/${id}`).set(bearer(w));
  const version = async (id: string) => (await get(u.mgmt, id)).body.version;
  const act = async (w: Who, id: string, action: string, body: Record<string, unknown> = {}) =>
    http().post(`/api/tasks/${id}/${action}`).set(bearer(w)).send({ version: await version(id), ...body });
  async function one(assignee: Who, body: Record<string, unknown> = {}) {
    const res = await http().post('/api/tasks').set(bearer(u.mgr)).send({ title: 'Edge task', category_id: cat.GENERAL, deadline: day(3), assignee_ids: [assignee.id], ...body });
    if (res.status !== 201) throw new Error(`create → ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.data[0].id as string;
  }
  const raise = async (w: Who, taskId: string, body: Record<string, unknown>) =>
    http().post(`/api/tasks/${taskId}/blockers`).set(bearer(w)).send({ version: await version(taskId), ...body });
  const openBlocker = async (taskId: string) => (await get(u.mgmt, taskId)).body.blockers.find((b: any) => b.open)?.id as string;
  const decide = async (w: Who, taskId: string, decision: string, body: Record<string, unknown> = {}) =>
    http().post(`/api/task-blockers/${await openBlocker(taskId)}/${decision}`).set(bearer(w)).send({ version: await version(taskId), ...body });
  const rewriteTask = (id: string, set: Record<string, unknown>) =>
    db.connection().execute(async (c) => {
      await sql`set session_replication_role = replica`.execute(c);
      await c.updateTable('tasks').set(set as any).where('id', '=', id).execute();
      await sql`set session_replication_role = default`.execute(c);
    });
  const complete = (w: Who, id: string, body: Record<string, unknown> = {}) => act(w, id, 'complete', { remarks: 'Work handed in', confirm_full_completion: true, ...body });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    db = moduleFixture.get<Kysely<Database>>(TASK_DB);
    u.mgmt = await login('mgmt@arihant.com');
    const hash = await bcrypt.hash('password123', 10);
    const ids = { mgr: randomUUID(), e1: randomUUID(), e2: randomUUID(), acc: randomUUID() };
    tempUserIds.push(...Object.values(ids));
    const tag = ids.mgr.slice(0, 6);
    const people: [keyof typeof ids, string, string, string][] = [
      ['mgr', 'EdManager', 'regional_manager', u.mgmt.id],
      ['e1', 'EdEmpOne', 'sales', ids.mgr],
      ['e2', 'EdEmpTwo', 'sales', ids.mgr],
      ['acc', 'EdAccountable', 'sales', ids.mgr],
    ];
    for (const [k, name, role, manager] of people) {
      await db.insertInto('users').values({ id: ids[k], full_name: name, email: `ed.${name.toLowerCase()}.${tag}@test.local`, role, reporting_manager_id: manager, password_hash: hash } as any).execute();
    }
    for (const [k, name] of people) u[k] = await login(`ed.${name.toLowerCase()}.${tag}@test.local`);
    for (const c of (await http().get('/api/task-categories').set(bearer(u.e1))).body) cat[c.code] = c.id;
  });

  afterAll(async () => {
    if (db && tempUserIds.length) {
      const storage = loadTaskConfig().storageDir;
      await db.connection().execute(async (conn) => {
        await sql`set session_replication_role = replica`.execute(conn);
        const tasks = (await conn.selectFrom('tasks').select('id').where((eb) => eb.or([eb('assigned_to', 'in', tempUserIds), eb('created_by', 'in', tempUserIds), eb('assigned_by', 'in', tempUserIds)])).execute()).map((t) => t.id);
        const historical = (await conn.selectFrom('task_assignment_history').select('task_id').where('from_user_id', 'in', tempUserIds).execute()).map((r) => r.task_id);
        const all = Array.from(new Set([...tasks, ...historical]));
        if (all.length) {
          for (const t of ['task_attachments', 'task_updates', 'task_deadline_changes', 'task_assignment_history', 'task_escalations', 'task_blockers'] as const) {
            await conn.deleteFrom(t).where('task_id', 'in', all).execute();
          }
          await conn.deleteFrom('task_notification_log').where('task_id', 'in', all).execute();
          await conn.deleteFrom('notifications').where('entity_id', 'in', all).execute();
          await conn.deleteFrom('tasks').where('id', 'in', all).execute();
        }
        const snaps = await conn.selectFrom('performance_evidence_snapshots').select(['pdf_storage_key', 'xlsx_storage_key']).where('employee_id', 'in', tempUserIds).execute();
        for (const s of snaps) for (const k of [s.pdf_storage_key, s.xlsx_storage_key]) if (k) fs.rmSync(path.join(storage, k), { force: true });
        await conn.deleteFrom('performance_evidence_snapshots').where('employee_id', 'in', tempUserIds).execute();
        await conn.deleteFrom('performance_reviews').where('employee_id', 'in', tempUserIds).execute();
        await conn.deleteFrom('task_notification_log').where('user_id', 'in', tempUserIds).execute();
        await conn.deleteFrom('notifications').where('user_id', 'in', tempUserIds).execute();
        await conn.deleteFrom('audit_log').where('actor_id', 'in', tempUserIds).execute();
        await conn.deleteFrom('users').where('id', 'in', tempUserIds).execute();
        await sql`set session_replication_role = default`.execute(conn);
      });
    }
    await app?.close();
  });

  describe('text is stored as written', () => {
    it('a lone "<" or ">" survives in blocker text and decisions; real HTML tags are still stripped', async () => {
      const t = await one(u.e1);
      const said = 'Vendor approved <50% of the lot; the rest needs >2 weeks (qty <5 units left)';
      const raised = await raise(u.e1, t, { ...vendor, description: `${said} <script>alert(1)</script><<b>b>` });
      expect(raised.status).toBe(201);
      expect(raised.body.blockers.find((b: any) => b.open).description).toBe(`${said} alert(1)`);
      const comment = 'Genuine: vendor confirmed <50% availability in writing';
      const accepted = await decide(u.mgr, t, 'accept', { mode: 'pause', comment });
      expect(accepted.status).toBe(200);
      expect(accepted.body.blockers[0].decision_comment).toBe(comment);
      // Only tags: a description made of nothing but markup is still empty → required error.
      expect((await raise(u.e2, await one(u.e2), { ...vendor, description: '<b></b><i>  </i>' })).status).toBe(400);
    });

    it('review comments keep their comparisons (they are evidence)', async () => {
      const comments = 'Completed <50% of tasks on time but >80% had an approved excuse.';
      const r = await http().post('/api/performance-reviews').set(bearer(u.mgr)).send({ employee_id: u.e1.id, period_from: day(-30), period_to: today, rating: 3, comments });
      expect(r.status).toBe(201);
      expect(r.body.comments).toBe(comments);
    });
  });

  describe('blocker workflow boundaries', () => {
    it.each([
      ['unknown type', { ...vendor, blocker_type: 'bad_weather' }],
      ['description under the minimum', { ...vendor, description: 'short' }],
      ['description of only spaces', { ...vendor, description: ' '.repeat(40) }],
      ['description over 2000 characters', { ...vendor, description: 'x'.repeat(2001) }],
      ['description that is not text', { ...vendor, description: { a: 1 } }],
      ['expected resolution in the past', { ...vendor, expected_resolution_date: day(-1) }],
      ['expected resolution not a real date', { ...vendor, expected_resolution_date: '2026-02-30' }],
      ['requested deadline in the past', { ...vendor, requested_new_deadline: day(-1) }],
      ['requested deadline absurdly far', { ...vendor, requested_new_deadline: '99999-01-01' }],
      ['waiting on yourself', { blocker_type: 'another_employee', description: 'Waiting on a colleague for drawings.', dependency_user_id: 'SELF' }],
      ['waiting on an unknown employee', { blocker_type: 'another_employee', description: 'Waiting on a colleague for drawings.', dependency_user_id: randomUUID() }],
      ['customer dependency without a customer', { blocker_type: 'customer_dependency', description: 'Customer has not replied to the offer.' }],
      ['approved leave that is not in the register', { blocker_type: 'approved_leave', description: 'On sick leave for two days.' }],
    ])('raise rejects %s with 400', async (_label, body) => {
      const t = await one(u.e1);
      const payload = { ...body } as Record<string, unknown>;
      if (payload.dependency_user_id === 'SELF') payload.dependency_user_id = u.e1.id;
      expect((await raise(u.e1, t, payload)).status).toBe(400);
      expect((await get(u.mgmt, t)).body.status).toBe('not_started');
    });

    it('accept with a new deadline must move it later and into the future; decisions happen once', async () => {
      const t = await one(u.e1);
      await raise(u.e1, t, vendor);
      for (const new_deadline of [day(-1), day(2), day(3), '9999-12-31', 'tomorrow']) {
        expect((await decide(u.mgr, t, 'accept', { mode: 'extend', new_deadline, comment: 'Genuine vendor delay.' })).status).toBe(400);
      }
      expect((await decide(u.mgr, t, 'accept', { mode: 'forever', comment: 'Genuine vendor delay.' })).status).toBe(400);
      expect((await decide(u.mgr, t, 'accept', { mode: 'pause', comment: 'ok.' })).status).toBe(400);
      expect((await decide(u.e1, t, 'accept', { mode: 'pause', comment: 'Genuine vendor delay.' })).status).toBe(403);
      expect((await decide(u.mgr, t, 'resolve', { note: 'Vendor sent it now.' })).status).toBe(403);
      expect((await decide(u.mgr, t, 'accept', { mode: 'extend', new_deadline: day(6), comment: 'Genuine vendor delay.' })).status).toBe(200);
      expect((await decide(u.mgr, t, 'reject', { comment: 'Changed my mind on this.' })).status).toBe(409);
    });

    it('accept and reject racing on the same version: exactly one wins', async () => {
      const t = await one(u.e1);
      await raise(u.e1, t, vendor);
      const b = await openBlocker(t);
      const v = await version(t);
      const send = (d: string, body: Record<string, unknown>) => http().post(`/api/task-blockers/${b}/${d}`).set(bearer(u.mgr)).send({ version: v, ...body });
      const res = await Promise.all([send('accept', { mode: 'pause', comment: 'Genuine vendor delay.' }), send('reject', { comment: 'Not a genuine blocker here.' })]);
      expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    });

    it('a task cannot be escalated twice to the same person while that escalation is open', async () => {
      const t = await one(u.e1);
      await raise(u.e1, t, vendor);
      expect((await act(u.mgr, t, 'escalate', { reason: 'Discount is above my approval limit.' })).status).toBe(200);
      const again = await act(u.mgr, t, 'escalate', { reason: 'Escalating again for visibility.' });
      expect(again.status).toBe(409);
      expect((await get(u.mgmt, t)).body.escalations.filter((e: any) => e.status !== 'closed')).toHaveLength(1);
    });

    it('"%" and "_" in a queue search are literal, not wildcards', async () => {
      const t = await one(u.e1, { title: 'Edge 100% stock check' });
      await raise(u.e1, t, vendor);
      const search = async (s: string) => (await http().get('/api/task-blockers/pending').query({ search: s }).set(bearer(u.mgr))).body.data.map((r: any) => r.task_id);
      expect(await search('%')).toEqual([t]);
      expect(await search('_')).toEqual([]);
    });
  });

  describe('accountability', () => {
    it('one late task whose blocker was rejected is one unapproved delay', async () => {
      const t = await one(u.acc);
      await rewriteTask(t, { deadline: sql`now() - interval '1 day'`, original_deadline: sql`now() - interval '1 day'` });
      await raise(u.acc, t, vendor);
      await decide(u.mgr, t, 'reject', { comment: 'Use the backup vendor instead.' });
      expect((await complete(u.acc, t, { delay_reason: 'Waited on the vendor anyway.' })).status).toBe(200);
      const dash = await http().get('/api/accountability/dashboard').query({ from: day(-30), to: day(30) }).set(bearer(u.mgr));
      const row = dash.body.employees.find((e: any) => e.employee_id === u.acc.id);
      expect(row).toMatchObject({ late_unexcused: 1, rejected_blockers: 1, unapproved_delays: 1 });
    });

    it('a reversed period or an unknown department is an error, not an empty dashboard', async () => {
      expect((await http().get('/api/accountability/dashboard').query({ from: day(5), to: day(-5) }).set(bearer(u.mgr))).status).toBe(400);
      expect((await http().get('/api/accountability/dashboard').query({ scope: 'department', department_id: randomUUID() }).set(bearer(u.mgmt))).status).toBe(404);
    });
  });

  describe('performance reviews in the evidence', () => {
    it('a locked review stays in the evidence while its new version is a draft, and is replaced once that is submitted', async () => {
      const ev = async () => (await http().get('/api/performance/evidence').query({ employee_id: u.e2.id, from: day(-30), to: today }).set(bearer(u.mgr))).body.reviews.map((r: any) => r.id);
      const draft = await http().post('/api/performance-reviews').set(bearer(u.mgr)).send({ employee_id: u.e2.id, period_from: day(-30), period_to: today, rating: 4, comments: 'Consistently raised blockers early with clear detail.' });
      const submitted = await http().post(`/api/performance-reviews/${draft.body.id}/submit`).set(bearer(u.mgr)).send({ version: draft.body.version });
      expect(submitted.status).toBe(200);
      expect(await ev()).toEqual([draft.body.id]);

      const revised = await http().post(`/api/performance-reviews/${draft.body.id}/revise`).set(bearer(u.mgr)).send({ reason: 'Rating should reflect the late Q3 tasks.' });
      expect(revised.body.status).toBe('draft');
      expect(await ev()).toEqual([draft.body.id]);

      expect((await http().post(`/api/performance-reviews/${revised.body.id}/submit`).set(bearer(u.mgr)).send({ version: revised.body.version })).status).toBe(200);
      expect(await ev()).toEqual([revised.body.id]);
    });

    it('a malformed employee filter is a 400, never "every review I can see"', async () => {
      expect((await http().get('/api/performance-reviews').query({ employee_id: 'not-a-real-id' }).set(bearer(u.mgr))).status).toBe(400);
      expect((await http().get('/api/performance-reviews').query({ employee_id: u.e2.id }).set(bearer(u.mgr))).status).toBe(200);
    });
  });
});
