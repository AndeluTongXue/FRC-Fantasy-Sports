-- Lets the commissioner pencil in a date/time for the draft. Purely informational — the
-- draft itself still starts manually from the draft room — so members have a shared
-- expectation to plan around. Null means no schedule has been set.

ALTER TABLE leagues ADD COLUMN scheduled_draft_at INTEGER;
