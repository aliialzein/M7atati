import { createHmac, timingSafeEqual } from 'node:crypto';
import type { OrderQuote } from '../../generated/prisma/client.js';

// A distinct bearer capability, issued only after authorized order creation.
// Binding both IDs prevents use on another order. Domain separation prevents
// accepting the original quote credential. Deterministic derivation makes a
// lost creation response recoverable through the existing authorized replay.
// The quote secret hash stays server-side; no additional storage is needed.
export function guestOrderAccessToken(
  orderId: number,
  quote: Pick<OrderQuote, 'id' | 'customerId' | 'guestTokenHash'>,
) {
  if (
    quote.customerId !== null ||
    !quote.guestTokenHash ||
    !/^[a-f0-9]{64}$/.test(quote.guestTokenHash)
  )
    return undefined;
  return createHmac('sha256', Buffer.from(quote.guestTokenHash, 'hex'))
    .update(`m7atati:order-tracking:v1:${quote.id}:${orderId}`)
    .digest('hex');
}

export function matchesGuestOrderAccessToken(
  expected: string | undefined,
  supplied: unknown,
) {
  return (
    expected !== undefined &&
    typeof supplied === 'string' &&
    /^[a-f0-9]{64}$/.test(supplied) &&
    timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(supplied, 'hex'))
  );
}
