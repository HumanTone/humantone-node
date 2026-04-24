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
  fetch: globalThis.fetch,                // optional, for testing or custom runtimes
});
```

## Error handling

All errors are instances of `HumanToneError` and expose `statusCode`, `errorCode`, `requestId`, `details`, and `retryable`.

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

Common error codes: `authentication_error`, `permission_error`, `insufficient_credits`, `daily_limit_exceeded`, `rate_limit`, `invalid_request`, `not_found`, `api_error`, `network_error`, `timeout`.

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

## Releases

Early release (v0.0.x). Track updates on [GitHub](https://github.com/humantone/humantone-node/releases).

## Links

- API docs: [humantone.io/docs/api](https://humantone.io/docs/api/)
- Source: [github.com/humantone/humantone-node](https://github.com/humantone/humantone-node)
- Issues: [github.com/humantone/humantone-node/issues](https://github.com/humantone/humantone-node/issues)
- Author email: dev@humantone.io
- Support: help@humantone.io

## License

MIT. Copyright (c) HumanTone.
