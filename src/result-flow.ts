import * as N from 'neverthrow';
import type { Result, ResultAsync, Err } from 'neverthrow';
import * as PromiseHelpers from './promise-helpers.js';
import { calculateDelay, wait, type DelayStrategy } from './delay.js';
import type { IsAny, UnionToIntersection } from './typeHelper.js';

export interface ResultFlowHelpers<E> {
  tryTo<A>(result: Result<A, E> | Promise<Result<A, E>> | ResultAsync<A, E>): Promise<A>;
  tryTo<A, E2>(
    result: Result<A, E2> | Promise<Result<A, E2>> | ResultAsync<A, E2>,
    options: {
      mapError: (value: E2) => E;
    },
  ): Promise<A>;
  fail(error: E): never;
  promiseHelpers: PromiseHelpers.PromiseHelpers;
}

const unwrap = <A, E>(result: Result<A, E>): A => {
  if (result.isOk()) {
    return result.value;
  }

  throw new ResultInterruption(result);
};

type DefaultContext = Record<never, never>;
type BaseContext = Record<string, any>;
type SubContext<C> = { [K in keyof C]?: C[K] };
type PolymorphicResult<A, E, C extends BaseContext = DefaultContext> = ResultFlow<A, E, C> | Promise<Result<A, E>> | Result<A, E> | ResultAsync<A, E>;
// RunParams is the public caller input. Extras is the normalized runtime shape
// passed to flow callbacks, so context is always present there.
type Extras<C extends BaseContext> = { context: C; abortSignal?: AbortSignal; };
type RunParams<C extends BaseContext> =
  { abortSignal?: AbortSignal } & (keyof C extends never ? { context?: C } : { context: C });
type FlowSuccess<F> = F extends ResultFlow<infer A, any, any> ? A : never;
type FlowError<F> = F extends ResultFlow<any, infer E, any> ? E : never;
type FlowContext<F> = F extends ResultFlow<any, any, infer C> ? C : never;
type FlowSuccesses<Flows extends readonly ResultFlow<any, any, any>[]> = FlowSuccess<Flows[number]>;
type FlowErrors<Flows extends readonly ResultFlow<any, any, any>[]> = FlowError<Flows[number]>;
type FlowErrorArray<Flows extends readonly ResultFlow<any, any, any>[]> = FlowErrors<Flows>[];
type FlowResult<F> = F extends ResultFlow<infer A, infer E, any> ? Result<A, E> : never;
type NormalizeContext<C> = IsAny<C> extends true
  ? DefaultContext
  : C extends BaseContext
    ? C
    : DefaultContext;
type FlowContexts<Flows extends readonly ResultFlow<any, any, any>[]> = NormalizeContext<
  UnionToIntersection<FlowContext<Flows[number]>>
>;
type FlowValues<Flows extends readonly ResultFlow<any, any, any>[]> = {
  [K in keyof Flows]: FlowSuccess<Flows[K]>;
};
type FlowResults<Flows extends readonly ResultFlow<any, any, any>[]> = {
  [K in keyof Flows]: FlowResult<Flows[K]>;
};

export class ResultFlow<A, E, C extends BaseContext = DefaultContext> {
  private constructor(private runPromise: (helpers: ResultFlowHelpers<E>, extras: Extras<C>) => Promise<A>) {}

  private static buildExtras<C extends BaseContext>(
    ...args: keyof C extends never
      ? [] | [RunParams<C>]
      : [RunParams<C>]
  ): Extras<C> {
    const [{ context = {} as C, abortSignal } = {} as RunParams<C>] = args;
    return abortSignal ? { context, abortSignal } : { context };
  }

  private helpers: ResultFlowHelpers<E> = {
    tryTo<A1, E2>(
      result: Result<A1, E2> | Promise<Result<A1, E2>>,
      options?: {
        mapError?: (value: E2) => E;
      },
    ): Promise<A1> {
      return options?.mapError
        ? PromiseHelpers.mapError(Promise.resolve(result), options.mapError).then(unwrap)
        : Promise.resolve(result).then(unwrap);
    },
    fail(error: E): never {
      // eslint-disable-next-line @spendesk/must-use-result
      const resultError = N.err(error);
      throw new ResultInterruption(resultError);
    },
    promiseHelpers: PromiseHelpers,
  };

