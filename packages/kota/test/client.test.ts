import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import { describe, expect, test } from "vitest";
import * as Kota from "../src/index.ts";
import { employer, json, problem, provide, stubClient } from "./helpers.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const runExit = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect);
const failure = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.find((r) => r._tag === "Fail")?.error : undefined;

describe("requests", () => {
  test("GET with a path label goes to the production host with a bearer token", async () => {
    const { sent, layer } = stubClient(json(employer("er_1")));
    const result = await run(Kota.getEmployer({ employer_id: "er_1" }).pipe(provide(layer)));

    expect(result.legal_name).toBe("Employer er_1");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe("GET");
    expect(sent[0]!.url.href).toBe("https://api.kota.io/employers/er_1");
    expect(sent[0]!.headers.authorization).toBe("Bearer pt_secret");
  });

  test("the test environment uses test.api.kota.io", async () => {
    const { sent, layer } = stubClient(json(employer("er_1")));
    await run(
      Kota.getEmployer({ employer_id: "er_1" }).pipe(
        provide(layer, Kota.fromApiKey({ apiKey: "pt_secret", environment: "test" })),
      ),
    );
    expect(sent[0]!.url.origin).toBe("https://test.api.kota.io");
  });

  test("POST sends the body in snake_case and Idempotency-Key as a header", async () => {
    const { sent, layer } = stubClient(json(employer("er_2")));
    await run(
      Kota.createEmployer({
        idempotencyKey: "idem-123",
        legal_name: "Acme Ltd",
        legal_address: {
          line1: "1 Main St",
          city: "Dublin",
          postal_code: "D01",
          country_code: "IE",
        },
        contact: { name: "Ada Lovelace", email: "hr@acme.test" },
        metadata: { crm_id: "42" },
      }).pipe(provide(layer)),
    );

    expect(sent[0]!.method).toBe("POST");
    expect(sent[0]!.url.href).toBe("https://api.kota.io/employers");
    expect(sent[0]!.headers["idempotency-key"]).toBe("idem-123");
    expect(sent[0]!.body).toEqual({
      legal_name: "Acme Ltd",
      legal_address: { line1: "1 Main St", city: "Dublin", postal_code: "D01", country_code: "IE" },
      contact: { name: "Ada Lovelace", email: "hr@acme.test" },
      metadata: { crm_id: "42" },
    });
  });

  test("query parameters are sent on list calls", async () => {
    const { sent, layer } = stubClient(
      json({ items: [], page: 3, page_size: 25, total_count: 0, has_next_page: false }),
    );
    await run(
      Kota.listEmployers({ filter: "active,pending", page: 3, page_size: 25 }).pipe(provide(layer)),
    );
    const params = sent[0]!.url.searchParams;
    expect(params.get("filter")).toBe("active,pending");
    expect(params.get("page")).toBe("3");
    expect(params.get("page_size")).toBe("25");
  });

  test("204 actions succeed with no body", async () => {
    const { sent, layer } = stubClient(new Response(null, { status: 204 }));
    await run(Kota.confirmEnrolmentIntent({ enrolment_intent_id: "ei_1" }).pipe(provide(layer)));
    expect(sent[0]!.method).toBe("POST");
    expect(sent[0]!.url.pathname).toBe("/enrolment_intents/ei_1/confirm");
  });
});

describe("pagination", () => {
  const page = (n: number, ids: string[], hasNext: boolean) =>
    json({
      items: ids.map(employer),
      page: n,
      page_size: 2,
      total_count: 5,
      has_next_page: hasNext,
      has_previous_page: n > 1,
    });

  test(".items streams every item across pages and stops on has_next_page = false", async () => {
    const { sent, layer } = stubClient(
      page(1, ["er_1", "er_2"], true),
      page(2, ["er_3", "er_4"], true),
      page(3, ["er_5"], false),
    );
    const ids = await run(
      Kota.listEmployers.items({ page_size: 2 }).pipe(
        Stream.map((e) => e.id),
        Stream.runCollect,
        provide(layer),
      ),
    );
    expect(Array.from(ids)).toEqual(["er_1", "er_2", "er_3", "er_4", "er_5"]);
    expect(sent.map((r) => r.url.searchParams.get("page"))).toEqual(["1", "2", "3"]);
    expect(sent.every((r) => r.url.searchParams.get("page_size") === "2")).toBe(true);
  });

  test(".pages starts from the requested page", async () => {
    const { sent, layer } = stubClient(page(4, ["er_7"], false));
    const pages = await run(
      Kota.listEmployers.pages({ page: 4 }).pipe(Stream.runCollect, provide(layer)),
    );
    expect(Array.from(pages)).toHaveLength(1);
    expect(sent[0]!.url.searchParams.get("page")).toBe("4");
  });
});

