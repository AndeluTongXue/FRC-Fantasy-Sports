-- Optional auto-start time for a league's draft. Set at creation or edited any time before
-- the draft actually starts; cleared once it does (manually or via auto-start).
ALTER TABLE leagues ADD COLUMN scheduled_draft_at INTEGER;
