-- Sign in with Google.
--
-- Keyed on the Google subject id rather than the email address: `sub` is stable for the life
-- of the Google account, while the address on it can be changed, so matching on email would
-- hand the account to whoever inherits an old address.
ALTER TABLE users ADD COLUMN google_sub TEXT;
CREATE UNIQUE INDEX idx_users_google_sub ON users(google_sub);

-- `password_hash` is NOT NULL from 0001 and SQLite can't relax that without rebuilding the
-- table, which isn't worth doing to a table three others reference. An account that has only
-- ever signed in with Google stores '' instead — `verifyPassword` rejects it outright, so it
-- can never be used to sign in, and `hasPassword` is how the rest of the code asks.
