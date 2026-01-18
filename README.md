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

### `run`

Executes the flow. Nothing gets executed until this method is called.
It returns a **resolved promise** with a `Result` (from the general type helpers) inside.
However if your code threw an exception, it does not intercept it and the promise is rejected.

```ts
(method) ResultFlow<E, A>.run(): Promise<R.Result<E, A>>
```

#### Examples

```ts
const r = ResultFlow.of<never, number>(async () => 10).run(); // Promise<R.Success(20)>

const f = ResultFlow.of<'error', number>(async () => {
  fail('error');
  return 10;
}).run(); // Promise<R.Failure('error')>
```

### `map`

Executes a function over a success

```ts
(method) ResultFlow<E, A>.map<A2>(f: (value: A) => A2): ResultFlow<E, A2>
```

#### Examples

```ts
const r = ResultFlow
            .of<never, number>(async () => 10)
            .map(value => value + 10);
            .run(); // Promise<R.Success(20)>

const f = ResultFlow
            .of<'error', number>(async () => {
              fail('error');
              return 10;
            })
            .map(value => value + 10); // not executed
            .run(); // Promise<R.Failure('error')>
```

### `mapError`

Executes a function over a failure

```ts
(method) ResultFlow<E, A>.mapError<E2>(f: (value: L) => L2): ResultFlow<E2, A>
```

#### Examples

```ts
const r = ResultFlow
            .of<'error', number>(async () => 10)
            .mapError(error => `transformed-${error}`);
            .run(); // Promise<R.Success(20)>

const f = ResultFlow
            .of<'error', number>(async () => {
              fail('error');
              return 10;
            })
            .mapError(error => `transformed-${error}`);
            .run(); // Promise<R.Failure('transformed-error')>
```

### `chain`

Chains a success `ResultFlow` with:
- a function that returns a `ResultFlow`
- a function that returns a `Promise<Result>`
- a function that returns a `Result`

returns a `ResultFlow` which is the result of the composition

```ts
(method) ResultFlow<E, A>.chain<E2, A2>(f: (value: A) => ResultFlow<E2, A2> | Promise<R.Result<E2, A2>> | R.Result<E2, A2>): ResultFlow<E | E2, A2>
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

### `orElse`

Executes the alternative of the previous flow is a failure.
This takes as a parameter the previous flow failure, and accepts:
- a function that returns a `ResultFlow`
- a function that returns a `Promise<Result>`
- a function that returns a `Result`

returns a `ResultFlow` which is the result of the composition

```ts
(method) ResultFlow<E, A>.orElse<E2>(alternative: (error: E) => ResultFlow<E2, A> | Promise<R.Result<E2, A>> | R.Result<E2, A>): ResultFlow<E | E2, A>
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

### `ifSuccess`

Executes an effect if the `ResultFlow` is a success

```ts
(method) ResultFlow<E, A>.ifSuccess(f: (value: R) => void): ResultFlow<E, A>
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

### `ifFailure`

Executes an effect if the `ResultFlow` is a failure

```ts
(method) ResultFlow<E, A>.ifFailure(f: (value: L) => void): ResultFlow<E, A>
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
