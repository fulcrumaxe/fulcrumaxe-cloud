-- D#845 MC-11b: the hourly price of a server's primary IPv4 address, stamped at create beside the monthly one. Hetzner bills the address by the started hour
-- up to its monthly price, so Budget & billing needs the hourly rate it was made at; it is never worked out from the monthly price.
-- Rows made before this have no hourly stamp (NULL): their IPv4 cost falls back to the monthly price and is shown as an estimate.
-- Like the other prices stamped at create, it is not in app_user's column UPDATE grant, so it cannot be changed afterwards.
-- Numbered 1076 by the Team Lead. Re-check against main's highest right before merging and renumber to stay above it.

ALTER TABLE managed_servers ADD COLUMN ipv4_hourly_gross numeric(12, 6) CHECK (ipv4_hourly_gross >= 0);
