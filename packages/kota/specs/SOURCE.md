# Spec provenance

## `openapi.json`

The Kota public API description, as served by the API itself at
`https://api.kota.io/openapi.json`. It is the source of truth for routes,
request and response shapes. Endpoints the API does not document are not in it,
and not in this SDK.

| Field | Value |
| --- | --- |
| Fetched | 2026-11-12 |
| URL | https://api.kota.io/openapi.json |
| Operations | 94 |

## `requirements.openapi.json`

The Adaptive Requirements API, served on the same host at
`https://api.kota.io/requirements/openapi.json`. It fetches the JSON Schema
for, and accepts answers to, the `ar_`/`ars_` ids the main API's
`.../requirements` lists return.

| Field | Value |
| --- | --- |
| Fetched | 2026-11-12 (production and test documents identical) |
| URL | https://api.kota.io/requirements/openapi.json |
| Operations | 2 (`get-requirement`, `submit-answers`) |

Refresh both with `pnpm spec:fetch`, then `pnpm generate`. Corrections for
behaviour the documents do not declare live in `../patches/`.
