import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Kysely, sql } from 'kysely';
import { KYSELY_DB } from '../common/database/database.module.js';
import { AppEvents } from '../common/events/event-names.js';
import { calendarDay } from '../common/utils/ist-date.util.js';
import { EventsGateway } from '../common/realtime/events.gateway.js';
import { OutboxService } from '../common/outbox/outbox.service.js';
import {
  CLOSED_LEAD_STATUSES,
  TENDER_UPCOMING_DAYS,
  TENDER_URGENT_HOURS,
  todayInKolkata,
  istDateOf,
  isoDaysBetween,
  type Database,
} from '@arihant/shared';

/**
 * A follow-up still worth chasing: not tied to a lead, or its lead is still open (Leads page LEAD_IS_OPEN). A converted,
 * won or lost lead's leftover follow-up is not a reminder anyone should get.
 */
const FOLLOW_UP_ON_OPEN_LEAD = sql<boolean>`(follow_ups.lead_id is null or not exists (
  select 1 from leads l where l.id = follow_ups.lead_id
    and lower(coalesce(l.lead_status, l.status, 'new')) = any(${[...CLOSED_LEAD_STATUSES] as string[]}::text[])))`;

/** Pre-submission stages — the only ones whose submission deadline can still be missed. */
const PRE_SUBMISSION_STATUSES = ['identified', 'awaiting_approval', 'under_preparation', 'pq_qualified'];

@Injectable()
export class DeadlineRemindersJob {
  private readonly logger = new Logger(DeadlineRemindersJob.name);

