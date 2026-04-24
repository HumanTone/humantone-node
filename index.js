'use strict';

// Official Node.js SDK for the HumanTone API.
// Docs: https://humantone.io/docs/api/
// Source: https://github.com/humantone/humantone-node

const { version } = require('./package.json');

const DEFAULT_BASE_URL = 'https://api.humantone.io';
const DEFAULT_TIMEOUT_MS = 120000;
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

class HumanTone {
  constructor(options = {}) {
    const apiKey = options.apiKey || process.env.HUMANTONE_API_KEY;
    if (!apiKey) {
      throw new HumanToneError(
        'Missing API key. Pass { apiKey } to new HumanTone() or set HUMANTONE_API_KEY. ' +
        'Get a key at https://app.humantone.io/settings/api'
      );
    }
    if (!API_KEY_REGEX.test(apiKey)) {
      throw new HumanToneError(
        'Invalid API key format. Expected "ht_" prefix followed by 64 hex characters.'
      );
    }

    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl || process.env.HUMANTONE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeout = Number.isFinite(options.timeout) ? options.timeout : DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch || globalThis.fetch;
    this.userAgent = options.userAgent || `humantone-node/${version} (node/${process.versions.node})`;

    if (typeof this.fetchImpl !== 'function') {
      throw new HumanToneError(
        'No fetch implementation available. Use Node.js 18+ or pass { fetch } in options.'
      );
    }

    this.account = {
      get: (opts = {}) => this._request('GET', '/v1/account', null, opts),
    };
  }

  async humanize(options = {}) {
    if (typeof options.text !== 'string' || options.text.length === 0) {
      throw new HumanToneError('humanize: "text" is required and must be a non-empty string.');
    }
    if (options.level !== undefined && !HUMANIZATION_LEVELS.includes(options.level)) {
      throw new HumanToneError(`humanize: "level" must be one of: ${HUMANIZATION_LEVELS.join(', ')}.`);
    }
    if (options.outputFormat !== undefined && !OUTPUT_FORMATS.includes(options.outputFormat)) {
      throw new HumanToneError(`humanize: "outputFormat" must be one of: ${OUTPUT_FORMATS.join(', ')}.`);
    }
    if (options.customInstructions !== undefined) {
      if (typeof options.customInstructions !== 'string') {
        throw new HumanToneError('humanize: "customInstructions" must be a string.');
      }
      if (options.customInstructions.length > 1000) {
        throw new HumanToneError('humanize: "customInstructions" must be 1000 characters or fewer.');
      }
    }

    const body = { content: options.text };
    if (options.level !== undefined) body.humanization_level = options.level;
    if (options.outputFormat !== undefined) body.output_format = options.outputFormat;
    if (options.customInstructions !== undefined) body.custom_instructions = options.customInstructions;

    const raw = await this._request('POST', '/v1/humanize', body, { signal: options.signal });
    return {
      text: raw.content,
      outputFormat: raw.outputFormat,
      creditsUsed: raw.creditsUsed,
      requestId: raw.requestId,
    };
  }

  async detect(options = {}) {
    if (typeof options.text !== 'string' || options.text.length === 0) {
      throw new HumanToneError('detect: "text" is required and must be a non-empty string.');
    }

    const raw = await this._request('POST', '/v1/detect', { content: options.text }, { signal: options.signal });

    if (raw.success === false) {
      if (typeof raw.error === 'string' && raw.error.toLowerCase().includes('daily usage limit')) {
        throw new HumanToneError(raw.error, {
          statusCode: 200,
          errorCode: 'daily_limit_exceeded',
          details: { timeToNextRenew: raw.timeToNextRenew },
          retryable: false,
        });
      }
      throw new HumanToneError('Detection service returned no result. Retry the request.', {
        statusCode: 200,
        errorCode: 'detection_failed',
        retryable: true,
      });
    }

    return {
      aiScore: raw.aiScore,
    };
  }

  async _request(method, path, body, { signal } = {}) {
    const url = `${this.baseUrl}${path}`;
    const headers = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Accept': 'application/json',
      'User-Agent': this.userAgent,
    };
    if (body !== null && body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(new Error('timeout')), this.timeout);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }

    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: body !== null && body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        throw new HumanToneError('Request timed out or was aborted.', {
          errorCode: 'timeout',
          retryable: false,
        });
      }
      throw new HumanToneError(`Network error: ${err && err.message ? err.message : 'unknown'}`, {
        errorCode: 'network_error',
        retryable: true,
        details: err,
      });
    }
    clearTimeout(timeoutId);

    let data;
    try {
      data = await response.json();
    } catch {
      throw new HumanToneError(`HTTP ${response.status}: response was not valid JSON.`, {
        statusCode: response.status,
        errorCode: 'invalid_response',
        retryable: response.status >= 500,
      });
    }

    if (!response.ok) {
      const errorMessage = typeof data.error === 'string'
        ? data.error
        : (data.error && data.error.message) || `HTTP ${response.status}`;
      const errorCode = data.error && typeof data.error === 'object' && data.error.code
        ? data.error.code
        : inferErrorCode(response.status, errorMessage);
      throw new HumanToneError(errorMessage, {
        statusCode: response.status,
        requestId: data.request_id,
        errorCode,
        details: data,
        retryable: response.status >= 500 || response.status === 429,
      });
    }

    return snakeToCamel(data);
  }
}

module.exports = HumanTone;
module.exports.HumanTone = HumanTone;
module.exports.HumanToneError = HumanToneError;
module.exports.default = HumanTone;
