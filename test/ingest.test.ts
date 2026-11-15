import { describe, it, expect, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createIngestHandler } from '../src/ingest';
import { sign } from '../src/lib/signature';

const SECRET = 'whsec_test';
const NOW = 1_763_200_000_000; // fixed clock
const t = Math.floor(NOW / 1000);

const validEvent = {
  id: 'evt_123',
  type: 'order.created',
  created_at: '2026-11-15T08:00:00Z',
  data: { order_id: 'ord_9', customer_email: 'a@example.com', total: 42.5, currency: 'usd' },
};

function request(body: string, signature?: string): APIGatewayProxyEventV2 {
  return {
    body,
    isBase64Encoded: false,
    headers: signature ? { 'x-signature': signature } : {},
    requestContext: { requestId: 'req-1' },
  } as unknown as APIGatewayProxyEventV2;
}

function setup() {
  const deps = {
    getSecret: vi.fn(async () => SECRET),
    archive: vi.fn(async () => {}),
    enqueue: vi.fn(async () => {}),
    now: () => NOW,
  };
  return { deps, handler: createIngestHandler(deps) };
}

describe('ingest handler', () => {
  it('accepts a signed, valid event: archives the raw body and enqueues it', async () => {
    const { deps, handler } = setup();
    const body = JSON.stringify(validEvent);
    const res = await handler(request(body, `t=${t},v1=${sign(body, SECRET, t)}`));

    expect(res.statusCode).toBe(202);
    expect(deps.archive).toHaveBeenCalledWith('raw/2026/11/15/evt_123.json', body);
    expect(deps.enqueue).toHaveBeenCalledWith(expect.stringContaining('"id":"evt_123"'), 'evt_123');
  });

  it('rejects a missing or wrong signature with 401 and stores nothing', async () => {
    const { deps, handler } = setup();
    const body = JSON.stringify(validEvent);
    expect((await handler(request(body))).statusCode).toBe(401);
    expect((await handler(request(body, `t=${t},v1=${sign(body, 'wrong', t)}`))).statusCode).toBe(401);
    expect(deps.archive).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it('rejects a replayed request with an old timestamp', async () => {
    const { handler } = setup();
    const body = JSON.stringify(validEvent);
    const old = t - 3600;
    expect((await handler(request(body, `t=${old},v1=${sign(body, SECRET, old)}`))).statusCode).toBe(401);
  });

  it('returns 422 with readable issues when the payload breaks the contract', async () => {
    const { deps, handler } = setup();
    const body = JSON.stringify({ ...validEvent, data: { ...validEvent.data, total: -1 } });
    const res = await handler(request(body, `t=${t},v1=${sign(body, SECRET, t)}`));

    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body as string).issues[0]).toMatch(/^data\.total/);
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it('returns 400 for a body that is not JSON', async () => {
    const { handler } = setup();
    const body = 'not-json';
    expect((await handler(request(body, `t=${t},v1=${sign(body, SECRET, t)}`))).statusCode).toBe(400);
  });
});
