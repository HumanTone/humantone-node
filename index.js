'use strict';

// Official Node.js SDK for the HumanTone API.
// Docs: https://humantone.io/docs/api/
// Source: https://github.com/humantone/humantone-node

const { version } = require('./package.json');

const DEFAULT_BASE_URL = 'https://api.humantone.io';
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_RETRIES = 2;
const API_KEY_REGEX = /^ht_[0-9a-f]{64}$/;

const HUMANIZATION_LEVELS = ['standard', 'advanced', 'extreme'];
const OUTPUT_FORMATS = ['html', 'text', 'markdown'];

class HumanToneError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'HumanToneError';
    this.statusCode = options.statusCode;
    this.requestId = options.requestId;
    this.errorCode = options.errorCode;
    this.details = options.details;
    this.retryable = options.retryable === true;
  }
}

function nonEmptyTrim(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  return t.length > 0 ? t : null;
}

function snakeToCamel(input) {
  if (Array.isArray(input)) return input.map(snakeToCamel);
  if (input && typeof input === 'object' && input.constructor === Object) {
    const out = {};
    for (const key of Object.keys(input)) {
      const camel = key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
      out[camel] = snakeToCamel(input[key]);
    }
    return out;
  }
  return input;
}

function parseRetryAfter(headerValue) {
  if (!headerValue) return 0;
  const v = String(headerValue).trim();
  if (/^\d+$/.test(v)) return Math.max(0, parseInt(v, 10));
  const dateMs = Date.parse(v);
  if (Number.isFinite(dateMs)) return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
  return 0;
}

function computeBackoffMs(attempt, retryAfterSec) {
  if (retryAfterSec > 0) return retryAfterSec * 1000;
  const base = Math.min(2 ** attempt * 250, 30000);
  return base + Math.floor(Math.random() * 250);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      return reject(signal.reason || new Error('aborted'));
    }
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason || new Error('aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function inferErrorCode(statusCode, message) {
  if (statusCode === 401) return 'authentication_error';
  if (statusCode === 403) return 'permission_error';
  if (statusCode === 404) return 'not_found';
  if (statusCode === 405) return 'method_not_allowed';
  if (statusCode === 429) return 'rate_limit';
  if (typeof message === 'string' && message.toLowerCase().includes('not enough credits')) {
    return 'insufficient_credits';
  }
  if (statusCode >= 500) return 'api_error';
  return 'invalid_request';
}

function extractErrorMessage(data, statusCode) {
  if (data && typeof data.error === 'string') return data.error;
  if (data && data.error && typeof data.error.message === 'string') return data.error.message;
  return `HTTP ${statusCode}`;
}

function extractErrorCode(data, statusCode, message) {
  if (data && data.error && typeof data.error === 'object' && typeof data.error.code === 'string') {
    return data.error.code;
  }
  return inferErrorCode(statusCode, message);
}

function resolveRequestId(data, response) {
  if (data && typeof data.request_id === 'string' && data.request_id.length > 0) {
    return data.request_id;
  }
  if (response && response.headers && typeof response.headers.get === 'function') {
    const h = response.headers.get('x-request-id');
    if (typeof h === 'string' && h.length > 0) return h;
  }
  return null;
}

class HumanTone {
  constructor(options = {}) {
    const apiKey =
      nonEmptyTrim(options.apiKey) ?? nonEmptyTrim(process.env.HUMANTONE_API_KEY);
    if (!apiKey) {
      throw new HumanToneError(
        'Missing API key. Pass { apiKey } to new HumanTone() or set HUMANTONE_API_KEY. ' +
          'Get a key at https://app.humantone.io/settings/api',
        { errorCode: 'missing_api_key' }
      );
    }
    if (!API_KEY_REGEX.test(apiKey)) {
      throw new HumanToneError(
        'Invalid API key format. Expected "ht_" prefix followed by 64 hex characters.',
        { errorCode: 'invalid_api_key_format' }
      );
    }

    this.apiKey = apiKey;
    const rawBaseUrl =
      nonEmptyTrim(options.baseUrl) ??
      nonEmptyTrim(process.env.HUMANTONE_BASE_URL) ??
      DEFAULT_BASE_URL;
    this.baseUrl = rawBaseUrl.replace(/\/+$/, '');
    this.timeout =
      Number.isFinite(options.timeout) && options.timeout > 0
        ? options.timeout
        : DEFAULT_TIMEOUT_MS;
    this.maxRetries =
      Number.isInteger(options.maxRetries) && options.maxRetries >= 0
        ? options.maxRetries
        : DEFAULT_MAX_RETRIES;
    this.retryOnPost = options.retryOnPost === true;
    this.fetchImpl = options.fetch || globalThis.fetch;

    const defaultUA = `humantone-node/${version} (node/${process.versions.node})`;
    const customUA = nonEmptyTrim(options.userAgent);
    this.userAgent = customUA ? `${defaultUA} ${customUA}` : defaultUA;

    if (typeof this.fetchImpl !== 'function') {
      throw new HumanToneError(
        'No fetch implementation available. Use Node.js 18+ or pass { fetch } in options.',
        { errorCode: 'invalid_request' }
      );
    }

    this.account = {
      get: async (opts = {}) => {
        const { data, requestId } = await this._request('GET', '/v1/account', null, opts);
        const result = (data && typeof data === 'object' ? snakeToCamel(data) : {}) || {};
        if (!result.requestId) result.requestId = requestId;
        if (result.subscription && result.subscription.expiresAt === undefined) {
          result.subscription.expiresAt = null;
        }
        return result;
      },
    };
  }

