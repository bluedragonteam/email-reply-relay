import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

/**
 * A minimal D1 binding backed by an in-memory SQLite database (node:sqlite) loaded with the
 * real schema.sql, so the Worker's SQL runs for real in the tests.
 * Implements the subset the Worker uses: prepare().bind().first()/all()/run().
 */
export class FakeD1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec(SCHEMA);
  }

  prepare(sql) {
    return new FakeStatement(this.sqlite, sql, []);
  }

  /** Test convenience: raw query against the database. */
  query(sql, ...params) {
    return this.sqlite.prepare(sql).all(...params).map((row) => ({ ...row }));
  }
}

class FakeStatement {
  constructor(sqlite, sql, params) {
    this.sqlite = sqlite;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new FakeStatement(this.sqlite, this.sql, params);
  }

  async first(column) {
    const row = this.sqlite.prepare(this.sql).get(...this.params);
    if (!row) return null;
    return column ? row[column] : { ...row };
  }

  async all() {
    const results = this.sqlite.prepare(this.sql).all(...this.params).map((row) => ({ ...row }));
    return { success: true, results, meta: {} };
  }

  async run() {
    const result = this.sqlite.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
}

/** A stand-in for Email Routing's ForwardableEmailMessage. */
export const fakeMessage = (to, raw, { from = 'jane@example.org' } = {}) => {
  const bytes = new TextEncoder().encode(raw);
  const calls = { forwarded: [], rejected: null };
  return {
    calls,
    from,
    to,
    rawSize: bytes.byteLength,
    headers: new Headers({ subject: /^Subject: (.*)$/m.exec(raw)?.[1] || '' }),
    raw: new Response(bytes).body,
    async forward(address, headers) {
      calls.forwarded.push({ address, headers: Object.fromEntries(headers || []) });
    },
    setReject(reason) {
      calls.rejected = reason;
    }
  };
};

export const fakeContext = () => {
  const pending = [];
  return {
    pending,
    waitUntil(promise) {
      pending.push(promise);
    },
    settle: () => Promise.all(pending)
  };
};

/** Build a small multipart message: a text part followed by optional base64 attachments. */
export const buildMessage = ({ to, subject = 'Re: Your order', text = 'Thanks, that works for me.', attachments = [] }) => {
  const lines = [
    'From: Jane Doe <jane@example.org>',
    `To: ${to}`,
    `Subject: ${subject}`,
    'Date: Mon, 02 Nov 2026 10:00:00 +0000',
    'Message-ID: <reply-1@example.org>',
    'In-Reply-To: <original-1@example.com>',
    'References: <original-1@example.com>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="sep"',
    '',
    '--sep',
    'Content-Type: text/plain; charset=utf-8',
    '',
    text
  ];
  for (const file of attachments) {
    lines.push(
      '--sep',
      `Content-Type: ${file.type || 'application/octet-stream'}; name="${file.name}"`,
      `Content-Disposition: attachment; filename="${file.name}"`,
      'Content-Transfer-Encoding: base64',
      '',
      file.base64
    );
  }
  lines.push('--sep--', '');
  return lines.join('\r\n');
};

export const SECRET = 'test-reply-secret';
export const SYNC_TOKEN = 'test-sync-token';

export const testEnv = (overrides = {}) => ({
  REPLY_SECRET: SECRET,
  REPLY_DOMAIN: 'reply.example.com',
  FORWARD_TO: 'inbox@example.net',
  SYNC_TOKEN,
  DB: new FakeD1(),
  ...overrides
});
