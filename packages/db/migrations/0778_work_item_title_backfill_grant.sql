-- A work item's title can be filled in after the row is created.
--
-- The webhook's row for an issue is made without a title when it predates the intake change that stores one. The stage
-- driver reads the issue before it triages it, so it fills the title in then (only while the column is still NULL; the
-- statement says so, this grant only lets the column be written). 0630 left `title` out of app_user's UPDATE grant
-- because nothing wrote it after the INSERT; this adds exactly that column and no other.
GRANT UPDATE (title) ON work_items TO app_user;
