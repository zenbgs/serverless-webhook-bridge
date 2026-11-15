/** Errors that retrying won't fix (e.g. 400/401/422 from the downstream API). */
export class NonRetryableError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * POSTs JSON with exponential backoff + full jitter.
 * Retries network errors and 408/425/429/5xx; honours Retry-After (seconds) when present.
 */
export async function postJsonWithRetry(url: string, body: unknown, opts: RetryOptions = {}): Promise<Response> {
  const {
    maxAttempts = 4,
    baseDelayMs = 200,
    maxDelayMs = 5_000,
    headers = {},
    fetchImpl = fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    random = Math.random,
  } = opts;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response | undefined;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      lastError = err; // network error / timeout -> retry
    }

    if (res) {
      if (res.ok) return res;
      if (!RETRYABLE.has(res.status)) {
        throw new NonRetryableError(`Downstream rejected request with ${res.status}`, res.status);
      }
      lastError = new Error(`Downstream returned ${res.status}`);
    }

    if (attempt === maxAttempts) break;
    const retryAfter = Number(res?.headers.get('retry-after'));
    const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(maxDelayMs, retryAfter * 1000) : random() * backoff;
    await sleep(delay);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