  constructor(
    @Inject(KYSELY_DB) private readonly db: Kysely<Database>,
    private readonly eventEmitter: EventEmitter2,
    private readonly eventsGateway: EventsGateway,
    private readonly outboxService: OutboxService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async checkTenderDeadlines() {
    this.logger.log('Running tender deadline & compliance check job...');

    const now = new Date();
    // Windows come from Tender Settings when configured; the shared constants are only the fallback.
    const settings = await this.db
      .selectFrom('tender_settings')
      .select(['upcoming_days', 'approaching_days', 'approval_sla_hours', 'escalation_user_ids'])
      .executeTakeFirst()
      .catch(() => undefined);
    const upcomingMs = (settings?.upcoming_days || TENDER_UPCOMING_DAYS) * 24 * 60 * 60 * 1000;
    const urgentMs = settings?.approaching_days
      ? settings.approaching_days * 24 * 60 * 60 * 1000
      : TENDER_URGENT_HOURS * 60 * 60 * 1000;

    // B2/B3: only live (not deleted), pre-submission bids can miss or approach their submission deadline —
    // a submitted / under-evaluation / closed bid is never "overdue".
    const activeTenders = await this.db
      .selectFrom('tenders')
      .selectAll()
      .where('is_deleted', '=', false)
      .where('status', 'in', PRE_SUBMISSION_STATUSES as any)
      .where((eb) =>
        eb.or([
          eb('submission_deadline', 'is not', null),
          eb('bid_closing_date', 'is not', null),
        ]),
      )
      .execute();

    for (const tender of activeTenders) {
      const rawDeadline = tender.submission_deadline || tender.bid_closing_date;
      if (!rawDeadline) continue;
      const closingDate = new Date(rawDeadline);
      const diffMs = closingDate.getTime() - now.getTime();
      const hoursLeft = Math.round(diffMs / (1000 * 60 * 60));
      // Calendar days and the dedupe key use the IST day (server clock is UTC; 00:00–05:30 IST is still "yesterday" in UTC).
      const daysLeft = isoDaysBetween(todayInKolkata(now), istDateOf(closingDate));
      const deadlineKey = istDateOf(closingDate);

      // Overdue
      if (diffMs < 0) {
        const idempotencyKey = `overdue_${tender.id}_${deadlineKey}`;
        const alreadyNotified = await this.outboxService.isEventProcessed(idempotencyKey, 'TenderDeadlineCheck');
        if (!alreadyNotified) {
          await this.outboxService.queueEvent(this.db, {
            eventType: AppEvents.TENDER_DEADLINE_EXCEEDED,
            aggregateType: 'TENDER',
            aggregateId: tender.id,
            payload: {
              tenderId: tender.id,
              tenderNo: tender.tender_no,
              deadline: closingDate.toISOString(),
              assignedPersonId: tender.assigned_to || (tender as any).assigned_person_id,
              tenderOwnerId: (tender as any).tender_owner_id,
            },
          });
          await this.outboxService.markEventProcessed(idempotencyKey, 'TenderDeadlineCheck');
        }
      } else if (diffMs <= urgentMs) {
        // Urgent: within the approaching window (settings.approaching_days, else 48h)
        const idempotencyKey = `urgent_${tender.id}_${deadlineKey}`;
        const alreadyNotified = await this.outboxService.isEventProcessed(idempotencyKey, 'TenderDeadlineCheck');
        if (!alreadyNotified) {
          await this.outboxService.queueEvent(this.db, {
            eventType: AppEvents.TENDER_DEADLINE_APPROACHING,
            aggregateType: 'TENDER',
            aggregateId: tender.id,
            payload: {
              tenderId: tender.id,
              tenderNo: tender.tender_no,
              deadline: closingDate.toISOString(),
              hoursLeft,
              assignedPersonId: tender.assigned_to || (tender as any).assigned_person_id,
              tenderOwnerId: (tender as any).tender_owner_id,
            },
          });
          await this.outboxService.markEventProcessed(idempotencyKey, 'TenderDeadlineCheck');
        }
      } else if (diffMs <= upcomingMs) {
        // Upcoming: within settings.upcoming_days (else 7 days) - warning broadcast
        this.eventsGateway.broadcast('tender:deadline_warning', {
          tenderId: tender.id,
          tenderNo: tender.tender_no,
          daysLeft,
          bidClosingDate: rawDeadline,
        });
      }
    }

    await this.sweepApprovalSla(now, settings?.approval_sla_hours ?? 24, settings?.escalation_user_ids);

    this.outboxService.triggerImmediate();
  }

  /**
   * Approval SLA: a bid waiting in awaiting_approval longer than tender_settings.approval_sla_hours is escalated to
   * the configured escalation users, once per tender per IST day (deduped through processed_events).
   */
  private async sweepApprovalSla(now: Date, slaHours: number, rawEscalationIds: unknown) {
    const escalationIds = (Array.isArray(rawEscalationIds) ? rawEscalationIds : []).filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    );
    if (!escalationIds.length || !slaHours) return;

    const cutoff = new Date(now.getTime() - slaHours * 60 * 60 * 1000);
    const waiting = await this.db
      .selectFrom('tenders')
      .select(['tenders.id', 'tenders.tender_no', 'tenders.tender_number', 'tenders.updated_at', 'tenders.created_at'])
      .select((eb) =>
        eb
          .selectFrom('tender_status_history')
          .select((h) => h.fn.max('tender_status_history.changed_at').as('since'))
          .whereRef('tender_status_history.tender_id', '=', 'tenders.id')
          .where('tender_status_history.to_status', '=', 'awaiting_approval')
          .as('awaiting_since'),
      )
      .where('tenders.is_deleted', '=', false)
      .where('tenders.status', '=', 'awaiting_approval' as any)
      .where((eb) => eb.or([eb('tenders.on_hold', '=', false), eb('tenders.on_hold', 'is', null)]))
      .execute();

    const today = todayInKolkata(now);
    for (const t of waiting) {
      const since = new Date((t.awaiting_since as any) || t.updated_at || t.created_at);
      if (since > cutoff) continue;

      const dedupeKey = `approval_sla_${t.id}_${today}`;
      if (await this.outboxService.isEventProcessed(dedupeKey, 'TenderApprovalSla')) continue;

      const tenderNo = t.tender_number || t.tender_no || 'Tender';
      const waitedHours = Math.round((now.getTime() - since.getTime()) / (60 * 60 * 1000));
      for (const userId of escalationIds) {
        try {
          const row = await this.db
            .insertInto('notifications')
            .values({
              user_id: userId,
              type: 'tender_approval_escalation',
              title: `Approval SLA breached: ${tenderNo}`,
              body: `Tender ${tenderNo} has been awaiting internal approval for ${waitedHours} hours (SLA ${slaHours}h).`,
              entity_type: 'tender',
              entity_id: t.id,
              is_read: false,
            })
            .returningAll()
            .executeTakeFirst();
          if (row) this.eventsGateway.sendToUser(userId, 'notification:new', row);
        } catch (err: any) {
          this.logger.warn(`Approval SLA notification failed for tender ${t.id}: ${err.message}`);
        }
      }
      await this.outboxService.markEventProcessed(dedupeKey, 'TenderApprovalSla');
    }
  }

