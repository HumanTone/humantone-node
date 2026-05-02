'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const HumanTone = require('..');
const { HumanToneError } = HumanTone;

const VALID_KEY = 'ht_' + 'a'.repeat(64);

function makeResponse({ status = 200, body = '', headers = {} } = {}) {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (lower.has(String(k).toLowerCase()) ? lower.get(String(k).toLowerCase()) : null) },
    text: async () => text,
  };
}

function mockFetch(responses, calls = []) {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (queue.length === 0) throw new Error('mockFetch: no more responses queued');
    const next = queue.shift();
    if (next instanceof Error) throw next;
    if (next && next.__throw) throw next.__throw;
    return makeResponse(next);
  };
  fn.calls = calls;
  return fn;
}

const ENV_SNAPSHOT = {};
beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('HUMANTONE_')) {
      ENV_SNAPSHOT[k] = process.env[k];
      delete process.env[k];
    }
  }
});
afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('HUMANTONE_')) delete process.env[k];
  }
  for (const [k, v] of Object.entries(ENV_SNAPSHOT)) process.env[k] = v;
  for (const k of Object.keys(ENV_SNAPSHOT)) delete ENV_SNAPSHOT[k];
});

// -------------------- Constructor --------------------

test('constructor: missing apiKey + missing env → errorCode missing_api_key', () => {
  assert.throws(
    () => new HumanTone(),
    (err) => err instanceof HumanToneError && err.errorCode === 'missing_api_key'
  );
});

test('constructor: empty string apiKey falls through to env', () => {
  process.env.HUMANTONE_API_KEY = VALID_KEY;
  const c = new HumanTone({ apiKey: '' });
  assert.equal(c.apiKey, VALID_KEY);
});

test('constructor: empty env apiKey → missing_api_key', () => {
  process.env.HUMANTONE_API_KEY = '';
  assert.throws(
    () => new HumanTone(),
    (err) => err.errorCode === 'missing_api_key'
  );
});

test('constructor: whitespace-only env apiKey → missing_api_key (not invalid_format)', () => {
  process.env.HUMANTONE_API_KEY = '   ';
  assert.throws(
    () => new HumanTone(),
    (err) => err.errorCode === 'missing_api_key'
  );
});

test('constructor: malformed apiKey → invalid_api_key_format', () => {
  assert.throws(
    () => new HumanTone({ apiKey: 'abc' }),
    (err) => err instanceof HumanToneError && err.errorCode === 'invalid_api_key_format'
  );
});

test('constructor: empty HUMANTONE_BASE_URL → falls back to default', () => {
  process.env.HUMANTONE_BASE_URL = '';
  const c = new HumanTone({ apiKey: VALID_KEY });
  assert.equal(c.baseUrl, 'https://api.humantone.io');
});

test('constructor: custom userAgent appended to default with single space', () => {
  const c = new HumanTone({ apiKey: VALID_KEY, userAgent: 'my-app/1.2.3' });
  assert.match(c.userAgent, /^humantone-node\/\S+ \(node\/\S+\) my-app\/1\.2\.3$/);
});

test('constructor: whitespace userAgent → ignored, default only', () => {
  const c = new HumanTone({ apiKey: VALID_KEY, userAgent: '   ' });
  assert.match(c.userAgent, /^humantone-node\/\S+ \(node\/\S+\)$/);
});

test('constructor: maxRetries and retryOnPost defaults', () => {
  const c = new HumanTone({ apiKey: VALID_KEY });
  assert.equal(c.maxRetries, 2);
  assert.equal(c.retryOnPost, false);
});

// -------------------- Error fallback chain (§1) --------------------

test('error: 401 with unknown message → authentication_error', async () => {
  const fetch = mockFetch([{ status: 401, body: { error: 'Unrecognized message' } }]);
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 0 });
  await assert.rejects(c.account.get(), (err) => err.errorCode === 'authentication_error' && err.statusCode === 401);
});

test('error: 403 with unknown message → permission_error', async () => {
  const fetch = mockFetch([{ status: 403, body: { error: 'Some new permission message' } }]);
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 0 });
  await assert.rejects(c.account.get(), (err) => err.errorCode === 'permission_error');
});

test('error: 404 → not_found', async () => {
  const fetch = mockFetch([{ status: 404, body: { error: 'Resource gone' } }]);
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 0 });
  await assert.rejects(c.account.get(), (err) => err.errorCode === 'not_found');
});

test('error: 429 → rate_limit', async () => {
  const fetch = mockFetch([
    { status: 429, body: { error: 'Slow down' } },
    { status: 429, body: { error: 'Slow down' } },
  ]);
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 1 });
  await assert.rejects(c.account.get(), (err) => err.errorCode === 'rate_limit' && err.retryable === true);
});

