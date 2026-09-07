/**
 * Creating and joining leagues is gated on a confirmed email address, so a script that has
 * just signed an account up has to redeem its confirmation link before it can do anything
 * with a league.
 *
 * The link is read back from `/api/auth/dev/outbox`, which needs `EMAIL_DEV_OUTBOX=1` in
 * .dev.vars and no `RESEND_API_KEY` — with a key set the mail is really sent and never
 * captured, and every one of these scripts stops at its first league.
 */
export async function confirmEmail(base, email) {
  const outbox = await fetch(`${base}/api/auth/dev/outbox?email=${encodeURIComponent(email)}`);
  if (!outbox.ok) {
    throw new Error(
      `could not read the confirmation email for ${email} (HTTP ${outbox.status}). Set ` +
        "EMAIL_DEV_OUTBOX=1 in .dev.vars, leave RESEND_API_KEY unset, and restart the dev server.",
    );
  }

  const captured = await outbox.json();
  const link = captured.body.match(/https?:\/\/\S+/)?.[0];
  if (!link) throw new Error(`no confirmation link in the email sent to ${email}`);

  const response = await fetch(`${base}/api/auth/verify-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: new URL(link).searchParams.get("token") }),
  });
  if (!response.ok) throw new Error(`could not confirm ${email}: HTTP ${response.status}`);
}
