import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import { describe, expect, test } from "vitest";
import * as Kota from "../src/index.ts";
import { json, problem, provide, stubClient } from "./helpers.ts";

const AR = "ar_0a1b2c3d4e5f67890a1b2c3d4e5f6789";
const failure = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.find((r) => r._tag === "Fail")?.error : undefined;

describe("requirements", () => {
  test("getRequirement fetches the schema from the requirements route", async () => {
    const schema = { type: "object", properties: { date_of_birth: { type: "string" } } };
    const { sent, layer } = stubClient(json({ is_fulfilled: false, schema }));
    const result = await Effect.runPromise(
      Kota.getRequirement({ requirement_id: AR }).pipe(provide(layer)),
    );
    expect(result).toEqual({ is_fulfilled: false, schema });
    expect(sent[0]!.method).toBe("GET");
    expect(sent[0]!.url.href).toBe(`https://api.kota.io/requirements/${AR}`);
    expect(sent[0]!.headers.authorization).toBe("Bearer pt_secret");
  });

  test("submitAnswers posts the answers map", async () => {
    const { sent, layer } = stubClient(
      json({ status: "in_progress", outstanding_fields: ["address"], schema: {} }),
    );
    const result = await Effect.runPromise(
      Kota.submitAnswers({ requirement_id: AR, answers: { date_of_birth: "1990-04-01" } }).pipe(
        provide(layer),
      ),
    );
    expect(result.status).toBe("in_progress");
    expect(result.outstanding_fields).toEqual(["address"]);
    expect(sent[0]!.method).toBe("POST");
    expect(sent[0]!.url.pathname).toBe(`/requirements/${AR}`);
    expect(sent[0]!.body).toEqual({ answers: { date_of_birth: "1990-04-01" } });
  });

  test("answer validation failures keep the per-field errors", async () => {
    const { layer } = stubClient(
      problem(400, {
        title: "Invalid request",
        detail: "One or more answers failed validation",
        error_code: "invalid_request",
        errors: [
          { field_id: "date_of_birth", error_type: "validation", message: "must be a date" },
        ],
      }),
    );
    const exit = await Effect.runPromiseExit(
      Kota.submitAnswers({ requirement_id: AR, answers: { date_of_birth: "soon" } }).pipe(
        provide(layer),
      ),
    );
    const error = failure(exit) as { _tag: string };
    expect(error._tag).toBe("BadRequest");
    expect(Kota.problemDetails(error)?.errors).toEqual([
      { field_id: "date_of_birth", error_type: "validation", message: "must be a date" },
    ]);
  });

  test("an already-fulfilled requirement is a Conflict with its error_code", async () => {
    const { layer } = stubClient(
      problem(409, {
        title: "Conflict",
        detail: `Requirement ${AR} is already fulfilled`,
        error_code: "requirement_already_fulfilled",
      }),
    );
    const outcome = await Effect.runPromise(
      Kota.submitAnswers({ requirement_id: AR, answers: {} }).pipe(
        Effect.as("submitted"),
        Effect.catchTag("Conflict", (e) =>
          Effect.succeed(
            Kota.hasErrorCode(e, "requirement_already_fulfilled") ? "already-done" : "other",
          ),
        ),
        provide(layer),
      ),
    );
    expect(outcome).toBe("already-done");
  });

  test("an intent's requirement list feeds getRequirement", async () => {
    const { sent, layer } = stubClient(
      json({
        items: [
          {
            id: AR,
            object_type: "employee",
            object_id: "ee_1",
            is_fulfilled: false,
            requirement_type: "employee_details",
          },
        ],
        page: 1,
        page_size: 10,
        total_count: 1,
        has_next_page: false,
      }),
      json({ is_fulfilled: false, schema: {} }),
    );
    await Effect.runPromise(
      Kota.listEnrolmentIntentRequirements.items({ enrolment_intent_id: "ei_1" }).pipe(
        Stream.mapEffect((r) => Kota.getRequirement({ requirement_id: r.id })),
        Stream.runDrain,
        provide(layer),
      ),
    );
    expect(sent.map((r) => r.url.pathname)).toEqual([
      "/enrolment_intents/ei_1/requirements",
      `/requirements/${AR}`,
    ]);
  });
});