  async humanize(options = {}) {
    if (typeof options.text !== 'string' || options.text.length === 0) {
      throw new HumanToneError('humanize: "text" is required and must be a non-empty string.', {
        errorCode: 'invalid_request',
      });
    }
    if (options.level !== undefined && !HUMANIZATION_LEVELS.includes(options.level)) {
      throw new HumanToneError(
        `humanize: "level" must be one of: ${HUMANIZATION_LEVELS.join(', ')}.`,
        { errorCode: 'invalid_request' }
      );
    }
    if (options.outputFormat !== undefined && !OUTPUT_FORMATS.includes(options.outputFormat)) {
      throw new HumanToneError(
        `humanize: "outputFormat" must be one of: ${OUTPUT_FORMATS.join(', ')}.`,
        { errorCode: 'invalid_request' }
      );
    }
    if (options.customInstructions !== undefined) {
      if (typeof options.customInstructions !== 'string') {
        throw new HumanToneError('humanize: "customInstructions" must be a string.', {
          errorCode: 'invalid_request',
        });
      }
      if (options.customInstructions.length > 1000) {
        throw new HumanToneError('humanize: "customInstructions" must be 1000 characters or fewer.', {
          errorCode: 'invalid_request',
        });
      }
    }

    const body = {
      content: options.text,
      output_format: options.outputFormat ?? 'text',
    };
    if (options.level !== undefined) body.humanization_level = options.level;
    if (options.customInstructions !== undefined) body.custom_instructions = options.customInstructions;

    const { data, requestId } = await this._request('POST', '/v1/humanize', body, {
      signal: options.signal,
    });

    if (!data || typeof data.content !== 'string') {
      throw new HumanToneError('Malformed humanize response: missing or invalid "content".', {
        statusCode: 200,
        requestId,
        errorCode: 'invalid_response_shape',
        details: { rawData: data },
        retryable: false,
      });
    }
    if (typeof data.credits_used !== 'number') {
      throw new HumanToneError('Malformed humanize response: missing or invalid "credits_used".', {
        statusCode: 200,
        requestId,
        errorCode: 'invalid_response_shape',
        details: { rawData: data },
        retryable: false,
      });
    }
    if (data.output_format !== undefined && !OUTPUT_FORMATS.includes(data.output_format)) {
      throw new HumanToneError('Malformed humanize response: unknown "output_format".', {
        statusCode: 200,
        requestId,
        errorCode: 'invalid_response_shape',
        details: { rawData: data },
        retryable: false,
      });
    }

    return {
      text: data.content,
      outputFormat: data.output_format,
      creditsUsed: data.credits_used,
      requestId,
    };
  }

  async detect(options = {}) {
    if (typeof options.text !== 'string' || options.text.length === 0) {
      throw new HumanToneError('detect: "text" is required and must be a non-empty string.', {
        errorCode: 'invalid_request',
      });
    }

    const shouldRetryOnSuccess = (data) =>
      Boolean(
        data &&
          data.success === false &&
          !(typeof data.error === 'string' && data.error.toLowerCase().includes('daily usage limit'))
      );

    const { data, requestId } = await this._request(
      'POST',
      '/v1/detect',
      { content: options.text },
      { signal: options.signal, shouldRetryOnSuccess }
    );

    if (data && data.success === false) {
      if (typeof data.error === 'string' && data.error.toLowerCase().includes('daily usage limit')) {
        throw new HumanToneError(data.error, {
          statusCode: 200,
          requestId,
          errorCode: 'daily_limit_exceeded',
          details: { timeToNextRenew: data.time_to_next_renew ?? null },
          retryable: false,
        });
      }
      throw new HumanToneError(
        'Detection service returned no result. The service may be temporarily unavailable.',
        {
          statusCode: 200,
          requestId,
          errorCode: 'detection_failed',
          retryable: true,
        }
      );
    }

    if (!data || typeof data.ai_score !== 'number') {
      throw new HumanToneError('Malformed detect response: "ai_score" must be a number.', {
        statusCode: 200,
        requestId,
        errorCode: 'invalid_response_shape',
        details: { rawData: data },
        retryable: false,
      });
    }

    return { aiScore: data.ai_score };
  }

