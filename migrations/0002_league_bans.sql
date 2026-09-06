-- Commissioner-managed bans: a banned user is kicked from the league and can't rejoin
-- (via invite code) until unbanned. See leagueRoutes' /ban and /unban.

CREATE TABLE league_bans (
  league_id  TEXT NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  banned_at  INTEGER NOT NULL,
  PRIMARY KEY (league_id, user_id)
);
