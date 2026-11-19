/**
 * Kota webhooks -- hand-written.
 *
 * Kota signs every delivery:
 *
 * ```
 * X-Kota-Webhook-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>
 * ```
 *
 * where the HMAC key is the endpoint's secret, base64-decoded, and the
 * message is `<t>.<raw request body>`. {@link verifySignature} checks that,
 * plus that `t` is within a tolerance of now (default 5 minutes) so a
 * captured delivery cannot be replayed later. {@link constructEvent} verifies
 * and parses in one step, giving a {@link KotaWebhookEvent} you can narrow on
 * `type`.
 *
 * Verify against the raw body bytes exactly as received. Re-serialising
 * parsed JSON changes whitespace and key order and the signature will not
 * match.
 *
 * @example
 * ```ts
 * import * as Kota from "@kota/effect";
 *
 * const handle = (body: string, signature: string | undefined) =>
 *   Effect.gen(function* () {
 *     const event = yield* Kota.Webhooks.constructEvent({
 *       payload: body,
 *       signature,
 *       secret: Redacted.make(process.env.KOTA_WEBHOOK_SECRET!),
 *     });
 *     if (Kota.Webhooks.isEventType(event, "employee.created")) {
 *       yield* Effect.log(`new employee ${event.data.id}`);
 *     }
 *   });
 * ```
 */
import * as Crypto from "@distilled.cloud/core/crypto";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { KotaWebhookEvent, KotaWebhookEventType } from "./services/webhook-events.ts";

export type * from "./services/webhook-events.ts";
export { WEBHOOK_EVENT_TYPES } from "./services/webhook-events.ts";

/** Header carrying `t=<unix seconds>,v1=<hex signature>`. */
export const SIGNATURE_HEADER = "x-kota-webhook-signature";
/** Header carrying the delivery's unique id; use it to de-duplicate retries. */
export const DELIVERY_ID_HEADER = "x-kota-webhook-delivery-id";
/** Header carrying the event version, `V1` or `V2`. */
export const EVENT_VERSION_HEADER = "x-kota-event-version";

/** How far a delivery's timestamp may be from now. */
export const DEFAULT_TOLERANCE: Duration.Duration = /*@__PURE__*/ Duration.minutes(5);

export type WebhookVerificationReason =
  | "missing_signature"
  | "malformed_signature"
  | "invalid_secret"
  | "timestamp_outside_tolerance"
  | "signature_mismatch";

/** The delivery is not provably from Kota. Respond 400 and do not process it. */
export class WebhookVerificationError extends Data.TaggedError("KotaWebhookVerificationError")<{
  readonly reason: WebhookVerificationReason;
  readonly message: string;
}> {}

/** The signature was valid but the body is not a JSON webhook event. */
export class WebhookPayloadError extends Data.TaggedError("KotaWebhookPayloadError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface VerifyOptions {
  /** The raw request body, exactly as received. */
  readonly payload: string | Uint8Array;
  /** The `X-Kota-Webhook-Signature` header value. */
  readonly signature: string | null | undefined;
  /** The endpoint's signing secret (base64), as shown when the endpoint was created. */
  readonly secret: string | Redacted.Redacted<string>;
  /**
   * Maximum distance between the signature timestamp and now. Default
   * {@link DEFAULT_TOLERANCE}. Pass `false` to skip the check (not
   * recommended: it lets a captured delivery be replayed).
   */
  readonly tolerance?: Duration.Input | false;
}

const encoder = /*@__PURE__*/ new TextEncoder();
const decoder = /*@__PURE__*/ new TextDecoder();

const fail = (reason: WebhookVerificationReason, message: string) =>
  Effect.fail(new WebhookVerificationError({ reason, message }));

/** `t` and every `v1` from a signature header; undefined when malformed. */
export const parseSignatureHeader = (
  header: string,
): { readonly timestamp: number; readonly signatures: ReadonlyArray<string> } | undefined => {
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t" && /^\d+$/.test(value)) timestamp = Number(value);
    else if (key === "v1" && /^[0-9a-fA-F]{64}$/.test(value)) signatures.push(value.toLowerCase());
  }
  return timestamp === undefined || signatures.length === 0 ? undefined : { timestamp, signatures };
};

const decodeSecret = (secret: string): Uint8Array | undefined => {
  try {
    const binary = atob(secret.trim());
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.length > 0 ? bytes : undefined;
  } catch {
    return undefined;
  }
};

