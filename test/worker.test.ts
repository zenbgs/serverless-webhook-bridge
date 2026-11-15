import { describe, it, expect, vi } from 'vitest';
import type { SQSEvent } from 'aws-lambda';
import { createWorkerHandler, type WorkerDeps } from '../src/worker';
import { NonRetryableError } from '../src/lib/http';
import { toDownstream } from '../src/lib/schema';

const evt = (id: string) => ({
  id,
  type: 'order.updated',
  created_at: '2026-11-15T08:00:00Z',
  data: { order_id: `ord_${id}`, total: 10, currency: 'eur' },
});

const batch = (...bodies: string[]): SQSEvent =>
  ({ Records: bodies.map((body, i) => ({ messageId: `m${i + 1}`, body })) }) as unknown as SQSEvent;

function setup(overrides: Partial<WorkerDeps> = {}) {
  const claimed = new Set<string>();
  const deps: WorkerDeps = {
    claim: vi.fn(async (id: string) => (claimed.has(id) ? false : (claimed.add(id), true))),
    complete: vi.fn(async () => {}),
    release: vi.fn(async (id: string) => void claimed.delete(id)),
    deliver: vi.fn(async () => {}),
    ...overrides,
  };
  return { deps, handler: createWorkerHandler(deps) };
}

describe('worker handler', () => {
  it('delivers each event once and reports no failures', async () => {
    const { deps, handler } = setup();
    const res = await handler(batch(JSON.stringify(evt('a')), JSON.stringify(evt('b'))));
    expect(res.batchItemFailures).toEqual([]);
    expect(deps.deliver).toHaveBeenCalledTimes(2);
    expect(deps.complete).toHaveBeenCalledTimes(2);
  });

  it('skips a duplicate event (same id delivered twice by the provider)', async () => {
    const { deps, handler } = setup();
    await handler(batch(JSON.stringify(evt('dup')), JSON.stringify(evt('dup'))));
    expect(deps.deliver).toHaveBeenCalledTimes(1);
  });

  it('reports only the failed message, and releases its claim so a retry can process it', async () => {
    const deliver = vi.fn(async (e: { id: string }) => {
      if (e.id === 'bad') throw new Error('Downstream returned 503');
    });
    const { deps, handler } = setup({ deliver });
    const res = await handler(batch(JSON.stringify(evt('ok')), JSON.stringify(evt('bad'))));

    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm2' }]);
    expect(deps.release).toHaveBeenCalledWith('bad');
    // next SQS delivery of the same message can claim it again
    expect(await deps.claim('bad')).toBe(true);
  });

  it('fails malformed messages without touching the downstream API', async () => {
    const { deps, handler } = setup();
    const res = await handler(batch('{"id": 1}'));
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }]);
    expect(deps.deliver).not.toHaveBeenCalled();
  });

  it('marks permanent downstream rejections as failures (they end up in the DLQ)', async () => {
    const { handler } = setup({ deliver: vi.fn(async () => { throw new NonRetryableError('422', 422); }) });
    const res = await handler(batch(JSON.stringify(evt('x'))));
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }]);
  });
});

describe('toDownstream mapping', () => {
  it('maps the provider shape to our API contract', () => {
    expect(toDownstream(evt('a') as never)).toEqual({
      externalEventId: 'a',
      action: 'updated',
      orderId: 'ord_a',
      customerEmail: null,
      amount: { value: 10, currency: 'EUR' },
      occurredAt: '2026-11-15T08:00:00Z',
    });
  });
});
