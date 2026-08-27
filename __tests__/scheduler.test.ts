/**
 * Scheduler — Unit Tests
 *
 * Two properties carry the design: scheduling the same key twice must not
 * duplicate work, and a failed job must back off on the same widening curve
 * BullMQ used before giving up.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockUpsert, mockUpdate } = vi.hoisted(() => ({
  mockUpsert: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    scheduledJob: {
      upsert: mockUpsert,
      update: mockUpdate,
    },
  },
}));

import {
  scheduleJob,
  markJobFailed,
  BACKOFF_DELAYS_MS,
  MAX_ATTEMPTS,
} from "../lib/jobs/scheduler";

function job(attempts: number) {
  return {
    id: "job_1",
    key: "followup_auto_1_user_1",
    kind: "FOLLOWUP" as const,
    payload: {},
    runAt: new Date(),
    attempts,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("scheduleJob", () => {
  it("never overwrites an existing key", async () => {
    await scheduleJob({
      key: "comment_ig_1_c_1",
      kind: "COMMENT",
      payload: { commentId: "c_1" },
    });

    // An empty update is the whole dedup guarantee: Meta redelivering a webhook
    // must not reset a job that already ran, or move its scheduled time.
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: "comment_ig_1_c_1" },
        update: {},
      })
    );
  });

  it("defaults to running as soon as possible", async () => {
    const before = Date.now();
    await scheduleJob({ key: "k", kind: "COMMENT", payload: {} });

    const runAt = mockUpsert.mock.calls[0][0].create.runAt as Date;
    expect(runAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(runAt.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe("markJobFailed", () => {
  it("backs off further on each successive attempt", async () => {
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      mockUpdate.mockClear();
      const before = Date.now();

      const result = await markJobFailed(job(attempt), "Meta is down");

      expect(result.retrying).toBe(true);
      const data = mockUpdate.mock.calls[0][0].data;
      expect(data.status).toBeUndefined();
      const delay = (data.runAt as Date).getTime() - before;
      expect(delay).toBeGreaterThanOrEqual(BACKOFF_DELAYS_MS[attempt - 1]);
      expect(delay).toBeLessThan(BACKOFF_DELAYS_MS[attempt - 1] + 1_000);
    }
  });

  it("gives up once the attempts are spent", async () => {
    const result = await markJobFailed(job(MAX_ATTEMPTS), "Meta is down");

    expect(result.retrying).toBe(false);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          claimedAt: null,
          lastError: "Meta is down",
        }),
      })
    );
  });

  it("releases the claim so a retry is actually reachable", async () => {
    await markJobFailed(job(1), "Meta is down");

    expect(mockUpdate.mock.calls[0][0].data.claimedAt).toBeNull();
  });
});
