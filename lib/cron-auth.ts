import { timingSafeEqual } from "crypto";

/**
 * Authorize a scheduled job or an operator request carrying the cron secret.
 *
 * Deliberately reads CRON_SECRET only. The previous inline checks fell back to
 * NEXTAUTH_SECRET, which had two consequences: the session-signing key
 * travelled in an Authorization header and sat in the Vercel cron config, and
 * with neither variable set the comparison degraded to the literal string
 * "Bearer undefined", which an attacker can simply send.
 *
 * Fails closed: no secret configured means no request is ever authorized.
 */
export function isAuthorizedCron(authHeader: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || !authHeader) return false;

  const provided = Buffer.from(authHeader);
  const expected = Buffer.from(`Bearer ${secret}`);

  // timingSafeEqual throws on a length mismatch, so the length is compared
  // first. Length is not the secret; the bytes are.
  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  );
}