  async _request(method, path, body, { signal, shouldRetryOnSuccess } = {}) {
    const url = `${this.baseUrl}${path}`;
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
      'User-Agent': this.userAgent,
    };
    const requestBody = body !== null && body !== undefined ? JSON.stringify(body) : undefined;
    if (requestBody !== undefined) headers['Content-Type'] = 'application/json';

    const isPost = method === 'POST';
    const allowFailureRetry = !isPost || this.retryOnPost;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (signal && signal.aborted) {
        throw new HumanToneError('Request aborted.', { errorCode: 'timeout', retryable: false });
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(new Error('timeout')), this.timeout);
      let onUserAbort = null;
      if (signal) {
        if (signal.aborted) controller.abort(signal.reason);
        else {
          onUserAbort = () => controller.abort(signal.reason);
          signal.addEventListener('abort', onUserAbort, { once: true });
        }
      }

      let response = null;
      let networkError = null;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          body: requestBody,
          signal: controller.signal,
        });
      } catch (err) {
        networkError = err;
      } finally {
        clearTimeout(timeoutId);
        if (signal && onUserAbort) signal.removeEventListener('abort', onUserAbort);
      }

      if (signal && signal.aborted) {
        throw new HumanToneError('Request aborted.', { errorCode: 'timeout', retryable: false });
      }

      if (networkError) {
        const isTimeout =
          networkError.name === 'AbortError' || networkError.name === 'TimeoutError';
        const errorCode = isTimeout ? 'timeout' : 'network_error';
        const message = isTimeout
          ? 'Request timed out.'
          : `Network error: ${networkError.message || 'unknown'}`;

        if (allowFailureRetry && attempt < this.maxRetries) {
          await sleep(computeBackoffMs(attempt, 0), signal);
          continue;
        }
        throw new HumanToneError(message, {
          errorCode,
          retryable: true,
          details: isTimeout
            ? undefined
            : { name: networkError.name, message: networkError.message },
        });
      }

      let rawBody = '';
      try {
        rawBody = await response.text();
      } catch (err) {
        const status = response.status;
        const retryable = status >= 500;
        if (retryable && allowFailureRetry && attempt < this.maxRetries) {
          await sleep(
            computeBackoffMs(attempt, parseRetryAfter(response.headers.get('retry-after'))),
            signal
          );
          continue;
        }
        throw new HumanToneError('Failed to read response body.', {
          statusCode: status,
          errorCode: 'invalid_response',
          retryable,
          details: { error: err && err.message },
        });
      }

      let data = null;
      let parseError = null;
      if (rawBody.length > 0) {
        try {
          data = JSON.parse(rawBody);
        } catch (err) {
          parseError = err;
        }
      }

      const requestId = resolveRequestId(data, response);

      if (parseError) {
        const isServerErr = response.status >= 500;
        const canRetry = isServerErr && allowFailureRetry;
        if (canRetry && attempt < this.maxRetries) {
          await sleep(
            computeBackoffMs(attempt, parseRetryAfter(response.headers.get('retry-after'))),
            signal
          );
          continue;
        }
        throw new HumanToneError(`HTTP ${response.status}: response was not valid JSON.`, {
          statusCode: response.status,
          requestId,
          errorCode: 'invalid_response',
          details: { rawBody, parseError: parseError.message },
          retryable: isServerErr,
        });
      }

      if (!response.ok) {
        const status = response.status;
        const message = extractErrorMessage(data, status);
        const errorCode = extractErrorCode(data, status, message);
        const is429 = status === 429;
        const is5xx = status >= 500;
        const shouldRetry = is429 || (is5xx && allowFailureRetry);

        if (shouldRetry && attempt < this.maxRetries) {
          await sleep(
            computeBackoffMs(attempt, parseRetryAfter(response.headers.get('retry-after'))),
            signal
          );
          continue;
        }

        throw new HumanToneError(message, {
          statusCode: status,
          requestId,
          errorCode,
          details: { rawBody, parsed: data },
          retryable: is5xx || is429,
        });
      }

      if (typeof shouldRetryOnSuccess === 'function' && shouldRetryOnSuccess(data)) {
        if (attempt < this.maxRetries) {
          await sleep(
            computeBackoffMs(attempt, parseRetryAfter(response.headers.get('retry-after'))),
            signal
          );
          continue;
        }
      }

      return { data, requestId };
    }

    throw new HumanToneError('Retries exhausted.', { errorCode: 'api_error', retryable: true });
  }
}

module.exports = HumanTone;
module.exports.HumanTone = HumanTone;
module.exports.HumanToneError = HumanToneError;
module.exports.default = HumanTone;
