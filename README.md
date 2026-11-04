# ResultFlow

`ResultFlow` is built on top of `neverthrow`. Both libraries are meant to be used together: `neverthrow` gives you typed `Result` and `ResultAsync` values, and `ResultFlow` adds a thunk-driven layer for composing work that should not execute until you call `run()`.

That lazy execution model makes it possible to extend `neverthrow` workflows with behavior such as retries, polling, periodic execution, timeouts, and context passing. A flow stops on the first `Err`, returns that error from `run()`, and skips the remaining success path.

`ResultFlow` has no bundled runtime dependencies. `neverthrow` is a required peer dependency, so install it alongside `@youldali/result-flow`.

## Table Of Contents

- [Why ResultFlow](#why-resultflow)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [API At A Glance](#api-at-a-glance)
- [Choosing Related Methods](#choosing-related-methods)
- [Core Concepts](#core-concepts)
  - [Type Parameters](#type-parameters)
  - [Lazy And Immutable](#lazy-and-immutable)
  - [Failures Vs Exceptions](#failures-vs-exceptions)
  - [Context](#context)
- [Recipes](#recipes)
  - [Choose Between Of And Gen](#choose-between-of-and-gen)
  - [Chain Operations And Stop On First Failure](#chain-operations-and-stop-on-first-failure)
  - [Pipe Values With Chain](#pipe-values-with-chain)
  - [Validate A Success Value](#validate-a-success-value)
  - [Normalize Success And Error Values Together](#normalize-success-and-error-values-together)
  - [Handle One Failure Manually](#handle-one-failure-manually)
  - [Fallback To Another Flow](#fallback-to-another-flow)
  - [Recover With An Infallible Value](#recover-with-an-infallible-value)
  - [Run Side Effects After Any Result](#run-side-effects-after-any-result)
  - [Convert A Flow To A Response](#convert-a-flow-to-a-response)
  - [Use Generator Syntax](#use-generator-syntax)
  - [Combine Independent Flows](#combine-independent-flows)
  - [Use The First Successful Flow](#use-the-first-successful-flow)
  - [Race Concurrent Flows](#race-concurrent-flows)
  - [Retry Transient Failures](#retry-transient-failures)
  - [Poll Until A Success Value Is Ready](#poll-until-a-success-value-is-ready)
  - [Fail On Timeout](#fail-on-timeout)
  - [Run A Flow Periodically](#run-a-flow-periodically)
- [API Reference](#api-reference)
  - Create And Lift
    - [`ResultFlow.of`](#resultflowof)
    - [`ResultFlow.from`](#resultflowfrom)
    - [`ResultFlow.lift`](#resultflowlift)
    - [`ResultFlow.isResultFlow`](#resultflowisresultflow)
    - [`ResultFlow.gen`](#resultflowgen)
  - Run And Control Execution
    - [`run`](#run)
    - [`runAndMatch`](#runandmatch)
    - [`runPeriodically`](#runperiodically)
    - [`retryPolicy`](#retrypolicy)
    - [`repeatUntil`](#repeatuntil)
    - [`timeout`](#timeout)
  - Transform
    - [`map`](#map)
    - [`mapBoth`](#mapboth)
    - [`mapError`](#maperror)
  - Compose And Recover
    - [`chain`](#chain)
    - [`catch`](#catch)
    - [`orElse`](#orelse)
    - [`recover`](#recover)
  - Observe
    - [`ifSuccess`](#ifsuccess)
    - [`tap`](#tap)
    - [`ifFailure`](#iffailure)
    - [`tapError`](#taperror)
    - [`finally`](#finally)
    - [`tapBoth`](#tapboth)
  - Validate
    - [`ensure`](#ensure)
  - Coordinate
    - [`ResultFlow.all`](#resultflowall)
    - [`ResultFlow.allSettled`](#resultflowallsettled)
    - [`ResultFlow.firstOk`](#resultflowfirstok)
    - [`ResultFlow.race`](#resultflowrace)
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
import { ResultFlow } from '@youldali/result-flow';

const flow = ResultFlow.of<User, UserError>(async ({ tryTo }) => {
  const user = await tryTo(findUser('user-1'));
  const validUser = await tryTo(validateUser(user));
  return tryTo(saveUser(validUser));
})
  .retryPolicy({ maxRetries: 3 })
  .tapError((error) => console.error(error));

const result = await flow.run();
```

The success path stays linear. The failure path stays typed. The work does not start until `run()` is called, so capabilities like `retryPolicy`, `repeatUntil`, `runPeriodically`, and context passing can be layered around the workflow before execution.

## Installation

```sh
npm install @youldali/result-flow neverthrow
```

`@youldali/result-flow` is dependency-free at runtime except for its required `neverthrow` peer dependency. Installing both packages keeps `neverthrow` explicit in your application and avoids pulling extra transitive dependencies into your runtime.

## Quick Start

`ResultFlow` works with `neverthrow`'s `Result` and `ResultAsync` values. Use `Result` for synchronous domain operations and `ResultAsync` for asynchronous operations.

```ts
import { type Result, type ResultAsync } from 'neverthrow';
import { ResultFlow } from '@youldali/result-flow';

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

Most examples below use `N.ok`, `N.err`, or `N.ResultAsync` from `neverthrow`:

```ts
import * as N from 'neverthrow';
```

## API At A Glance

`ResultFlow` methods fall into a few small groups. If you know what kind of operation you want, this is the quickest way to find the right method.

| Category | Methods | Use When |
| --- | --- | --- |
| Create flows | `of`, `from`, `lift`, `gen` | You want to build a lazy flow from `Result`, `ResultAsync`, `Promise<Result>`, or generator syntax. |
| Run flows | `run`, `runAndMatch` | You want to execute the lazy workflow and get either a `Promise<Result<A, E>>` or a plain value produced from both cases. |
| Transform values | `map`, `mapError`, `mapBoth` | You want to change the success value, error value, or both without changing the control flow. |
| Compose fallible work | `chain`, `orElse` | You want to continue with another operation that can itself fail. |
| Observe results | `tap`, `tapError`, `ifFailure`, `finally`, `tapBoth` | You want side effects such as logging, metrics, or cleanup while preserving the original result. |
| Validate success values | `ensure` | You want to keep a success value only if it passes a predicate. |
| Handle exceptions | `catch` | You want to opt in to converting upstream exceptions into Results or recovering with `Ok`. |
| Recover from failures | `recover` | You want to turn a failure into an infallible fallback success value. |
| Control execution | `retryPolicy`, `repeatUntil`, `timeout`, `runPeriodically` | You want retries, readiness polling, time limits, or background interval execution. |
| Coordinate flows | `all`, `allSettled`, `race`, `firstOk` | You want to combine multiple lazy flows. |

Aliases:

- `lift` is an alias for `from`.
- `tap` is the success-side observer. `ifSuccess` is kept as the more explicit name.
- `tapError` observes typed `Err` values; `ifFailure` observes both typed failures and exceptions.
- `tapBoth` observes returned Results; `finally` runs cleanup for every outcome, including exceptions.

## Choosing Related Methods

Some methods are intentionally close to each other. The difference is what signal they react to and whether they return one final `Result`.

### Constructing Imperative Flows

`ResultFlow.of` and `ResultFlow.gen` are equivalent constructors for writing a flow in an imperative style while keeping typed failures, lazy execution, retries, context, and other `ResultFlow` behavior.

They are similar in spirit to do notation in Haskell: each step reads like ordinary sequential code, but an `Err` still stops the flow and becomes the final result.

| Method | Style | Use When |
| --- | --- | --- |
| `ResultFlow.of` | Regular `async` function. Use `await tryTo(...)` to unwrap `Ok` values and stop on `Err`. | You want familiar TypeScript control flow, or you want helpers such as `tryTo`, `tryToOrRecover`, `tryToOrElse`... |
| `ResultFlow.gen` | Async generator. Use `yield* resultLike` to unwrap `Ok` values and stop on `Err`. | You prefer lighter syntax for result-producing steps, or you want generator helpers such as `orRecover` and `orElse`. |

In short:

```text
of  -> await tryTo(step())
gen -> yield* step()
```

### Running Flows

Both `run` and `runAndMatch` execute the lazy flow immediately. Use `run` when the caller should keep working with a `Result`. Use `runAndMatch` when you are at an application boundary and want to convert both cases into one plain value.

| Method | Returns | Use When |
| --- | --- | --- |
| `run` | `Promise<Result<A, E>>` | You want the final `Ok` or `Err` and will decide what to do with it later. |
| `runAndMatch` | `Promise<B>` | You want to handle both `Ok` and `Err` now and return a plain value such as an HTTP response, CLI payload, or UI state. |

In short:

```text
run         -> execute and keep the Result
runAndMatch -> execute and leave the Result world
```

### Repeating Work

| Method | Repeats When | Stops When | Returns |
| --- | --- | --- | --- |
| `retryPolicy` | The flow returns `Err(error)` and the retry condition allows it. | The flow returns `Ok`, the retry condition rejects the error, or retries are exhausted. | A single final `Promise<Result<A, E>>` from `run()`. |
| `repeatUntil` | The flow returns `Ok(value)` but the predicate says the value is not ready. | The predicate passes, the flow returns `Err`, or repeats are exhausted. | A single final `Promise<Result<A, E | E2>>` from `run()`. |
| `runPeriodically` | A timer interval elapses. | The loop is aborted, the flow fails without recovery, or recovery fails. | `void`; it starts background work and reports interruption through callbacks. |

In short:

```text
retryPolicy     -> repeat failed attempts
repeatUntil     -> poll until a successful value is ready
runPeriodically -> run ongoing background work
```

### Fallbacks

`orElse` and `recover` handle explicit `Err` failures. Use [`catch`](#catch) for thrown exceptions and rejected promises; it leaves existing `Ok` and `Err` outcomes unchanged.

| Method | Fallback Returns | Use When |
| --- | --- | --- |
| `orElse` | Another `Result`, `ResultAsync`, `Promise<Result>`, or `ResultFlow`. | The fallback work can fail. |
| `recover` | A plain value or `Promise` of a plain value. | The fallback is infallible and should turn failure into `Ok`. |

### Transforming Values

| Method | Runs On | Use When |
| --- | --- | --- |
| `map` | `Ok(value)` | Only the success value should change. |
| `mapError` | `Err(error)` | Only the error value should change. |
| `mapBoth` | Either `Ok` or `Err` | Both sides should be normalized together. Only the matching handler runs. |

### Observing Results

| Method | Runs On | Changes The Result? |
| --- | --- | --- |
| `tap` / `ifSuccess` | `Ok(value)` | No. |
| `tapError` | `Err(error)` | No, unless the effect throws or rejects. |
| `ifFailure` | `Err` or an exception | No, unless the effect throws or rejects. |
| `tapBoth` | Both `Ok` and `Err` | No, unless the effect throws or rejects. |
| `finally` | `Ok`, `Err`, or an exception | No, unless cleanup throws or rejects. |

### Combining Flows

| Method | Execution | Failure Behavior |
| --- | --- | --- |
| `all` | Runs flows in order. | Stops on the first `Err`; otherwise returns `Ok([...values])`. |
| `allSettled` | Starts every flow in parallel. | Collects every `Result` and returns `Ok([...results])`; input `Err` values do not fail the outer flow. |
| `firstOk` | Runs flows in order. | Ignores `Err` values until one flow returns `Ok`; fails with all errors if none succeed. |
| `race` | Starts every flow in parallel. | Returns the first settled `Result`, whether it is `Ok` or `Err`. |

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

All `ResultFlow` methods are immutable: they return new flows and do not mutate the original flow.

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

By default, thrown exceptions and rejected promises are not converted into `Err`. They reject the `run()` promise. Add `.catch(handler)` to opt in to handling exceptions from the preceding flow.

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

### Choose Between Of And Gen

Use `ResultFlow.of` when you want a normal `async` function body. Helpers such as `tryTo` extract the value inside an `Ok`, and stop the flow with the `Err` when the result is a failure.

```ts
const result = await ResultFlow.of<User, UserError>(async ({ tryTo }) => {
  const user = await tryTo(findUser('user-1'));
  const validUser = await tryTo(validateEmail(user));
  return tryTo(saveUser(validUser));
}).run();
```

Use `ResultFlow.gen` when you prefer generator syntax. Instead of `await tryTo(...)`, you directly `yield*` the `Result`, `ResultAsync`, or `ResultFlow`. The generator also receives helpers for inline recovery and fallible fallbacks.

```ts
const result = await ResultFlow.gen<User, UserError>(async function* () {
  const user = yield* findUser('user-1');
  const validUser = yield* validateEmail(user);
  return yield* saveUser(validUser);
}).run();
```

Both examples are equivalent. They return `Promise<Result<User, UserError>>`, do not execute until `run()` is called, and stop on the first `Err`.

### Chain Operations And Stop On First Failure

Use `ResultFlow.of` with `tryTo` when you want an `async` function body.

```ts
import { type Result, type ResultAsync } from 'neverthrow';
import { ResultFlow } from '@youldali/result-flow';

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

### Normalize Success And Error Values Together

Use `mapBoth` when both sides should be converted into the shapes your caller expects. It calls only the handler for the actual result.

```ts
type RawUser = { id: number; email: string };
type UserDto = { id: string; email: string };
type ApiError = { status: number; code: string };

declare function findRawUser(id: string): N.ResultAsync<RawUser, 'not-found'>;

const result = await ResultFlow
  .from<RawUser, 'not-found'>(findRawUser('42'))
  .mapBoth({
    ok: (user): UserDto => ({
      id: user.id.toString(),
      email: user.email.toLowerCase(),
    }),
    err: (error): ApiError => ({
      status: 404,
      code: error,
    }),
  })
  .run();

// Ok({ id: '42', email: 'ada@example.com' })
// or Err({ status: 404, code: 'not-found' })
```

Use `map` or `mapError` when only one side changes. Use `mapBoth` when success and error normalization belong together.

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

Use `orElse` when a failure should trigger another fallible operation.

```ts
type Data = { id: string; value: string };

declare function getFromCache(id: string): ResultAsync<Data, 'cache-miss'>;
declare function getFromDatabase(id: string): ResultAsync<Data, 'db-error'>;

const result = await ResultFlow
  .from(getFromCache('item-1'))
  .tapError((error) => console.log(`Cache failed: ${error}`))
  .orElse(() => getFromDatabase('item-1'))
  .run();

// Ok(data) or Err('db-error')
```

The fallback is not executed when the first flow succeeds.

### Recover With An Infallible Value

Use `recover` when a failure can be replaced with a plain fallback value. The fallback returns the success value directly, not a `Result`, so the recovered flow has error type `never`.

```ts
type Profile = { name: string; theme: 'light' | 'dark' };

declare function loadProfile(id: string): ResultAsync<Profile, 'not-found'>;

const result = await ResultFlow
  .from(loadProfile('user-1'))
  .recover(() => ({ name: 'Guest', theme: 'light' }))
  .run();

// Ok({ name: 'Guest', theme: 'light' })
```

`recover` is for infallible fallback values. Use `orElse` instead when the fallback work can fail and should return another `Result`, `ResultAsync`, or `ResultFlow`.

### Run Side Effects After Any Result

Use `tapBoth` when you want to observe the completed `Result` without changing it.

```ts
const result = await ResultFlow
  .from(() => saveOrder(order))
  .tapBoth((result, { context }) => {
    audit.log({
      requestId: context.requestId,
      status: result.isOk() ? 'saved' : 'failed',
    });
  })
  .run({ context: { requestId: 'req-123' } });

// The original Ok or Err is returned unchanged.
```

The effect runs for returned `Ok` and `Err` values. If the underlying flow throws or rejects instead of returning a `Result`, the effect is not called and `run()` rejects as usual.

### Convert A Flow To A Response

Use `runAndMatch` at application boundaries when both success and failure should become a plain value, such as an HTTP response, message acknowledgement, CLI exit payload, or UI state.

```ts
type Context = { requestId: string };
type Response = { status: number; body: unknown };
type UserError = 'not-found' | 'invalid-email' | 'save-failed';

declare function updateUserFlow(id: string): ResultFlow<User, UserError, Context>;

const response = await updateUserFlow('user-1').runAndMatch<Response>({
  ok: (user, { context }) => ({
    status: 200,
    body: { requestId: context.requestId, user },
  }),
  err: (error, { context }) => ({
    status: error === 'not-found' ? 404 : 400,
    body: { requestId: context.requestId, error },
  }),
}, { context: { requestId: 'req-123' } });
```

`runAndMatch` executes the flow immediately, just like `run`. Unlike chainable methods such as `map`, `chain`, or `recover`, it does not return a `ResultFlow`.

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

Use `ResultFlow.all` when you have several flows that should run in order and collect their success values.

```ts
const result = await ResultFlow
  .all([
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
  .all([
    ResultFlow.from(N.ok('cached-user')),
    ResultFlow.from<number, 'quota-exceeded'>(N.err('quota-exceeded')),
    ResultFlow.from(N.ok('not-run')),
  ])
  .run();

// Err('quota-exceeded')
```

Use `ResultFlow.allSettled` when every input flow should run and you want to inspect each returned `Result`. When the returned flow is run, all input flows are started in parallel, and the final array still preserves the original input order.

```ts
const result = await ResultFlow
  .allSettled([
    ResultFlow.from(N.ok('cached-user')),
    ResultFlow.from<number, 'quota-exceeded'>(N.err('quota-exceeded')),
    ResultFlow.from(N.ok('fresh-user')),
  ] as const)
  .run();

// Ok([Ok('cached-user'), Err('quota-exceeded'), Ok('fresh-user')])
```

The difference is the execution and failure behavior: `all` runs flows in order and short-circuits on the first `Err`; `allSettled` starts all flows in parallel and returns `Ok([...Result])`.

### Use The First Successful Flow

Use `ResultFlow.firstOk` when several flows can satisfy the same request and you want to try them in order until one succeeds.

```ts
const result = await ResultFlow
  .firstOk([
    ResultFlow.from<User, 'cache-miss'>(() => readFromCache('user-1')),
    ResultFlow.from<User, 'replica-miss'>(() => readFromReplica('user-1')),
    ResultFlow.from<User, 'not-found'>(() => readFromDatabase('user-1')),
  ] as const)
  .run();

// Ok(user) from the first successful flow,
// or Err(['cache-miss', 'replica-miss', 'not-found']) if all fail.
```

The returned flow is lazy. It runs input flows sequentially, one at a time, in array order. As soon as one flow returns `Ok`, `firstOk` returns that value and does not run any later flows. Each executed flow receives the same context, and thrown exceptions or rejected promises still reject `run()`.

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

`retryPolicy` only repeats `Err` results. If the flow returns `Ok(value)`, it stops even if that value represents a pending or not-ready state.

### Poll Until A Success Value Is Ready

Use `repeatUntil` when a request should wait for one final ready value. It repeats only when the flow succeeds but the success value says the work is not ready yet.

```ts
type JobStatus =
  | { id: string; status: 'queued' | 'running' }
  | { id: string; status: 'done'; resultUrl: string };

declare function getJobStatus(id: string): ResultAsync<JobStatus, { reason: 'not-found' }>;

const result = await ResultFlow
  .from(() => getJobStatus('job-123'))
  .repeatUntil({
    predicate: (job) => job.status === 'done',
    maxRepeats: 10,
    delayStrategy: { type: 'exponentialBackoff', baseDelayMs: 250, maxDelayMs: 2000 },
    beforeRepeat: (job, repeatNumber) => {
      console.log(`Job ${job.id} is ${job.status}; repeat ${repeatNumber}`);
    },
    onExhausted: (job) => ({
      reason: 'job-not-ready' as const,
      lastStatus: job.status,
    }),
  })
  .run();

// Ok({ status: 'done', ... })
// or Err({ reason: 'not-found' })
// or Err({ reason: 'job-not-ready', lastStatus: 'queued' | 'running' })
```

`repeatUntil` only repeats successful `Ok(value)` results whose predicate returns `false`. If the wrapped flow returns `Err`, it stops immediately and returns that original error. Unlike `runPeriodically`, the caller awaits one final `Result`.

Choose between the execution helpers by the signal you want to react to:

- `retryPolicy` repeats when the wrapped flow returns `Err`.
- `repeatUntil` repeats when the wrapped flow returns `Ok(value)` but the value is not ready yet.
- `runPeriodically` starts an interval loop and does not return a `Result`; it is for ongoing background work such as health checks.

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

Use `runPeriodically` for ongoing background loops such as health checks or scheduled maintenance.

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

`runPeriodically` returns `void`. It starts an interval and reports why the loop stopped through `onInterruption`.

If the periodic flow fails and there is no recovery action, the interval stops. If the recovery action succeeds, the interval continues. If recovery fails, the interval stops and `onInterruption` receives both the original error and the recovery error.

## API Reference

### `ResultFlow.of`

Builds a flow from an async function. The function receives helpers and extras.

```ts
ResultFlow.of<A, E, C>(
  builder: (
    helpers: ResultFlowHelpers<E>,
    extras: { context: C; abortSignal?: AbortSignal },
  ) => Promise<A>,
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
tryTo<A>(
  result:
    | ResultFlow<A, E>
    | N.Result<A, E>
    | N.ResultAsync<A, E>
    | Promise<N.Result<A, E>>,
): Promise<A>

tryTo<A, E2>(
  result:
    | ResultFlow<A, E2>
    | N.Result<A, E2>
    | N.ResultAsync<A, E2>
    | Promise<N.Result<A, E2>>,
  options: { mapError: (error: E2) => E },
): Promise<A>

tryToOrRecover<A, A2>(
  result:
    | ResultFlow<A, E>
    | N.Result<A, E>
    | N.ResultAsync<A, E>
    | Promise<N.Result<A, E>>,
  fallback: (error: E) => A2 | Promise<A2>,
): Promise<A | A2>

tryToOrElse<A>(
  result:
    | ResultFlow<A, E>
    | N.Result<A, E>
    | N.ResultAsync<A, E>
    | Promise<N.Result<A, E>>,
  fallback: (error: E) =>
    | ResultFlow<A, E>
    | N.Result<A, E>
    | N.ResultAsync<A, E>
    | Promise<N.Result<A, E>>,
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

Example with `tryToOrRecover`:

```ts
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
const flow = ResultFlow.of<User, UserError>(async ({ tryToOrElse }) => {
  return tryToOrElse(findUser('missing'), () => findDefaultUser());
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
  generator: (
    helpers: {
      orRecover<A, E2, A2>(
        result:
          | ResultFlow<A, E2, C>
          | N.Result<A, E2>
          | N.ResultAsync<A, E2>
          | Promise<N.Result<A, E2>>,
        fallback: (error: E2, extras: { context: C; abortSignal?: AbortSignal }) => A2 | Promise<A2>,
      ): ResultFlow<A | A2, never, C>
      orElse<A, E2, E3>(
        result:
          | ResultFlow<A, E2, C>
          | N.Result<A, E2>
          | N.ResultAsync<A, E2>
          | Promise<N.Result<A, E2>>,
        fallback: (error: E2, extras: { context: C; abortSignal?: AbortSignal }) =>
          | ResultFlow<A, E3, C>
          | N.Result<A, E3>
          | N.ResultAsync<A, E3>
          | Promise<N.Result<A, E3>>,
      ): ResultFlow<A, E3, C>
      fail(error: E): never
    },
    extras: { context: C; abortSignal?: AbortSignal },
  ) => AsyncGenerator<
    ResultFlow<unknown, E, C> | N.Result<unknown, E> | N.ResultAsync<unknown, E>,
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

const flow = ResultFlow.gen<number, never, Context>(async function* (_helpers, { context }) {
  const value = yield* N.ok(10);
  return value * context.multiplier;
});

await flow.run({ context: { multiplier: 3 } }); // Ok(30)
```

Example with inline recovery:

```ts
const flow = ResultFlow.gen<User, never>(async function* ({ orRecover }) {
  return yield* orRecover(findUser('missing'), () => ({
    id: 'guest',
    email: 'guest@example.com',
  }));
});
```

Example with an inline fallible fallback:

```ts
const flow = ResultFlow.gen<User, UserError>(async function* ({ orElse }) {
  return yield* orElse(findUser('missing'), () => findDefaultUser());
});
```

### `ResultFlow.all`

Combines multiple `ResultFlow`s into one lazy flow. The returned flow runs each input flow in array order, returns `Ok` with the collected success values when all flows succeed, and returns the first `Err` when any flow fails.

```ts
ResultFlow.all(flows): ResultFlow<Values, Errors, Context>
```

Example:

```ts
const flow = ResultFlow.all([
  ResultFlow.from(N.ok(10)),
  ResultFlow.from(N.ok('ready')),
] as const);

await flow.run(); // Ok([10, 'ready'])
```

For readonly tuple inputs, the success type is preserved as a tuple. Error types are unioned, and context types are combined so the returned flow requires the context needed by every input flow.

```ts
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

### `ResultFlow.allSettled`

Combines multiple `ResultFlow`s into one lazy flow that starts every input flow in parallel and collects each returned `Result` in input order. Input `Err` values are returned inside the success array; they do not fail the outer flow.

```ts
ResultFlow.allSettled(flows): ResultFlow<Results, never, Context>
```

Example:

```ts
const flow = ResultFlow.allSettled([
  ResultFlow.from(N.ok(10)),
  ResultFlow.from<string, 'missing'>(N.err('missing')),
  ResultFlow.from(N.ok('ready')),
] as const);

await flow.run(); // Ok([Ok(10), Err('missing'), Ok('ready')])
```

For readonly tuple inputs, the success type is preserved as a tuple of `Result` values. The outer error type is `never`, and context types are combined so the returned flow requires the context needed by every input flow.

```ts
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

### `ResultFlow.firstOk`

Combines multiple `ResultFlow`s into one lazy flow. The returned flow runs input flows sequentially, one at a time, in array order and returns the first `Ok` value. Earlier `Err` values are collected and ignored while more candidates are available. Once a flow returns `Ok`, later flows are not run.

```ts
ResultFlow.firstOk(flows): ResultFlow<Successes, Errors[], Context>
```

Example:

```ts
const flow = ResultFlow.firstOk([
  ResultFlow.from<number, 'primary-failed'>(N.err('primary-failed')),
  ResultFlow.from<number, 'backup-failed'>(N.ok(10)),
] as const);

await flow.run(); // Ok(10)
```

If every input flow fails, the returned flow fails with the collected errors in execution order.

```ts
const flow = ResultFlow.firstOk([
  ResultFlow.from<number, 'primary-failed'>(N.err('primary-failed')),
  ResultFlow.from<number, 'backup-failed'>(N.err('backup-failed')),
] as const);

await flow.run(); // Err(['primary-failed', 'backup-failed'])
```

Success types are unioned, error types are returned as an array of the unioned error type, and context types are combined so the returned flow requires the context needed by every input flow.

An empty input array rejects with `Error('ResultFlow.firstOk requires at least one flow')`.

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
flow.run({ abortSignal }: { abortSignal?: AbortSignal }): Promise<N.Result<A, E>>
flow.run({ context, abortSignal }: { context: C; abortSignal?: AbortSignal }): Promise<N.Result<A, E>>
```

The context argument is only needed when the flow declares a context type. `abortSignal` can be passed with or without context.

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

### `runAndMatch`

Executes the flow and converts the final `Result` into a plain value by handling both cases.

```ts
flow.runAndMatch<B>(
  handlers: {
    ok: (value: A, extras: { context: C; abortSignal?: AbortSignal }) => B | Promise<B>;
    err: (error: E, extras: { context: C; abortSignal?: AbortSignal }) => B | Promise<B>;
  },
): Promise<B>

flow.runAndMatch<B>(
  handlers: {
    ok: (value: A, extras: { context: C; abortSignal?: AbortSignal }) => B | Promise<B>;
    err: (error: E, extras: { context: C; abortSignal?: AbortSignal }) => B | Promise<B>;
  },
  { context, abortSignal }: { context: C; abortSignal?: AbortSignal },
): Promise<B>
```

The context argument is only needed when the flow declares a context type. If `abortSignal` is passed, the selected handler receives it in `extras`.

Example:

```ts
const response = await ResultFlow
  .from<User, 'not-found'>(() => findUser('user-1'))
  .runAndMatch({
    ok: (user) => ({ status: 200, body: user }),
    err: (error) => ({ status: 404, body: { error } }),
  });
```

`runAndMatch` is terminal: it executes the flow immediately and returns `Promise<B>`, not a `ResultFlow`. If the underlying flow throws or rejects instead of returning a `Result`, `runAndMatch` rejects and does not call either handler. If the selected handler throws or rejects, `runAndMatch` rejects with that exception.

### `map`

Transforms a success value. It does not run when the flow is a failure.

```ts
flow.map<A2>(
  mapper: (value: A, extras: { context: C; abortSignal?: AbortSignal }) => A2,
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

### `mapBoth`

Transforms either side of a flow in one call. If the flow succeeds, `mapBoth` calls `ok` and returns `Ok(mappedValue)`. If the flow fails, it calls `err` and returns `Err(mappedError)`.

Only the selected handler runs. If the underlying flow throws or rejects, `run()` rejects and neither handler is called. If the selected handler throws, `run()` rejects with that exception.

```ts
flow.mapBoth<A2, E2>({
  ok: (value: A, extras: { context: C; abortSignal?: AbortSignal }) => A2;
  err: (error: E, extras: { context: C; abortSignal?: AbortSignal }) => E2;
}): ResultFlow<A2, E2, C>
```

Success example:

```ts
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

### `ensure`

Validates a success value. If the predicate passes, the original value is kept unchanged. If the predicate fails, the flow becomes a failure using the error returned by `onFailure`.

It does not run when the flow is already a failure.

```ts
flow.ensure<E2>(
  predicate: (value: A, extras: { context: C; abortSignal?: AbortSignal }) => boolean | Promise<boolean>,
  onFailure: (value: A, extras: { context: C; abortSignal?: AbortSignal }) => E2 | Promise<E2>,
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
  mapper: (error: E, extras: { context: C; abortSignal?: AbortSignal }) => E2,
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
  mapper: (value: A, extras: { context: C & C2; abortSignal?: AbortSignal }) =>
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

### `catch`

Handles unexpected synchronous exceptions and asynchronous rejections from the preceding flow. Existing `Ok` and `Err` outcomes pass through unchanged without invoking the handler, including failures produced by `fail()`, `tryTo()`, or generator short-circuiting.

```ts
catch<A2 = never, E2 = never>(
  handler: (cause: unknown, extras: ResultFlowExtras<C>) =>
    | ResultFlow<A2, E2, C>
    | N.Result<A2, E2>
    | Promise<N.Result<A2, E2>>
    | N.ResultAsync<A2, E2>,
): ResultFlow<A | A2, E | E2, C>
```

The handler receives the original thrown value as `unknown` and the current context and abort signal. Returning `Ok` recovers with a successful value; returning `Err` converts the exception into a typed failure. Asynchronous handlers are awaited. A handler can also return a `ResultFlow`, which executes with the current context and abort signal. Its explicit failures stay Result failures, and its exceptions propagate to any downstream `.catch()`. Calling `.catch()` is lazy and returns a new flow; each execution runs independently.

```ts
const formatted = flow
  .map(transform)
  .catch(cause => N.err(toDomainError(cause)))
  .map(format);
```

Ordering defines the exception boundary: exceptions from `flow` or `transform` are handled here. Exceptions from `format` still propagate unless another `.catch()` is chained after it. A handler's own throws or rejections also propagate unchanged; the same operator never catches them again, but a downstream `.catch()` can.

```ts
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
const withFallbackFlow = flow.catch(cause =>
  ResultFlow.of<string, never>(async () => {
    console.error(cause);
    return 'fallback';
  }),
);
```

### `orElse`

Runs a fallback when the previous flow fails. The fallback receives the previous error and returns another fallible operation.

```ts
flow.orElse<E2, C2>(
  fallback: (error: E, extras: { context: C & C2; abortSignal?: AbortSignal }) =>
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

### `recover`

Turns a failure into a fallback success value. The fallback receives the previous error and returns a plain value, so the returned flow has error type `never`.

```ts
flow.recover<A2>(
  fallback: (error: E, extras: { context: C; abortSignal?: AbortSignal }) => A2 | Promise<A2>,
): ResultFlow<A | A2, never, C>
```

Example:

```ts
const result = await ResultFlow
  .from<number, 'missing'>(N.err('missing'))
  .recover(() => 0)
  .run();

// Ok(0)
```

The fallback is not called when the original flow succeeds.

```ts
const result = await ResultFlow
  .from<number, 'missing'>(N.ok(10))
  .recover(() => 0)
  .run();

// Ok(10)
```

Use `recover` for infallible fallback values. Use `orElse` for fallback operations that can fail and return another `Result`, `ResultAsync`, or `ResultFlow`.

### `ifSuccess`

Runs a side effect when the flow succeeds, then keeps the original success value.

```ts
flow.ifSuccess(
  effect: (value: A, extras: { context: C; abortSignal?: AbortSignal }) => void | Promise<void>,
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
  effect: (value: A, extras: { context: C; abortSignal?: AbortSignal }) => void | Promise<void>,
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

Lazily observes both typed `Err` values and thrown exceptions or rejected promises. Each run executes the upstream flow once, forwarding the current context and abort signal. `Ok` skips the effect. The callback receives `FlowFailure<E>`, exported from the package entry point:

```ts
export type FlowFailure<E> =
  | { kind: 'err'; error: E }
  | { kind: 'exception'; cause: unknown };

flow.ifFailure(
  effect: (failure: FlowFailure<E>, extras: ResultFlowExtras<C>) => void | Promise<void>,
): ResultFlow<A, E, C>
```

Narrow `failure.kind` to handle either failure kind. Use `.tapError((error, extras) => …)` to observe only typed failures with the raw `E`.

One callback can roll back after either kind of failure and retain the original failure if rollback also fails:

```ts
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

The effect is awaited. If rollback succeeds, the original typed failure is preserved or the original thrown value is rethrown, including non-`Error` values. Upstream `fail()` and `tryTo()` failures arrive as `kind: 'err'`. If rollback throws or rejects, its exception propagates; the callback cannot catch its own failure and runs at most once per execution. In this example, `run()` rejects with the `AggregateError` containing both failures.

Use `.catch()` for exception recovery and `.finally()` for unconditional cleanup, including success. A downstream `.catch()` can recover from either the original exception or a cleanup exception; placing `.catch()` before `.ifFailure()` makes the effect observe the outcome after recovery.

### `tapError`

Observes only typed `Err` values with the raw error and current extras. Awaits the effect and preserves the original typed failure when the effect succeeds. `Ok` values and upstream exceptions bypass the callback. If the effect throws or rejects, `run()` rejects with that exception.

```ts
flow.tapError(
  effect: (error: E, extras: { context: C; abortSignal?: AbortSignal }) => void | Promise<void>,
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

Runs and awaits cleanup exactly once per execution after the upstream flow completes. **Cleanup runs even when the upstream flow throws an exception or a promise rejects**, as well as when it returns `Ok` or `Err`. No `.catch()` is needed for cleanup to run.

The operator is lazy; cleanup receives the upstream exit and the current context and abort signal. `FlowExit` is exported from the package entry point.

```ts
export type FlowExit<A, E> =
  | { kind: 'ok'; value: A }
  | { kind: 'err'; error: E }
  | { kind: 'exception'; cause: unknown };

flow.finally(
  effect: (exit: FlowExit<A, E>, extras: ResultFlowExtras<C>) => void | Promise<void>,
): ResultFlow<A, E, C>
```

```ts
const result = await ResultFlow
  .from(() => saveOrder(order))
  .finally(async (_exit, { context }) => {
    await releaseResources(context.requestId);
  })
  .run({ context: { requestId: 'req-123' } });
```

For example, cleanup still runs when no Result is returned because the upstream throws:

```ts
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

### `tapBoth`

Lazily observes a returned `Ok` or `Err` with `(result, extras)`, awaits the effect, and preserves the original result.

```ts
flow.tapBoth(
  effect: (result: N.Result<A, E>, extras: { context: C; abortSignal?: AbortSignal }) => void | Promise<void>,
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

Retries the previous flow when it returns an `Err`. It is for transient failures: network errors, timeouts, version conflicts, and similar failed attempts.

```ts
flow.retryPolicy(params?: {
  condition?: (error: E) => boolean;
  beforeRetry?: (
    error: E,
    retryNumber: number,
    extras: { context: C; abortSignal?: AbortSignal },
  ) => Promise<void> | void;
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

### `repeatUntil`

Repeats the previous flow when it returns `Ok(value)` and `predicate(value)` returns `false`. It is for successful-but-not-ready values, such as a job status that is still `queued` or `running`.

```ts
flow.repeatUntil<E2>(params: {
  predicate: (value: A, extras: { context: C; abortSignal?: AbortSignal }) => boolean | Promise<boolean>;
  onExhausted: (lastValue: A, extras: { context: C; abortSignal?: AbortSignal }) => E2 | Promise<E2>;
  maxRepeats?: number;
  delayStrategy?: DelayStrategy;
  beforeRepeat?: (
    value: A,
    repeatNumber: number,
    extras: { context: C; abortSignal?: AbortSignal },
  ) => void | Promise<void>;
}): ResultFlow<A, E | E2, C>
```

Defaults:

```ts
{
  maxRepeats: 1,
  delayStrategy: { type: 'immediate' },
}
```

Example:

```ts
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

Only the flow before `repeatUntil` is repeated. Steps appended after `repeatUntil` run once after the repeat loop completes.

`retryPolicy`, `repeatUntil`, and `runPeriodically` repeat for different reasons: `retryPolicy` repeats returned failures, `repeatUntil` repeats not-ready successes and returns one final `Result`, and `runPeriodically` schedules ongoing interval execution rather than returning a final `Result`.

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

Runs the flow repeatedly with `setInterval`. It is for background work and returns `void`, not a final `Result`.

```ts
flow.runPeriodically<E2>(params: {
  interval: number;
  recoveryAction?: (error: E, extras: { context: C; abortSignal?: AbortSignal }) =>
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
