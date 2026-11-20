/**
 * Example: pull queued replies from the Worker, hand them to your app, then acknowledge them.
 *
 *   RELAY_URL=https://email-reply-relay.<account>.workers.dev SYNC_TOKEN=... node client/pull-loop.example.js
 *
 * Items stay in the queue until they are acknowledged, so a crash between "handle" and "ack"
 * means the item is delivered again. Make handleReply idempotent (e.g. keyed on item.id or
 * item.messageId).
 */

const RELAY_URL = (process.env.RELAY_URL || '').replace(/\/+$/, '');
const SYNC_TOKEN = process.env.SYNC_TOKEN || '';
const INTERVAL_MS = 60_000;

if (!RELAY_URL || !SYNC_TOKEN) {
  console.error('Set RELAY_URL and SYNC_TOKEN');
  process.exit(1);
}

const call = async (path, init = {}) => {
  const response = await fetch(`${RELAY_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${SYNC_TOKEN}`, 'Content-Type': 'application/json', ...init.headers },
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
  return response.json();
};

// Replace with your own logic: store the reply, update the conversation, notify someone...
const handleReply = async (item) => {
  const who = item.from ? item.from.address : item.envelope.from;
  if (item.signed) {
    console.log(`#${item.id} reply from ${who} for recipient ${item.recipientId}: ${item.subject}`);
  } else {
    // No valid signature: match by sender address in your own data if you want to.
    console.log(`#${item.id} unsigned mail from ${who} to ${item.envelope.to}: ${item.subject}`);
  }
};

const drain = async () => {
  for (;;) {
    const { items, more } = await call('/sync/pull?limit=50');
    if (items.length === 0) return;

    const handled = [];
    for (const item of items) {
      try {
        await handleReply(item);
        handled.push(item.id);
      } catch (error) {
        // Not acknowledged, so it is returned again by the next pull.
        console.error(`#${item.id} failed: ${error.message}`);
      }
    }
    if (handled.length > 0) await call('/sync/ack', { method: 'POST', body: JSON.stringify({ ids: handled }) });
    if (!more || handled.length < items.length) return;
  }
};

for (;;) {
  try {
    await drain();
  } catch (error) {
    console.error(error.message);
  }
  await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
}
