/**
 * Kota error types -- hand-written.
 *
 * Every non-2xx response from the Kota API is an RFC 9110 problem document
 * (`application/problem+json`):
 *
 * ```json
 * {
 *   "type": "https://tools.ietf.org/html/rfc9110#section-15.5.5",
 *   "title": "Resource not found",
 *   "status": 404,
 *   "detail": "Employer not found",
 *   "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
 *   "error_code": "not_found"
 * }
 * ```
 *
 * Validation failures (400) add `errors`, a map from snake_case field path
 * to messages. Some codes add more fields (`missing_pricing_data`,
 * `max_dependents`, ...).
 *
 * Failures surface as tagged errors:
 *
 * - The statuses an operation declares (`BadRequest`, `NotFound`,
 *   `Conflict`, `UnprocessableEntity`) are generated per operation and carry
 *   `message` (the problem's `detail`) and `body` (the whole document).
 * - Any other status maps to the shared classes re-exported below
 *   (`Unauthorized`, `Forbidden`, `TooManyRequests`, `InternalServerError`,
 *   ...), which carry `message`.
 * - Anything else is {@link UnknownKotaError}.
 *
 * Generated and shared classes share `_tag`s, so `Effect.catchTag("NotFound",
 * ...)` handles both. {@link problemDetails} reads the problem document off
 * any of them.
 */
export {
  BadGateway,
  BadRequest,
  Conflict,
  ConfigError,
  Forbidden,
  GatewayTimeout,
  InternalServerError,
  Locked,
  NotFound,
  ServiceUnavailable,
  TooManyRequests,
  Unauthorized,
  UnprocessableEntity,
  HTTP_STATUS_MAP,
  DEFAULT_ERRORS,
  API_ERRORS,
} from "@distilled.cloud/core/errors";
export type { DefaultErrors } from "@distilled.cloud/core/errors";

import * as Category from "@distilled.cloud/core/category";
import * as Schema from "@distilled.cloud/core/schema-lite-typed";

/** A failure nothing else matched. `code` is the problem's `error_code`. */
export class UnknownKotaError
  extends /*@__PURE__*/ Schema.TaggedError<UnknownKotaError>()("UnknownKotaError", {
    code: /*@__PURE__*/ Schema.optional(Schema.String),
    message: /*@__PURE__*/ Schema.optional(Schema.String),
    body: Schema.Unknown,
  }).pipe(Category.withServerError) {}

/** A 2xx body that did not match the operation's output (strict validation only). */
export class KotaParseError
  extends /*@__PURE__*/ Schema.TaggedError<KotaParseError>()("KotaParseError", {
    body: Schema.Unknown,
    cause: Schema.Unknown,
  }).pipe(Category.withParseError) {}

/**
 * The `error_code` values the API returns. Kept open (`string & {}`) so
 * a code added server-side still type-checks.
 */
export type ErrorCode =
  | "invalid_request"
  | "invalid_state"
  | "not_found"
  | "conflict"
  | "third_party_error"
  | "internal_error"
  | "idempotency_error"
  | "unauthorized"
  | "token_expired"
  | "forbidden"
  | "limit_reached"
  | "escalation_required"
  | "service_unavailable"
  | "dependent_ineligible"
  | "dependent_limit_reached"
  | "too_many_dependents"
  | "policy_already_exists"
  | "action_rejected"
  | "organization_not_available"
  | "payload_too_large"
  | "file_content_mismatch"
  | "group_has_policy"
  | "group_has_policy_intent"
  | "group_has_quote_intent"
  | "pricing_data_missing"
  // Adaptive Requirements routes (getRequirement / submitAnswers)
  | "requirement_already_fulfilled"
  | "requirement_set_already_fulfilled"
  | "requirement_set_conflict"
  | "requirement_set_submission_required"
  | (string & {});

/** The RFC 9110 problem document every Kota error response carries. */
export interface ProblemDetails {
  readonly type?: string | undefined;
  readonly title?: string | undefined;
  readonly status?: number | undefined;
  readonly detail?: string | undefined;
  readonly instance?: string | undefined;
  /** Machine-readable reason, see {@link ErrorCode}. */
  readonly error_code?: ErrorCode | undefined;
  /** Include this when contacting Kota support. */
  readonly trace_id?: string | undefined;
  /**
   * Validation failures. The main API sends snake_case field path -> messages;
   * the Adaptive Requirements routes send one entry per failing answer.
   */
  readonly errors?:
    | Readonly<Record<string, ReadonlyArray<string>>>
    | ReadonlyArray<{
        readonly field_id: string;
        readonly error_type: string;
        readonly message: string;
      }>
    | undefined;
  /** Code-specific extensions, e.g. `missing_pricing_data`, `max_dependents`. */
  readonly [extension: string]: unknown;
}

const isRecord = (u: unknown): u is Record<string, unknown> =>
  typeof u === "object" && u !== null && !Array.isArray(u);

/**
 * The problem document behind a Kota error, when the error carries one
 * (generated per-operation classes and {@link UnknownKotaError} do; the
 * shared status classes carry only `message`).
 */
export const problemDetails = (error: unknown): ProblemDetails | undefined => {
  if (!isRecord(error) || !isRecord(error.body)) return undefined;
  const body = error.body;
  const looksLikeProblem =
    "error_code" in body || "title" in body || "detail" in body || "status" in body;
  return looksLikeProblem ? (body as ProblemDetails) : undefined;
};

/** Whether `error` carries the given `error_code`, e.g. `"invalid_state"`. */
export const hasErrorCode = (error: unknown, code: ErrorCode): boolean =>
  problemDetails(error)?.error_code === code;
