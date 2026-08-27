import { NextRequest, NextResponse, after } from "next/server";
import { prisma } from "@/lib/db/client";
import { scheduleJob } from "@/lib/jobs/scheduler";
import { drainDueJobs } from "@/lib/jobs/drain";
import { claimWindowSlot } from "@/lib/utils/rate-limiter";
import {
  parseCommentEvents,
  parseMessageEvents,
  parsePostbackEvents,
  parseReadEvents,
  verifyWebhookSignature,
} from "@/lib/meta/webhook";
import { Prisma } from "@/app/generated/prisma/client";

// `after` runs inside the route's budget, and the drain runs inside `after`.
// Without this the callback inherits the platform default and a burst of
// comments gets cut off mid-flight; the drain keeps its own deadline below it.
export const maxDuration = 60;

const OPENING_DM_READ_FALLBACK_DELAY_MS = 5 * 60 * 1000;

// Anyone on the internet can POST here with a bad signature, so the failure
// audit trail is throttled to one row per window instead of one per request.
const SIGNATURE_FAILURE_THROTTLE_KEY = "webhook:sigfail";

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    return new NextResponse(challenge, { status: 200 });
  }

  return NextResponse.json(
    { success: false, error: "Verification failed" },
    { status: 403 }
  );
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  if (!verifyWebhookSignature(rawBody, signature)) {
    // Record the attempt so a signature mismatch is visible rather than a
    // silent 401. This is the common symptom of FACEBOOK_APP_SECRET being
    // set to the wrong app's secret for the webhook's signing key. One row
    // per window is enough to spot that; one row per request would let a
    // curl loop fill the database. The body itself is never persisted — it
    // is unverified attacker input that gets replayed into the diagnostics
    // screen.
    // The throttle counter used to be a Redis key with a TTL. On Postgres the
    // guarded upsert is still one statement and the table still cannot grow
    // past a row an hour — but unlike Redis it is a statement against the
    // database, so a sustained flood of bad signatures costs compute here where
    // it used to cost nothing. Acceptable at one cheap statement per request;
    // revisit if this endpoint ever gets found and hammered.
    let shouldRecord = false;
    try {
      shouldRecord =
        (await claimWindowSlot(SIGNATURE_FAILURE_THROTTLE_KEY, 1)) !== null;
    } catch {
      // Database unreachable: drop the audit row rather than the 401.
    }

    if (shouldRecord) {
      await prisma.operationalEvent
        .create({
          data: {
            source: "SYSTEM",
            level: "WARNING",
            message: "Webhook signature verification failed",
            payload: {
              hadSignatureHeader: Boolean(signature),
              bodyLength: rawBody.length,
            },
          },
        })
        .catch(() => {});
    }

    return NextResponse.json(
      { success: false, error: "Invalid signature" },
      { status: 401 }
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON" },
      { status: 400 }
    );
  }

  const webhookEvent = await prisma.webhookEvent.create({
    data: {
      object:
        typeof payload === "object" && payload && "object" in payload
          ? String(payload.object)
          : null,
      payload: payload as Prisma.InputJsonValue,
      status: "PENDING",
    },
  });

  try {
    const commentEvents = parseCommentEvents(
      payload as Parameters<typeof parseCommentEvents>[0]
    );

    for (const event of commentEvents) {
      const account = await prisma.instagramAccount.findUnique({
        where: { instagramId: event.instagramAccountId },
        select: { workspaceId: true },
      });

      await scheduleJob({
        kind: "COMMENT",
        key: `comment_${event.instagramAccountId}_${event.commentId}`,
        payload: {
          instagramAccountId: event.instagramAccountId,
          commentId: event.commentId,
          commentText: event.commentText,
          commenterId: event.commenterId,
          commenterName: event.commenterName,
          mediaId: event.mediaId,
          source: "WEBHOOK",
        },
      });

      if (account) {
        await prisma.webhookEvent.update({
          where: { id: webhookEvent.id },
          data: { workspaceId: account.workspaceId },
        });
      }
    }

    // Button taps from opening DMs → deliver the reveal message.
    const postbackEvents = parsePostbackEvents(
      payload as Parameters<typeof parsePostbackEvents>[0]
    );

    for (const event of postbackEvents) {
      await scheduleJob({
        kind: "POSTBACK",
        // The colon stripping is inherited from BullMQ, which forbade ":" in a
        // job id. Nothing requires it now, but the keys are load-bearing for
        // dedup and rewriting them would make every in-flight key a stranger.
        key: `postback_${event.instagramAccountId}_${event.userId}_${(
          event.mid ?? event.payload
        ).replace(/:/g, "_")}`,
        payload: {
          instagramAccountId: event.instagramAccountId,
          userId: event.userId,
          payload: event.payload,
          mid: event.mid,
        },
      });
    }

    // Inbound DMs → keyword-triggered autoreply.
    const messageEvents = parseMessageEvents(
      payload as Parameters<typeof parseMessageEvents>[0]
    );

    for (const event of messageEvents) {
      const account = await prisma.instagramAccount.findUnique({
        where: { instagramId: event.instagramAccountId },
        select: { workspaceId: true },
      });

      await scheduleJob({
        kind: "MESSAGE",
        // base64url is injective, which is the point: substituting characters
        // could let two distinct mids collapse onto one key and silently drop
        // a reply. Kept as-is now that the key is a plain unique column.
        key: `message_${event.instagramAccountId}_${Buffer.from(
          event.messageId
        ).toString("base64url")}`,
        payload: {
          instagramAccountId: event.instagramAccountId,
          messageId: event.messageId,
          messageText: event.messageText,
          senderId: event.senderId,
        },
      });

      if (account) {
        await prisma.webhookEvent.update({
          where: { id: webhookEvent.id },
          data: { workspaceId: account.workspaceId },
        });
      }
    }

    // If a user reads the opening DM and never taps the button, deliver the
    // same next-step DM after five minutes. The worker no-ops this delayed job
    // if a real button tap has already delivered the reveal.
    const readEvents = parseReadEvents(
      payload as Parameters<typeof parseReadEvents>[0]
    );

    for (const event of readEvents) {
      const openingLogs = await prisma.dmLog.findMany({
        where: {
          commenterId: event.userId,
          status: "SENT",
          automation: {
            isActive: true,
            openingDmEnabled: true,
            instagramAccount: {
              instagramId: event.instagramAccountId,
            },
          },
        },
        select: {
          automation: {
            select: {
              id: true,
            },
          },
        },
      });

      const scheduledAutomationIds = new Set<string>();
      for (const log of openingLogs) {
        const automation = log.automation;
        if (scheduledAutomationIds.has(automation.id)) continue;
        scheduledAutomationIds.add(automation.id);

        await scheduleJob({
          kind: "POSTBACK",
          key: `read_fallback_${event.instagramAccountId}_${event.userId}_${automation.id}`,
          payload: {
            instagramAccountId: event.instagramAccountId,
            userId: event.userId,
            payload: `reveal:${automation.id}`,
            fallback: true,
          },
          runAt: new Date(Date.now() + OPENING_DM_READ_FALLBACK_DELAY_MS),
        });
      }
    }

    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: {
        status: "PROCESSED",
        processedAt: new Date(),
      },
    });

    // Meta gets its 200 first — it retries anything slower, and a retry storm
    // is what turned a Redis outage into a dead webhook subscription. The work
    // runs after the response, on rows that are already committed: if this
    // invocation is cut short, the cron picks up whatever is still pending.
    after(async () => {
      try {
        await drainDueJobs();
      } catch (error) {
        console.error(
          "[Webhook] Post-response drain failed:",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: {
        status: "FAILED",
        errorMessage: message,
        processedAt: new Date(),
      },
    });

    return NextResponse.json(
      { success: false, error: "Webhook processing failed" },
      { status: 500 }
    );
  }
}
