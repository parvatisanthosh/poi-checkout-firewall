import { z } from "zod";

export interface PayPalErrorDetail {
  issue?: string;
  field?: string;
  description?: string;
}

/**
 * Every failure talking to PayPal surfaces as this one class.
 * - `status`: HTTP status (0 for network failures that never got a response)
 * - `code`: PayPal's error `name` (e.g. UNPROCESSABLE_ENTITY), the OAuth `error`
 *   (e.g. invalid_client), or a POI_* code we add ourselves
 * - `debugId`: PayPal's debug_id, the thing PayPal support asks for
 */
export class PayPalError extends Error {
  override readonly name = "PayPalError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly debugId?: string,
    readonly details: PayPalErrorDetail[] = [],
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }

  /** True when `code` or any detail `issue` matches one of `issues`. */
  hasIssue(...issues: string[]): boolean {
    return (
      issues.includes(this.code) || this.details.some((d) => !!d.issue && issues.includes(d.issue))
    );
  }
}

// Covers both REST errors ({ name, message, debug_id, details }) and OAuth errors
// ({ error, error_description }).
const PayPalErrorBody = z.looseObject({
  name: z.string().optional(),
  message: z.string().optional(),
  debug_id: z.string().optional(),
  details: z
    .array(
      z.looseObject({
        issue: z.string().optional(),
        field: z.string().optional(),
        description: z.string().optional(),
      }),
    )
    .optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

export async function toPayPalError(res: Response, what: string): Promise<PayPalError> {
  const text = await res.text().catch(() => "");
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  const parsed = PayPalErrorBody.safeParse(json);
  const body = parsed.success ? parsed.data : {};
  const code = body.name ?? body.error ?? `HTTP_${res.status}`;
  const details: PayPalErrorDetail[] = (body.details ?? []).map(
    ({ issue, field, description }) => ({ issue, field, description }),
  );
  const first = details[0];
  const reason =
    (first?.issue ? `${first.issue}${first.description ? `: ${first.description}` : ""}` : "") ||
    body.message ||
    body.error_description ||
    res.statusText;
  const debugId = body.debug_id ?? res.headers.get("paypal-debug-id") ?? undefined;
  return new PayPalError(
    res.status,
    code,
    `${what} failed (${res.status} ${code}): ${reason}`,
    debugId,
    details,
  );
}

export function invalidResponse(what: string, error: z.ZodError | Error): PayPalError {
  const message = error instanceof z.ZodError ? z.prettifyError(error) : error.message;
  return new PayPalError(
    0,
    "POI_INVALID_PAYPAL_RESPONSE",
    `${what}: PayPal response did not match the expected shape: ${message}`,
  );
}
