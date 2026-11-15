import { describe, it, expect, vi } from 'vitest';
import { postJsonWithRetry, NonRetryableError } from '../src/lib/http';

const res = (status: number, headers: Record<string, string> = {}) => new Response(status === 204 ? null : '{}', { status, headers });
const noSleep = vi.fn(async () => {});

describe('postJsonWithRetry', () => {
  it('retries 503 and network errors, then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res(503))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(res(200));
    const r = await postJsonWithRetry('https://api.test/x', { a: 1 }, { fetchImpl, sleep: noSleep });
    expect(r.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('honours Retry-After on 429', async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi.fn().mockResolvedValueOnce(res(429, { 'retry-after': '2' })).mockResolvedValueOnce(res(200));
    await postJsonWithRetry('https://api.test/x', {}, { fetchImpl, sleep });
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('does not retry a 422 and throws NonRetryableError', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(422));
    await expect(postJsonWithRetry('https://api.test/x', {}, { fetchImpl, sleep: noSleep })).rejects.toBeInstanceOf(NonRetryableError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxAttempts', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(500));
    await expect(postJsonWithRetry('https://api.test/x', {}, { fetchImpl, sleep: noSleep, maxAttempts: 3 })).rejects.toThrow('500');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('sends JSON with the idempotency header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(200));
    await postJsonWithRetry('https://api.test/x', { a: 1 }, { fetchImpl, headers: { 'idempotency-key': 'evt_1' } });
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init.headers).toMatchObject({ 'content-type': 'application/json', 'idempotency-key': 'evt_1' });
    expect(init.body).toBe('{"a":1}');
  });
});
