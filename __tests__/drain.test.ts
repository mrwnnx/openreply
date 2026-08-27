/**
 * Drain — Unit Tests
 *
 * The drain decides what a failure means: try again later, or give up and
 * leave a trace. That decision is what BullMQ used to own, so it is the part
 * of the replacement worth pinning down.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockReconcileComments,
  mockClaimDueJobs,
  mockMarkJobDone,
  mockMarkJobFailed,
  mockPurgeSettledJobs,
  mockRunScheduledJob,
  mockRecordJobFailure,
} = vi.hoisted(() => ({
  mockReconcileComments: vi.fn(),
  mockClaimDueJobs: vi.fn(),
  mockMarkJobDone: vi.fn(),
  mockMarkJobFailed: vi.fn(),
  mockPurgeSettledJobs: vi.fn(),
  mockRunScheduledJob: vi.fn(),
  mockRecordJobFailure: vi.fn(),
}));

vi.mock("@/lib/jobs/scheduler", () => ({
  claimDueJobs: mockClaimDueJobs,
  markJobDone: mockMarkJobDone,
  markJobFailed: mockMarkJobFailed,
  purgeSettledJobs: mockPurgeSettledJobs,
}));

vi.mock("@/lib/jobs/handlers", () => ({
  runScheduledJob: mockRunScheduledJob,
  recordJobFailure: mockRecordJobFailure,
}));

vi.mock("@/lib/polling/comment-reconciler", () => ({
  reconcileComments: mockReconcileComments,
}));

import { drainDueJobs, runScheduledDrain } from "../lib/jobs/drain";

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: "job_1",
    key: "comment_ig_1_c_1",
    kind: "COMMENT",
    payload: { instagramAccountId: "ig_1", commentId: "c_1" },
    runAt: new Date(),
    attempts: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMarkJobFailed.mockResolvedValue({ retrying: true });
  mockPurgeSettledJobs.mockResolvedValue(0);
  mockReconcileComments.mockResolvedValue(undefined);
});

describe("drainDueJobs", () => {
  it("marks a job done when it runs cleanly", async () => {
    mockClaimDueJobs.mockResolvedValue([job()]);
    mockRunScheduledJob.mockResolvedValue(undefined);

    const result = await drainDueJobs();

    expect(mockMarkJobDone).toHaveBeenCalledWith("job_1");
    expect(result).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
  });

  it("hands a failing job back for a retry without recording a failure", async () => {
    mockClaimDueJobs.mockResolvedValue([job()]);
    mockRunScheduledJob.mockRejectedValue(new Error("Meta is down"));
    mockMarkJobFailed.mockResolvedValue({ retrying: true });

    const result = await drainDueJobs();

    expect(mockMarkJobFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job_1" }),
      "Meta is down"
    );
    // A job that will be tried again is not an incident yet — recording one per
    // attempt is how the old handler wrote a million rows during an outage.
    expect(mockRecordJobFailure).not.toHaveBeenCalled();
    expect(result).toMatchObject({ retrying: 1, failed: 0 });
  });

  it("records a failure once the job has given up", async () => {
    mockClaimDueJobs.mockResolvedValue([job({ attempts: 3 })]);
    mockRunScheduledJob.mockRejectedValue(new Error("Meta is down"));
    mockMarkJobFailed.mockResolvedValue({ retrying: false });

    const result = await drainDueJobs();

    expect(mockRecordJobFailure).toHaveBeenCalledTimes(1);
    expect(mockRecordJobFailure).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job_1" }),
      "COMMENT",
      "Meta is down"
    );
    expect(result).toMatchObject({ retrying: 0, failed: 1 });
  });

  it("keeps going after one job fails", async () => {
    mockClaimDueJobs.mockResolvedValue([
      job({ id: "job_1" }),
      job({ id: "job_2" }),
    ]);
    mockRunScheduledJob
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);

    const result = await drainDueJobs();

    expect(mockRunScheduledJob).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ claimed: 2, succeeded: 1, retrying: 1 });
  });

  it("hands back work it cannot finish instead of starting it", async () => {
    mockClaimDueJobs.mockResolvedValue([
      job({ id: "job_1" }),
      job({ id: "job_2" }),
    ]);
    // A deadline already in the past: the invocation has no budget left, so
    // nothing should be started. Starting a job that gets killed mid-flight
    // leaves its claim behind and blocks it for the whole claim timeout.
    const result = await drainDueJobs({ deadlineMs: -1 });

    expect(mockRunScheduledJob).not.toHaveBeenCalled();
    expect(mockMarkJobFailed).toHaveBeenCalledTimes(2);
    expect(result.stoppedEarly).toBe(true);
    expect(result.succeeded).toBe(0);
  });

  it("reports nothing to do on an empty queue", async () => {
    mockClaimDueJobs.mockResolvedValue([]);

    const result = await drainDueJobs();

    expect(result).toMatchObject({
      claimed: 0,
      succeeded: 0,
      retrying: 0,
      failed: 0,
      stoppedEarly: false,
    });
  });
});

describe("runScheduledDrain", () => {
  it("purges settled rows after draining", async () => {
    mockClaimDueJobs.mockResolvedValue([]);
    mockPurgeSettledJobs.mockResolvedValue(7);

    const result = await runScheduledDrain();

    expect(mockPurgeSettledJobs).toHaveBeenCalledTimes(1);
    expect(result.purged).toBe(7);
  });

  it("runs the comment sweep — deleting the worker orphaned its only caller", async () => {
    mockClaimDueJobs.mockResolvedValue([]);

    const result = await runScheduledDrain();

    expect(mockReconcileComments).toHaveBeenCalledTimes(1);
    expect(result.reconciled).toBe(true);
  });

  it("drains again after the sweep so found comments do not wait a full tick", async () => {
    mockClaimDueJobs.mockResolvedValue([]);

    await runScheduledDrain();

    expect(mockClaimDueJobs).toHaveBeenCalledTimes(2);
  });

  it("survives a failing sweep without losing the drain", async () => {
    mockClaimDueJobs.mockResolvedValue([job()]);
    mockRunScheduledJob.mockResolvedValue(undefined);
    mockReconcileComments.mockRejectedValue(new Error("Meta is down"));

    const result = await runScheduledDrain();

    expect(result.reconciled).toBe(false);
    expect(result.succeeded).toBeGreaterThan(0);
  });
});
