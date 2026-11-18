# Getting started

[README](../README.md) · [API reference](api-reference.md)

Build on the README's order example: observe a failure, retry a price lookup,
rerun the workflow, and turn its outcome into an application message.
The tutorial has two runnable versions, each using TypeScript with top-level
`await`. **Version 1** builds the initial workflow and exercises a typed failure.
**Version 2** adds retries in a complete example for a fresh file; append the
rerun and application-boundary examples to that version.

## Install

```sh
npm install @youldali/result-flow neverthrow
```

`neverthrow` is a required peer (`^8.2.0`). It provides `Result` and `ResultAsync`;
ResultFlow adds deferred execution and composable policies. The package is ESM
with TypeScript declarations.

## Build and run an order workflow

**Version 1:** start a TypeScript file with these local operations and counters
so execution is visible. The notebook costs 12 per unit, or 10 when ordering at
least three.

```ts
import { ResultFlow } from '@youldali/result-flow';
import { err, errAsync, ok, okAsync, type Result, type ResultAsync } from 'neverthrow';

type OrderError = 'invalid-quantity' | 'product-not-found';
let validations = 0;
let lookups = 0;

function parseQuantity(input: string): Result<number, 'invalid-quantity'> {
  validations += 1;
  const quantity = Number(input);
  return Number.isInteger(quantity) && quantity > 0
    ? ok(quantity)
    : err('invalid-quantity');
}

function findUnitPrice(
  productId: string,
  quantity: number,
): ResultAsync<number, 'product-not-found'> {
  lookups += 1;
  if (productId !== 'notebook') return errAsync('product-not-found');
  return okAsync(quantity >= 3 ? 10 : 12);
}

function orderTotal(productId: string, input: string) {
  return ResultFlow.of<number, OrderError>(async ({ tryTo }) => {
    const quantity = await tryTo(parseQuantity(input));
    const unitPrice = await tryTo(findUnitPrice(productId, quantity));
    return quantity * unitPrice;
  });
}

const firstOrder = orderTotal('notebook', '3');
console.log('Before execution:', validations, lookups); // Before execution: 0 0
const result = await firstOrder.run(); // Ok(30)
console.log(result.isOk() && result.value); // 30
```

The factory accepts order inputs; `ResultFlow.of` stores its async callback
without executing it. `run()` executes it and returns a `Promise<Result<number,
OrderError>>`. `tryTo` unwraps each `Ok`, letting the validated quantity feed the
asynchronous lookup. Always await or return `tryTo` so the step participates in
execution. Here, the final Result is `Ok(30)`.

## Exercise a typed failure

Append this invalid order to complete Version 1. Compare lookup counts around
this run to see that validation stops it before pricing:

```ts
const beforeInvalid = lookups;
const invalidOrder = orderTotal('notebook', '0');
const invalidResult = await invalidOrder.run(); // Err('invalid-quantity')
if (invalidResult.isErr()) console.log(invalidResult.error); // invalid-quantity
console.log('Invalid-order lookups:', lookups - beforeInvalid); // Invalid-order lookups: 0
```

An `Err` passed to `tryTo` stops the callback and becomes the final Result.
The lookup never runs for this invalid quantity. These strings describe expected,
typed failures; unexpected throws or rejected promises still reject `run()`
instead of becoming an `Err`. See [failure handling](failure-handling.md).

## Retry only the price lookup

**Version 2** simulates a service that fails once before recovering. The snippets
below explain the changes; the complete runnable version follows in the expandable
example. Its error types include the transient failure, with state to trigger it once:

```ts
type PriceError = 'price-unavailable' | 'product-not-found';
type OrderError = 'invalid-quantity' | PriceError;
let transientFailuresRemaining = 1;
```

The lookup still returns `product-not-found` for a missing product. For a notebook,
this new branch consumes the one simulated transient failure before returning a price:

```ts
  if (transientFailuresRemaining > 0) {
    transientFailuresRemaining -= 1;
    return errAsync('price-unavailable');
  }
```

Inside `orderTotal`, the price lookup now has its own flow and retry policy:

```ts
    const price = ResultFlow.from(() => findUnitPrice(productId, quantity))
      .retryPolicy({
        maxRetries: 1,
        condition: error => error === 'price-unavailable',
      });
    const unitPrice = await tryTo(price);
```

`from(() => ...)` defers the lookup and invokes it anew for each execution or
retry. Passing an already created `ResultAsync` would reuse that operation instead.
`tryTo` can execute a nested flow and unwrap its result, just as it unwraps a
Result or ResultAsync.

