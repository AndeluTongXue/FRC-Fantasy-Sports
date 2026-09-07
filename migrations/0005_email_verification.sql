-- Email confirmation and password reset.
--
-- Both flows are the same shape: mint a random token, mail a link containing it, store only
-- its SHA-256 digest (same reasoning as `sessions` — a D1 leak must not be enough to take
-- over an account), then redeem it once.

-- NULL means unconfirmed. Accounts that predate this migration are grandfathered in as
-- confirmed: they signed up when no confirmation existed, and retroactively locking them
-- out of leagues they already run would be a worse outcome than trusting the address.
ALTER TABLE users ADD COLUMN email_verified_at INTEGER;
UPDATE users SET email_verified_at = created_at;

CREATE TABLE auth_tokens (
  id         TEXT PRIMARY KEY,  -- SHA-256 digest of the token in the emailed link
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('verify_email', 'password_reset')),
  -- The address the link was mailed to. A token is only honoured while it still matches the
  -- account's current address, so changing the address invalidates outstanding links.
  email      TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_auth_tokens_user ON auth_tokens(user_id, purpose);
CREATE INDEX idx_auth_tokens_expiry ON auth_tokens(expires_at);

-- Only written when no email provider is configured, so local development (and the smoke
-- script) can read the link that would have been sent. Never written once RESEND_API_KEY
-- is set, and only readable through a route that EMAIL_DEV_OUTBOX has to switch on.
CREATE TABLE outbound_emails (
  id         TEXT PRIMARY KEY,
  to_email   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_outbound_emails_to ON outbound_emails(to_email, created_at);
