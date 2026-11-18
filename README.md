# ResultFlow

Compose execution and failure handling around your neverthrow workflows.

Write readable TypeScript operations with typed failures, then add retries,
timeouts, execution guards and cleanup. Build the workflow once; execute it when needed.

`neverthrow` provides `Result` and `ResultAsync`. ResultFlow adds a lazy,
composable execution layer around those operations. The two libraries work together.

[Getting started](docs/getting-started.md) · [API reference](docs/api-reference.md) · [Docs on GitHub](https://github.com/youldali/result-flow/tree/main/docs)

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
A timeout can return while the underlying read is still running. See [Timeouts and cancellation](docs/execution.md#timeouts-and-cancellation).

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

## Documentation

| Guide | What you'll find |
| --- | --- |
| [Getting started](docs/getting-started.md) | Extend the order example with a retryable lookup and handle the result. |
| [Core concepts](docs/core-concepts.md) | Understand deferred work, typed inputs, and execution context. |
| [Execution](docs/execution.md) | Decide which steps to retry, time out, or run together. |
| [Failure handling](docs/failure-handling.md) | Recover from typed errors, handle exceptions, and clean up. |
| [Recipes](docs/recipes.md) | Adapt examples for polling a job or turning a flow into a response. |
| [API reference](docs/api-reference.md) | Look up method signatures, defaults, and helper types. |

## Core semantics

- **Deferred work.** `of` and `gen` run their callbacks on execution. For repeatable work, pass a factory to `from`. Each run or retry that reaches it calls it again. Passing an existing Promise or ResultAsync reuses the work already started.
- **Typed failures.** An `Err` skips later success steps. Unexpected throws and rejected promises reject execution by default.
- **Policy scope.** Each operator returns a new flow. A policy wraps the steps before it, as the read example shows. See [Operator order](docs/execution.md#operator-order).

For an application function `operation` returning a `ResultAsync`, compare:

```ts
ResultFlow.from(operation());       // Calls operation now; reuses its result.
ResultFlow.from(() => operation()); // Calls operation on each execution.
```

## API At A Glance

| Purpose | Representative methods |
| --- | --- |
| Construct a flow | `ResultFlow.of` builds an async workflow. `ResultFlow.from` wraps an operation. |
| Compose steps | `map` transforms a success value. `chain` passes it to the next fallible step. |
| Apply policies | `retryPolicy` retries selected typed failures. `timeout` limits how long to wait. |
| Handle outcomes | `orElse` handles a typed error. `catch` handles an upstream exception. |
| Execute | Await `run` for a Result or `runAndMatch` for the value from an outcome handler. |

[Choose a constructor](docs/getting-started.md#choose-a-constructor) compares the entry points.
For operator comparisons, see [how to choose a failure handler](docs/failure-handling.md#choose-a-method),
[Repeating work](docs/execution.md#repeating-work), and [Coordinate flows](docs/execution.md#coordinate-flows).
The [API reference](docs/api-reference.md) covers every method.

## When to use ResultFlow

Use ResultFlow when your workflow needs reusable execution policies or when callers
need to decide when work starts. For simple Result composition, plain neverthrow
may be sufficient, including its `safeTry` helper for linear workflows.

## Development

Before contributing, install dependencies and run the same checks as CI:

```sh
npm ci
npm test
npm run build
```

Use `npm run dev` to compile in watch mode.
