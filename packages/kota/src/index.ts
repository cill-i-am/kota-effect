/**
 * @kota/effect -- Effect-native SDK for the Kota public API.
 *
 * `./services` is generated from the API's OpenAPI document by distilled's
 * code generator (`scripts/generate.ts`). Everything else in this folder is
 * hand-written.
 *
 * @example
 * ```ts
 * import * as Kota from "@kota/effect";
 * import * as Effect from "effect/Effect";
 * import * as FetchHttpClient from "effect/http/FetchHttpClient";
 * import * as Layer from "effect/Layer";
 *
 * const program = Effect.gen(function* () {
 *   const employer = yield* Kota.getEmployer({ employer_id: "er_..." });
 *   return employer.legal_name;
 * });
 *
 * program.pipe(
 *   Effect.provide(Layer.mergeAll(Kota.CredentialsFromEnv, FetchHttpClient.layer)),
 *   Effect.runPromise,
 * );
 * ```
 */
export * from "./credentials.ts";
export * from "./errors.ts";
export * as T from "./traits.ts";
export { KotaProtocol, type KotaOpError, type KotaOpContext } from "./protocol.ts";
export { paginateKota } from "./pagination.ts";
export * as Retry from "./retry.ts";
export * as Webhooks from "./webhooks.ts";
export * as Services from "./services/index.ts";
// Operations and their request/response types are importable straight off the
// package root.
export * from "./services/kota.ts";
// The generated per-operation error classes (which keep the problem document
// as `body`) shadow the same-named shared classes from ./errors.ts. They share
// `_tag`s, so `catchTag` handles either.
export { BadRequest, Conflict, NotFound, UnprocessableEntity } from "./services/kota.ts";
// Adaptive Requirements: fetch the JSON Schema for an `ar_`/`ars_` id from an
// intent's requirements list, and submit answers to it. Its error classes share
// `_tag`s with the ones above, so they are not re-exported.
export {
  getRequirement,
  submitAnswers,
  type GetRequirementError,
  type GetRequirementRequest,
  type GetRequirementResponse,
  type SubmitAnswersError,
  type SubmitAnswersRequest,
  type SubmitAnswersRequestAnswersMap,
  type SubmitAnswersResponse,
  type SubmitAnswersResponseStatus,
} from "./services/requirements.ts";