  // Task overdue detection moved to Module 8 (tasks/task-jobs.service.ts): OVERDUE is derived, never stored.

  // Proposal follow-up / inactivity alerts live in ProposalsSchedulerService.runHourlyProposalChecks, which emits
  // proposal.followup_due / followup_overdue / stale as outbox envelopes deduped per day via scheduler_dedupe.
  // The legacy raw-payload emitter that used to sit here broke every proposal.* envelope consumer.

  @Cron(CronExpression.EVERY_HOUR)
  async checkLeadFollowupsOverdue() {
    this.logger.log('Running CRM lead & customer follow-up overdue compliance check...');
    const today = todayInKolkata();

    const overdueFollowUps = await this.db
      .selectFrom('follow_ups')
      .innerJoin('organisations', 'follow_ups.organisation_id', 'organisations.id')
      .select([
        'follow_ups.id',
        'follow_ups.assigned_to',
        'follow_ups.due_date',
        'follow_ups.lead_id',
        'organisations.name as organisation_name',
      ])
      .where('follow_ups.status', '=', 'pending')
      .where('follow_ups.due_date', '<', today)
      .where(FOLLOW_UP_ON_OPEN_LEAD)
      .execute();

    for (const fu of overdueFollowUps) {
      const idempotencyKey = `overdue_fu_${fu.id}_${today}`;
      const alreadyHandled = await this.outboxService.isEventProcessed(
        idempotencyKey,
        'DeadlineRemindersJob.checkLeadFollowupsOverdue',
      );

      if (!alreadyHandled) {
        await this.outboxService.queueEvent(this.db, {
          eventType: AppEvents.FOLLOWUP_OVERDUE,
          aggregateType: 'FOLLOW_UP',
          aggregateId: fu.id,
          payload: {
            followUpId: fu.id,
            leadId: fu.lead_id,
            assignedTo: fu.assigned_to,
            dueDate: fu.due_date,
            organisationName: fu.organisation_name,
          },
        });
        await this.outboxService.markEventProcessed(
          idempotencyKey,
          'DeadlineRemindersJob.checkLeadFollowupsOverdue',
        );
      }
    }

    if (overdueFollowUps.length > 0) {
      this.outboxService.triggerImmediate();
    }
  }

  /**
   * Blueprint "Follow-up due": a pending follow-up due today (IST) on an open lead reminds its owner once. Runs hourly in
   * working hours (08:00–20:00 IST) so a follow-up added in the morning is still caught, and nobody is pinged at night.
   */
  @Cron('0 0 8-20 * * *', { timeZone: 'Asia/Kolkata' })
  async checkLeadFollowupsDue(): Promise<number> {
    const today = todayInKolkata();
    const due = await this.db
      .selectFrom('follow_ups')
      .innerJoin('organisations', 'follow_ups.organisation_id', 'organisations.id')
      .select(['follow_ups.id', 'follow_ups.assigned_to', 'follow_ups.due_date', 'follow_ups.due_time', 'follow_ups.lead_id', 'organisations.name as organisation_name'])
      .where('follow_ups.status', '=', 'pending')
      .where('follow_ups.due_date', '=', today as any)
      .where('follow_ups.assigned_to', 'is not', null)
      .where(FOLLOW_UP_ON_OPEN_LEAD)
      .execute();

    let queued = 0;
    for (const fu of due) {
      const idempotencyKey = `due_fu_${fu.id}_${today}`;
      if (await this.outboxService.isEventProcessed(idempotencyKey, 'DeadlineRemindersJob.checkLeadFollowupsDue')) continue;
      await this.outboxService.queueEvent(this.db, {
        eventType: AppEvents.FOLLOWUP_DUE,
        aggregateType: 'FOLLOW_UP',
        aggregateId: fu.id,
        payload: {
          followUpId: fu.id,
          leadId: fu.lead_id,
          assignedTo: fu.assigned_to,
          dueDate: today,
          dueTime: fu.due_time ?? null,
          organisationName: fu.organisation_name,
        },
      });
      await this.outboxService.markEventProcessed(idempotencyKey, 'DeadlineRemindersJob.checkLeadFollowupsDue');
      queued++;
    }
    if (queued) this.outboxService.triggerImmediate();
    return queued;
  }

