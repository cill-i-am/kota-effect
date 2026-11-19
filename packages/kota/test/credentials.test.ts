import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as Kota from "../src/index.ts";
import { employer, json, stubClient } from "./helpers.ts";

const KEYS = ["KOTA_API_KEY", "KOTA_ENVIRONMENT", "KOTA_API_BASE_URL"] as const;

describe("CredentialsFromEnv", () => {
  const saved: Partial<Record<(typeof KEYS)[number], string>> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const call = (layer: Layer.Layer<never, never, never> = Layer.empty) => {
    const stub = stubClient(json(employer("er_1")));
    const effect = Kota.getEmployer({ employer_id: "er_1" }).pipe(
      Kota.Retry.none,
      Effect.provide(Layer.mergeAll(stub.layer, Kota.CredentialsFromEnv, layer)),
    );
    return { stub, effect };
  };

  test("a missing KOTA_API_KEY fails with ConfigError and sends nothing", async () => {
    const { stub, effect } = call();
    const exit = await Effect.runPromiseExit(effect);
    expect(Exit.isFailure(exit)).toBe(true);
    const error = Exit.isFailure(exit)
      ? exit.cause.reasons.find((r) => r._tag === "Fail")?.error
      : undefined;
    expect((error as { _tag: string })._tag).toBe("ConfigError");
    expect(stub.sent).toHaveLength(0);
  });

  test("KOTA_ENVIRONMENT=test targets the test host", async () => {
    process.env.KOTA_API_KEY = "pt_from_env";
    process.env.KOTA_ENVIRONMENT = "test";
    const { stub, effect } = call();
    await Effect.runPromise(effect);
    expect(stub.sent[0]!.url.origin).toBe("https://test.api.kota.io");
    expect(stub.sent[0]!.headers.authorization).toBe("Bearer pt_from_env");
  });

  test("KOTA_API_BASE_URL overrides the environment", async () => {
    process.env.KOTA_API_KEY = "pt_from_env";
    process.env.KOTA_API_BASE_URL = "http://localhost:8080/public/";
    const { stub, effect } = call();
    await Effect.runPromise(effect);
    expect(stub.sent[0]!.url.href).toBe("http://localhost:8080/public/employers/er_1");
  });

  test("an unknown KOTA_ENVIRONMENT is a ConfigError", async () => {
    process.env.KOTA_API_KEY = "pt_from_env";
    process.env.KOTA_ENVIRONMENT = "staging";
    const { stub, effect } = call();
    const exit = await Effect.runPromiseExit(effect);
    const error = Exit.isFailure(exit)
      ? exit.cause.reasons.find((r) => r._tag === "Fail")?.error
      : undefined;
    expect(error).toMatchObject({ _tag: "ConfigError", key: "KOTA_ENVIRONMENT" });
    expect(stub.sent).toHaveLength(0);
  });

  test("values come from a provided ConfigProvider", async () => {
    const provider = ConfigProvider.layer(
      ConfigProvider.fromUnknown({ KOTA_API_KEY: "pt_from_provider", KOTA_ENVIRONMENT: "test" }),
    );
    const { stub, effect } = call(provider);
    await Effect.runPromise(effect);
    expect(stub.sent[0]!.headers.authorization).toBe("Bearer pt_from_provider");
    expect(stub.sent[0]!.url.origin).toBe("https://test.api.kota.io");
  });
});
