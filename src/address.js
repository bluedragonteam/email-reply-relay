import { hmacSha256Hex, safeEqual } from './crypto.js';

/**
 * Signed reply addresses: reply+<recipientId>.<signature>@<REPLY_DOMAIN>
 *
 * signature = first N hex characters of HMAC-SHA256(REPLY_SECRET, "reply|<recipientId>")
 *
 * client/replyAddress.js implements the same scheme for the sending app (with node:crypto);
 * test/address.test.js checks that the two agree.
 */

export const DEFAULT_SIGNATURE_LENGTH = 16;
const MIN_SIGNATURE_LENGTH = 8;
const MAX_SIGNATURE_LENGTH = 64;

// Recipient ids are lowercase so they survive mail systems that change the case of local parts.
const LOCAL_PART = /^reply\+([a-z0-9_-]{1,64})\.([0-9a-f]{8,64})$/;

export const signatureLength = (env) => {
  const value = Number.parseInt(env.SIGNATURE_LENGTH, 10);
  if (Number.isInteger(value) && value >= MIN_SIGNATURE_LENGTH && value <= MAX_SIGNATURE_LENGTH) return value;
  return DEFAULT_SIGNATURE_LENGTH;
};

export const replySignature = async (secret, recipientId, length = DEFAULT_SIGNATURE_LENGTH) =>
  (await hmacSha256Hex(secret, `reply|${recipientId}`)).slice(0, length);

/** Split an address into its local part and domain, both lowercased. Returns null if it is not an address. */
export const splitAddress = (address) => {
  const value = String(address || '').trim().replace(/^<|>$/g, '').toLowerCase();
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return null;
  return { local: value.slice(0, at), domain: value.slice(at + 1) };
};

/**
 * Work out what an envelope recipient means for the relay.
 *
 * @returns {Promise<{ onReplyDomain: boolean, signed: boolean, recipientId: string | null }>}
 *   `recipientId` is only set when the signature checks out; an unsigned or forged address
 *   never yields an id the app might trust.
 */
export const classifyRecipient = async (address, env) => {
  const parts = splitAddress(address);
  const replyDomain = String(env.REPLY_DOMAIN || '').toLowerCase();
  if (!parts || !replyDomain || parts.domain !== replyDomain) {
    return { onReplyDomain: false, signed: false, recipientId: null };
  }

  const match = LOCAL_PART.exec(parts.local);
  const length = signatureLength(env);
  if (!match || match[2].length !== length) {
    return { onReplyDomain: true, signed: false, recipientId: null };
  }

  const [, recipientId, signature] = match;
  const expected = await replySignature(env.REPLY_SECRET, recipientId, length);
  const signed = await safeEqual(signature, expected);
  return { onReplyDomain: true, signed, recipientId: signed ? recipientId : null };
};
