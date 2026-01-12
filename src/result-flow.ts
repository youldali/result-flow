import * as N from 'neverthrow';
import type { Result, ResultAsync, Err } from 'neverthrow';
import * as PromiseHelpers from './promise-helpers';
import { calculateDelay, wait, type DelayStrategy } from './delay';

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

type PolymorphicResult<A, E, C extends BaseContext = DefaultContext> = ResultFlow<A, E, C> | Promise<Result<A, E>> | Result<A, E> | ResultAsync<A, E>;

type DefaultContext = Record<never, never>;
type BaseContext = Record<string, any>;
type SubContext<C> = { [K in keyof C]?: C[K] };
export class ResultFlow<A, E, C extends BaseContext = DefaultContext> {
  private constructor(private runPromise: (helpers: ResultFlowHelpers<E>, {context}: {context: C}) => Promise<A>) {}
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
  private context!: C;

  static of<A, E, C extends BaseContext = DefaultContext>(
    builderFunction: (helpers: ResultFlowHelpers<E>, extras: {context: C}) => Promise<A>,
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

  async run(
    ...args: keyof C extends never
      ? [] | [{ context: C }]
      : [{ context: C }]
  ): Promise<Result<A, E>> {
    const [{ context } = { context: {} as C }] = args;
    try {
      this.context = context;
      return N.ok(await this.runPromise(this.helpers, {context}));
    } catch (e: unknown) {
      if (e instanceof ResultInterruption) {
        return e.error;
      }
      throw e;
    }
  }

  map<A2>(f: (value: A, extras: { context: C }) => A2): ResultFlow<A2, E, C> {
    return ResultFlow.of<A2, E, C>(async ({tryTo}, extras) => {
      const value = await tryTo(this.run(extras));
      return f(value, extras);
    });
  }

  mapError<E2>(f: (value: E, extras: { context: C }) => E2): ResultFlow<A, E2, C> {
    return ResultFlow.of<A, E2, C>(async ({ fail }, extras) => {
      const result = await this.run(extras);
      if (result.isErr()) {
        fail(f(result.error, extras));
      }
      return (result as { value: A }).value;
    });
  }

  chain<A2, E2, C2 extends BaseContext = DefaultContext>(
    f: (value: A, extras: { context: C & C2 }) => PolymorphicResult<A2, E2, C2>,
  ): ResultFlow<A2, E | E2, C & C2> {
    return ResultFlow.of<A2, E | E2, C & C2>(async ({ tryTo }, extras) => {
      const result = await tryTo(this.run(extras));
      const fResult = f(result, extras);
      return ResultFlow.isResultFlow<A2, E2, C2>(fResult) ? tryTo(fResult.run(extras)) : tryTo(fResult);
    });
  }

  ifSuccess(f: (value: A, extras: { context: C }) => void): ResultFlow<A, E, C> {
    return ResultFlow.of<A, E, C>(async ({ tryTo }, {context}) => {
      const result = await tryTo(this.run({context}));
      f(result, { context });
      return result;
    });
  }

  ifFailure(f: (value: E, extras: { context: C }) => void): ResultFlow<A, E, C> {
    return ResultFlow.of<A, E, C>(async ({ fail }, extras) => {
      const result = await this.run(extras);
      if (result.isErr()) {
        f(result.error, extras);
        fail(result.error);
      }
      return (result as { value: A }).value;
    });
  }

  orElse<E2, C2 extends BaseContext = DefaultContext>(
    alternative: (error: E, extras: { context: C & C2 }) => PolymorphicResult<A, E2, C2>,
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

  retryPolicy({
    beforeRetry,
    condition = () => true,
    maxRetries = 1,
    retryStrategy = { type: "immediate" },
  }: {
    condition?: (error: E) => boolean;
    beforeRetry?: (error: E, retryNumber: number) => Promise<void> | void;
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
              await beforeRetry(result.error, i + 1);
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

  runPeriodically<E2>({
    recoveryAction,
    onInterruption,
    interval, // in ms
  }: {
    recoveryAction?: (error: E) => PolymorphicResult<unknown, E2>;
    onInterruption?: (
      param: { cause: 'failure'; error: E; recoveryError: E2 | undefined } | { cause: 'aborted' },
    ) => void;
    interval: number;
  }): { interrupt: () => void } {
    const intervalId = setInterval(async () => {
      const result = await this.run({context: this.context});
      if (result.isErr()) {
        let recoveryResult;
        if (recoveryAction) {
          const recoveryResultPromise = recoveryAction(result.error);
          recoveryResult = await (ResultFlow.isResultFlow(recoveryResultPromise)
            ? recoveryResultPromise.run({context: this.context})
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

    return {
      interrupt: () => {
        clearInterval(intervalId);
        onInterruption?.({ cause: 'aborted' });
      },
    };
  }
  static gen<A, E, C extends BaseContext = DefaultContext>(f: ((extras: { context: C }) => AsyncGenerator<ResultFlow<unknown, E, SubContext<C>> | ResultFlow<unknown, E, C> | Result<unknown, E> | ResultAsync<unknown, E>, A, unknown> )): ResultFlow<A, E, C> {
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