import { deepEqual, rejects } from 'node:assert';

import { describe, it, mock, type Mock, type TestContext } from 'node:test';
import * as N from 'neverthrow';
import { Result, ResultAsync } from 'neverthrow';
import { ResultFlow } from './result-flow';

type Row = {
  id: number;
  name: string;
};

type FindByIdFailure = { reason: 'not-found'; operation: 'findById' };
type UpdateByIdFailure = { reason: 'not-found'; operation: 'updateById' };

const dbMock = [{ id: 1, name: 'test' }] as Row[];
async function findById(id: number): Promise<Result<Row, FindByIdFailure>> {
  if (id === -1) {
    throw new Error('index cannot be negative');
  }
  const row = dbMock.find((r) => r.id === id);
  return row ? N.ok(row) : N.err({ reason: 'not-found', operation: 'findById' });
}
async function updateById(
  id: number,
  payload: Omit<Row, 'id'>,
): Promise<Result<Row, UpdateByIdFailure>> {
  const row = dbMock.find((r) => r.id === id);
  return row
    ? N.ok({ ...row, ...payload })
    : N.err({ reason: 'not-found', operation: 'updateById' });
}

// domain function
type ValidateFailure = { reason: 'invalid-data'; operation: 'validate' };
const validate = (row: Row, isValid: boolean): Result<Row, ValidateFailure> => {
  return isValid
    ? N.ok(row)
    : N.err({ reason: 'invalid-data', operation: 'validate' });
};

type FlowFailure = FindByIdFailure | UpdateByIdFailure | ValidateFailure;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const advanceToNextTick = async (context: TestContext) => {
  context.mock.timers.runAll();
  await sleep(0);
};

