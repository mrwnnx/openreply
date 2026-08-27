/**
 * Rate Limiter
 *
 * Postgres-based rate limiter for Instagram private replies.
 *
 * The cap matches Meta's documented limit for this exact call: 750 private
 * replies per hour per Instagram professional account, for comments on posts
 * and reels. Exceeding it risks 429s and app-level restrictions, so the caller
 * requeues rather than pushing through.
 * https://developers.facebook.com/docs/graph-api/overview/rate-limiting/
 *
 * Note this is a hard ceiling with no headroom. If Meta throttles before the
 * documented limit, or other calls on the same account share the bucket, lower
 * this value.
 *
 * This used to live in Redis. It moved to Postgres when the worker and its
 * Upstash instance were removed: an idle BullMQ worker cost more Redis commands
 * than the free tier allowed, and the counter was the only other thing keeping
 * that dependency alive. One row per account per hour costs a single statement
 * on a database the send already has to touch.
 */

import { prisma } from "@/lib/db/client";

const RATE_LIMIT_MAX = 750; // private replies per hour, per Meta's documented cap
const RATE_LIMIT_WINDOW = 3600; // 1 hour in seconds
const REQUEUE_DELAY_MS = 30 * 60 * 1000; // 30 minutes
const MAX_REQUEUE_ATTEMPTS = 3;

export interface RateLimitResult {
  allowed: boolean;
  currentCount: number;
  remainingDMs: number;
  shouldRequeue: boolean;
  requeueDelayMs: number;
  shouldSkip: boolean;
  reserved: boolean;
}

/**
 * The hour bucket a moment falls into. Truncating to the hour is what makes the
 * primary key stable across concurrent sends, and what lets old rows be dropped
 * by windowStart without tracking expiry per row.
 */
export function currentWindowStart(now: Date = new Date()): Date {
  return new Date(
    Math.floor(now.getTime() / (RATE_LIMIT_WINDOW * 1000)) *
      RATE_LIMIT_WINDOW *
      1000
  );
}

function dmWindowKey(instagramAccountId: string): string {
  return `dm:${instagramAccountId}`;
}

/**
 * Claim one unit against a key's ceiling for the current hour.
 *
 * The increment and the ceiling check are a single statement: the conditional
 * ON CONFLICT returns no row once the window is full, so concurrent callers
 * cannot all read a below-limit count and then each proceed. Returns the new
 * count, or null when the window is full.
 */
export async function claimWindowSlot(
  key: string,
  max: number
): Promise<number | null> {
  const windowStart = currentWindowStart();

  const rows = await prisma.$queryRaw<Array<{ count: number }>>`
    INSERT INTO "RateWindow" ("key", "windowStart", "count")
    VALUES (${key}, ${windowStart}, 1)
    ON CONFLICT ("key", "windowStart")
    DO UPDATE SET "count" = "RateWindow"."count" + 1
    WHERE "RateWindow"."count" < ${max}
    RETURNING "count"
  `;

  const count = rows[0]?.count;
  return count === undefined ? null : Number(count);
}

function blockedResult(
  count: number,
  requeueAttempt: number
): RateLimitResult {
  if (requeueAttempt >= MAX_REQUEUE_ATTEMPTS) {
    return {
      allowed: false,
      currentCount: count,
      remainingDMs: 0,
      shouldRequeue: false,
      requeueDelayMs: 0,
      shouldSkip: true,
      reserved: false,
    };
  }

  return {
    allowed: false,
    currentCount: count,
    remainingDMs: 0,
    shouldRequeue: true,
    requeueDelayMs: REQUEUE_DELAY_MS,
    shouldSkip: false,
    reserved: false,
  };
}

/**
 * Check if an Instagram account is within its DM rate limit.
 *
 * Read-only: it reports the state without claiming a slot. Two callers can both
 * pass this check and then both send, which is why the send path uses
 * reserveDMSlot instead.
 */
export async function checkRateLimit(
  instagramAccountId: string,
  requeueAttempt: number = 0
): Promise<RateLimitResult> {
  const count = await getCurrentDMCount(instagramAccountId);

  if (count >= RATE_LIMIT_MAX) {
    return blockedResult(count, requeueAttempt);
  }

  return {
    allowed: true,
    currentCount: count,
    remainingDMs: RATE_LIMIT_MAX - count,
    shouldRequeue: false,
    requeueDelayMs: 0,
    shouldSkip: false,
    reserved: false,
  };
}

/**
 * Atomically reserve a DM send slot for an Instagram account.
 *
 * The increment and the ceiling check happen in one statement: the conditional
 * ON CONFLICT returns no row when the window is already full, so concurrent
 * senders cannot all read a below-limit count and then each send.
 */
export async function reserveDMSlot(
  instagramAccountId: string,
  requeueAttempt: number = 0
): Promise<RateLimitResult> {
  const reservedCount = await claimWindowSlot(
    dmWindowKey(instagramAccountId),
    RATE_LIMIT_MAX
  );

  if (reservedCount === null) {
    // No row came back: the conditional update did not fire, so the window is
    // full. Read the count separately for the caller's diagnostics.
    return blockedResult(
      await getCurrentDMCount(instagramAccountId),
      requeueAttempt
    );
  }

  const count = reservedCount;
  return {
    allowed: true,
    currentCount: count,
    remainingDMs: RATE_LIMIT_MAX - count,
    shouldRequeue: false,
    requeueDelayMs: 0,
    shouldSkip: false,
    reserved: true,
  };
}

/**
 * Backwards-compatible helper for tests and admin scripts.
 * Prefer reserveDMSlot in senders.
 */
export async function incrementDMCounter(
  instagramAccountId: string
): Promise<number> {
  const result = await reserveDMSlot(instagramAccountId, MAX_REQUEUE_ATTEMPTS);
  return result.currentCount;
}

/**
 * Get the current DM count for an Instagram account in the live window.
 */
export async function getCurrentDMCount(
  instagramAccountId: string
): Promise<number> {
  const row = await prisma.rateWindow.findUnique({
    where: {
      key_windowStart: {
        key: dmWindowKey(instagramAccountId),
        windowStart: currentWindowStart(),
      },
    },
    select: { count: true },
  });

  return row?.count ?? 0;
}

/**
 * Reset the rate limiter for an account (useful for testing).
 */
export async function resetRateLimit(
  instagramAccountId: string
): Promise<void> {
  await prisma.rateWindow.deleteMany({
    where: { key: dmWindowKey(instagramAccountId) },
  });
}

// Export constants for use in tests
export { RATE_LIMIT_MAX, RATE_LIMIT_WINDOW, REQUEUE_DELAY_MS, MAX_REQUEUE_ATTEMPTS };
