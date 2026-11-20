/**
 * D1 access for the reply queue. See schema.sql for the table.
 *
 * Timestamps are written by SQLite as ISO-8601 UTC strings (2026-01-31T12:00:00.000Z) so they
 * sort and compare correctly as text.
 */

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export const insertReply = (db, item) => db
  .prepare('INSERT INTO replies (recipient_id, signed, payload) VALUES (?, ?, ?) RETURNING id')
  .bind(item.recipientId, item.signed ? 1 : 0, JSON.stringify(item))
  .first('id');

/** Oldest unacknowledged items first. Asks for one extra row to tell the caller whether more are waiting. */
export const pendingReplies = async (db, limit) => {
  const { results } = await db
    .prepare('SELECT id, payload, received_at FROM replies WHERE acked_at IS NULL ORDER BY id LIMIT ?')
    .bind(limit + 1)
    .all();
  const items = results.slice(0, limit).map((row) => ({
    id: row.id,
    receivedAt: row.received_at,
    ...JSON.parse(row.payload)
  }));
  return { items, more: results.length > limit };
};

/** Mark items as delivered to the app. Already-acked or unknown ids are ignored. */
export const ackReplies = async (db, ids) => {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(', ');
  const { meta } = await db
    .prepare(`UPDATE replies SET acked_at = ${NOW} WHERE acked_at IS NULL AND id IN (${placeholders})`)
    .bind(...ids)
    .run();
  return meta.changes;
};

/** Delete acknowledged items older than `days`. Unacknowledged items are never deleted here. */
export const deleteAckedBefore = async (db, days) => {
  const { meta } = await db
    .prepare(`DELETE FROM replies WHERE acked_at IS NOT NULL AND acked_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)`)
    .bind(`-${days} days`)
    .run();
  return meta.changes;
};