describe('ResultFlow', () => {
  describe('run', () => {
    it('should successfully run the whole flow when all the functions return a success result', async () => {
      const resultFlow = ResultFlow.of<Row, FlowFailure>(async ({ tryTo }) => {
        const row = await tryTo(findById(1));
        await tryTo(validate(row, true));
        return tryTo(updateById(row.id, { name: 'updated-name' }));
      });

      const result = await resultFlow.run();
      const value = result._unsafeUnwrap();
      deepEqual(value, { id: 1, name: 'updated-name' });
    });

    it('should successfully run the whole flow when all the functions return a success result (chain variant)', async () => {
      const result = await ResultFlow.from(findById(1))
        .chain((row) => validate(row, true))
        .chain((row) => updateById(row.id, { name: 'updated-name' }))
        .run();

      const value = result._unsafeUnwrap();
      deepEqual(value, { id: 1, name: 'updated-name' });
    });

    it('should successfully run the whole flow with tryTo options', async () => {
      const resultFlow = ResultFlow.of<Row, { kind: 'flow-error'; cause: FlowFailure }>(
        async ({ tryTo }) => {
          const row = await tryTo(findById(1), {
            mapError: (error) => ({ kind: 'flow-error', cause: error }),
          });
          await tryTo(validate(row, true), {
            mapError: (error) => ({ kind: 'flow-error', cause: error }),
          });
          return tryTo(updateById(row.id, { name: 'updated-name' }), {
            mapError: (error) => ({ kind: 'flow-error', cause: error }),
          });
        },
      );

      const result = await resultFlow.run();
      const value = result._unsafeUnwrap();
      deepEqual(value, { id: 1, name: 'updated-name' });
    });

    it('should return a failure as soon as a function return a failure result', async () => {
      const mockFn = mock.fn();
      const resultFlow = ResultFlow.of<Row, FlowFailure>(async ({ tryTo }) => {
        // the following operation fails
        const row = await tryTo(findById(2));
        mockFn();
        await tryTo(validate(row, true));
        return tryTo(updateById(1, { name: 'updated' }));
      });

      const result = await resultFlow.run();
      const value = result._unsafeUnwrapErr();
      deepEqual(value, { reason: 'not-found', operation: 'findById' });
      deepEqual(mockFn.mock.callCount(), 0);
    });

    it('should return a failure as soon as a function return a failure result (chain variant)', async () => {
      const mockFn = mock.fn();
      const result = await ResultFlow.from(findById(2))
        .chain((row) => {
          mockFn();
          return validate(row, true);
        })
        .chain((row) => updateById(row.id, { name: 'updated-name' }))
        .run();

      const value = result._unsafeUnwrapErr();
      deepEqual(value, { reason: 'not-found', operation: 'findById' });
      deepEqual(mockFn.mock.callCount(), 0);
    });

    it('should return a rejected promise if a function throws', async () => {
      const resultFlow = ResultFlow.of<string, FlowFailure>(async ({ tryTo }) => {
        await tryTo(Promise.reject(new Error('error description')));
        return 'ok';
      });

      await rejects(async () => resultFlow.run(), /error description/);
    });

    it('allows to implement custom logic on a result', async () => {
      const resultFlow = ResultFlow.of<Row, FlowFailure>(async () => {
        let row: Row;
        const rowResult = await findById(2);
        if (rowResult.isErr()) {
          row = { id: 0, name: 'default' };
        } else {
          row = rowResult.value;
        }
        return row;
      });

      const result = await resultFlow.run();
      const value = result._unsafeUnwrap();
      deepEqual(value, { id: 0, name: 'default' });
    });

    it('should return a failure result if the `fail` helper is called', async () => {
      const mockFn = mock.fn();
      const resultFlow = ResultFlow.of<string, { reason: 'early-fail' }>(async ({ fail }) => {
        fail({ reason: 'early-fail' });
        mockFn();
        return 'ok';
      });

      const result = await resultFlow.run();
      const value = result._unsafeUnwrapErr();
      deepEqual(value, { reason: 'early-fail' });
      deepEqual(mockFn.mock.callCount(), 0);
    });

    it('should be immutable', async () => {
      let counter = 0;
      const r1 = ResultFlow.from(N.ok(10));
      await r1.run();
      const r2 = r1.ifSuccess(() => counter++);
      await r1.run();
      deepEqual(counter, 0);

      await r2.run();
      await r2.run();
      deepEqual(counter, 2);
    });
  });

  describe('from', () => {
    it('should lift the Result<A, E> into a `ResultFlow`', async () => {
      const resultFlow = ResultFlow.from(N.ok(10));
      const value = await resultFlow.run();
      deepEqual(value._unsafeUnwrap(), 10);
    });

    it('should lift the () => Result<A, E> into a `ResultFlow`', async () => {
      const resultFlow = ResultFlow.from(() => N.ok(10));
      const value = await resultFlow.run();
      deepEqual(value._unsafeUnwrap(), 10);
    });

    it('should lift the ResultAsync<A, E> into a `ResultFlow`', async () => {
      const resultFlow = ResultFlow.from(N.okAsync(10));
      const value = await resultFlow.run();
      deepEqual(value._unsafeUnwrap(), 10);
    });

    it('should lift the () => ResultAsync<A, E> into a `ResultFlow`', async () => {
      const resultFlow = ResultFlow.from(() => N.okAsync(10));
      const value = await resultFlow.run();
      deepEqual(value._unsafeUnwrap(), 10);
    });

    it('should lift the Promise<Result<A, E>> into a `ResultFlow`', async () => {
      const resultFlow = ResultFlow.from(Promise.resolve(N.ok(10)));
      const value = await resultFlow.run();
      deepEqual(value._unsafeUnwrap(), 10);
    });

    it('should lift the () => Promise<Result<A, E>> into a `ResultFlow`', async () => {
      const resultFlow = ResultFlow.from(() => Promise.resolve(N.ok(10)));
      const value = await resultFlow.run();
      deepEqual(value._unsafeUnwrap(), 10);
    });
  });

  describe('lift', () => {
    it('should lift the Result<A, E> into a `ResultFlow`', async () => {
      const resultFlow = ResultFlow.lift(N.ok(10));
      const value = await resultFlow.run();
      deepEqual(value._unsafeUnwrap(), 10);
    });

    it('should lift the () => Result<A, E> into a `ResultFlow`', async () => {
      const resultFlow = ResultFlow.lift(() => N.ok(10));
      const value = await resultFlow.run();
      deepEqual(value._unsafeUnwrap(), 10);
    });

    it('should lift the ResultAsync<A, E> into a `ResultFlow`', async () => {
      const resultFlow = ResultFlow.lift(N.okAsync(10));
      const value = await resultFlow.run();
      deepEqual(value._unsafeUnwrap(), 10);
    });

    it('should lift the () => ResultAsync<A, E> into a `ResultFlow`', async () => {
      const resultFlow = ResultFlow.lift(() => N.okAsync(10));
      const value = await resultFlow.run();
      deepEqual(value._unsafeUnwrap(), 10);
    });

    it('should lift the Promise<Result<A, E>> into a `ResultFlow`', async () => {
      const resultFlow = ResultFlow.lift(Promise.resolve(N.ok(10)));
      const value = await resultFlow.run();
      deepEqual(value._unsafeUnwrap(), 10);
    });

    it('should lift the () => Promise<Result<A, E>> into a `ResultFlow`', async () => {
      const resultFlow = ResultFlow.lift(() => Promise.resolve(N.ok(10)));
      const value = await resultFlow.run();
      deepEqual(value._unsafeUnwrap(), 10);
    });
  });

  describe('isResultFlow', () => {
    it('should return `false` when passed undefined', async () => {
      const isResultFlow = ResultFlow.isResultFlow(undefined);
      deepEqual(isResultFlow, false);
    });

    it('should return `false` when passed an object', async () => {
      const isResultFlow = ResultFlow.isResultFlow({});
      deepEqual(isResultFlow, false);
    });

    it('should return true when passed a `ResultFlow`', async () => {
      const isResultFlow = ResultFlow.isResultFlow(ResultFlow.from(N.ok(10)));
      deepEqual(isResultFlow, true);
    });
  });

  describe('map', () => {
    it('should map the function over the result when it is a success', async () => {
      const resultFlow = ResultFlow.of<number, never>(async () => {
        return 10;
      });
      const add10 = (n: number) => n + 10;
      const result = await resultFlow.map(add10).run();
      const value = result._unsafeUnwrap();
      deepEqual(value, 20);
    });

    it('should do nothing when the result value is a failure', async () => {
      const resultFlow = ResultFlow.of<number, 'error'>(async ({ fail }) => {
        fail('error');
        return 10;
      });
      const mapFunction = mock.fn();
      const result = await resultFlow.map(mapFunction).run();

      const value = result._unsafeUnwrapErr();
      deepEqual(value, 'error');
      deepEqual(mapFunction.mock.callCount(), 0);
    });

    it('should be immutable', async () => {
      const r1 = ResultFlow.from(N.ok(10));
      const r2 = r1.map((n) => n + 10);

      deepEqual((await r1.run())._unsafeUnwrap(), 10);
      deepEqual((await r2.run())._unsafeUnwrap(), 20);
    });
  });

  describe('mapError', () => {
    it('should map the function over the error when it is a failure', async () => {
      const resultFlow = ResultFlow.of<number, string>(async ({ fail }) => {
        fail('error');
        return 10;
      });
      const transformError = (error: string) => `transformed-${error}`;
      const result = await resultFlow.mapError(transformError).run();
      const value = result._unsafeUnwrapErr();
      deepEqual(value, 'transformed-error');
    });

    it('should do nothing when the result value is a success', async () => {
      const resultFlow = ResultFlow.of<number, 'error'>(async () => {
        return 10;
      });
      const mapErrorFunction = mock.fn();
      const result = await resultFlow.mapError(mapErrorFunction).run();

      const value = result._unsafeUnwrap();
      deepEqual(value, 10);
      deepEqual(mapErrorFunction.mock.callCount(), 0);
    });

    it('should be immutable', async () => {
      const r1 = ResultFlow.from(N.err('error'));
      const r2 = r1.mapError((error) => `${error} - transformed`);

      deepEqual(await r1.run(), N.err('error'));
      deepEqual(await r2.run(), N.err('error - transformed'));
    });
  });

  describe('chain', () => {
    it('should run the function that returns a `ResultFlow` over the result when it is a success', async () => {
      const add10 = (n: number) => ResultFlow.of<number, never>(async () => n + 10);

      const result = await ResultFlow.from(N.ok(10)).chain(add10).run();
      const value = result._unsafeUnwrap();
      deepEqual(value, 20);
    });

    it('should run the function that returns a `Promise<Result<A, E>>` over the result when it is a success', async () => {
      const add10 = (n: number) => Promise.resolve(N.ok(n + 10));
      const result = await ResultFlow.from(N.ok(10)).chain(add10).run();
      const value = result._unsafeUnwrap();
      deepEqual(value, 20);
    });

    it('should run the function that returns a `Result<A, E>` over the result when it is a success', async () => {
      const add10 = (n: number) => N.ok(n + 10);
      const result = await ResultFlow.from(N.ok(10)).chain(add10).run();

      const value = result._unsafeUnwrap();
      deepEqual(value, 20);
    });

    it('should run the function that returns a `ResultAsync<A, E>` over the result when it is a success', async () => {
      const add10 = (n: number) => N.okAsync(n + 10);
      const result = await ResultFlow.from(N.ok(10)).chain(add10).run();

      const value = result._unsafeUnwrap();
      deepEqual(value, 20);
    });

    it('should do nothing when the result value is a failure', async () => {
      const resultFlow = ResultFlow.of<number, 'error'>(async ({ fail }) => {
        fail('error');
        return 10;
      });
      const mockFn = mock.fn();
      const add10 = (n: number) =>
        ResultFlow.of<number, never>(async () => {
          mockFn();
          return n + 10;
        });
      const result = await resultFlow.chain(add10).run();

      const value = result._unsafeUnwrapErr();
      deepEqual(value, 'error');
      deepEqual(mockFn.mock.callCount(), 0);
    });

    it('should be immutable', async () => {
      const r1 = ResultFlow.from(N.ok(10));
      // eslint-disable-next-line promise/prefer-await-to-then
      const r2 = r1.chain((n) => N.ok(n + 10));

      deepEqual((await r1.run())._unsafeUnwrap(), 10);
      deepEqual((await r2.run())._unsafeUnwrap(), 20);
    });
  });

  describe('ifSuccess', () => {
    it('should execute the effect when it is a success', async () => {
      const resultFlow = ResultFlow.of<number, never>(async () => {
        return 10;
      });
      const effect = mock.fn();
      const result = await resultFlow.ifSuccess(effect).run();
      const value = result._unsafeUnwrap();

      deepEqual(effect.mock.calls[0]?.arguments, [10]);
      deepEqual(value, 10);
    });

    it('should not execute the effect when it is a failure', async () => {
      const resultFlow = ResultFlow.of<number, 'error'>(async ({ fail }) => {
        fail('error');
        return 10;
      });
      const effect = mock.fn();
      const result = await resultFlow.ifSuccess(effect).run();
      const value = result._unsafeUnwrapErr();

      deepEqual(effect.mock.callCount(), 0);
      deepEqual(value, 'error');
    });

    it('should be immutable', async () => {
      let counter = 0;
      const r1 = ResultFlow.from(N.ok(10));
      const r2 = r1.ifSuccess(() => counter++);

      await r1.run();
      await r2.run();
      deepEqual(counter, 1);
    });
  });

  describe('ifFailure', () => {
    it('should execute the effect when it is a failure', async () => {
      const resultFlow = ResultFlow.of<number, 'error'>(async ({ fail }) => {
        fail('error');
        return 10;
      });
      const effect = mock.fn();
      const result = await resultFlow.ifFailure(effect).run();
      const value = result._unsafeUnwrapErr();

      deepEqual(value, 'error');
      deepEqual(effect.mock.calls[0]?.arguments, ['error']);
    });

    it('should not execute the effect when it is a success', async () => {
      const resultFlow = ResultFlow.of<number, never>(async () => {
        return 10;
      });
      const effect = mock.fn();
      const result = await resultFlow.ifFailure(effect).run();
      const value = result._unsafeUnwrap();

      deepEqual(value, 10);
      deepEqual(effect.mock.callCount(), 0);
    });

    it('should be immutable', async () => {
      let counter = 0;
      const r1 = ResultFlow.from(N.err('error'));
      const r2 = r1.ifFailure(() => counter++);

      await r1.run();
      await r2.run();
      deepEqual(counter, 1);
    });
  });

  describe('orElse', () => {
    it('should execute the alternative if the first is a failure', async () => {
      const mockCallback = mock.fn();
      const resultFlow = ResultFlow.from<number, string>(N.err('error'));
      const alternativeResultFlow = (error: string) => {
        mockCallback(error);
        return ResultFlow.from(N.ok(20));
      };
      const ifSuccess = mock.fn();
      const result = await resultFlow.ifSuccess(ifSuccess).orElse(alternativeResultFlow).run();
      const value = result._unsafeUnwrap();

      deepEqual(value, 20);
      deepEqual(ifSuccess.mock.callCount(), 0);
      deepEqual(mockCallback.mock.calls[0]?.arguments, ['error']);
    });

    it('should execute the alternative that returns a Promise<Result<A, E>> if the first is a failure', async () => {
      const mockCallback = mock.fn();
      const resultFlow = ResultFlow.from<number, string>(N.err('error'));
      const alternativeResultFlow = (error: string) => {
        mockCallback(error);
        return Promise.resolve(N.ok(20));
      };
      const ifSuccess = mock.fn();
      const result = await resultFlow.ifSuccess(ifSuccess).orElse(alternativeResultFlow).run();
      const value = result._unsafeUnwrap();
      deepEqual(value, 20);
      deepEqual(ifSuccess.mock.callCount(), 0);
      deepEqual(mockCallback.mock.calls[0]?.arguments, ['error']);
    });

    it('should execute the alternative that returns a Result<A, E> if the first is a failure', async () => {
      const mockCallback = mock.fn();
      const resultFlow = ResultFlow.from<number, string>(N.err('error'));
      const alternativeResultFlow = (error: string) => {
        mockCallback(error);
        return N.ok(20);
      };
      const ifSuccess = mock.fn();
      const result = await resultFlow.ifSuccess(ifSuccess).orElse(alternativeResultFlow).run();
      const value = result._unsafeUnwrap();
      deepEqual(value, 20);
      deepEqual(ifSuccess.mock.callCount(), 0);
      deepEqual(mockCallback.mock.calls[0]?.arguments, ['error']);
    });

    it('should execute the alternative that returns a ResultAsync<A, E> if the first is a failure', async () => {
      const mockCallback = mock.fn();
      const resultFlow = ResultFlow.from<number, string>(N.err('error'));
      const alternativeResultFlow = (error: string) => {
        mockCallback(error);
        return N.okAsync(20);
      };
      const ifSuccess = mock.fn();
      const result = await resultFlow.ifSuccess(ifSuccess).orElse(alternativeResultFlow).run();
      const value = result._unsafeUnwrap();
      deepEqual(value, 20);
      deepEqual(ifSuccess.mock.callCount(), 0);
      deepEqual(mockCallback.mock.calls[0]?.arguments, ['error']);
    });

    it('should not execute the alternative if the first is a success', async () => {
      const mockCallback = mock.fn();

      const resultFlow = ResultFlow.from<number, 'error'>(N.ok(10));
      const alternativeResultFlow = () => {
        mockCallback();
        return ResultFlow.from<number, never>(N.ok(20));
      };

      const ifSuccess = mock.fn();
      const result = await resultFlow.ifSuccess(ifSuccess).orElse(alternativeResultFlow).run();
      const value = result._unsafeUnwrap();

      deepEqual(value, 10);
      deepEqual(ifSuccess.mock.callCount(), 1);
      deepEqual(mockCallback.mock.callCount(), 0);
    });

    it('should be immutable', async () => {
      let counter = 0;
      const r1 = ResultFlow.from<number, string>(N.err('error'));
      const r2 = r1.orElse(() => {
        counter++;
        return N.ok(10);
      });

      await r1.run();
      await r2.run();
      deepEqual(counter, 1);
    });
  });

  describe('retryPolicy', () => {
    const success = 10;
    const defaultError = 'error';
    const versionError = 'version-error';

    describe('Given no parameters are provided', () => {
      it('should retry the operation once when it fails', async () => {
        const defaultNumberOfRetries = 1;
        const mockAction = mock.fn(() => N.err(defaultError));
        const resultFlow = ResultFlow.from(mockAction).retryPolicy();

        const result = await resultFlow.run();

        deepEqual(mockAction.mock.callCount(), defaultNumberOfRetries + 1);
        deepEqual(result._unsafeUnwrapErr(), defaultError);
      });

      it('should not retry if the operation succeeds', async () => {
        const mockAction = mock.fn(() => N.ok(success));
        const resultFlow = ResultFlow.from(mockAction).retryPolicy();

        const result = await resultFlow.run();

        deepEqual(mockAction.mock.callCount(), 1);
        deepEqual(result._unsafeUnwrap(), success);
      });
    });

    describe('Given maxRetries / beforeRetry parameters are provided', () => {
      it('should retry the operation n times when it fails, and call `beforeRetry` before each retry', async () => {
        const n = 5;
        const mockAction = mock.fn(() => N.err(defaultError));
        const beforeRetryMock = mock.fn();
        const resultFlow = ResultFlow.from(mockAction).retryPolicy({
          maxRetries: n,
          beforeRetry: beforeRetryMock,
        });

        const result = await resultFlow.run();

        deepEqual(mockAction.mock.callCount(), n + 1);
        deepEqual(beforeRetryMock.mock.callCount(), n);
        for (let i = 1; i <= n; i++) {
          deepEqual(beforeRetryMock.mock.calls[i - 1]?.arguments[0], defaultError);
          deepEqual(beforeRetryMock.mock.calls[i - 1]?.arguments[1], i);
        }
        deepEqual(result._unsafeUnwrapErr(), defaultError);
      });

      it('should stop retrying as soon as the operation succeeds', async () => {
        const n = 5;
        const numberOfFailures = 2;
        const mockAction = mock.fn(
          () => N.ok(success),
          () => N.err(defaultError),
          { times: numberOfFailures },
        );
        const beforeRetryMock = mock.fn();
        const resultFlow = ResultFlow.from(mockAction).retryPolicy({
          maxRetries: n,
          beforeRetry: beforeRetryMock,
        });

        const result = await resultFlow.run();

        deepEqual(mockAction.mock.callCount(), numberOfFailures + 1);
        deepEqual(beforeRetryMock.mock.callCount(), numberOfFailures);
        for (let i = 1; i <= numberOfFailures; i++) {
          deepEqual(beforeRetryMock.mock.calls[i - 1]?.arguments[0], defaultError);
          deepEqual(beforeRetryMock.mock.calls[i - 1]?.arguments[1], i);
        }
        deepEqual(result._unsafeUnwrap(), success);
      });

      it('should ignore the retry policy if maxRetries <= 0', async () => {
        const n = -1;
        const mockAction = mock.fn(() => N.err(defaultError));
        const beforeRetryMock = mock.fn();
        const resultFlow = ResultFlow.from(mockAction).retryPolicy({
          maxRetries: n,
          beforeRetry: beforeRetryMock,
        });

        const result = await resultFlow.run();

        deepEqual(mockAction.mock.callCount(), 1);
        deepEqual(beforeRetryMock.mock.callCount(), 0);
        deepEqual(result._unsafeUnwrapErr(), defaultError);
      });
    });

    describe('Given a condition is passed', () => {
      it('should retry the operation only when the condition is satisfied', async () => {
        const n = 5;
        const numberOfVersionError = 2;
        const mockAction = mock.fn(
          () => N.err(defaultError),
          () => N.err(versionError),
          { times: numberOfVersionError },
        );
        const beforeRetryMock = mock.fn();
        const condition = (error: string) => error === versionError;
        const resultFlow = ResultFlow.from(mockAction).retryPolicy({
          maxRetries: n,
          beforeRetry: beforeRetryMock,
          condition,
        });

        const result = await resultFlow.run();

        deepEqual(mockAction.mock.callCount(), numberOfVersionError + 1);
        deepEqual(beforeRetryMock.mock.callCount(), numberOfVersionError);
        for (let i = 1; i <= numberOfVersionError; i++) {
          deepEqual(beforeRetryMock.mock.calls[i - 1]?.arguments[0], versionError);
          deepEqual(beforeRetryMock.mock.calls[i - 1]?.arguments[1], i);
        }
        deepEqual(result._unsafeUnwrapErr(), defaultError);
      });

      it('should stop retrying when we have a success', async () => {
        const n = 5;
        const mockAction = mock.fn(() => N.ok(success));
        const beforeRetryMock = mock.fn();
        const condition = (error: string) => error === versionError;
        const resultFlow = ResultFlow.from(mockAction).retryPolicy({
          maxRetries: n,
          beforeRetry: beforeRetryMock,
          condition,
        });

        const result = await resultFlow.run();

        deepEqual(mockAction.mock.callCount(), 1);
        deepEqual(beforeRetryMock.mock.callCount(), 0);
        deepEqual(result._unsafeUnwrap(), success);
      });
    });

    it('should be immutable', async () => {
      const mockAction = mock.fn(
        () => N.ok(success),
        () => N.err(defaultError),
        { times: 2 },
      );
      const flow1 = ResultFlow.from<number, string>(mockAction);
      const flow2 = flow1.retryPolicy({ maxRetries: 3 });

      const r1 = await flow1.run();
      const r2 = await flow2.run();

      deepEqual(r1._unsafeUnwrapErr(), defaultError);
      deepEqual(r2._unsafeUnwrap(), success);
    });

    it('should not retry anything appended to resultFlow after the retryPolicy method', async () => {
      const n = 3;
      const mockIfFailure = mock.fn();
      const mockOrElse = mock.fn(() => N.ok(success));
      const mockAction = mock.fn(() => N.err(defaultError));
      const flow = ResultFlow.from<number, string>(mockAction)
        .retryPolicy({ maxRetries: n })
        .ifFailure(mockIfFailure)
        .orElse(mockOrElse);

      await flow.run();

      deepEqual(mockAction.mock.callCount(), n + 1);
      deepEqual(mockIfFailure.mock.callCount(), 1);
      deepEqual(mockIfFailure.mock.calls[0]?.arguments[0], defaultError);
      deepEqual(mockOrElse.mock.callCount(), 1);
      deepEqual(mockIfFailure.mock.calls[0]?.arguments[0], defaultError);
    });
  });

  describe('runPeriodically', () => {
    const error = 'error';
    const defaultInterval = 10;

    it('should repeat the flow until fails, and call `onInterruption` with the error', async (context) => {
      context.mock.timers.enable({ apis: ['setInterval'] });
      const mockAction: Mock<() => Result<undefined, string>> = mock.fn(
        () => N.err(error),
        () => N.ok(undefined),
        { times: 2 },
      );
      const mockOnInterruption = mock.fn();

      ResultFlow.from(mockAction).runPeriodically({
        interval: defaultInterval,
        onInterruption: mockOnInterruption,
      });
      await advanceToNextTick(context);
      await advanceToNextTick(context);
      await advanceToNextTick(context);
      await advanceToNextTick(context);

      deepEqual(mockAction.mock.callCount(), 3);
      deepEqual(mockOnInterruption.mock.callCount(), 1);
      deepEqual(mockOnInterruption.mock.calls[0]?.arguments[0], {
        cause: 'failure',
        error,
        recoveryError: undefined,
      });
    });

    it('should return a `interrupt` function that can interrupt the repeat flow when called, and call `onInterruption` with the cause `aborted`', async (context) => {
      context.mock.timers.enable({ apis: ['setInterval'] });
      const mockAction: Mock<() => Result<undefined, string>> = mock.fn(() =>
        N.ok(undefined),
      );
      const mockOnInterruption = mock.fn();

      const { interrupt } = ResultFlow.from(mockAction).runPeriodically({
        interval: defaultInterval,
        onInterruption: mockOnInterruption,
      });
      interrupt();

      await advanceToNextTick(context);
      deepEqual(mockAction.mock.callCount(), 0);
      deepEqual(mockOnInterruption.mock.callCount(), 1);
      deepEqual(mockOnInterruption.mock.calls[0]?.arguments[0], { cause: 'aborted' });
    });

    it('should run a recovery action in case of failure, and stop the flow it the recovery fails. In which case it calls `onInterruption` callback', async (context) => {
      context.mock.timers.enable({ apis: ['setInterval'] });
      const recoveryError = 'recovery-error' as const;
      const mockAction: Mock<() => Result<never, string>> = mock.fn(() => N.err(error));
      const mockRecoveryAction = mock.fn(() => Promise.resolve(N.err(recoveryError)));
      const mockOnInterruption = mock.fn();

      ResultFlow.from(mockAction).runPeriodically({
        interval: defaultInterval,
        recoveryAction: mockRecoveryAction,
        onInterruption: mockOnInterruption,
      });

      await advanceToNextTick(context);
      await advanceToNextTick(context);

      deepEqual(mockAction.mock.callCount(), 1);
      deepEqual(mockRecoveryAction.mock.callCount(), 1);
      deepEqual(mockOnInterruption.mock.callCount(), 1);
      deepEqual(mockOnInterruption.mock.calls[0]?.arguments[0], {
        cause: 'failure',
        error,
        recoveryError: recoveryError,
      });
    });

    it('should run a recovery action in case of failure, and stop the flow it the recovery fails. In which case it calls `onInterruption` callback (ResultFlow variant for recoveryAction)', async (context) => {
      context.mock.timers.enable({ apis: ['setInterval'] });
      const recoveryError = 'recovery-error' as const;
      const mockAction: Mock<() => Result<never, string>> = mock.fn(() => N.err(error));
      const mockRecoveryAction = mock.fn(() => ResultFlow.from(() => N.err(recoveryError)));
      const mockOnInterruption = mock.fn();

      ResultFlow.from(mockAction).runPeriodically({
        interval: defaultInterval,
        recoveryAction: mockRecoveryAction,
        onInterruption: mockOnInterruption,
      });
      await advanceToNextTick(context);
      await advanceToNextTick(context);

      deepEqual(mockAction.mock.callCount(), 1);
      deepEqual(mockRecoveryAction.mock.callCount(), 1);
      deepEqual(mockOnInterruption.mock.callCount(), 1);
      deepEqual(mockOnInterruption.mock.calls[0]?.arguments[0], {
        cause: 'failure',
        error,
        recoveryError: recoveryError,
      });
    });

    it('should run a recovery action in case of failure, and resume the repeat flow it if the recovery succeeds', async (context) => {
      context.mock.timers.enable({ apis: ['setInterval'] });
      const mockAction: Mock<() => Result<undefined, string>> = mock.fn(
        () => N.ok(undefined),
        () => N.err(error),
        { times: 1 },
      );
      const mockRecoveryAction = mock.fn(() => Promise.resolve(N.ok(undefined)));
      const mockOnInterruption = mock.fn();

      const { interrupt } = ResultFlow.from(mockAction).runPeriodically({
        interval: defaultInterval,
        recoveryAction: mockRecoveryAction,
        onInterruption: mockOnInterruption,
      });
      await advanceToNextTick(context);
      await advanceToNextTick(context);
      await advanceToNextTick(context);
      await advanceToNextTick(context);

      deepEqual(mockAction.mock.callCount() > 1, true);
      deepEqual(mockRecoveryAction.mock.callCount(), 1);
      deepEqual(mockOnInterruption.mock.callCount(), 0);

      interrupt();
    });
  });
});