test('error: 500 → api_error', async () => {
  const fetch = mockFetch([{ status: 500, body: { error: 'oops' } }]);
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 0 });
  await assert.rejects(c.account.get(), (err) => err.errorCode === 'api_error');
});

// -------------------- request_id resolution (§2) --------------------

test('request_id: body.request_id wins over header', async () => {
  const fetch = mockFetch([
    {
      status: 200,
      body: { request_id: 'body-id', plan: { id: 'p1' } },
      headers: { 'x-request-id': 'header-id' },
    },
  ]);
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 0 });
  const info = await c.account.get();
  assert.equal(info.requestId, 'body-id');
});

test('request_id: X-Request-Id header used when body lacks it', async () => {
  const fetch = mockFetch([
    {
      status: 200,
      body: { plan: { id: 'p1' } },
      headers: { 'x-request-id': 'header-id' },
    },
  ]);
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 0 });
  const info = await c.account.get();
  assert.equal(info.requestId, 'header-id');
});

test('request_id: null when neither body nor header has it', async () => {
  const fetch = mockFetch([{ status: 200, body: { plan: { id: 'p1' } } }]);
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 0 });
  const info = await c.account.get();
  assert.equal(info.requestId, null);
});

test('request_id: nested body.error.request_id is NOT consulted', async () => {
  const fetch = mockFetch([
    {
      status: 401,
      body: { error: { message: 'auth', request_id: 'wrong-path' } },
      headers: { 'x-request-id': 'right-path' },
    },
  ]);
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 0 });
  await assert.rejects(c.account.get(), (err) => err.requestId === 'right-path');
});

// -------------------- JSON parse failure (§9) --------------------

test('parse: 5xx with HTML body → invalid_response, retryable=true, rawBody preserved', async () => {
  const html = '<html>500 Internal Server Error</html>';
  const fetch = mockFetch([{ status: 500, body: html }]);
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 0 });
  await assert.rejects(c.account.get(), (err) => {
    return (
      err.errorCode === 'invalid_response' &&
      err.retryable === true &&
      err.details &&
      err.details.rawBody === html &&
      typeof err.details.parseError === 'string'
    );
  });
});

test('parse: 200 with non-JSON body → invalid_response, retryable=false, rawBody preserved', async () => {
  const fetch = mockFetch([{ status: 200, body: 'not-json' }]);
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 0 });
  await assert.rejects(c.account.get(), (err) => {
    return (
      err.errorCode === 'invalid_response' &&
      err.retryable === false &&
      err.details.rawBody === 'not-json'
    );
  });
});

// -------------------- Retry matrix (§3, §13, §15) --------------------

test('retry: GET 500 retries up to maxRetries, then throws', async () => {
  const calls = [];
  const fetch = mockFetch(
    [
      { status: 500, body: { error: 'a' } },
      { status: 500, body: { error: 'b' } },
    ],
    calls
  );
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 1 });
  await assert.rejects(c.account.get(), (err) => err.statusCode === 500);
  assert.equal(calls.length, 2);
});

test('retry: GET succeeds after one 500', async () => {
  const calls = [];
  const fetch = mockFetch(
    [{ status: 500, body: { error: 'a' } }, { status: 200, body: { plan: { id: 'p' } } }],
    calls
  );
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 1 });
  const info = await c.account.get();
  assert.equal(info.plan.id, 'p');
  assert.equal(calls.length, 2);
});

test('retry: POST 500 does NOT retry by default (humanize)', async () => {
  const calls = [];
  const fetch = mockFetch([{ status: 500, body: { error: 'oops' } }], calls);
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 2 });
  await assert.rejects(
    c.humanize({ text: 'hi there' }),
    (err) => err.statusCode === 500
  );
  assert.equal(calls.length, 1);
});

test('retry: POST 500 retries with retryOnPost=true', async () => {
  const calls = [];
  const fetch = mockFetch(
    [
      { status: 500, body: { error: 'a' } },
      {
        status: 200,
        body: { content: 'humanized', credits_used: 1, output_format: 'text', request_id: 'r1' },
      },
    ],
    calls
  );
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 1, retryOnPost: true });
  const r = await c.humanize({ text: 'hi' });
  assert.equal(r.text, 'humanized');
  assert.equal(calls.length, 2);
});

test('retry: 429 always retries on POST regardless of retryOnPost', async () => {
  const calls = [];
  const fetch = mockFetch(
    [
      { status: 429, body: { error: 'slow' } },
      {
        status: 200,
        body: { content: 'ok', credits_used: 1, output_format: 'text' },
      },
    ],
    calls
  );
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 1, retryOnPost: false });
  const r = await c.humanize({ text: 'hi' });
  assert.equal(r.text, 'ok');
  assert.equal(calls.length, 2);
});

