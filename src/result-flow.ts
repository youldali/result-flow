import * as N from 'neverthrow';
import type { Result, ResultAsync, Err } from 'neverthrow';
import * as PromiseHelpers from './promise-helpers.js';
import { calculateDelay, wait, type DelayStrategy } from './delay.js';
import type { IsAny, UnionToIntersection } from './typeHelper.js';

type DefaultContext = Record<never, never>;
type BaseContext = Record<string, any>;
type PolymorphicResult<A, E, C extends BaseContext = DefaultContext> = ResultFlow<A, E, C> | Promise<Result<A, E>> | Result<A, E> | ResultAsync<A, E>;

export interface ResultFlowHelpers<E, C extends BaseContext = DefaultContext> {
  tryTo<A>(result: PolymorphicResult<A, E, C>): Promise<A>;
  tryTo<A, E2>(
    result: PolymorphicResult<A, E2, C>,
    options: {
      mapError: (value: E2) => E;
    },
  ): Promise<A>;
  tryToOrRecover<A, A2>(
    result: PolymorphicResult<A, E, C>,
    fallback: (error: E) => A2 | Promise<A2>,
  ): Promise<A | A2>;
  tryToOrElse<A>(
    result: PolymorphicResult<A, E, C>,
    fallback: (error: E) => PolymorphicResult<A, E, C>,
  ): Promise<A>;
  fail(error: E): never;
  promiseHelpers: PromiseHelpers.PromiseHelpers;
}

export interface ResultFlowGenHelpers<E, C extends BaseContext = DefaultContext> {
  orRecover<A, E2, A2>(
    result: PolymorphicResult<A, E2, C>,
    fallback: (error: E2, extras: ResultFlowExtras<C>) => A2 | Promise<A2>,
  ): ResultFlow<A | A2, never, C>;
  orElse<A, E2, E3>(
    result: PolymorphicResult<A, E2, C>,
    fallback: (error: E2, extras: ResultFlowExtras<C>) => PolymorphicResult<A, E3, C>,
  ): ResultFlow<A, E3, C>;
  fail(error: E): never;
}

const unwrap = <A, E>(result: Result<A, E>): A => {
  if (result.isOk()) {
    return result.value;
  }

  throw new ResultInterruption(result);
};

// RunParams is the public caller input. Extras is the normalized runtime shape
// passed to flow callbacks, so context is always present there.
export type ResultFlowExtras<C extends BaseContext = DefaultContext> = { context: C; abortSignal?: AbortSignal; };
export type ResultFlowRunParams<C extends BaseContext = DefaultContext> =
  { abortSignal?: AbortSignal } & (keyof C extends never ? { context?: C } : { context: C });
type YieldableResultFlow<A, E, C extends BaseContext> = {
  run(
    ...args: keyof C extends never
      ? [] | [ResultFlowRunParams<C>]
      : [ResultFlowRunParams<C>]
  ): Promise<Result<A, E>>;
};
type AnyYieldableResultFlow = YieldableResultFlow<any, any, any>;
type FlowSuccess<F> = F extends YieldableResultFlow<infer A, any, any> ? A : never;
type FlowError<F> = F extends YieldableResultFlow<any, infer E, any> ? E : never;
type FlowContext<F> = F extends YieldableResultFlow<any, any, infer C> ? C : never;
type FlowSuccesses<Flows extends readonly AnyYieldableResultFlow[]> = FlowSuccess<Flows[number]>;
type FlowErrors<Flows extends readonly AnyYieldableResultFlow[]> = FlowError<Flows[number]>;
type FlowErrorArray<Flows extends readonly AnyYieldableResultFlow[]> = FlowErrors<Flows>[];
type FlowResult<F> = F extends YieldableResultFlow<infer A, infer E, any> ? Result<A, E> : never;
type NormalizeContext<C> = IsAny<C> extends true
  ? DefaultContext
  : C extends BaseContext
    ? C
    : DefaultContext;
type FlowContexts<Flows extends readonly AnyYieldableResultFlow[]> = NormalizeContext<
  UnionToIntersection<FlowContext<Flows[number]>>
>;
type FlowValues<Flows extends readonly AnyYieldableResultFlow[]> = {
  [K in keyof Flows]: FlowSuccess<Flows[K]>;
};
type FlowResults<Flows extends readonly AnyYieldableResultFlow[]> = {
  [K in keyof Flows]: FlowResult<Flows[K]>;
};

export class ResultFlow<A, E, C extends BaseContext = DefaultContext> {
  private constructor(private runPromise: (helpers: ResultFlowHelpers<E, C>, extras: ResultFlowExtras<C>) => Promise<A>) {}

