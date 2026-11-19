<img src="assets/icon.svg" width="64" height="64" alt="">

# kota effect

An Effect-native TypeScript SDK for the [Kota public API](https://docs.kota.io/getting-started), built on [distilled](https://distilled.cloud).

| Path                                         | What                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| [`packages/kota`](packages/kota)             | `@kota/effect`, the SDK. Start with its [README](packages/kota/README.md).            |
| [`tools/distilled-dev`](tools/distilled-dev) | distilled's code generator, vendored at a pinned commit (it is not published to npm). |

```sh
pnpm install
pnpm generate     # regenerate the SDK from packages/kota/specs/openapi.json
pnpm typecheck
pnpm test
pnpm build
```

Requires Node 24+ (scripts run TypeScript directly) and pnpm.
