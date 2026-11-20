import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { MAX_BODY_CHARS, MAX_PARSE_BYTES } from '../src/inbound.js';
import { createReplyAddress } from '../client/replyAddress.js';
import { buildMessage, fakeContext, fakeMessage, SECRET, testEnv } from './helpers.js';

const REPLY_TO = createReplyAddress('r_42', { secret: SECRET, domain: 'reply.example.com' });

const queued = (env) => env.DB.query('SELECT * FROM replies ORDER BY id')
  .map((row) => ({ ...row, payload: JSON.parse(row.payload) }));

const receive = async (env, to, raw = buildMessage({ to })) => {
  const message = fakeMessage(to, raw);
  const ctx = fakeContext();
  await worker.email(message, env, ctx);
  await ctx.settle();
  return message;
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('a reply to a signed address is forwarded and queued with its recipient id', async () => {
  const env = testEnv();
  const raw = buildMessage({
    to: REPLY_TO,
    attachments: [{ name: 'invoice.pdf', type: 'application/pdf', base64: 'JVBERi0xLjQK' }]
  });
  const message = await receive(env, REPLY_TO, raw);

  assert.equal(message.calls.rejected, null);
  assert.deepEqual(message.calls.forwarded, [{ address: 'inbox@example.net', headers: { 'x-reply-relay': 'signed' } }]);

  const rows = queued(env);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].recipient_id, 'r_42');
  assert.equal(rows[0].signed, 1);
  assert.equal(rows[0].acked_at, null);

  const item = rows[0].payload;
  assert.equal(item.recipientId, 'r_42');
  assert.equal(item.signed, true);
  assert.deepEqual(item.envelope, { from: 'jane@example.org', to: REPLY_TO });
  assert.deepEqual(item.from, { name: 'Jane Doe', address: 'jane@example.org' });
  assert.deepEqual(item.to, [{ name: '', address: REPLY_TO }]);
  assert.equal(item.subject, 'Re: Your order');
  assert.equal(item.messageId, '<reply-1@example.org>');
  assert.equal(item.inReplyTo, '<original-1@example.com>');
  assert.match(item.text, /Thanks, that works for me\./);
  assert.deepEqual(item.attachments, [{ filename: 'invoice.pdf', mimeType: 'application/pdf', disposition: 'attachment' }]);
  assert.equal(item.truncated, false);
  assert.equal(item.rawSize, new TextEncoder().encode(raw).byteLength);
  assert.equal(item.forwarded, true);
  assert.equal(item.forwardError, null);
});

test('unsigned addresses on the reply domain are forwarded and queued as unsigned', async () => {
  const forged = REPLY_TO.replace(/\.[0-9a-f]+@/, '.0000000000000000@');
  for (const to of ['reply@reply.example.com', 'hello@reply.example.com', forged]) {
    const env = testEnv();
    const message = await receive(env, to);

    assert.equal(message.calls.rejected, null, to);
    assert.deepEqual(message.calls.forwarded, [{ address: 'inbox@example.net', headers: { 'x-reply-relay': 'unsigned' } }], to);
    const rows = queued(env);
    assert.equal(rows.length, 1, to);
    assert.equal(rows[0].signed, 0);
    assert.equal(rows[0].recipient_id, null);
    assert.equal(rows[0].payload.signed, false);
    assert.equal(rows[0].payload.recipientId, null);
    // The app can still match on the sender
    assert.equal(rows[0].payload.from.address, 'jane@example.org');
  }
});

test('mail for other domains is rejected, not forwarded and not queued', async () => {
  for (const to of ['someone@example.com', 'reply@reply.example.com.attacker.test', REPLY_TO.replace('@reply.', '@other.')]) {
    const env = testEnv();
    const message = await receive(env, to);
    assert.equal(message.calls.rejected, 'Unknown address', to);
    assert.deepEqual(message.calls.forwarded, []);
    assert.equal(queued(env).length, 0);
  }
});

test('a failed forward still queues the item and records the error', async () => {
  const env = testEnv();
  const message = fakeMessage(REPLY_TO, buildMessage({ to: REPLY_TO }));
  message.forward = async () => {
    throw new Error('destination address not verified');
  };
  await worker.email(message, env, fakeContext());

  const rows = queued(env);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payload.forwarded, false);
  assert.equal(rows[0].payload.forwardError, 'destination address not verified');
  assert.equal(rows[0].payload.recipientId, 'r_42');
});

test('without FORWARD_TO the item is queued and marked as not forwarded', async () => {
  const env = testEnv({ FORWARD_TO: '' });
  const message = await receive(env, REPLY_TO);
  assert.deepEqual(message.calls.forwarded, []);
  assert.equal(queued(env)[0].payload.forwarded, false);
});

test('oversized messages are forwarded whole but parsed only up to the cap', async () => {
  const env = testEnv();
  // ~900 KB of base64 after the text part, so the cut falls inside the second attachment
  const big = 'A'.repeat(76);
  const body = Array.from({ length: 6000 }, () => big).join('\r\n');
  const raw = buildMessage({
    to: REPLY_TO,
    text: 'See the files attached.',
    attachments: [
      { name: 'photo-1.jpg', type: 'image/jpeg', base64: body },
      { name: 'photo-2.jpg', type: 'image/jpeg', base64: body }
    ]
  });
  const size = new TextEncoder().encode(raw).byteLength;
  assert.ok(size > MAX_PARSE_BYTES, 'fixture must exceed the parse cap');

  const message = await receive(env, REPLY_TO, raw);
  assert.equal(message.calls.forwarded.length, 1);

  const item = queued(env)[0].payload;
  assert.equal(item.truncated, true);
  assert.equal(item.rawSize, size);
  assert.match(item.text, /See the files attached\./);
  const names = item.attachments.map((file) => file.filename);
  assert.ok(names.includes('photo-1.jpg'), `attachment names recorded: ${names}`);
});

test('very long bodies are cut after parsing and the item is marked truncated', async () => {
  const env = testEnv();
  const text = 'x'.repeat(MAX_BODY_CHARS + 1000);
  await receive(env, REPLY_TO, buildMessage({ to: REPLY_TO, text }));
  const item = queued(env)[0].payload;
  assert.equal(item.text.length, MAX_BODY_CHARS);
  assert.equal(item.truncated, true);
});

test('NOTIFY_URL is pinged with the new id and no message content', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), method: init.method });
    return new Response('ok');
  };
  const env = testEnv({ NOTIFY_URL: 'https://app.example.com/hooks/reply' });
  await receive(env, REPLY_TO);

  const [row] = queued(env);
  assert.deepEqual(calls, [{
    url: 'https://app.example.com/hooks/reply',
    method: 'POST',
    body: { event: 'reply.queued', id: row.id, signed: true }
  }]);
});

test('a failing NOTIFY_URL does not affect the queued item', async () => {
  globalThis.fetch = async () => {
    throw new Error('connection refused');
  };
  const env = testEnv({ NOTIFY_URL: 'https://app.example.com/hooks/reply' });
  await receive(env, REPLY_TO);
  assert.equal(queued(env).length, 1);
});

test('the email handler refuses to run without REPLY_SECRET or REPLY_DOMAIN', async () => {
  for (const overrides of [{ REPLY_SECRET: '' }, { REPLY_DOMAIN: '' }]) {
    const env = testEnv(overrides);
    await assert.rejects(worker.email(fakeMessage(REPLY_TO, buildMessage({ to: REPLY_TO })), env, fakeContext()));
    assert.equal(queued(env).length, 0);
  }
});