  static of<A, E, C extends BaseContext = DefaultContext>(
    builderFunction: (helpers: ResultFlowHelpers<E>, extras: Extras<C>) => Promise<A>,
  ): ResultFlow<A, E, C> {
    return new ResultFlow<A, E, C>(builderFunction);
  }

  static isResultFlow<A, E, C extends BaseContext = DefaultContext>(value: unknown): value is ResultFlow<A, E, C> {
    return value instanceof ResultFlow;
  }

  static from<A, E, C extends BaseContext = DefaultContext>(
    value:
      | Promise<Result<A, E>>
      | Result<A, E>
      | ResultAsync<A, E>
      | (() => Promise<Result<A, E>>)
      | (() => Result<A, E>)
      | (() => ResultAsync<A, E>),
  ): ResultFlow<A, E, C> {
    return ResultFlow.of<A, E, C>(async ({ tryTo }) => {
      return typeof value === 'function' ? tryTo(value()) : tryTo(value);
    });
  }

  static lift<A, E, C extends BaseContext = DefaultContext>(
    value:
      | Promise<Result<A, E>>
      | Result<A, E>
      | ResultAsync<A, E>
      | (() => Promise<Result<A, E>>)
      | (() => Result<A, E>)
      | (() => ResultAsync<A, E>),
  ): ResultFlow<A, E, C> {
    return ResultFlow.from(value);
  }

  static all<const Flows extends readonly ResultFlow<any, any, any>[]>(
    flows: Flows,
  ): ResultFlow<
    FlowValues<Flows>,
    FlowErrors<Flows>,
    FlowContexts<Flows>
  > {
    return ResultFlow.of<
      FlowValues<Flows>,
      FlowErrors<Flows>,
      FlowContexts<Flows>
    >(async ({ tryTo }, extras) => {
      const values: unknown[] = [];
      const flowsToRun = flows as readonly ResultFlow<
        unknown,
        FlowErrors<Flows>,
        FlowContexts<Flows>
      >[];

      for (const flow of flowsToRun) {
        values.push(await tryTo(flow.run(extras)));
      }

      return values as FlowValues<Flows>;
    });
  }

  static allSettled<const Flows extends readonly ResultFlow<any, any, any>[]>(
    flows: Flows,
  ): ResultFlow<
    FlowResults<Flows>,
    never,
    FlowContexts<Flows>
  > {
    return ResultFlow.of<
      FlowResults<Flows>,
      never,
      FlowContexts<Flows>
    >(async (_helpers, extras) => {
      const flowsToRun = flows as readonly ResultFlow<
        unknown,
        FlowErrors<Flows>,
        FlowContexts<Flows>
      >[];
      const settledResults = await Promise.allSettled(
        flowsToRun.map((flow) => flow.run(extras)),
      );
      const results: Result<unknown, FlowErrors<Flows>>[] = [];

      for (const settledResult of settledResults) {
        if (settledResult.status === 'rejected') {
          throw settledResult.reason;
        }

        results.push(settledResult.value);
      }

      return results as FlowResults<Flows>;
    });
  }

  static firstOk<const Flows extends readonly ResultFlow<any, any, any>[]>(
    flows: Flows,
  ): ResultFlow<
    FlowSuccesses<Flows>,
    FlowErrorArray<Flows>,
    FlowContexts<Flows>
  > {
    return ResultFlow.of<
      FlowSuccesses<Flows>,
      FlowErrorArray<Flows>,
      FlowContexts<Flows>
    >(async ({ fail }, extras) => {
      if (flows.length === 0) {
        throw new Error('ResultFlow.firstOk requires at least one flow');
      }

      const errors: FlowErrors<Flows>[] = [];
      const flowsToRun = flows as readonly ResultFlow<
        FlowSuccesses<Flows>,
        FlowErrors<Flows>,
        FlowContexts<Flows>
      >[];

      for (const flow of flowsToRun) {
        const result = await flow.run(extras);

        if (result.isOk()) {
          return result.value;
        }

        errors.push(result.error);
      }

      return fail(errors);
    });
  }

