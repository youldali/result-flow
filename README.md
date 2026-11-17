# ResultFlow

Compose execution and failure handling around your neverthrow workflows.

Write readable TypeScript operations with typed failures, then add retries,
timeouts, execution guards and cleanup. Build the workflow once; execute it when needed.

`neverthrow` provides `Result` and `ResultAsync`. ResultFlow adds a lazy,
composable execution layer around those operations. The two libraries work together.

## Why ResultFlow?

A remote read may need retries and a time limit, while the validation that follows
should run only once. ResultFlow lets you express those policies around the relevant
steps and reuse the resulting workflow wherever it needs to run.

Given these application functions:

```ts
import { ResultFlow } from '@youldali/result-flow';
import type { Result, ResultAsync } from 'neverthrow';

type RecordData = { id: string; name: string };
type ReadError = 'unavailable' | 'not-found';
declare function readRemote(id: string): ResultAsync<RecordData, ReadError>;
declare function validateRecord(data: RecordData): Result<RecordData, 'invalid'>;

const readRecord = ResultFlow
  .from(() => readRemote('record-1'))
  .timeout({
    ms: 1000,
    onTimeout: () => 'timeout' as const,
  })
  .retryPolicy({
    maxRetries: 2,
    condition: (error) => error === 'unavailable' || error === 'timeout',
    retryStrategy: { type: 'exponentialBackoff', baseDelayMs: 100 },
  });

const workflow = readRecord.chain(validateRecord);

// Construction above does not call readRemote.
const result = await workflow.run();
// Result<RecordData, ReadError | 'timeout' | 'invalid'>
```

