-- Reply queue for email-reply-relay.
-- Apply with: npx wrangler d1 execute email-reply-relay --remote --file schema.sql

CREATE TABLE IF NOT EXISTS replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Set only when the reply address carried a valid signature
  recipient_id TEXT,
  signed INTEGER NOT NULL DEFAULT 0,
  -- The normalized message as JSON (see normalizeReply in src/inbound.js)
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- NULL until the app acknowledges the item via POST /sync/ack
  acked_at TEXT
);

-- /sync/pull reads unacknowledged rows in id order; the cron cleanup scans acknowledged rows by age.
CREATE INDEX IF NOT EXISTS replies_pending ON replies (acked_at, id);