  static race<const Flows extends readonly ResultFlow<any, any, any>[]>(
    flows: Flows,
  ): ResultFlow<
    FlowSuccesses<Flows>,
    FlowErrors<Flows>,
    FlowContexts<Flows>
  > {
    return ResultFlow.of<
      FlowSuccesses<Flows>,
      FlowErrors<Flows>,
      FlowContexts<Flows>
    >(async ({ tryTo }, extras) => {
      if (flows.length === 0) {
        throw new Error('ResultFlow.race requires at least one flow');
      }

      const flowsToRun = flows as readonly ResultFlow<
        FlowSuccesses<Flows>,
        FlowErrors<Flows>,
        FlowContexts<Flows>
      >[];

      return tryTo(Promise.race(flowsToRun.map((flow) => flow.run(extras))));
    });
  }

  async run(
    ...args: keyof C extends never
      ? [] | [RunParams<C>]
      : [RunParams<C>]
  ): Promise<Result<A, E>> {
    const extras = ResultFlow.buildExtras<C>(...args);

    return this.executeWithExtras(extras);
  }

  async match<B>(
    handlers: {
      ok: (value: A, extras: Extras<C>) => B | Promise<B>;
      err: (error: E, extras: Extras<C>) => B | Promise<B>;
    },
    ...args: keyof C extends never
      ? [] | [RunParams<C>]
      : [RunParams<C>]
  ): Promise<B> {
    const extras = ResultFlow.buildExtras<C>(...args);
    const result = await this.executeWithExtras(extras);

    if (result.isOk()) {
      return handlers.ok(result.value, extras);
    }

    return handlers.err(result.error, extras);
  }

  private async executeWithExtras(extras: Extras<C>): Promise<Result<A, E>> {
    try {
      return N.ok(await this.runPromise(this.helpers, extras));
    } catch (e: unknown) {
      if (e instanceof ResultInterruption) {
        return e.error;
      }
      throw e;
    }
  }

  map<A2>(f: (value: A, extras: Extras<C>) => A2): ResultFlow<A2, E, C> {
    return ResultFlow.of<A2, E, C>(async ({tryTo}, extras) => {
      const value = await tryTo(this.run(extras));
      return f(value, extras);
    });
  }

  mapBoth<A2, E2>(
    handlers: {
      ok: (value: A, extras: Extras<C>) => A2;
      err: (error: E, extras: Extras<C>) => E2;
    },
  ): ResultFlow<A2, E2, C> {
    return ResultFlow.of<A2, E2, C>(async ({ fail }, extras) => {
      const result = await this.run(extras);

      if (result.isOk()) {
        return handlers.ok(result.value, extras);
      }

      return fail(handlers.err(result.error, extras));
    });
  }

  ensure<E2>(
    predicate: (value: A, extras: Extras<C>) => boolean | Promise<boolean>,
    onFailure: (value: A, extras: Extras<C>) => E2 | Promise<E2>,
  ): ResultFlow<A, E | E2, C> {
    return ResultFlow.of<A, E | E2, C>(async ({ fail, tryTo }, extras) => {
      const value = await tryTo(this.run(extras));
      if (await predicate(value, extras)) {
        return value;
      }

      return fail(await onFailure(value, extras));
    });
  }

  mapError<E2>(f: (value: E, extras: Extras<C>) => E2): ResultFlow<A, E2, C> {
    return ResultFlow.of<A, E2, C>(async ({ fail }, extras) => {
      const result = await this.run(extras);
      if (result.isErr()) {
        fail(f(result.error, extras));
      }
      return (result as { value: A }).value;
    });
  }

  chain<A2, E2, C2 extends BaseContext = DefaultContext>(
    f: (value: A, extras: Extras<C & C2>) => PolymorphicResult<A2, E2, C2>,
  ): ResultFlow<A2, E | E2, C & C2> {
    return ResultFlow.of<A2, E | E2, C & C2>(async ({ tryTo }, extras) => {
      const result = await tryTo(this.run(extras));
      const fResult = f(result, extras);
      return ResultFlow.isResultFlow<A2, E2, C2>(fResult) ? tryTo(fResult.run(extras)) : tryTo(fResult);
    });
  }

  ifSuccess(f: (value: A, extras: Extras<C>) => void | Promise<void>): ResultFlow<A, E, C> {
    return ResultFlow.of<A, E, C>(async ({ tryTo }, extras) => {
      const result = await tryTo(this.run(extras));
      await f(result, extras);
      return result;
    });
  }

