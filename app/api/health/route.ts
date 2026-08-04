import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getDMQueue, getRedisConnection } from "@/lib/queue/client";
import { getWorkerHealth } from "@/lib/ops/worker-health";
import { isAuthorizedCron } from "@/lib/cron-auth";

export const runtime = "nodejs";
// Health must reflect live state (worker heartbeat, queue depth), never a
// cached response, or it reports stale worker start times.
export const dynamic = "force-dynamic";

type CheckStatus = "ok" | "error";

interface HealthCheck {
  status: CheckStatus;
  detail?: string;
}

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

async function checkRedis(): Promise<HealthCheck> {
  try {
    const pong = await getRedisConnection().ping();
    return { status: pong === "PONG" ? "ok" : "error", detail: pong };
  } catch (error) {
    console.error("[Health] Redis check failed:", error);
    return {
      status: "error",
      detail: error instanceof Error ? error.message : "Redis check failed",
    };
  }
}

async function checkQueue(): Promise<HealthCheck & { counts?: unknown }> {
  try {
    const counts = await getDMQueue().getJobCounts(
      "waiting",
      "active",
      "delayed",
      "failed"
    );
    return { status: "ok", counts };
  } catch (error) {
    console.error("[Health] Queue check failed:", error);
    return {
      status: "error",
      detail: error instanceof Error ? error.message : "Queue check failed",
    };
  }
}

export async function GET(request: NextRequest) {
  // Two tiers. Unauthenticated callers (uptime probes, Meta, anyone) get the
  // verdict and nothing else. The infrastructure detail — Neon and Redis error
  // strings, the worker's hostname and pid, queue depth — needs the cron
  // secret, because each of those is a free hint for someone mapping the stack.
  const verbose = isAuthorizedCron(request.headers.get("authorization"));

  const [database, redis, queue, worker] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    checkQueue(),
    getWorkerHealth().catch((error) => ({
      healthy: false,
      heartbeat: null,
      ageMs: null,
      error: error instanceof Error ? error.message : "Worker check failed",
    })),
  ]);

  const healthy =
    database.status === "ok" &&
    redis.status === "ok" &&
    queue.status === "ok" &&
    worker.healthy;

  if (!verbose) {
    return NextResponse.json(
      { status: healthy ? "ok" : "degraded" },
      { status: healthy ? 200 : 503 }
    );
  }

  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      checks: {
        database,
        redis,
        queue,
        worker,
      },
    },
    { status: healthy ? 200 : 503 }
  );
}