/** Constant-time comparison of two equal-length lowercase hex strings. */
const safeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

const signedPayload = (timestamp: number, payload: string | Uint8Array): Uint8Array => {
  const prefix = encoder.encode(`${timestamp}.`);
  const body = typeof payload === "string" ? encoder.encode(payload) : payload;
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix, 0);
  out.set(body, prefix.length);
  return out;
};

const hmacHex = (key: Uint8Array, message: Uint8Array) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const hmacKey = yield* crypto.importHmacKey(key);
    return Crypto.hex(yield* crypto.hmacSha256(hmacKey, message));
  });

/**
 * Sign `payload` the way Kota does. Useful to test your webhook handler; the
 * returned value is the `X-Kota-Webhook-Signature` header.
 */
export const sign = (options: {
  readonly payload: string | Uint8Array;
  readonly secret: string | Redacted.Redacted<string>;
  /** Unix seconds. Default: now, from the `Clock`. */
  readonly timestamp?: number;
}): Effect.Effect<string, WebhookVerificationError | Crypto.CryptoError> =>
  Effect.gen(function* () {
    const key = decodeSecret(
      Redacted.isRedacted(options.secret) ? Redacted.value(options.secret) : options.secret,
    );
    if (!key) return yield* fail("invalid_secret", "The webhook secret is not valid base64");
    const timestamp = options.timestamp ?? Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const signature = yield* hmacHex(key, signedPayload(timestamp, options.payload));
    return `t=${timestamp},v1=${signature}`;
  });

/** Succeeds when `signature` is Kota's signature of `payload` under `secret`. */
export const verifySignature = (
  options: VerifyOptions,
): Effect.Effect<void, WebhookVerificationError | Crypto.CryptoError> =>
  Effect.gen(function* () {
    if (!options.signature) {
      return yield* fail("missing_signature", `Missing ${SIGNATURE_HEADER} header`);
    }
    const parsed = parseSignatureHeader(options.signature);
    if (!parsed) {
      return yield* fail(
        "malformed_signature",
        `${SIGNATURE_HEADER} must look like t=<unix seconds>,v1=<hex signature>`,
      );
    }
    const secret = Redacted.isRedacted(options.secret)
      ? Redacted.value(options.secret)
      : options.secret;
    const key = decodeSecret(secret);
    if (!key) return yield* fail("invalid_secret", "The webhook secret is not valid base64");

    if (options.tolerance !== false) {
      const tolerance = Duration.toMillis(
        Duration.fromInputUnsafe(options.tolerance ?? DEFAULT_TOLERANCE),
      );
      const now = yield* Clock.currentTimeMillis;
      if (Math.abs(now - parsed.timestamp * 1000) > tolerance) {
        return yield* fail(
          "timestamp_outside_tolerance",
          `Signature timestamp ${parsed.timestamp} is more than ${tolerance / 1000}s from now`,
        );
      }
    }

    const expected = yield* hmacHex(key, signedPayload(parsed.timestamp, options.payload));
    if (!parsed.signatures.some((candidate) => safeEqual(candidate, expected))) {
      return yield* fail("signature_mismatch", "The webhook signature does not match the payload");
    }
  });

/**
 * Verify a delivery and parse it into a {@link KotaWebhookEvent}. Only V2
 * events are typed; the body is not schema-validated beyond being a JSON
 * object with a string `type`.
 */
export const constructEvent = (
  options: VerifyOptions,
): Effect.Effect<
  KotaWebhookEvent,
  WebhookVerificationError | WebhookPayloadError | Crypto.CryptoError
> =>
  Effect.gen(function* () {
    yield* verifySignature(options);
    const text =
      typeof options.payload === "string" ? options.payload : decoder.decode(options.payload);
    const json = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (cause) => new WebhookPayloadError({ message: "Body is not valid JSON", cause }),
    });
    if (
      typeof json !== "object" ||
      json === null ||
      typeof (json as { type?: unknown }).type !== "string"
    ) {
      return yield* new WebhookPayloadError({
        message: "Body is not a webhook event (no string `type`)",
      });
    }
    return json as KotaWebhookEvent;
  });

/** Narrow an event to one `type`. */
export const isEventType = <T extends KotaWebhookEventType>(
  event: KotaWebhookEvent,
  type: T,
): event is Extract<KotaWebhookEvent, { type: T }> => event.type === type;
