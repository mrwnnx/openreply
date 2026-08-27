import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { countOverdueJobs } from "@/lib/jobs/scheduler";
import { DRAIN_INTERVAL_MS } from "@/lib/jobs/config";
import { isAuthorizedCron } from "@/lib/cron-auth";

export const runtime = "nodejs";
// Health must reflect live state (job backlog), never a cached response.
export const dynamic = "force-dynamic";

type CheckStatus = "ok" | "error";

interface HealthCheck {
  status: CheckStatus;
  detail?: string;
}

// Jobs run late by design — the cron only fires every interval. Something is
// wrong when they are late by several intervals, which is what a cron that has
// stopped firing looks like. This replaced the worker's Redis heartbeat: it
// measures the outcome (work is moving) rather than the liveness of a process.
const BACKLOG_TOLERANCE_MS = DRAIN_INTERVAL_MS * 3;

async function checkDatabase(): Promise<HealthCheck> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: "ok" };
  } catch (error) {
    // Logged, not returned: a Prisma connection error spells out the full Neon
    // host. It reaches the response only on the authenticated path below.
    console.error("[Health] Database check failed:", error);
    return {
      status: "error",
      detail: error instanceof Error ? error.message : "Database check failed",
    };
  }
}

async function checkJobs(): Promise<HealthCheck & { overdue?: number }> {
  try {
    const overdue = await countOverdueJobs(BACKLOG_TOLERANCE_MS);
    return {
      status: overdue === 0 ? "ok" : "error",
      overdue,
      detail:
        overdue === 0
          ? undefined
          : `${overdue} job(s) more than ${Math.round(
              BACKLOG_TOLERANCE_MS / 60_000
            )} minutes overdue — is the drain cron firing?`,
    };
  } catch (error) {
    console.error("[Health] Job backlog check failed:", error);
    return {
      status: "error",
      detail: error instanceof Error ? error.message : "Job check failed",
    };
  }
}

export async function GET(request: NextRequest) {
  // Two tiers. Unauthenticated callers (uptime probes, Meta, anyone) get the
  // verdict and nothing else. The infrastructure detail — Neon error strings,
  // backlog depth — needs the cron secret, because each of those is a free hint
  // for someone mapping the stack.
  const verbose = isAuthorizedCron(request.headers.get("authorization"));

  const [database, jobs] = await Promise.all([checkDatabase(), checkJobs()]);

  const healthy = database.status === "ok" && jobs.status === "ok";

  if (!verbose) {
    return NextResponse.json(
      { status: healthy ? "ok" : "degraded" },
      { status: healthy ? 200 : 503 }
    );
  }

  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      checks: { database, jobs },
    },
    { status: healthy ? 200 : 503 }
  );
}
