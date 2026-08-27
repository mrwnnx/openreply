/**
 * Drain
 *
 * Takes due jobs and runs them. Called from two places: the webhook, right
 * after it has answered Meta, and the cron. Both do the same thing — the
 * webhook is only there so an arriving comment does not wait for the next tick.
 */

import {
  claimDueJobs,
  markJobDone,
  markJobFailed,
  purgeSettledJobs,
} from "./scheduler";
import { runScheduledJob, recordJobFailure } from "./handlers";
import { reconcileComments } from "@/lib/polling/comment-reconciler";

export interface DrainResult {
  claimed: number;
  succeeded: number;
  retrying: number;
  failed: number;
  /** True when the time budget cut the run short and work is still waiting. */
  stoppedEarly: boolean;
}

// A serverless invocation gets killed at its max duration. Stopping before that
// matters: a job interrupted mid-run keeps its claim, and nothing else will
// touch it until the claim goes stale ten minutes later.
const DEFAULT_DEADLINE_MS = 40_000;

export async function drainDueJobs(options?: {
  limit?: number;
  deadlineMs?: number;
}): Promise<DrainResult> {
  const deadline = Date.now() + (options?.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const jobs = await claimDueJobs(options?.limit ?? 10);

  const result: DrainResult = {
    claimed: jobs.length,
    succeeded: 0,
    retrying: 0,
    failed: 0,
    stoppedEarly: false,
  };

  for (const job of jobs) {
    if (Date.now() >= deadline) {
      // Hand the rest back rather than start work that cannot finish.
      await markJobFailed(job, "Drain deadline reached before this job ran");
      result.stoppedEarly = true;
      continue;
    }

    try {
      await runScheduledJob(job);
      await markJobDone(job.id);
      result.succeeded += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const { retrying } = await markJobFailed(job, message);

      if (retrying) {
        result.retrying += 1;
      } else {
        result.failed += 1;
        await recordJobFailure(job, job.kind, message);
      }
    }
  }

  return result;
}

/**
 * The cron's entry point.
 *
 * Order is deliberate. Delayed work goes first and on a tight budget, because
 * firing it is the one thing only this cron can do — the webhook drains its own
 * arrivals, but nothing else wakes a follow-up. The reconciler runs second: it
 * calls out to Meta and can be slow, and it must not be able to starve the
 * drain. A short second drain then picks up whatever the sweep just found,
 * instead of leaving it until the next tick — a query against an empty table
 * when there is nothing to do.
 */
export async function runScheduledDrain(): Promise<
  DrainResult & { reconciled: boolean; purged: number }
> {
  const result = await drainDueJobs({ deadlineMs: 20_000 });

  let reconciled = true;
  try {
    await reconcileComments();
  } catch (error) {
    // The sweep is a safety net over the webhook, not the delivery path. A Meta
    // outage here must not take the drain's result down with it.
    reconciled = false;
    console.error(
      "[Jobs] Comment reconciliation failed:",
      error instanceof Error ? error.message : "Unknown error"
    );
  }

  const swept = await drainDueJobs({ deadlineMs: 10_000 });
  const purged = await purgeSettledJobs();

  return {
    claimed: result.claimed + swept.claimed,
    succeeded: result.succeeded + swept.succeeded,
    retrying: result.retrying + swept.retrying,
    failed: result.failed + swept.failed,
    stoppedEarly: result.stoppedEarly || swept.stoppedEarly,
    reconciled,
    purged,
  };
}
