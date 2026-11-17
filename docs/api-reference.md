# API reference

[README](../README.md) · [Core concepts](core-concepts.md) · [Failure handling](failure-handling.md)

Signatures below are class member declarations from the public types, not executable snippets. Examples containing `declare` statements are illustrative contracts for application code. `A`, `E`, and `C` are the current flow’s success, error, and context types. All flow combinators are lazy and return new flows. Unexpected exceptions reject execution unless a downstream `catch` handles them; an error type of `never` does not prevent exceptions.

## Contents

- [Create and identify flows](#create-and-identify-flows)
  - [`ResultFlow.of`](#resultflowof)
  - [`ResultFlow.from`](#resultflowfrom)
  - [`ResultFlow.lift`](#resultflowlift)
  - [`ResultFlow.isResultFlow`](#resultflowisresultflow)
  - [`ResultFlow.gen`](#resultflowgen)
- [Execute flows](#execute-flows)
  - [`run`](#run)
  - [`runAndMatch`](#runandmatch)
- [Transform values](#transform-values)
  - [`map`](#map)
  - [`mapBoth`](#mapboth)
  - [`mapError`](#maperror)
- [Compose and recover](#compose-and-recover)
  - [`chain`](#chain)
  - [`orElse`](#orelse)
  - [`recover`](#recover)
  - [`catch`](#catch)
- [Observe and clean up](#observe-and-clean-up)
  - [`ifSuccess`](#ifsuccess)
  - [`tap`](#tap)
  - [`ifFailure`](#iffailure)
  - [`tapError`](#taperror)
  - [`finally`](#finally)
  - [`tapBoth`](#tapboth)
- [Validate and guard](#validate-and-guard)
  - [`precondition`](#precondition)
  - [`ensure`](#ensure)
- [Control execution](#control-execution)
  - [`retryPolicy`](#retrypolicy)
  - [`repeatUntil`](#repeatuntil)
  - [`timeout`](#timeout)
  - [`runPeriodically`](#runperiodically)
- [Coordinate flows](#coordinate-flows)
  - [`ResultFlow.all`](#resultflowall)
  - [`ResultFlow.allSettled`](#resultflowallsettled)
  - [`ResultFlow.firstOk`](#resultflowfirstok)
  - [`ResultFlow.race`](#resultflowrace)
- [Public helper types and callback helpers](#public-helper-types-and-callback-helpers)
  - [`FlowFailure`](#flowfailure)
  - [`FlowExit`](#flowexit)
  - [`ResultFlowExtras`](#resultflowextras)
  - [`ResultFlowRunParams`](#resultflowrunparams)
  - [`ResultFlowHelpers`](#resultflowhelpers)
  - [`ResultFlowGenHelpers`](#resultflowgenhelpers)
  - [`DelayStrategy`](#delaystrategy)
- [`[Symbol.iterator]`](#symboliterator)
- [Signature notation](#signature-notation)

## Create and identify flows

### `ResultFlow.of`

Builds a flow from an async function. The function receives helpers and extras.
The builder returns the successful value directly. Use `tryTo` to unwrap
result-producing operations and propagate typed failures, or `fail` to stop with
a typed error. Returning an `Err` directly treats that object as a success value,
if the declared success type permits it; it does not propagate the failure.
Use [`from`](#resultflowfrom) to wrap an existing result-producing operation.

```typescript
static of<A, E, C extends BaseContext = DefaultContext>(
  builderFunction: (helpers: ResultFlowHelpers<E, C>, extras: ResultFlowExtras<C>) => Promise<A>
): ResultFlow<A, E, C>;
```

Example:

```ts
import { ResultFlow } from '@youldali/result-flow';

const flow = ResultFlow.of<number, 'too-small'>(async ({ fail }) => {
  const value = 5;
  if (value < 10) {
    fail('too-small');
  }
  return value;
});

await flow.run(); // Err('too-small')
```

See [callback helpers](#resultflowhelpers) for all helper signatures.

Example with `tryTo` error mapping:

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

declare function findUser(id: string): N.ResultAsync<User, 'not-found'>;
type User = { id: string; email: string };
type FlowError = { kind: 'flow-error'; cause: 'not-found' };

const flow = ResultFlow.of<User, FlowError>(async ({ tryTo }) => {
  return tryTo(findUser('missing'), {
    mapError: (error) => ({ kind: 'flow-error', cause: error }),
  });
});
```

Example with `tryToOrRecover`:

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

declare function saveUser(user: User): N.ResultAsync<User, 'save-failed'>;
declare function findUser(id: string): N.ResultAsync<User, 'not-found'>;
type UserError = 'not-found' | 'invalid-email' | 'save-failed';
type User = { id: string; email: string };
const flow = ResultFlow.of<User, UserError>(async ({ tryTo, tryToOrRecover }) => {
  const user = await tryToOrRecover(findUser('missing'), () => ({
    id: 'guest',
    email: 'guest@example.com',
  }));

  return tryTo(saveUser(user));
});
```

Example with `tryToOrElse`:

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

declare function findDefaultUser(): N.ResultAsync<User, 'not-found'>;
declare function findUser(id: string): N.ResultAsync<User, 'not-found'>;
type UserError = 'not-found' | 'invalid-email' | 'save-failed';
type User = { id: string; email: string };
const flow = ResultFlow.of<User, UserError>(async ({ tryToOrElse }) => {
  return tryToOrElse(findUser('missing'), () => findDefaultUser());
});
```

Guide: [Getting started](getting-started.md#build-and-run-an-order-workflow).

### `ResultFlow.from`

Creates a flow from a `Result`, `ResultAsync`, `Promise<Result>`, or a function that returns one of those.

```typescript
static from<A, E, C extends BaseContext = DefaultContext>(
  value: Promise<Result<A, E>>
    | Result<A, E>
    | ResultAsync<A, E>
    | (() => Promise<Result<A, E>>)
    | (() => Result<A, E>)
    | (() => ResultAsync<A, E>)
): ResultFlow<A, E, C>;
```

Examples:

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

ResultFlow.from(N.ok(10));
ResultFlow.from(N.okAsync(10));
ResultFlow.from(Promise.resolve(N.ok(10)));
ResultFlow.from(() => N.ok(10));
```

Use a function when the operation should be re-executed on every `run()` or retry.

Guide: [Constructor choices](getting-started.md#choose-a-constructor).

### `ResultFlow.lift`

Alias for `ResultFlow.from`.

```typescript
static lift<A, E, C extends BaseContext = DefaultContext>(
  value: Promise<Result<A, E>>
    | Result<A, E>
    | ResultAsync<A, E>
    | (() => Promise<Result<A, E>>)
    | (() => Result<A, E>)
    | (() => ResultAsync<A, E>)
): ResultFlow<A, E, C>;
```

Guide: [Constructor choices](getting-started.md#choose-a-constructor).

### `ResultFlow.isResultFlow`

Checks `value instanceof ResultFlow` at runtime. This identifies a ResultFlow
instance; it does not validate the runtime shape of success values, errors, or
context against the supplied generic type arguments.

```typescript
static isResultFlow<A, E, C extends BaseContext = DefaultContext>(
  value: unknown
): value is ResultFlow<A, E, C>;
```

This is mostly useful when writing helpers that accept polymorphic result-like values.

Guide: [Result-like inputs](core-concepts.md#result-like-inputs).

### `ResultFlow.gen`

Creates a flow from an async generator. Inside the generator, use `yield*` with `ResultFlow`, `Result`, or `ResultAsync` values.

```typescript
static gen<A, E, C extends BaseContext = DefaultContext>(
  f: ((
    helpers: ResultFlowGenHelpers<E, C>,
    extras: ResultFlowExtras<C>
  ) => AsyncGenerator<
    YieldableResultFlow<any, E, C> | Result<any, E> | ResultAsync<any, E>,
    A,
    any
  >)
): ResultFlow<A, E, C>;
```

Example:

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

const flow = ResultFlow.gen<number, string>(async function* () {
  const a = yield* N.ok(5);
  const b = yield* N.okAsync(10);
  return a + b;
});

await flow.run(); // Ok(15)
```

Example with context:

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

type Context = { multiplier: number };

const flow = ResultFlow.gen<number, never, Context>(async function* (_helpers, { context }) {
  const value = yield* N.ok(10);
  return value * context.multiplier;
});

await flow.run({ context: { multiplier: 3 } }); // Ok(30)
```

Example with inline recovery:

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

declare function findUser(id: string): N.ResultAsync<User, 'not-found'>;
type User = { id: string; email: string };
const flow = ResultFlow.gen<User, never>(async function* ({ orRecover }) {
  return yield* orRecover(findUser('missing'), () => ({
    id: 'guest',
    email: 'guest@example.com',
  }));
});
```

Example with an inline fallible fallback:

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

declare function findDefaultUser(): N.ResultAsync<User, 'not-found'>;
declare function findUser(id: string): N.ResultAsync<User, 'not-found'>;
type UserError = 'not-found' | 'invalid-email' | 'save-failed';
type User = { id: string; email: string };
const flow = ResultFlow.gen<User, UserError>(async function* ({ orElse }) {
  return yield* orElse(findUser('missing'), () => findDefaultUser());
});
```

The driver does not close generators suspended at a failed yield. Use the flow’s `.finally()` operator for cleanup; see [generator cleanup](failure-handling.md#generator-cleanup).

Guide: [Generator composition](getting-started.md#choose-a-constructor).

## Execute flows

### `run`

Executes the flow and returns a `Promise<Result<A, E>>`.

```typescript
run(
  ...args: keyof C extends never ? [] | [ResultFlowRunParams<C>] : [ResultFlowRunParams<C>]
): Promise<Result<A, E>>;
```

The context argument is required when the flow context type has keys; it is optional otherwise. `abortSignal` can be passed with or without context.

Examples:

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

await ResultFlow.from(N.ok(10)).run(); // Ok(10)
await ResultFlow.from<number, string>(N.err('error')).run(); // Err('error')
```

With context:

```ts
import { ResultFlow } from '@youldali/result-flow';

type Context = { requestId: string };

const flow = ResultFlow.of<string, never, Context>(async (_helpers, { context }) => {
  return context.requestId;
});

await flow.run({ context: { requestId: 'req-123' } }); // Ok('req-123')
```

Guide: [Context and execution](core-concepts.md#context).

### `runAndMatch`

Executes the flow and converts the final `Result` into a plain value by handling both cases.

```typescript
runAndMatch<B>(
  handlers: {
    ok: (value: A, extras: ResultFlowExtras<C>) => B | Promise<B>;
    err: (error: E, extras: ResultFlowExtras<C>) => B | Promise<B>;
  },
  ...args: keyof C extends never ? [] | [ResultFlowRunParams<C>] : [ResultFlowRunParams<C>]
): Promise<B>;
```

The context argument is required when the flow context type has keys; it is optional otherwise. If `abortSignal` is passed, the selected handler receives it in `extras`.

Example:

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

declare function findUser(id: string): N.ResultAsync<User, 'not-found'>;
type User = { id: string; email: string };
const response = await ResultFlow
  .from<User, 'not-found'>(() => findUser('user-1'))
  .runAndMatch<{ status: number; body: User | { error: string } }>({
    ok: (user) => ({ status: 200, body: user }),
    err: (error) => ({ status: 404, body: { error } }),
  });
```

`runAndMatch` is terminal: it executes the flow immediately and returns `Promise<B>`, not a `ResultFlow`. If the underlying flow throws or rejects instead of returning a `Result`, `runAndMatch` rejects and does not call either handler. If the selected handler throws or rejects, `runAndMatch` rejects with that exception.

Guide: [Application responses](recipes.md#convert-a-flow-to-a-response).

## Transform values

### `map`

Transforms a success value. It does not run when the flow is a failure.

```typescript
map<A2>(f: (value: A, extras: ResultFlowExtras<C>) => A2): ResultFlow<A2, E, C>;
```

Example:

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

const result = await ResultFlow
  .from(N.ok(10))
  .map((value) => value + 5)
  .run();

// Ok(15)
```

Guide: [Composition and types](core-concepts.md#composition-and-types).

### `mapBoth`

Transforms either side of a flow in one call. If the flow succeeds, `mapBoth` calls `ok` and returns `Ok(mappedValue)`. If the flow fails, it calls `err` and returns `Err(mappedError)`.

Only the selected handler runs. If the underlying flow throws or rejects, `run()` rejects and neither handler is called. If the selected handler throws, `run()` rejects with that exception.

```typescript
mapBoth<A2, E2>(
  handlers: {
    ok: (value: A, extras: ResultFlowExtras<C>) => A2;
    err: (error: E, extras: ResultFlowExtras<C>) => E2;
  }
): ResultFlow<A2, E2, C>;
```

Success example:

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

const result = await ResultFlow
  .from<number, string>(N.ok(10))
  .mapBoth({
    ok: (value) => value.toString(),
    err: (error) => ({ code: error }),
  })
  .run();

// Ok('10')
```

Error example:

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

const result = await ResultFlow
  .from<number, string>(N.err('not-found'))
  .mapBoth({
    ok: (value) => value.toString(),
    err: (error) => ({ code: error, retryable: false }),
  })
  .run();

// Err({ code: 'not-found', retryable: false })
```

`mapBoth` is useful when both success and error values should be normalized together. Prefer `map` when only the success value changes, and `mapError` when only the error value changes.

Guide: [Composition and types](core-concepts.md#composition-and-types).

### `mapError`

Transforms a failure value. It does not run when the flow is a success.

```typescript
mapError<E2>(f: (value: E, extras: ResultFlowExtras<C>) => E2): ResultFlow<A, E2, C>;
```

Example:

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

const result = await ResultFlow
  .from<number, 'not-found'>(N.err('not-found'))
  .mapError((error) => ({ code: error, retryable: false }))
  .run();

// Err({ code: 'not-found', retryable: false })
```

Guide: [Composition and types](core-concepts.md#composition-and-types).

## Compose and recover

### `chain`

Runs another result-producing operation after a success. It does not run when the previous flow is a failure.

```typescript
chain<A2, E2, C2 extends BaseContext = DefaultContext>(
  f: (value: A, extras: ResultFlowExtras<C & C2>) => PolymorphicResult<A2, E2, C2>
): ResultFlow<A2, E | E2, C & C2>;
```

Examples:

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

const result = await ResultFlow
  .from(N.ok(10))
  .chain((value) => N.ok(value + 5))
  .chain((value) => Promise.resolve(N.ok(value * 2)))
  .run();

// Ok(30)
```

With a returned `ResultFlow`:

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

type User = { id: string; email: string };
declare function findUser(id: string): N.ResultAsync<User, 'not-found'>;
const result = await ResultFlow
  .from(N.ok('user-1'))
  .chain((id) => ResultFlow.from(() => findUser(id)))
  .run();
```

Guide: [Composition and types](core-concepts.md#composition-and-types).

### `orElse`

Runs a fallback when the previous flow fails. The fallback receives the previous error and returns another fallible operation.

```typescript
orElse<E2, C2 extends BaseContext = DefaultContext>(
  alternative: (error: E, extras: ResultFlowExtras<C & C2>) => PolymorphicResult<A, E2, C2>
): ResultFlow<A, E2, C & C2>;
```

Example:

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

const result = await ResultFlow
  .from<number, 'cache-miss'>(N.err('cache-miss'))
  .orElse(() => N.ok(10))
  .run();

// Ok(10)
```

If the fallback also fails, the final result contains the fallback error.

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

const result = await ResultFlow
  .from<number, 'cache-miss'>(N.err('cache-miss'))
  .orElse(() => N.err<number, 'db-error'>('db-error'))
  .run();

// Err('db-error')
```

Guide: [Recovery and exceptions](failure-handling.md#propagation-and-recovery).

### `recover`

Turns a failure into a fallback success value. The fallback receives the previous error and returns a plain value, so the returned flow has error type `never`.

```typescript
recover<A2>(
  f: (error: E, extras: ResultFlowExtras<C>) => A2 | Promise<A2>
): ResultFlow<A | A2, never, C>;
```

Example:

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

const result = await ResultFlow
  .from<number, 'missing'>(N.err('missing'))
  .recover(() => 0)
  .run();

// Ok(0)
```

The fallback is not called when the original flow succeeds.

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

const result = await ResultFlow
  .from<number, 'missing'>(N.ok(10))
  .recover(() => 0)
  .run();

// Ok(10)
```

Use `recover` for infallible fallback values. Use `orElse` for fallback operations that can fail and return another `Result`, `ResultAsync`, or `ResultFlow`.

Guide: [Recovery and exceptions](failure-handling.md#propagation-and-recovery).

### `catch`

Handles unexpected synchronous exceptions and asynchronous rejections from the preceding flow. Existing `Ok` and `Err` outcomes pass through unchanged without invoking the handler, including failures produced by `fail()`, `tryTo()`, or generator short-circuiting.

```typescript
catch<A2 = never, E2 = never>(
  handler: (cause: unknown, extras: ResultFlowExtras<C>) => PolymorphicResult<A2, E2, C>
): ResultFlow<A | A2, E | E2, C>;
```

The handler receives the original thrown value as `unknown` and the current context and abort signal. Returning `Ok` recovers with a successful value; returning `Err` converts the exception into a typed failure. Asynchronous handlers are awaited. A handler can also return a `ResultFlow`, which executes with the current context and abort signal. Its explicit failures stay Result failures, and its exceptions propagate to any downstream `.catch()`. Calling `.catch()` is lazy and returns a new flow; each execution runs independently.

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

declare const flow: ResultFlow<string, 'missing'>;
declare function transform(value: string): number;
declare function toDomainError(cause: unknown): 'invalid';
declare function format(value: number): string;

const formatted = flow
  .map(transform)
  .catch(cause => N.err(toDomainError(cause)))
  .map(format);
```

Ordering defines the exception boundary: exceptions from `flow` or `transform` are handled here. Exceptions from `format` still propagate unless another `.catch()` is chained after it. A handler's own throws or rejections also propagate unchanged; the same operator never catches them again, but a downstream `.catch()` can.

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

const defaultValue = 'fallback';
declare class NotFoundError extends Error {}
declare const flow: ResultFlow<string, 'missing'>;
const withFallback = flow.catch(cause => {
  if (cause instanceof NotFoundError) {
    return N.ok(defaultValue);
  }

  throw cause;
});
```

Unlike `.orElse()` and `.recover()`, `.catch()` handles exceptions rather than explicit Result failures. It preserves the original error type and adds any handler error type. An Err-only handler preserves the success type, and a rethrow-only handler preserves both types. Without `.catch()`, exceptions continue to reject execution as before.

A fallback flow can perform additional lazy work:

```ts
import { ResultFlow } from '@youldali/result-flow';

declare const flow: ResultFlow<string, 'missing'>;
const withFallbackFlow = flow.catch(cause =>
  ResultFlow.of<string, never>(async () => {
    console.error(cause);
    return 'fallback';
  }),
);
```

Guide: [Recovery and exceptions](failure-handling.md#propagation-and-recovery).

## Observe and clean up

### `ifSuccess`

Runs a side effect when the flow succeeds, then keeps the original success value.

```typescript
ifSuccess(
  f: (value: A, extras: ResultFlowExtras<C>) => void | Promise<void>
): ResultFlow<A, E, C>;
```

Example:

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

const result = await ResultFlow
  .from(N.ok(10))
  .ifSuccess((value) => console.log(`Success: ${value}`))
  .run();

// Ok(10)
```

If the effect throws or rejects, the exception is not handled by `ResultFlow`; `run()` rejects with that exception.

Guide: [Observation](failure-handling.md#observation).

### `tap`

Alias for `ifSuccess`.

```typescript
tap(
  f: (value: A, extras: ResultFlowExtras<C>) => void | Promise<void>
): ResultFlow<A, E, C>;
```

Example:

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

const result = await ResultFlow
  .from(N.ok(10))
  .tap((value) => console.log(`Success: ${value}`))
  .run();

// Ok(10)
```

Guide: [Observation](failure-handling.md#observation).

### `ifFailure`

Lazily observes both typed `Err` values and thrown exceptions or rejected promises. Each run executes the upstream flow once, forwarding the current context and abort signal. `Ok` skips the effect. The callback receives `FlowFailure<E>`, exported from the package entry point:

```typescript
ifFailure(
  effect: (failure: FlowFailure<E>, extras: ResultFlowExtras<C>) => void | Promise<void>
): ResultFlow<A, E, C>;
```

Narrow `failure.kind` to handle either failure kind. Use `.tapError((error, extras) => …)` to observe only typed failures with the raw `E`.

One callback can roll back after either kind of failure and retain the original failure if rollback also fails:

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

declare function rollback(): Promise<void>;
declare function initialize(): N.ResultAsync<void, 'initialization-failed'>;
const result = await ResultFlow
  .from(() => initialize()) // Returns a Result or a promise of a Result.
  .ifFailure(async (failure) => {
    try {
      await rollback();
    } catch (cleanupCause) {
      const originalFailure = failure.kind === 'err' ? failure.error : failure.cause;
      throw new AggregateError(
        [originalFailure, cleanupCause],
        'Initialization and rollback failed',
      );
    }
  })
  .run();
```

The effect is awaited. If rollback succeeds, the original typed failure is preserved or the original thrown value is rethrown, including non-`Error` values. Upstream `fail()` and `tryTo()` failures arrive as `kind: 'err'`. The callback may use ordinary `try/catch` internally. An exception escaping the callback propagates downstream; this `ifFailure` operator does not invoke its callback again for that exception. If initialization fails and rollback also throws or rejects, `run()` rejects with the `AggregateError` containing both failures.

Use `.catch()` for exception recovery and `.finally()` for unconditional cleanup, including success. A downstream `.catch()` can recover from either the original exception or a cleanup exception; placing `.catch()` before `.ifFailure()` makes the effect observe the outcome after recovery.

Guide: [Observation](failure-handling.md#observation).

### `tapError`

Observes only typed `Err` values with the raw error and current extras. Awaits the effect and preserves the original typed failure when the effect succeeds. `Ok` values and upstream exceptions bypass the callback. If the effect throws or rejects, `run()` rejects with that exception.

```typescript
tapError(
  f: (value: E, extras: ResultFlowExtras<C>) => void | Promise<void>
): ResultFlow<A, E, C>;
```

Example:

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

const result = await ResultFlow
  .from<number, string>(N.err('error'))
  .tapError((error) => console.error(`Failed: ${error}`))
  .run();

// Err('error')
```

Guide: [Observation](failure-handling.md#observation).

### `finally`

Runs and awaits cleanup exactly once per execution after the upstream flow completes. **Cleanup runs even when the upstream flow throws an exception or a promise rejects**, as well as when it returns `Ok` or `Err`. No `.catch()` is needed for cleanup to run.

The operator is lazy; cleanup receives the upstream exit and the current context and abort signal. `FlowExit` is exported from the package entry point.

```typescript
finally(
  effect: (exit: FlowExit<A, E>, extras: ResultFlowExtras<C>) => void | Promise<void>
): ResultFlow<A, E, C>;
```

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

type Context = { requestId: string };
type Order = { id: string };
type SaveError = 'save-failed';

declare function saveOrder(order: Order): N.ResultAsync<Order, SaveError>;
declare function releaseResources(requestId: string): Promise<void>;

const order: Order = { id: 'order-1' };
const result = await ResultFlow
  .from<Order, SaveError, Context>(() => saveOrder(order))
  .finally(async (_exit, { context }) => {
    await releaseResources(context.requestId);
  })
  .run({ context: { requestId: 'req-123' } });
```

For example, cleanup still runs when no Result is returned because the upstream throws:

```ts
import { ResultFlow } from '@youldali/result-flow';

await ResultFlow
  .of(async () => {
    throw new Error('Something went wrong');
  })
  .finally(() => {
    console.log('Cleanup runs even after an exception');
  })
  .run();
// Logs the cleanup message, then rejects with the original Error.
```

This follows JavaScript `try/finally` semantics: if cleanup succeeds, the original success value, typed failure, or thrown value is preserved. If cleanup throws or rejects, its exception replaces the upstream outcome, including an earlier exception or typed failure, and execution rejects unless a downstream `.catch()` handles it. Failures raised by upstream `fail()` and `tryTo()` remain typed `Err` results when cleanup succeeds.

Cleanup callbacks can omit unused parameters. To access only extras, use `(_exit, extras)`. Use `.tapBoth((result, extras) => …)` for callbacks that need the original Result object.

For rollback only after failure, use [`.ifFailure()`](#iffailure) to observe either a typed failure or an exception and aggregate the original failure with a rollback error.

Ordering with `.catch()` matters:

- `flow.finally(cleanup).catch(handler)` runs cleanup before the handler. The handler can catch a cleanup exception.
- `flow.catch(handler).finally(cleanup)` lets cleanup observe the outcome after recovery (`ok` or `err`), or `exception` if the handler throws or rejects.

If a timeout wraps this flow, it may settle before underlying cleanup completes. See [timeout and cleanup order](execution.md#operator-order).

Guide: [Cleanup and ordering](failure-handling.md#cleanup-and-ordering).

### `tapBoth`

Lazily observes a returned `Ok` or `Err` with `(result, extras)`, awaits the effect, and preserves the original result.

```typescript
tapBoth(
  effect: (result: Result<A, E>, extras: ResultFlowExtras<C>) => void | Promise<void>
): ResultFlow<A, E, C>;
```

Example:

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

const result = await ResultFlow
  .from(N.ok(10))
  .tapBoth((result) => {
    console.log(result.isOk() ? `Success: ${result.value}` : 'Failed');
  })
  .run();

// Ok(10)
```

If the effect throws or rejects, the exception is not handled by `ResultFlow`; `run()` rejects with that exception. If the wrapped flow throws or rejects before returning a `Result`, the effect is not called.

Guide: [Observation](failure-handling.md#observation).

## Validate and guard

### `precondition`

Checks a condition before the wrapped flow starts, on every execution. If it passes, the wrapped flow runs with the same context and abort signal. If it fails, `onFailure` produces a typed `Err` and the entire wrapped flow is skipped. Constructing the wrapper does not execute either callback.

```typescript
precondition<E2>(
  predicate: (extras: ResultFlowExtras<C>) => boolean | Promise<boolean>,
  onFailure: (extras: ResultFlowExtras<C>) => E2 | Promise<E2>
): ResultFlow<A, E | E2, C>;
```

Example: see the [shutdown guard recipe](recipes.md#guard-new-work-during-shutdown).

`.precondition()` checks before the wrapped flow starts, while `.ensure()` validates a successful upstream value. Use a factory with `.from()` to keep the underlying work lazy; an already-started promise cannot be deferred by the guard.

Both callbacks may be synchronous or asynchronous. If either throws or rejects, execution rejects with that exception unless a downstream `.catch()` handles it. A false predicate is a typed failure, not an exception.

Ordering with retries matters: `flow.precondition(...).retryPolicy(...)` checks on every attempt the policy executes, including retries of a failed check. `flow.retryPolicy(...).precondition(...)` checks once before entering the retry loop; a failed check skips the loop entirely.

Guide: [Guards and validation](execution.md#guard-before-work-validate-after-success).

### `ensure`

Validates a success value. If the predicate passes, the original value is kept unchanged. If the predicate fails, the flow becomes a failure using the error returned by `onFailure`.

It does not run when the flow is already a failure.

```typescript
ensure<E2>(
  predicate: (value: A, extras: ResultFlowExtras<C>) => boolean | Promise<boolean>,
  onFailure: (value: A, extras: ResultFlowExtras<C>) => E2 | Promise<E2>
): ResultFlow<A, E | E2, C>;
```

Example:

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

const result = await ResultFlow
  .from(N.ok(5))
  .ensure(
    (value) => value >= 10,
    (value) => ({ code: 'too-small' as const, value }),
  )
  .run();

// Err({ code: 'too-small', value: 5 })
```

If `predicate` or `onFailure` throws or rejects, `run()` rejects with that exception.

Guide: [Guards and validation](execution.md#guard-before-work-validate-after-success).

## Control execution

### `retryPolicy`

Retries the previous flow when it returns an `Err`. It is for transient failures: network errors, timeouts, version conflicts, and similar failed attempts.

```typescript
retryPolicy(
  { beforeRetry, condition, maxRetries, retryStrategy, }?: {
    condition?: (error: E) => boolean;
    beforeRetry?: (error: E, retryNumber: number, extras: ResultFlowExtras<C>) => Promise<void> | void;
    maxRetries?: number;
    retryStrategy?: DelayStrategy;
  }
): ResultFlow<A, E, C>;
```

See [`DelayStrategy`](#delaystrategy).

Defaults:

```typescript
{
  condition: () => true,
  maxRetries: 1,
  retryStrategy: { type: 'immediate' },
}
```

Example:

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

declare function callRemoteService(): N.ResultAsync<string, 'timeout'>;
const result = await ResultFlow
  .from(() => callRemoteService())
  .retryPolicy({
    maxRetries: 2,
    condition: (error) => error === 'timeout',
    retryStrategy: { type: 'exponentialBackoff', baseDelayMs: 250, maxDelayMs: 1000 },
  })
  .run();
```

Only the flow before `retryPolicy` is retried. Downstream operators are outside the repetition scope. Success-path operators run once if the final outcome is `Ok`; failure handlers and observers run according to their normal semantics.

The default permits one additional attempt, immediately, for any typed error. `beforeRetry` runs before the delay, with retry numbers starting at 1. Exceptions bypass retries. Use nonnegative integer counts; counts at or below zero run once. Backoff waits and the retry loop do not stop automatically on abort.

Guide: [Repeating work](execution.md#repeating-work).

### `repeatUntil`

Repeats the previous flow when it returns `Ok(value)` and `predicate(value)` returns `false`. It is for successful-but-not-ready values, such as a job status that is still `queued` or `running`.

```typescript
repeatUntil<E2>(
  { predicate, onExhausted, maxRepeats, delayStrategy, beforeRepeat, }: {
    predicate: (value: A, extras: ResultFlowExtras<C>) => boolean | Promise<boolean>;
    onExhausted: (lastValue: A, extras: ResultFlowExtras<C>) => E2 | Promise<E2>;
    maxRepeats?: number;
    delayStrategy?: DelayStrategy;
    beforeRepeat?: (value: A, repeatNumber: number, extras: ResultFlowExtras<C>) => void | Promise<void>;
  }
): ResultFlow<A, E | E2, C>;
```

Defaults:

```typescript
{
  maxRepeats: 1,
  delayStrategy: { type: 'immediate' },
}
```

Example:

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

declare function getJobStatus(id: string): N.ResultAsync<{ status: 'queued' | 'done' }, 'not-found'>;
const result = await ResultFlow
  .from(() => getJobStatus('job-123'))
  .repeatUntil({
    predicate: (job) => job.status === 'done',
    maxRepeats: 5,
    delayStrategy: { type: 'exponentialBackoff', baseDelayMs: 500, maxDelayMs: 5000 },
    beforeRepeat: (job, repeatNumber) => {
      console.log(`Repeat ${repeatNumber}; current status is ${job.status}`);
    },
    onExhausted: (job) => ({ reason: 'job-not-ready' as const, lastStatus: job.status }),
  })
  .run();
```

The original flow always runs at least once. `maxRepeats` is the number of additional runs after the first attempt, so `maxRepeats: 0` runs once and `maxRepeats: 3` can run up to 4 total attempts.

If the wrapped flow returns `Err`, `repeatUntil` stops immediately and returns that original error. If all repeats are exhausted, `onExhausted(lastValue, extras)` builds the returned `Err`.

`beforeRepeat` runs before each additional attempt. Its `repeatNumber` starts at `1` for the first repeat after the first `Ok(value)` that did not satisfy the predicate. Delay is applied after `beforeRepeat` and before the next run.

Only the flow before `repeatUntil` is repeated. Downstream operators are outside the repetition scope. Success-path operators run once if the final outcome is `Ok`; failure handlers and observers run according to their normal semantics.

`retryPolicy`, `repeatUntil`, and `runPeriodically` repeat for different reasons: `retryPolicy` repeats returned failures, `repeatUntil` repeats not-ready successes and returns one final `Result`, and `runPeriodically` schedules ongoing interval execution rather than returning a final `Result`.

Exceptions reject execution. Backoff waits and the polling loop do not stop automatically on abort. Use nonnegative integer repeat counts.

Guide: [Repeating work](execution.md#repeating-work).

### `timeout`

Turns the previous flow into a typed failure when it takes longer than `ms`.

```typescript
timeout<E2>(
  { ms, onTimeout, }: {
    ms: number;
    onTimeout: (extras: ResultFlowExtras<C>) => E2;
  }
): ResultFlow<A, E | E2, C>;
```

Example:

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

declare function callRemoteService(): N.ResultAsync<string, 'timeout'>;
const result = await ResultFlow
  .from(() => callRemoteService())
  .timeout({
    ms: 500,
    onTimeout: () => ({ reason: 'timeout' as const }),
  })
  .run();
```

The timeout signal is composed with any existing `extras.abortSignal` using `AbortSignal.any`, and the composed signal is passed down to the wrapped flow. Pass `extras.abortSignal` to long-running operations so they can stop when the timeout emits; otherwise `timeout` can return early but the underlying work may continue in the background.

If this timeout emits first, `onTimeout` builds the returned `Err`. External aborts rely on the underlying operation observing the signal. If that operation settles first, its outcome wins; otherwise the timeout can still expire and call `onTimeout`.

Composition order with `retryPolicy` is significant: `flow.timeout(...).retryPolicy(...)` gives each retry attempt its own timeout, while `flow.retryPolicy(...).timeout(...)` applies one timeout to the whole retry sequence.

Guide: [Timeouts and cancellation](execution.md#timeouts-and-cancellation).

### `runPeriodically`

Runs the flow repeatedly with `setInterval`. It is for background work and returns `void`, not a final `Result`.

```typescript
runPeriodically<E2>(
  params: {
    recoveryAction?: (error: E, extras: ResultFlowExtras<C>) => PolymorphicResult<unknown, E2>;
    onInterruption?: (
      param: {
        cause: 'failure';
        error: E;
        recoveryError: E2 | undefined;
      }
        | {
          cause: 'aborted';
        }
    ) => void;
    interval: number;
    abortSignal?: AbortSignal;
  } & (keyof C extends never ? {
    context?: C;
  } : {
    context: C;
  })
): void;
```

Example:

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

declare function pollQueue(): N.ResultAsync<void, 'unavailable'>;
const controller = new AbortController();

ResultFlow
  .from(() => pollQueue())
  .runPeriodically({
    interval: 1000,
    abortSignal: controller.signal,
    onInterruption: (interruption) => {
      if (interruption.cause === 'failure') {
        console.error(interruption.error);
      }
    },
  });

```

Later, when stopping the loop, use the same controller:

```ts
controller.abort();
```

Calling `abort()` immediately after startup prevents the first scheduled tick.

Important behavior:

- The first run happens after the first interval delay.
- Without `recoveryAction`, the interval stops on the first `Err`.
- With `recoveryAction`, the interval continues if recovery returns `Ok`.
- If recovery returns `Err`, the interval stops and reports the recovery error.
- If the flow or recovery action throws, the interval callback rejects. `onInterruption` is not called for thrown exceptions.

Runs and recovery can overlap. Abort events clear future ticks, not in-flight work. An already-aborted signal does not prevent scheduling. Exceptions reject the interval callback without clearing the interval. See [periodic execution](execution.md#periodic-execution).

Guide: [Periodic execution](execution.md#periodic-execution).

## Coordinate flows

### `ResultFlow.all`

Combines multiple `ResultFlow`s into one lazy flow. The returned flow runs each input flow in array order, returns `Ok` with the collected success values when all flows succeed, and returns the first `Err` when any flow fails.

```typescript
static all<const Flows extends readonly AnyYieldableResultFlow[]>(
  flows: Flows
): ResultFlow<FlowValues<Flows>, FlowErrors<Flows>, FlowContexts<Flows>>;
```

Example:

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

const flow = ResultFlow.all([
  ResultFlow.from(N.ok(10)),
  ResultFlow.from(N.ok('ready')),
] as const);

await flow.run(); // Ok([10, 'ready'])
```

For readonly tuple inputs, the success type is preserved as a tuple. Error types are unioned, and context types are combined so the returned flow requires the context needed by every input flow.

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

type Context = { requestId: string };

const flow = ResultFlow.all([
  ResultFlow.of<number, 'missing', Context>(async (_helpers, { context }) => {
    return context.requestId.length;
  }),
  ResultFlow.from<boolean, 'invalid'>(N.ok(true)),
] as const);

// ResultFlow<readonly [number, boolean], 'missing' | 'invalid', Context>
await flow.run({ context: { requestId: 'req-123' } });
```

An empty input array succeeds with `Ok([])`.

An exception rejects execution and skips later flows.

Guide: [Coordinating flows](execution.md#coordinate-flows).

### `ResultFlow.allSettled`

Combines multiple `ResultFlow`s into one lazy flow that starts every input flow in parallel and collects each returned `Result` in input order. Input `Err` values are returned inside the success array; they do not fail the outer flow.

```typescript
static allSettled<const Flows extends readonly AnyYieldableResultFlow[]>(
  flows: Flows
): ResultFlow<FlowResults<Flows>, never, FlowContexts<Flows>>;
```

Example:

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

const flow = ResultFlow.allSettled([
  ResultFlow.from(N.ok(10)),
  ResultFlow.from<string, 'missing'>(N.err('missing')),
  ResultFlow.from(N.ok('ready')),
] as const);

await flow.run(); // Ok([Ok(10), Err('missing'), Ok('ready')])
```

For readonly tuple inputs, the success type is preserved as a tuple of `Result` values. The outer error type is `never`, and context types are combined so the returned flow requires the context needed by every input flow.

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';
import type { Result } from 'neverthrow';

type Context = { requestId: string };

const flow = ResultFlow.allSettled([
  ResultFlow.of<number, 'missing', Context>(async (_helpers, { context }) => {
    return context.requestId.length;
  }),
  ResultFlow.from<boolean, 'invalid'>(N.err('invalid')),
] as const);

// ResultFlow<readonly [Result<number, 'missing'>, Result<boolean, 'invalid'>], never, Context>
await flow.run({ context: { requestId: 'req-123' } });
```

An empty input array succeeds with `Ok([])`.

All executions settle before return. If any reject, execution rejects with the first rejection in input order instead of returning Ok.

Guide: [Coordinating flows](execution.md#coordinate-flows).

### `ResultFlow.firstOk`

Combines multiple `ResultFlow`s into one lazy flow. The returned flow runs input flows sequentially, one at a time, in array order and returns the first `Ok` value. Earlier `Err` values are collected and ignored while more candidates are available. Once a flow returns `Ok`, later flows are not run.

```typescript
static firstOk<const Flows extends readonly AnyYieldableResultFlow[]>(
  flows: Flows
): ResultFlow<FlowSuccesses<Flows>, FlowErrorArray<Flows>, FlowContexts<Flows>>;
```

Example:

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

const flow = ResultFlow.firstOk([
  ResultFlow.from<number, 'primary-failed'>(N.err('primary-failed')),
  ResultFlow.from<number, 'backup-failed'>(N.ok(10)),
] as const);

await flow.run(); // Ok(10)
```

If every input flow fails, the returned flow fails with the collected errors in execution order.

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

const flow = ResultFlow.firstOk([
  ResultFlow.from<number, 'primary-failed'>(N.err('primary-failed')),
  ResultFlow.from<number, 'backup-failed'>(N.err('backup-failed')),
] as const);

await flow.run(); // Err(['primary-failed', 'backup-failed'])
```

Success types are unioned, error types are returned as an array of the unioned error type, and context types are combined so the returned flow requires the context needed by every input flow.

An empty input array rejects with `Error('ResultFlow.firstOk requires at least one flow')`.

Exceptions reject execution immediately; they are not collected as typed errors.

Guide: [Coordinating flows](execution.md#coordinate-flows).

### `ResultFlow.race`

Combines multiple `ResultFlow`s into one lazy flow. The returned flow starts every input flow concurrently and returns the first settled `Result`, whether it is `Ok` or `Err`.

```typescript
static race<const Flows extends readonly AnyYieldableResultFlow[]>(
  flows: Flows
): ResultFlow<FlowSuccesses<Flows>, FlowErrors<Flows>, FlowContexts<Flows>>;
```

Example:

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

type User = { id: string; email: string };
declare function fetchReplicaUser(): N.ResultAsync<User, 'not-found'>;
declare function fetchPrimaryUser(): N.ResultAsync<User, 'not-found'>;
const flow = ResultFlow.race([
  ResultFlow.from(() => fetchPrimaryUser()),
  ResultFlow.from(() => fetchReplicaUser()),
] as const);

await flow.run(); // The first settled Ok or Err wins.
```

Success types are unioned, error types are unioned, and context types are combined so the returned flow requires the context needed by every input flow.

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

declare function readCache(requestId: string): N.ResultAsync<User, 'cache-miss'>;
declare function fetchUser(): N.ResultAsync<User, 'not-found'>;
type User = { id: string; email: string };
type Context = { requestId: string };

const flow = ResultFlow.race([
  ResultFlow.of<User, 'cache-miss', Context>(async ({ tryTo }, { context }) => {
    return tryTo(readCache(context.requestId));
  }),
  ResultFlow.from<User, 'not-found'>(() => fetchUser()),
] as const);

// ResultFlow<User, 'cache-miss' | 'not-found', Context>
await flow.run({ context: { requestId: 'req-123' } });
```

An empty input array rejects with `Error('ResultFlow.race requires at least one flow')`. A race over no flows would otherwise never settle.

If the first settlement is a rejection, execution rejects. Losing operations are not automatically cancelled.

Guide: [Coordinating flows](execution.md#coordinate-flows).

### `[Symbol.iterator]`

Allows `yield* flow` in `gen`. It yields the flow to the driver and returns its unwrapped success value.

```typescript
[Symbol.iterator](): Generator<YieldableResultFlow<any, E, C>, A, any>;
```

Example: [generator composition](getting-started.md#choose-a-constructor).

## Public helper types and callback helpers

These types are exported from `@youldali/result-flow`. `Result` and `ResultAsync`
in signatures come from neverthrow. Parameters without defaults are required;
optional callbacks are omitted unless provided.

### `FlowFailure`

```typescript
export type FlowFailure<E> = {
  kind: 'err';
  error: E;
} | {
  kind: 'exception';
  cause: unknown;
};
```

### `FlowExit`

```typescript
export type FlowExit<A, E> = {
  kind: 'ok';
  value: A;
}
  | {
    kind: 'err';
    error: E;
  }
  | {
    kind: 'exception';
    cause: unknown;
  };
```

### `ResultFlowExtras`

```typescript
export type ResultFlowExtras<C extends BaseContext = DefaultContext> = {
  context: C;
  abortSignal?: AbortSignal;
};
```

### `ResultFlowRunParams`

```typescript
export type ResultFlowRunParams<C extends BaseContext = DefaultContext> = {
  abortSignal?: AbortSignal;
} & (keyof C extends never ? {
  context?: C;
} : {
  context: C;
});
```

### `ResultFlowHelpers`

```typescript
export interface ResultFlowHelpers<E, C extends BaseContext = DefaultContext> {
  tryTo<A>(result: PolymorphicResult<A, E, C>): Promise<A>;
  tryTo<A, E2>(
    result: PolymorphicResult<A, E2, C>,
    options: {
      mapError: (value: E2) => E;
    }
  ): Promise<A>;
  tryToOrRecover<A, A2>(
    result: PolymorphicResult<A, E, C>,
    fallback: (error: E) => A2 | Promise<A2>
  ): Promise<A | A2>;
  tryToOrElse<A>(
    result: PolymorphicResult<A, E, C>,
    fallback: (error: E) => PolymorphicResult<A, E, C>
  ): Promise<A>;
  fail(error: E): never;
  promiseHelpers: PromiseHelpers.PromiseHelpers;
}
```

### `ResultFlowGenHelpers`

```typescript
export interface ResultFlowGenHelpers<E, C extends BaseContext = DefaultContext> {
  orRecover<A, E2, A2>(
    result: PolymorphicResult<A, E2, C>,
    fallback: (error: E2, extras: ResultFlowExtras<C>) => A2 | Promise<A2>
  ): ResultFlow<A | A2, never, C>;
  orElse<A, E2, E3>(
    result: PolymorphicResult<A, E2, C>,
    fallback: (error: E2, extras: ResultFlowExtras<C>) => PolymorphicResult<A, E3, C>
  ): ResultFlow<A, E3, C>;
  fail(error: E): never;
}
```

`tryTo` unwraps success or stops with a typed error; its overload maps an input
error into the builder's error type. `fail` stops with an Err without returning.
`tryToOrRecover` supplies a plain fallback; `tryToOrElse` supplies a fallible one.
Those callbacks receive the error only. Generator helpers `orRecover` and `orElse`
return flows to `yield*` and also pass extras to their fallback callbacks.

`promiseHelpers.mapError` maps only the Err of a promised Result; promise rejection
or a thrown mapper still rejects. It is available through the `of` helpers, not as
a package-level export:

```typescript
mapError<A, E, E2>(
  promise: Promise<Result<A, E>>,
  mapper: (error: E) => E2,
): Promise<Result<A, E2>>;
```

### `DelayStrategy`

```typescript
export type DelayStrategy =
  | { type: "immediate" }
  | { type: "exponentialBackoff"; baseDelayMs: number; maxDelayMs?: number };
```

Exponential backoff uses `baseDelayMs * 2 ** (attempt - 1)`, capped by
`maxDelayMs` when supplied. The first additional attempt is numbered 1.
No jitter is applied. Backoff waits do not observe abort signals.

## Signature notation

The following aliases describe the implementation's signatures; they are **not
package exports**. Do not import them. `PromiseHelpers.PromiseHelpers` denotes
the `promiseHelpers` object described above. `IsAny` and `UnionToIntersection`
are internal type utilities.

```typescript
type DefaultContext = Record<never, never>;
type BaseContext = Record<string, any>;
type PolymorphicResult<A, E, C extends BaseContext = DefaultContext> =
  ResultFlow<A, E, C>
  | Promise<Result<A, E>>
  | Result<A, E>
  | ResultAsync<A, E>;
```

<details>
<summary>Advanced signature details</summary>

```typescript
type YieldableResultFlow<A, E, C extends BaseContext> = {
  run(
    ...args: keyof C extends never ? [] | [ResultFlowRunParams<C>] : [ResultFlowRunParams<C>]
  ): Promise<Result<A, E>>;
};
type AnyYieldableResultFlow = YieldableResultFlow<any, any, any>;
type FlowSuccess<F> = F extends YieldableResultFlow<infer A, any, any> ? A : never;
type FlowError<F> = F extends YieldableResultFlow<any, infer E, any> ? E : never;
type FlowContext<F> = F extends YieldableResultFlow<any, any, infer C> ? C : never;
type FlowSuccesses<Flows extends readonly AnyYieldableResultFlow[]> = FlowSuccess<Flows[number]>;
type FlowErrors<Flows extends readonly AnyYieldableResultFlow[]> = FlowError<Flows[number]>;
type FlowErrorArray<Flows extends readonly AnyYieldableResultFlow[]> = FlowErrors<Flows>[];
type FlowResult<F> = F extends YieldableResultFlow<infer A, infer E, any> ? Result<A, E> : never;
type NormalizeContext<C> = IsAny<C> extends true
  ? DefaultContext
  : C extends BaseContext ? C : DefaultContext;
type FlowContexts<Flows extends readonly AnyYieldableResultFlow[]> =
  NormalizeContext<UnionToIntersection<FlowContext<Flows[number]>>>;
type FlowValues<Flows extends readonly AnyYieldableResultFlow[]> = {
  [K in keyof Flows]: FlowSuccess<Flows[K]>;
};
type FlowResults<Flows extends readonly AnyYieldableResultFlow[]> = {
  [K in keyof Flows]: FlowResult<Flows[K]>;
};
type IsAny<T> = 0 extends (1 & T) ? true : false;
type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void
  ? I
  : never;
```

</details>
