/**
 * Scheduled jobs
 *
 * The durable half of what BullMQ used to do, on the database the work already
 * touches. A job is a row: writing it is the commitment that the work will
 * happen, running it is a separate step that can be retried.
 *
 * Two things drive it. The webhook drains immediately after answering Meta, so
 * a comment is handled in the same second it arrives. A cron drains on a fixed
 * interval, which is what makes delayed work fire and what catches anything the
 * webhook's execution window cut short.
 */

import { prisma } from "@/lib/db/client";
import type { Prisma } from "@/app/generated/prisma/client";

export type JobKind = "COMMENT" | "POSTBACK" | "FOLLOWUP" | "MESSAGE";

// Kept from the BullMQ configuration it replaces: three attempts, widening gaps.
export const BACKOFF_DELAYS_MS = [5 * 60_000, 15 * 60_000, 45 * 60_000];
export const MAX_ATTEMPTS = 3;

// A claim older than this is treated as abandoned — the only way to leave one
// behind is for the process holding it to die mid-job.
const CLAIM_TIMEOUT_MS = 10 * 60_000;

// Settled rows are the dedup ledger, so they outlive the work by a wide margin.
// BullMQ kept roughly the last thousand; a month is far more forgiving and
// still bounded.
const SETTLED_RETENTION_DAYS = 30;

export interface ScheduledJobRow {
  id: string;
  key: string;
  kind: JobKind;
  payload: Prisma.JsonValue;
  runAt: Date;
  attempts: number;
}

export interface ScheduleJobInput {
  /**
   * Deterministic identity for this piece of work. Scheduling the same key
   * twice is a no-op, which is what dedupes a webhook Meta redelivers and a
   * follow-up two button taps would otherwise both schedule.
   */
  key: string;
  kind: JobKind;
  payload: Prisma.InputJsonValue;
  /** Omit for "as soon as possible". */
  runAt?: Date;
}

/**
 * Record a job. Idempotent on `key`: an existing row — pending, done or failed —
 * wins, and nothing is overwritten.
 */
export async function scheduleJob(input: ScheduleJobInput): Promise<void> {
  await prisma.scheduledJob.upsert({
    where: { key: input.key },
    create: {
      key: input.key,
      kind: input.kind,
      payload: input.payload,
      runAt: input.runAt ?? new Date(),
    },
    update: {},
  });
}

/**
 * Claim up to `limit` jobs that are due.
 *
 * The claim is the update itself, so two drains running at once cannot take the
 * same row: SKIP LOCKED steps over what the other has locked, and claimedAt
 * keeps a crashed drain's rows out of circulation until the timeout passes.
 */
export async function claimDueJobs(limit = 25): Promise<ScheduledJobRow[]> {
  const staleBefore = new Date(Date.now() - CLAIM_TIMEOUT_MS);

  return prisma.$queryRaw<ScheduledJobRow[]>`
    UPDATE "ScheduledJob"
    SET "claimedAt" = now(), "attempts" = "attempts" + 1, "updatedAt" = now()
    WHERE "id" IN (
      SELECT "id" FROM "ScheduledJob"
      WHERE "status" = 'PENDING'
        AND "runAt" <= now()
        AND ("claimedAt" IS NULL OR "claimedAt" < ${staleBefore})
      ORDER BY "runAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "key", "kind", "payload", "runAt", "attempts"
  `;
}

export async function markJobDone(id: string): Promise<void> {
  await prisma.scheduledJob.update({
    where: { id },
    data: { status: "DONE", claimedAt: null, lastError: null },
  });
}

/**
 * Hand a failed job back for another attempt, or give up on it.
 *
 * `attempts` was already incremented by the claim, so it counts attempts made,
 * not attempts remaining.
 */
export async function markJobFailed(
  job: ScheduledJobRow,
  error: string
): Promise<{ retrying: boolean }> {
  const retrying = job.attempts < MAX_ATTEMPTS;

  if (!retrying) {
    await prisma.scheduledJob.update({
      where: { id: job.id },
      data: { status: "FAILED", claimedAt: null, lastError: error },
    });
    return { retrying: false };
  }

  const delay =
    BACKOFF_DELAYS_MS[Math.min(job.attempts - 1, BACKOFF_DELAYS_MS.length - 1)];

  await prisma.scheduledJob.update({
    where: { id: job.id },
    data: {
      claimedAt: null,
      lastError: error,
      runAt: new Date(Date.now() + delay),
    },
  });
  return { retrying: true };
}

/**
 * Drop settled rows once they are past the dedup window. Without this the table
 * only grows — the failure mode that filled the database once already.
 */
export async function purgeSettledJobs(): Promise<number> {
  const cutoff = new Date(
    Date.now() - SETTLED_RETENTION_DAYS * 24 * 60 * 60 * 1000
  );

  const { count } = await prisma.scheduledJob.deleteMany({
    where: {
      status: { in: ["DONE", "FAILED"] },
      updatedAt: { lt: cutoff },
    },
  });

  return count;
}

/**
 * How far behind the drain is. Jobs due well in the past mean the cron is not
 * firing — this is the signal that replaced the worker's Redis heartbeat.
 */
export async function countOverdueJobs(olderThanMs: number): Promise<number> {
  return prisma.scheduledJob.count({
    where: {
      status: "PENDING",
      runAt: { lt: new Date(Date.now() - olderThanMs) },
    },
  });
}
