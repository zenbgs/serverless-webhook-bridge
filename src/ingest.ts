import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { verifySignature } from './lib/signature';
import { OrderEvent } from './lib/schema';
import { log } from './lib/log';

export interface IngestDeps {
  getSecret: () => Promise<string>;
  archive: (key: string, body: string) => Promise<void>;
  enqueue: (body: string, dedupId: string) => Promise<void>;
  now?: () => number;
}

const json = (statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * Edge of the integration: verify, validate, archive the raw payload, enqueue, answer fast.
 * All slow work (calling the downstream API) happens in the worker, so the provider never times out.
 */
export function createIngestHandler(deps: IngestDeps) {
  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
    const rawBody = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body ?? '';
    const requestId = event.requestContext?.requestId;

    const secret = await deps.getSecret();
    if (!verifySignature(rawBody, event.headers?.['x-signature'], secret, { nowMs: deps.now?.() })) {
      log('warn', 'invalid signature', { requestId });
      return json(401, { error: 'invalid signature' });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return json(400, { error: 'body is not valid JSON' });
    }

    const parsed = OrderEvent.safeParse(payload);
    if (!parsed.success) {
      log('warn', 'schema validation failed', { requestId, issues: parsed.error.issues });
      return json(422, { error: 'invalid event', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }

    const e = parsed.data;
    const day = e.created_at.slice(0, 10).replaceAll('-', '/');
    await deps.archive(`raw/${day}/${e.id}.json`, rawBody); // replayable audit trail
    await deps.enqueue(JSON.stringify(e), e.id);

    log('info', 'event accepted', { requestId, eventId: e.id, type: e.type });
    return json(202, { received: true, id: e.id });
  };
}

// ---- AWS wiring (module scope = reused across warm invocations) ----
const s3 = new S3Client({});
const sqs = new SQSClient({});
const secrets = new SecretsManagerClient({});
let cachedSecret: { value: string; at: number } | undefined;

export const handler = createIngestHandler({
  async getSecret() {
    // cache for 5 minutes: cheap, and a rotated secret is picked up without a redeploy
    if (cachedSecret && Date.now() - cachedSecret.at < 300_000) return cachedSecret.value;
    const res = await secrets.send(new GetSecretValueCommand({ SecretId: process.env.WEBHOOK_SECRET_ARN }));
    cachedSecret = { value: res.SecretString ?? '', at: Date.now() };
    return cachedSecret.value;
  },
  async archive(key, body) {
    await s3.send(new PutObjectCommand({ Bucket: process.env.RAW_BUCKET, Key: key, Body: body, ContentType: 'application/json' }));
  },
  async enqueue(body, dedupId) {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: process.env.QUEUE_URL,
        MessageBody: body,
        MessageAttributes: { eventId: { DataType: 'String', StringValue: dedupId } },
      }),
    );
  },
});
