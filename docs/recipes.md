# Recipes

[README](../README.md) · [API reference](api-reference.md)

Focused examples for application workflows. `declare` statements describe illustrative application dependencies; supply those implementations to run the corresponding snippets.

- [Chain operations and stop on first failure](#chain-operations-and-stop-on-first-failure)
- [Pipe values with chain](#pipe-values-with-chain)
- [Validate a success value](#validate-a-success-value)
- [Normalize success and error values together](#normalize-success-and-error-values-together)
- [Handle one failure manually](#handle-one-failure-manually)
- [Fallback to another flow](#fallback-to-another-flow)
- [Recover with an infallible value](#recover-with-an-infallible-value)
- [Run side effects after any result](#run-side-effects-after-any-result)
- [Convert a flow to a response](#convert-a-flow-to-a-response)
- [Retry transient failures](#retry-transient-failures)
- [Poll until a success value is ready](#poll-until-a-success-value-is-ready)
- [Run a flow periodically](#run-a-flow-periodically)
- [Retry a remote read, then process](#retry-a-remote-read-then-process)
- [Guard new work during shutdown](#guard-new-work-during-shutdown)
- [Clean up after every outcome](#clean-up-after-every-outcome)
- [Convert selected exceptions](#convert-selected-exceptions)

## Chain operations and stop on first failure

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


See the [`of` API entry](api-reference.md#resultflowof) and the [failure-handling guide](failure-handling.md).

## Pipe values with chain

Use `chain` when each step consumes the previous success value.

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

const result = await ResultFlow
  .from(N.ok('10'))
  .chain((value) => N.ok(Number.parseInt(value, 10)))
  .chain((value) => Promise.resolve(N.ok(value + 20)))
  .run();

// Ok(30)
```

`chain` accepts callbacks that return a `ResultFlow`, `Result`, `ResultAsync`, or `Promise<Result>`.


See the [`chain` API entry](api-reference.md#chain) and the [failure-handling guide](failure-handling.md).

## Validate a success value

Use `ensure` when you want to keep a success value as-is only if it passes a predicate.

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

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
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

const result = await ResultFlow
  .from(N.ok(5))
  .ensure(
    (value) => value >= 10,
    (value) => ({ reason: 'too-small' as const, value }),
  )
  .run();

// Err({ reason: 'too-small', value: 5 })
```


See the [`ensure` API entry](api-reference.md#ensure) and the [failure-handling guide](failure-handling.md).

## Normalize success and error values together

Use `mapBoth` when both sides should be converted into the shapes your caller expects. It calls only the handler for the actual result.

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

type RawUser = { id: number; email: string };
type UserDto = { id: string; email: string };
type ApiError = { status: number; code: string };

declare function findRawUser(id: string): N.ResultAsync<RawUser, 'not-found'>;

const result = await ResultFlow
  .from<RawUser, 'not-found'>(() => findRawUser('42'))
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


See the [`mapBoth` API entry](api-reference.md#mapboth) and the [failure-handling guide](failure-handling.md).

## Handle one failure manually

Skip `tryTo` for a specific operation when you want custom branching.

```ts
import { ResultFlow } from '@youldali/result-flow';
import type { Result, ResultAsync } from 'neverthrow';

type User = { id: string; email: string };
type UserError = 'not-found' | 'invalid-email' | 'blocked-domain' | 'save-failed';

declare function findUser(id: string): ResultAsync<User, 'not-found'>;
declare function validateEmail(user: User): Result<User, 'invalid-email' | 'blocked-domain'>;
declare function saveUser(user: User): ResultAsync<User, 'save-failed'>;
declare function useFallbackEmail(user: User): User;

const result = await ResultFlow.of<User, UserError>(async ({ fail, tryTo }) => {
  let user = await tryTo(findUser('user-1'));

  const validation = validateEmail(user);
  if (validation.isOk()) {
    user = validation.value;
  } else if (validation.error === 'invalid-email') {
    user = useFallbackEmail(user);
  } else {
    // Stop the flow for errors this branch does not recover from.
    fail(validation.error);
  }

  return tryTo(saveUser(user));
}).run();
```

Use `fail(error)` to stop the flow with a typed error from your own logic.


See the [`of` API entry](api-reference.md#resultflowof) and the [failure-handling guide](failure-handling.md).

## Fallback to another flow

Use `orElse` when a failure should trigger another fallible operation.

```ts
import { ResultFlow } from '@youldali/result-flow';
import type { ResultAsync } from 'neverthrow';

type Data = { id: string; value: string };

declare function getFromCache(id: string): ResultAsync<Data, 'cache-miss'>;
declare function getFromDatabase(id: string): ResultAsync<Data, 'db-error'>;

const result = await ResultFlow
  .from(() => getFromCache('item-1'))
  .tapError((error) => console.log(`Cache failed: ${error}`))
  .orElse(() => getFromDatabase('item-1'))
  .run();

// Ok(data) or Err('db-error')
```

The fallback is not executed when the first flow succeeds.


See the [`orElse` API entry](api-reference.md#orelse) and the [failure-handling guide](failure-handling.md).

## Recover with an infallible value

Use `recover` when a failure can be replaced with a plain fallback value. The fallback returns the success value directly, not a `Result`, so the recovered flow has error type `never`.

```ts
import { ResultFlow } from '@youldali/result-flow';
import type { ResultAsync } from 'neverthrow';

type Profile = { name: string; theme: 'light' | 'dark' };

declare function loadProfile(id: string): ResultAsync<Profile, 'not-found'>;

const result = await ResultFlow
  .from(() => loadProfile('user-1'))
  .recover((): Profile => ({ name: 'Guest', theme: 'light' }))
  .run();

// Ok(existingProfile) on success;
// Ok({ name: 'Guest', theme: 'light' }) after a typed failure.
```

`never` means no typed Err; execution can still throw or reject.

`recover` is for infallible fallback values. Use `orElse` instead when the fallback work can fail and should return another `Result`, `ResultAsync`, or `ResultFlow`.


See the [`recover` API entry](api-reference.md#recover) and the [failure-handling guide](failure-handling.md).

## Run side effects after any result

Use `tapBoth` when you want to observe the completed `Result` without changing it.

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

type Context = { requestId: string };
type Order = { id: string };
type SaveError = 'save-failed';

declare function saveOrder(order: Order): N.ResultAsync<Order, SaveError>;
declare const audit: {
  log(entry: { requestId: string; status: 'saved' | 'failed' }): void;
};

const order: Order = { id: 'order-1' };
const result = await ResultFlow
  .from<Order, SaveError, Context>(() => saveOrder(order))
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


See the [`tapBoth` API entry](api-reference.md#tapboth) and the [failure-handling guide](failure-handling.md).

## Convert a flow to a response

Use `runAndMatch` at application boundaries when both success and failure should become a plain value, such as an HTTP response, message acknowledgement, CLI exit payload, or UI state.

```ts
import { ResultFlow } from '@youldali/result-flow';

type User = { id: string; email: string };
type Context = { requestId: string };
type Response = { status: number; body: unknown };
type UserError = 'not-found' | 'invalid-email' | 'save-failed';

declare function updateUserFlow(id: string): ResultFlow<User, UserError, Context>;

const errorStatus: Record<UserError, number> = {
  'not-found': 404,
  'invalid-email': 400,
  'save-failed': 500,
};

const response = await updateUserFlow('user-1').runAndMatch<Response>({
  ok: (user, { context }) => ({
    status: 200,
    body: { requestId: context.requestId, user },
  }),
  err: (error, { context }) => ({
    status: errorStatus[error],
    body: { requestId: context.requestId, error },
  }),
}, { context: { requestId: 'req-123' } });
```

`runAndMatch` handles returned Ok and Err values; unexpected exceptions still reject unless handled by the flow. It executes the flow immediately, just like `run`. Unlike chainable methods such as `map`, `chain`, or `recover`, it does not return a `ResultFlow`.


See the [`runAndMatch` API entry](api-reference.md#runandmatch) and the [failure-handling guide](failure-handling.md).

## Retry transient failures

Use `retryPolicy` around the part of the flow that should be retried.

```ts
import { ResultFlow } from '@youldali/result-flow';
import * as N from 'neverthrow';

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


See the [`retryPolicy` API entry](api-reference.md#retrypolicy) and the [execution guide](execution.md).

## Poll until a success value is ready

Use `repeatUntil` when a request should wait for one final ready value. It repeats only when the flow succeeds but the success value says the work is not ready yet.

```ts
import { ResultFlow } from '@youldali/result-flow';
import type { ResultAsync } from 'neverthrow';

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


See the [`repeatUntil` API entry](api-reference.md#repeatuntil) and the [execution guide](execution.md).

## Run a flow periodically

Use `runPeriodically` for ongoing background loops such as health checks or scheduled maintenance.

```ts
import { ResultFlow } from '@youldali/result-flow';
import type { ResultAsync } from 'neverthrow';

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

```

Later, during application shutdown, stop the loop with the same controller:

```ts
controller.abort();
```

`runPeriodically` returns `void`. It starts an interval and reports typed-failure or abort interruptions through `onInterruption`; exceptions follow the behavior described in the execution guide.

A returned Err stops the interval when no recovery is provided. Recovery returning
Ok allows it to continue; recovery returning Err stops it and reports both errors
through `onInterruption`. Throws and rejected promises instead reject the async
interval callback, without invoking `onInterruption` or automatically clearing the
interval. A `catch` on the main flow does not cover exceptions from `recoveryAction`;
handle those separately within the recovery operation.


See the [`runPeriodically` API entry](api-reference.md#runperiodically) and [periodic execution](execution.md#periodic-execution) for details.

## Retry a remote read, then process

Retry transient reads without repeating validation. The declarations describe application operations.

```ts
import { ResultFlow } from '@youldali/result-flow';
import type { Result, ResultAsync } from 'neverthrow';

type User = { id: string; email: string };
declare function readUser(): ResultAsync<User, 'unavailable' | 'not-found'>;
declare function validateUser(user: User): Result<User, 'invalid'>;

const flow = ResultFlow.from(() => readUser())
  .timeout({ ms: 500, onTimeout: () => 'timeout' as const })
  .retryPolicy({
    maxRetries: 2,
    condition: error => error === 'unavailable' || error === 'timeout',
  })
  .chain(validateUser);
const result = await flow.run();
```

There are at most three read attempts, each with its own timeout. Validation runs
once after a successful read, outside the retry scope. See [execution order](execution.md#operator-order)
and [`retryPolicy`](api-reference.md#retrypolicy).

## Guard new work during shutdown

Check shutdown state at execution time, before starting an application operation.

```ts
import { ResultFlow } from '@youldali/result-flow';
import type { ResultAsync } from 'neverthrow';

declare function processNext(): ResultAsync<string, 'job-failed'>;
let shuttingDown = false;
const flow = ResultFlow.from(() => processNext())
  .precondition(() => !shuttingDown, () => 'shutting-down' as const);
shuttingDown = true;
const result = await flow.run(); // Err('shutting-down'); processNext is not called.
```

This prevents new work; it does not stop work already running. With retries,
place the guard inside the retry scope to check every attempt. See
[guards](execution.md#guard-before-work-validate-after-success) and [`precondition`](api-reference.md#precondition).

## Clean up after every outcome

Release resources after success, typed failure, or exception. These are illustrative application dependencies.

```ts
import { ResultFlow } from '@youldali/result-flow';
import type { ResultAsync } from 'neverthrow';

type Context = { requestId: string };
type Order = { id: string };
declare function saveOrder(order: Order): ResultAsync<Order, 'save-failed'>;
declare function releaseResources(requestId: string): Promise<void>;

const flow = ResultFlow.from<Order, 'save-failed', Context>(() => saveOrder({ id: 'order-1' }))
  .finally(async (_exit, { context }) => releaseResources(context.requestId));
const result = await flow.run({ context: { requestId: 'req-123' } });
```

Cleanup is awaited. Successful cleanup preserves the outcome; a cleanup exception
replaces it. See [cleanup ordering](failure-handling.md#cleanup-and-ordering),
[rollback with AggregateError](failure-handling.md#rollback-while-preserving-both-failures),
and [`finally`](api-reference.md#finally). An outer timeout can still settle before
underlying cleanup finishes.

## Convert selected exceptions

Convert a known exception into a domain Err while letting unexpected exceptions propagate.

```ts
import { ResultFlow } from '@youldali/result-flow';
import { err } from 'neverthrow';

class MissingFileError extends Error {}
declare function readFile(): Promise<string>;

const flow = ResultFlow.of<string, never>(async () => readFile())
  .catch(cause => {
    if (cause instanceof MissingFileError) return err('not-found' as const);
    throw cause;
  });
const result = await flow.run(); // Ok(contents), Err('not-found'), or a rejection.
```

The handler covers only preceding work; exceptions in later operators need another
catch. See [exception recovery](failure-handling.md#propagation-and-recovery) and [`catch`](api-reference.md#catch).
