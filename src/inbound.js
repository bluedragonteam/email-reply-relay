import PostalMime from 'postal-mime';
import { classifyRecipient } from './address.js';
import { insertReply } from './store.js';

// Only the first part of a message is parsed for the queue. The complete message, attachments
// included, is what gets forwarded to FORWARD_TO; this keeps large mail within the CPU budget.
export const MAX_PARSE_BYTES = 512 * 1024;
// Text and HTML bodies are capped again after parsing so a queued row stays well below D1's row limit.
export const MAX_BODY_CHARS = 200_000;
const NOTIFY_TIMEOUT_MS = 10_000;

/**
 * Read a stream to the end but keep only its first `cap` bytes.
 * Draining (rather than cancelling) leaves the message in the state Email Routing expects.
 */
export const readCapped = async (stream, cap) => {
  const reader = stream.getReader();
  const chunks = [];
  let kept = 0;
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (kept < cap) {
      const part = value.subarray(0, cap - kept);
      chunks.push(part);
      kept += part.byteLength;
    }
  }
  const bytes = new Uint8Array(kept);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, totalBytes: total };
};

const mailboxes = (addresses = []) =>
  addresses.flatMap((entry) => (entry.group ? entry.group : [entry]))
    .filter((entry) => entry && entry.address)
    .map(({ name, address }) => ({ name: name || '', address }));

const capText = (value) => {
  const text = typeof value === 'string' ? value : '';
  return text.length > MAX_BODY_CHARS ? { value: text.slice(0, MAX_BODY_CHARS), cut: true } : { value: text, cut: false };
};

/**
 * Turn a parsed message into the item stored in the queue.
 * Attachments are described by name and type only; the files themselves are in the forwarded copy.
 */
export const normalizeReply = (email, context) => {
  const text = capText(email.text);
  const html = capText(email.html);
  return {
    recipientId: context.recipientId,
    signed: context.signed,
    envelope: { from: context.envelopeFrom, to: context.envelopeTo },
    from: mailboxes(email.from ? [email.from] : [])[0] || null,
    to: mailboxes(email.to),
    cc: mailboxes(email.cc),
    replyTo: mailboxes(email.replyTo),
    subject: email.subject || '',
    date: email.date || null,
    messageId: email.messageId || null,
    inReplyTo: email.inReplyTo || null,
    references: email.references || null,
    text: text.value,
    html: html.value,
    attachments: (email.attachments || []).map((file) => ({
      filename: file.filename || null,
      mimeType: file.mimeType || 'application/octet-stream',
      disposition: file.disposition || null
    })),
    rawSize: context.rawSize,
    truncated: context.truncated || text.cut || html.cut,
    parseError: context.parseError || null,
    forwarded: context.forwarded,
    forwardError: context.forwardError || null
  };
};

const forward = async (message, env, signed) => {
  if (!env.FORWARD_TO) return { forwarded: false, forwardError: 'FORWARD_TO is not set' };
  try {
    // Email Routing only allows adding X- headers to a forwarded message.
    await message.forward(env.FORWARD_TO, new Headers({ 'X-Reply-Relay': signed ? 'signed' : 'unsigned' }));
    return { forwarded: true, forwardError: null };
  } catch (error) {
    // The item is still queued below, so the reply is not lost.
    console.error(`Forwarding to FORWARD_TO failed: ${error.message}`);
    return { forwarded: false, forwardError: String(error.message || error) };
  }
};

const parse = async (bytes, message) => {
  try {
    return { email: await PostalMime.parse(bytes), parseError: null };
  } catch (error) {
    console.error(`Could not parse message: ${error.message}`);
    return {
      email: { subject: message.headers?.get('subject') || '', attachments: [] },
      parseError: String(error.message || error)
    };
  }
};

/**
 * Optional: tell the app that something new is waiting. The body carries no message content;
 * the app is expected to call /sync/pull (which is authenticated) in response.
 */
export const notifyApp = async (env, id, signed) => {
  if (!env.NOTIFY_URL) return;
  try {
    const response = await fetch(env.NOTIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'reply.queued', id, signed }),
      signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS)
    });
    if (!response.ok) console.error(`NOTIFY_URL answered HTTP ${response.status}`);
  } catch (error) {
    console.error(`NOTIFY_URL request failed: ${error.message}`);
  }
};

/**
 * Email Routing entry point for one incoming message.
 *
 * - signed reply-domain address   -> forwarded + queued with its recipient id
 * - other reply-domain address    -> forwarded + queued as `signed: false`
 * - anything on another domain    -> rejected
 */
export const handleEmail = async (message, env, ctx) => {
  const { onReplyDomain, signed, recipientId } = await classifyRecipient(message.to, env);
  if (!onReplyDomain) {
    message.setReject('Unknown address');
    return null;
  }

  const { bytes, totalBytes } = await readCapped(message.raw, MAX_PARSE_BYTES);
  const rawSize = Number.isFinite(message.rawSize) ? message.rawSize : totalBytes;
  const forwardResult = await forward(message, env, signed);
  const { email, parseError } = await parse(bytes, message);

  const item = normalizeReply(email, {
    recipientId,
    signed,
    envelopeFrom: message.from,
    envelopeTo: message.to,
    rawSize,
    truncated: totalBytes > MAX_PARSE_BYTES,
    parseError,
    ...forwardResult
  });
  const id = await insertReply(env.DB, item);

  const notification = notifyApp(env, id, signed);
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(notification);
  else await notification;
  return id;
};
