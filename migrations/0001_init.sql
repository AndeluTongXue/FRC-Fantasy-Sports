-- Accounts and sessions

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Cached FRC data from The Blue Alliance

CREATE TABLE teams (
  team_key    TEXT PRIMARY KEY,
  team_number INTEGER NOT NULL,
  nickname    TEXT,
  name        TEXT,
  city        TEXT,
  state_prov  TEXT,
  country     TEXT,
  rookie_year INTEGER,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_teams_number ON teams(team_number);

CREATE TABLE events (
  event_key         TEXT PRIMARY KEY,
  year              INTEGER NOT NULL,
  name              TEXT NOT NULL,
  short_name        TEXT,
  event_type        INTEGER,
  event_type_string TEXT,
  week              INTEGER,
  start_date        TEXT,
  end_date          TEXT,
  city              TEXT,
  state_prov        TEXT,
  country           TEXT,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX idx_events_year ON events(year);

CREATE TABLE event_teams (
  event_key TEXT NOT NULL,
  team_key  TEXT NOT NULL,
  PRIMARY KEY (event_key, team_key)
);
CREATE INDEX idx_event_teams_team ON event_teams(team_key);

CREATE TABLE matches (
  match_key       TEXT PRIMARY KEY,
  event_key       TEXT NOT NULL,
  comp_level      TEXT NOT NULL,
  set_number      INTEGER,
  match_number    INTEGER,
  red_teams       TEXT NOT NULL,
  blue_teams      TEXT NOT NULL,
  red_score       INTEGER,
  blue_score      INTEGER,
  winning_alliance TEXT,
  score_breakdown TEXT,
  actual_time     INTEGER,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_matches_event ON matches(event_key);

CREATE TABLE awards (
  event_key  TEXT NOT NULL,
  award_type INTEGER NOT NULL,
  name       TEXT NOT NULL,
  team_key   TEXT NOT NULL,
  PRIMARY KEY (event_key, award_type, team_key)
);
CREATE INDEX idx_awards_team ON awards(team_key);

CREATE TABLE alliances (
  event_key       TEXT NOT NULL,
  alliance_number INTEGER NOT NULL,
  pick_index      INTEGER NOT NULL,
  team_key        TEXT NOT NULL,
  PRIMARY KEY (event_key, alliance_number, pick_index)
);
CREATE INDEX idx_alliances_team ON alliances(team_key);

-- Draft pricing, seeded from prior-season Statbotics EPA (with a TBA fallback)

CREATE TABLE team_prices (
  season_year INTEGER NOT NULL,
  team_key    TEXT NOT NULL,
  price       INTEGER NOT NULL,
  epa         REAL,
  source      TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (season_year, team_key)
);

-- Leagues

CREATE TABLE leagues (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  league_type     TEXT NOT NULL CHECK (league_type IN ('single_event', 'season')),
  event_key       TEXT,
  season_year     INTEGER NOT NULL,
  invite_code     TEXT NOT NULL UNIQUE,
  commissioner_id TEXT NOT NULL REFERENCES users(id),
  roster_size     INTEGER NOT NULL DEFAULT 6,
  salary_cap      INTEGER NOT NULL DEFAULT 200,
  max_members     INTEGER NOT NULL DEFAULT 8,
  pick_seconds    INTEGER NOT NULL DEFAULT 90,
  scoring_config  TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'setup' CHECK (status IN ('setup', 'drafting', 'active', 'complete')),
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_leagues_commissioner ON leagues(commissioner_id);

CREATE TABLE league_members (
  league_id      TEXT NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  roster_name    TEXT NOT NULL,
  draft_position INTEGER,
  joined_at      INTEGER NOT NULL,
  PRIMARY KEY (league_id, user_id)
);
CREATE INDEX idx_league_members_user ON league_members(user_id);

CREATE TABLE draft_picks (
  league_id   TEXT NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  pick_number INTEGER NOT NULL,
  user_id     TEXT NOT NULL,
  team_key    TEXT NOT NULL,
  price       INTEGER NOT NULL,
  drafted_at  INTEGER NOT NULL,
  PRIMARY KEY (league_id, pick_number)
);
CREATE UNIQUE INDEX idx_draft_picks_team ON draft_picks(league_id, team_key);

-- Scoring output: one row per rostered team per event

CREATE TABLE fantasy_scores (
  league_id  TEXT NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  team_key   TEXT NOT NULL,
  event_key  TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  points     REAL NOT NULL,
  breakdown  TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (league_id, team_key, event_key)
);
CREATE INDEX idx_fantasy_scores_user ON fantasy_scores(league_id, user_id);