  tap(f: (value: A, extras: Extras<C>) => void | Promise<void>): ResultFlow<A, E, C> {
    return this.ifSuccess(f);
  }

  ifFailure(f: (value: E, extras: Extras<C>) => void | Promise<void>): ResultFlow<A, E, C> {
    return ResultFlow.of<A, E, C>(async ({ fail }, extras) => {
      const result = await this.run(extras);
      if (result.isErr()) {
        await f(result.error, extras);
        fail(result.error);
      }
      return (result as N.Ok<A, E>).value;
    });
  }

  tapError(f: (value: E, extras: Extras<C>) => void | Promise<void>): ResultFlow<A, E, C> {
    return this.ifFailure(f);
  }

  finally(
    effect: (result: Result<A, E>, extras: Extras<C>) => void | Promise<void>,
  ): ResultFlow<A, E, C> {
    return ResultFlow.of<A, E, C>(async ({ fail }, extras) => {
      const result = await this.run(extras);
      await effect(result, extras);

      if (result.isErr()) {
        fail(result.error);
      }

      return (result as N.Ok<A, E>).value;
    });
  }

  tapBoth(
    effect: (result: Result<A, E>, extras: Extras<C>) => void | Promise<void>,
  ): ResultFlow<A, E, C> {
    return this.finally(effect);
  }

  orElse<E2, C2 extends BaseContext = DefaultContext>(
    alternative: (error: E, extras: Extras<C & C2>) => PolymorphicResult<A, E2, C2>,
  ): ResultFlow<A, E2, C & C2> {
    return ResultFlow.of<A, E2, C & C2>(async ({ tryTo }, extras) => {
      const result = await this.run(extras);
      if (result.isOk()) {
        return result.value;
      }

      const alternativeResult = alternative(result.error, extras);
      return ResultFlow.isResultFlow<A, E2, C2>(alternativeResult)
        ? tryTo(alternativeResult.run(extras))
        : tryTo(alternativeResult);
    });
  }

  recover<A2>(
    f: (error: E, extras: Extras<C>) => A2 | Promise<A2>,
  ): ResultFlow<A | A2, never, C> {
    return ResultFlow.of<A | A2, never, C>(async (_helpers, extras) => {
      const result = await this.run(extras);
      if (result.isOk()) {
        return result.value;
      }

      return f(result.error, extras);
    });
  }

  retryPolicy({
    beforeRetry,
    condition = () => true,
    maxRetries = 1,
    retryStrategy = { type: "immediate" },
  }: {
    condition?: (error: E) => boolean;
    beforeRetry?: (error: E, retryNumber: number, extras: Extras<C>) => Promise<void> | void;
    maxRetries?: number;
    retryStrategy?: DelayStrategy;
  } = {}): ResultFlow<A, E, C> {
    return ResultFlow.of<A, E, C>(async ({ fail, tryTo }, extras) => {
      for (let i = 0; i < maxRetries; i++) {
        const result = await this.run(extras);
        if (result.isErr()) {
          const shouldRetry = condition(result.error);
          if (shouldRetry) {
            if (beforeRetry) {
              await beforeRetry(result.error, i + 1, extras);
            }
            const delay = calculateDelay(retryStrategy, i + 1);
            if (delay > 0) {
              await wait(delay);
            }
            continue;
          } else {
            return fail(result.error);
          }
        }
        return result.value;
      }
      return tryTo(this.run(extras));
    });
  }

  repeatUntil<E2>({
    predicate,
    onExhausted,
    maxRepeats = 1,
    delayStrategy = { type: "immediate" },
    beforeRepeat,
  }: {
    predicate: (value: A, extras: Extras<C>) => boolean | Promise<boolean>;
    onExhausted: (lastValue: A, extras: Extras<C>) => E2 | Promise<E2>;
    maxRepeats?: number;
    delayStrategy?: DelayStrategy;
    beforeRepeat?: (value: A, repeatNumber: number, extras: Extras<C>) => void | Promise<void>;
  }): ResultFlow<A, E | E2, C> {
    return ResultFlow.of<A, E | E2, C>(async ({ fail }, extras) => {
      let repeatNumber = 0;

      while (true) {
        const result = await this.run(extras);

        if (result.isErr()) {
          return fail(result.error);
        }

        if (await predicate(result.value, extras)) {
          return result.value;
        }

        if (repeatNumber >= maxRepeats) {
          return fail(await onExhausted(result.value, extras));
        }

        repeatNumber += 1;
        if (beforeRepeat) {
          await beforeRepeat(result.value, repeatNumber, extras);
        }

        const delay = calculateDelay(delayStrategy, repeatNumber);
        if (delay > 0) {
          await wait(delay);
        }
      }
    });
  }

