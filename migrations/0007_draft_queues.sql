-- Per-manager draft queue: an ordered list of teams to take automatically when the pick
-- clock runs out, instead of the "best affordable team" fallback that ignores what the
-- manager actually wanted.
--
-- A queue is private to its owner — seeing an opponent's would be a large and unearned
-- advantage — so it is only ever read back through a route scoped to the signed-in user.
CREATE TABLE draft_queues (
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Rank, ascending. Left non-contiguous when entries are pruned; only the order matters.
  position  INTEGER NOT NULL,
  team_key  TEXT NOT NULL,
  PRIMARY KEY (league_id, user_id, position)
);

-- One manager can't queue the same team twice.
CREATE UNIQUE INDEX idx_draft_queues_team ON draft_queues(league_id, user_id, team_key);

-- Drafting a team drops it from every queue in the league, so nobody's list accumulates
-- teams they can no longer have.
CREATE INDEX idx_draft_queues_league_team ON draft_queues(league_id, team_key);
