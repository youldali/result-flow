# Getting started

[README](../README.md) · [API reference](api-reference.md)

Build a workflow with ordinary async/await, then choose when to execute it.

## Install

```sh
npm install @youldali/result-flow neverthrow
```

`neverthrow` is a required peer (`^8.2.0`). It provides `Result` and `ResultAsync`;
ResultFlow adds deferred execution and composable policies. The package is ESM
with TypeScript declarations. See [execution](execution.md#timeouts-and-cancellation)
for the runtime APIs used by timeouts.

## Build and run an order workflow

This complete example combines a synchronous parse with an asynchronous local lookup.
The price depends on the quantity returned by the first step.

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

`of` stores the callback. Calling `run()` executes it and returns a promise of a
Result. `tryTo` unwraps each success; a parse failure skips the lookup, and either
step's typed failure becomes the final Result. Unexpected exceptions reject execution.
The example prints `Total: 30`; a missing product returns `Err('product-not-found')`.

## Choose a constructor

| Constructor | Use it for |
| --- | --- |
| [`of`](api-reference.md#resultflowof) | Async/await with `tryTo`, branching, and inline recovery helpers. |
| [`from`](api-reference.md#resultflowfrom) | An existing Result-like operation; use a factory to defer and repeat its invocation. |
| [`gen`](api-reference.md#resultflowgen) | Generator syntax with `yield*` for Result-producing steps. |

Using the helpers and types defined in the order example above, the equivalent generator is:

```ts
const totalWithGen = ResultFlow.gen<number, OrderError>(async function* () {
  const quantity = yield* parseQuantity('3');
  const unitPrice = yield* findUnitPrice('notebook', quantity);
  return quantity * unitPrice;
});
const generatedResult = await totalWithGen.run(); // Ok(30)
```

Generators can yield Results, ResultAsync values and flows. This syntax is an
alternative, not a prerequisite; neverthrow also supports linear composition with
`safeTry`. See [generator cleanup](failure-handling.md#generator-cleanup) before
using JavaScript `try/finally` around yields.

Next: [core concepts](core-concepts.md), [execution policies](execution.md), and
[failure handling](failure-handling.md).