Only `price` has a retry policy: quantity validation stays outside its scope.
`maxRetries: 1` allows **one additional attempt**, for at most two lookup calls.
The default delay is immediate. Only `price-unavailable` is retried;
`product-not-found` returns immediately. Exceptions are not retried.
See [repeating work](execution.md#repeating-work) for more detail.

Copy this complete **Version 2** into a fresh TypeScript file. It includes the
retry, permanent-failure, and invalid-quantity demonstrations. Use this version
for the remaining sections, appending their examples in order.

<details>
<summary>Complete example with retries</summary>

```ts
import { ResultFlow } from '@youldali/result-flow';
import { err, errAsync, ok, okAsync, type Result, type ResultAsync } from 'neverthrow';

type PriceError = 'price-unavailable' | 'product-not-found';
type OrderError = 'invalid-quantity' | PriceError;
let transientFailuresRemaining = 1;
let validations = 0;
let lookups = 0;

function parseQuantity(input: string): Result<number, 'invalid-quantity'> {
  validations += 1;
  const quantity = Number(input);
  return Number.isInteger(quantity) && quantity > 0
    ? ok(quantity)
    : err('invalid-quantity');
}

function findUnitPrice(
  productId: string,
  quantity: number,
): ResultAsync<number, PriceError> {
  lookups += 1;
  if (productId !== 'notebook') return errAsync('product-not-found');
  if (transientFailuresRemaining > 0) {
    transientFailuresRemaining -= 1;
    return errAsync('price-unavailable');
  }
  return okAsync(quantity >= 3 ? 10 : 12);
}

function orderTotal(productId: string, input: string) {
  return ResultFlow.of<number, OrderError>(async ({ tryTo }) => {
    const quantity = await tryTo(parseQuantity(input));
    const price = ResultFlow.from(() => findUnitPrice(productId, quantity))
      .retryPolicy({
        maxRetries: 1,
        condition: error => error === 'price-unavailable',
      });
    const unitPrice = await tryTo(price);
    return quantity * unitPrice;
  });
}

const retriedOrder = orderTotal('notebook', '3');
const retriedResult = await retriedOrder.run(); // Ok(30)
console.log(retriedResult.isOk() && retriedResult.value); // 30
console.log('Validation calls:', validations); // Validation calls: 1
console.log('Lookup attempts:', lookups); // Lookup attempts: 2

const beforeMissing = lookups;
const missingResult = await orderTotal('pen', '3').run();
if (missingResult.isErr()) console.log(missingResult.error); // product-not-found
console.log('Missing-product attempts:', lookups - beforeMissing); // Missing-product attempts: 1

const beforeInvalid = lookups;
const invalidQuantityResult = await orderTotal('notebook', '0').run();
if (invalidQuantityResult.isErr()) console.log(invalidQuantityResult.error); // invalid-quantity
console.log('Invalid-order lookups:', lookups - beforeInvalid); // Invalid-order lookups: 0
```

</details>

## Execute the same workflow again

Append this code to Version 2 without resetting any state. The observations count
only operations since the start of this section:

```ts
const beforeReruns = { validations, lookups };
const reusableOrder = orderTotal('notebook', '3');
console.log('Construction:', validations - beforeReruns.validations, lookups - beforeReruns.lookups);
// Construction: 0 0

const firstRun = await reusableOrder.run(); // Ok(30)
console.log(firstRun.isOk() && firstRun.value); // 30
console.log('After one run:', validations - beforeReruns.validations, lookups - beforeReruns.lookups);
// After one run: 1 1

const secondRun = await reusableOrder.run(); // Ok(30)
console.log(secondRun.isOk() && secondRun.value); // 30
console.log('After two runs:', validations - beforeReruns.validations, lookups - beforeReruns.lookups);
// After two runs: 2 2
```

Both calls execute the **same flow instance**. Each rerun validates the quantity
and performs a new lookup; the earlier Result is not cached. Retrying a step, by
contrast, repeats only the lookup wrapped by `retryPolicy` within one order run.

Captured mutable state is not automatically reset. The counters keep increasing,
and `transientFailuresRemaining` is already zero after the retry demonstration.
Each run above therefore needs just one lookup. Starting the entire file afresh
initializes that variable to one again; calling `run()` does not.

## Handle the outcome at the application boundary

Append handlers that return a message suitable for displaying to a user:

```ts
const messages: Record<OrderError, string> = {
  'invalid-quantity': 'Enter a positive whole-number quantity.',
  'product-not-found': 'That product is not available.',
  'price-unavailable': 'Prices are unavailable; try again later.',
};
const handlers = {
  ok: (total: number) => `Order total: ${total}`,
  err: (error: OrderError) => messages[error],
};

console.log(await reusableOrder.runAndMatch(handlers)); // Order total: 30
console.log(await orderTotal('notebook', '0').runAndMatch(handlers));
// Enter a positive whole-number quantity.
```

`runAndMatch` executes the workflow again and returns a promise that resolves to
the selected handler’s value—here, a string. It does not consume a Result from an earlier run.
Unexpected exceptions still reject; neither typed-outcome handler handles them.
A handler that throws or rejects also causes `runAndMatch` to reject.

## Choose a constructor

| Constructor | Use it for |
| --- | --- |
| [`of`](api-reference.md#resultflowof) | Async/await with `tryTo` and ordinary branching. |
| [`from`](api-reference.md#resultflowfrom) | A Result-like operation; use a factory to defer and repeat its invocation. |
| [`gen`](api-reference.md#resultflowgen) | Generator syntax with `yield*`; see the linked examples. |

Next: [core concepts](core-concepts.md), [execution policies](execution.md), and
[failure handling](failure-handling.md).
