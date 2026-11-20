import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createReplyAddress } from '../client/replyAddress.js';
import { buildMessage, fakeContext, fakeMessage, SECRET, SYNC_TOKEN, testEnv } from './helpers.js';

const BASE = 'https://relay.example.com';
const auth = { Authorization: `Bearer ${SYNC_TOKEN}` };

const request = (path, { method = 'GET', headers = auth, body } = {}) =>
  worker.fetch(new Request(`${BASE}${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
  }), currentEnv);

let currentEnv;

/** Fresh env with `count` replies queued for recipients r_1..r_count. */
const seed = async (count, overrides = {}) => {
  currentEnv = testEnv(overrides);
  for (let i = 1; i <= count; i++) {
    const to = createReplyAddress(`r_${i}`, { secret: SECRET, domain: 'reply.example.com' });
    await worker.email(fakeMessage(to, buildMessage({ to, subject: `Reply ${i}` })), currentEnv, fakeContext());
  }
  return currentEnv;
};

test('pull and ack require the bearer token', async () => {
  await seed(1);
  const cases = [
    {},
    { Authorization: 'Bearer wrong-token' },
    { Authorization: SYNC_TOKEN },
    { Authorization: `Basic ${SYNC_TOKEN}` },
    { Authorization: `Bearer ${SYNC_TOKEN}x` }
  ];
  for (const headers of cases) {
    const pull = await request('/sync/pull', { headers });
    assert.equal(pull.status, 401, JSON.stringify(headers));
    assert.equal(pull.headers.get('WWW-Authenticate'), 'Bearer');
    const ack = await request('/sync/ack', { method: 'POST', headers, body: { ids: [1] } });
    assert.equal(ack.status, 401, JSON.stringify(headers));
  }
  // Nothing was acknowledged by the rejected calls
  assert.equal(currentEnv.DB.query('SELECT COUNT(*) AS n FROM replies WHERE acked_at IS NULL')[0].n, 1);
});

test('sync endpoints answer 503 when SYNC_TOKEN is not configured', async () => {
  await seed(0, { SYNC_TOKEN: '' });
  const response = await request('/sync/pull', { headers: { Authorization: 'Bearer ' } });
  assert.equal(response.status, 503);
});

test('pull returns pending items oldest first, honours limit and reports "more"', async () => {
  await seed(3);
  const first = await request('/sync/pull?limit=2');
  assert.equal(first.status, 200);
  const page = await first.json();
  assert.deepEqual(page.items.map((item) => item.subject), ['Reply 1', 'Reply 2']);
  assert.deepEqual(page.items.map((item) => item.recipientId), ['r_1', 'r_2']);
  assert.equal(page.more, true);
  assert.equal(typeof page.items[0].id, 'number');
  assert.match(page.items[0].receivedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  const all = await (await request('/sync/pull')).json();
  assert.equal(all.items.length, 3);
  assert.equal(all.more, false);
});

test('pull clamps out-of-range limits', async () => {
  await seed(2);
  for (const limit of ['0', '-5', 'abc', '100000']) {
    const response = await request(`/sync/pull?limit=${limit}`);
    assert.equal(response.status, 200, limit);
    assert.equal((await response.json()).items.length, 2, limit);
  }
});

test('ack hides items from later pulls and is idempotent', async () => {
  await seed(3);
  const { items } = await (await request('/sync/pull')).json();

  const ack = await request('/sync/ack', { method: 'POST', body: { ids: [items[0].id, items[1].id, items[1].id, 9999] } });
  assert.equal(ack.status, 200);
  assert.deepEqual(await ack.json(), { acked: 2 });

  const after = await (await request('/sync/pull')).json();
  assert.deepEqual(after.items.map((item) => item.id), [items[2].id]);

  const again = await request('/sync/ack', { method: 'POST', body: { ids: [items[0].id] } });
  assert.deepEqual(await again.json(), { acked: 0 });

  // Acknowledged rows stay in D1 until the cron cleanup removes them
  assert.equal(currentEnv.DB.query('SELECT COUNT(*) AS n FROM replies')[0].n, 3);
});

test('ack validates its body', async () => {
  await seed(1);
  for (const body of ['not json', {}, { ids: 'all' }, { ids: [1.5] }, { ids: ['1'] }, { ids: [0] }, { ids: Array(501).fill(1) }]) {
    const response = await request('/sync/ack', { method: 'POST', body });
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  const empty = await request('/sync/ack', { method: 'POST', body: { ids: [] } });
  assert.deepEqual(await empty.json(), { acked: 0 });
});

test('routing: health, unknown paths and wrong methods', async () => {
  await seed(0);
  assert.equal((await request('/health', { headers: {} })).status, 200);
  assert.equal((await request('/nope')).status, 404);
  const wrong = await request('/sync/pull', { method: 'POST', body: {} });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get('Allow'), 'GET');
  assert.equal((await request('/sync/ack')).status, 405);
});

test('cron cleanup deletes acknowledged items past the retention period only', async () => {
  const env = await seed(4, { RETENTION_DAYS: '7' });
  const ids = env.DB.query('SELECT id FROM replies ORDER BY id').map((row) => row.id);
  const setAcked = (id, modifier) => env.DB.sqlite
    .prepare("UPDATE replies SET acked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) WHERE id = ?")
    .run(modifier, id);
  setAcked(ids[0], '-8 days'); // acked long ago: deleted
  setAcked(ids[1], '-6 days'); // acked recently: kept
  setAcked(ids[2], '-0 days'); // acked just now: kept
  // ids[3] never acked: kept no matter how old
  env.DB.sqlite.prepare("UPDATE replies SET received_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(ids[3]);

  const ctx = fakeContext();
  const deleted = await worker.scheduled({ cron: '0 3 * * *' }, env, ctx);
  await ctx.settle();

  assert.equal(deleted, 1);
  assert.deepEqual(env.DB.query('SELECT id FROM replies ORDER BY id').map((row) => row.id), ids.slice(1));
});

test('cron cleanup uses 7 days when RETENTION_DAYS is missing or invalid', async () => {
  for (const value of [undefined, 'soon', '-1']) {
    const env = await seed(2, { RETENTION_DAYS: value });
    const [a, b] = env.DB.query('SELECT id FROM replies ORDER BY id').map((row) => row.id);
    env.DB.sqlite.prepare("UPDATE replies SET acked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-8 days') WHERE id = ?").run(a);
    env.DB.sqlite.prepare("UPDATE replies SET acked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-6 days') WHERE id = ?").run(b);
    assert.equal(await worker.scheduled({}, env, fakeContext()), 1, String(value));
  }
});
