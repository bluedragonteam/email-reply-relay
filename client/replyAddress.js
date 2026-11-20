/**
 * Create and verify signed reply addresses in the app that sends email (Node 18+).
 *
 *   reply+<recipientId>.<signature>@<domain>
 *   signature = first `signatureLength` hex chars of HMAC-SHA256(secret, "reply|<recipientId>")
 *
 * Use the same secret as the Worker's REPLY_SECRET and the same length as its SIGNATURE_LENGTH.
 * This file has no dependencies; copy it into your project or import it from here.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const DEFAULT_SIGNATURE_LENGTH = 16;

const RECIPIENT_ID = /^[a-z0-9_-]{1,64}$/;
const LOCAL_PART = /^reply\+([a-z0-9_-]{1,64})\.([0-9a-f]{8,64})$/;

const checkOptions = ({ secret, domain, signatureLength = DEFAULT_SIGNATURE_LENGTH }) => {
  if (typeof secret !== 'string' || secret.length === 0) throw new TypeError('secret is required');
  if (typeof domain !== 'string' || !domain.includes('.')) throw new TypeError('domain is required, e.g. "reply.example.com"');
  if (!Number.isInteger(signatureLength) || signatureLength < 8 || signatureLength > 64) {
    throw new RangeError('signatureLength must be an integer from 8 to 64');
  }
  return { secret, domain: domain.toLowerCase(), signatureLength };
};

export const replySignature = (recipientId, secret, signatureLength = DEFAULT_SIGNATURE_LENGTH) =>
  createHmac('sha256', secret).update(`reply|${recipientId}`).digest('hex').slice(0, signatureLength);

/**
 * @param {string} recipientId lowercase letters, digits, "_" or "-", up to 64 characters
 * @param {{ secret: string, domain: string, signatureLength?: number }} options
 * @returns {string} e.g. "reply+r_42.3f9c0a1b2c3d4e5f@reply.example.com"
 */
export const createReplyAddress = (recipientId, options) => {
  const { secret, domain, signatureLength } = checkOptions(options);
  if (typeof recipientId !== 'string' || !RECIPIENT_ID.test(recipientId)) {
    throw new TypeError('recipientId must match /^[a-z0-9_-]{1,64}$/');
  }
  return `reply+${recipientId}.${replySignature(recipientId, secret, signatureLength)}@${domain}`;
};

/**
 * @param {string} address an address such as one found in a To header; "<...>" and case are ignored
 * @param {{ secret: string, domain: string, signatureLength?: number }} options
 * @returns {string | null} the recipient id when the address is valid and signed, otherwise null
 */
export const verifyReplyAddress = (address, options) => {
  const { secret, domain, signatureLength } = checkOptions(options);
  const value = String(address || '').trim().replace(/^<|>$/g, '').toLowerCase();
  const at = value.lastIndexOf('@');
  if (at <= 0 || value.slice(at + 1) !== domain) return null;

  const match = LOCAL_PART.exec(value.slice(0, at));
  if (!match || match[2].length !== signatureLength) return null;

  const [, recipientId, signature] = match;
  const expected = replySignature(recipientId, secret, signatureLength);
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected)) ? recipientId : null;
};
