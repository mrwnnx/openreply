import { NextRequest, NextResponse } from "next/server";
import { runScheduledDrain } from "@/lib/jobs/drain";
import { isAuthorizedCron } from "@/lib/cron-auth";

/**
 * Runs due scheduled jobs.
 *
 * This is what replaced the always-on worker. The webhook already drains what
 * it just wrote, so this exists for the two things it cannot do: fire work that
 * was scheduled for later (follow-ups, the read fallback, rate-limit requeues),
 * and pick up anything an interrupted invocation left behind.
 *
 * Driven from GitHub Actions rather than Vercel Cron: the Hobby plan only fires
 * a cron once a day, which is useless for delayed work measured in minutes.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The drain holds its own deadline below this so it stops handing out work it
// cannot finish before the platform kills the invocation.
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request.headers.get("authorization"))) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const result = await runScheduledDrain();

  return NextResponse.json({ success: true, data: result });
}
