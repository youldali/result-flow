import { deepEqual, fail, rejects, strictEqual } from 'node:assert';

import { describe, it, mock, type Mock, type TestContext } from 'node:test';
import * as N from 'neverthrow';
import { Result } from 'neverthrow';
import { ResultFlow } from './result-flow.js';
import type { ResultFlowExtras, ResultFlowRunParams } from './index.js';

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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

const advanceToNextTick = async (testContext: TestContext) => {
  testContext.mock.timers.runAll();
  await sleep(0);
};

type Context = { correlationId: string; userId: string; };
const context: Context = { correlationId: 'test-correlation-id', userId: 'test-user-id' };

describe('ResultFlow', () => {
  describe('gen', () => {
    it('should allow to use ResultFlow in a generator function', async () => {
      const resultFlow = ResultFlow.gen<Row, FlowFailure>(async function* () {
        const row = yield* ResultFlow.lift(findById(1));
        yield* ResultFlow.lift(validate(row, true));
        return yield* ResultFlow.lift(updateById(row.id, { name: 'updated-name' }));
      });

      const result = await resultFlow.run();
      const value = result._unsafeUnwrap();
      deepEqual(value, { id: 1, name: 'updated-name' });
    });

    it('should allow to use Result in a generator function', async () => {
      const resultFlow = ResultFlow.gen(async function* () {
        const a = yield* N.ok(5);
        const b = yield* N.ok(10);
        return a + b;
      });

      const result = await resultFlow.run();
      const value = result._unsafeUnwrap();
      deepEqual(value, 15);
    });

    it('should allow to use ResultAsync in a generator function', async () => {
      const resultFlow = ResultFlow.gen(async function* () {
        const a = yield* N.okAsync(5);
        const b = yield* N.okAsync(10);
        return a + b;
      });

      const result = await resultFlow.run();
      const value = result._unsafeUnwrap();
      deepEqual(value, 15);
    });

    it('should return a failure as soon as a function returns a failure result', async () => {
      const mockFn = mock.fn();
      const resultFlow = ResultFlow.gen<Row, FlowFailure>(async function* () {
        // the following operation fails
        const row = yield* ResultFlow.lift(findById(2));
        mockFn();
        yield* validate(row, true);
        return yield* ResultFlow.lift(updateById(1, { name: 'updated' }));
      });

      const result = await resultFlow.run();
      const value = result._unsafeUnwrapErr();
      deepEqual(value, { reason: 'not-found', operation: 'findById' });
      deepEqual(mockFn.mock.callCount(), 0);
    });

    it('should return a failure as soon as a function returns a failure result (result variant)', async () => {
      const mockFn = mock.fn();
      const resultFlow = ResultFlow.gen(async function* () {
        const a = yield* N.err("error");
        mockFn();
        const b = yield* N.ok(10);
        return a + b;
      });

      const result = await resultFlow.run();
      const value = result._unsafeUnwrapErr();
      deepEqual(value, "error");
      deepEqual(mockFn.mock.callCount(), 0);
    });

    it('should return a failure as soon as a function returns a failure result (resultAsync variant)', async () => {
      const mockFn = mock.fn();
      const resultFlow = ResultFlow.gen(async function* () {
        const a = yield* N.errAsync("error");
        mockFn();
        const b = yield* N.okAsync(10);
        return a + b;
      });

      const result = await resultFlow.run();
      const value = result._unsafeUnwrapErr();
      deepEqual(value, "error");
      deepEqual(mockFn.mock.callCount(), 0);
    });

    it('should return a rejected promise if a function throws', async () => {
      const resultFlow = ResultFlow.gen(async function* () {
        yield* ResultFlow.lift(Promise.reject(new Error('error description')));
        return 'ok';
      });

      await rejects(async () => resultFlow.run(), /error description/);
    });

    it('should be able to access the context', async () => {
      const mockFn = mock.fn();
      await ResultFlow.gen<number, Error, Context>(async function* (_helpers, { context }: ResultFlowExtras<Context>) {
        const a = yield* N.okAsync(5);
        const b = yield* N.okAsync(10);
        mockFn(context);
        return a + b;
      })
      .run({ context });

      deepEqual(mockFn.mock.calls[0]?.arguments, [context]);
    });

    it('should allow yielding flows that require subsets of the generator context', async () => {
      type CorrelationContext = { correlationId: string };
      type UserContext = { userId: string };
      type FlowContext = CorrelationContext & UserContext;

      const correlationFlow = ResultFlow.of<number, never, CorrelationContext>(
        async (_helpers, { context }) => context.correlationId.length,
      );
      const userFlow = ResultFlow.of<string, never, UserContext>(
        async (_helpers, { context }) => context.userId,
      );

      const resultFlow = ResultFlow.gen<string, never, FlowContext>(async function* () {
        const correlationLength = yield* correlationFlow;
        const userId = yield* userFlow;

        return `${userId}:${correlationLength}`;
      });

      const result = await resultFlow.run({
        context: {
          correlationId: 'test-correlation-id',
          userId: 'test-user-id',
        },
      });

      deepEqual(result, N.ok('test-user-id:19'));
    });

    it('should allow recovering a yielded result inline with orRecover', async () => {
      const resultFlow = ResultFlow.gen<Row, FlowFailure>(async function* ({ orRecover }) {
        const row = yield* orRecover(findById(2), (error) => ({
          id: 0,
          name: `${error.operation}-default`,
        }));

        return row;
      });

      const result = await resultFlow.run();

      deepEqual(result, N.ok({ id: 0, name: 'findById-default' }));
    });

    it('should not call orRecover fallback when the yielded result succeeds', async () => {
      const fallback = mock.fn(() => ({ id: 0, name: 'default' }));
      const resultFlow = ResultFlow.gen<Row, FlowFailure>(async function* ({ orRecover }) {
        return yield* orRecover(findById(1), fallback);
      });

      const result = await resultFlow.run();

      deepEqual(result, N.ok({ id: 1, name: 'test' }));
      deepEqual(fallback.mock.callCount(), 0);
    });

    it('should support async orRecover fallback functions', async () => {
      const resultFlow = ResultFlow.gen<number, never>(async function* ({ orRecover }) {
        return yield* orRecover(N.err<number, 'error'>('error'), async () => 20);
      });

      const result = await resultFlow.run();

      deepEqual(result, N.ok(20));
    });

    it('should pass context to orRecover fallback functions', async () => {
      const resultFlow = ResultFlow.gen<Row, never, Context>(async function* ({ orRecover }) {
        return yield* orRecover(findById(2), (_error, { context }) => ({
          id: 0,
          name: context.userId,
        }));
      });

      const result = await resultFlow.run({ context });

      deepEqual(result, N.ok({ id: 0, name: 'test-user-id' }));
    });

    it('should not call orElse fallback when the yielded result succeeds', async () => {
      const fallback = mock.fn(() => N.ok<Row, UpdateByIdFailure>({ id: 0, name: 'default' }));
      const resultFlow = ResultFlow.gen<Row, UpdateByIdFailure>(async function* ({ orElse }) {
        return yield* orElse(findById(1), fallback);
      });

      const result = await resultFlow.run();

      deepEqual(result, N.ok({ id: 1, name: 'test' }));
      deepEqual(fallback.mock.callCount(), 0);
    });

    it('should allow falling back to another yielded result inline with orElse', async () => {
      const resultFlow = ResultFlow.gen<Row, UpdateByIdFailure>(async function* ({ orElse }) {
        return yield* orElse(findById(2), () => updateById(1, { name: 'fallback' }));
      });

      const result = await resultFlow.run();

      deepEqual(result, N.ok({ id: 1, name: 'fallback' }));
    });

    it('should fail when the orElse fallback result fails', async () => {
      const resultFlow = ResultFlow.gen<Row, UpdateByIdFailure>(async function* ({ orElse }) {
        return yield* orElse(findById(2), () => updateById(2, { name: 'fallback' }));
      });

      const result = await resultFlow.run();

      deepEqual(result, N.err({ reason: 'not-found', operation: 'updateById' }));
    });

    it('should pass context to orElse fallback functions', async () => {
      const resultFlow = ResultFlow.gen<Row, never, Context>(async function* ({ orElse }) {
        return yield* orElse(findById(2), (_error, { context }) =>
          N.ok<Row, never>({ id: 0, name: context.userId }),
        );
      });

      const result = await resultFlow.run({ context });

      deepEqual(result, N.ok({ id: 0, name: 'test-user-id' }));
    });
  });

  describe('run', () => {
     it('should accept a context', async () => {
      type Context = { correlationId: string };
      const runParams: ResultFlowRunParams<Context> = { context: { correlationId: '123' } };
      const resultFlow = ResultFlow.of<Row, FlowFailure, Context>(async ({ tryTo }) => {
        const row = await tryTo(findById(1));
        await tryTo(validate(row, true));
        return tryTo(updateById(row.id, { name: 'updated-name' }));
      });

      const result = await resultFlow.run(runParams);
      const value = result._unsafeUnwrap();
      deepEqual(value, { id: 1, name: 'updated-name' });
    });

    it('should successfully run the whole flow when all the functions returns a success result', async () => {
      const resultFlow = ResultFlow.of<Row, FlowFailure>(async ({ tryTo }) => {
        const row = await tryTo(findById(1));
        await tryTo(validate(row, true));
        return tryTo(updateById(row.id, { name: 'updated-name' }));
      });

      const result = await resultFlow.run();
      const value = result._unsafeUnwrap();
      deepEqual(value, { id: 1, name: 'updated-name' });
    });

    it('should successfully run the whole flow when all the functions returns a success result (chain variant)', async () => {
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

    it('should map tryTo failures when mapError is provided', async () => {
      const resultFlow = ResultFlow.of<Row, { kind: 'flow-error'; cause: FlowFailure }>(
        async ({ tryTo }) => {
          return tryTo(findById(2), {
            mapError: (error) => ({ kind: 'flow-error', cause: error }),
          });
        },
      );

      const result = await resultFlow.run();
      deepEqual(result._unsafeUnwrapErr(), {
        kind: 'flow-error',
        cause: { reason: 'not-found', operation: 'findById' },
      });
    });

    it('should accept a ResultFlow with tryTo', async () => {
      const nestedFlow = ResultFlow.from<Row, FlowFailure>(findById(1));
      const resultFlow = ResultFlow.of<Row, FlowFailure>(async ({ tryTo }) => {
        return tryTo(nestedFlow);
      });

      const result = await resultFlow.run();

      deepEqual(result, N.ok({ id: 1, name: 'test' }));
    });

    it('should map ResultFlow failures with tryTo options', async () => {
      const nestedFlow = ResultFlow.from<Row, FindByIdFailure>(findById(2));
      const resultFlow = ResultFlow.of<Row, { kind: 'flow-error'; cause: FlowFailure }>(
        async ({ tryTo }) => {
          return tryTo(nestedFlow, {
            mapError: (error) => ({ kind: 'flow-error', cause: error }),
          });
        },
      );

      const result = await resultFlow.run();

      deepEqual(result, N.err({
        kind: 'flow-error',
        cause: { reason: 'not-found', operation: 'findById' },
      }));
    });

    it('should not call tryToOrRecover fallback when the result succeeds', async () => {
      const fallback = mock.fn(() => ({ id: 0, name: 'default' }));
      const resultFlow = ResultFlow.of<Row, FlowFailure>(async ({ tryToOrRecover }) => {
        return tryToOrRecover(findById(1), fallback);
      });

      const result = await resultFlow.run();

      deepEqual(result, N.ok({ id: 1, name: 'test' }));
      deepEqual(fallback.mock.callCount(), 0);
    });

    it('should recover from a failure with tryToOrRecover', async () => {
      const fallback = mock.fn((error: FlowFailure) => ({
        id: 0,
        name: `${error.operation}-default`,
      }));
      const resultFlow = ResultFlow.of<Row, FlowFailure>(async ({ tryToOrRecover }) => {
        return tryToOrRecover(findById(2), fallback);
      });

      const result = await resultFlow.run();

      deepEqual(result, N.ok({ id: 0, name: 'findById-default' }));
      deepEqual(fallback.mock.calls[0]?.arguments, [{ reason: 'not-found', operation: 'findById' }]);
    });

    it('should support ResultAsync values with tryToOrRecover', async () => {
      const resultFlow = ResultFlow.of<number, 'error'>(async ({ tryToOrRecover }) => {
        return tryToOrRecover(N.errAsync<number, 'error'>('error'), () => 20);
      });

      const result = await resultFlow.run();

      deepEqual(result, N.ok(20));
    });

    it('should recover from a failing ResultFlow with tryToOrRecover', async () => {
      const nestedFlow = ResultFlow.from<Row, FlowFailure>(findById(2));
      const resultFlow = ResultFlow.of<Row, FlowFailure>(async ({ tryToOrRecover }) => {
        return tryToOrRecover(nestedFlow, () => ({ id: 0, name: 'default' }));
      });

      const result = await resultFlow.run();

      deepEqual(result, N.ok({ id: 0, name: 'default' }));
    });

    it('should reject when tryToOrRecover receives a rejected promise', async () => {
      const fallback = mock.fn(() => 'fallback');
      const resultFlow = ResultFlow.of<string, FlowFailure>(async ({ tryToOrRecover }) => {
        return tryToOrRecover(Promise.reject(new Error('error description')), fallback);
      });

      await rejects(async () => resultFlow.run(), /error description/);
      deepEqual(fallback.mock.callCount(), 0);
    });

    it('should not call tryToOrElse fallback when the result succeeds', async () => {
      const fallback = mock.fn(() => N.ok({ id: 0, name: 'default' }));
      const resultFlow = ResultFlow.of<Row, FlowFailure>(async ({ tryToOrElse }) => {
        return tryToOrElse(findById(1), fallback);
      });

      const result = await resultFlow.run();

      deepEqual(result, N.ok({ id: 1, name: 'test' }));
      deepEqual(fallback.mock.callCount(), 0);
    });

    it('should run a fallback Result with tryToOrElse when the result fails', async () => {
      const fallback = mock.fn((error: FlowFailure) => {
        return N.ok<Row, FlowFailure>({ id: 0, name: `${error.operation}-fallback` });
      });
      const resultFlow = ResultFlow.of<Row, FlowFailure>(async ({ tryToOrElse }) => {
        return tryToOrElse(findById(2), fallback);
      });

      const result = await resultFlow.run();

      deepEqual(result, N.ok({ id: 0, name: 'findById-fallback' }));
      deepEqual(fallback.mock.calls[0]?.arguments, [{ reason: 'not-found', operation: 'findById' }]);
    });

    it('should fail with the fallback error when tryToOrElse fallback fails', async () => {
      const resultFlow = ResultFlow.of<Row, FlowFailure | UpdateByIdFailure>(async ({ tryToOrElse }) => {
        return tryToOrElse(findById(2), () => updateById(2, { name: 'fallback' }));
      });

      const result = await resultFlow.run();

      deepEqual(result, N.err({ reason: 'not-found', operation: 'updateById' }));
    });

    it('should run a fallback when tryToOrElse receives a failing ResultFlow', async () => {
      const nestedFlow = ResultFlow.from<Row, FlowFailure>(findById(2));
      const resultFlow = ResultFlow.of<Row, FlowFailure>(async ({ tryToOrElse }) => {
        return tryToOrElse(nestedFlow, () => N.ok({ id: 0, name: 'default' }));
      });

      const result = await resultFlow.run();

      deepEqual(result, N.ok({ id: 0, name: 'default' }));
    });

    it('should run a fallback ResultFlow with the current context', async () => {
      type FallbackContext = { userId: string };
      const fallbackFlow = ResultFlow.of<Row, FlowFailure, FallbackContext>(
        async (_helpers, { context }) => ({ id: 0, name: context.userId }),
      );
      const resultFlow = ResultFlow.of<Row, FlowFailure, FallbackContext>(async ({ tryToOrElse }) => {
        return tryToOrElse(findById(2), () => fallbackFlow);
      });

      const result = await resultFlow.run({ context: { userId: 'fallback-user' } });

      deepEqual(result, N.ok({ id: 0, name: 'fallback-user' }));
    });

    it('should pass context to a ResultFlow received by tryTo', async () => {
      type NestedContext = { userId: string };
      const nestedFlow = ResultFlow.of<Row, FlowFailure, NestedContext>(
        async (_helpers, { context }) => ({ id: 0, name: context.userId }),
      );
      const resultFlow = ResultFlow.of<Row, FlowFailure, NestedContext>(async ({ tryTo }) => {
        return tryTo(nestedFlow);
      });

      const result = await resultFlow.run({ context: { userId: 'nested-user' } });

      deepEqual(result, N.ok({ id: 0, name: 'nested-user' }));
    });

    it('should return a failure as soon as a function returns a failure result', async () => {
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

    it('should return a failure as soon as a function returns a failure result (chain variant)', async () => {
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
      const r2 = r1.ifSuccess(() => {
        counter++;
      });
      await r1.run();
      deepEqual(counter, 0);

      await r2.run();
      await r2.run();
      deepEqual(counter, 2);
    });

    it('should be able to access the context', async () => {
      const mockFn = mock.fn();
      await ResultFlow.gen<number, Error, Context>(async function* (_helpers, { context }: { context: Context }) {
        const a = yield* N.okAsync(5);
        const b = yield* N.okAsync(10);
        mockFn(context);
        return a + b;
      })
      .run({ context });

      deepEqual(mockFn.mock.calls[0]?.arguments, [context]);
    });
  });

  describe('runAndMatch', () => {
    it('calls ok handler and returns its value when the flow succeeds', async () => {
      const result = await ResultFlow.from<number, string>(N.ok(10)).runAndMatch({
        ok: (value) => ({ status: 200, body: value }),
        err: () => ({ status: 500, body: 0 }),
      });

      deepEqual(result, { status: 200, body: 10 });
    });

    it('does not call err handler when the flow succeeds', async () => {
      const err = mock.fn();

      await ResultFlow.from<number, string>(N.ok(10)).runAndMatch({
        ok: (value) => value,
        err,
      });

      strictEqual(err.mock.callCount(), 0);
    });

    it('calls err handler and returns its value when the flow fails', async () => {
      const result = await ResultFlow.from<number, string>(N.err('error')).runAndMatch<{ status: number; body: unknown }>({
        ok: () => ({ status: 200, body: 0 }),
        err: (error) => ({ status: 400, body: error }),
      });

      deepEqual(result, { status: 400, body: 'error' });
    });

    it('does not call ok handler when the flow fails', async () => {
      const ok = mock.fn();

      await ResultFlow.from<number, string>(N.err('error')).runAndMatch({
        ok,
        err: (error) => error,
      });

      strictEqual(ok.mock.callCount(), 0);
    });

    it('supports async ok handler', async () => {
      const result = await ResultFlow.from<number, string>(N.ok(10)).runAndMatch({
        ok: async (value) => value + 5,
        err: async () => 0,
      });

      strictEqual(result, 15);
    });

    it('supports async err handler', async () => {
      const result = await ResultFlow.from<number, string>(N.err('error')).runAndMatch({
        ok: async () => 'ok',
        err: async (error) => `handled:${error}`,
      });

      strictEqual(result, 'handled:error');
    });

    it('passes context to the selected handler', async () => {
      type Context = { requestId: string };
      const requestContext: Context = { requestId: 'req-123' };

      const result = await ResultFlow.from<number, string, Context>(N.ok(10)).runAndMatch({
        ok: (_value, extras) => extras.context.requestId,
        err: () => 'error',
      }, { context: requestContext });

      strictEqual(result, 'req-123');
    });

    it('passes abortSignal to the selected handler', async () => {
      const abortController = new AbortController();

      const result = await ResultFlow.from<number, string>(N.ok(10)).runAndMatch({
        ok: (_value, extras) => extras.abortSignal,
        err: () => undefined,
      }, { abortSignal: abortController.signal });

      strictEqual(result, abortController.signal);
    });

    it('allows calling runAndMatch with no context when the flow has no context type', async () => {
      const result = await ResultFlow.from<number, string>(N.ok(10)).runAndMatch({
        ok: (value) => value,
        err: () => 0,
      });

      strictEqual(result, 10);
    });

    it('requires and uses context when the flow has a context type', async () => {
      type Context = { multiplier: number };
      const flow = ResultFlow.from<number, string, Context>(N.ok(10));

      if (false) {
        // @ts-expect-error Context is required for context-aware flows.
        void flow.runAndMatch({
          ok: (value) => value,
          err: () => 0,
        });
      }

      const result = await flow.runAndMatch({
        ok: (value, extras) => value * extras.context.multiplier,
        err: () => 0,
      }, { context: { multiplier: 3 } });

      strictEqual(result, 30);
    });

    it('rejects when the underlying flow throws and does not call either handler', async () => {
      const ok = mock.fn();
      const err = mock.fn();
      const resultFlow = ResultFlow.of<number, string>(async () => {
        throw new Error('flow threw');
      });

      await rejects(() => resultFlow.runAndMatch({ ok, err }), /flow threw/);
      strictEqual(ok.mock.callCount(), 0);
      strictEqual(err.mock.callCount(), 0);
    });

    it('rejects when the underlying flow rejects and does not call either handler', async () => {
      const ok = mock.fn();
      const err = mock.fn();
      const resultFlow = ResultFlow.from<number, string>(() => Promise.reject(new Error('flow rejected')));

      await rejects(() => resultFlow.runAndMatch({ ok, err }), /flow rejected/);
      strictEqual(ok.mock.callCount(), 0);
      strictEqual(err.mock.callCount(), 0);
    });

    it('rejects when the selected handler throws', async () => {
      await rejects(
        () => ResultFlow.from<number, string>(N.ok(10)).runAndMatch({
          ok: () => {
            throw new Error('handler threw');
          },
          err: () => 0,
        }),
        /handler threw/,
      );
    });

    it('rejects when the selected handler rejects', async () => {
      await rejects(
        () => ResultFlow.from<number, string>(N.err('error')).runAndMatch({
          ok: () => 0,
          err: async () => {
            throw new Error('handler rejected');
          },
        }),
        /handler rejected/,
      );
    });

    it('does not mutate the original flow', async () => {
      const base = ResultFlow.from<number, string>(N.ok(10));

      const matched = await base.runAndMatch({
        ok: (value) => value * 2,
        err: () => 0,
      });
      const originalResult = await base.run();

      strictEqual(matched, 20);
      deepEqual(originalResult, N.ok(10));
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

    it('should preserve failures from all supported input variants', async () => {
      deepEqual(await ResultFlow.from<number, string>(N.err('error')).run(), N.err('error'));
      deepEqual(await ResultFlow.from<number, string>(() => N.err('error')).run(), N.err('error'));
      deepEqual(await ResultFlow.from<number, string>(N.errAsync('error')).run(), N.err('error'));
      deepEqual(await ResultFlow.from<number, string>(() => N.errAsync('error')).run(), N.err('error'));
      deepEqual(await ResultFlow.from<number, string>(Promise.resolve(N.err('error'))).run(), N.err('error'));
      deepEqual(await ResultFlow.from<number, string>(() => Promise.resolve(N.err('error'))).run(), N.err('error'));
    });

    it('should reject when the input promise rejects or factory throws', async () => {
      await rejects(
        () => ResultFlow.from<number, string>(Promise.reject<Result<number, string>>(new Error('promise rejected'))).run(),
        /promise rejected/,
      );
      await rejects(
        () => ResultFlow.from<number, string>(() => {
          throw new Error('factory threw');
        }).run(),
        /factory threw/,
      );
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

    it('should preserve failures from all supported input variants', async () => {
      deepEqual(await ResultFlow.lift<number, string>(N.err('error')).run(), N.err('error'));
      deepEqual(await ResultFlow.lift<number, string>(() => N.err('error')).run(), N.err('error'));
      deepEqual(await ResultFlow.lift<number, string>(N.errAsync('error')).run(), N.err('error'));
      deepEqual(await ResultFlow.lift<number, string>(() => N.errAsync('error')).run(), N.err('error'));
      deepEqual(await ResultFlow.lift<number, string>(Promise.resolve(N.err('error'))).run(), N.err('error'));
      deepEqual(await ResultFlow.lift<number, string>(() => Promise.resolve(N.err('error'))).run(), N.err('error'));
    });

    it('should reject when the input promise rejects or factory throws', async () => {
      await rejects(
        () => ResultFlow.lift<number, string>(Promise.reject<Result<number, string>>(new Error('promise rejected'))).run(),
        /promise rejected/,
      );
      await rejects(
        () => ResultFlow.lift<number, string>(() => {
          throw new Error('factory threw');
        }).run(),
        /factory threw/,
      );
    });
  });

  describe('all', () => {
    it('should return Ok([]) for an empty array', async () => {
      const result = await ResultFlow.all([]).run();

      deepEqual(result, N.ok([]));
    });

    it('should return Ok([a, b, c]) when all flows succeed', async () => {
      const result = await ResultFlow.all([
        ResultFlow.from(N.ok('a')),
        ResultFlow.from(N.ok('b')),
        ResultFlow.from(N.ok('c')),
      ]).run();

      deepEqual(result, N.ok(['a', 'b', 'c']));
    });

    it('should return the first failure in array order', async () => {
      const result = await ResultFlow.all([
        ResultFlow.from<number, 'first-error'>(N.err('first-error')),
        ResultFlow.from<number, 'second-error'>(N.err('second-error')),
      ]).run();

      deepEqual(result, N.err('first-error'));
    });

    it('should stop executing flows after the first failure', async () => {
      const first = mock.fn(() => N.ok(1));
      const second = mock.fn(() => N.err('error' as const));
      const third = mock.fn(() => N.ok(3));

      const result = await ResultFlow.all([
        ResultFlow.from(first),
        ResultFlow.from(second),
        ResultFlow.from(third),
      ]).run();

      deepEqual(result, N.err('error'));
      deepEqual(first.mock.callCount(), 1);
      deepEqual(second.mock.callCount(), 1);
      deepEqual(third.mock.callCount(), 0);
    });

    it('should not execute any flow before .run() is called', () => {
      const first = mock.fn(() => N.ok(1));
      const second = mock.fn(() => N.ok(2));

      ResultFlow.all([
        ResultFlow.from(first),
        ResultFlow.from(second),
      ]);

      deepEqual(first.mock.callCount(), 0);
      deepEqual(second.mock.callCount(), 0);
    });

    it('should pass context to every input flow', async () => {
      const first = mock.fn();
      const second = mock.fn();

      const result = await ResultFlow.all([
        ResultFlow.of<number, never, Context>(async (_helpers, extras) => {
          first(extras);
          return 1;
        }),
        ResultFlow.of<number, never, Context>(async (_helpers, extras) => {
          second(extras);
          return 2;
        }),
      ]).run({ context });

      deepEqual(result, N.ok([1, 2]));
      deepEqual(first.mock.calls[0]?.arguments, [{ context }]);
      deepEqual(second.mock.calls[0]?.arguments, [{ context }]);
    });

    it('should preserve tuple value types for readonly tuple input', async () => {
      const flow = ResultFlow.all([
        ResultFlow.from<1, 'first-error'>(N.ok(1 as const)),
        ResultFlow.from<'two', 'second-error'>(N.ok('two' as const)),
        ResultFlow.from<true, 'third-error'>(N.ok(true as const)),
      ] as const);
      const typedFlow: ResultFlow<
        readonly [1, 'two', true],
        'first-error' | 'second-error' | 'third-error'
      > = flow;

      const result = await typedFlow.run();

      deepEqual(result, N.ok([1, 'two', true]));
    });

    it('should union error types from all flows', async () => {
      const flow = ResultFlow.all([
        ResultFlow.from<number, { reason: 'first' }>(N.ok(1)),
        ResultFlow.from<string, { reason: 'second' }>(N.err({ reason: 'second' })),
      ] as const);
      const typedFlow: ResultFlow<
        readonly [number, string],
        { reason: 'first' } | { reason: 'second' }
      > = flow;

      const result = await typedFlow.run();

      deepEqual(result, N.err({ reason: 'second' }));
    });

    it('should require combined context when input flows have context', async () => {
      type FirstContext = { correlationId: string };
      type SecondContext = { userId: string };
      const flow = ResultFlow.all([
        ResultFlow.of<number, never, FirstContext>(async (_helpers, { context }) => context.correlationId.length),
        ResultFlow.of<string, never, SecondContext>(async (_helpers, { context }) => context.userId),
      ] as const);
      const typedFlow: ResultFlow<
        readonly [number, string],
        never,
        FirstContext & SecondContext
      > = flow;

      const result = await typedFlow.run({
        context: { correlationId: 'test-correlation-id', userId: 'test-user-id' },
      });

      deepEqual(result, N.ok([19, 'test-user-id']));
    });

    it('should reject when an input flow throws or rejects', async () => {
      await rejects(
        () => ResultFlow.all([
          ResultFlow.from(N.ok(1)),
          ResultFlow.of<number, never>(async () => {
            throw new Error('flow threw');
          }),
        ]).run(),
        /flow threw/,
      );

      await rejects(
        () => ResultFlow.all([
          ResultFlow.from(N.ok(1)),
          ResultFlow.from<number, never>(Promise.reject(new Error('flow rejected'))),
        ]).run(),
        /flow rejected/,
      );
    });

    it('should be immutable', async () => {
      const first = ResultFlow.from(N.ok(1));
      const second = ResultFlow.from(N.ok(2));
      const flows = Object.freeze([first, second] as const);
      const settled = ResultFlow.all(flows);

      deepEqual(flows, [first, second]);
      deepEqual(await first.run(), N.ok(1));
      deepEqual(await second.run(), N.ok(2));
      deepEqual(await settled.run(), N.ok([1, 2]));
      deepEqual(flows, [first, second]);
    });
  });

  describe('allSettled', () => {
    it('should return Ok([]) for an empty array', async () => {
      const result = await ResultFlow.allSettled([]).run();

      deepEqual(result, N.ok([]));
    });

    it('should run every flow even when some return Err', async () => {
      const first = mock.fn(() => N.ok(1));
      const second = mock.fn(() => N.err('error' as const));
      const third = mock.fn(() => N.ok(3));

      const result = await ResultFlow.allSettled([
        ResultFlow.from(first),
        ResultFlow.from(second),
        ResultFlow.from(third),
      ]).run();

      deepEqual(result, N.ok([N.ok(1), N.err('error'), N.ok(3)]));
      deepEqual(first.mock.callCount(), 1);
      deepEqual(second.mock.callCount(), 1);
      deepEqual(third.mock.callCount(), 1);
    });

    it('should return Ok([Ok(a), Err(e), Ok(c)]) in input order', async () => {
      const result = await ResultFlow.allSettled([
        ResultFlow.from<string, 'first-error'>(N.ok('a')),
        ResultFlow.from<string, 'second-error'>(N.err('second-error')),
        ResultFlow.from<string, 'third-error'>(N.ok('c')),
      ]).run();

      deepEqual(result, N.ok([N.ok('a'), N.err('second-error'), N.ok('c')]));
    });

    it('should start every flow in parallel while preserving result order', async () => {
      const first = createDeferred<Result<string, never>>();
      const second = createDeferred<Result<string, never>>();
      const started = mock.fn();

      const resultPromise = ResultFlow.allSettled([
        ResultFlow.from(() => {
          started('first');
          return first.promise;
        }),
        ResultFlow.from(() => {
          started('second');
          return second.promise;
        }),
      ] as const).run();

      deepEqual(started.mock.calls.map((call) => call.arguments[0]), ['first', 'second']);

      second.resolve(N.ok('second'));
      first.resolve(N.ok('first'));

      deepEqual(await resultPromise, N.ok([N.ok('first'), N.ok('second')]));
    });

    it('should pass context to every input flow', async () => {
      const first = mock.fn();
      const second = mock.fn();

      const result = await ResultFlow.allSettled([
        ResultFlow.of<number, never, Context>(async (_helpers, extras) => {
          first(extras);
          return 1;
        }),
        ResultFlow.of<number, 'error', Context>(async ({ fail }, extras) => {
          second(extras);
          return fail('error');
        }),
      ]).run({ context });

      deepEqual(result, N.ok([N.ok(1), N.err('error')]));
      deepEqual(first.mock.calls[0]?.arguments, [{ context }]);
      deepEqual(second.mock.calls[0]?.arguments, [{ context }]);
    });

    it('should not execute any flow before .run() is called', () => {
      const first = mock.fn(() => N.ok(1));
      const second = mock.fn(() => N.err('error' as const));

      ResultFlow.allSettled([
        ResultFlow.from(first),
        ResultFlow.from(second),
      ]);

      deepEqual(first.mock.callCount(), 0);
      deepEqual(second.mock.callCount(), 0);
    });

    it('should reject when an input flow throws or rejects', async () => {
      await rejects(
        () => ResultFlow.allSettled([
          ResultFlow.from(N.ok(1)),
          ResultFlow.of<number, never>(async () => {
            throw new Error('flow threw');
          }),
        ]).run(),
        /flow threw/,
      );

      await rejects(
        () => ResultFlow.allSettled([
          ResultFlow.from(N.ok(1)),
          ResultFlow.from<number, never>(Promise.reject(new Error('flow rejected'))),
        ]).run(),
        /flow rejected/,
      );
    });

    it('should be immutable', async () => {
      const first = ResultFlow.from(N.ok(1));
      const second = ResultFlow.from<number, 'error'>(N.err('error'));
      const flows = Object.freeze([first, second] as const);
      const settled = ResultFlow.allSettled(flows);

      deepEqual(flows, [first, second]);
      deepEqual(await first.run(), N.ok(1));
      deepEqual(await second.run(), N.err('error'));
      deepEqual(await settled.run(), N.ok([N.ok(1), N.err('error')]));
      deepEqual(flows, [first, second]);
    });

    it('should preserve tuple result types and use never as the outer error type', async () => {
      const flow = ResultFlow.allSettled([
        ResultFlow.from<1, 'first-error'>(N.ok(1 as const)),
        ResultFlow.from<'two', 'second-error'>(N.err('second-error')),
      ] as const);
      const typedFlow: ResultFlow<
        readonly [Result<1, 'first-error'>, Result<'two', 'second-error'>],
        never
      > = flow;

      const result = await typedFlow.run();

      deepEqual(result, N.ok([N.ok(1), N.err('second-error')]));
    });

    it('should require combined context when input flows have context', async () => {
      type FirstContext = { correlationId: string };
      type SecondContext = { userId: string };
      const flow = ResultFlow.allSettled([
        ResultFlow.of<number, never, FirstContext>(async (_helpers, { context }) => context.correlationId.length),
        ResultFlow.of<string, never, SecondContext>(async (_helpers, { context }) => context.userId),
      ] as const);
      const typedFlow: ResultFlow<
        readonly [Result<number, never>, Result<string, never>],
        never,
        FirstContext & SecondContext
      > = flow;

      const result = await typedFlow.run({
        context: { correlationId: 'test-correlation-id', userId: 'test-user-id' },
      });

      deepEqual(result, N.ok([N.ok(19), N.ok('test-user-id')]));
    });
  });

  describe('firstOk', () => {
    it('should not execute any flow before .run() is called', () => {
      const first = mock.fn(() => N.ok(1));
      const second = mock.fn(() => N.ok(2));

      ResultFlow.firstOk([
        ResultFlow.from(first),
        ResultFlow.from(second),
      ]);

      deepEqual(first.mock.callCount(), 0);
      deepEqual(second.mock.callCount(), 0);
    });

    it('should return the first success when the first flow succeeds', async () => {
      const result = await ResultFlow.firstOk([
        ResultFlow.from<number, 'first-error'>(N.ok(1)),
        ResultFlow.from<number, 'second-error'>(N.ok(2)),
      ]).run();

      deepEqual(result, N.ok(1));
    });

    it('should ignore earlier failures and return a later success', async () => {
      const result = await ResultFlow.firstOk([
        ResultFlow.from<number, 'first-error'>(N.err('first-error')),
        ResultFlow.from<number, 'second-error'>(N.err('second-error')),
        ResultFlow.from<number, 'third-error'>(N.ok(3)),
      ]).run();

      deepEqual(result, N.ok(3));
    });

    it('should stop executing flows after the first success', async () => {
      const first = mock.fn(() => N.err('first-error' as const));
      const second = mock.fn(() => N.ok(2));
      const third = mock.fn(() => N.ok(3));

      const result = await ResultFlow.firstOk([
        ResultFlow.from(first),
        ResultFlow.from(second),
        ResultFlow.from(third),
      ]).run();

      deepEqual(result, N.ok(2));
      deepEqual(first.mock.callCount(), 1);
      deepEqual(second.mock.callCount(), 1);
      deepEqual(third.mock.callCount(), 0);
    });

    it('should return Err([errors]) when every flow fails', async () => {
      const result = await ResultFlow.firstOk([
        ResultFlow.from<number, 'first-error'>(N.err('first-error')),
        ResultFlow.from<number, 'second-error'>(N.err('second-error')),
      ]).run();

      deepEqual(result, N.err(['first-error', 'second-error']));
    });

    it('should reject with a clear error for an empty array', async () => {
      await rejects(
        () => ResultFlow.firstOk([]).run(),
        /ResultFlow\.firstOk requires at least one flow/,
      );
    });

    it('should preserve failure order in the returned error array', async () => {
      const result = await ResultFlow.firstOk([
        ResultFlow.from<number, { step: 1 }>(N.err({ step: 1 })),
        ResultFlow.from<number, { step: 2 }>(N.err({ step: 2 })),
        ResultFlow.from<number, { step: 3 }>(N.err({ step: 3 })),
      ] as const).run();

      deepEqual(result, N.err([{ step: 1 }, { step: 2 }, { step: 3 }]));
    });

    it('should pass context to each executed flow', async () => {
      const first = mock.fn();
      const second = mock.fn();

      const result = await ResultFlow.firstOk([
        ResultFlow.of<number, string, Context>(async ({ fail }, extras) => {
          first(extras);
          return fail('first-error');
        }),
        ResultFlow.of<number, string, Context>(async (_helpers, extras) => {
          second(extras);
          return extras.context.userId.length;
        }),
      ]).run({ context });

      deepEqual(result, N.ok(12));
      deepEqual(first.mock.calls[0]?.arguments, [{ context }]);
      deepEqual(second.mock.calls[0]?.arguments, [{ context }]);
    });

    it('should not pass context to flows skipped after the first success', async () => {
      const first = mock.fn();
      const second = mock.fn();

      const result = await ResultFlow.firstOk([
        ResultFlow.of<number, never, Context>(async (_helpers, extras) => {
          first(extras);
          return extras.context.correlationId.length;
        }),
        ResultFlow.of<number, never, Context>(async (_helpers, extras) => {
          second(extras);
          return extras.context.userId.length;
        }),
      ]).run({ context });

      deepEqual(result, N.ok(19));
      deepEqual(first.mock.calls[0]?.arguments, [{ context }]);
      deepEqual(second.mock.callCount(), 0);
    });

    it('should reject when an executed flow throws or rejects', async () => {
      await rejects(
        () => ResultFlow.firstOk([
          ResultFlow.from<number, 'first-error'>(N.err('first-error')),
          ResultFlow.of<number, never>(async () => {
            throw new Error('flow threw');
          }),
        ]).run(),
        /flow threw/,
      );

      await rejects(
        () => ResultFlow.firstOk([
          ResultFlow.from<number, 'first-error'>(N.err('first-error')),
          ResultFlow.from<number, never>(Promise.reject(new Error('flow rejected'))),
        ]).run(),
        /flow rejected/,
      );
    });

    it('should be immutable', async () => {
      const first = ResultFlow.from(N.err('first-error' as const));
      const second = ResultFlow.from(N.ok(2));
      const flows = Object.freeze([first, second] as const);
      const firstSuccessful = ResultFlow.firstOk(flows);

      deepEqual(flows, [first, second]);
      deepEqual(await first.run(), N.err('first-error'));
      deepEqual(await second.run(), N.ok(2));
      deepEqual(await firstSuccessful.run(), N.ok(2));
      deepEqual(flows, [first, second]);
    });

    it('should preserve success union types', async () => {
      const flow = ResultFlow.firstOk([
        ResultFlow.from<1, { reason: 'first' }>(N.err({ reason: 'first' })),
        ResultFlow.from<'two', { reason: 'second' }>(N.ok('two' as const)),
      ] as const);
      const typedFlow: ResultFlow<
        1 | 'two',
        ({ reason: 'first' } | { reason: 'second' })[]
      > = flow;

      const result = await typedFlow.run();

      deepEqual(result, N.ok('two'));
    });

    it('should return an array of unioned error types', async () => {
      const flow = ResultFlow.firstOk([
        ResultFlow.from<number, { reason: 'first' }>(N.err({ reason: 'first' })),
        ResultFlow.from<string, { reason: 'second' }>(N.err({ reason: 'second' })),
      ] as const);
      const typedFlow: ResultFlow<
        number | string,
        ({ reason: 'first' } | { reason: 'second' })[]
      > = flow;

      const result = await typedFlow.run();

      deepEqual(result, N.err([{ reason: 'first' }, { reason: 'second' }]));
    });

    it('should require combined context when input flows have context', async () => {
      type FirstContext = { correlationId: string };
      type SecondContext = { userId: string };
      const flow = ResultFlow.firstOk([
        ResultFlow.of<number, { reason: 'first' }, FirstContext>(async ({ fail }) => fail({ reason: 'first' })),
        ResultFlow.of<string, { reason: 'second' }, SecondContext>(async (_helpers, { context }) => context.userId),
      ] as const);
      const typedFlow: ResultFlow<
        number | string,
        ({ reason: 'first' } | { reason: 'second' })[],
        FirstContext & SecondContext
      > = flow;

      const result = await typedFlow.run({
        context: { correlationId: 'test-correlation-id', userId: 'test-user-id' },
      });

      deepEqual(result, N.ok('test-user-id'));
    });
  });

  describe('race', () => {
    it('should not execute any flow before .run() is called', () => {
      const first = mock.fn();
      const second = mock.fn();

      ResultFlow.race([
        ResultFlow.of<number, never>(async () => {
          first();
          return 1;
        }),
        ResultFlow.of<number, never>(async () => {
          second();
          return 2;
        }),
      ]);

      deepEqual(first.mock.callCount(), 0);
      deepEqual(second.mock.callCount(), 0);
    });

    it('should start all flows when the returned flow is run', async () => {
      const first = createDeferred<number>();
      const second = createDeferred<number>();
      const started = mock.fn();

      const resultPromise = ResultFlow.race([
        ResultFlow.of<number, never>(async () => {
          started('first');
          return first.promise;
        }),
        ResultFlow.of<number, never>(async () => {
          started('second');
          return second.promise;
        }),
      ]).run();

      deepEqual(started.mock.calls.map((call) => call.arguments[0]), ['first', 'second']);

      first.resolve(1);
      deepEqual(await resultPromise, N.ok(1));
      second.resolve(2);
    });

    it('should return the first successful result when an Ok settles first', async () => {
      const slow = createDeferred<number>();
      const fast = createDeferred<string>();

      const resultPromise = ResultFlow.race([
        ResultFlow.of<number, 'slow-error'>(async () => slow.promise),
        ResultFlow.of<string, 'fast-error'>(async () => fast.promise),
      ]).run();

      fast.resolve('fast');

      deepEqual(await resultPromise, N.ok('fast'));
      slow.resolve(1);
    });

    it('should return the first failure when an Err settles first', async () => {
      const slow = createDeferred<number>();
      const fast = createDeferred<never>();

      const resultPromise = ResultFlow.race([
        ResultFlow.of<number, 'slow-error'>(async () => slow.promise),
        ResultFlow.of<number, 'fast-error'>(async ({ fail }) => {
          await fast.promise;
          return fail('fast-error');
        }),
      ]).run();

      fast.resolve(undefined as never);

      deepEqual(await resultPromise, N.err('fast-error'));
      slow.resolve(1);
    });

    it('should pass context to every input flow', async () => {
      const first = mock.fn();
      const second = mock.fn();

      const result = await ResultFlow.race([
        ResultFlow.of<number, never, Context>(async (_helpers, extras) => {
          first(extras);
          return 1;
        }),
        ResultFlow.of<number, never, Context>(async (_helpers, extras) => {
          second(extras);
          return 2;
        }),
      ]).run({ context });

      deepEqual(result, N.ok(1));
      deepEqual(first.mock.calls[0]?.arguments, [{ context }]);
      deepEqual(second.mock.calls[0]?.arguments, [{ context }]);
    });

    it('should reject with a clear error for an empty array', async () => {
      await rejects(
        () => ResultFlow.race([]).run(),
        /ResultFlow\.race requires at least one flow/,
      );
    });

    it('should reject when the first settled input flow throws or rejects', async () => {
      const pending = createDeferred<number>();

      await rejects(
        () => ResultFlow.race([
          ResultFlow.of<number, never>(async () => pending.promise),
          ResultFlow.of<number, never>(async () => {
            throw new Error('flow threw');
          }),
        ]).run(),
        /flow threw/,
      );

      pending.resolve(1);

      const rejected = createDeferred<number>();
      const stillPending = createDeferred<number>();

      const resultPromise = ResultFlow.race([
        ResultFlow.of<number, never>(async () => rejected.promise),
        ResultFlow.of<number, never>(async () => stillPending.promise),
      ]).run();

      rejected.reject(new Error('flow rejected'));

      await rejects(() => resultPromise, /flow rejected/);
      stillPending.resolve(1);
    });

    it('should ignore later results after the first flow settles', async () => {
      const first = createDeferred<string>();
      const later = createDeferred<string>();

      const resultPromise = ResultFlow.race([
        ResultFlow.of<string, never>(async () => first.promise),
        ResultFlow.of<string, never>(async () => later.promise),
      ]).run();

      first.resolve('winner');
      const result = await resultPromise;

      later.reject(new Error('too late'));
      await sleep(0);

      deepEqual(result, N.ok('winner'));
    });

    it('should preserve success and error union types', async () => {
      const flow = ResultFlow.race([
        ResultFlow.from<1, { reason: 'first' }>(N.ok(1 as const)),
        ResultFlow.from<'two', { reason: 'second' }>(N.ok('two' as const)),
      ] as const);
      const typedFlow: ResultFlow<
        1 | 'two',
        { reason: 'first' } | { reason: 'second' }
      > = flow;

      const result = await typedFlow.run();

      deepEqual(result, N.ok(1));
    });

    it('should require combined context when input flows have context', async () => {
      type FirstContext = { correlationId: string };
      type SecondContext = { userId: string };
      const flow = ResultFlow.race([
        ResultFlow.of<number, never, FirstContext>(async (_helpers, { context }) => context.correlationId.length),
        ResultFlow.of<string, never, SecondContext>(async (_helpers, { context }) => context.userId),
      ] as const);
      const typedFlow: ResultFlow<
        number | string,
        never,
        FirstContext & SecondContext
      > = flow;

      const result = await typedFlow.run({
        context: { correlationId: 'test-correlation-id', userId: 'test-user-id' },
      });

      deepEqual(result, N.ok(19));
    });

    it('should be immutable', async () => {
      const first = ResultFlow.from(N.ok(1));
      const second = ResultFlow.from(N.ok(2));
      const flows = Object.freeze([first, second] as const);
      const raced = ResultFlow.race(flows);

      deepEqual(flows, [first, second]);
      deepEqual(await first.run(), N.ok(1));
      deepEqual(await second.run(), N.ok(2));
      deepEqual(await raced.run(), N.ok(1));
      deepEqual(flows, [first, second]);
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

    it('should access the context', async () => {
      const resultFlow = ResultFlow.of<number, never, Context>(async () => {
        return 10;
      });
      const mockFn = mock.fn();
      const add10 = (n: number, extras: {context: Context}) => {
        mockFn(extras);
        return n + 10;
      }

      const result = await resultFlow.map(add10).run({ context });
      deepEqual(mockFn.mock.calls[0]?.arguments, [{context}]);
      const value = result._unsafeUnwrap();
      deepEqual(value, 20);
    });

    it('should reject when the map callback throws', async () => {
      const resultFlow = ResultFlow.from<number, never>(N.ok(10)).map(() => {
        throw new Error('map failed');
      });

      await rejects(() => resultFlow.run(), /map failed/);
    });
  });

  describe('mapBoth', () => {
    it('maps the success value when the flow succeeds', async () => {
      const result = await ResultFlow
        .from<number, string>(N.ok(10))
        .mapBoth({
          ok: (value) => value + 5,
          err: (error) => error.length,
        })
        .run();

      deepEqual(result, N.ok(15));
    });

    it('does not call err handler when the flow succeeds', async () => {
      const err = mock.fn((error: string) => error.length);

      const result = await ResultFlow
        .from<number, string>(N.ok(10))
        .mapBoth({
          ok: (value) => value + 5,
          err,
        })
        .run();

      deepEqual(result, N.ok(15));
      strictEqual(err.mock.callCount(), 0);
    });

    it('maps the error value when the flow fails', async () => {
      const result = await ResultFlow
        .from<number, string>(N.err('error'))
        .mapBoth({
          ok: (value) => value + 5,
          err: (error) => ({ code: error, retryable: false }),
        })
        .run();

      deepEqual(result, N.err({ code: 'error', retryable: false }));
    });

    it('does not call ok handler when the flow fails', async () => {
      const ok = mock.fn((value: number) => value + 5);

      const result = await ResultFlow
        .from<number, string>(N.err('error'))
        .mapBoth({
          ok,
          err: (error) => ({ code: error }),
        })
        .run();

      deepEqual(result, N.err({ code: 'error' }));
      strictEqual(ok.mock.callCount(), 0);
    });

    it('passes context to the selected handler', async () => {
      const ok = mock.fn((value: number, extras: { context: Context }) => {
        return `${extras.context.userId}:${value}`;
      });
      const err = mock.fn((error: string, extras: { context: Context }) => {
        return `${extras.context.correlationId}:${error}`;
      });

      const successResult = await ResultFlow
        .from<number, string, Context>(N.ok(10))
        .mapBoth({ ok, err })
        .run({ context });
      const errorResult = await ResultFlow
        .from<number, string, Context>(N.err('error'))
        .mapBoth({ ok, err })
        .run({ context });

      deepEqual(successResult, N.ok('test-user-id:10'));
      deepEqual(errorResult, N.err('test-correlation-id:error'));
      deepEqual(ok.mock.calls[0]?.arguments, [10, { context }]);
      deepEqual(err.mock.calls[0]?.arguments, ['error', { context }]);
    });

    it('passes abortSignal to the selected handler', async () => {
      const abortController = new AbortController();

      const result = await ResultFlow
        .from<number, string>(N.ok(10))
        .mapBoth({
          ok: (_value, extras) => extras.abortSignal,
          err: () => undefined,
        })
        .run({ abortSignal: abortController.signal });

      strictEqual(result._unsafeUnwrap(), abortController.signal);
    });

    it('is immutable', async () => {
      const original = ResultFlow.from<number, string>(N.ok(10));
      const mapped = original.mapBoth({
        ok: (value) => value + 5,
        err: (error) => error.length,
      });

      deepEqual(await original.run(), N.ok(10));
      deepEqual(await mapped.run(), N.ok(15));
    });

    it('rejects when the underlying flow throws', async () => {
      const ok = mock.fn();
      const err = mock.fn();
      const resultFlow = ResultFlow.of<number, string>(async () => {
        throw new Error('underlying failed');
      }).mapBoth({ ok, err });

      await rejects(() => resultFlow.run(), /underlying failed/);
      strictEqual(ok.mock.callCount(), 0);
      strictEqual(err.mock.callCount(), 0);
    });

    it('rejects when the selected success handler throws', async () => {
      const resultFlow = ResultFlow.from<number, string>(N.ok(10)).mapBoth({
        ok: () => {
          throw new Error('ok failed');
        },
        err: (error) => error.length,
      });

      await rejects(() => resultFlow.run(), /ok failed/);
    });

    it('rejects when the selected error handler throws', async () => {
      const resultFlow = ResultFlow.from<number, string>(N.err('error')).mapBoth({
        ok: (value) => value + 5,
        err: () => {
          throw new Error('err failed');
        },
      });

      await rejects(() => resultFlow.run(), /err failed/);
    });

    it('returns a flow with mapped success and error types', async () => {
      const flow: ResultFlow<string, { code: string }> = ResultFlow
        .from<number, string>(N.ok(10))
        .mapBoth({
          ok: (value) => value.toString(),
          err: (error) => ({ code: error }),
        });

      deepEqual(await flow.run(), N.ok('10'));
    });
  });

  describe('ensure', () => {
    it('should return the original success value when the predicate returns true', async () => {
      const result = await ResultFlow
        .from<number, never>(N.ok(10))
        .ensure((value) => value === 10, () => 'too-small')
        .run();

      deepEqual(result, N.ok(10));
    });

    it('should return the new failure when the predicate returns false', async () => {
      const result = await ResultFlow
        .from<number, 'original-error'>(N.ok(10))
        .ensure((value) => value > 10, (value) => ({ reason: 'too-small' as const, value }))
        .run();

      deepEqual(result, N.err({ reason: 'too-small', value: 10 }));
    });

    it('should skip the predicate and onFailure when the current flow is a failure', async () => {
      const predicate = mock.fn((_value: number) => true);
      const onFailure = mock.fn((_value: number) => 'new-error');

      const result = await ResultFlow
        .from<number, 'original-error'>(N.err('original-error'))
        .ensure(predicate, onFailure)
        .run();

      deepEqual(result, N.err('original-error'));
      deepEqual(predicate.mock.callCount(), 0);
      deepEqual(onFailure.mock.callCount(), 0);
    });

    it('should support an async predicate', async () => {
      const result = await ResultFlow
        .from<number, never>(N.ok(10))
        .ensure(async (value) => value === 10, () => 'invalid')
        .run();

      deepEqual(result, N.ok(10));
    });

    it('should support an async onFailure', async () => {
      const result = await ResultFlow
        .from<number, never>(N.ok(10))
        .ensure(
          () => false,
          async (value) => ({ reason: 'invalid' as const, value }),
        )
        .run();

      deepEqual(result, N.err({ reason: 'invalid', value: 10 }));
    });

    it('should pass context to predicate and onFailure', async () => {
      const predicate = mock.fn((value: number, extras: { context: Context }) => {
        return value === 10 && extras.context.correlationId === context.correlationId;
      });
      const onFailure = mock.fn((value: number, extras: { context: Context }) => {
        return `${extras.context.userId}:${value}`;
      });

      const result = await ResultFlow
        .from<number, string, Context>(N.ok(5))
        .ensure(predicate, onFailure)
        .run({ context });

      deepEqual(result, N.err('test-user-id:5'));
      deepEqual(predicate.mock.calls[0]?.arguments, [5, { context }]);
      deepEqual(onFailure.mock.calls[0]?.arguments, [5, { context }]);
    });

    it('should be immutable', async () => {
      const r1 = ResultFlow.from<number, string>(N.ok(10));
      const r2 = r1.ensure((value) => value > 10, () => 'too-small');

      deepEqual(await r1.run(), N.ok(10));
      deepEqual(await r2.run(), N.err('too-small'));
    });

    it('should reject when the predicate throws', async () => {
      const resultFlow = ResultFlow.from<number, never>(N.ok(10)).ensure(() => {
        throw new Error('predicate failed');
      }, () => 'invalid');

      await rejects(() => resultFlow.run(), /predicate failed/);
    });

    it('should reject when the predicate rejects', async () => {
      const resultFlow = ResultFlow.from<number, never>(N.ok(10)).ensure(
        async () => Promise.reject(new Error('predicate rejected')),
        () => 'invalid',
      );

      await rejects(() => resultFlow.run(), /predicate rejected/);
    });

    it('should reject when onFailure throws', async () => {
      const resultFlow = ResultFlow.from<number, never>(N.ok(10)).ensure(() => false, () => {
        throw new Error('onFailure failed');
      });

      await rejects(() => resultFlow.run(), /onFailure failed/);
    });

    it('should reject when onFailure rejects', async () => {
      const resultFlow = ResultFlow.from<number, never>(N.ok(10)).ensure(
        () => false,
        async () => Promise.reject(new Error('onFailure rejected')),
      );

      await rejects(() => resultFlow.run(), /onFailure rejected/);
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

    it('should access the context', async () => {
      const mockFn = mock.fn();
      const r = await ResultFlow
      .from<string, string, Context>(N.err('error'))
      .mapError((error, extras: {context: Context}) => {
        mockFn(extras);
        return `${error} - transformed`;
      })
      .run({ context });
      deepEqual(mockFn.mock.calls[0]?.arguments, [{context}]);
      deepEqual(r, N.err('error - transformed'));
    });

    it('should reject when the mapError callback throws', async () => {
      const resultFlow = ResultFlow.from<number, string>(N.err('error')).mapError(() => {
        throw new Error('mapError failed');
      });

      await rejects(() => resultFlow.run(), /mapError failed/);
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
      const r2 = r1.chain((n) => N.ok(n + 10));

      deepEqual((await r1.run())._unsafeUnwrap(), 10);
      deepEqual((await r2.run())._unsafeUnwrap(), 20);
    });

    it('should access the context', async () => {
      const mockFn = mock.fn();
      const resultFlow = ResultFlow.of<number, never, Context>(async () => {
        return 10;
      });
      const add10 = (n: number, extras: {context: Context}) => {
        mockFn(extras);
        return ResultFlow.of<number, never>(async () => {
          return n + 10;
        });
      };
      const result = await resultFlow.chain(add10).run({ context });
      const value = result._unsafeUnwrap();
      deepEqual(mockFn.mock.calls[0]?.arguments, [{context}]);
      deepEqual(value, 20);
    });

    it('should pass context to a ResultFlow returned by the callback', async () => {
      const innerMock = mock.fn();
      const resultFlow = ResultFlow.from<number, never, Context>(N.ok(10))
        .chain((n) => ResultFlow.of<number, never, Context>(async (_, extras) => {
          innerMock(extras);
          return n + 10;
        }));

      const result = await resultFlow.run({ context });

      deepEqual(result._unsafeUnwrap(), 20);
      deepEqual(innerMock.mock.calls[0]?.arguments, [{ context }]);
    });

    it('should reject when the chain callback throws', async () => {
      const resultFlow = ResultFlow.from<number, never>(N.ok(10)).chain(() => {
        throw new Error('chain failed');
      });

      await rejects(() => resultFlow.run(), /chain failed/);
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

      deepEqual(effect.mock.calls[0]?.arguments, [10, { context: {} }]);
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
      const r2 = r1.ifSuccess(() => {
        counter++;
      });

      await r1.run();
      await r2.run();
      deepEqual(counter, 1);
    });

    it('should access the context', async () => {
      const resultFlow = ResultFlow.of<number, never, Context>(async () => {
        return 10;
      });
      const effect = mock.fn();
      const result = await resultFlow.ifSuccess(effect).run({ context });
      const value = result._unsafeUnwrap();

      deepEqual(effect.mock.calls[0]?.arguments, [10, { context }]);
      deepEqual(value, 10);
    });

    it('should reject when the effect throws', async () => {
      const resultFlow = ResultFlow.from<number, never>(N.ok(10)).ifSuccess(() => {
        throw new Error('ifSuccess failed');
      });

      await rejects(() => resultFlow.run(), /ifSuccess failed/);
    });

    it('should support async effects', async () => {
      let effectCompleted = false;
      const resultFlow = ResultFlow.from<number, never>(N.ok(10));

      const result = await resultFlow.ifSuccess(async () => {
        await sleep(0);
        effectCompleted = true;
      }).run();

      deepEqual(result._unsafeUnwrap(), 10);
      deepEqual(effectCompleted, true);
    });

    it('should reject when the effect rejects', async () => {
      const resultFlow = ResultFlow.from<number, never>(N.ok(10)).ifSuccess(async () => {
        throw new Error('ifSuccess rejected');
      });

      await rejects(() => resultFlow.run(), /ifSuccess rejected/);
    });
  });

  describe('tap', () => {
    it('should execute the effect when it is a success', async () => {
      const resultFlow = ResultFlow.of<number, never, Context>(async () => {
        return 10;
      });
      const effect = mock.fn();
      const result = await resultFlow.tap(effect).run({ context });
      const value = result._unsafeUnwrap();

      deepEqual(effect.mock.calls[0]?.arguments, [10, { context }]);
      deepEqual(value, 10);
    });

    it('should not execute the effect when it is a failure', async () => {
      const resultFlow = ResultFlow.of<number, 'error'>(async ({ fail }) => {
        fail('error');
        return 10;
      });
      const effect = mock.fn();
      const result = await resultFlow.tap(effect).run();
      const value = result._unsafeUnwrapErr();

      deepEqual(effect.mock.callCount(), 0);
      deepEqual(value, 'error');
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
      deepEqual(effect.mock.calls[0]?.arguments, ['error', { context: {} }]);
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
      const r2 = r1.ifFailure(() => {
        counter++;
      });

      await r1.run();
      await r2.run();
      deepEqual(counter, 1);
    });

    it('should access the context', async () => {
      const resultFlow = ResultFlow.of<number, string, Context>(async ({ fail }) => {
        fail('error');
        return 10;
      });
      const effect = mock.fn();
      await resultFlow.ifFailure(effect).run({ context });

      deepEqual(effect.mock.calls[0]?.arguments, ['error', { context }]);
    });

    it('should reject when the effect throws', async () => {
      const resultFlow = ResultFlow.from<number, string>(N.err('error')).ifFailure(() => {
        throw new Error('ifFailure failed');
      });

      await rejects(() => resultFlow.run(), /ifFailure failed/);
    });

    it('should support async effects', async () => {
      let effectCompleted = false;
      const resultFlow = ResultFlow.from<number, string>(N.err('error'));

      const result = await resultFlow.ifFailure(async () => {
        await sleep(0);
        effectCompleted = true;
      }).run();

      deepEqual(result._unsafeUnwrapErr(), 'error');
      deepEqual(effectCompleted, true);
    });

    it('should reject when the effect rejects', async () => {
      const resultFlow = ResultFlow.from<number, string>(N.err('error')).ifFailure(async () => {
        throw new Error('ifFailure rejected');
      });

      await rejects(() => resultFlow.run(), /ifFailure rejected/);
    });
  });

  describe('tapError', () => {
    it('should execute the effect when it is a failure', async () => {
      const resultFlow = ResultFlow.of<number, 'error', Context>(async ({ fail }) => {
        fail('error');
        return 10;
      });
      const effect = mock.fn();
      const result = await resultFlow.tapError(effect).run({ context });
      const value = result._unsafeUnwrapErr();

      deepEqual(value, 'error');
      deepEqual(effect.mock.calls[0]?.arguments, ['error', { context }]);
    });

    it('should not execute the effect when it is a success', async () => {
      const resultFlow = ResultFlow.of<number, never>(async () => {
        return 10;
      });
      const effect = mock.fn();
      const result = await resultFlow.tapError(effect).run();
      const value = result._unsafeUnwrap();

      deepEqual(value, 10);
      deepEqual(effect.mock.callCount(), 0);
    });
  });

  describe('finally', () => {
    it('should call the effect with the Ok result when the flow succeeds', async () => {
      const resultFlow = ResultFlow.from<number, never>(N.ok(10));
      const effect = mock.fn();

      await resultFlow.finally(effect).run();

      deepEqual(effect.mock.calls[0]?.arguments, [N.ok(10), { context: {} }]);
    });

    it('should return the original success value unchanged', async () => {
      const value = { id: 1, name: 'test' };
      const resultFlow = ResultFlow.from<typeof value, never>(N.ok(value));

      const result = await resultFlow.finally(() => undefined).run();

      strictEqual(result._unsafeUnwrap(), value);
    });

    it('should call the effect with the Err result when the flow fails', async () => {
      const resultFlow = ResultFlow.from<number, string>(N.err('error'));
      const effect = mock.fn();

      await resultFlow.finally(effect).run();

      deepEqual(effect.mock.calls[0]?.arguments, [N.err('error'), { context: {} }]);
    });

    it('should return the original failure unchanged', async () => {
      const error = { reason: 'not-found' as const };
      const resultFlow = ResultFlow.from<number, typeof error>(N.err(error));

      const result = await resultFlow.finally(() => undefined).run();

      strictEqual(result._unsafeUnwrapErr(), error);
    });

    it('should pass context to the effect', async () => {
      const resultFlow = ResultFlow.from<number, never, Context>(N.ok(10));
      const effect = mock.fn();

      await resultFlow.finally(effect).run({ context });

      deepEqual(effect.mock.calls[0]?.arguments, [N.ok(10), { context }]);
    });

    it('should support async effects', async () => {
      let effectCompleted = false;
      const resultFlow = ResultFlow.from<number, never>(N.ok(10));

      const result = await resultFlow.finally(async () => {
        await sleep(0);
        effectCompleted = true;
      }).run();

      deepEqual(result._unsafeUnwrap(), 10);
      deepEqual(effectCompleted, true);
    });

    it('should be immutable', async () => {
      const effect = mock.fn();
      const r1 = ResultFlow.from(N.ok(10));
      const r2 = r1.finally(effect);

      deepEqual(await r1.run(), N.ok(10));
      deepEqual(effect.mock.callCount(), 0);

      deepEqual(await r2.run(), N.ok(10));
      deepEqual(effect.mock.callCount(), 1);
    });

    it('should reject when the effect throws', async () => {
      const resultFlow = ResultFlow.from<number, never>(N.ok(10)).finally(() => {
        throw new Error('finally failed');
      });

      await rejects(() => resultFlow.run(), /finally failed/);
    });

    it('should reject when the effect rejects', async () => {
      const resultFlow = ResultFlow.from<number, never>(N.ok(10)).finally(async () => {
        throw new Error('finally rejected');
      });

      await rejects(() => resultFlow.run(), /finally rejected/);
    });

    it('should not call the effect when the original flow throws or rejects', async () => {
      const effect = mock.fn();
      const throwingFlow = ResultFlow.of<number, never>(async () => {
        throw new Error('original flow threw');
      }).finally(effect);
      const rejectingFlow = ResultFlow.from<number, never>(() =>
        Promise.reject(new Error('original flow rejected')),
      ).finally(effect);

      await rejects(() => throwingFlow.run(), /original flow threw/);
      await rejects(() => rejectingFlow.run(), /original flow rejected/);
      deepEqual(effect.mock.callCount(), 0);
    });
  });

  describe('tapBoth', () => {
    it('should be an alias for finally', async () => {
      const resultFlow = ResultFlow.from<number, string>(N.err('error'));
      const effect = mock.fn();

      const result = await resultFlow.tapBoth(effect).run();

      deepEqual(result, N.err('error'));
      deepEqual(effect.mock.calls[0]?.arguments, [N.err('error'), { context: {} }]);
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

    it('should access the context', async () => {
      const mockFn = mock.fn();
      const resultFlow = ResultFlow.from<number, string, Context>(N.err('error'));
      const alternativeResultFlow = (error: string, extras: {context: Context}) => {
        mockFn(extras);
        return ResultFlow.from(N.ok(20));
      };
      const result = await resultFlow.orElse(alternativeResultFlow).run({ context });
      const value = result._unsafeUnwrap();

      deepEqual(mockFn.mock.calls[0]?.arguments, [{context}]);
      deepEqual(value, 20);
    });

    it('should preserve failures returned by the alternative', async () => {
      deepEqual(
        await ResultFlow.from<number, string>(N.err('error'))
          .orElse(() => ResultFlow.from<number, 'recovery-error'>(N.err('recovery-error')))
          .run(),
        N.err('recovery-error'),
      );
      deepEqual(
        await ResultFlow.from<number, string>(N.err('error'))
          .orElse(() => Promise.resolve(N.err<number, 'recovery-error'>('recovery-error')))
          .run(),
        N.err('recovery-error'),
      );
      deepEqual(
        await ResultFlow.from<number, string>(N.err('error'))
          .orElse(() => N.err<number, 'recovery-error'>('recovery-error'))
          .run(),
        N.err('recovery-error'),
      );
      deepEqual(
        await ResultFlow.from<number, string>(N.err('error'))
          .orElse(() => N.errAsync<number, 'recovery-error'>('recovery-error'))
          .run(),
        N.err('recovery-error'),
      );
    });

    it('should reject when the alternative throws', async () => {
      const resultFlow = ResultFlow.from<number, string>(N.err('error')).orElse(() => {
        throw new Error('orElse failed');
      });

      await rejects(() => resultFlow.run(), /orElse failed/);
    });
  });

  describe('recover', () => {
    it('should not call the fallback when the flow succeeds', async () => {
      const fallback = mock.fn(() => 20);

      await ResultFlow.from<number, 'error'>(N.ok(10)).recover(fallback).run();

      deepEqual(fallback.mock.callCount(), 0);
    });

    it('should return the original success value unchanged', async () => {
      const value = { count: 10 };

      const result = await ResultFlow.from<typeof value, 'error'>(N.ok(value))
        .recover(() => ({ count: 20 }))
        .run();

      strictEqual(result._unsafeUnwrap(), value);
    });

    it('should call the fallback when the flow fails', async () => {
      const fallback = mock.fn((error: string) => `${error}-recovered`);

      await ResultFlow.from<number, string>(N.err('error')).recover(fallback).run();

      deepEqual(fallback.mock.calls[0]?.arguments, ['error', { context: {} }]);
    });

    it('should turn the fallback value into an Ok', async () => {
      const result = await ResultFlow.from<number, string>(N.err('error'))
        .recover(() => 20)
        .run();

      deepEqual(result, N.ok(20));
    });

    it('should support async fallback functions', async () => {
      const result = await ResultFlow.from<number, string>(N.err('error'))
        .recover(async () => 20)
        .run();

      deepEqual(result, N.ok(20));
    });

    it('should pass context to the fallback', async () => {
      const fallback = mock.fn((error: string, extras: { context: Context }) => {
        return `${extras.context.userId}:${error}`;
      });

      const result = await ResultFlow.from<number, string, Context>(N.err('error'))
        .recover(fallback)
        .run({ context });

      deepEqual(result, N.ok('test-user-id:error'));
      deepEqual(fallback.mock.calls[0]?.arguments, ['error', { context }]);
    });

    it('should be immutable', async () => {
      const r1 = ResultFlow.from<number, string>(N.err('error'));
      const r2 = r1.recover(() => 10);

      deepEqual(await r1.run(), N.err('error'));
      deepEqual(await r2.run(), N.ok(10));
    });

    it('should reject when the fallback throws', async () => {
      const resultFlow = ResultFlow.from<number, string>(N.err('error')).recover(() => {
        throw new Error('recover failed');
      });

      await rejects(() => resultFlow.run(), /recover failed/);
    });

    it('should reject when the fallback rejects', async () => {
      const resultFlow = ResultFlow.from<number, string>(N.err('error')).recover(async () => {
        throw new Error('recover rejected');
      });

      await rejects(() => resultFlow.run(), /recover rejected/);
    });

    it('should not call the fallback when the original flow throws or rejects', async () => {
      const throwingFallback = mock.fn(() => 20);
      const rejectingFallback = mock.fn(() => 20);
      const throwingFlow = ResultFlow.of<number, never>(async () => {
        throw new Error('flow threw');
      }).recover(throwingFallback);
      const rejectingFlow = ResultFlow.from<number, string>(() =>
        Promise.reject(new Error('flow rejected')),
      ).recover(rejectingFallback);

      await rejects(() => throwingFlow.run(), /flow threw/);
      await rejects(() => rejectingFlow.run(), /flow rejected/);
      deepEqual(throwingFallback.mock.callCount(), 0);
      deepEqual(rejectingFallback.mock.callCount(), 0);
    });

    it('should remove the error type', async () => {
      const flow = ResultFlow.from<number, 'error'>(N.err('error')).recover(() => 'fallback' as const);
      const typedFlow: ResultFlow<number | 'fallback', never> = flow;

      const result = await typedFlow.run();

      deepEqual(result, N.ok('fallback'));
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

      it('should wait according to the retry strategy before retrying', async (testContext: TestContext) => {
        const setTimeoutMock = testContext.mock.method(globalThis, 'setTimeout', (callback: () => void) => {
          callback();
          return 0 as unknown as ReturnType<typeof setTimeout>;
        });
        const numberOfFailures = 2;
        const mockAction = mock.fn(
          () => N.ok(success),
          () => N.err(defaultError),
          { times: numberOfFailures },
        );
        const resultFlow = ResultFlow.from(mockAction).retryPolicy({
          maxRetries: numberOfFailures,
          retryStrategy: {
            type: 'exponentialBackoff',
            baseDelayMs: 100,
          },
        });

        const result = await resultFlow.run();

        deepEqual(mockAction.mock.callCount(), 3);
        deepEqual(setTimeoutMock.mock.callCount(), 2);
        deepEqual(setTimeoutMock.mock.calls[0]?.arguments[1], 100);
        deepEqual(setTimeoutMock.mock.calls[1]?.arguments[1], 200);
        deepEqual(result._unsafeUnwrap(), success);
      });

      it('should reject when beforeRetry rejects', async () => {
        const beforeRetryMock = mock.fn(async () => {
          throw new Error('beforeRetry failed');
        });
        const mockAction = mock.fn(() => N.err(defaultError));
        const resultFlow = ResultFlow.from(mockAction).retryPolicy({
          maxRetries: 2,
          beforeRetry: beforeRetryMock,
        });

        await rejects(() => resultFlow.run(), /beforeRetry failed/);
        deepEqual(mockAction.mock.callCount(), 1);
        deepEqual(beforeRetryMock.mock.callCount(), 1);
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

      it('should reject when the condition throws', async () => {
        const condition = mock.fn(() => {
          throw new Error('condition failed');
        });
        const beforeRetryMock = mock.fn();
        const mockAction = mock.fn(() => N.err(defaultError));
        const resultFlow = ResultFlow.from(mockAction).retryPolicy({
          maxRetries: 2,
          beforeRetry: beforeRetryMock,
          condition,
        });

        await rejects(() => resultFlow.run(), /condition failed/);
        deepEqual(mockAction.mock.callCount(), 1);
        deepEqual(condition.mock.callCount(), 1);
        deepEqual(beforeRetryMock.mock.callCount(), 0);
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

    it('should access the context', async () => {
      const beforeRetryMock = mock.fn();
      const n = 2;
      const resultFlow = ResultFlow.from<number, string, Context>(N.err(defaultError));
      const resultFlowWithRetry = resultFlow.retryPolicy({
        maxRetries: n,
        beforeRetry: beforeRetryMock,
      });
      await resultFlowWithRetry.run({ context });

      for (let i = 1; i <= n; i++) {
        deepEqual(beforeRetryMock.mock.calls[i - 1]?.arguments[0], defaultError);
        deepEqual(beforeRetryMock.mock.calls[i - 1]?.arguments[1], i);
        deepEqual(beforeRetryMock.mock.calls[i - 1]?.arguments[2], { context });
      }
    });
  });

  describe('repeatUntil', () => {
    it('should return the first Ok(value) immediately when predicate returns true', async () => {
      const action = mock.fn(() => N.ok(10));
      const predicate = mock.fn(() => true);
      const beforeRepeat = mock.fn();

      const result = await ResultFlow.from(action)
        .repeatUntil({
          predicate,
          onExhausted: () => 'exhausted' as const,
          beforeRepeat,
          maxRepeats: 3,
        })
        .run();

      deepEqual(result, N.ok(10));
      deepEqual(action.mock.callCount(), 1);
      deepEqual(predicate.mock.callCount(), 1);
      deepEqual(beforeRepeat.mock.callCount(), 0);
    });

    it('should repeat when predicate returns false', async () => {
      const action = mock.fn(() => N.ok('pending' as const));

      const result = await ResultFlow.from(action)
        .repeatUntil({
          predicate: () => false,
          onExhausted: (lastValue) => ({ reason: 'not-ready' as const, lastValue }),
          maxRepeats: 2,
        })
        .run();

      deepEqual(action.mock.callCount(), 3);
      deepEqual(result, N.err({ reason: 'not-ready', lastValue: 'pending' }));
    });

    it('should return a later Ok(value) when predicate eventually returns true', async () => {
      const values = ['pending', 'pending', 'done'] as const;
      let index = 0;
      const action = mock.fn(() => N.ok(values[index++]));

      const result = await ResultFlow.from(action)
        .repeatUntil({
          predicate: (value) => value === 'done',
          onExhausted: () => 'exhausted' as const,
          maxRepeats: 3,
        })
        .run();

      deepEqual(result, N.ok('done'));
      deepEqual(action.mock.callCount(), 3);
    });

    it('should return the original Err(error) immediately and not repeat', async () => {
      const action = mock.fn(() => N.err('original-error' as const));
      const predicate = mock.fn(() => false);
      const onExhausted = mock.fn(() => 'exhausted' as const);
      const beforeRepeat = mock.fn();

      const result = await ResultFlow.from(action)
        .repeatUntil({
          predicate,
          onExhausted,
          beforeRepeat,
          maxRepeats: 3,
        })
        .run();

      deepEqual(result, N.err('original-error'));
      deepEqual(action.mock.callCount(), 1);
      deepEqual(predicate.mock.callCount(), 0);
      deepEqual(beforeRepeat.mock.callCount(), 0);
      deepEqual(onExhausted.mock.callCount(), 0);
    });

    it('should call onExhausted(lastValue, extras) and return its error when repeats are exhausted', async () => {
      let attempt = 0;
      const onExhausted: Mock<(lastValue: string, extras: { context: Record<never, never> }) => { reason: 'not-ready'; lastValue: string }> = mock.fn(
        (lastValue) => ({ reason: 'not-ready', lastValue }),
      );

      const result = await ResultFlow.from<string, never>(() => {
        attempt += 1;
        return N.ok(attempt === 1 ? 'first' : 'last');
      })
        .repeatUntil({
          predicate: () => false,
          onExhausted,
          maxRepeats: 1,
        })
        .run();

      deepEqual(result, N.err({ reason: 'not-ready', lastValue: 'last' }));
      deepEqual(onExhausted.mock.calls[0]?.arguments[0], 'last');
      deepEqual(onExhausted.mock.calls[0]?.arguments[1], { context: {} });
    });

    it('should support async predicate', async () => {
      const result = await ResultFlow.from(N.ok('done'))
        .repeatUntil({
          predicate: async (value) => value === 'done',
          onExhausted: () => 'exhausted' as const,
        })
        .run();

      deepEqual(result, N.ok('done'));
    });

    it('should support async beforeRepeat', async () => {
      const events: string[] = [];
      let attempt = 0;

      const result = await ResultFlow.from(() => {
        attempt += 1;
        events.push(`run-${attempt}`);
        return N.ok(attempt);
      })
        .repeatUntil({
          predicate: (value) => value === 2,
          beforeRepeat: async (value, repeatNumber) => {
            await sleep(0);
            events.push(`before-${repeatNumber}-${value}`);
          },
          onExhausted: () => 'exhausted' as const,
        })
        .run();

      deepEqual(result, N.ok(2));
      deepEqual(events, ['run-1', 'before-1-1', 'run-2']);
    });

    it('should support async onExhausted', async () => {
      const result = await ResultFlow.from(N.ok('pending'))
        .repeatUntil({
          predicate: () => false,
          onExhausted: async (lastValue) => ({ reason: 'not-ready' as const, lastValue }),
          maxRepeats: 0,
        })
        .run();

      deepEqual(result, N.err({ reason: 'not-ready', lastValue: 'pending' }));
    });

    it('should call beforeRepeat before each repeat with repeat numbers starting at 1', async () => {
      const beforeRepeat = mock.fn();

      await ResultFlow.from(N.ok('pending'))
        .repeatUntil({
          predicate: () => false,
          beforeRepeat,
          onExhausted: () => 'exhausted' as const,
          maxRepeats: 3,
        })
        .run();

      deepEqual(beforeRepeat.mock.callCount(), 3);
      deepEqual(beforeRepeat.mock.calls.map((call) => call.arguments[1]), [1, 2, 3]);
    });

    it('should use the immediate delay strategy by default', async (testContext: TestContext) => {
      const setTimeoutMock = testContext.mock.method(globalThis, 'setTimeout', (callback: () => void) => {
        callback();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      });

      const result = await ResultFlow.from(N.ok('pending'))
        .repeatUntil({
          predicate: () => false,
          onExhausted: () => 'exhausted' as const,
          maxRepeats: 2,
        })
        .run();

      deepEqual(result, N.err('exhausted'));
      deepEqual(setTimeoutMock.mock.callCount(), 0);
    });

    it('should wait according to exponentialBackoff delay strategy when provided', async (testContext: TestContext) => {
      const setTimeoutMock = testContext.mock.method(globalThis, 'setTimeout', (callback: () => void) => {
        callback();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      });
      let attempt = 0;

      const result = await ResultFlow.from(() => {
        attempt += 1;
        return N.ok(attempt);
      })
        .repeatUntil({
          predicate: (value) => value === 3,
          onExhausted: () => 'exhausted' as const,
          maxRepeats: 2,
          delayStrategy: { type: 'exponentialBackoff', baseDelayMs: 100 },
        })
        .run();

      deepEqual(result, N.ok(3));
      deepEqual(setTimeoutMock.mock.callCount(), 2);
      deepEqual(setTimeoutMock.mock.calls[0]?.arguments[1], 100);
      deepEqual(setTimeoutMock.mock.calls[1]?.arguments[1], 200);
    });

    it('should run only once when maxRepeats is 0', async () => {
      const action = mock.fn(() => N.ok('pending' as const));

      const result = await ResultFlow.from(action)
        .repeatUntil({
          predicate: () => false,
          onExhausted: () => 'exhausted' as const,
          maxRepeats: 0,
        })
        .run();

      deepEqual(action.mock.callCount(), 1);
      deepEqual(result, N.err('exhausted'));
    });

    it('should repeat once by default for two total attempts', async () => {
      const action = mock.fn(() => N.ok('pending' as const));

      const result = await ResultFlow.from(action)
        .repeatUntil({
          predicate: () => false,
          onExhausted: () => 'exhausted' as const,
        })
        .run();

      deepEqual(action.mock.callCount(), 2);
      deepEqual(result, N.err('exhausted'));
    });

    it('should pass context to predicate, beforeRepeat, and onExhausted', async () => {
      const predicate: Mock<(value: number, extras: { context: Context }) => boolean> = mock.fn(() => false);
      const beforeRepeat: Mock<(value: number, repeatNumber: number, extras: { context: Context }) => void> = mock.fn();
      const onExhausted: Mock<(lastValue: number, extras: { context: Context }) => 'exhausted'> = mock.fn(() => 'exhausted' as const);

      await ResultFlow.from<number, never, Context>(N.ok(1))
        .repeatUntil({
          predicate,
          beforeRepeat,
          onExhausted,
          maxRepeats: 1,
        })
        .run({ context });

      deepEqual(predicate.mock.calls[0]?.arguments[1], { context });
      deepEqual(beforeRepeat.mock.calls[0]?.arguments[2], { context });
      deepEqual(onExhausted.mock.calls[0]?.arguments[1], { context });
    });

    it('should be lazy and not execute the original flow before .run()', () => {
      const action = mock.fn(() => N.ok('done' as const));

      ResultFlow.from(action)
        .repeatUntil({
          predicate: () => true,
          onExhausted: () => 'exhausted' as const,
        });

      deepEqual(action.mock.callCount(), 0);
    });

    it('should be immutable and not mutate the original flow', async () => {
      const base = ResultFlow.from(N.ok(1));
      const repeated = base.repeatUntil({
        predicate: () => false,
        onExhausted: () => 'exhausted' as const,
        maxRepeats: 0,
      });

      deepEqual(await base.run(), N.ok(1));
      deepEqual(await repeated.run(), N.err('exhausted'));
      deepEqual(await base.run(), N.ok(1));
    });

    it('should reject when the original flow throws or rejects', async () => {
      await rejects(
        () => ResultFlow.of<number, never>(async () => {
          throw new Error('flow threw');
        })
          .repeatUntil({
            predicate: () => true,
            onExhausted: () => 'exhausted' as const,
          })
          .run(),
        /flow threw/,
      );

      await rejects(
        () => ResultFlow.from<number, never>(() => Promise.reject(new Error('flow rejected')))
          .repeatUntil({
            predicate: () => true,
            onExhausted: () => 'exhausted' as const,
          })
          .run(),
        /flow rejected/,
      );
    });

    it('should reject when predicate throws or rejects', async () => {
      await rejects(
        () => ResultFlow.from(N.ok(1))
          .repeatUntil({
            predicate: () => {
              throw new Error('predicate failed');
            },
            onExhausted: () => 'exhausted' as const,
          })
          .run(),
        /predicate failed/,
      );

      await rejects(
        () => ResultFlow.from(N.ok(1))
          .repeatUntil({
            predicate: async () => {
              throw new Error('predicate rejected');
            },
            onExhausted: () => 'exhausted' as const,
          })
          .run(),
        /predicate rejected/,
      );
    });

    it('should reject when beforeRepeat throws or rejects', async () => {
      await rejects(
        () => ResultFlow.from(N.ok(1))
          .repeatUntil({
            predicate: () => false,
            beforeRepeat: () => {
              throw new Error('beforeRepeat failed');
            },
            onExhausted: () => 'exhausted' as const,
          })
          .run(),
        /beforeRepeat failed/,
      );

      await rejects(
        () => ResultFlow.from(N.ok(1))
          .repeatUntil({
            predicate: () => false,
            beforeRepeat: async () => {
              throw new Error('beforeRepeat rejected');
            },
            onExhausted: () => 'exhausted' as const,
          })
          .run(),
        /beforeRepeat rejected/,
      );
    });

    it('should reject when onExhausted throws or rejects', async () => {
      await rejects(
        () => ResultFlow.from(N.ok(1))
          .repeatUntil({
            predicate: () => false,
            onExhausted: () => {
              throw new Error('onExhausted failed');
            },
            maxRepeats: 0,
          })
          .run(),
        /onExhausted failed/,
      );

      await rejects(
        () => ResultFlow.from(N.ok(1))
          .repeatUntil({
            predicate: () => false,
            onExhausted: async () => {
              throw new Error('onExhausted rejected');
            },
            maxRepeats: 0,
          })
          .run(),
        /onExhausted rejected/,
      );
    });
  });

  describe('timeout', () => {
    it('should return the original success when the flow completes before the timeout', async (testContext: TestContext) => {
      testContext.mock.method(AbortSignal, 'timeout', () => new AbortController().signal);

      const result = await ResultFlow.from(N.ok(10))
        .timeout({
          ms: 100,
          onTimeout: () => 'timeout' as const,
        })
        .run();

      deepEqual(result._unsafeUnwrap(), 10);
    });

    it('should return the onTimeout error when the timeout wins', async (testContext: TestContext) => {
      const timeoutController = new AbortController();
      testContext.mock.method(AbortSignal, 'timeout', () => timeoutController.signal);
      const onTimeout = mock.fn(() => 'timeout' as const);
      const resultPromise = ResultFlow.of<never, never>(async () => {
        return new Promise<never>(() => undefined);
      })
        .timeout({
          ms: 100,
          onTimeout,
        })
        .run();

      await sleep(0);
      timeoutController.abort();

      const result = await resultPromise;
      deepEqual(result._unsafeUnwrapErr(), 'timeout');
      deepEqual(onTimeout.mock.callCount(), 1);
    });

    it('should pass context and the composed abortSignal to onTimeout', async (testContext: TestContext) => {
      const timeoutController = new AbortController();
      const parentController = new AbortController();
      let composedSignal: AbortSignal | undefined;
      const originalAbortSignalAny = AbortSignal.any;
      testContext.mock.method(AbortSignal, 'timeout', () => timeoutController.signal);
      testContext.mock.method(AbortSignal, 'any', (signals: AbortSignal[]) => {
        composedSignal = originalAbortSignalAny(signals);
        return composedSignal;
      });
      const onTimeout = mock.fn(() => 'timeout' as const);
      const resultPromise = ResultFlow.of<never, never, Context>(async () => {
        return new Promise<never>(() => undefined);
      })
        .timeout({
          ms: 100,
          onTimeout,
        })
        .run({ context, abortSignal: parentController.signal });

      await sleep(0);
      timeoutController.abort();
      await resultPromise;

      deepEqual(onTimeout.mock.calls[0]?.arguments, [{ context, abortSignal: composedSignal }]);
    });

    it('should pass a signal that flow bodies can observe aborting on timeout', async (testContext: TestContext) => {
      const timeoutController = new AbortController();
      testContext.mock.method(AbortSignal, 'timeout', () => timeoutController.signal);
      const abortObserved = mock.fn();
      const resultPromise = ResultFlow.of<never, never>(async (_helpers, { abortSignal }) => {
        abortSignal?.addEventListener('abort', abortObserved, { once: true });
        return new Promise<never>(() => undefined);
      })
        .timeout({
          ms: 100,
          onTimeout: () => 'timeout' as const,
        })
        .run();

      await sleep(0);
      timeoutController.abort();

      const result = await resultPromise;
      deepEqual(result._unsafeUnwrapErr(), 'timeout');
      deepEqual(abortObserved.mock.callCount(), 1);
    });

    it('should compose an existing upstream abortSignal into the signal passed to the flow', async (testContext: TestContext) => {
      const timeoutController = new AbortController();
      const parentController = new AbortController();
      testContext.mock.method(AbortSignal, 'timeout', () => timeoutController.signal);
      const onTimeout = mock.fn(() => 'timeout' as const);
      const resultPromise = ResultFlow.of<'aborted', never>(async (_helpers, { abortSignal }) => {
        return new Promise<'aborted'>((resolve) => {
          abortSignal?.addEventListener('abort', () => resolve('aborted'), { once: true });
        });
      })
        .timeout({
          ms: 100,
          onTimeout,
        })
        .run({ abortSignal: parentController.signal });

      await sleep(0);
      parentController.abort();

      const result = await resultPromise;
      deepEqual(result._unsafeUnwrap(), 'aborted');
      deepEqual(onTimeout.mock.callCount(), 0);
    });

    it('should not call onTimeout when an upstream signal aborts first', async (testContext: TestContext) => {
      const timeoutController = new AbortController();
      const parentController = new AbortController();
      const upstreamAbortError = new Error('upstream aborted');
      testContext.mock.method(AbortSignal, 'timeout', () => timeoutController.signal);
      const onTimeout = mock.fn(() => 'timeout' as const);
      const resultFlow = ResultFlow.of<never, never>(async (_helpers, { abortSignal }) => {
        return new Promise<never>((_resolve, reject) => {
          abortSignal?.addEventListener('abort', () => reject(upstreamAbortError), { once: true });
        });
      })
        .timeout({
          ms: 100,
          onTimeout,
        });
      const resultPromise = resultFlow.run({ abortSignal: parentController.signal });

      await sleep(0);
      parentController.abort();

      await rejects(() => resultPromise, /upstream aborted/);
      deepEqual(onTimeout.mock.callCount(), 0);
    });

    it('should call the onTimeout callback associated with the timeout signal that emitted', async (testContext: TestContext) => {
      const outerTimeoutController = new AbortController();
      const innerTimeoutController = new AbortController();
      let timeoutCallCount = 0;
      testContext.mock.method(AbortSignal, 'timeout', () => {
        timeoutCallCount += 1;
        return timeoutCallCount === 1
          ? outerTimeoutController.signal
          : innerTimeoutController.signal;
      });
      const innerOnTimeout = mock.fn(() => 'inner-timeout' as const);
      const outerOnTimeout = mock.fn(() => 'outer-timeout' as const);
      const resultPromise = ResultFlow.of<never, never>(async () => {
        return new Promise<never>(() => undefined);
      })
        .timeout({
          ms: 100,
          onTimeout: innerOnTimeout,
        })
        .timeout({
          ms: 200,
          onTimeout: outerOnTimeout,
        })
        .run();

      await sleep(0);
      innerTimeoutController.abort();

      const result = await resultPromise;
      deepEqual(result._unsafeUnwrapErr(), 'inner-timeout');
      deepEqual(innerOnTimeout.mock.callCount(), 1);
      deepEqual(outerOnTimeout.mock.callCount(), 0);
    });

    it('should timeout each retry attempt when timeout is applied before retryPolicy', async (testContext: TestContext) => {
      const firstTimeoutController = new AbortController();
      const secondTimeoutController = new AbortController();
      let timeoutCallCount = 0;
      testContext.mock.method(AbortSignal, 'timeout', () => {
        timeoutCallCount += 1;
        return timeoutCallCount === 1
          ? firstTimeoutController.signal
          : secondTimeoutController.signal;
      });
      const action = mock.fn(() => new Promise<Result<never, never>>(() => undefined));
      const resultPromise = ResultFlow.from(action)
        .timeout({
          ms: 100,
          onTimeout: () => 'timeout' as const,
        })
        .retryPolicy({ maxRetries: 1 })
        .run();

      await sleep(0);
      firstTimeoutController.abort();
      await sleep(0);
      secondTimeoutController.abort();

      const result = await resultPromise;
      deepEqual(result._unsafeUnwrapErr(), 'timeout');
      deepEqual(action.mock.callCount(), 2);
    });

    it('should timeout the whole retry sequence when timeout is applied after retryPolicy', async (testContext: TestContext) => {
      const timeoutController = new AbortController();
      testContext.mock.method(AbortSignal, 'timeout', () => timeoutController.signal);
      const action = mock.fn(() => N.err('failure' as const));
      const resultPromise = ResultFlow.from(action)
        .retryPolicy({
          maxRetries: 1,
          retryStrategy: { type: 'exponentialBackoff', baseDelayMs: 1000 },
        })
        .timeout({
          ms: 100,
          onTimeout: () => 'timeout' as const,
        })
        .run();

      await sleep(0);
      timeoutController.abort();

      const result = await resultPromise;
      deepEqual(result._unsafeUnwrapErr(), 'timeout');
      deepEqual(action.mock.callCount(), 1);
    });
  });

  describe('runPeriodically', () => {
    const error = 'error';
    const defaultInterval = 10;

    it('should repeat the flow until fails, and call `onInterruption` with the error', async (testContext: TestContext) => {
      testContext.mock.timers.enable({ apis: ['setInterval'] });
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
      await advanceToNextTick(testContext);
      await advanceToNextTick(testContext);
      await advanceToNextTick(testContext);
      await advanceToNextTick(testContext);

      deepEqual(mockAction.mock.callCount(), 3);
      deepEqual(mockOnInterruption.mock.callCount(), 1);
      deepEqual(mockOnInterruption.mock.calls[0]?.arguments[0], {
        cause: 'failure',
        error,
        recoveryError: undefined,
      });
    });

    it('should interrupt the flow when the abortSignal is aborted, and call `onInterruption` with the cause `aborted`', async (testContext: TestContext) => {
      testContext.mock.timers.enable({ apis: ['setInterval'] });
      const abortController = new AbortController();
      const mockAction: Mock<() => Result<undefined, string>> = mock.fn(() =>
        N.ok(undefined),
      );
      const mockOnInterruption = mock.fn();

      ResultFlow.from(mockAction).runPeriodically({
        interval: defaultInterval,
        onInterruption: mockOnInterruption,
        abortSignal: abortController.signal,
      });
      abortController.abort();

      await advanceToNextTick(testContext);
      deepEqual(mockAction.mock.callCount(), 0);
      deepEqual(mockOnInterruption.mock.callCount(), 1);
      deepEqual(mockOnInterruption.mock.calls[0]?.arguments[0], { cause: 'aborted' });
    });

    it('should run a recovery action in case of failure, and stop the flow it the recovery fails. In which case it calls `onInterruption` callback', async (testContext: TestContext) => {
      testContext.mock.timers.enable({ apis: ['setInterval'] });
      const recoveryError = 'recovery-error' as const;
      const mockAction: Mock<() => Result<never, string>> = mock.fn(() => N.err(error));
      const mockRecoveryAction = mock.fn(() => Promise.resolve(N.err(recoveryError)));
      const mockOnInterruption = mock.fn();

      ResultFlow.from(mockAction).runPeriodically({
        interval: defaultInterval,
        recoveryAction: mockRecoveryAction,
        onInterruption: mockOnInterruption,
      });

      await advanceToNextTick(testContext);
      await advanceToNextTick(testContext);

      deepEqual(mockAction.mock.callCount(), 1);
      deepEqual(mockRecoveryAction.mock.callCount(), 1);
      deepEqual(mockOnInterruption.mock.callCount(), 1);
      deepEqual(mockOnInterruption.mock.calls[0]?.arguments[0], {
        cause: 'failure',
        error,
        recoveryError: recoveryError,
      });
    });

    it('should run a recovery action in case of failure, and stop the flow it the recovery fails. In which case it calls `onInterruption` callback (ResultFlow variant for recoveryAction)', async (testContext: TestContext) => {
      testContext.mock.timers.enable({ apis: ['setInterval'] });
      const recoveryError = 'recovery-error' as const;
      const mockAction: Mock<() => Result<never, string>> = mock.fn(() => N.err(error));
      const mockRecoveryAction = mock.fn(() => ResultFlow.from(() => N.err(recoveryError)));
      const mockOnInterruption = mock.fn();

      ResultFlow.from(mockAction).runPeriodically({
        interval: defaultInterval,
        recoveryAction: mockRecoveryAction,
        onInterruption: mockOnInterruption,
      });
      await advanceToNextTick(testContext);
      await advanceToNextTick(testContext);

      deepEqual(mockAction.mock.callCount(), 1);
      deepEqual(mockRecoveryAction.mock.callCount(), 1);
      deepEqual(mockOnInterruption.mock.callCount(), 1);
      deepEqual(mockOnInterruption.mock.calls[0]?.arguments[0], {
        cause: 'failure',
        error,
        recoveryError: recoveryError,
      });
    });

    it('should run a recovery action in case of failure, and stop the flow it the recovery fails. In which case it calls `onInterruption` callback (ResultAsync variant for recoveryAction)', async (testContext: TestContext) => {
      testContext.mock.timers.enable({ apis: ['setInterval'] });
      const recoveryError = 'recovery-error' as const;
      const mockAction: Mock<() => Result<never, string>> = mock.fn(() => N.err(error));
      const mockRecoveryAction = mock.fn(() => N.errAsync(recoveryError));
      const mockOnInterruption = mock.fn();

      ResultFlow.from(mockAction).runPeriodically({
        interval: defaultInterval,
        recoveryAction: mockRecoveryAction,
        onInterruption: mockOnInterruption,
      });
      await advanceToNextTick(testContext);
      await advanceToNextTick(testContext);

      deepEqual(mockAction.mock.callCount(), 1);
      deepEqual(mockRecoveryAction.mock.callCount(), 1);
      deepEqual(mockOnInterruption.mock.callCount(), 1);
      deepEqual(mockOnInterruption.mock.calls[0]?.arguments[0], {
        cause: 'failure',
        error,
        recoveryError: recoveryError,
      });
    });

    it('should run a recovery action in case of failure, and stop the flow it the recovery fails. In which case it calls `onInterruption` callback (Result variant for recoveryAction)', async (testContext: TestContext) => {
      testContext.mock.timers.enable({ apis: ['setInterval'] });
      const recoveryError = 'recovery-error' as const;
      const mockAction: Mock<() => Result<never, string>> = mock.fn(() => N.err(error));
      const mockRecoveryAction = mock.fn(() => N.err(recoveryError));
      const mockOnInterruption = mock.fn();

      ResultFlow.from(mockAction).runPeriodically({
        interval: defaultInterval,
        recoveryAction: mockRecoveryAction,
        onInterruption: mockOnInterruption,
      });
      await advanceToNextTick(testContext);
      await advanceToNextTick(testContext);

      deepEqual(mockAction.mock.callCount(), 1);
      deepEqual(mockRecoveryAction.mock.callCount(), 1);
      deepEqual(mockOnInterruption.mock.callCount(), 1);
      deepEqual(mockOnInterruption.mock.calls[0]?.arguments[0], {
        cause: 'failure',
        error,
        recoveryError: recoveryError,
      });
    });

    it('should run a recovery action in case of failure, and resume the repeat flow it if the recovery succeeds', async (testContext: TestContext) => {
      testContext.mock.timers.enable({ apis: ['setInterval'] });
      const abortController = new AbortController();
      const mockAction: Mock<() => Result<undefined, string>> = mock.fn(
        () => N.ok(undefined),
        () => N.err(error),
        { times: 1 },
      );
      const mockRecoveryAction = mock.fn(() => Promise.resolve(N.ok(undefined)));
      const mockOnInterruption = mock.fn();

      ResultFlow.from(mockAction).runPeriodically({
        interval: defaultInterval,
        recoveryAction: mockRecoveryAction,
        onInterruption: mockOnInterruption,
        abortSignal: abortController.signal,
      });
      await advanceToNextTick(testContext);
      await advanceToNextTick(testContext);
      await advanceToNextTick(testContext);
      await advanceToNextTick(testContext);

      deepEqual(mockAction.mock.callCount() > 1, true);
      deepEqual(mockRecoveryAction.mock.callCount(), 1);
      deepEqual(mockOnInterruption.mock.callCount(), 0);

      abortController.abort();
    });

    it('should pass context to the periodic flow and recovery action', async (testContext: TestContext) => {
      testContext.mock.timers.enable({ apis: ['setInterval'] });
      const flowMock = mock.fn();
      const recoveryMock = mock.fn(() => N.err('recovery-error'));
      const onInterruption = mock.fn();
      const resultFlow = ResultFlow.of<never, string, Context>(async ({ fail }, extras) => {
        flowMock(extras);
        return fail(error);
      });

      resultFlow.runPeriodically({
        interval: defaultInterval,
        context: { correlationId: 'test-correlation-id', userId: 'test-user-id' },
        recoveryAction: recoveryMock,
        onInterruption,
      });

      await advanceToNextTick(testContext);
      await advanceToNextTick(testContext);

      deepEqual(flowMock.mock.calls[0]?.arguments, [{ context: {
        correlationId: 'test-correlation-id',
        userId: 'test-user-id',
      } }]);
      deepEqual(recoveryMock.mock.calls[0]?.arguments, [
        error,
        {
          context: {
            correlationId: 'test-correlation-id',
            userId: 'test-user-id',
          },
        },
      ]);
      deepEqual(onInterruption.mock.callCount(), 1);
    });

    it('should let the interval callback reject when the periodic flow throws', async (testContext: TestContext) => {
      let intervalCallback: (() => Promise<void>) | undefined;
      testContext.mock.method(globalThis, 'setInterval', (callback: () => void) => {
        intervalCallback = callback as () => Promise<void>;
        return 0 as unknown as ReturnType<typeof setTimeout>;
      });
      const thrownError = new Error('periodic flow failed');
      const mockOnInterruption = mock.fn();
      const resultFlow = ResultFlow.of<never, Error>(async () => {
        throw thrownError;
      });

      resultFlow.runPeriodically({
        interval: defaultInterval,
        onInterruption: mockOnInterruption,
      });

      if (!intervalCallback) {
        fail('Expected runPeriodically to register an interval callback');
      }

      await rejects(intervalCallback, /periodic flow failed/);
      deepEqual(mockOnInterruption.mock.callCount(), 0);
    });

    it('should let the interval callback reject when the recovery action rejects', async (testContext: TestContext) => {
      let intervalCallback: (() => Promise<void>) | undefined;
      testContext.mock.method(globalThis, 'setInterval', (callback: () => void) => {
        intervalCallback = callback as () => Promise<void>;
        return 0 as unknown as ReturnType<typeof setTimeout>;
      });
      const recoveryError = new Error('recovery action failed');
      const mockOnInterruption = mock.fn();
      const mockRecoveryAction = mock.fn(async () => {
        throw recoveryError;
      });

      ResultFlow.from<never, string>(N.err(error)).runPeriodically({
        interval: defaultInterval,
        recoveryAction: mockRecoveryAction,
        onInterruption: mockOnInterruption,
      });

      if (!intervalCallback) {
        fail('Expected runPeriodically to register an interval callback');
      }

      await rejects(intervalCallback, /recovery action failed/);
      deepEqual(mockRecoveryAction.mock.callCount(), 1);
      deepEqual(mockOnInterruption.mock.callCount(), 0);
    });
  });
});
