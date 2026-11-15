import { z } from 'zod';

/** Contract for events the third-party platform sends us. Anything else is rejected at the edge. */
export const OrderEvent = z.object({
  id: z.string().min(1),
  type: z.enum(['order.created', 'order.updated', 'order.cancelled']),
  created_at: z.string().datetime(),
  data: z.object({
    order_id: z.string().min(1),
    customer_email: z.string().email().optional(),
    total: z.number().nonnegative(),
    currency: z.string().length(3),
  }),
});

export type OrderEvent = z.infer<typeof OrderEvent>;

/** Maps the provider's shape to the payload our downstream API expects. */
export function toDownstream(e: OrderEvent) {
  return {
    externalEventId: e.id,
    action: e.type.split('.')[1],
    orderId: e.data.order_id,
    customerEmail: e.data.customer_email ?? null,
    amount: { value: e.data.total, currency: e.data.currency.toUpperCase() },
    occurredAt: e.created_at,
  };
}