  /**
   * EMD / PBG watch (daily, 09:00 IST): a live instrument (issued, submitted or refund due) reaching 30 / 15 / 7 / 1
   * days to expiry, or lapsed, and an EMD refund pending more than 30 days (once a week). Goes to the finance owner,
   * else every Accounts user, plus the bid owner for expiry. Each reminder is sent once (processed_events).
   */
  @Cron('0 0 9 * * *', { timeZone: 'Asia/Kolkata' })
  async checkInstrumentAttention() {
    const today = todayInKolkata();
    const rows = await this.db
      .selectFrom('tender_financial_instruments as i')
      .innerJoin('tenders as t', 't.id', 'i.tender_id')
      .select([
        'i.id',
        'i.tender_id',
        'i.instrument_type',
        'i.amount',
        'i.status',
        'i.finance_owner_id',
        'i.refund_due_on',
        'i.expiry_date',
        'i.created_at',
        't.tender_no',
        't.tender_number',
        't.tender_owner_id',
        't.assigned_to',
        't.result_date',
      ])
      .where('i.status', 'in', ['Issued', 'Submitted', 'Refund Due'])
      .where('t.is_deleted', '=', false)
      .execute();
    if (!rows.length) return;

    const accounts = (
      await this.db.selectFrom('users').select('id').where('role', '=', 'accounts').where('is_active', '=', true).execute()
    ).map((u) => u.id);
    // DATE columns arrive as local-midnight Dates: read them as their IST calendar day, never via toISOString (UTC).
    const day = (v: unknown) => calendarDay(v as any);
    const isoWeek = (d: string) => `${d.slice(0, 4)}-w${Math.ceil((isoDaysBetween(`${d.slice(0, 4)}-01-01`, d) + 1) / 7)}`;

    for (const r of rows) {
      const what = `${r.instrument_type}${r.amount ? ` of ₹ ${Number(r.amount).toLocaleString('en-IN')}` : ''}`;
      const bid = r.tender_number || r.tender_no || 'a tender';
      const finance = r.finance_owner_id ? [r.finance_owner_id] : accounts;
      const notices: { key: string; title: string; body: string; to: string[] }[] = [];

      const expiry = day(r.expiry_date);
      if (expiry) {
        const left = isoDaysBetween(today, expiry);
        if (left < 0 || [30, 15, 7, 1].includes(left)) {
          notices.push({
            key: left < 0 ? `instrument-lapsed-${r.id}-${expiry}` : `instrument-expiry-${r.id}-${expiry}-${left}`,
            title: left < 0 ? `${r.instrument_type} validity lapsed: ${bid}` : `${r.instrument_type} expires in ${left} day${left === 1 ? '' : 's'}: ${bid}`,
            body:
              left < 0
                ? `${what} for ${bid} passed its expiry date (${expiry}) while still ${r.status}. Extend it with the bank or mark it expired.`
                : `${what} for ${bid} expires on ${expiry} and is still ${r.status}. Get it extended or returned in time.`,
            to: [...finance, ...([r.tender_owner_id, r.assigned_to].filter(Boolean) as string[])],
          });
        }
      }
      if (r.status === 'Refund Due' && r.instrument_type === 'EMD') {
        const since = day(r.refund_due_on) || day(r.result_date) || day(r.created_at)!;
        const pending = isoDaysBetween(since, today);
        if (pending > 30) {
          notices.push({
            key: `instrument-refund-aging-${r.id}-${isoWeek(today)}`,
            title: `EMD refund pending ${pending} days: ${bid}`,
            body: `${what} for ${bid} has been due back since ${since}. Follow up with the buyer and record it when received.`,
            to: finance,
          });
        }
      }

      for (const n of notices) {
        if (await this.outboxService.isEventProcessed(n.key, 'InstrumentAttention')) continue;
        for (const userId of new Set(n.to)) {
          try {
            const row = await this.db
              .insertInto('notifications')
              .values({ user_id: userId, type: 'tender_instrument', title: n.title, body: n.body, entity_type: 'tender', entity_id: r.tender_id, is_read: false })
              .returningAll()
              .executeTakeFirst();
            if (row) this.eventsGateway.sendToUser(userId, 'notification:new', row);
          } catch (err: any) {
            this.logger.warn(`Instrument reminder failed for ${r.id}: ${err.message}`);
          }
        }
        await this.outboxService.markEventProcessed(n.key, 'InstrumentAttention');
      }
    }
  }
}
