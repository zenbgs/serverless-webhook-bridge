# Serverless Webhook Bridge (AWS)

A small, production-style integration that connects a **third-party platform's webhooks** to **your own REST API** on AWS, without losing, duplicating or blocking events.

```
Third-party ──POST──▶ API Gateway (HTTP API, throttled)
                         │
                         ▼
                 Ingest Lambda ── verify HMAC signature + timestamp
                         │        validate payload (Zod contract)
                         ├──────▶ S3: raw payload archive (encrypted, 90-day lifecycle)
                         ▼
                     SQS queue ── 3 attempts ──▶ Dead-letter queue ──▶ CloudWatch alarm ──▶ SNS email
                         │
                         ▼
                 Worker Lambda ── DynamoDB idempotency claim (TTL)
                         │        map to downstream contract
                         ▼
                  Your REST API ── retries with backoff + jitter, honours Retry-After, Idempotency-Key header
```

## Why it's built this way

| Problem in real integrations | How this handles it |
|---|---|
| Provider times out if we're slow | Ingest only verifies, archives and enqueues, then returns `202` in milliseconds |
| Forged or replayed requests | HMAC-SHA256 over `timestamp.body`, constant-time compare, 5-minute window |
| Unexpected payload shapes | Zod schema at the edge; `422` with readable issues |
| Same event delivered twice | DynamoDB conditional write per event ID; stale locks recoverable; `Idempotency-Key` sent downstream |
| Downstream API slow, down or rate-limiting | Retries on 408/425/429/5xx with exponential backoff + full jitter; respects `Retry-After`; worker concurrency capped at 5 |
| One bad record blocking the batch | `ReportBatchItemFailures`: only failed messages are retried |
| Failures nobody notices | DLQ (14-day retention) + alarms on DLQ depth, queue age and worker errors |
| Secrets in env vars or code | Signing secret read from Secrets Manager, cached 5 min (rotation-friendly) |
| Over-broad permissions | Least-privilege IAM per function via SAM policy templates |

## Project layout

```
src/ingest.ts          API Gateway handler (edge)
src/worker.ts          SQS handler (delivery)
src/lib/signature.ts   HMAC verification
src/lib/schema.ts      Event contract + mapping to downstream shape
src/lib/http.ts        POST with retry/backoff
src/lib/log.ts         Structured JSON logs for CloudWatch Logs Insights
template.yaml          AWS SAM: API, Lambdas, SQS + DLQ, S3, DynamoDB, alarms
test/                  16 unit tests (Vitest)
```

Handlers take their AWS dependencies as parameters, so business logic is tested without mocking the SDK, and the AWS wiring stays thin.

## Run it

```bash
npm install
npm run typecheck   # strict TypeScript
npm test            # 16 tests
npm run build       # esbuild bundles to dist/ (AWS SDK v3 comes from the Lambda runtime)
npm run validate    # cfn-lint on template.yaml
```

Deploy (needs AWS credentials and the SAM CLI):

```bash
sam deploy --guided \
  --parameter-overrides DownstreamUrl=https://api.example.com WebhookSecretArn=arn:aws:secretsmanager:... AlarmEmail=ops@example.com
```

## Status

Built as a portfolio example by [Zain Bagus](https://zenbgs.github.io). Typecheck, tests, build and `cfn-lint` pass locally; it is not deployed to a live AWS account.
