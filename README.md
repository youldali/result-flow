# ResultFlow

`ResultFlow` is built on top of `neverthrow`. Both libraries are meant to be used together: `neverthrow` gives you typed `Result` and `ResultAsync` values, and `ResultFlow` adds a thunk-driven layer for composing work that should not execute until you call `run()`.

That lazy execution model makes it possible to extend `neverthrow` workflows with behavior such as retries, periodic execution, timeouts, and context passing. A flow stops on the first `Err`, returns that error from `run()`, and skips the remaining success path.

## Table Of Contents

- [Why ResultFlow](#why-resultflow)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Core Concepts](#core-concepts)
  - [Type Parameters](#type-parameters)
  - [Lazy And Immutable](#lazy-and-immutable)
  - [Failures Vs Exceptions](#failures-vs-exceptions)
  - [Context](#context)
- [Recipes](#recipes)
  - [Chain Operations And Stop On First Failure](#chain-operations-and-stop-on-first-failure)
  - [Pipe Values With Chain](#pipe-values-with-chain)
  - [Validate A Success Value](#validate-a-success-value)
  - [Handle One Failure Manually](#handle-one-failure-manually)
  - [Fallback To Another Flow](#fallback-to-another-flow)
  - [Run Side Effects After Any Result](#run-side-effects-after-any-result)
  - [Use Generator Syntax](#use-generator-syntax)
  - [Combine Independent Flows](#combine-independent-flows)
  - [Race Concurrent Flows](#race-concurrent-flows)
  - [Retry Transient Failures](#retry-transient-failures)
  - [Fail On Timeout](#fail-on-timeout)
  - [Run A Flow Periodically](#run-a-flow-periodically)
- [API Reference](#api-reference)
  - [`ResultFlow.of`](#resultflowof)
  - [`ResultFlow.from`](#resultflowfrom)
  - [`ResultFlow.lift`](#resultflowlift)
  - [`ResultFlow.isResultFlow`](#resultflowisresultflow)
  - [`ResultFlow.gen`](#resultflowgen)
  - [`ResultFlow.allSettled`](#resultflowallsettled)
  - [`ResultFlow.race`](#resultflowrace)
  - [`run`](#run)
  - [`map`](#map)
  - [`ensure`](#ensure)
  - [`mapError`](#maperror)
  - [`chain`](#chain)
  - [`orElse`](#orelse)
  - [`ifSuccess`](#ifsuccess)
  - [`tap`](#tap)
  - [`ifFailure`](#iffailure)
  - [`tapError`](#taperror)
  - [`finally`](#finally)
  - [`tapBoth`](#tapboth)
  - [`retryPolicy`](#retrypolicy)
  - [`timeout`](#timeout)
  - [`runPeriodically`](#runperiodically)
- [Helper Types](#helper-types)
- [Development](#development)

## Why ResultFlow

`neverthrow` is great for making failures explicit, including asynchronous failures through `ResultAsync`:

```ts
import { type Result, type ResultAsync } from 'neverthrow';

type User = { id: string; email: string };
type UserError = 'not-found' | 'invalid-user' | 'save-failed';

declare function findUser(id: string): ResultAsync<User, 'not-found'>;
declare function validateUser(user: User): Result<User, 'invalid-user'>;
declare function saveUser(user: User): ResultAsync<User, 'save-failed'>;
```

You can already work with those values directly in `neverthrow`. The main reason to use `ResultFlow` is different: a `ResultFlow` is a thunk. It describes a workflow without running it yet.

That means you can build a flow, add behavior around it, and decide when it executes:

```ts
import { ResultFlow } from 'result-flow';

const flow = ResultFlow.of<User, UserError>(async ({ tryTo }) => {
  const user = await tryTo(findUser('user-1'));
  const validUser = await tryTo(validateUser(user));
  return tryTo(saveUser(validUser));
})
  .retryPolicy({ maxRetries: 3 })
  .ifFailure((error) => console.error(error));

const result = await flow.run();
```

The success path stays linear. The failure path stays typed. The work does not start until `run()` is called, so capabilities like `retryPolicy`, `runPeriodically`, and context passing can be layered around the workflow before execution.

## Installation

```sh
npm install result-flow neverthrow
```

`neverthrow` is a peer dependency.

## Quick Start

`ResultFlow` works with `neverthrow`'s `Result` and `ResultAsync` values. Use `Result` for synchronous domain operations and `ResultAsync` for asynchronous operations.

```ts
import { type Result, type ResultAsync } from 'neverthrow';
import { ResultFlow } from 'result-flow';

type User = { id: string; email: string };
type UserError = 'not-found' | 'invalid-email' | 'save-failed';

declare function findUser(id: string): ResultAsync<User, 'not-found'>;
declare function validateEmail(user: User): Result<User, 'invalid-email'>;
declare function saveUser(user: User): ResultAsync<User, 'save-failed'>;
```

Build a flow with `ResultFlow.of` when you want familiar `async`/`await` syntax. `tryTo` unwraps `Ok` values and stops the flow on the first `Err`.

```ts
const result = await ResultFlow.of<User, UserError>(async ({ tryTo }) => {
  const user = await tryTo(findUser('user-1'));
  const validUser = await tryTo(validateEmail(user));
  return tryTo(saveUser(validUser));
}).run();
```

Or use `ResultFlow.gen` with `yield*` to avoid calling `tryTo` explicitly.

```ts
const result = await ResultFlow.gen<User, UserError>(async function* () {
  const user = yield* findUser('user-1');
  const validUser = yield* validateEmail(user);
  return yield* saveUser(validUser);
}).run();
```

Both versions return the same type:

```ts
// Promise<Result<User, UserError>>
```

## Core Concepts

### Type Parameters

`ResultFlow` uses the same success-first order as `neverthrow`:

```ts
ResultFlow<Success, Failure, Context = Record<never, never>>
```

In everyday use, you only provide the first two type parameters. The third type parameter is optional and only needed when the flow should receive a context object.

Examples:

```ts
// No context.
ResultFlow.of<User, UserError>(async () => ({
  id: 'user-1',
  email: 'ada@example.com',
}));
ResultFlow.from<number, 'not-a-number'>(N.ok(42));

// Context is opt-in.
ResultFlow.of<User, UserError, { requestId: string }>(async () => ({
  id: 'user-1',
  email: 'ada@example.com',
}));
```

### Lazy And Immutable

A flow is a thunk: a description of work. Nothing runs until you call `run()`.

Methods such as `map`, `ensure`, `chain`, `orElse`, and `retryPolicy` return new flows. They do not mutate the original flow.

```ts
const base = ResultFlow.from(N.ok(10));
const doubled = base.map((value) => value * 2);

await base.run();    // Ok(10)
await doubled.run(); // Ok(20)
```

### Failures Vs Exceptions

`ResultFlow` handles `Err` values as typed failures:

```ts
const result = await ResultFlow.from<number, 'missing'>(N.err('missing')).run();
// Err('missing')
```

Thrown exceptions and rejected promises are not converted into `Err`. They reject the `run()` promise.

```ts
const flow = ResultFlow.of<number, never>(async () => {
  throw new Error('unexpected');
});

await flow.run(); // rejects with Error('unexpected')
```

Use `Result` values for expected domain failures. Use exceptions for unexpected failures.

### Context

Context is optional. Most flows do not need one, and can call `run()` with no arguments.

If a flow declares the third type parameter, `run()` requires a context object and every callback receives it as `extras.context`.

```ts
const flowWithoutContext = ResultFlow.from(N.ok(10));

await flowWithoutContext.run(); // Ok(10)
```

```ts
type Context = { requestId: string };

const flow = ResultFlow
  .of<number, never, Context>(async (_helpers, { context }) => {
    console.log(context.requestId);
    return 10;
  })
  .map((value, { context }) => `${context.requestId}:${value}`);

await flow.run({ context: { requestId: 'req-123' } });
```

## Recipes

### Chain Operations And Stop On First Failure

Use `ResultFlow.of` with `tryTo` when you want an `async` function body.

```ts
import { type Result, type ResultAsync } from 'neverthrow';
import { ResultFlow } from 'result-flow';

type User = { id: string; email: string };
type UserError = 'not-found' | 'invalid-email' | 'save-failed';

declare function findUser(id: string): ResultAsync<User, 'not-found'>;
declare function validateEmail(user: User): Result<User, 'invalid-email'>;
declare function saveUser(user: User): ResultAsync<User, 'save-failed'>;

const result = await ResultFlow.of<User, UserError>(async ({ tryTo }) => {
  const user = await tryTo(findUser('user-1'));
  const validUser = await tryTo(validateEmail(user));
  return tryTo(saveUser(validUser));
}).run();
```

If any step returns `Err`, the next step is skipped and `run()` returns that error.

### Pipe Values With Chain

Use `chain` when each step consumes the previous success value.

```ts
const result = await ResultFlow
  .from(N.ok('10'))
  .chain((value) => N.ok(Number.parseInt(value, 10)))
  .chain((value) => Promise.resolve(N.ok(value + 20)))
  .run();

// Ok(30)
```

`chain` accepts callbacks that return a `ResultFlow`, `Result`, `ResultAsync`, or `Promise<Result>`.

### Validate A Success Value

Use `ensure` when you want to keep a success value as-is only if it passes a predicate.

```ts
const result = await ResultFlow
  .from(N.ok(10))
  .ensure(
    (value) => value >= 10,
    (value) => ({ reason: 'too-small' as const, value }),
  )
  .run();

// Ok(10)
```

When the predicate returns `false`, the flow becomes an `Err` using the value returned by `onFailure`.

```ts
const result = await ResultFlow
  .from(N.ok(5))
  .ensure(
    (value) => value >= 10,
    (value) => ({ reason: 'too-small' as const, value }),
  )
  .run();

// Err({ reason: 'too-small', value: 5 })
```

### Handle One Failure Manually

Skip `tryTo` for a specific operation when you want custom branching.

```ts
type User = { id: string; email: string };
type UserError = 'not-found' | 'invalid-email' | 'blocked-domain' | 'save-failed';

declare function findUser(id: string): ResultAsync<User, 'not-found'>;
declare function validateEmail(user: User): Result<User, 'invalid-email' | 'blocked-domain'>;
declare function saveUser(user: User): ResultAsync<User, 'save-failed'>;
declare function useFallbackEmail(user: User): User;

const result = await ResultFlow.of<User, UserError>(async ({ fail, tryTo }) => {
  let user = await tryTo(findUser('user-1'));

  const validation = validateEmail(user);
  if (validation.isErr()) {
    if (validation.error === 'invalid-email') {
      user = useFallbackEmail(user);
    } else {
      // Stop the flow for errors this branch does not recover from.
      fail(validation.error);
    }
  }

  return tryTo(saveUser(user));
}).run();
```

Use `fail(error)` to stop the flow with a typed error from your own logic.

### Fallback To Another Flow

Use `orElse` when a failure should trigger a fallback.

```ts
type Data = { id: string; value: string };

declare function getFromCache(id: string): ResultAsync<Data, 'cache-miss'>;
declare function getFromDatabase(id: string): ResultAsync<Data, 'db-error'>;

const result = await ResultFlow
  .from(getFromCache('item-1'))
  .ifFailure((error) => console.log(`Cache failed: ${error}`))
  .orElse(() => getFromDatabase('item-1'))
  .run();

// Ok(data) or Err('db-error')
```

The fallback is not executed when the first flow succeeds.

### Run Side Effects After Any Result

Use `finally` or its alias `tapBoth` when you want to observe the completed `Result` without changing it.

```ts
const result = await ResultFlow
  .from(() => saveOrder(order))
  .finally((result, { context }) => {
    audit.log({
      requestId: context.requestId,
      status: result.isOk() ? 'saved' : 'failed',
    });
  })
  .run({ context: { requestId: 'req-123' } });

// The original Ok or Err is returned unchanged.
```

The effect runs for returned `Ok` and `Err` values. If the underlying flow throws or rejects instead of returning a `Result`, the effect is not called and `run()` rejects as usual.

### Use Generator Syntax

`ResultFlow.gen` lets you write a flow with `yield*`.

```ts
const result = await ResultFlow.gen<User, UserError>(async function* () {
  const user = yield* findUser('user-1');
  const validUser = yield* validateEmail(user);
  return yield* saveUser(validUser);
}).run();
```

You can yield `ResultFlow`, `Result`, or `ResultAsync` values. The flow unwraps `Ok` values and stops on the first `Err`.

### Combine Independent Flows

Use `ResultFlow.allSettled` when you have several flows that should run in order and collect their success values.

```ts
const result = await ResultFlow
  .allSettled([
    ResultFlow.from(N.ok('user-1')),
    ResultFlow.from(N.ok(42)),
    ResultFlow.from(N.ok(true)),
  ] as const)
  .run();

// Ok(['user-1', 42, true])
```

The combined flow is lazy. None of the input flows runs until the returned flow is run. When it runs, each input flow receives the same context, execution stops on the first `Err`, and thrown exceptions or rejected promises still reject `run()`.

```ts
const result = await ResultFlow
  .allSettled([
    ResultFlow.from(N.ok('cached-user')),
    ResultFlow.from<number, 'quota-exceeded'>(N.err('quota-exceeded')),
    ResultFlow.from(N.ok('not-run')),
  ])
  .run();

// Err('quota-exceeded')
```

### Race Concurrent Flows

Use `ResultFlow.race` when several flows can answer the same question and you want the first settled `Result`.

```ts
const result = await ResultFlow
  .race([
    ResultFlow.from(() => readFromCache('user-1')),
    ResultFlow.from(() => readFromReplica('user-1')),
  ] as const)
  .run();

// Ok(user) or Err(error), whichever settles first.
```

The race is lazy. None of the input flows runs until the returned flow is run. When it runs, all input flows start concurrently and receive the same context.

The first settled `Result` wins, whether it is `Ok` or `Err`. If the first settled input flow throws or rejects instead of returning a `Result`, the returned flow's `run()` rejects with that exception.

### Retry Transient Failures

Use `retryPolicy` around the part of the flow that should be retried.

```ts
let attempt = 0;

const result = await ResultFlow
  .from(() => {
    attempt += 1;
    return attempt < 3 ? N.err('network-error' as const) : N.ok('data');
  })
  .retryPolicy({
    maxRetries: 3,
    condition: (error) => error === 'network-error',
    beforeRetry: (error, retryNumber) => {
      console.log(`Retry ${retryNumber} after ${error}`);
    },
    retryStrategy: {
      type: 'exponentialBackoff',
      baseDelayMs: 100,
      maxDelayMs: 1000,
    },
  })
  .run();

// Ok('data')
```

`maxRetries` is the number of retries after the first attempt. With `maxRetries: 3`, the operation can run up to 4 times.

### Fail On Timeout

Use `timeout` when a flow should become a typed failure if it takes too long.

```ts
const result = await flow
  .timeout({
    ms: 500,
    onTimeout: () => ({ reason: 'timeout' as const }),
  })
  .run();
```

The flow receives a composed `extras.abortSignal`. Pass this signal to long-running operations such as `fetch` or `fs` calls so they can stop when the timeout emits.

```ts
const flow = ResultFlow.of<Response, { reason: 'timeout' }>(async ({ tryTo }, { abortSignal }) => {
  return tryTo(fetch(url, { signal: abortSignal }).then((response) => N.ok(response)));
});
```

The timeout wrapper can return `Err` as soon as the timeout wins, but it cannot force arbitrary work to stop unless that work uses the signal.

Order matters when combining `timeout` with `retryPolicy`:

```ts
flow.timeout({ ms: 500, onTimeout }).retryPolicy({ maxRetries: 2 });
// Each retry attempt gets its own 500ms timeout.

flow.retryPolicy({ maxRetries: 2 }).timeout({ ms: 500, onTimeout });
// The whole retry sequence shares one 500ms timeout.
```

Timeouts are returned as typed `Err` values. External aborts are not mapped by `timeout`; they are left to the underlying operation's normal abort behavior.

### Run A Flow Periodically

Use `runPeriodically` for polling, health checks, or scheduled maintenance loops.

```ts
const controller = new AbortController();

declare function checkServiceHealth(): ResultAsync<void, 'service-down'>;
declare function reconnectService(): ResultAsync<void, 'reconnect-failed'>;

const healthCheck = ResultFlow.from(() => checkServiceHealth());

healthCheck.runPeriodically({
  interval: 5000,
  abortSignal: controller.signal,
  recoveryAction: () => reconnectService(),
  onInterruption: (interruption) => {
    if (interruption.cause === 'failure') {
      console.error('Health check stopped', interruption.error);
      console.error('Recovery error', interruption.recoveryError);
    }

    if (interruption.cause === 'aborted') {
      console.log('Health check stopped manually');
    }
  },
});

// Later, when the loop should stop:
controller.abort();
```

If the periodic flow fails and there is no recovery action, the interval stops. If the recovery action succeeds, the interval continues. If recovery fails, the interval stops and `onInterruption` receives both the original error and the recovery error.

## API Reference

### `ResultFlow.of`

Builds a flow from an async function. The function receives helpers and extras.

```ts
ResultFlow.of<A, E, C>(
  builder: (helpers: ResultFlowHelpers<E>, extras: { context: C }) => Promise<A>,
): ResultFlow<A, E, C>
```

Example:

```ts
const flow = ResultFlow.of<number, 'too-small'>(async ({ fail }) => {
  const value = 5;
  if (value < 10) {
    fail('too-small');
  }
  return value;
});

await flow.run(); // Err('too-small')
```

The helpers are:

```ts
tryTo<A>(result: N.Result<A, E> | Promise<N.Result<A, E>> | N.ResultAsync<A, E>): Promise<A>

tryTo<A, E2>(
  result: N.Result<A, E2> | Promise<N.Result<A, E2>> | N.ResultAsync<A, E2>,
  options: { mapError: (error: E2) => E },
): Promise<A>

fail(error: E): never

promiseHelpers: {
  mapError<A, E, E2>(
    promise: Promise<N.Result<A, E>>,
    mapper: (error: E) => E2,
  ): Promise<N.Result<A, E2>>
}
```

Example with `tryTo` error mapping:

```ts
type FlowError = { kind: 'flow-error'; cause: 'not-found' };

const flow = ResultFlow.of<User, FlowError>(async ({ tryTo }) => {
  return tryTo(findUser('missing'), {
    mapError: (error) => ({ kind: 'flow-error', cause: error }),
  });
});
```

### `ResultFlow.from`

Creates a flow from a `Result`, `ResultAsync`, `Promise<Result>`, or a function that returns one of those.

```ts
ResultFlow.from<A, E, C>(
  value:
    | N.Result<A, E>
    | N.ResultAsync<A, E>
    | Promise<N.Result<A, E>>
    | (() => N.Result<A, E>)
    | (() => N.ResultAsync<A, E>)
    | (() => Promise<N.Result<A, E>>),
): ResultFlow<A, E, C>
```

Examples:

```ts
ResultFlow.from(N.ok(10));
ResultFlow.from(N.okAsync(10));
ResultFlow.from(Promise.resolve(N.ok(10)));
ResultFlow.from(() => N.ok(10));
```

Use a function when the operation should be re-executed on every `run()` or retry.

### `ResultFlow.lift`

Alias for `ResultFlow.from`.

```ts
const flow = ResultFlow.lift(N.ok(10));

await flow.run(); // Ok(10)
```

### `ResultFlow.isResultFlow`

Checks whether a value is a `ResultFlow`.

```ts
const value = ResultFlow.from(N.ok(10));

ResultFlow.isResultFlow(value); // true
ResultFlow.isResultFlow(N.ok(10)); // false
```

This is mostly useful when writing helpers that accept polymorphic result-like values.

### `ResultFlow.gen`

Creates a flow from an async generator. Inside the generator, use `yield*` with `ResultFlow`, `Result`, or `ResultAsync` values.

```ts
ResultFlow.gen<A, E, C>(
  generator: (extras: { context: C }) => AsyncGenerator<
    ResultFlow<unknown, E, Partial<C>> | N.Result<unknown, E> | N.ResultAsync<unknown, E>,
    A,
    unknown
  >,
): ResultFlow<A, E, C>
```

Example:

```ts
const flow = ResultFlow.gen<number, string>(async function* () {
  const a = yield* N.ok(5);
  const b = yield* N.okAsync(10);
  return a + b;
});

await flow.run(); // Ok(15)
```

Example with context:

```ts
type Context = { multiplier: number };

const flow = ResultFlow.gen<number, never, Context>(async function* ({ context }) {
  const value = yield* N.ok(10);
  return value * context.multiplier;
});

await flow.run({ context: { multiplier: 3 } }); // Ok(30)
```

### `ResultFlow.allSettled`

Combines multiple `ResultFlow`s into one lazy flow. The returned flow runs each input flow in array order, returns `Ok` with the collected success values when all flows succeed, and returns the first `Err` when any flow fails.

```ts
ResultFlow.allSettled(flows): ResultFlow<Values, Errors, Context>
```

Example:

```ts
const flow = ResultFlow.allSettled([
  ResultFlow.from(N.ok(10)),
  ResultFlow.from(N.ok('ready')),
] as const);

await flow.run(); // Ok([10, 'ready'])
```

For readonly tuple inputs, the success type is preserved as a tuple. Error types are unioned, and context types are combined so the returned flow requires the context needed by every input flow.

```ts
type Context = { requestId: string };

const flow = ResultFlow.allSettled([
  ResultFlow.of<number, 'missing', Context>(async (_helpers, { context }) => {
    return context.requestId.length;
  }),
  ResultFlow.from<boolean, 'invalid'>(N.ok(true)),
] as const);

// ResultFlow<readonly [number, boolean], 'missing' | 'invalid', Context>
await flow.run({ context: { requestId: 'req-123' } });
```

An empty input array succeeds with `Ok([])`.

### `ResultFlow.race`

Combines multiple `ResultFlow`s into one lazy flow. The returned flow starts every input flow concurrently and returns the first settled `Result`, whether it is `Ok` or `Err`.

```ts
ResultFlow.race(flows): ResultFlow<Successes, Errors, Context>
```

Example:

```ts
const flow = ResultFlow.race([
  ResultFlow.from(() => fetchPrimaryUser()),
  ResultFlow.from(() => fetchReplicaUser()),
] as const);

await flow.run(); // The first settled Ok or Err wins.
```

Success types are unioned, error types are unioned, and context types are combined so the returned flow requires the context needed by every input flow.

```ts
type Context = { requestId: string };

const flow = ResultFlow.race([
  ResultFlow.of<User, 'cache-miss', Context>(async (_helpers, { context }) => {
    return readCache(context.requestId);
  }),
  ResultFlow.from<User, 'not-found'>(() => fetchUser()),
] as const);

// ResultFlow<User, 'cache-miss' | 'not-found', Context>
await flow.run({ context: { requestId: 'req-123' } });
```

An empty input array rejects with `Error('ResultFlow.race requires at least one flow')`. A race over no flows would otherwise never settle.

### `run`

Executes the flow and returns a `Promise<Result<A, E>>`.

```ts
flow.run(): Promise<N.Result<A, E>>
flow.run({ context, abortSignal }: { context: C; abortSignal?: AbortSignal }): Promise<N.Result<A, E>>
```

The context argument is only needed when the flow declares a context type.

Examples:

```ts
await ResultFlow.from(N.ok(10)).run(); // Ok(10)
await ResultFlow.from<number, string>(N.err('error')).run(); // Err('error')
```

With context:

```ts
type Context = { requestId: string };

const flow = ResultFlow.of<string, never, Context>(async (_helpers, { context }) => {
  return context.requestId;
});

await flow.run({ context: { requestId: 'req-123' } }); // Ok('req-123')
```

### `map`

Transforms a success value. It does not run when the flow is a failure.

```ts
flow.map<A2>(
  mapper: (value: A, extras: { context: C }) => A2,
): ResultFlow<A2, E, C>
```

Example:

```ts
const result = await ResultFlow
  .from(N.ok(10))
  .map((value) => value + 5)
  .run();

// Ok(15)
```

### `ensure`

Validates a success value. If the predicate passes, the original value is kept unchanged. If the predicate fails, the flow becomes a failure using the error returned by `onFailure`.

It does not run when the flow is already a failure.

```ts
flow.ensure<E2>(
  predicate: (value: A, extras: { context: C }) => boolean | Promise<boolean>,
  onFailure: (value: A, extras: { context: C }) => E2 | Promise<E2>,
): ResultFlow<A, E | E2, C>
```

Example:

```ts
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

### `mapError`

Transforms a failure value. It does not run when the flow is a success.

```ts
flow.mapError<E2>(
  mapper: (error: E, extras: { context: C }) => E2,
): ResultFlow<A, E2, C>
```

Example:

```ts
const result = await ResultFlow
  .from<number, 'not-found'>(N.err('not-found'))
  .mapError((error) => ({ code: error, retryable: false }))
  .run();

// Err({ code: 'not-found', retryable: false })
```

### `chain`

Runs another result-producing operation after a success. It does not run when the previous flow is a failure.

```ts
flow.chain<A2, E2, C2>(
  mapper: (value: A, extras: { context: C & C2 }) =>
    | ResultFlow<A2, E2, C2>
    | N.Result<A2, E2>
    | N.ResultAsync<A2, E2>
    | Promise<N.Result<A2, E2>>,
): ResultFlow<A2, E | E2, C & C2>
```

Examples:

```ts
const result = await ResultFlow
  .from(N.ok(10))
  .chain((value) => N.ok(value + 5))
  .chain((value) => Promise.resolve(N.ok(value * 2)))
  .run();

// Ok(30)
```

With a returned `ResultFlow`:

```ts
const result = await ResultFlow
  .from(N.ok('user-1'))
  .chain((id) => ResultFlow.from(findUser(id)))
  .run();
```

### `orElse`

Runs a fallback when the previous flow fails. The fallback receives the previous error.

```ts
flow.orElse<E2, C2>(
  fallback: (error: E, extras: { context: C & C2 }) =>
    | ResultFlow<A, E2, C2>
    | N.Result<A, E2>
    | N.ResultAsync<A, E2>
    | Promise<N.Result<A, E2>>,
): ResultFlow<A, E2, C & C2>
```

Example:

```ts
const result = await ResultFlow
  .from<number, 'cache-miss'>(N.err('cache-miss'))
  .orElse(() => N.ok(10))
  .run();

// Ok(10)
```

If the fallback also fails, the final result contains the fallback error.

```ts
const result = await ResultFlow
  .from<number, 'cache-miss'>(N.err('cache-miss'))
  .orElse(() => N.err<number, 'db-error'>('db-error'))
  .run();

// Err('db-error')
```

### `ifSuccess`

Runs a side effect when the flow succeeds, then keeps the original success value.

```ts
flow.ifSuccess(
  effect: (value: A, extras: { context: C }) => void | Promise<void>,
): ResultFlow<A, E, C>
```

Example:

```ts
const result = await ResultFlow
  .from(N.ok(10))
  .ifSuccess((value) => console.log(`Success: ${value}`))
  .run();

// Ok(10)
```

If the effect throws or rejects, the exception is not handled by `ResultFlow`; `run()` rejects with that exception.

### `tap`

Alias for `ifSuccess`.

```ts
flow.tap(
  effect: (value: A, extras: { context: C }) => void | Promise<void>,
): ResultFlow<A, E, C>
```

Example:

```ts
const result = await ResultFlow
  .from(N.ok(10))
  .tap((value) => console.log(`Success: ${value}`))
  .run();

// Ok(10)
```

### `ifFailure`

Runs a side effect when the flow fails, then keeps the original failure value.

```ts
flow.ifFailure(
  effect: (error: E, extras: { context: C }) => void | Promise<void>,
): ResultFlow<A, E, C>
```

Example:

```ts
const result = await ResultFlow
  .from<number, string>(N.err('error'))
  .ifFailure((error) => console.error(`Failed: ${error}`))
  .run();

// Err('error')
```

If the effect throws or rejects, the exception is not handled by `ResultFlow`; `run()` rejects with that exception.

### `tapError`

Alias for `ifFailure`.

```ts
flow.tapError(
  effect: (error: E, extras: { context: C }) => void | Promise<void>,
): ResultFlow<A, E, C>
```

Example:

```ts
const result = await ResultFlow
  .from<number, string>(N.err('error'))
  .tapError((error) => console.error(`Failed: ${error}`))
  .run();

// Err('error')
```

### `finally`

Runs a side effect after the flow returns either `Ok` or `Err`, then keeps the original result unchanged.

```ts
flow.finally(
  effect: (result: N.Result<A, E>, extras: { context: C }) => void | Promise<void>,
): ResultFlow<A, E, C>
```

Example:

```ts
const result = await ResultFlow
  .from<number, 'not-found'>(N.err('not-found'))
  .finally((result) => {
    console.log(result.isOk() ? 'ok' : `failed: ${result.error}`);
  })
  .run();

// Err('not-found')
```

If the effect throws or rejects, the exception is not handled by `ResultFlow`; `run()` rejects with that exception. If the wrapped flow throws or rejects before returning a `Result`, the effect is not called.

### `tapBoth`

Alias for `finally`.

```ts
flow.tapBoth(
  effect: (result: N.Result<A, E>, extras: { context: C }) => void | Promise<void>,
): ResultFlow<A, E, C>
```

Example:

```ts
const result = await ResultFlow
  .from(N.ok(10))
  .tapBoth((result) => {
    console.log(result.isOk() ? `Success: ${result.value}` : 'Failed');
  })
  .run();

// Ok(10)
```

If the effect throws or rejects, the exception is not handled by `ResultFlow`; `run()` rejects with that exception. If the wrapped flow throws or rejects before returning a `Result`, the effect is not called.

### `retryPolicy`

Retries the previous flow when it returns an `Err`.

```ts
flow.retryPolicy(params?: {
  condition?: (error: E) => boolean;
  beforeRetry?: (error: E, retryNumber: number, extras: { context: C }) => Promise<void> | void;
  maxRetries?: number;
  retryStrategy?: DelayStrategy;
}): ResultFlow<A, E, C>
```

`DelayStrategy`:

```ts
type DelayStrategy =
  | { type: 'immediate' }
  | { type: 'exponentialBackoff'; baseDelayMs: number; maxDelayMs?: number };
```

Defaults:

```ts
{
  condition: () => true,
  maxRetries: 1,
  retryStrategy: { type: 'immediate' },
}
```

Example:

```ts
const result = await ResultFlow
  .from(() => callRemoteService())
  .retryPolicy({
    maxRetries: 2,
    condition: (error) => error === 'timeout',
    retryStrategy: { type: 'exponentialBackoff', baseDelayMs: 250, maxDelayMs: 1000 },
  })
  .run();
```

Only the flow before `retryPolicy` is retried. Steps appended after `retryPolicy` run once after the retry policy completes.

### `timeout`

Turns the previous flow into a typed failure when it takes longer than `ms`.

```ts
flow.timeout<E2>(params: {
  ms: number;
  onTimeout: (extras: { context: C; abortSignal?: AbortSignal }) => E2;
}): ResultFlow<A, E | E2, C>
```

Example:

```ts
const result = await ResultFlow
  .from(() => callRemoteService())
  .timeout({
    ms: 500,
    onTimeout: () => ({ reason: 'timeout' as const }),
  })
  .run();
```

The timeout signal is composed with any existing `extras.abortSignal` using `AbortSignal.any`, and the composed signal is passed down to the wrapped flow. Pass `extras.abortSignal` to long-running operations so they can stop when the timeout emits; otherwise `timeout` can return early but the underlying work may continue in the background.

If this timeout emits first, `onTimeout` builds the returned `Err`. If another signal aborts first, `onTimeout` is not called.

Composition order with `retryPolicy` is significant: `flow.timeout(...).retryPolicy(...)` gives each retry attempt its own timeout, while `flow.retryPolicy(...).timeout(...)` applies one timeout to the whole retry sequence.

### `runPeriodically`

Runs the flow repeatedly with `setInterval`.

```ts
flow.runPeriodically<E2>(params: {
  interval: number;
  recoveryAction?: (error: E, extras: { context: C }) =>
    | ResultFlow<unknown, E2>
    | N.Result<unknown, E2>
    | N.ResultAsync<unknown, E2>
    | Promise<N.Result<unknown, E2>>;
  onInterruption?: (
    interruption:
      | { cause: 'failure'; error: E; recoveryError: E2 | undefined }
      | { cause: 'aborted' },
  ) => void;
  abortSignal?: AbortSignal;
  context?: C;
}): void
```

Example:

```ts
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

controller.abort();
```

Important behavior:

- The first run happens after the first interval delay.
- Without `recoveryAction`, the interval stops on the first `Err`.
- With `recoveryAction`, the interval continues if recovery returns `Ok`.
- If recovery returns `Err`, the interval stops and reports the recovery error.
- If the flow or recovery action throws, the interval callback rejects. `onInterruption` is not called for thrown exceptions.

## Helper Types

The library works with these result-like values:

```ts
type PolymorphicResult<A, E, C = Record<never, never>> =
  | ResultFlow<A, E, C>
  | N.Result<A, E>
  | N.ResultAsync<A, E>
  | Promise<N.Result<A, E>>;
```

Several methods receive `extras`:

```ts
type Extras<C> = {
  context: C;
  abortSignal?: AbortSignal;
};
```

`abortSignal` is a single composed signal. It may include a timeout signal, a caller-provided signal, or both.

## Development

```sh
npm install
npm test
npm run build
```