The read runs at most three times, retrying only `unavailable` or `timeout` failures;
placing `timeout` before `retryPolicy` gives each attempt its own limit.
Validation sits outside the retry scope and runs once if the read succeeds.
A timeout can return before the underlying read stops; see [Core semantics](#core-semantics).

## Installation

```sh
npm install @youldali/result-flow neverthrow
```

`neverthrow` (`^8.2.0`) is a required peer dependency. Published as ESM with
TypeScript declarations. The `timeout` operator requires `AbortSignal.timeout`;
combining an existing abort signal with the timeout signal also requires `AbortSignal.any`.

## Quick Start

Use `ResultFlow.of` for familiar `async`/`await` control flow. This self-contained
example parses an order quantity, looks up its unit price, and calculates a total.

```ts
import { ResultFlow } from '@youldali/result-flow';
import { err, errAsync, ok, okAsync, type Result, type ResultAsync } from 'neverthrow';

type OrderError = 'invalid-quantity' | 'product-not-found';

function parseQuantity(input: string): Result<number, 'invalid-quantity'> {
  const quantity = Number(input);
  return Number.isInteger(quantity) && quantity > 0
    ? ok(quantity)
    : err('invalid-quantity');
}

function findUnitPrice(
  productId: string,
  quantity: number,
): ResultAsync<number, 'product-not-found'> {
  if (productId !== 'notebook') return errAsync('product-not-found');
  return okAsync(quantity >= 3 ? 10 : 12); // Bulk price for three or more.
}

// Describe the work; the callback has not executed yet.
const total = ResultFlow.of<number, OrderError>(async ({ tryTo }) => {
  const quantity = await tryTo(parseQuantity('3'));
  const unitPrice = await tryTo(findUnitPrice('notebook', quantity));
  return quantity * unitPrice;
});

// Execute when needed, then handle the final Result.
const result = await total.run();
if (result.isOk()) {
  console.log(`Total: ${result.value}`); // Total: 30
} else {
  console.error(`Cannot calculate total: ${result.error}`);
}
```

`tryTo` unwraps each `Ok`. If parsing returns `Err`, the price lookup is skipped
and that failure becomes the final Result. Here, three notebooks at a unit price
of 10 produce a total of 30.

Prefer generators? [`ResultFlow.gen`](docs/api-reference.md#resultflowgen) offers `yield*` syntax.
`neverthrow` already supports linear composition through `safeTry`; ResultFlow's
additional role is reusable execution policies and deferred execution.

## Core semantics

- **Factories defer work.** The callback passed to `of`, `gen`, or the factory
  form of `from` runs on execution and can run again on a later execution or retry.
- **Existing work stays started.** Wrapping an already-created `Promise` or
  `ResultAsync` cannot defer or restart the operation that produced it.
- **Typed failures stop the success path.** An `Err` skips subsequent success
  steps; recovery operators can explicitly provide an alternative.
- **Exceptions remain exceptions.** Unexpected throws and rejections reject
  execution by default. [`catch`](docs/api-reference.md#catch) handles upstream exceptions explicitly;
  `orElse` and `recover` handle typed errors.
- **Combinators return new flows.** Adding an operator leaves the original flow
  unchanged. `run`, `runAndMatch` and `runPeriodically` execute work.
- **Placement determines scope.** An operator wraps the preceding flow:
  `flow.timeout(...).retryPolicy(...)` limits each attempt, while
  `flow.retryPolicy(...).timeout(...)` limits the entire retry sequence.
- **Cancellation is cooperative.** Callers can pass an `abortSignal` to `run`;
  callbacks receive it through extras. Underlying operations must observe the
  signal to stop. A timeout alone does not guarantee that work has stopped.

For an application function `operation` returning a `ResultAsync`, compare:

```ts
ResultFlow.from(operation());       // Calls operation now; reuses its result.
ResultFlow.from(() => operation()); // Calls operation on each execution.
```

Only the factory form invokes `operation` anew on each execution or retry.
See [Context](docs/core-concepts.md#context) for passing execution context and
[Choosing Related Methods](docs/getting-started.md#choose-a-constructor) for operator comparisons.

## API At A Glance

Static constructors and coordinators are called on `ResultFlow`; other operators
are called on a flow instance.

| Intent | API | Purpose |
| --- | --- | --- |
| Create | [`of`](docs/api-reference.md#resultflowof), [`from`](docs/api-reference.md#resultflowfrom), [`lift`](docs/api-reference.md#resultflowlift), [`gen`](docs/api-reference.md#resultflowgen), [`isResultFlow`](docs/api-reference.md#resultflowisresultflow) | Build flows or check whether a value is a flow. |
| Execute | [`run`](docs/api-reference.md#run), [`runAndMatch`](docs/api-reference.md#runandmatch) | Get a `Promise<Result>` or handle both typed outcomes as a plain value. |
| Transform | [`map`](docs/api-reference.md#map), [`mapError`](docs/api-reference.md#maperror), [`mapBoth`](docs/api-reference.md#mapboth) | Transform success values, typed errors, or both. |
| Compose and recover | [`chain`](docs/api-reference.md#chain), [`orElse`](docs/api-reference.md#orelse), [`recover`](docs/api-reference.md#recover), [`catch`](docs/api-reference.md#catch) | Continue success, fall back on `Err`, recover a value, or handle exceptions. |
| Observe and clean up | [`tap`](docs/api-reference.md#tap), [`ifSuccess`](docs/api-reference.md#ifsuccess), [`tapError`](docs/api-reference.md#taperror), [`ifFailure`](docs/api-reference.md#iffailure), [`tapBoth`](docs/api-reference.md#tapboth), [`finally`](docs/api-reference.md#finally) | Observe outcomes or await cleanup. |
| Validate and guard | [`ensure`](docs/api-reference.md#ensure), [`precondition`](docs/api-reference.md#precondition) | Validate a success value or check a guard before upstream execution. |
| Control execution | [`retryPolicy`](docs/api-reference.md#retrypolicy), [`repeatUntil`](docs/api-reference.md#repeatuntil), [`timeout`](docs/api-reference.md#timeout), [`runPeriodically`](docs/api-reference.md#runperiodically) | Retry typed failures, poll successes, limit duration, or start interval work. |
| Coordinate flows | [`all`](docs/api-reference.md#resultflowall), [`allSettled`](docs/api-reference.md#resultflowallsettled), [`firstOk`](docs/api-reference.md#resultflowfirstok), [`race`](docs/api-reference.md#resultflowrace) | Combine flows sequentially or concurrently. |

`lift` aliases `from`; `tap` aliases `ifSuccess`. Other similarly named methods
have distinct behavior:

- `tapError` receives only typed errors; `ifFailure` receives either a typed error
  or an exception, distinguished by `FlowFailure.kind`.
- `tapBoth` observes returned Results; `finally` receives a `FlowExit` and runs
  cleanup after success, typed failure, or exception. An observer or cleanup
  callback that throws or rejects causes execution to reject.
- `all` runs sequentially and stops on the first `Err`; `allSettled` runs in
  parallel and collects Results in input order. Exceptions still reject execution.
- `firstOk` tries flows sequentially until one succeeds; `race` starts them
  concurrently and returns the first settled outcome, including a failure.
- `runPeriodically` starts interval work and returns `void`, not a final Result.

See the [API Reference](docs/api-reference.md) for signatures and
[Helper Types](docs/api-reference.md#public-helper-types-and-callback-helpers) for callback shapes.

## When to use ResultFlow

Use ResultFlow when existing neverthrow operations need reusable execution
policies, when a workflow needs retries, timeouts, execution-time guards or
cleanup, or when describing work separately from running it makes callers simpler.

For simple Result composition, plain neverthrow may be sufficient.

## Documentation

| Guide | Purpose |
| --- | --- |
| [Getting started](docs/getting-started.md) | Build and run your first workflow. |
| [Core concepts](docs/core-concepts.md) | Understand laziness, Result-like inputs, and context types. |
| [Execution](docs/execution.md) | Guard, retry, poll, time, schedule, and coordinate work. |
| [Failure handling](docs/failure-handling.md) | Recover, observe outcomes, and clean up. |
| [Recipes](docs/recipes.md) | Combine APIs for practical application workflows. |
| [API reference](docs/api-reference.md) | Look up signatures, defaults, and public helper types. |

## Development

Before contributing, install dependencies and run the same checks as CI:

```sh
npm ci
npm test
npm run build
```

Use `npm run dev` to compile in watch mode.