test('retry: 4xx (not 429) never retries', async () => {
  const calls = [];
  const fetch = mockFetch([{ status: 400, body: { error: 'bad' } }], calls);
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 5 });
  await assert.rejects(c.account.get(), (err) => err.statusCode === 400);
  assert.equal(calls.length, 1);
});

test('retry: Retry-After numeric (1) honoured', async () => {
  const calls = [];
  const start = Date.now();
  const fetch = mockFetch(
    [
      { status: 429, body: { error: 'slow' }, headers: { 'retry-after': '1' } },
      { status: 200, body: { plan: { id: 'p' } } },
    ],
    calls
  );
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 1 });
  await c.account.get();
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 950, `expected ~1s wait, got ${elapsed}ms`);
});

test('retry: Retry-After HTTP-date in near future honoured', async () => {
  const calls = [];
  const future = new Date(Date.now() + 1100).toUTCString();
  const start = Date.now();
  const fetch = mockFetch(
    [
      { status: 429, body: { error: 'slow' }, headers: { 'retry-after': future } },
      { status: 200, body: { plan: { id: 'p' } } },
    ],
    calls
  );
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 1 });
  await c.account.get();
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 900, `expected ~1s wait, got ${elapsed}ms`);
});

test('retry: Retry-After garbage falls back to backoff (no throw)', async () => {
  const calls = [];
  const fetch = mockFetch(
    [
      { status: 429, body: { error: 'slow' }, headers: { 'retry-after': 'banana' } },
      { status: 200, body: { plan: { id: 'p' } } },
    ],
    calls
  );
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 1 });
  const r = await c.account.get();
  assert.equal(r.plan.id, 'p');
  assert.equal(calls.length, 2);
});

test('retry: network error on POST default → no retry', async () => {
  const calls = [];
  const fetch = mockFetch([new Error('ECONNREFUSED')], calls);
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 2 });
  await assert.rejects(c.humanize({ text: 'hi' }), (err) => err.errorCode === 'network_error');
  assert.equal(calls.length, 1);
});

test('retry: network error on GET retries', async () => {
  const calls = [];
  const fetch = mockFetch(
    [new Error('ECONNREFUSED'), { status: 200, body: { plan: { id: 'p' } } }],
    calls
  );
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 1 });
  await c.account.get();
  assert.equal(calls.length, 2);
});

// -------------------- detect (§8.1, §10, §15) --------------------

test('detect: 200 success:false (no daily) retries, then throws detection_failed', async () => {
  const calls = [];
  const fetch = mockFetch(
    [
      { status: 200, body: { success: false } },
      { status: 200, body: { success: false } },
    ],
    calls
  );
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 1 });
  await assert.rejects(
    c.detect({ text: 'hi' }),
    (err) => err.errorCode === 'detection_failed' && err.retryable === true && err.statusCode === 200
  );
  assert.equal(calls.length, 2);
});

test('detect: 200 success:false with daily limit → DailyLimitExceeded, no retry, statusCode 200', async () => {
  const calls = [];
  const fetch = mockFetch(
    [{ status: 200, body: { success: false, error: 'Daily usage limit exceeded', time_to_next_renew: 3600 } }],
    calls
  );
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 5 });
  await assert.rejects(c.detect({ text: 'hi' }), (err) => {
    return (
      err.errorCode === 'daily_limit_exceeded' &&
      err.statusCode === 200 &&
      err.retryable === false &&
      err.details.timeToNextRenew === 3600
    );
  });
  assert.equal(calls.length, 1);
});

test('detect: ai_score as string → invalid_response_shape, no retry', async () => {
  const calls = [];
  const fetch = mockFetch([{ status: 200, body: { success: true, ai_score: 'not-a-number' } }], calls);
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 5 });
  await assert.rejects(c.detect({ text: 'hi' }), (err) => err.errorCode === 'invalid_response_shape');
  assert.equal(calls.length, 1);
});

test('detect: success:true + ai_score → returns aiScore', async () => {
  const fetch = mockFetch([{ status: 200, body: { success: true, ai_score: 42 } }]);
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 0 });
  const r = await c.detect({ text: 'hi' });
  assert.equal(r.aiScore, 42);
});

test('detect: no success field + ai_score → returns aiScore (forward-compat)', async () => {
  const fetch = mockFetch([{ status: 200, body: { ai_score: 33 } }]);
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 0 });
  const r = await c.detect({ text: 'hi' });
  assert.equal(r.aiScore, 33);
});

// -------------------- humanize (§6, §7, §8) --------------------

test('humanize: default outputFormat → request body sends "text"', async () => {
  const calls = [];
  const fetch = mockFetch(
    [{ status: 200, body: { content: 'out', credits_used: 1, output_format: 'text' } }],
    calls
  );
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 0 });
  await c.humanize({ text: 'hi' });
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.output_format, 'text');
  assert.equal(sent.content, 'hi');
});

