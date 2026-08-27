import { createDMWorker } from "@/lib/queue/dm-worker";
import { recordWorkerHeartbeat } from "@/lib/ops/worker-health";
import { reconcileComments } from "@/lib/polling/comment-reconciler";
import os from "node:os";

const worker = createDMWorker();
const startedAt = new Date().toISOString();
// At 30s this beat alone cost 86,400 Redis commands a month — 17% of Upstash's
// free ceiling for a signal that does not need to be second-fresh.
const HEARTBEAT_INTERVAL_MS = 180_000;
// Polling safety net for comments that webhooks miss. Runs in the worker because
// Vercel's free crons only run once a day.
// At the previous 5 minutes it matched Neon's scale-to-zero threshold exactly,
// so the database never suspended: 0.25 CU around the clock is ~180 CU-hours a
// month against a 100 CU-hour ceiling, which is what took the database down on
// 2026-08-27. Thirty minutes lets it sleep between sweeps; the cost is that a
// comment the webhook drops waits that long instead of five minutes.
const POLL_INTERVAL_MS = Number(
  process.env.COMMENT_POLL_INTERVAL_MS ?? 30 * 60_000
);

console.log("[DM Worker] Started");

async function heartbeat() {
  try {
    await recordWorkerHeartbeat({
      pid: process.pid,
      hostname: os.hostname(),
      startedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Heartbeat failed:", message);
  }
}

void heartbeat();
const heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);

async function poll() {
  try {
    await reconcileComments();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Comment reconciliation failed:", message);
  }
}

// Kick off one sweep shortly after boot, then on a fixed interval.
setTimeout(() => void poll(), 10_000);
const pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);

async function shutdown(signal: string) {
  console.log(`[DM Worker] ${signal} received, closing worker`);
  clearInterval(heartbeatTimer);
  clearInterval(pollTimer);
  await worker.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
