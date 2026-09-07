import type { Env } from "./env";

export interface Email {
  to: string;
  subject: string;
  /** Plain text. These two mails are a sentence and a link; HTML buys nothing and costs
   * deliverability with spam filters. */
  body: string;
}

/**
 * Sends through Resend when `RESEND_API_KEY` is set. Without one the mail is dropped, and
 * only captured in D1 for `EMAIL_DEV_OUTBOX` to read back — a deploy that forgets the key
 * shouldn't quietly accumulate live reset links in its database. Either way it's logged, so
 * the mistake is visible rather than silent.
 */
export async function sendEmail(env: Env, email: Email): Promise<void> {
  if (!env.RESEND_API_KEY) {
    if (env.EMAIL_DEV_OUTBOX === "1") await captureEmail(env, email);
    console.warn(`RESEND_API_KEY is not set — dropped "${email.subject}" to ${email.to}`);
    return;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM || "FRC Fantasy <onboarding@resend.dev>",
      to: [email.to],
      subject: email.subject,
      text: email.body,
    }),
  });

  if (!response.ok) {
    // Surfaced to the caller so signup/reset can tell the user the mail didn't go out,
    // rather than leaving them waiting for a link that will never arrive.
    throw new EmailError(`Resend returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
}

export class EmailError extends Error {}

/**
 * Whether a confirmation link can actually reach someone. True with a provider configured,
 * and true in development, where the mail is captured and readable from the dev outbox — in
 * both cases a link is obtainable. False means the email confirmation gate has to stand
 * down: enforcing it would lock every new account out of leagues forever, waiting on a link
 * that was never going to arrive.
 */
export function canDeliverEmail(env: Env): boolean {
  return Boolean(env.RESEND_API_KEY) || env.EMAIL_DEV_OUTBOX === "1";
}

async function captureEmail(env: Env, email: Email): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO outbound_emails (id, to_email, subject, body, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(crypto.randomUUID(), email.to, email.subject, email.body, Date.now())
    .run();
}

/**
 * Base URL for the links in those mails. `APP_URL` is preferred over the request's own
 * Host header: the header is client-supplied, so trusting it would let someone request a
 * password reset for your address and have the link point at a host they control.
 */
export function appUrl(env: Env, requestUrl: string): string {
  if (env.APP_URL) return env.APP_URL.replace(/\/+$/, "");
  return new URL(requestUrl).origin;
}

export function verificationEmail(to: string, displayName: string, link: string): Email {
  return {
    to,
    subject: "Confirm your FRC Fantasy email",
    body: [
      `Hi ${displayName},`,
      "",
      "Confirm this address to start creating and joining leagues:",
      link,
      "",
      "The link is good for 24 hours. If you didn't sign up for FRC Fantasy, ignore this email.",
    ].join("\n"),
  };
}

export function passwordResetEmail(to: string, displayName: string, link: string): Email {
  return {
    to,
    subject: "Reset your FRC Fantasy password",
    body: [
      `Hi ${displayName},`,
      "",
      "Someone asked to reset the password on this account. Set a new one here:",
      link,
      "",
      "The link is good for 1 hour and can only be used once. If this wasn't you, ignore this",
      "email — your password stays as it is.",
    ].join("\n"),
  };
}

/** Capture rows are only written in development, and only useful for the few minutes a dev
 * spends clicking the link. */
export async function pruneOutboundEmails(db: D1Database): Promise<void> {
  await db
    .prepare("DELETE FROM outbound_emails WHERE created_at < ?")
    .bind(Date.now() - 24 * 60 * 60 * 1000)
    .run();
}