test('humanize: explicit outputFormat=html → request body sends "html"', async () => {
  const calls = [];
  const fetch = mockFetch(
    [{ status: 200, body: { content: '<p>out</p>', credits_used: 1, output_format: 'html' } }],
    calls
  );
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 0 });
  await c.humanize({ text: 'hi', outputFormat: 'html' });
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.output_format, 'html');
});

test('humanize: rename text → content on request, content → text on response', async () => {
  const calls = [];
  const fetch = mockFetch(
    [{ status: 200, body: { content: 'humanized text', credits_used: 1, output_format: 'text' } }],
    calls
  );
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 0 });
  const r = await c.humanize({ text: 'original' });
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.content, 'original');
  assert.equal(r.text, 'humanized text');
});

test('humanize: response request_id from body wins', async () => {
  const fetch = mockFetch(
    [
      {
        status: 200,
        body: { content: 'x', credits_used: 1, output_format: 'text', request_id: 'body-r' },
        headers: { 'x-request-id': 'header-r' },
      },
    ]
  );
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 0 });
  const r = await c.humanize({ text: 'hi' });
  assert.equal(r.requestId, 'body-r');
});

test('humanize: response without request_id, header present → uses header', async () => {
  const fetch = mockFetch(
    [
      {
        status: 200,
        body: { content: 'x', credits_used: 1, output_format: 'text' },
        headers: { 'x-request-id': 'header-r' },
      },
    ]
  );
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 0 });
  const r = await c.humanize({ text: 'hi' });
  assert.equal(r.requestId, 'header-r');
});

test('humanize: response missing content → invalid_response_shape', async () => {
  const fetch = mockFetch([{ status: 200, body: { credits_used: 1, output_format: 'text' } }]);
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 0 });
  await assert.rejects(c.humanize({ text: 'hi' }), (err) => err.errorCode === 'invalid_response_shape');
});

test('humanize: response credits_used as string → invalid_response_shape', async () => {
  const fetch = mockFetch(
    [{ status: 200, body: { content: 'x', credits_used: '1', output_format: 'text' } }]
  );
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 0 });
  await assert.rejects(c.humanize({ text: 'hi' }), (err) => err.errorCode === 'invalid_response_shape');
});

test('humanize: unknown output_format in response → invalid_response_shape', async () => {
  const fetch = mockFetch(
    [{ status: 200, body: { content: 'x', credits_used: 1, output_format: 'csv' } }]
  );
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 0 });
  await assert.rejects(c.humanize({ text: 'hi' }), (err) => err.errorCode === 'invalid_response_shape');
});

// -------------------- account.get (§7, §8.4) --------------------

test('account.get: snake_case fields converted to camelCase', async () => {
  const fetch = mockFetch([
    {
      status: 200,
      body: {
        plan: { id: 'pro', name: 'Pro', max_words: 1500, monthly_credits: 100, api_access: true },
        credits: { trial: 0, subscription: 50, extra: 10, total: 60 },
        subscription: { active: true, expires_at: '2026-12-01' },
      },
    },
  ]);
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 0 });
  const r = await c.account.get();
  assert.equal(r.plan.maxWords, 1500);
  assert.equal(r.plan.apiAccess, true);
  assert.equal(r.subscription.expiresAt, '2026-12-01');
});

test('account.get: subscription.expires_at missing → expiresAt is null', async () => {
  const fetch = mockFetch([
    {
      status: 200,
      body: {
        plan: { id: 'free' },
        credits: { trial: 5, subscription: 0, extra: 0, total: 5 },
        subscription: { active: false },
      },
    },
  ]);
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 0 });
  const r = await c.account.get();
  assert.equal(r.subscription.expiresAt, null);
});

// -------------------- Authorization header --------------------

test('request: Authorization header carries Bearer token', async () => {
  const calls = [];
  const fetch = mockFetch([{ status: 200, body: { plan: { id: 'p' } } }], calls);
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 0 });
  await c.account.get();
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${VALID_KEY}`);
});

test('request: User-Agent header sent', async () => {
  const calls = [];
  const fetch = mockFetch([{ status: 200, body: { plan: { id: 'p' } } }], calls);
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 0 });
  await c.account.get();
  assert.match(calls[0].init.headers['User-Agent'], /^humantone-node\//);
});

// -------------------- API key never leaked in errors --------------------

test('errors: apiKey does not appear in error message, details, or stack', async () => {
  const fetch = mockFetch([{ status: 401, body: { error: 'auth fail' } }]);
  const c = new HumanTone({ apiKey: VALID_KEY, fetch, maxRetries: 0 });
  let caught = null;
  try {
    await c.account.get();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught);
  const haystack = JSON.stringify({
    message: caught.message,
    details: caught.details,
    stack: caught.stack,
  });
  assert.ok(!haystack.includes(VALID_KEY), 'API key leaked into error');
});
