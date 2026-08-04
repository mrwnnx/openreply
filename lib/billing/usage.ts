import { prisma } from "@/lib/db/client";
import type { Prisma } from "@/app/generated/prisma/client";

// Monthly DM ceiling per workspace, from MONTHLY_DM_LIMIT.
//
// This used to be pinned at two billion, which counted usage for the dashboard
// but enforced nothing — leaving Meta's own limits as the only brake, i.e. the
// account getting restricted was the feedback mechanism. The default below is a
// deliberate backstop, not a billing tier.
//
// Must stay within PostgreSQL int4 range, since dmsSentThisPeriod is an Int
// column and this value is used in a `less-than` comparison against it.
const DEFAULT_MONTHLY_DM_LIMIT = 10_000;
const MAX_MONTHLY_DM_LIMIT = 2_000_000_000;

function getMonthlyDMLimit(): number {
  const raw = process.env.MONTHLY_DM_LIMIT;
  if (!raw) return DEFAULT_MONTHLY_DM_LIMIT;

  // A malformed value falls back to the default rather than to zero, which
  // would silently stop every campaign.
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MONTHLY_DM_LIMIT;

  return Math.min(parsed, MAX_MONTHLY_DM_LIMIT);
}

function getMonthStart(date = new Date()): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

async function resetUsageIfNeededTx(
  tx: Prisma.TransactionClient,
  workspaceId: string
): Promise<void> {
  const now = new Date();
  const monthStart = getMonthStart(now);

  await tx.workspace.updateMany({
    where: {
      id: workspaceId,
      usagePeriodStart: { lt: monthStart },
    },
    data: {
      usagePeriodStart: monthStart,
      dmsSentThisPeriod: 0,
    },
  });
}

export async function resetUsageIfNeeded(workspaceId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await resetUsageIfNeededTx(tx, workspaceId);
  });
}

export interface WorkspaceDMReservation {
  allowed: boolean;
  reserved: boolean;
  remaining: number;
  limit: number;
  periodStart: Date | null;
}

export async function reserveWorkspaceDMSend(
  workspaceId: string
): Promise<WorkspaceDMReservation> {
  return prisma.$transaction(async (tx) => {
    await resetUsageIfNeededTx(tx, workspaceId);

    const monthStart = getMonthStart();
    const workspace = await tx.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        usagePeriodStart: true,
        dmsSentThisPeriod: true,
      },
    });

    if (!workspace) {
      return {
        allowed: false,
        reserved: false,
        remaining: 0,
        limit: 0,
        periodStart: null,
      };
    }

    const limit = getMonthlyDMLimit();

    if (workspace.dmsSentThisPeriod >= limit) {
      return {
        allowed: false,
        reserved: false,
        remaining: 0,
        limit,
        periodStart: workspace.usagePeriodStart,
      };
    }

    const reserved = await tx.workspace.updateMany({
      where: {
        id: workspaceId,
        usagePeriodStart: { gte: monthStart },
        dmsSentThisPeriod: { lt: limit },
      },
      data: {
        dmsSentThisPeriod: { increment: 1 },
      },
    });

    if (reserved.count === 0) {
      const current = await tx.workspace.findUnique({
        where: { id: workspaceId },
        select: { dmsSentThisPeriod: true, usagePeriodStart: true },
      });

      return {
        allowed: false,
        reserved: false,
        remaining: Math.max(0, limit - (current?.dmsSentThisPeriod ?? limit)),
        limit,
        periodStart: current?.usagePeriodStart ?? workspace.usagePeriodStart,
      };
    }

    return {
      allowed: true,
      reserved: true,
      remaining: Math.max(0, limit - workspace.dmsSentThisPeriod - 1),
      limit,
      periodStart: workspace.usagePeriodStart,
    };
  });
}

export async function canSendDMForWorkspace(workspaceId: string): Promise<{
  allowed: boolean;
  remaining: number;
  limit: number;
}> {
  await resetUsageIfNeeded(workspaceId);

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      dmsSentThisPeriod: true,
    },
  });

  if (!workspace) {
    return { allowed: false, remaining: 0, limit: 0 };
  }

  const limit = getMonthlyDMLimit();
  const remaining = Math.max(0, limit - workspace.dmsSentThisPeriod);

  return {
    allowed: workspace.dmsSentThisPeriod < limit,
    remaining,
    limit,
  };
}

export async function releaseWorkspaceDMReservation(
  workspaceId: string,
  periodStart: Date | null
) {
  if (!periodStart) {
    return { count: 0 };
  }

  return prisma.workspace.updateMany({
    where: {
      id: workspaceId,
      usagePeriodStart: periodStart,
      dmsSentThisPeriod: { gt: 0 },
    },
    data: { dmsSentThisPeriod: { decrement: 1 } },
  });
}

export async function incrementWorkspaceDMUsage(workspaceId: string) {
  return reserveWorkspaceDMSend(workspaceId);
}
