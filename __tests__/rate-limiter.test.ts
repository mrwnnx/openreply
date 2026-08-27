/**
 * Rate Limiter — Unit Tests
 *
 * Tests the hourly private-reply cap enforcement against a mocked Prisma
 * client. Assertions derive from RATE_LIMIT_MAX so they survive a change to
 * the cap.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockQueryRaw, mockFindUnique, mockDeleteMany } = vi.hoisted(() => ({
  mockQueryRaw: vi.fn(),
  mockFindUnique: vi.fn(),
  mockDeleteMany: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    $queryRaw: mockQueryRaw,
    rateWindow: {
      findUnique: mockFindUnique,
      deleteMany: mockDeleteMany,
    },
  },
}));

import {
  checkRateLimit,
  currentWindowStart,
  incrementDMCounter,
  reserveDMSlot,
  RATE_LIMIT_MAX,
} from "../lib/utils/rate-limiter";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("currentWindowStart", () => {
  it("truncates to the top of the hour", () => {
    const start = currentWindowStart(new Date("2026-08-27T14:37:59.999Z"));

    expect(start.toISOString()).toBe("2026-08-27T14:00:00.000Z");
  });

  it("puts two moments in the same hour in the same window", () => {
    const a = currentWindowStart(new Date("2026-08-27T14:00:00.000Z"));
    const b = currentWindowStart(new Date("2026-08-27T14:59:59.000Z"));

    expect(a.getTime()).toBe(b.getTime());
  });
});

describe("checkRateLimit", () => {
  it("should allow when count is below limit", async () => {
    mockFindUnique.mockResolvedValue({ count: 50 });

    const result = await checkRateLimit("account_123");

    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(50);
    expect(result.remainingDMs).toBe(RATE_LIMIT_MAX - 50);
    expect(result.shouldRequeue).toBe(false);
    expect(result.shouldSkip).toBe(false);
    expect(result.reserved).toBe(false);
  });

  it("should allow when no window row exists yet", async () => {
    mockFindUnique.mockResolvedValue(null);

    const result = await checkRateLimit("account_123");

    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(0);
    expect(result.remainingDMs).toBe(RATE_LIMIT_MAX);
  });

  it("should not claim a slot — it only reads", async () => {
    mockFindUnique.mockResolvedValue({ count: 50 });

    await checkRateLimit("account_123");

    expect(mockQueryRaw).not.toHaveBeenCalled();
  });

  it("should deny when count reaches the limit", async () => {
    mockFindUnique.mockResolvedValue({ count: RATE_LIMIT_MAX });

    const result = await checkRateLimit("account_123");

    expect(result.allowed).toBe(false);
    expect(result.shouldRequeue).toBe(true);
    expect(result.shouldSkip).toBe(false);
  });

  it("should skip after max requeue attempts", async () => {
    mockFindUnique.mockResolvedValue({ count: RATE_LIMIT_MAX });

    const result = await checkRateLimit("account_123", 3);

    expect(result.allowed).toBe(false);
    expect(result.shouldRequeue).toBe(false);
    expect(result.shouldSkip).toBe(true);
  });
});

describe("reserveDMSlot", () => {
  it("should reserve a slot when below the hourly cap", async () => {
    mockQueryRaw.mockResolvedValue([{ count: 51 }]);

    const result = await reserveDMSlot("account_123");

    expect(result.allowed).toBe(true);
    expect(result.reserved).toBe(true);
    expect(result.currentCount).toBe(51);
    expect(result.remainingDMs).toBe(RATE_LIMIT_MAX - 51);
  });

  it("should recommend requeue when the conditional insert returns nothing", async () => {
    // An empty result set is how a full window reports itself: the ON CONFLICT
    // update is guarded by the ceiling, so it simply does not fire.
    mockQueryRaw.mockResolvedValue([]);
    mockFindUnique.mockResolvedValue({ count: RATE_LIMIT_MAX });

    const result = await reserveDMSlot("account_123", 0);

    expect(result.allowed).toBe(false);
    expect(result.reserved).toBe(false);
    expect(result.shouldRequeue).toBe(true);
    expect(result.shouldSkip).toBe(false);
    expect(result.currentCount).toBe(RATE_LIMIT_MAX);
  });

  it("should skip after max requeue attempts", async () => {
    mockQueryRaw.mockResolvedValue([]);
    mockFindUnique.mockResolvedValue({ count: RATE_LIMIT_MAX });

    const result = await reserveDMSlot("account_123", 3);

    expect(result.allowed).toBe(false);
    expect(result.shouldRequeue).toBe(false);
    expect(result.shouldSkip).toBe(true);
  });

  it("should treat a count of exactly 1 as the first send of the window", async () => {
    mockQueryRaw.mockResolvedValue([{ count: 1 }]);

    const result = await reserveDMSlot("account_123");

    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(1);
    expect(result.remainingDMs).toBe(RATE_LIMIT_MAX - 1);
  });
});

describe("incrementDMCounter", () => {
  it("should use the reservation path", async () => {
    mockQueryRaw.mockResolvedValue([{ count: 51 }]);

    const count = await incrementDMCounter("account_123");

    expect(mockQueryRaw).toHaveBeenCalled();
    expect(count).toBe(51);
  });
});