  private static buildExtras<C extends BaseContext>(
    ...args: keyof C extends never
      ? [] | [ResultFlowRunParams<C>]
      : [ResultFlowRunParams<C>]
  ): ResultFlowExtras<C> {
    const [{ context = {} as C, abortSignal } = {} as ResultFlowRunParams<C>] = args;
    return abortSignal ? { context, abortSignal } : { context };
  }

  private buildHelpers(extras: ResultFlowExtras<C>): ResultFlowHelpers<E, C> {
    const resolvePolymorphicResult = <A1, E2>(
      result: PolymorphicResult<A1, E2, C>,
    ): Promise<Result<A1, E2>> => {
      return ResultFlow.isResultFlow<A1, E2>(result)
        ? result.run(extras)
        : Promise.resolve(result as Result<A1, E2> | Promise<Result<A1, E2>> | ResultAsync<A1, E2>);
    };

    return {
      tryTo<A1, E2>(
        result: PolymorphicResult<A1, E2, C>,
        options?: {
          mapError?: (value: E2) => E;
        },
      ): Promise<A1> {
        const resolvedResult = resolvePolymorphicResult(result);

        return options?.mapError
          ? PromiseHelpers.mapError(resolvedResult, options.mapError).then(unwrap)
          : resolvedResult.then(unwrap);
      },
      async tryToOrRecover<A1, A2>(
        result: PolymorphicResult<A1, E, C>,
        fallback: (error: E) => A2 | Promise<A2>,
      ): Promise<A1 | A2> {
        const resolvedResult = await resolvePolymorphicResult(result);

        if (resolvedResult.isOk()) {
          return resolvedResult.value;
        }

        return fallback(resolvedResult.error);
      },
      async tryToOrElse<A1>(
        result: PolymorphicResult<A1, E, C>,
        fallback: (error: E) => PolymorphicResult<A1, E, C>,
      ): Promise<A1> {
        const resolvedResult = await resolvePolymorphicResult(result);

        if (resolvedResult.isOk()) {
          return resolvedResult.value;
        }

        return unwrap(await resolvePolymorphicResult(fallback(resolvedResult.error)));
      },
      fail(error: E): never {
        // eslint-disable-next-line @spendesk/must-use-result
        const resultError = N.err(error);
        throw new ResultInterruption(resultError);
      },
      promiseHelpers: PromiseHelpers,
    };
  }

  private static buildGenHelpers<E, C extends BaseContext>(): ResultFlowGenHelpers<E, C> {
    return {
      orRecover<A, E2, A2>(
        result: PolymorphicResult<A, E2, C>,
        fallback: (error: E2, extras: ResultFlowExtras<C>) => A2 | Promise<A2>,
      ): ResultFlow<A | A2, never, C> {
        return ResultFlow.isResultFlow<A, E2, C>(result)
          ? result.recover(fallback)
          : ResultFlow.from<A, E2, C>(result).recover(fallback);
      },
      orElse<A, E2, E3>(
        result: PolymorphicResult<A, E2, C>,
        fallback: (error: E2, extras: ResultFlowExtras<C>) => PolymorphicResult<A, E3, C>,
      ): ResultFlow<A, E3, C> {
        return ResultFlow.isResultFlow<A, E2, C>(result)
          ? result.orElse(fallback)
          : ResultFlow.from<A, E2, C>(result).orElse(fallback);
      },
      fail(error: E): never {
        // eslint-disable-next-line @spendesk/must-use-result
        const resultError = N.err(error);
        throw new ResultInterruption(resultError);
      },
    };
  }

