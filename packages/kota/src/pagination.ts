/**
 * Kota pagination -- hand-written.
 *
 * List endpoints take `page` (1-based) and `page_size` (default 10, max 100)
 * and answer with a paged list:
 *
 * ```json
 * { "items": [...], "page": 1, "page_size": 10, "total_count": 42,
 *   "has_next_page": true, "has_previous_page": false }
 * ```
 *
 * `page` echoes the current page rather than naming the next one, so core's
 * page-number strategy would only stop on an empty page, one request late.
 * {@link paginateKota} follows `has_next_page` instead.
 */
import * as Pagination from "@distilled.cloud/core/pagination";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/**
 * Request `page`, `page + 1`, ... from the input's `page` (default 1) while
 * the response says `has_next_page`. An empty page also ends the walk, so a
 * stale flag cannot loop forever.
 */
export const paginateKota: Pagination.PaginationStrategy = (operation, input, pagination) => {
  const inputToken = pagination.inputToken ?? "page";
  const hasNextPath = pagination.hasNextPage ?? "has_next_page";
  const itemsPath = pagination.items ?? "items";
  const startPage = typeof input[inputToken] === "number" ? (input[inputToken] as number) : 1;

  type State = { readonly page: number; readonly done: boolean };
  return Stream.unfold({ page: startPage, done: false } as State, (state) =>
    Effect.gen(function* () {
      if (state.done) return undefined;
      const response = yield* operation({ ...input, [inputToken]: state.page } as typeof input);
      const items = Pagination.getItems(response, itemsPath);
      const hasNext = Pagination.getPath(response, hasNextPath) === true;
      return [response, { page: state.page + 1, done: !hasNext || items.length === 0 }] as const;
    }),
  );
};
