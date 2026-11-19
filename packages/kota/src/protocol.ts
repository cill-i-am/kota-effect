/**
 * KotaProtocol -- hand-written.
 *
 * Kota speaks bearer-authenticated JSON REST with no response envelope, so the
 * protocol is one `makeRestProtocol` call from distilled's core:
 *
 *   request:  credentials -> `Authorization: Bearer <apiKey>` + base URL,
 *             resolved from the calling fiber on every request
 *
 *   response: a 2xx JSON body is the payload; a non-2xx problem document maps
 *             to the operation's typed error classes by status, then the
 *             shared HTTP-status classes, then {@link UnknownKotaError}.
 *             `message` is the problem's `detail` (else its `title`) and the
 *             error code is its `error_code`.
 */
import type * as API from "@distilled.cloud/core/api";
import type { API_ERRORS, ConfigError, InvalidInput } from "@distilled.cloud/core/errors";
import { makeRestProtocol } from "@distilled.cloud/core/protocol-rest";
import type { SdkError } from "@distilled.cloud/core/sdk-error";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import type * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Credentials, type Config } from "./credentials.ts";
import { KotaParseError, UnknownKotaError } from "./errors.ts";

/** Error channel shared by every generated Kota operation. */
export type KotaOpError =
  | InstanceType<(typeof API_ERRORS)[number]>
  | UnknownKotaError
  | ConfigError
  | HttpClientError.HttpClientError
  | KotaParseError
  | InvalidInput
  | SdkError;

/** Requirements shared by every generated Kota operation. */
export type KotaOpContext = Credentials | HttpClient.HttpClient;

export const KotaProtocol: Layer.Layer<API.Protocol> = /*@__PURE__*/ makeRestProtocol<Config>({
  credentials: /*@__PURE__*/ Effect.flatMap(Credentials, (resolve) => resolve),
  baseUrl: (creds) => creds.apiBaseUrl.replace(/\/+$/, ""),
  headers: (creds) => ({
    Authorization: `Bearer ${Redacted.value(creds.apiKey)}`,
    Accept: "application/json",
  }),
  errorEnvelope: (body) => {
    if (body === null || typeof body !== "object") return undefined;
    const problem = body as Record<string, unknown>;
    const code = typeof problem.error_code === "string" ? problem.error_code : undefined;
    const message =
      typeof problem.detail === "string" && problem.detail.length > 0
        ? problem.detail
        : typeof problem.title === "string"
          ? problem.title
          : undefined;
    if (code === undefined && message === undefined) return undefined;
    return { code, message };
  },
  unknownError: ({ code, message, body }) =>
    new UnknownKotaError({
      code: code === undefined ? undefined : String(code),
      message,
      body,
    }),
  parseError: ({ body, cause }) => new KotaParseError({ body, cause }),
});
