import * as N from 'neverthrow';
import type { Result, ResultAsync, Err } from 'neverthrow';
import * as PromiseHelpers from './promise-helpers';

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

export class ResultFlow<A, E> {
  private constructor(private runPromise: (helpers: ResultFlowHelpers<E>) => Promise<A>) {}
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

  static of<A, E>(
    builderFunction: (helpers: ResultFlowHelpers<E>) => Promise<A>,
  ): ResultFlow<A, E> {
    return new ResultFlow<A, E>(builderFunction);
  }

  static isResultFlow(value: unknown): value is ResultFlow<unknown, unknown> {
    return value instanceof ResultFlow;
  }

  static from<A, E>(
    value:
      | Promise<Result<A, E>>
      | Result<A, E>
      | ResultAsync<A, E>
      | (() => Promise<Result<A, E>>)
      | (() => Result<A, E>)
      | (() => ResultAsync<A, E>),
  ): ResultFlow<A, E> {
    return ResultFlow.of<A, E>(async ({ tryTo }) => {
      return typeof value === 'function' ? tryTo(value()) : tryTo(value);
    });
  }

  static lift<A, E>(
    value:
      | Promise<Result<A, E>>
      | Result<A, E>
      | ResultAsync<A, E>
      | (() => Promise<Result<A, E>>)
      | (() => Result<A, E>)
      | (() => ResultAsync<A, E>),
  ): ResultFlow<A, E> {
    return ResultFlow.from(value);
  }

  async run(): Promise<Result<A, E>> {
    try {
      return N.ok(await this.runPromise(this.helpers));
    } catch (e: unknown) {
      if (e instanceof ResultInterruption) {
        return e.error;
      }
      throw e;
    }
  }

  map<A2>(f: (value: A) => A2): ResultFlow<A2, E> {
    return ResultFlow.of<A2, E>(() => {
      return this.runPromise(this.helpers).then(f);
    });
  }

  mapError<E2>(f: (value: E) => E2): ResultFlow<A, E2> {
    return ResultFlow.of<A, E2>(async ({ fail }) => {
      const result = await this.run();
      if (result.isErr()) {
        fail(f(result.error));
      }
      return (result as { value: A }).value;
    });
  }

  chain<A2, E2>(
    f: (value: A) => ResultFlow<A2, E2> | Promise<Result<A2, E2>> | Result<A2, E2>,
  ): ResultFlow<A2, E | E2> {
    return ResultFlow.of<A2, E | E2>(async ({ tryTo }) => {
      const result = await tryTo(this.run());
      const fResult = f(result);
      return ResultFlow.isResultFlow(fResult) ? tryTo(fResult.run()) : tryTo(fResult);
    });
  }

  ifSuccess(f: (value: A) => void): ResultFlow<A, E> {
    return ResultFlow.of<A, E>(async ({ tryTo }) => {
      const result = await tryTo(this.run());
      f(result);
      return result;
    });
  }

  ifFailure(f: (value: E) => void): ResultFlow<A, E> {
    return ResultFlow.of<A, E>(async ({ fail }) => {
      const result = await this.run();
      if (result.isErr()) {
        f(result.error);
        fail(result.error);
      }
      return (result as { value: A }).value;
    });
  }

  orElse<E2>(
    alternative: (error: E) => ResultFlow<A, E2> | Promise<Result<A, E2>> | Result<A, E2>,
  ): ResultFlow<A, E2> {
    return ResultFlow.of<A, E2>(async ({ tryTo }) => {
      const result = await this.run();
      if (result.isOk()) {
        return result.value;
      }

      const alternativeResult = alternative(result.error);
      return ResultFlow.isResultFlow(alternativeResult)
        ? tryTo(alternativeResult.run())
        : tryTo(alternativeResult);
    });
  }

  retryPolicy({
    beforeRetry,
    condition = () => true,
    maxRetries = 1,
  }: {
    condition?: (error: E) => boolean;
    beforeRetry?: (error: E, retryNumber: number) => Promise<void> | void;
    maxRetries?: number;
  } = {}): ResultFlow<A, E> {
    return ResultFlow.of<A, E>(async ({ fail, tryTo }) => {
      for (let i = 0; i < maxRetries; i++) {
        const result = await this.run();
        if (result.isErr()) {
          const shouldRetry = condition(result.error);
          if (shouldRetry) {
            if (beforeRetry) {
              await beforeRetry(result.error, i + 1);
            }
            continue;
          } else {
            return fail(result.error);
          }
        }
        return result.value;
      }
      return tryTo(this.run());
    });
  }

  runPeriodically<E2>({
    recoveryAction,
    onInterruption,
    interval, // in ms
  }: {
    recoveryAction?: (error: E) => Promise<Result<unknown, E2>> | ResultFlow<unknown, E2>;
    onInterruption?: (
      param: { cause: 'failure'; error: E; recoveryError: E2 | undefined } | { cause: 'aborted' },
    ) => void;
    interval: number;
  }): { interrupt: () => void } {
    const intervalId = setInterval(async () => {
      const result = await this.run();
      if (result.isErr()) {
        let recoveryResult;
        if (recoveryAction) {
          const recoveryResultPromise = recoveryAction(result.error);
          recoveryResult = await (ResultFlow.isResultFlow(recoveryResultPromise)
            ? recoveryResultPromise.run()
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

  // static gen<E, A>(f: (() => AsyncGenerator<ResultFlow<E, any>, A, any>  )): ResultFlow<E, A> {
  //   return ResultFlow.of<E, A>(async ({ tryTo }) => {
  //     const generator = f();
  //     let result = await generator.next();
  //     console.log('>> result: ', result);
  //     while (!result.done) {
  //       const value = await (ResultFlow.isResultFlow(result.value) ? tryTo(result.value.run()) : tryTo(result.value));
  //       console.log('>> value: ', value);
  //       result = await generator.next(value);
  //     }
  //     console.log('>> final result: ', result);
  //     return result.value as unknown as A;
  //   });
  // }

  *[Symbol.iterator](): Generator<ResultFlow<any, E>, A, any> {
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