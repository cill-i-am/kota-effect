/**
 * Kota credentials -- hand-written.
 *
 * The public API authenticates every request with `Authorization: Bearer
 * <token>`. The token is a platform API key, or a short-lived embed/hosted
 * session token from `createEmbedSession` / `createHostedSession`; the API
 * scopes what each can reach.
 *
 * Keys do not say which environment they belong to, so the environment is
 * explicit: `production` (https://api.kota.io, the default) or `test`
 * (https://test.api.kota.io). `apiBaseUrl` overrides both, e.g. for a local
 * backend at `http://localhost:8080/public`.
 *
 * The `Credentials` service holds an *effect* that resolves the credentials
 * on every request, on the calling fiber, so a layer provided closer to the
 * call wins and rotating keys are picked up without rebuilding anything.
 */
import * as EffectConfig from "@distilled.cloud/core/config";
import { ConfigError } from "@distilled.cloud/core/errors";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

/** The Kota environments, as named in the API's OpenAPI `servers`. */
export type Environment = "production" | "test";

/** Base URL of each environment. The API serves its routes at the root. */
export const API_BASE_URLS: Readonly<Record<Environment, string>> = {
  production: "https://api.kota.io",
  test: "https://test.api.kota.io",
};

export const DEFAULT_API_BASE_URL = API_BASE_URLS.production;

export interface Config {
  readonly apiKey: Redacted.Redacted<string>;
  readonly apiBaseUrl: string;
}

export class Credentials
  extends /*@__PURE__*/ Context.Service<Credentials, Effect.Effect<Config, ConfigError>>()(
    "KotaCredentials",
  ) {}

const isEnvironment = (value: string): value is Environment =>
  Object.prototype.hasOwnProperty.call(API_BASE_URLS, value);

export interface CredentialsOptions {
  /** A platform API key, or an embed/hosted session token. */
  readonly apiKey: string | Redacted.Redacted<string>;
  /** Default `production`. Ignored when `apiBaseUrl` is set. */
  readonly environment?: Environment;
  /** Overrides the environment's base URL. */
  readonly apiBaseUrl?: string;
}

/** Layer from an API key (or session token) and environment. */
export const fromApiKey = (options: CredentialsOptions): Layer.Layer<Credentials> =>
  Layer.succeed(
    Credentials,
    Effect.succeed({
      apiKey: Redacted.isRedacted(options.apiKey) ? options.apiKey : Redacted.make(options.apiKey),
      apiBaseUrl: options.apiBaseUrl ?? API_BASE_URLS[options.environment ?? "production"],
    }),
  );

const envConfig = /*@__PURE__*/ EffectConfig.all({
  apiKey: /*@__PURE__*/ EffectConfig.Redacted("KOTA_API_KEY"),
  environment: /*@__PURE__*/ EffectConfig.String("KOTA_ENVIRONMENT").pipe(
    /*@__PURE__*/ EffectConfig.withDefault("production"),
  ),
  apiBaseUrl: /*@__PURE__*/ EffectConfig.option(
    /*@__PURE__*/ EffectConfig.String("KOTA_API_BASE_URL"),
  ),
});

/**
 * Reads `KOTA_API_KEY` (required), `KOTA_ENVIRONMENT` (`production` or
 * `test`, default `production`) and `KOTA_API_BASE_URL` (optional override).
 * Values come from the `ConfigProvider` in context, else `process.env`.
 */
export const CredentialsFromEnv: Layer.Layer<Credentials> = /*@__PURE__*/ Layer.succeed(
  Credentials,
  /*@__PURE__*/ Effect.gen(function* () {
    const config = yield* envConfig.pipe(
      Effect.mapError(
        () => new ConfigError({ key: "KOTA_API_KEY", message: "KOTA_API_KEY is required" }),
      ),
    );
    const environment = config.environment.trim().toLowerCase();
    if (!isEnvironment(environment)) {
      return yield* new ConfigError({
        key: "KOTA_ENVIRONMENT",
        message: `KOTA_ENVIRONMENT must be "production" or "test", got "${config.environment}"`,
      });
    }
    return {
      apiKey: config.apiKey,
      apiBaseUrl:
        config.apiBaseUrl._tag === "Some" ? config.apiBaseUrl.value : API_BASE_URLS[environment],
    };
  }),
);
