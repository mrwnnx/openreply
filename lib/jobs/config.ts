/**
 * How often the drain cron is expected to fire.
 *
 * This is a tuning dial with a real cost on both sides. Firing often keeps
 * delayed work punctual, but every wake-up is a database query, and Neon
 * suspends a free-tier endpoint only after five idle minutes — so a five-minute
 * cron means the database never sleeps at all. That is precisely what exhausted
 * its compute quota on 2026-08-27. Thirty minutes leaves it asleep for most of
 * the hour.
 *
 * Raise the frequency only against a measured compute budget; the GitHub
 * Actions schedule in .github/workflows/drain-jobs.yml has to be changed to
 * match, since nothing reads this value at the other end.
 */
export const DRAIN_INTERVAL_MS =
  Number(process.env.JOB_DRAIN_INTERVAL_MINUTES ?? 30) * 60_000;
