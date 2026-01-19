# `ResultFlow`

  - [Description](#description)
  - [Most common use case: chain a series of functions and stop as soon as one of them is a failure](#most-common-use-case-chain-a-series-of-functions-and-stop-as-soon-as-one-of-them-is-a-failure)
    - [Explanation:](#explanation)
  - [Use case: pipe the result value to the next function](#use-case-pipe-the-result-value-to-the-next-function)
    - [Explanation:](#explanation-1)
  - [Use case: custom error handling on one of the results](#use-case-custom-error-handling-on-one-of-the-results)
    - [Explanation:](#explanation-2)
  - [Use case: execute a flow only if another one fails](#use-case-execute-a-flow-only-if-another-one-fails)
    - [Explanation:](#explanation-3)
    - [Explanation:](#explanation-4)
    - [Explanation:](#explanation-5)
  - [API reference](#api-reference)
    - [static `of`](#static-of)
      - [Examples](#examples)
    - [static `lift`](#static-lift)
      - [Examples](#examples-1)
    - [`run`](#run)
      - [Examples](#examples-2)
    - [`map`](#map)
      - [Examples](#examples-3)
    - [`mapError`](#maperror)
      - [Examples](#examples-4)
    - [`chain`](#chain)
      - [Examples](#examples-5)
    - [`orElse`](#orelse)
      - [Examples](#examples-6)
    - [`ifSuccess`](#ifsuccess)
      - [Examples](#examples-7)
    - [`ifFailure`](#iffailure)
      - [Examples](#examples-8)



## Description

The `ResultFlow` datatype makes it easier to work with `Promise<Result<L,R>>` and `Result<L,R>`, using with familiar syntax that looks imperative, while still having immutable, declarative and composable qualities.

It returns a type that encapsulates a sequence of actions, which can then be manipulated. Nothing is executed until the `run` method is called. Calling it returns the final result of the flow, ie. a `Promise<Result<E,A>>`.

It's especially useful in **service functions**, because they need to orchestrate a flow in which many functions can fail (repository calls, api calls, domain validation, etc.)

## Most common use case: chain a series of functions and stop as soon as one of them is a failure
As soon as we encounter a failure inside a `Promise<Result<E,A>>` or a `Result<E,A>` , we stop the flow

**Example of repository & domain functions**
```ts
// Example of repository functions that return a Promise<Result>
type FindByIdFailure = { reason: 'not-found'; };
type UpdateByIdFailure = { reason: 'not-found'; };
findById(id: number): Promise<R.Result<FindByIdFailure, Data>>.
updateById(id: number, payload: Payload): Promise<R.Result<UpdateByIdFailure, Data>>;

// Example of domain function that returns a Result
type ValidateFailure = { reason: 'invalid-data' | 'invalid-amount'; };
validate(data: Data): R.Result<ValidateFailure, true>;
```

Now we want to execute 3 operations in a row: `findById`, `validate`, `updateById`
If any of the operations fail, we abort and return the failure.

```ts
type FlowFailure = FindByIdFailure | UpdateByIdFailure | ValidateFailure;
const resultFlow = ResultFlow.of<FlowFailure, DataRow>(async ({ tryTo }) => {
  const data = await tryTo(repositoryMock.findById(1));
  await tryTo(validate(data));
  return tryTo(
    repositoryMock.updateById(data.id, { description: 'updated-description' }),
  );
});

const flowResult = await resultFlow.run(); // Result<FlowFailure, Data>
```

### Explanation:

- We build a `ResultFlow` using the constructor `ResultFlow.of`. It takes a function that provides the `tryTo` helper as a parameter.
- We use `tryTo` on any function returning either a `Promise<Result<L,R>>` or `Result<L,R>`. It unwraps the success value for us and returns it inside a promise, ie. `Promise<A>`. **If the `Result` was a failure, the flow is stopped**.
- Finally we run the flow using the `run()` method. This returns a `Promise<Result<E,A>>` that's either the **success path final value**, or the error value of the **first action that failed**.

## Use case: pipe the result value to the next function
Here's a contrived example where we want pipe a value through a series of functions that may fail

```ts
await ResultFlow.of<never, number>(async ({ tryTo }) => {
        const string = '10';
        const number = await tryTo(R.toSuccess(Number.parseInt(string)));
        return tryTo(Promise.resolve(R.toSuccess(number + 20)));
      })
      .run();
// returns Promise<R.Success(10)>
```

We can use a more idomatic syntax to pipe the success value to the next function and get rid of the intermediary variables
```ts
const r = await ResultFlow
      .lift(R.toSuccess('10'))
      .chain(value => R.toSuccess(Number.parseInt(value))) // works with (value) => Result
      .chain(value => Promise.resolve(R.toSuccess(value + 20))) // works with (value) => Promise<Result>
      .run();
// returns Promise<R.Success(10)>
```


### Explanation:

- `lift` takes the `Result` and puts it inside a `ResultFlow` context
- We chain the function using the `.chain` method. It accepts either a function that returns a `Result`, a `Promise<Result>`, or a `ResultFlow`.


## Use case: custom error handling on one of the results

Let's assume that we want to execute some specific logic when the validation fails with a specific error code

```ts
correctData(data: Data): Promise<R.Result<UpdateByIdFailure, Data>>;
const resultFlow = ResultFlow.of<FlowFailure, DataRow>(
  async ({ fail, tryTo }) => {
    let data = await tryTo(repositoryMock.findById(1));

    // we manually handle the validation error by not using the tryTo helper
    const isValidResult = validate(row);
    if(R.isFailure(isValidResult)) {
      if(error.reason === 'invalid-data') {
        data = await tryTo(correctData(row));
      }
      else {
        // fails the flow with the current error
        fail(result.error)
      }
    }

    return tryTo(repositoryMock.updateById(1, { description: 'updated-description' }));
  },
);

const flowResult = await resultFlow.run(); // Result<FlowFailure, Data>
```

### Explanation:

- We don't use `tryTo` on the validate function because we want to handle the failure ourselves
- If the failure is `invalid-data`, we try to correct it. Otherwise we immediately fail the flow with the current error, by using the type safe `fail` helper

*Note: it's usually better to avoid relying on mutable variables*

## Use case: execute a flow only if another one fails

Let's assume that we try to fetch some data from a cache. If it fails, we get it from the DB.

```ts
getCacheInstance(): Promise<R.Result<'error', Cache>>;
getCacheData(cache: Cache, id: number): Promise<R.Result<'not-found', Data>>;
getDataFromDB(id: number): Promise<R.Result<'not-found', Data>>;

const getFromCacheFlow = ResultFlow.of<'error' | 'not-found', Data>(
  async ({ tryTo }) => {
    const cache = await tryTo(getCacheInstance());
    return tryTo(getCacheData(cache, 1);
  },
);

const getFromDbFlow = ResultFlow.of<'not-found-db', Data>(
  async ({ tryTo }) => {
    return tryTo(getDataFromDB(1);
  },
);

const finalResult = await getFromCacheFlow.orElse(() => getFromDbFlow).run(); // Result<'error' | 'not-found' | 'not-found-db', Data>
```

### Explanation:

- We define 2 flows: 1 to get the data from the cache, 1 to get the data from the DB
- we use the `orElse` to indicate that if the cache flow fails, we want to execute the DB flow. The DB flow is never executed if the 1st one succeeds.

Now let's add some side effects:

```ts
// ...
const finalResult = await
  getFromCacheFlow
  .ifSuccess(() => console.log("Successfully got the data from the cache. We skip the DB."))
  .ifFailure(() => console.log("Failed to get the data from cache. Let's try the DB"))
  .orElse(getFromDbFlow)
  .run();
```

### Explanation:

- We use the `ifSuccess` and `ifFailure` methods to add some logging for each case

Finally, we execute some logic on the data we got from the cache / DB:

```ts
// ...
const finalResult = await
  getFromCacheFlow
  .ifSuccess(() => console.log("Successfully got the data from the cache. We skip the DB."))
  .ifFailure(() => console.log("Failed to get the data from cache. Let's try the DB"))
  .orElse(getFromDbFlow)
  .chain(transformData(data)); // transformData can return a Result / PromiseResult / ResultFlow
  ))
  .run();
```

### Explanation:

- We use the `chain` to execute another flow which has access to the success data of the previous flow (same behaviour as `Promise.then`)

## API reference

### static `of`

Build a `ResultFlow`. Nothing gets executed until the `run` method is called.

```ts
ResultFlow.of<E, A>(builderFunction: ({fail, tryTo, promiseHelpers}: ResultFlowHelpers<E>) => PromiseLike<A>): ResultFlow<E, A>
```

with

- `fail<Failure>(error: Failure): never`
- `tryTo<E>(result: R.Result<unknown, A> | PromiseLike<R.Result<unknown, A>>): PromiseLike<A>`
- promiseHelpers
```ts
interface promiseHelpers: {
  fromNullable<E, A>(promise: Promise<A>, error: E): Promise<R.Result<E, NonNullable<A>>>;
  mapError<E, A, E2>(promise: Promise<R.Result<E, A>>, mapper: (error: E) => E2): Promise<R.Result<E2, A>>;
}
```

#### Examples

```ts
// the followings are all equivalent
const r1 = ResultFlow.of<never, number>(async () => 10);
const r2 = ResultFlow.of<never, number>(async ({ tryTo }) =>
  tryTo(R.toSuccess(10)),
);
const r3 = ResultFlow.of<never, number>(async ({ tryTo }) =>
  tryTo(Promise.resolve(R.toSuccess(10))),
);

// early fail
const failure = ResultFlow.of<'error', number>(async ({ fail }) => {
  fail('error');
  // nothing is executed past the fail instruction
  return 10;
});
failure.run(); // return Promise<R.Failure('error')>
```

### static `lift`

Takes a `Result<E, A>` / a `Promise<Result<E, A>>` / a function that returns any of the former, and puts it into a `ResultFlow` context

```ts
ResultFlow.lift<E, A>(value: Promise<R.Result<E, A>> | R.Result<E, A> | (() => Promise<R.Result<E, A>>) | (() => R.Result<E, A>)): ResultFlow<E, A>
```

#### Examples

```ts
// the followings are all equivalent
const r1 = ResultFlow.lift(R.toSuccess(10));
const r2 = ResultFlow.lift(() => R.toSuccess(10));
const r3 = ResultFlow.lift(Promise.resolve(R.toSuccess(10)));
const r4 = ResultFlow.lift(() => Promise.resolve(R.toSuccess(10)));
```

### static `gen`

Creates a `ResultFlow` using generator-style syntax. This provides an alternative, more imperative-looking syntax for building flows compared to `of`. Similar to async/await, you can `yield` on `ResultFlow`, `Result`, or `ResultAsync` values, and the flow will automatically unwrap success values or stop on failures.

```ts
ResultFlow.gen<A, E, C>(f: (extras: Extras<C>) => AsyncGenerator<ResultFlow<unknown, E, C> | Result<unknown, E> | ResultAsync<unknown, E>, A, unknown>): ResultFlow<A, E, C>
```

#### Examples

```ts
// Basic usage with ResultFlow
const flow = ResultFlow.gen<Row, FlowFailure>(async function* () {
  const data = yield* findById(1); // findById returns Promise<Result>
  yield* validate(data, true); // validate returns Result
  return yield* updateById(data.id, { name: 'updated-name' });
});

const result = await flow.run(); // Result<Row, FlowFailure>
```

```ts
// Using with plain Results
const flow = ResultFlow.gen(async function* () {
  const a = yield* R.toSuccess(10);
  const b = yield* R.toSuccess(5);
  return a + b;
});

const result = await flow.run(); // Result<15, never>
```

```ts
// Accessing context
const flow = ResultFlow.gen<number, Error, Context>(async function* ({ context }) {
  console.log(context.userId);
  return yield* R.toSuccess(42);
});

await flow.run({ context: { userId: 'user-123' } });
```

### `run`

Executes the flow. Nothing gets executed until this method is called.
It returns a **resolved promise** with a `Result` (from the general type helpers) inside.
However if your code threw an exception, it does not intercept it and the promise is rejected.

You can pass a `context` object that will be accessible in all methods throughout the flow (in `map`, `chain`, `ifSuccess`, etc.).

```ts
(method) ResultFlow<E, A, C>.run(options?: { context: C }): Promise<R.Result<E, A>>
```

#### Examples

```ts
const r = ResultFlow.of<never, number>(async () => 10).run(); // Promise<R.Success(20)>

const f = ResultFlow.of<'error', number>(async () => {
  fail('error');
  return 10;
}).run(); // Promise<R.Failure('error')>
```

```ts
// With context
type Context = { userId: string; correlationId: string };

const flow = ResultFlow.of<Data, Error, Context>(async ({ tryTo }, { context }) => {
  console.log(`Processing for user: ${context.userId}`);
  return tryTo(fetchData());
});

await flow.run({ context: { userId: 'user-123', correlationId: 'abc-456' } });
```

### `map`

Executes a function over a success. The function receives the success value and the extras object containing the context.

```ts
(method) ResultFlow<E, A, C>.map<A2>(f: (value: A, extras: { context: C }) => A2): ResultFlow<E, A2, C>
```

#### Examples

```ts
const r = ResultFlow
            .of<never, number>(async () => 10)
            .map(value => value + 10)
            .run(); // Promise<R.Success(20)>

const f = ResultFlow
            .of<'error', number>(async () => {
              fail('error');
              return 10;
            })
            .map(value => value + 10) // not executed
            .run(); // Promise<R.Failure('error')>
```

```ts
// With context
type Context = { multiplier: number };

const r = ResultFlow
            .of<number, never, Context>(async () => 10)
            .map((value, { context }) => value * context.multiplier)
            .run({ context: { multiplier: 3 } }); // Promise<R.Success(30)>
```

### `mapError`

Executes a function over a failure. The function receives the error value and the extras object containing the context.

```ts
(method) ResultFlow<E, A, C>.mapError<E2>(f: (value: E, extras: { context: C }) => E2): ResultFlow<E2, A, C>
```

#### Examples

```ts
const r = ResultFlow
            .of<'error', number>(async () => 10)
            .mapError(error => `transformed-${error}`)
            .run(); // Promise<R.Success(20)>

const f = ResultFlow
            .of<'error', number>(async () => {
              fail('error');
              return 10;
            })
            .mapError(error => `transformed-${error}`)
            .run(); // Promise<R.Failure('transformed-error')>
```

```ts
// With context
type Context = { requestId: string };

const f = ResultFlow
            .of<'error', number, Context>(async ({ fail }) => {
              fail('error');
              return 10;
            })
            .mapError((error, { context }) => ({
              error,
              requestId: context.requestId
            }))
            .run({ context: { requestId: 'req-123' } }); 
            // Promise<R.Failure({ error: 'error', requestId: 'req-123' })>
```

### `chain`

Chains a success `ResultFlow` with:
- a function that returns a `ResultFlow`
- a function that returns a `Promise<Result>`
- a function that returns a `Result`

The chained function receives the success value and the extras object containing the context.
returns a `ResultFlow` which is the result of the composition

```ts
(method) ResultFlow<E, A, C>.chain<E2, A2, C2>(f: (value: A, extras: { context: C & C2 }) => ResultFlow<E2, A2, C2> | Promise<R.Result<E2, A2>> | R.Result<E2, A2>): ResultFlow<E | E2, A2, C & C2>
```

#### Examples

```ts
const flowWithFailure = ResultFlow.lift(R.toFailure('error'));
const flowWithSuccess = ResultFlow.of<never, number>(async () => 10);
const getSecondFlow = (n: number) =>
  ResultFlow.of<never, number>(async () => n + 10);

const success = flowWithSuccess.chain(getSecondFlow).run(); // Promise<R.Success(20)>
const failure = flowWithFailure.chain(getSecondFlow).run(); // Promise<R.Failure('error')>
```

```ts
// With context
type Context = { apiUrl: string };

const flow = ResultFlow
  .of<User, Error, Context>(async ({ tryTo }) => tryTo(getUser(1)))
  .chain((user, { context }) => 
    fetchFromApi(`${context.apiUrl}/users/${user.id}/details`)
  );

await flow.run({ context: { apiUrl: 'https://api.example.com' } });
```

### `orElse`

Executes the alternative if the previous flow is a failure.
The alternative function receives the previous flow failure and the extras object containing the context, and accepts:
- a function that returns a `ResultFlow`
- a function that returns a `Promise<Result>`
- a function that returns a `Result`

returns a `ResultFlow` which is the result of the composition

```ts
(method) ResultFlow<E, A, C>.orElse<E2, C2>(alternative: (error: E, extras: { context: C & C2 }) => ResultFlow<E2, A, C2> | Promise<R.Result<E2, A>> | R.Result<E2, A>): ResultFlow<E2, A, C & C2>
```

#### Examples

```ts
const flowWithFailure = ResultFlow.of<'error', number>(async () => {
  fail('error');
  return 10;
});
const flowWithSuccess = ResultFlow.of<never, number>(async () => 10);
const alternative = ResultFlow.of<never, number>(async () => 100);

const r1 = flowWithSuccess.orElse((_error) => alternative).run(); // Promise<R.Success(10)>
const r2 = flowWithFailure.orElse((_error) => alternative).run(); // Promise<R.Success(100)>
```

```ts
// With context
type Context = { fallbackUrl: string };

const flow = ResultFlow
  .of<Data, 'network-error', Context>(async ({ tryTo }) => 
    tryTo(fetchFromPrimarySource())
  )
  .orElse((error, { context }) => {
    console.log(`Primary failed with ${error}, trying ${context.fallbackUrl}`);
    return fetchFromUrl(context.fallbackUrl);
  });

await flow.run({ context: { fallbackUrl: 'https://backup.example.com' } });
```

### `ifSuccess`

Executes an effect if the `ResultFlow` is a success. The function receives the success value and the extras object containing the context.

```ts
(method) ResultFlow<E, A, C>.ifSuccess(f: (value: A, extras: { context: C }) => void): ResultFlow<E, A, C>
```

#### Examples

```ts
const r = ResultFlow
  .lift(R.toSuccess(10))
  .ifSuccess((value) => console.log(`the value is ${value}`)) // this will be executed
  .run();

const f = ResultFlow
  .lift(R.toFailure('error'))
  .ifSuccess((_value) => console.log(`this log will not be executed`))
  .run();
```

```ts
// With context
type Context = { logger: Logger };

const flow = ResultFlow
  .of<Data, Error, Context>(async ({ tryTo }) => tryTo(fetchData()))
  .ifSuccess((data, { context }) => {
    context.logger.info(`Successfully fetched data: ${data.id}`);
  });

await flow.run({ context: { logger: myLogger } });
```

### `ifFailure`

Executes an effect if the `ResultFlow` is a failure. The function receives the error value and the extras object containing the context.

```ts
(method) ResultFlow<E, A, C>.ifFailure(f: (value: E, extras: { context: C }) => void): ResultFlow<E, A, C>
```

#### Examples

```ts
const r = ResultFlow
  .lift(R.toSuccess(10))
  .ifFailure((_failure_) => console.log(`this log will not be executed`))
  .run();

const f = ResultFlow
  .lift(R.toFailure('error'))
  .ifFailure((failure) => console.log(`the failure is ${failure}`)) // this will be executed
  .run();
```

```ts
// With context
type Context = { alertService: AlertService };

const flow = ResultFlow
  .of<Data, Error, Context>(async ({ tryTo }) => tryTo(fetchData()))
  .ifFailure((error, { context }) => {
    context.alertService.send(`Failed to fetch data: ${error.message}`);
  });

await flow.run({ context: { alertService: myAlertService } });
```

### `retryPolicy`

Applies a retry policy to the flow. If the flow fails and matches the retry condition, it will be retried up to `maxRetries` times. The retry strategy can be either immediate or use exponential backoff.

The `beforeRetry` callback receives the error, retry number, and the extras object containing the context.

```ts
(method) ResultFlow<E, A, C>.retryPolicy({
  condition?: (error: E) => boolean;
  beforeRetry?: (error: E, retryNumber: number, extras: { context: C }) => Promise<void> | void;
  maxRetries?: number;
  retryStrategy?: DelayStrategy;
}): ResultFlow<E, A, C>
```

with `DelayStrategy` being:
```ts
type DelayStrategy = 
  | { type: 'immediate' }
  | { type: 'exponential'; initialDelay?: number; maxDelay?: number; factor?: number };
```

#### Examples

```ts
// Simple retry with default settings (1 retry, immediate)
const flow = ResultFlow
  .of<Data, 'network-error'>(async ({ tryTo }) => {
    return tryTo(fetchDataFromApi());
  })
  .retryPolicy();

await flow.run(); // Will retry once immediately if it fails
```

```ts
// Retry with exponential backoff
const flow = ResultFlow
  .of<Data, 'network-error' | 'timeout'>(async ({ tryTo }) => {
    return tryTo(fetchDataFromApi());
  })
  .retryPolicy({
    maxRetries: 3,
    retryStrategy: { 
      type: 'exponential', 
      initialDelay: 1000, // 1 second
      maxDelay: 10000,    // 10 seconds max
      factor: 2           // doubles each time
    },
    // Only retry on network errors, not timeouts
    condition: (error) => error === 'network-error',
    beforeRetry: (error, retryNumber) => {
      console.log(`Attempt ${retryNumber} failed with ${error}, retrying...`);
    }
  });

await flow.run();
```

```ts
// With context
type Context = { logger: Logger; requestId: string };

const flow = ResultFlow
  .of<Data, 'network-error', Context>(async ({ tryTo }, { context }) => {
    context.logger.debug(`Attempt for request ${context.requestId}`);
    return tryTo(fetchDataFromApi());
  })
  .retryPolicy({
    maxRetries: 3,
    retryStrategy: { type: 'exponential', initialDelay: 1000 },
    beforeRetry: (error, retryNumber, { context }) => {
      context.logger.warn(
        `Request ${context.requestId} failed on attempt ${retryNumber}: ${error}`
      );
    }
  });

await flow.run({ context: { logger: myLogger, requestId: 'req-789' } });
```

### `runPeriodically`

Runs the flow repeatedly at a fixed interval until it fails or is aborted. This is useful for monitoring tasks, health checks, or polling operations. You can optionally provide a recovery action that attempts to fix failures before stopping the flow.

```ts
(method) ResultFlow<E, A>.runPeriodically<E2>({
  interval: number;
  recoveryAction?: (error: E, extras: Extras<C>) => PolymorphicResult<unknown, E2>;
  onInterruption?: (
    param: 
      | { cause: 'failure'; error: E; recoveryError: E2 | undefined } 
      | { cause: 'aborted' }
  ) => void;
  abortSignal?: AbortSignal;
  context?: C;
}): void
```

#### Examples

```ts
// Simple health check that runs every 5 seconds
const healthCheckFlow = ResultFlow.of<void, 'service-down'>(async ({ tryTo }) => {
  return tryTo(checkServiceHealth());
});

healthCheckFlow.runPeriodically({
  interval: 5000, // 5 seconds
  onInterruption: ({ cause, error }) => {
    if (cause === 'failure') {
      console.error(`Service is down: ${error}`);
      sendAlert(error);
    }
  }
});
```

```ts
// With recovery action
const monitorFlow = ResultFlow.of<void, 'connection-lost'>(async ({ tryTo }) => {
  return tryTo(checkConnection());
});

monitorFlow.runPeriodically({
  interval: 10000, // 10 seconds
  recoveryAction: (error) => {
    console.log('Attempting to reconnect...');
    return reconnect(); // Returns Promise<Result> or ResultFlow
  },
  onInterruption: ({ cause, error, recoveryError }) => {
    if (cause === 'failure') {
      console.error(`Failed: ${error}`);
      if (recoveryError) {
        console.error(`Recovery also failed: ${recoveryError}`);
      }
    }
  }
});
```

```ts
// With abort signal for manual cancellation
const controller = new AbortController();

const pollingFlow = ResultFlow.of<Data, 'fetch-error'>(async ({ tryTo }) => {
  return tryTo(pollForUpdates());
});

pollingFlow.runPeriodically({
  interval: 2000,
  abortSignal: controller.signal,
  onInterruption: ({ cause }) => {
    if (cause === 'aborted') {
      console.log('Polling stopped by user');
    }
  }
});

// Later: stop polling
controller.abort();
```
