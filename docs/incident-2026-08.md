# Incident — 6 to 27 August 2026

Production was down for three weeks. Two free-tier quotas were exhausted by a
worker that was doing nothing, and the architecture changed as a result.

## What happened

**6 August — Redis.** The BullMQ worker, idle, cost 112.5 Redis commands a
minute: BullMQ's default `drainDelay` of 5 seconds and `stalledInterval` of 30
seconds, plus a 30-second heartbeat. That is 4.86M commands a month against
Upstash's free ceiling of 500,000 — burned through in 3.1 days. The project
started on 3 August. The quota died on the 6th. **Instagram traffic had nothing
to do with it**; total production history at that point was 5 DMs.

**6 to 9 August — the webhook subscription.** With Redis refusing every command,
`/api/webhook` stopped returning 200. Meta retries an unacknowledged delivery
every 30 seconds, so 600 webhooks a day became 15,000 a day — 37,606 in total.
On 9 August at 03:00 Meta gave up and stopped delivering. Nothing arrived after
that.

**6 to 27 August — the database.** `worker.on("error")` wrote one
`OperationalEvent` row per error, with no ceiling and no deduplication. ioredis
emits one error per refused command. That produced **1,251,002 rows and 448 MB**
in three days, on a database capped at 500 MB. The rows were purged on 17 August
(490 MB down to 43 MB) but the handler was not fixed, so the flood resumed
immediately.

Meanwhile the comment reconciler polled the database every 5 minutes — exactly
Neon's scale-to-zero threshold — so the endpoint never suspended. A quarter of a
compute unit running around the clock is roughly 180 compute-hours a month
against a ceiling well below that. On 27 August Postgres started refusing every
query with `53000: compute time quota exceeded`.

At that point both datastores were dead and the worker was still running,
looping through refused Redis commands and failed inserts several times a
second, 21 days in.

## Why it could not just be tuned

The settings were tuned first: `drainDelay: 300`, `stalledInterval: 600000`, a
180-second heartbeat. That took idle cost from 112.5 to 2.9 commands a minute,
a 97% reduction, with no added latency — a job wakes the worker through its
marker rather than the blocking read, measured at 6 ms.

It was not enough. BullMQ costs **41.3 Redis commands per job** in transport
alone, so even at zero idle cost the free tier carries about 9,000 jobs a month.
An always-on worker does not fit a free tier, and the database being permanently
awake was a separate ceiling with the same shape.

## What changed

The worker, BullMQ, ioredis and Redis were removed entirely.

- Work is a `ScheduledJob` row. Writing it is the durability guarantee.
- The webhook writes rows, answers Meta, and drains them in Next's `after()`.
  Meta gets its 200 first, which is what prevents a retry storm from ever
  turning into a dead subscription again.
- Delayed work — follow-ups, the read fallback, rate-limit requeues — waits in
  the table until a GitHub Actions cron calls `/api/cron/drain-jobs`. Vercel Cron
  is not used: the Hobby plan fires once a day.
- The hourly rate limiter and the per-person reveal cap became `RateWindow` rows
  claimed with a single conditional upsert.
- Health stopped being a worker heartbeat and became a backlog measurement: jobs
  overdue by several drain intervals mean the cron is not firing. It measures
  the outcome instead of the liveness of a process.
- One `OperationalEvent` row per job that has exhausted its attempts, never one
  per error.

## What to carry forward

- **An idle background process is not free.** Measure it at rest, not under
  load. The method: run the broker locally, `CONFIG RESETSTAT`, leave it alone,
  read `INFO commandstats`. The window has to span several `drainDelay`s or the
  startup cost dominates the average.
- **Any unbounded write in an error handler is a loaded gun.** Errors arrive at
  the rate of the failure, not the rate of the traffic.
- **A poll interval that matches a scale-to-zero threshold means it never
  scales to zero.** The drain interval here is a compute budget, which is why
  `JOB_DRAIN_INTERVAL_MINUTES` and the workflow schedule are documented as
  having to change together.
- **`DmLog.automation` cascades on delete.** Deleting a campaign destroys its
  entire send history. Real users tapped buttons on 7 August and no record of
  what was delivered survives.
