# Failure handling

[README](../README.md) · [Core concepts](core-concepts.md) · [API reference](api-reference.md)

Typed Err values describe expected failures. Throws and rejected promises are
exceptions and reject execution by default, including when the thrown value is
not an Error object. Choose a handler for the signal you intend to handle.

## Choose a method

| Method | Handles | Result |
| --- | --- | --- |
| [`orElse`](api-reference.md#orelse) | Err | Fallible alternative; replaces the error type |
| [`recover`](api-reference.md#recover) | Err | Plain fallback success; error type becomes never |
| [`catch`](api-reference.md#catch) | Exception | Result-like recovery; existing Ok and Err pass through |
| [`tap` / `ifSuccess`](api-reference.md#tap) | Ok | Observe success |
| [`tapError`](api-reference.md#taperror) | Err | Observe the raw typed error |
| [`ifFailure`](api-reference.md#iffailure) | Err or exception | Observe a discriminated failure |
| [`tapBoth`](api-reference.md#tapboth) | Returned Result | Observe either typed outcome |
| [`finally`](api-reference.md#finally) | Ok, Err, or exception | Await cleanup |

## Propagation and recovery

`orElse` and `recover` leave Ok untouched and do not catch exceptions. `orElse`
can fail again, returning the fallback error. `recover` returns a plain value,
possibly asynchronously; its error type is never, but its callback can still throw.

`catch` receives an unknown cause and current extras. Returning Err converts it
to a typed failure; returning Ok recovers. Returning a flow runs that flow with
current extras. A handler's own exception propagates to a later catch, not back
into itself. Err-only handlers preserve the success type; handler error types
are added to existing error types. See [selected exceptions](recipes.md#convert-selected-exceptions).

A catch covers only preceding operators. Later mappers or observers need a later
catch if their exceptions should be handled too.

## Inline helpers

`tryTo` unwraps an Ok and stops the builder with Err on failure. Its `mapError`
overload converts a step's error to the builder's error type. `fail(error)` stops
with a typed failure from a branch. Avoid swallowing the internal interruption
with a broad JavaScript catch around `tryTo`; use the provided recovery helpers.

Always await or return the promise produced by `tryTo`. Calling it without
awaiting or returning it does not stop subsequent builder statements and can
leave a rejection unhandled. These are alternative usage patterns inside a builder:

```ts
const value = await tryTo(step()); // Await when later statements need the value.
return tryTo(step());             // Return when this is the builder's final result.
```

Likewise, await or return `tryToOrRecover` and `tryToOrElse` so their outcomes
participate in the builder's execution.

This complete example recovers a cache miss with the requested product ID, then
uses that ID to look up a price. The local cache is empty; the source contains
only a notebook:

```ts
import { ResultFlow } from '@youldali/result-flow';
import { err, ok, type Result } from 'neverthrow';

type FlowError =
  | { kind: 'cache-miss' }
  | { kind: 'source-missing'; productId: string; cause: 'not-found' };

function readCachedProductId(): Result<string, FlowError> {
  return err({ kind: 'cache-miss' });
}

function readPrice(productId: string): Result<number, 'not-found'> {
  return productId === 'notebook' ? ok(12) : err('not-found');
}

function priceFlow(productId: string) {
  return ResultFlow.of<number, FlowError>(async ({ tryTo, tryToOrRecover }) => {
    const resolvedId = await tryToOrRecover(readCachedProductId(), () => productId);
    return tryTo(readPrice(resolvedId), {
      mapError: cause => ({ kind: 'source-missing', productId: resolvedId, cause }),
    });
  });
}

const available = await priceFlow('notebook').run();
// Ok(12)
const missing = await priceFlow('pen').run();
// Err({ kind: 'source-missing', productId: 'pen', cause: 'not-found' })
```

`tryToOrElse` supplies a fallible alternative instead of a plain value. Generator
helpers `orRecover` and `orElse` return flows for `yield*`; their fallbacks receive
extras as well as the error. `fail` is available in both styles. `promiseHelpers.mapError`
changes only the Err in a promised Result. Full [helper signatures](api-reference.md#public-helper-types-and-callback-helpers)
and examples are in the API reference.

For manual branching, await a Result without `tryTo`, narrow with `isErr`, recover
selected errors yourself and call `fail` for others. See [manual failure handling](recipes.md#handle-one-failure-manually).

## Observation

When an observer succeeds, the original outcome is preserved. If it throws or
rejects, execution rejects with that exception unless a downstream catch handles
it. Effects are awaited; they do not run during flow construction.

`tapError` gets the raw typed error. `ifFailure` gets `FlowFailure<E>` with
`kind: 'err'` and `error`, or `kind: 'exception'` and `cause`. It skips Ok and
rethrows the original exception after successful observation. It does not invoke
its callback again when that callback fails.

`tapBoth` receives the original Result object and does not run on exceptions.
`finally` receives `FlowExit<A, E>`: the same failure alternatives plus
`{ kind: 'ok'; value: A }`. Both types are public exports.

## Cleanup and ordering

ResultFlow's `finally` runs once per execution of its upstream flow after that
execution settles, including on exceptions. It awaits cleanup and then preserves
the original value, typed error, or thrown value. A cleanup exception replaces
that outcome; the library does not automatically aggregate the two failures.
Upstream `tryTo` and `fail` interruptions remain typed Err outcomes.

| Composition | Behavior |
| --- | --- |
| `flow.finally(cleanup).catch(handler)` | Cleanup runs first; the handler can catch its exception. |
| `flow.catch(handler).finally(cleanup)` | Cleanup sees the recovered outcome, or the handler's exception. |
| `flow.ifFailure(report).catch(handler)` | Report sees the original failure before exception recovery. |
| `flow.catch(handler).ifFailure(report)` | Report sees the outcome after recovery; recovered Ok skips it. |

Callbacks can omit unused parameters; use `(_exit, extras)` to access only extras.
For unconditional cleanup, see the [cleanup recipe](recipes.md#clean-up-after-every-outcome).
For timeout placement and cleanup that may still be pending when the caller
receives a timeout, see [execution order](execution.md#operator-order).

## Rollback while preserving both failures

These declarations stand for application operations. Rollback runs only after a
typed failure or exception; if rollback fails too, AggregateError retains both.

```ts
import { ResultFlow } from '@youldali/result-flow';
import type { ResultAsync } from 'neverthrow';

declare function initialize(): ResultAsync<void, 'initialization-failed'>;
declare function rollback(): Promise<void>;

const result = await ResultFlow.from(() => initialize())
  .ifFailure(async failure => {
    try {
      await rollback();
    } catch (cleanupCause) {
      const original = failure.kind === 'err' ? failure.error : failure.cause;
      throw new AggregateError([original, cleanupCause], 'Initialization and rollback failed');
    }
  })
  .run();
```

If rollback succeeds, the original Err is returned or exception rethrown. If it
fails, `run` rejects with AggregateError. A downstream catch can handle that
aggregate. See [`ifFailure`](api-reference.md#iffailure) and [`finally`](api-reference.md#finally).

## Generator cleanup

The `.finally()` operator is separate from JavaScript `try/finally` inside a
generator. The current `gen` driver advances with `next()` but does not call
`return()` or `throw()` on a generator suspended at a failed yield. Therefore a
JavaScript finally around that yield is not guaranteed to execute when the yielded
Result is Err or the yielded operation rejects. Attach ResultFlow `.finally()`
to the constructed flow for cleanup after the driver's execution settles.