  timeout<E2>({
    ms,
    onTimeout,
  }: {
    ms: number;
    onTimeout: (extras: Extras<C>) => E2;
  }): ResultFlow<A, E | E2, C> {
    return ResultFlow.of<A, E | E2, C>(async ({ fail, tryTo }, extras) => {
      const timeoutSignal = AbortSignal.timeout(ms);
      const timeoutSentinel = Symbol('ResultFlow.timeout');
      const abortSignal = extras.abortSignal
        ? AbortSignal.any([extras.abortSignal, timeoutSignal])
        : timeoutSignal;
      const nextExtras: Extras<C> = { ...extras, abortSignal };
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutSignal.addEventListener(
          'abort',
          () => reject(timeoutSentinel),
          { once: true },
        );
      });

      try {
        return await Promise.race([
          tryTo(this.run(nextExtras)),
          timeoutPromise,
        ]);
      } catch (error) {
        if (error === timeoutSentinel) {
          fail(onTimeout(nextExtras));
        }

        throw error;
      }
    });
  }

  runPeriodically<E2>(
    params: {
      recoveryAction?: (error: E, extras: Extras<C>) => PolymorphicResult<unknown, E2>;
      onInterruption?: (
        param: { cause: 'failure'; error: E; recoveryError: E2 | undefined } | { cause: 'aborted' },
      ) => void;
      interval: number;
      abortSignal?: AbortSignal;
    } & (keyof C extends never ? { context?: C } : { context: C })
  ): void {
    const { recoveryAction, onInterruption, interval, context = {} as C, abortSignal } = params;
    const extras: Extras<C> = abortSignal ? { context, abortSignal } : { context };

    const intervalId = setInterval(async () => {
      const result = await this.run(extras);
      if (result.isErr()) {
        let recoveryResult;
        if (recoveryAction) {
          const recoveryResultPromise = recoveryAction(result.error, extras);
          recoveryResult = await (ResultFlow.isResultFlow(recoveryResultPromise)
            ? recoveryResultPromise.run(extras)
            : recoveryResultPromise);
        }
        if (!recoveryResult || recoveryResult.isErr()) {
          clearInterval(intervalId);
          onInterruption?.({
            cause: 'failure',
            error: result.error,
            recoveryError: recoveryResult?.error,
          });
        }
      }
    }, interval);

    if (abortSignal) {
      abortSignal.addEventListener('abort', () => {
        clearInterval(intervalId);
        onInterruption?.({ cause: 'aborted' });
      });
    }
  }

  static gen<A, E, C extends BaseContext = DefaultContext>(f: ((extras: Extras<C>) => AsyncGenerator<ResultFlow<unknown, E, SubContext<C>> | ResultFlow<unknown, E, C> | Result<unknown, E> | ResultAsync<unknown, E>, A, unknown> )): ResultFlow<A, E, C> {
    return ResultFlow.of<A, E, C>(async ({ tryTo }, extras) => {
      const generator = f(extras);
      let result = await generator.next();
      while (!result.done) {
        const value = await (ResultFlow.isResultFlow<unknown, E, C | DefaultContext>(result.value) ? tryTo(result.value.run(extras)) : tryTo(result.value as Result<unknown, E> | ResultAsync<unknown, E>));
        result = await generator.next(value);
      }
      return result.value;
    });
  }

  *[Symbol.iterator](): Generator<ResultFlow<any, E, C>, A, any> {
		return yield this as any;
	}
}

export class ResultInterruption<E = unknown> extends Error {
  public readonly error: Err<any, E>;

  constructor(error: Err<any, E>) {
    super();

    this.name = "InternalError";
    this.error = error;

    // Fix the prototype (required for custom Error classes)
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
