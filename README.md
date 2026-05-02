# humantone

Official Node.js SDK for [HumanTone](https://humantone.io), the AI text humanizer API.

Three endpoints, one API key, same credits you already use in the app.

## Install

```bash
npm install humantone
```

Requires Node.js 18 or later. Also works in Bun and AWS Lambda (Node runtime).

## Quickstart

```js
import HumanTone from 'humantone';

const client = new HumanTone({ apiKey: process.env.HUMANTONE_API_KEY });

const result = await client.humanize({
  text: 'Your AI-generated text goes here. Must be at least 30 words.',
  level: 'standard',
  outputFormat: 'text',
});

console.log(result.text);
console.log(`Credits used: ${result.creditsUsed}`);
```

Get an API key at [app.humantone.io/settings/api](https://app.humantone.io/settings/api). Available on all paid plans.

## Endpoints

### Humanize

```js
const result = await client.humanize({
  text: '...',                           // required, min 30 words
  level: 'standard',                      // optional: standard | advanced | extreme
  outputFormat: 'text',                   // optional: html | text | markdown
  customInstructions: 'Keep a formal tone', // optional, max 1000 chars
});
// result.text, result.outputFormat, result.creditsUsed, result.requestId
```

Word limits per request: Basic 750, Standard 1,000, Pro 1,500.

**Output format default.** The SDK sends `output_format: "text"` by default even though the API default is `"html"`. Most callers want plain text. Pass `outputFormat: 'html'` (or `'markdown'`) explicitly to opt back in.

### Detect

```js
const result = await client.detect({ text: '...' });
// result.aiScore (0 to 100)
```

Free. Limited to 30 requests per day, shared between app and API.

### Account

```js
const info = await client.account.get();
// info.plan, info.credits, info.subscription
```

Useful for checking credit balance before a large batch.

## Configuration

```js
new HumanTone({
  apiKey: 'ht_...',                      // required, or set HUMANTONE_API_KEY env var
  baseUrl: 'https://api.humantone.io',   // optional, or HUMANTONE_BASE_URL
  timeout: 120000,                        // optional, milliseconds (default 120000)
  maxRetries: 2,                          // optional, default 2
  retryOnPost: false,                     // optional, default false (see Retries below)
  userAgent: 'my-app/1.2.3',              // optional, appended to default UA
  fetch: globalThis.fetch,                // optional, for testing or custom runtimes
});
```

## Retries

GET requests (`account.get`) retry on 5xx, 429, and network errors up to `maxRetries` (default 2).

POST requests (`humanize`, `detect`) **do not** retry on 5xx or network errors by default. Humanize debits credits, so a blind retry could double-bill. Set `retryOnPost: true` to opt in.

429 always retries on every method, regardless of `retryOnPost`.

The `Retry-After` response header is honored in both numeric seconds (`Retry-After: 30`) and HTTP-date format (`Retry-After: Wed, 21 Oct 2026 07:28:00 GMT`). When absent or unparseable, the SDK falls back to exponential backoff with jitter.

For `detect`, a `200 {success: false}` response with no daily-limit message is treated as a transient backend hiccup and retried automatically (the request is read-only, so retry is safe).

## Error handling

All errors are instances of `HumanToneError` with `statusCode`, `errorCode`, `requestId`, `details`, and `retryable`.

```js
import { HumanTone, HumanToneError } from 'humantone';

try {
  const result = await client.humanize({ text });
} catch (err) {
  if (err instanceof HumanToneError) {
    console.error(`HumanTone error (${err.errorCode}): ${err.message}`);
    if (err.requestId) console.error(`Request ID: ${err.requestId}`);
  } else {
    throw err;
  }
}
```

`errorCode` values group into:

- **Auth and billing:** `missing_api_key`, `invalid_api_key_format`, `authentication_error`, `permission_error`, `insufficient_credits`, `daily_limit_exceeded`
- **Request:** `invalid_request`, `not_found`, `rate_limit`
- **Server and transport:** `api_error`, `network_error`, `timeout`, `invalid_response`, `invalid_response_shape`

> **API keys are never logged.** They never appear in error messages, stack traces, or `details` produced by this SDK.

## Cancellation

All methods accept an `AbortSignal`:

```js
const controller = new AbortController();
setTimeout(() => controller.abort(), 5000);

const result = await client.humanize({
  text: '...',
  signal: controller.signal,
});
```

## Links

- API docs: [humantone.io/docs/api](https://humantone.io/docs/api/)
- Source: [github.com/humantone/humantone-node](https://github.com/humantone/humantone-node)
- Issues: [github.com/humantone/humantone-node/issues](https://github.com/humantone/humantone-node/issues)
- Releases: [github.com/humantone/humantone-node/releases](https://github.com/humantone/humantone-node/releases)
- Author email: dev@humantone.io
- Support: help@humantone.io

## License

MIT. Copyright (c) HumanTone.
