import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as UrlParams from "effect/http/UrlParams";
import * as Kota from "../src/index.ts";

export interface Recorded {
  readonly method: string;
  readonly url: URL;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

const bodyOf = (request: HttpClientRequest.HttpClientRequest): unknown => {
  const body = request.body as { _tag: string; body?: Uint8Array };
  if (body._tag !== "Uint8Array" || !body.body) return undefined;
  const text = new TextDecoder().decode(body.body);
  return text.length ? JSON.parse(text) : undefined;
};

/**
 * An HttpClient that answers each request with the next queued response and
 * records what was sent.
 */
export const stubClient = (...responses: ReadonlyArray<Response | (() => Response)>) => {
  const sent: Recorded[] = [];
  const queue = [...responses];
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      sent.push({
        method: request.method,
        url: new URL(
          request.urlParams.params.length
            ? `${request.url}?${UrlParams.toString(request.urlParams)}`
            : request.url,
        ),
        headers: { ...request.headers },
        body: bodyOf(request),
      });
      const next = queue.shift();
      if (!next)
        return Effect.die(new Error(`unexpected request ${request.method} ${request.url}`));
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, typeof next === "function" ? next() : next),
      );
    }),
  );
  return { sent, layer };
};

export const problem = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify({ status, ...body }), {
    status,
    headers: { "content-type": "application/problem+json" },
  });

export const json = (body: unknown, status = 200) => Response.json(body, { status });

/** Credentials + stub client, with retries off so failures surface at once. */
export const provide =
  (
    client: Layer.Layer<HttpClient.HttpClient>,
    credentials = Kota.fromApiKey({ apiKey: "pt_secret" }),
  ) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Kota.Retry.none, Effect.provide(Layer.mergeAll(client, credentials)));

export const employer = (id: string) => ({
  id,
  platform_id: "pt_1",
  status: "active",
  legal_name: `Employer ${id}`,
  legal_address: { line1: "1 Main St", city: "Dublin", postal_code: "D01", country_code: "IE" },
  contact: { name: "HR", email: "hr@example.com" },
  object: "employer",
});