describe("errors", () => {
  test("a declared 404 is the operation's NotFound, carrying the problem document", async () => {
    const { layer } = stubClient(
      problem(404, {
        type: "https://tools.ietf.org/html/rfc9110#section-15.5.5",
        title: "Resource not found",
        detail: "Employer not found",
        trace_id: "trace-abc",
        error_code: "not_found",
      }),
    );
    const exit = await runExit(Kota.getEmployer({ employer_id: "er_x" }).pipe(provide(layer)));
    const error = failure(exit);

    expect(error).toBeInstanceOf(Kota.NotFound);
    expect((error as Kota.NotFound).message).toBe("Employer not found");
    const details = Kota.problemDetails(error);
    expect(details?.trace_id).toBe("trace-abc");
    expect(details?.error_code).toBe("not_found");
    expect(Kota.hasErrorCode(error, "not_found")).toBe(true);
  });

  test("a validation 400 keeps the per-field errors", async () => {
    const { layer } = stubClient(
      problem(400, {
        title: "Invalid request",
        error_code: "invalid_request",
        errors: { "contact.email": ["contact.email is not a valid email address"] },
      }),
    );
    const exit = await runExit(
      Kota.createEmployer({
        legal_name: "Acme",
        legal_address: { line1: "x", city: "y", postal_code: "z", country_code: "IE" },
        contact: { name: "Ada", email: "nope" },
      }).pipe(provide(layer)),
    );
    const error = failure(exit);
    expect(error).toBeInstanceOf(Kota.BadRequest);
    expect((error as Kota.BadRequest).message).toBe("Invalid request");
    expect(Kota.problemDetails(error)?.errors).toEqual({
      "contact.email": ["contact.email is not a valid email address"],
    });
  });

  test("an invalid_state 400 can be told apart by its error_code", async () => {
    const { layer } = stubClient(
      problem(400, {
        title: "Invalid state",
        detail: "Enrolment intent is not pending confirmation",
        error_code: "invalid_state",
      }),
    );
    const handled = await run(
      Kota.confirmEnrolmentIntent({ enrolment_intent_id: "ei_1" }).pipe(
        Effect.as("confirmed"),
        Effect.catchTag("BadRequest", (e) =>
          Effect.succeed(Kota.hasErrorCode(e, "invalid_state") ? "already-moved-on" : "bad"),
        ),
        provide(layer),
      ),
    );
    expect(handled).toBe("already-moved-on");
  });

  test("401 maps to Unauthorized and 403 (read-only key) to Forbidden", async () => {
    const unauthorized = stubClient(new Response(null, { status: 401 }));
    const exit401 = await runExit(Kota.listEmployers({}).pipe(provide(unauthorized.layer)));
    expect((failure(exit401) as { _tag: string })._tag).toBe("Unauthorized");

    const forbidden = stubClient(
      problem(403, {
        title: "Forbidden",
        detail: "This API key is read-only and can only be used for GET requests.",
        error_code: "forbidden",
      }),
    );
    const exit403 = await runExit(
      Kota.offboardEmployer({ employer_id: "er_1" }).pipe(provide(forbidden.layer)),
    );
    const error = failure(exit403) as { _tag: string; message: string };
    expect(error._tag).toBe("Forbidden");
    expect(error.message).toBe("This API key is read-only and can only be used for GET requests.");
  });

  test("transient failures are retried by default", async () => {
    const { sent, layer } = stubClient(
      problem(503, { title: "Service temporarily unavailable", error_code: "service_unavailable" }),
      json(employer("er_1")),
    );
    const result = await run(
      Kota.getEmployer({ employer_id: "er_1" }).pipe(
        Effect.provide(layer),
        Effect.provide(Kota.fromApiKey({ apiKey: "pt_secret" })),
      ),
    );
    expect(result.id).toBe("er_1");
    expect(sent).toHaveLength(2);
  });
});
