import { createHash } from "node:crypto";

export type PayPalAction = "create" | "authorize" | "capture" | "void";

/**
 * Deterministic PayPal-Request-Id for (action, resource). A retry of the same action on the
 * same order/authorization sends the same id, so PayPal replays the first result instead of
 * authorizing, capturing or voiding twice -- even if the retry comes from a fresh worker
 * process after a crash. Formatted as a UUID (v8, from SHA-256) because PayPal limits the
 * header length and UUIDs are the documented format.
 */
export function paypalRequestId(action: PayPalAction, resourceId: string): string {
  const h = createHash("sha256").update(`poi/v1:${action}:${resourceId}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x80; // version 8 (custom)
  h[8] = (h[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = h.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
