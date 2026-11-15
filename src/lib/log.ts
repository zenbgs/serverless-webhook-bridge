/** One JSON object per line, so CloudWatch Logs Insights can filter and aggregate on any field. */
export function log(level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ level, msg, ...fields, ts: new Date().toISOString() });
  if (level === 'error') console.error(line);
  else console.log(line);
}
