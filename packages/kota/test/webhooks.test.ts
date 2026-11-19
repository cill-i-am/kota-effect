import { createHmac, randomBytes } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, test } from "vitest";
import * as Kota from "../src/index.ts";

const secret = randomBytes(64).toString("base64");
const body = JSON.stringify({
  id: "evt_1",
  type: "employee.created",
  platform_id: "pt_1",
  data: { id: "ee_1", employer_id: "er_1", resource_type: "employee", object: "employee" },
  created: "2026-11-12T10:00:00Z",
});

/** Kota's documented signing scheme, implemented independently with node:crypto. */
const kotaSignature = (timestamp: number, payload: string, base64Secret: string) =>
  `t=${timestamp},v1=${createHmac("sha256", Buffer.from(base64Secret, "base64"))
    .update(`${timestamp}.${payload}`, "utf8")
    .digest("hex")}`;

const nowSeconds = Math.floor(Date.now() / 1000);

const reasonOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit)
    ? (exit.cause.reasons.find((r) => r._tag === "Fail")?.error as {
        reason?: string;
        _tag: string;
      })
    : undefined;

describe("webhooks", () => {
  test("accepts a signature made the way the backend makes it", async () => {
    const event = await Effect.runPromise(
      Kota.Webhooks.constructEvent({
        payload: body,
        signature: kotaSignature(nowSeconds, body, secret),
        secret: Redacted.make(secret),
      }),
    );
    expect(event.type).toBe("employee.created");
    if (Kota.Webhooks.isEventType(event, "employee.created")) {
      // narrowed: data is EmployeeEventResponse
      expect(event.data.employer_id).toBe("er_1");
    } else {
      expect.unreachable();
    }
  });

  test("accepts the raw body as bytes", async () => {
    await Effect.runPromise(
      Kota.Webhooks.verifySignature({
        payload: new TextEncoder().encode(body),
        signature: kotaSignature(nowSeconds, body, secret),
        secret,
      }),
    );
  });

  test("sign() produces what the backend would", async () => {
    const header = await Effect.runPromise(
      Kota.Webhooks.sign({ payload: body, secret, timestamp: 1705318200 }),
    );
    expect(header).toBe(kotaSignature(1705318200, body, secret));
  });

  test("rejects a tampered body", async () => {
    const exit = await Effect.runPromiseExit(
      Kota.Webhooks.verifySignature({
        payload: body.replace("ee_1", "ee_2"),
        signature: kotaSignature(nowSeconds, body, secret),
        secret,
      }),
    );
    expect(reasonOf(exit)).toMatchObject({
      _tag: "KotaWebhookVerificationError",
      reason: "signature_mismatch",
    });
  });

  test("rejects a different secret", async () => {
    const exit = await Effect.runPromiseExit(
      Kota.Webhooks.verifySignature({
        payload: body,
        signature: kotaSignature(nowSeconds, body, secret),
        secret: randomBytes(64).toString("base64"),
      }),
    );
    expect(reasonOf(exit)?.reason).toBe("signature_mismatch");
  });

  test("rejects missing and malformed headers", async () => {
    const missing = await Effect.runPromiseExit(
      Kota.Webhooks.verifySignature({ payload: body, signature: undefined, secret }),
    );
    expect(reasonOf(missing)?.reason).toBe("missing_signature");

    const malformed = await Effect.runPromiseExit(
      Kota.Webhooks.verifySignature({ payload: body, signature: "sha256=abc", secret }),
    );
    expect(reasonOf(malformed)?.reason).toBe("malformed_signature");
  });

  test("rejects a replayed delivery outside the tolerance, using the Clock", async () => {
    const signedAt = 1_700_000_000;
    const signature = kotaSignature(signedAt, body, secret);
    const verify = (tolerance?: false) =>
      Kota.Webhooks.verifySignature({ payload: body, signature, secret, tolerance });

    const program = Effect.gen(function* () {
      yield* TestClock.setTime(signedAt * 1000 + 4 * 60_000);
      const fresh = yield* Effect.exit(verify());
      yield* TestClock.setTime(signedAt * 1000 + 6 * 60_000);
      const stale = yield* Effect.exit(verify());
      const unchecked = yield* Effect.exit(verify(false));
      return { fresh, stale, unchecked };
    }).pipe(Effect.provide(TestClock.layer()));

    const { fresh, stale, unchecked } = await Effect.runPromise(program);
    expect(Exit.isSuccess(fresh)).toBe(true);
    expect(reasonOf(stale)?.reason).toBe("timestamp_outside_tolerance");
    expect(Exit.isSuccess(unchecked)).toBe(true);
  });

  test("a valid signature over a non-event body is a payload error", async () => {
    const exit = await Effect.runPromiseExit(
      Kota.Webhooks.constructEvent({
        payload: "[1,2,3]",
        signature: kotaSignature(nowSeconds, "[1,2,3]", secret),
        secret,
      }),
    );
    expect(reasonOf(exit)?._tag).toBe("KotaWebhookPayloadError");
  });

  test("every documented V2 event type is listed", () => {
    expect(Kota.Webhooks.WEBHOOK_EVENT_TYPES).toContain("enrolment_intent.enrolled");
    expect(Kota.Webhooks.WEBHOOK_EVENT_TYPES).toHaveLength(93);
  });
});
