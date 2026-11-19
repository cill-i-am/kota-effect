# @kota/effect

Effect-native TypeScript SDK for the [Kota public API](https://docs.kota.io/getting-started).

- All 94 public operations, plus the 2 Adaptive Requirements routes, typed from the APIs' own OpenAPI documents. Requests and responses use the wire's snake_case names, so they match the API reference one to one.
- Each operation lists the errors it can fail with, as tagged errors you can handle with `Effect.catchTag`.
- List endpoints stream every page or every item with `.pages()` and `.items()`.
- Credentials, the environment and the retry policy are layers. The SDK reads them from context on every call.
- Webhook signature verification and a typed union of all V2 webhook events.

It is generated with [distilled](https://distilled.cloud)'s code generator and runs on `@distilled.cloud/core`, like every distilled SDK.

## Install

```sh
pnpm add @kota/effect effect
```

Requires `effect` 4.1 or later.

## Quick start

```ts
import * as Kota from "@kota/effect";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";

const program = Effect.gen(function* () {
  const employer = yield* Kota.createEmployer({
    idempotencyKey: crypto.randomUUID(),
    legal_name: "Acme Ltd",
    legal_address: {
      line1: "1 Main St",
      city: "Dublin",
      postal_code: "D01 F5P2",
      country_code: "IE",
    },
    contact: { name: "Ada Lovelace", email: "hr@acme.example" },
  });

  const employee = yield* Kota.getEmployee({ employee_id: "ee_..." });
  return { employer, employee };
});

const KotaLive = Layer.mergeAll(Kota.CredentialsFromEnv, FetchHttpClient.layer);

program.pipe(Effect.provide(KotaLive), Effect.runPromise);
```

Every operation is exported from the package root (`Kota.listEmployers`, `Kota.confirmEnrolmentIntent`, ...). They are also grouped under `Kota.Services.kota`. Operations need two things in context: `Kota.Credentials` and an `HttpClient`.

## Credentials and environments

Kota API keys don't say which environment they belong to, so choose one explicitly:

| Environment            | Base URL                   |
| ---------------------- | -------------------------- |
| `production` (default) | `https://api.kota.io`      |
| `test`                 | `https://test.api.kota.io` |

```ts
// From the environment: KOTA_API_KEY (required), KOTA_ENVIRONMENT (production | test),
// KOTA_API_BASE_URL (optional override). A ConfigProvider in context takes precedence over process.env.
Kota.CredentialsFromEnv;

// Explicit
Kota.fromApiKey({ apiKey: Redacted.make(key), environment: "test" });

// A local backend
Kota.fromApiKey({ apiKey: key, apiBaseUrl: "http://localhost:8080/public" });
```

The token can be a platform API key, or a session token from `createEmbedSession` or `createHostedSession`. The API decides what each kind of token can reach.

Credentials are resolved on every call, from the calling fiber. Two programs can therefore talk to different platforms by providing different layers.

## Pagination

List operations accept `page` (1-based) and `page_size` (default 10, maximum 100). They also expose streams:

```ts
import * as Stream from "effect/Stream";

// One page
const page = yield * Kota.listEmployees({ page_size: 100 });
page.items;
page.total_count;
page.has_next_page;

// Every item, fetching pages as the stream is pulled
const active =
  yield * Kota.listEmployers.items({ filter: "active", page_size: 100 }).pipe(Stream.runCollect);

// Every page
yield *
  Kota.listPolicies.pages({ page_size: 50 }).pipe(Stream.runForEach((p) => Effect.log(p.page)));
```

## Requirements

Intents gather data through requirements. You find out what an intent still needs with its requirements list: `listEnrolmentIntentRequirements`, `listGroupQuoteIntentRequirements` or `listGroupPolicyIntentRequirements`. Then you fetch each requirement's JSON Schema and answer it. These two routes come from the Adaptive Requirements service, on the same host and with the same token:

```ts
const program = Effect.gen(function* () {
  const pending = yield* Kota.listEnrolmentIntentRequirements
    .items({ enrolment_intent_id: "ei_..." })
    .pipe(
      Stream.filter((r) => !r.is_fulfilled),
      Stream.runCollect,
    );

  for (const requirement of pending) {
    // `id` is an `ar_` (one requirement) or `ars_` (a set, composed into one schema)
    const { schema } = yield* Kota.getRequirement({ requirement_id: requirement.id });
    // ...render `schema` (JSON Schema) and collect answers...
    const result = yield* Kota.submitAnswers({
      requirement_id: requirement.id,
      answers: { date_of_birth: "1990-04-01" },
    });
    if (result.status === "in_progress")
      yield* Effect.log(`still need ${result.outstanding_fields}`);
  }
});
```

Answers are cumulative. You can submit part of them, and the response returns the schema with what is stored so far filled in as defaults. When an answer fails validation, `submitAnswers` fails with `BadRequest`. In that case `problemDetails(error).errors` lists `{ field_id, error_type, message }` per field.

## Errors

Every Kota error response is an RFC 9110 problem document: `title`, `detail`, `status`, Kota's `error_code` and `trace_id`, plus `errors` for validation failures. The SDK turns them into tagged errors:

| Tag                                                                                              | When                                                                                               |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `BadRequest`, `NotFound`, `Conflict`, `UnprocessableEntity`                                      | Statuses the operation declares. They carry `message` and the full problem document as `body`.     |
| `Unauthorized`, `Forbidden`, `TooManyRequests`, `InternalServerError`, `ServiceUnavailable`, ... | Any other status. They carry `message`. A read-only key calling a write endpoint gets `Forbidden`. |
| `UnknownKotaError`                                                                               | Anything else.                                                                                     |
| `ConfigError`                                                                                    | Credentials could not be resolved. No request is sent.                                             |

```ts
yield *
  Kota.confirmEnrolmentIntent({ enrolment_intent_id }).pipe(
    Effect.catchTag("BadRequest", (error) => {
      const problem = Kota.problemDetails(error);
      if (problem?.error_code === "invalid_state") return Effect.void; // already confirmed
      return Effect.logError(
        `Kota rejected the request: ${problem?.detail} (trace ${problem?.trace_id})`,
      );
    }),
    Effect.catchTag("NotFound", () => Effect.fail(new MissingIntent())),
  );
```

`Kota.hasErrorCode(error, "group_has_policy")` checks a single code. `Kota.ErrorCode` lists every code the backend defines.

## Retries

Transient failures are retried by default, with jittered exponential backoff. This covers 5xx responses, 429s and network errors, and honours `Retry-After`. You can change the policy for any scope:

```ts
program.pipe(Kota.Retry.none); // no retries
program.pipe(Kota.Retry.transient); // retry transient errors indefinitely
program.pipe(Kota.Retry.policy({ while: (e) => e._tag === "ServiceUnavailable", schedule }));
```

Pass `idempotencyKey` on create calls so a retried request can't create the same resource twice.

## Webhooks

```ts
import * as Kota from "@kota/effect";

// body: the raw request body (string or bytes), exactly as received
const handle = (body: string, headers: Headers) =>
  Effect.gen(function* () {
    const event = yield* Kota.Webhooks.constructEvent({
      payload: body,
      signature: headers.get(Kota.Webhooks.SIGNATURE_HEADER),
      secret: Redacted.make(process.env.KOTA_WEBHOOK_SECRET!),
    });

    switch (event.type) {
      case "employee.created":
        return yield* onEmployeeCreated(event.data); // EmployeeEventResponse
      case "enrolment_intent.enrolled":
        return yield* onEnrolled(event.data);
    }
  });
```

`constructEvent` does three things:

1. Checks the `X-Kota-Webhook-Signature` header (HMAC-SHA256 over `<t>.<body>` with the base64 secret, as the backend signs it).
2. Rejects deliveries whose timestamp is more than 5 minutes from now. Change this with `tolerance`.
3. Parses the body into `Kota.Webhooks.KotaWebhookEvent`, a union discriminated on `type` that covers all 93 V2 events.

A failure is a `KotaWebhookVerificationError` with a `reason`; answer it with a 400. Use `Kota.Webhooks.sign(...)` to produce valid signatures in your own tests.

## How it is built

```
specs/openapi.json   snapshot of https://api.kota.io/openapi.json (see specs/SOURCE.md)
specs/requirements.openapi.json  snapshot of https://api.kota.io/requirements/openapi.json
patches/             corrections for undeclared API behaviour, applied to the model
scripts/convert.ts   OpenAPI → Smithy model           (distilled's converter)
scripts/generate.ts  Smithy models → src/services/{kota,requirements}.ts (distilled's compiler)
scripts/generate-webhooks.ts  webhook payloads → src/services/webhook-events.ts
src/*.ts             hand-written: credentials, protocol, errors, pagination, retry, webhooks
```

The commands:

```sh
pnpm spec:fetch    # refresh the spec from the live API
pnpm generate      # regenerate src/services
pnpm typecheck && pnpm test
pnpm build         # emit lib/
```

Only `src/services/` is generated, so don't edit it by hand. When the API returns something its OpenAPI document doesn't declare, add a patch in `patches/` describing the observed response. `patches/001-source-observed-errors.patch.json` is an example.

The SDK covers what the API's published OpenAPI documents describe. Endpoints the API doesn't document are not included.
