// Type definitions for humantone
// Official Node.js SDK for the HumanTone API
// Docs: https://humantone.io/docs/api/

export type HumanizationLevel = 'standard' | 'advanced' | 'extreme';
export type OutputFormat = 'html' | 'text' | 'markdown';

export type HumanToneErrorCode =
  | 'missing_api_key'
  | 'invalid_api_key_format'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found'
  | 'method_not_allowed'
  | 'rate_limit'
  | 'insufficient_credits'
  | 'daily_limit_exceeded'
  | 'detection_failed'
  | 'invalid_request'
  | 'invalid_response'
  | 'invalid_response_shape'
  | 'api_error'
  | 'network_error'
  | 'timeout';

export interface HumanToneOptions {
  /** API key. Get one at https://app.humantone.io/settings/api. Falls back to HUMANTONE_API_KEY env var. */
  apiKey?: string;
  /** Base URL override. Defaults to https://api.humantone.io. Can also be set via HUMANTONE_BASE_URL. */
  baseUrl?: string;
  /** Request timeout in milliseconds. Defaults to 120000 (120 seconds). */
  timeout?: number;
  /** Maximum retry attempts. Default 2. Set to 0 to disable retries. */
  maxRetries?: number;
  /**
   * Opt-in: retry POST requests (`humanize`, `detect`) on 5xx and network errors.
   * Default false because POST endpoints are not idempotent — humanize debits credits, so blind retry could double-bill.
   * 429 is always retried regardless of this setting.
   */
  retryOnPost?: boolean;
  /** Custom fetch implementation. Defaults to globalThis.fetch (Node 18+). */
  fetch?: typeof fetch;
  /** Custom User-Agent suffix appended to the default `humantone-node/<version> (node/<node-version>)` with a single space. */
  userAgent?: string;
}

export interface HumanizeOptions {
  /** Text to humanize. Minimum 30 words. Max depends on plan. */
  text: string;
  /** Humanization strength. Default "standard". "advanced" and "extreme" are English-only. */
  level?: HumanizationLevel;
  /** Output format. SDK defaults to "text" (overrides API default of "html"). */
  outputFormat?: OutputFormat;
  /** Free-form instructions for the rewrite. Max 1000 characters. */
  customInstructions?: string;
  /** Cancel the request. */
  signal?: AbortSignal;
}

export interface HumanizeResult {
  /** Humanized text in the requested format. */
  text: string;
  /** Echo of the requested output format. */
  outputFormat: OutputFormat;
  /** Credits deducted for this request. 1 credit = 100 words. */
  creditsUsed: number;
  /** Unique request ID. Resolved from response body or `X-Request-Id` header; null if neither is present. */
  requestId: string | null;
}

export interface DetectOptions {
  /** Text to analyze for AI likelihood. */
  text: string;
  /** Cancel the request. */
  signal?: AbortSignal;
}

export interface DetectResult {
  /** AI likelihood score from 0 to 100. Higher means more AI patterns detected. */
  aiScore: number;
}

export interface AccountOptions {
  /** Cancel the request. */
  signal?: AbortSignal;
}

export interface AccountInfo {
  plan: {
    id: string;
    name: string;
    maxWords: number;
    monthlyCredits: number;
    apiAccess: boolean;
  };
  credits: {
    trial: number;
    subscription: number;
    extra: number;
    total: number;
  };
  subscription: {
    active: boolean;
    /** ISO timestamp when subscription expires. May be null if no subscription. */
    expiresAt: string | null;
  };
  /** Resolved request ID for this response (body or `X-Request-Id` header). */
  requestId?: string | null;
}

export interface HumanToneErrorOptions {
  statusCode?: number;
  requestId?: string | null;
  errorCode?: HumanToneErrorCode | string;
  details?: unknown;
  retryable?: boolean;
}

export class HumanToneError extends Error {
  readonly name: 'HumanToneError';
  readonly statusCode?: number;
  readonly requestId?: string | null;
  readonly errorCode?: HumanToneErrorCode | string;
  readonly details?: unknown;
  readonly retryable: boolean;
  constructor(message: string, options?: HumanToneErrorOptions);
}

export class HumanTone {
  constructor(options?: HumanToneOptions);

  /**
   * Rewrites AI-generated text to reduce AI-detection patterns.
   * @see https://humantone.io/docs/api/#humanize
   */
  humanize(options: HumanizeOptions): Promise<HumanizeResult>;

  /**
   * Returns an AI likelihood score (0 to 100).
   * Free. Limited to 30 requests per day per account (shared between app and API).
   * @see https://humantone.io/docs/api/#detect
   */
  detect(options: DetectOptions): Promise<DetectResult>;

  /**
   * Account, plan, and credit balance.
   * @see https://humantone.io/docs/api/#account
   */
  account: {
    get(options?: AccountOptions): Promise<AccountInfo>;
  };
}

export default HumanTone;
