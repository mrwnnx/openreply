# Setup

Everything you need to get OpenReply running end to end, in one place: hosting, the domain, environment variables, and the Meta app. Read it in order. The code deploys in minutes. The Meta side is the part that takes real time, so budget an afternoon the first time.

If you would rather have an AI assistant drive most of this, skip to [Set it up with an AI assistant](#set-it-up-with-an-ai-assistant) at the end and come back here when it asks for specifics.

## How it is built

OpenReply is one process and one datastore.

- Web app and API: Next.js on Vercel. Serves the dashboard, the OAuth callback, the incoming webhook, and the job drain.
- PostgreSQL: campaigns, logs, accounts, sessions — and the job queue itself.

Work is a row in `ScheduledJob`. The webhook writes rows, answers Meta immediately, then drains what it just wrote in Next's `after()`. A GitHub Actions cron calls `/api/cron/drain-jobs` every 30 minutes to fire work that was scheduled for later (follow-ups, the read fallback, rate-limit requeues) and to pick up anything an interrupted invocation left behind.

There used to be an always-on worker with Redis and BullMQ. It was removed after it took production down for three weeks: idle, it cost 9.7x the free Redis quota, and its five-minute database poll stopped Postgres from ever suspending. `docs/incident-2026-08.md` has the numbers.

## What you need first

- A Facebook account. Meta developer registration is built on it. There is no Instagram-only path.
- An Instagram Business or Creator account. A personal account cannot be connected. Switch it in the Instagram app under Settings, Account type, if needed.
- A [Resend](https://resend.com) account for login emails, with a verified sender domain. Login is email magic links only, so without this nobody can sign in.
- Somewhere to host. The setup used throughout this guide is Vercel for the app and any managed Postgres (Neon, Supabase, Railway — anything with a connection string). Free tiers are enough to run this for a single account.
- A GitHub account. The job drain runs as a scheduled GitHub Action, which is free.

## Hosting and your domain

You do not need to buy a domain. Deploying the web app to Vercel gives you a free public URL like `your-app.vercel.app`, and that URL is what everything else points at: `NEXTAUTH_URL`, the Meta OAuth redirect, and the Meta webhook callback all use it. If you want a custom domain later you can add one, but it is optional and you can launch without it.

Do the database first, because Vercel needs its URL.

### Step 1: Postgres

Any managed Postgres works. Two that have a usable free tier:

- **Neon** — create a project and copy its connection string. Note that a free-tier endpoint suspends after five idle minutes; that is deliberate here and the drain interval is set to let it happen.
- **Railway** — New Project, then New, then Database, then Add PostgreSQL. Open the service's Variables tab and use `DATABASE_PUBLIC_URL` (`*.proxy.rlwy.net`), not `DATABASE_URL` (`postgres.railway.internal`). Vercel runs outside Railway's private network and an internal host will simply hang.

If your provider offers a pooled and a direct URL, set both: `DATABASE_URL` for the pooled one and `DATABASE_URL_UNPOOLED` for the direct one. Migrations take a session-level advisory lock, which a transaction pooler cannot hold — `prisma.config.ts` points the CLI at the unpooled URL for exactly this reason, while the app keeps the pooled one.

### Step 2: Migrate the production database

Run once from your machine, using the direct (unpooled) Postgres URL:

```bash
DATABASE_URL="postgresql://..." npm run db:migrate
```

### Step 3: Vercel (web app, and your domain)

1. Create a Vercel account and Add New Project, importing your fork. It auto-detects Next.js.
2. Under the project's Settings, then Environment Variables, add every variable from the [table below](#environment-variables). Use these values:
   - `NEXTAUTH_URL`: your Vercel domain, for example `https://your-app.vercel.app`. This is the free domain Vercel assigns on deploy.
   - `DATABASE_URL`: your Postgres connection string.
   - `ENCRYPTION_KEY`: generate it once and never change it — it encrypts the stored Instagram tokens, and a different key means every send fails to decrypt.
3. Deploy. The build runs `prisma generate` before `next build`, so the Prisma client is generated even though it is gitignored.
4. The daily crons are wired up in `vercel.json`.

### Step 3b: Enable the job drain

The drain is a GitHub Action, not a Vercel Cron, because Vercel's free plan fires a cron at most once a day and delayed work here is measured in minutes.

In your fork, under Settings, then Secrets and variables, then Actions, add two repository secrets:

| Secret | Value |
| --- | --- |
| `APP_URL` | your deployed URL, e.g. `https://your-app.vercel.app`, no trailing slash |
| `CRON_SECRET` | the same value you set on Vercel |

The workflow is `.github/workflows/drain-jobs.yml` and runs every 30 minutes. You can trigger it by hand from the Actions tab to check it works — a healthy run prints a JSON body with the counts.

Do not shorten the interval without checking your database's compute budget. Thirty minutes is chosen so a Neon free-tier endpoint still suspends between runs; a five-minute cron keeps it awake around the clock. If you do change it, change `JOB_DRAIN_INTERVAL_MINUTES` on Vercel to match, or the health check's idea of "overdue" drifts.

Optional custom domain: if you want `openreply.yoursite.com` instead of the Vercel URL, add it in Vercel under Domains and make it primary. Then update `NEXTAUTH_URL`, the `APP_URL` secret, and the two Meta URLs (Step 7 and Step 8 below) to the new domain, or tracked links in DMs will point at the old domain.

## Environment variables

Copy `.env.example` to `.env` for local work, or set these in Vercel for hosting.

| Variable | What it is |
| --- | --- |
| `NEXTAUTH_URL` | Your public URL. Your Vercel domain in production, your tunnel URL locally. |
| `NEXTAUTH_SECRET` | Random secret. `openssl rand -base64 32` |
| `CRON_SECRET` | Random secret protecting the token-refresh cron. |
| `ENCRYPTION_KEY` | 32-byte hex. `openssl rand -hex 32`. Encrypts Instagram tokens. Never change it once tokens are stored. |
| `DATABASE_URL` | PostgreSQL connection string. The pooled one if your provider has two. |
| `DATABASE_URL_UNPOOLED` | Optional. The direct connection, used by the Prisma CLI for migrations — a transaction pooler cannot hold the advisory lock they take. |
| `RESEND_API_KEY` | Resend key. Login is email magic links only, so without this nobody can sign in. |
| `EMAIL_FROM` | A sender on a domain you verified in Resend. The placeholder will not deliver. |
| `META_GRAPH_API_VERSION` | Graph API version, for example `v25.0`. |
| `INSTAGRAM_APP_ID` | From the Meta app, see Step 6. |
| `INSTAGRAM_APP_SECRET` | From the Meta app. |
| `FACEBOOK_APP_SECRET` | From the Meta app. |
| `WEBHOOK_VERIFY_TOKEN` | Any random string. You paste the same value into Meta's webhook config. |

`ENCRYPTION_KEY` must be exactly 64 hex characters or the app throws on boot.

Optional (defaults are fine to start):

| Variable | Default | What it does |
| --- | --- | --- |
| `JOB_DRAIN_INTERVAL_MINUTES` | `30` | How often you have scheduled the drain workflow. Only used to judge whether jobs are overdue — it does not change the schedule, which lives in the workflow file. |
| `COMMENT_POLL_MAX_PER_SWEEP` | `30` | Max new comments each campaign acts on per sweep. Keep it conservative; higher gets closer to Instagram's rate limits. |
| `COMMENT_POLL_LOOKBACK_HOURS` | `72` | How far back a sweep considers comments. |

The comment sweep runs inside the drain cron, so its frequency is the drain's frequency.

## The Meta app

This is the slow part. The code works out of the box; getting Meta to send you comment events is where people lose an afternoon. Every step here exists because skipping it breaks something later. Have your Vercel domain from Step 3 ready, you will paste it in a few times.

### Step 4: Create the Meta app

Go to [developers.facebook.com/apps](https://developers.facebook.com/apps) and create an app.

- App type: Business.
- Contact email: one you actually check.

When it asks you to add a use case, filter to All, then choose Manage messaging and content on Instagram. Do not pick "Create and manage ads with Marketing API", and do not pick "Authenticate with Facebook Login". OpenReply uses Instagram Login. Picking the Facebook Login variant makes the OAuth flow fail later with a mismatched client error.

If you accidentally added the Marketing API use case, remove it. It has its own heavy review requirements and can block publishing.

### Step 5: Collect the three secrets

There are two app secrets and two app IDs, which is confusing. Here is what maps to what.

| Environment variable | Where it lives |
| --- | --- |
| `INSTAGRAM_APP_ID` | Instagram, API setup with Instagram login. A number like `2036...` |
| `INSTAGRAM_APP_SECRET` | Same page, click Show |
| `FACEBOOK_APP_SECRET` | App settings, Basic, App secret, click Show |

The Instagram app ID is not the same number as the Facebook App ID shown on the Basic settings page. Use the one under the Instagram product.

OpenReply verifies webhook signatures against both `FACEBOOK_APP_SECRET` and `INSTAGRAM_APP_SECRET`, so you do not have to guess which one Meta signs with. Set both.

### Step 6: Add your Instagram account as a tester, and accept the invite

This is the step people miss, and it produces the error "Insufficient Developer Role" on the Instagram login screen. In development, only accounts that have a role on your app can connect. Even your own account has to be added and accept.

There are two halves. Both are required.

Half one, on the Meta side. In the app dashboard, open App roles, then Roles (in the newer console this is also reachable from the Instagram product under "Generate access tokens"). Find the section for Instagram testers, click add, and enter the exact Instagram username of the account you want to connect. Send the invite.

Half two, on the Instagram side. This is the part that gets skipped. Open Instagram as that account (the phone app is easiest):

1. Go to your profile, then the menu, then Settings and activity.
2. Open Apps and websites (older versions: Website permissions, then Apps and websites).
3. Open Tester invites.
4. Accept the invite from your app.

Until you accept here, the account is not really a tester and the login will keep failing. If you do not see the invite, double-check you sent it to the exact username and that the account is a Business or Creator account.

### Step 7: Register the OAuth redirect

In the Instagram product, open Set up Instagram business login, then Business login settings. In the OAuth redirect URIs field, add exactly, using your Vercel domain:

```
https://your-app.vercel.app/api/instagram/callback
```

No trailing slash. If this is missing or wrong, connecting an account fails with a redirect_uri mismatch. You can register more than one, which is useful if you change domains later; keep the old and new both listed.

You do not need the "Embed URL" that Meta shows here. OpenReply builds its own login URL. Users connect by opening your app, going to Settings, and clicking Connect Instagram.

### Step 8: Configure the webhook

Still in the Instagram product, find the Configure webhooks step.

- Callback URL: `https://your-app.vercel.app/api/webhook`
- Verify token: the value of `WEBHOOK_VERIFY_TOKEN` from your environment
- Click Verify and save. It should succeed immediately, because the app answers Meta's verification challenge. If the button is greyed out, click into the verify-token field and paste the token again; editing the callback URL often clears it.
- Subscribe to the `comments` field.

To test delivery without a real comment, click Test next to `comments`, then click Send to My Server. This is a two-step control. Clicking Test only previews the sample payload; the second button is what actually POSTs it to your endpoint. After sending, a row should appear in your `WebhookEvent` table.

If your primary domain ever changes, update this callback URL to the new domain. A non-primary domain will 307-redirect the POST, and Meta does not reliably follow redirects, so webhooks silently stop.

### Step 9: Publish the app

Real comment webhooks are only delivered when the app is in Live state. In Development mode, only the console Test button delivers events. This is the single most common reason for "I set everything up and nothing happens."

Go to the Publish item in the left sidebar. Set the privacy policy, terms of service, and data deletion URLs first, or it will not let you publish. OpenReply ships these pages, on your Vercel domain:

```
https://your-app.vercel.app/privacy
https://your-app.vercel.app/data-deletion
https://your-app.vercel.app/terms
```

Then publish. Depending on your access level, Meta may let you go live for your own tester accounts immediately, or it may require App Review first (see the last section).

### The account ID trap (informational)

You do not have to do anything here; OpenReply handles it. It is worth understanding because it is invisible when it goes wrong.

Meta's `/me` returns two IDs. The `id` field is app-scoped. The `user_id` field is the Instagram professional account ID. Webhooks put `user_id` in `entry.id`, and the messaging API keys off `user_id` too. OpenReply stores `user_id`, so a fresh connection matches correctly. If you upgraded from a very old build and an account was stored with the wrong ID, disconnect and reconnect it once.

## Test it end to end

1. Make sure the account is a tester and has accepted the invite (Step 6), and the app is published (Step 9).
2. Connect it in the app: Settings, Connect Instagram. You should reach Instagram's consent screen, not the "Insufficient Developer Role" error.
3. Create a campaign on one of your posts with a keyword like `TEST`.
4. From a different Instagram account, comment `TEST` on that post. It must be a different account, because OpenReply ignores your own comments on purpose.
5. Watch for the DM. If nothing arrives, check the DM Logs page and `/api/health`.

Hit `/api/health` any time. Unauthenticated it returns the verdict alone; with `Authorization: Bearer $CRON_SECRET` it also reports the database and the job backlog. A backlog means jobs are due and nothing is running them — check that the drain workflow is enabled in the Actions tab and that its two secrets are set.

If you want to inspect where a comment stopped, the Postgres tables tell you: `WebhookEvent` for delivery, `ScheduledJob` for the work queued from it, `DmLog` for send status and errors, `OperationalEvent` for jobs that failed for good and the polling reconciler's sweep logs.

## Local development

You need Postgres. The included `docker-compose.yml` starts it:

```bash
docker-compose up -d
npm run db:generate
npm run db:migrate
```

Or install it natively (macOS):

```bash
brew install postgresql@16
brew services start postgresql@16
createdb openreply
```

Then set `DATABASE_URL` to match your local user, for example `postgresql://YOUR_USER@localhost:5432/openreply`.

One process:

```bash
npm run dev
```

Nothing runs delayed jobs locally unless you ask it to. Call the drain by hand when you want follow-ups and read fallbacks to fire:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/drain-jobs
```

For Meta to reach your local webhook, run a tunnel and point `NEXTAUTH_URL` and the Meta webhook and redirect URLs at the tunnel:

```bash
ngrok http 3000
```

## Set it up with an AI assistant

If you run an AI coding assistant like Claude Code or Cursor, it can drive most of this for you. Open a clone of this repo inside your assistant and paste the prompt below. Give it your keys as it asks for them.

A word of caution: the assistant will need real secrets to finish (Meta app secrets, a Resend key, database URLs). Only paste those into a tool and environment you trust, and rotate them afterward if you are unsure.

```
You are helping me self-host OpenReply, an open source Instagram comment-to-DM
automation tool, in this repository. Read README.md and docs/setup.md first, then
help me get it running end to end.

My goal: <describe it. For example: run it for my own Instagram account only,
or host it for other people to sign up.>

Work through this in order and stop to ask me whenever you need a value or an
action only I can do:

1. Local or hosted. Ask me which I want. If hosted, we use Vercel for the app
   (its domain becomes my public URL), a managed Postgres, and a scheduled
   GitHub Action for the job drain. If local, we use docker-compose and a
   tunnel.

2. Database. Help me get a Postgres running, then run the Prisma migration
   against it.

3. Environment. Generate NEXTAUTH_SECRET, CRON_SECRET, ENCRYPTION_KEY, and
   WEBHOOK_VERIFY_TOKEN for me. Ask me for my Resend API key and a verified
   sender address, and for the three Meta secrets once I create the app. Make
   sure ENCRYPTION_KEY is generated once and never changed afterwards.

4. Deploy, set the APP_URL and CRON_SECRET repository secrets so the drain
   workflow can run, and confirm /api/health returns ok.

5. Meta app. Walk me through the Meta app section of docs/setup.md one step at a
   time. This is the slow part. Tell me exactly what to click and what to paste,
   using my Vercel domain for the OAuth redirect and webhook. Remember the
   account ID trap (store user_id, not id) and that the app must be published
   for real webhooks to arrive.

6. Test. Have me create a campaign and comment a keyword from a second account,
   then confirm the DM sent by checking the DmLog table and the DM Logs page.

Rules for you:
- Never invent Meta dashboard steps. If a screen does not match the guide, ask
  me to screenshot it.
- Diagnose failures by querying the Postgres tables directly: WebhookEvent for
  delivery, ScheduledJob for queued work, DmLog for send status,
  OperationalEvent for jobs that failed for good. This is faster than logs.
- Remind me to rotate any secret I paste to you before real use.

Start by reading the docs, then ask me question 1.
```

By the end, `/api/health` returns `status: ok`, and a comment with your keyword from a second account produces a `SENT` row in the DM logs. If you get there, you are done.

## Letting other people use your instance

Everything above is enough to run OpenReply for your own accounts, or a handful of accounts you add as testers. No App Review needed.

For a stranger to connect their own Instagram to your hosted instance, Meta requires App Review granting Advanced Access on the messaging and comments permissions. That means:

- A screencast of the full flow working, recorded on real accounts in one take.
- A written justification for each permission. Drafts are in [../META_APP_REVIEW.md](../META_APP_REVIEW.md).
- Business verification, which asks for a document proving a legal business entity: a business registration or license, articles of incorporation, a business tax document, or a business bank statement.

Meta scrutinizes automated-DM apps and often rejects the first submission, so budget for a resubmit. If you do not have a registered business, most self-hosters skip this entirely by running their own instance for their own account, which never needs review.

## Security notes

- `.env` is gitignored. Keep it that way.
- Rotate any secret that has been pasted anywhere it could be logged, including a chat with an AI assistant.
- Instagram tokens are encrypted at rest with `ENCRYPTION_KEY`. Losing or changing it means every connected account has to reconnect.
