# Stack

Everything OpenReply needs to run, in one place: the application libraries, the
runtime processes, and the specific (free) services this instance is deployed on.
For the step-by-step setup, see [setup.md](setup.md).

## Application

| Layer | Tool |
| --- | --- |
| Framework | Next.js 16 (App Router, Turbopack) + React 19 |
| Language | TypeScript 5 |
| ORM / DB | Prisma 7 with the `@prisma/adapter-pg` driver, PostgreSQL |
| Jobs | `ScheduledJob` rows in Postgres, drained by an HTTP endpoint |
| Auth | Auth.js / NextAuth 5 (email magic links) |
| Email | Resend (login links) |
| Validation | Zod 4 |
| Charts | Recharts 3 |
| Styling | Tailwind CSS 4 |
| Tests | Vitest 4 |
| Instagram | Official Meta Graph API (Instagram Login) |

## Runtime — one process, one datastore

- **Web app + API** (`npm run dev` / `npm start`): Next.js. Serves the dashboard,
  the OAuth callback, the incoming webhook, and the job drain. Serverless; runs
  on Vercel.
- **PostgreSQL**: campaigns, DM logs, accounts, sessions, tracked links, click
  events — and the scheduled jobs and hourly rate windows that used to live in
  Redis.

There is no worker and no queue server. Work is a `ScheduledJob` row: the
webhook writes one, answers Meta, then drains what it wrote in `after()`. A
GitHub Actions cron calls `/api/cron/drain-jobs` on an interval to fire delayed
work (follow-ups, the read fallback, rate-limit requeues) and to pick up
anything an interrupted invocation left behind.

### Why it stopped being a worker

The worker was always-on, and always-on does not fit a free tier. Idle BullMQ
cost 112 Redis commands a minute — 4.8M a month against Upstash's 500k — and the
reconciler's five-minute database poll matched Neon's scale-to-zero threshold
exactly, so the database never suspended and burned its compute quota too.
Production was down for three weeks. See `docs/incident-2026-08.md`.

The drain interval is therefore a compute budget, not a preference:
`JOB_DRAIN_INTERVAL_MINUTES` (default 30) and the schedule in
`.github/workflows/drain-jobs.yml` must be changed together.

## Reference free deployment

The zero-cost stack this instance runs on.

| Piece | Service | Free tier |
| --- | --- | --- |
| Web app | Vercel (Hobby) | Free |
| PostgreSQL | Neon | Free |
| Job cron | GitHub Actions (`drain-jobs.yml`) | Free |
| Login email | Resend | Free (3k emails/mo) |
| Instagram API | Meta app with Instagram Login | Free |

Vercel Cron is not used for the drain: the Hobby plan fires a cron once a day,
which cannot drive work scheduled minutes out.

## Environment variables

Names only — values live in `.env` (gitignored) or the host's env settings, never
in the repo. Full descriptions are in [setup.md](setup.md#environment-variables).

`NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `CRON_SECRET`, `ENCRYPTION_KEY`, `DATABASE_URL`,
`RESEND_API_KEY`, `EMAIL_FROM`, `META_GRAPH_API_VERSION`, `INSTAGRAM_APP_ID`,
`INSTAGRAM_APP_SECRET`, `FACEBOOK_APP_SECRET`, `WEBHOOK_VERIFY_TOKEN`,
`JOB_DRAIN_INTERVAL_MINUTES` (optional).
