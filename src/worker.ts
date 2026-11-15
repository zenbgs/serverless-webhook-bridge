import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import {
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  ConditionalCheckFailedException,
} from '@aws-sdk/client-dynamodb';
import { OrderEvent, toDownstream } from './lib/schema';
import { postJsonWithRetry, NonRetryableError } from './lib/http';
import { log } from './lib/log';

export interface WorkerDeps {
  /** Returns false if another invocation already processed (or is processing) this event. */
  claim: (eventId: string) => Promise<boolean>;
  complete: (eventId: string) => Promise<void>;
  release: (eventId: string) => Promise<void>;
  deliver: (event: OrderEvent) => Promise<void>;
}

/**
 * Processes a batch from SQS. Each message is handled independently and only failed ones are
 * reported back (ReportBatchItemFailures), so one bad record never re-runs the whole batch.
 * After maxReceiveCount failures SQS moves the message to the dead-letter queue.
 */
export function createWorkerHandler(deps: WorkerDeps) {
  return async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];

    for (const record of event.Records) {
      let eventId: string | undefined;
      try {
        const e = OrderEvent.parse(JSON.parse(record.body));
        eventId = e.id;

        if (!(await deps.claim(e.id))) {
          log('info', 'duplicate skipped', { eventId: e.id });
          continue;
        }
        try {
          await deps.deliver(e);
          await deps.complete(e.id);
          log('info', 'delivered', { eventId: e.id, type: e.type });
        } catch (err) {
          await deps.release(e.id); // let the SQS retry claim it again
          throw err;
        }
      } catch (err) {
        const permanent = err instanceof NonRetryableError;
        log('error', 'processing failed', {
          messageId: record.messageId,
          eventId,
          permanent,
          error: err instanceof Error ? err.message : String(err),
        });
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  };
}

// ---- AWS wiring ----
const ddb = new DynamoDBClient({});
const TABLE = process.env.IDEMPOTENCY_TABLE;
const LOCK_SECONDS = 120;
const KEEP_DAYS = 7;

export const handler = createWorkerHandler({
  async claim(eventId) {
    const now = Math.floor(Date.now() / 1000);
    try {
      await ddb.send(
        new PutItemCommand({
          TableName: TABLE,
          Item: {
            pk: { S: eventId },
            status: { S: 'IN_PROGRESS' },
            lockUntil: { N: String(now + LOCK_SECONDS) },
            expiresAt: { N: String(now + KEEP_DAYS * 86_400) },
          },
          // new event, or a stale lock left by a crashed invocation
          ConditionExpression: 'attribute_not_exists(pk) OR (#s = :inProgress AND lockUntil < :now)',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':inProgress': { S: 'IN_PROGRESS' }, ':now': { N: String(now) } },
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  },
  async complete(eventId) {
    await ddb.send(
      new UpdateItemCommand({
        TableName: TABLE,
        Key: { pk: { S: eventId } },
        UpdateExpression: 'SET #s = :done',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':done': { S: 'DONE' } },
      }),
    );
  },
  async release(eventId) {
    await ddb.send(new DeleteItemCommand({ TableName: TABLE, Key: { pk: { S: eventId } } }));
  },
  async deliver(e) {
    await postJsonWithRetry(`${process.env.DOWNSTREAM_URL}/orders/events`, toDownstream(e), {
      // the downstream API can dedupe on its side too
      headers: { 'idempotency-key': e.id },
    });
  },
});
