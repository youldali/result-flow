# Core concepts

[README](../README.md) · [Getting started](getting-started.md) · [API reference](api-reference.md)

A flow describes how to produce a Result. Its type records the success value,
typed failures, and context required at execution.

## Type parameters

`ResultFlow<Success, Failure, Context = Record<never, never>>` uses neverthrow's
success-first ordering. Context is optional when the flow has no context keys.
A failure type of `never` means no typed Err, not that execution cannot throw.

## Lazy and immutable

Factories passed to `from`, and callbacks passed to `of` and `gen`, are deferred.
Each time execution reaches a factory or builder, it is invoked again; ResultFlow
does not memoize its result. Retries re-execute the portion of the workflow they
wrap. Preconditions or short-circuiting can prevent execution from reaching an operation.
An already-created Result is reused. An already-created Promise or ResultAsync
may already be doing work; wrapping it does not defer or restart that work.

This complete example distinguishes invocation from reuse:

```ts
import { ResultFlow } from '@youldali/result-flow';
import { okAsync } from 'neverthrow';

let calls = 0;
const operation = () => okAsync(++calls);
const eager = ResultFlow.from(operation()); // Calls operation now.
const lazy = ResultFlow.from(() => operation());
await eager.run(); // Ok(1)
await eager.run(); // Ok(1)
await lazy.run();  // Ok(2)
await lazy.run();  // Ok(3)
```

Flow combinators return new flows; the original flow remains usable:

```ts
import { ResultFlow } from '@youldali/result-flow';
import { ok } from 'neverthrow';

const base = ResultFlow.from(ok(10));
const doubled = base.map(value => value * 2);
await base.run();    // Ok(10)
await doubled.run(); // Ok(20)
```

Immutability applies to the flow composition, not to captured variables, context
objects or success values. Those can still contain mutable state.

`run()` returns `Promise<Result<A, E>>`. `runAndMatch()` handles the returned `Ok`
or `Err` and returns a promise of the selected handler's value. `runPeriodically()`
starts interval execution and returns `void`.
See [execution](execution.md) for periodic execution and operator scope.

## Short-circuiting

An Err skips subsequent success steps (`map`, `chain`, `ensure`, success observers).
`tryTo` and generator yields propagate it as the final Result unless explicitly
recovered. Thrown exceptions and rejected promises instead reject execution.
See [failure handling](failure-handling.md) for recovery and cleanup boundaries.

## Context

Declare context when constructing a flow. Supplying it later to `run` does not
retroactively type earlier callbacks. The run parameter is required when `keyof C`
is nonempty, even if the properties of that type are optional. With no context
keys, `run()` is valid and callbacks receive an empty context by default.

```ts
import { ResultFlow } from '@youldali/result-flow';

type Context = { requestId: string };
const flow = ResultFlow.of<number, never, Context>(async (_helpers, { context }) => {
  return context.requestId.length;
}).map((length, { context }) => `${context.requestId}:${length}`);

await flow.run({ context: { requestId: 'req-123' } }); // Ok('req-123:7')
```

Nested flows executed by `tryTo`, `chain`, fallback handlers, generator helpers,
and coordinators receive the current context and abort signal. Callbacks that
accept extras receive context as `extras.context` and the optional signal as
`extras.abortSignal`. `from` factories take no arguments; use `of` to access extras
inside an operation.

Not every callback receives extras. `retryPolicy.condition` receives only the
error; `beforeRetry` receives error, retry number, and extras. `of` inline recovery
callbacks and `tryTo` error mappers receive only the error, while generator
recovery helpers also receive extras. See the [canonical signatures](api-reference.md).

## Result-like inputs

| API | Accepted inputs or callback results |
| --- | --- |
| `from` / `lift` | Result, ResultAsync, Promise of Result, or a zero-argument factory returning one of these. |
| `of` | An async builder returning a success value; its helpers consume Result-like values. |
| `tryTo`, `chain`, `orElse`, `catch` | Result, ResultAsync, Promise of Result, or another ResultFlow. |
| `gen` yields | Result, ResultAsync, or ResultFlow; a raw Promise of Result is not directly yieldable. |
| Generator recovery helpers | Result-like inputs including promises; return a flow that can be yielded. |
| `recover` | A plain success value or a promise of one. |

For an application operation returning a promised Result, await it before yielding:

```ts
import { ResultFlow } from '@youldali/result-flow';
import type { Result } from 'neverthrow';

declare function operation(): Promise<Result<number, 'unavailable'>>;

const flow = ResultFlow.gen<number, 'unavailable'>(async function* () {
  return yield* (await operation());
});
```

Awaiting obtains the Result; `yield*` then unwraps `Ok` or propagates `Err`.
The operation is called inside the generator, so it remains deferred until
execution. A rejected promise still rejects execution; awaiting does not convert
it into a typed `Err`.

`from` does not accept a ResultFlow directly; use that flow itself or compose it.
See [callback helpers](api-reference.md#public-helper-types-and-callback-helpers).

## Composition and types

- `map` changes success; `mapError` changes the typed error; `mapBoth` changes
  both with separate handlers, invoking only the matching one.
- `chain` replaces success, unions old and new errors, and intersects context
  requirements (`C & C2`). `orElse` keeps the success type, replaces the error type,
  and combines contexts. `recover` unions success types and removes typed errors.
- `catch` unions the success and error types of the handler with the original
  types. An Err-only handler preserves success; a rethrow-only handler preserves
  both. Its returned flow uses the same context type.
- `ensure`, `precondition`, `timeout`, and `repeatUntil` can add typed errors.
- Coordination combines context requirements across all inputs. `all` preserves
  tuple success positions; `allSettled` preserves tuple Result positions.
  `firstOk` and `race` union input success types. See [coordination](execution.md#coordinate-flows).

```ts
import { ResultFlow } from '@youldali/result-flow';
import { ok } from 'neverthrow';

type Context = { requestId: string };
const combined = ResultFlow.all([
  ResultFlow.of<number, 'missing', Context>(async (_helpers, { context }) =>
    context.requestId.length),
  ResultFlow.from<boolean, 'invalid'>(ok(true)),
] as const);
// Success: readonly [number, boolean]; error: 'missing' | 'invalid'.
await combined.run({ context: { requestId: 'req-123' } });
```