  static of<A, E, C extends BaseContext = DefaultContext>(
    builderFunction: (helpers: ResultFlowHelpers<E, C>, extras: ResultFlowExtras<C>) => Promise<A>,
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

  static all<const Flows extends readonly AnyYieldableResultFlow[]>(
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
      const flowsToRun = flows as readonly YieldableResultFlow<
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

  static allSettled<const Flows extends readonly AnyYieldableResultFlow[]>(
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
      const flowsToRun = flows as readonly YieldableResultFlow<
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

  static firstOk<const Flows extends readonly AnyYieldableResultFlow[]>(
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
      const flowsToRun = flows as readonly YieldableResultFlow<
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

  static race<const Flows extends readonly AnyYieldableResultFlow[]>(
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

      const flowsToRun = flows as readonly YieldableResultFlow<
        FlowSuccesses<Flows>,
        FlowErrors<Flows>,
        FlowContexts<Flows>
      >[];

      return tryTo(Promise.race(flowsToRun.map((flow) => flow.run(extras))));
    });
  }

  async run(
    ...args: keyof C extends never
      ? [] | [ResultFlowRunParams<C>]
      : [ResultFlowRunParams<C>]
  ): Promise<Result<A, E>> {
    const extras = ResultFlow.buildExtras<C>(...args);

    return this.executeWithExtras(extras);
  }

  async runAndMatch<B>(
    handlers: {
      ok: (value: A, extras: ResultFlowExtras<C>) => B | Promise<B>;
      err: (error: E, extras: ResultFlowExtras<C>) => B | Promise<B>;
    },
    ...args: keyof C extends never
      ? [] | [ResultFlowRunParams<C>]
      : [ResultFlowRunParams<C>]
  ): Promise<B> {
    const extras = ResultFlow.buildExtras<C>(...args);
    const result = await this.executeWithExtras(extras);

    if (result.isOk()) {
      return handlers.ok(result.value, extras);
    }

    return handlers.err(result.error, extras);
  }

  private async executeWithExtras(extras: ResultFlowExtras<C>): Promise<Result<A, E>> {
    try {
      return N.ok(await this.runPromise(this.buildHelpers(extras), extras));
    } catch (e: unknown) {
      if (e instanceof ResultInterruption) {
        return e.error;
      }
      throw e;
    }
  }

  map<A2>(f: (value: A, extras: ResultFlowExtras<C>) => A2): ResultFlow<A2, E, C> {
    return ResultFlow.of<A2, E, C>(async ({tryTo}, extras) => {
      const value = await tryTo(this.run(extras));
      return f(value, extras);
    });
  }

  mapBoth<A2, E2>(
    handlers: {
      ok: (value: A, extras: ResultFlowExtras<C>) => A2;
      err: (error: E, extras: ResultFlowExtras<C>) => E2;
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
    predicate: (value: A, extras: ResultFlowExtras<C>) => boolean | Promise<boolean>,
    onFailure: (value: A, extras: ResultFlowExtras<C>) => E2 | Promise<E2>,
  ): ResultFlow<A, E | E2, C> {
    return ResultFlow.of<A, E | E2, C>(async ({ fail, tryTo }, extras) => {
      const value = await tryTo(this.run(extras));
      if (await predicate(value, extras)) {
        return value;
      }

      return fail(await onFailure(value, extras));
    });
  }

  mapError<E2>(f: (value: E, extras: ResultFlowExtras<C>) => E2): ResultFlow<A, E2, C> {
    return ResultFlow.of<A, E2, C>(async ({ fail }, extras) => {
      const result = await this.run(extras);
      if (result.isErr()) {
        fail(f(result.error, extras));
      }
      return (result as { value: A }).value;
    });
  }

  chain<A2, E2, C2 extends BaseContext = DefaultContext>(
    f: (value: A, extras: ResultFlowExtras<C & C2>) => PolymorphicResult<A2, E2, C2>,
  ): ResultFlow<A2, E | E2, C & C2> {
    return ResultFlow.of<A2, E | E2, C & C2>(async ({ tryTo }, extras) => {
      const result = await tryTo(this.run(extras));
      const fResult = f(result, extras);
      return ResultFlow.isResultFlow<A2, E2, C2>(fResult) ? tryTo(fResult.run(extras)) : tryTo(fResult);
    });
  }

  ifSuccess(f: (value: A, extras: ResultFlowExtras<C>) => void | Promise<void>): ResultFlow<A, E, C> {
    return ResultFlow.of<A, E, C>(async ({ tryTo }, extras) => {
      const result = await tryTo(this.run(extras));
      await f(result, extras);
      return result;
    });
  }

  tap(f: (value: A, extras: ResultFlowExtras<C>) => void | Promise<void>): ResultFlow<A, E, C> {
    return this.ifSuccess(f);
  }

  ifFailure(f: (value: E, extras: ResultFlowExtras<C>) => void | Promise<void>): ResultFlow<A, E, C> {
    return ResultFlow.of<A, E, C>(async ({ fail }, extras) => {
      const result = await this.run(extras);
      if (result.isErr()) {
        await f(result.error, extras);
        fail(result.error);
      }
      return (result as N.Ok<A, E>).value;
    });
  }

  tapError(f: (value: E, extras: ResultFlowExtras<C>) => void | Promise<void>): ResultFlow<A, E, C> {
    return this.ifFailure(f);
  }

  finally(
    effect: (extras: ResultFlowExtras<C>) => void | Promise<void>,
  ): ResultFlow<A, E, C> {
    return ResultFlow.of<A, E, C>(async ({ tryTo }, extras) => {
      try {
        return await tryTo(this.run(extras));
      } finally {
        await effect(extras);
      }
    });
  }

  tapBoth(
    effect: (result: Result<A, E>, extras: ResultFlowExtras<C>) => void | Promise<void>,
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

  catch<A2 = never, E2 = never>(
    handler: (cause: unknown, extras: ResultFlowExtras<C>) => PolymorphicResult<A2, E2, C>,
  ): ResultFlow<A | A2, E | E2, C> {
    return ResultFlow.of<A | A2, E | E2, C>(async ({ tryTo }, extras) => {
      let result: Result<A | A2, E | E2>;
      try {
        result = await this.executeWithExtras(extras);
      } catch (cause: unknown) {
        const handlerResult = handler(cause, extras);
        result = await (ResultFlow.isResultFlow<A2, E2, C>(handlerResult)
          ? handlerResult.run(extras)
          : handlerResult);
      }

      return tryTo(result);
    });
  }

  orElse<E2, C2 extends BaseContext = DefaultContext>(
    alternative: (error: E, extras: ResultFlowExtras<C & C2>) => PolymorphicResult<A, E2, C2>,
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
    f: (error: E, extras: ResultFlowExtras<C>) => A2 | Promise<A2>,
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
    beforeRetry?: (error: E, retryNumber: number, extras: ResultFlowExtras<C>) => Promise<void> | void;
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
    predicate: (value: A, extras: ResultFlowExtras<C>) => boolean | Promise<boolean>;
    onExhausted: (lastValue: A, extras: ResultFlowExtras<C>) => E2 | Promise<E2>;
    maxRepeats?: number;
    delayStrategy?: DelayStrategy;
    beforeRepeat?: (value: A, repeatNumber: number, extras: ResultFlowExtras<C>) => void | Promise<void>;
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
    onTimeout: (extras: ResultFlowExtras<C>) => E2;
  }): ResultFlow<A, E | E2, C> {
    return ResultFlow.of<A, E | E2, C>(async ({ fail, tryTo }, extras) => {
      const timeoutSignal = AbortSignal.timeout(ms);
      const timeoutSentinel = Symbol('ResultFlow.timeout');
      const abortSignal = extras.abortSignal
        ? AbortSignal.any([extras.abortSignal, timeoutSignal])
        : timeoutSignal;
      const nextExtras: ResultFlowExtras<C> = { ...extras, abortSignal };
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
      recoveryAction?: (error: E, extras: ResultFlowExtras<C>) => PolymorphicResult<unknown, E2>;
      onInterruption?: (
        param: { cause: 'failure'; error: E; recoveryError: E2 | undefined } | { cause: 'aborted' },
      ) => void;
      interval: number;
      abortSignal?: AbortSignal;
    } & (keyof C extends never ? { context?: C } : { context: C })
  ): void {
    const { recoveryAction, onInterruption, interval, context = {} as C, abortSignal } = params;
    const extras: ResultFlowExtras<C> = abortSignal ? { context, abortSignal } : { context };

    const intervalId = setInterval(async () => {
      const result = await this.run(extras);
      if (result.isErr()) {
        let recoveryResult: Result<unknown, E2> | undefined;
        if (recoveryAction) {
          const recoveryResultPromise = recoveryAction(result.error, extras);
          recoveryResult = await (ResultFlow.isResultFlow<unknown, E2>(recoveryResultPromise)
            ? recoveryResultPromise.run(extras)
            : recoveryResultPromise as Result<unknown, E2> | Promise<Result<unknown, E2>> | ResultAsync<unknown, E2>);
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

  static gen<A, E, C extends BaseContext = DefaultContext>(f: ((helpers: ResultFlowGenHelpers<E, C>, extras: ResultFlowExtras<C>) => AsyncGenerator<YieldableResultFlow<any, E, C> | Result<any, E> | ResultAsync<any, E>, A, any> )): ResultFlow<A, E, C> {
    return ResultFlow.of<A, E, C>(async ({ tryTo }, extras) => {
      const generator = f(ResultFlow.buildGenHelpers<E, C>(), extras);
      let result = await generator.next();
      while (!result.done) {
        const value = await (ResultFlow.isResultFlow<any, E, C | DefaultContext>(result.value) ? tryTo(result.value.run(extras)) : tryTo(result.value as Result<any, E> | ResultAsync<any, E>));
        result = await generator.next(value);
      }
      return result.value;
    });
  }

  *[Symbol.iterator](): Generator<YieldableResultFlow<any, E, C>, A, any> {
		return yield this as any;
	}
}

class ResultInterruption<E = unknown> extends Error {
  public readonly error: Err<any, E>;

  constructor(error: Err<any, E>) {
    super();

    this.name = "InternalError";
    this.error = error;

    // Fix the prototype (required for custom Error classes)
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
