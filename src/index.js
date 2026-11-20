import { safeEqual } from './crypto.js';
import { handleEmail } from './inbound.js';
import { ackReplies, deleteAckedBefore, pendingReplies } from './store.js';

const DEFAULT_PULL_LIMIT = 50;
const MAX_PULL_LIMIT = 100;
const MAX_ACK_IDS = 500;
const DEFAULT_RETENTION_DAYS = 7;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
});

const error = (status, message) => json({ error: message }, status);

const isAuthorized = (request, env) =>
  safeEqual(request.headers.get('Authorization') || '', `Bearer ${env.SYNC_TOKEN}`);

const parseLimit = (value) => {
  const limit = Number.parseInt(value, 10);
  if (!Number.isInteger(limit) || limit < 1) return DEFAULT_PULL_LIMIT;
  return Math.min(limit, MAX_PULL_LIMIT);
};

export const retentionDays = (env) => {
  const days = Number.parseInt(env.RETENTION_DAYS, 10);
  return Number.isInteger(days) && days >= 0 ? days : DEFAULT_RETENTION_DAYS;
};

const handlePull = async (request, env) => {
  const limit = parseLimit(new URL(request.url).searchParams.get('limit'));
  return json(await pendingReplies(env.DB, limit));
};

const handleAck = async (request, env) => {
  const body = await request.json().catch(() => null);
  const ids = body && Array.isArray(body.ids) ? body.ids : null;
  if (!ids || ids.length > MAX_ACK_IDS || !ids.every((id) => Number.isSafeInteger(id) && id > 0)) {
    return error(400, `Expected {"ids": [...]} with up to ${MAX_ACK_IDS} positive integer ids`);
  }
  const unique = [...new Set(ids)];
  return json({ acked: await ackReplies(env.DB, unique) });
};

const routes = {
  '/sync/pull': { GET: handlePull },
  '/sync/ack': { POST: handleAck }
};

export default {
  /** Email Routing: a message arrived on the reply domain's catch-all. */
  async email(message, env, ctx) {
    if (!env.REPLY_SECRET || !env.REPLY_DOMAIN) {
      // Fail loudly instead of accepting mail that cannot be verified.
      throw new Error('REPLY_SECRET and REPLY_DOMAIN must be configured');
    }
    await handleEmail(message, env, ctx);
  },

  /** HTTP: the app pulls and acknowledges queued replies. */
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const path = pathname.replace(/\/+$/, '') || '/';

    if (path === '/health' && request.method === 'GET') return json({ ok: true });

    const route = routes[path];
    if (!route) return error(404, 'Not found');
    const handler = route[request.method];
    if (!handler) {
      return new Response(null, { status: 405, headers: { Allow: Object.keys(route).join(', ') } });
    }

    if (!env.SYNC_TOKEN) return error(503, 'SYNC_TOKEN is not configured');
    if (!(await isAuthorized(request, env))) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'WWW-Authenticate': 'Bearer' }
      });
    }
    return handler(request, env);
  },

  /** Cron Trigger: remove acknowledged items after the retention period. */
  async scheduled(controller, env, ctx) {
    const days = retentionDays(env);
    const cleanup = deleteAckedBefore(env.DB, days).then((deleted) => {
      console.log(`Deleted ${deleted} acknowledged item(s) older than ${days} day(s)`);
      return deleted;
    });
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(cleanup);
    return cleanup;
  }
};
