import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { classifyRecipient, replySignature, signatureLength } from '../src/address.js';
import { safeEqual } from '../src/crypto.js';
import { createReplyAddress, verifyReplyAddress } from '../client/replyAddress.js';
import { SECRET } from './helpers.js';

const env = { REPLY_SECRET: SECRET, REPLY_DOMAIN: 'reply.example.com' };
const options = { secret: SECRET, domain: 'reply.example.com' };

test('signature is the first 16 hex chars of HMAC-SHA256(secret, "reply|<id>")', async () => {
  const expected = createHmac('sha256', SECRET).update('reply|r_42').digest('hex').slice(0, 16);
  assert.equal(await replySignature(SECRET, 'r_42'), expected);
  assert.equal(createReplyAddress('r_42', options), `reply+r_42.${expected}@reply.example.com`);
});

test('the Node helper and the Worker agree in both directions', async () => {
  for (const id of ['1', 'r_42', 'user-7f3a', 'a'.repeat(64)]) {
    const address = createReplyAddress(id, options);
    assert.deepEqual(await classifyRecipient(address, env), { onReplyDomain: true, signed: true, recipientId: id });
    assert.equal(verifyReplyAddress(address, options), id);
  }
});

test('custom signature length is honoured on both sides', async () => {
  const address = createReplyAddress('r_42', { ...options, signatureLength: 24 });
  assert.match(address, /^reply\+r_42\.[0-9a-f]{24}@/);
  assert.equal((await classifyRecipient(address, { ...env, SIGNATURE_LENGTH: '24' })).signed, true);
  // The default-length Worker does not accept a 24-char signature
  assert.equal((await classifyRecipient(address, env)).signed, false);
  assert.equal(verifyReplyAddress(address, { ...options, signatureLength: 24 }), 'r_42');
  assert.equal(verifyReplyAddress(address, options), null);
});

test('invalid SIGNATURE_LENGTH values fall back to the default', () => {
  for (const value of [undefined, '', 'abc', '4', '65']) {
    assert.equal(signatureLength({ SIGNATURE_LENGTH: value }), 16, String(value));
  }
  assert.equal(signatureLength({ SIGNATURE_LENGTH: '32' }), 32);
});

test('addresses are matched case-insensitively and may be wrapped in angle brackets', async () => {
  const address = createReplyAddress('r_42', options);
  assert.equal((await classifyRecipient(address.toUpperCase(), env)).recipientId, 'r_42');
  assert.equal(verifyReplyAddress(`<${address.toUpperCase()}>`, options), 'r_42');
});

test('tampered, truncated, or wrong-secret addresses are not signed', async () => {
  const good = createReplyAddress('r_42', options);
  const sig = good.slice(good.indexOf('.') + 1, good.indexOf('@'));
  const flipped = sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0');
  const cases = [
    `reply+r_43.${sig}@reply.example.com`, // signature for a different id
    `reply+r_42.${flipped}@reply.example.com`, // one character changed
    `reply+r_42.${sig.slice(0, 10)}@reply.example.com`, // too short
    createReplyAddress('r_42', { ...options, secret: 'other-secret' }),
    'reply+r_42@reply.example.com',
    'reply@reply.example.com',
    'hello@reply.example.com'
  ];
  for (const address of cases) {
    assert.deepEqual(await classifyRecipient(address, env), { onReplyDomain: true, signed: false, recipientId: null }, address);
    assert.equal(verifyReplyAddress(address, options), null, address);
  }
});

test('other domains, including look-alikes and subdomains, are not the reply domain', async () => {
  const sigPart = createReplyAddress('r_42', options).split('@')[0];
  for (const address of [
    `${sigPart}@example.com`,
    `${sigPart}@reply.example.com.attacker.test`,
    `${sigPart}@sub.reply.example.com`,
    'not-an-address',
    ''
  ]) {
    assert.equal((await classifyRecipient(address, env)).onReplyDomain, false, address);
    assert.equal(verifyReplyAddress(address, options), null, address);
  }
});

test('createReplyAddress validates its input', () => {
  assert.throws(() => createReplyAddress('Has.Dot', options), TypeError);
  assert.throws(() => createReplyAddress('UPPER', options), TypeError);
  assert.throws(() => createReplyAddress('a'.repeat(65), options), TypeError);
  assert.throws(() => createReplyAddress('r_42', { ...options, secret: '' }), TypeError);
  assert.throws(() => createReplyAddress('r_42', { secret: SECRET }), TypeError);
  assert.throws(() => createReplyAddress('r_42', { ...options, signatureLength: 4 }), RangeError);
});

test('safeEqual compares strings of any length without throwing', async () => {
  assert.equal(await safeEqual('abc', 'abc'), true);
  assert.equal(await safeEqual('abc', 'abd'), false);
  assert.equal(await safeEqual('abc', 'abcd'), false);
  assert.equal(await safeEqual('', ''), true);
  assert.equal(await safeEqual(undefined, 'abc'), false);
});
