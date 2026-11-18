# Recipes

[README](../README.md) · [API reference](api-reference.md)

For examples of individual operations, see [chaining steps](api-reference.md#chain) and [validating a success value](api-reference.md#ensure). Each example stands alone. In snippets with `declare`, the declarations describe functions supplied by your application.

- [Retry a remote read, then process](#retry-a-remote-read-then-process)
- [Guard new work during shutdown](#guard-new-work-during-shutdown)
- [Handle one failure manually](#handle-one-failure-manually)
- [Convert selected exceptions](#convert-selected-exceptions)
- [Convert a flow to a response](#convert-a-flow-to-a-response)
- [Poll until a success value is ready](#poll-until-a-success-value-is-ready)
- [Run a flow periodically](#run-a-flow-periodically)
- [Clean up after every outcome](#clean-up-after-every-outcome)

## Retry a remote read, then process

A request handler can retry a transiently unavailable read. Once it has a user, it should validate that user just once.

```ts
import { ResultFlow } from '@youldali/result-flow';
import type { Result, ResultAsync } from 'neverthrow';

type User = { id: string; email: string };
declare function readUser(): ResultAsync<User, 'unavailable' | 'not-found'>;
declare function validateUser(user: User): Result<User, 'invalid'>;

const flow = ResultFlow.from(() => readUser())
  .timeout({ ms: 500, onTimeout: () => 'timeout' as const })
  .retryPolicy({
    maxRetries: 2,
    condition: error => error === 'unavailable' || error === 'timeout',
  })
  .chain(validateUser);
const result = await flow.run();
```

> [!IMPORTANT]
> The 500 ms limit applies to each attempt. A timed-out read may still be running
> when its retry starts. See [timeouts and cancellation](execution.md#timeouts-and-cancellation).

The factory starts a fresh read on each attempt. Two retries allow at most three attempts. A missing user stops the flow immediately. Validation follows the policy, so a validation failure never triggers another read. See [operator order](execution.md#operator-order), [`retryPolicy`](api-reference.md#retrypolicy), and [`chain`](api-reference.md#chain).

## Guard new work during shutdown

A worker may start shutting down between building a flow and taking the next job. Check its state just before taking work.

```ts
import { ResultFlow } from '@youldali/result-flow';
import { okAsync } from 'neverthrow';

let jobsStarted = 0;
function processNext() {
  jobsStarted += 1;
  return okAsync('processed');
}

let shuttingDown = false;
const flow = ResultFlow.from(() => processNext())
  .precondition(() => !shuttingDown, () => 'shutting-down' as const);
shuttingDown = true;
const result = await flow.run(); // Err('shutting-down')
console.log(jobsStarted); // 0
```

The guard sees the latest shutdown flag and can skip the factory entirely. Jobs already in progress continue. To recheck before each retry, place the guard inside the retry policy. See [execution guards](execution.md#guard-before-work-validate-after-success) and [`precondition`](api-reference.md#precondition).

## Handle one failure manually

A user import can substitute a fallback address for an invalid email. A blocked domain must stop the save.

```ts
import { ResultFlow } from '@youldali/result-flow';
import type { Result, ResultAsync } from 'neverthrow';

type User = { id: string; email: string };
type UserError = 'not-found' | 'invalid-email' | 'blocked-domain' | 'save-failed';

declare function findUser(id: string): ResultAsync<User, 'not-found'>;
declare function validateEmail(user: User): Result<User, 'invalid-email' | 'blocked-domain'>;
declare function saveUser(user: User): ResultAsync<User, 'save-failed'>;
declare function useFallbackEmail(user: User): User;

const result = await ResultFlow.of<User, UserError>(async ({ fail, tryTo }) => {
  let user = await tryTo(findUser('user-1'));

  const validation = validateEmail(user);
  if (validation.isOk()) {
    user = validation.value;
  } else if (validation.error === 'invalid-email') {
    user = useFallbackEmail(user);
  } else {
    // Stop the flow for errors this branch does not recover from.
    fail(validation.error);
  }

  return tryTo(saveUser(user));
}).run();
```

Inspect the validation Result directly so the import can choose a fallback. Calling `fail` for the blocked domain returns its typed error and skips the save. Lookup and save still use `tryTo` to propagate their errors. See [inline helpers](failure-handling.md#inline-helpers) and [`ResultFlow.of`](api-reference.md#resultflowof).

## Convert selected exceptions

A file adapter throws for missing files. Its callers expect a typed lookup error and need unexpected exceptions to reach their usual error handler.

```ts
import { ResultFlow } from '@youldali/result-flow';
import { err } from 'neverthrow';

class MissingFileError extends Error {}
declare function readFile(): Promise<string>;

const flow = ResultFlow.of<string, never>(async () => readFile())
  .catch(cause => {
    if (cause instanceof MissingFileError) return err('not-found' as const);
    throw cause;
  });
const result = await flow.run(); // Ok(contents), Err('not-found'), or a rejection.
```

Placing `catch` directly after the read limits the conversion to exceptions from that work. Rethrowing an unknown cause preserves the rejection. See [exception recovery](failure-handling.md#propagation-and-recovery) and [`catch`](api-reference.md#catch).

## Convert a flow to a response

An HTTP endpoint needs a status and request ID for both a successful update and a domain error.

```ts
import { ResultFlow } from '@youldali/result-flow';

type User = { id: string; email: string };
type Context = { requestId: string };
type Response = { status: number; body: unknown };
type UserError = 'not-found' | 'invalid-email' | 'save-failed';

declare function updateUserFlow(id: string): ResultFlow<User, UserError, Context>;

const errorStatus: Record<UserError, number> = {
  'not-found': 404,
  'invalid-email': 400,
  'save-failed': 500,
};

const response = await updateUserFlow('user-1').runAndMatch<Response>({
  ok: (user, { context }) => ({
    status: 200,
    body: { requestId: context.requestId, user },
  }),
  err: (error, { context }) => ({
    status: errorStatus[error],
    body: { requestId: context.requestId, error },
  }),
}, { context: { requestId: 'req-123' } });
```

Keep HTTP status codes in the endpoint. Awaiting `runAndMatch` executes the update and yields the selected handler’s response. Unexpected exceptions bypass both handlers and reject execution. See [`runAndMatch`](api-reference.md#runandmatch) and [handling the outcome at the application boundary](getting-started.md#handle-the-outcome-at-the-application-boundary).

## Poll until a success value is ready

A job lookup can succeed while the job is still queued. The caller needs one final status and a limit on how many times to poll.

```ts
import { ResultFlow } from '@youldali/result-flow';
import type { ResultAsync } from 'neverthrow';

type JobStatus =
  | { id: string; status: 'queued' | 'running' }
  | { id: string; status: 'done'; resultUrl: string };

declare function getJobStatus(id: string): ResultAsync<JobStatus, { reason: 'not-found' }>;

const result = await ResultFlow
  .from(() => getJobStatus('job-123'))
  .repeatUntil({
    predicate: (job) => job.status === 'done',
    maxRepeats: 10,
    delayStrategy: { type: 'exponentialBackoff', baseDelayMs: 250, maxDelayMs: 2000 },
    beforeRepeat: (job, repeatNumber) => {
      console.log(`Job ${job.id} is ${job.status}; repeat ${repeatNumber}`);
    },
    onExhausted: (job) => ({
      reason: 'job-not-ready' as const,
      lastStatus: job.status,
    }),
  })
  .run();

// Ok({ status: 'done', ... })
// or Err({ reason: 'not-found' })
// or Err({ reason: 'job-not-ready', lastStatus: 'queued' | 'running' })
```

Each repeat calls the status factory again. A lookup error ends polling immediately. After the last allowed read, a pending status becomes `job-not-ready` with the last observed state. See [repeating work](execution.md#repeating-work) and [`repeatUntil`](api-reference.md#repeatuntil).

## Run a flow periodically

Schedule a service health check every five seconds. When the check reports a typed failure, try reconnecting before ending the checks.

```ts
import { ResultFlow } from '@youldali/result-flow';
import type { ResultAsync } from 'neverthrow';

const controller = new AbortController();

declare function checkServiceHealth(): ResultAsync<void, 'service-down'>;
declare function reconnectService(): ResultAsync<void, 'reconnect-failed'>;

const healthCheck = ResultFlow.from(() => checkServiceHealth());

healthCheck.runPeriodically({
  interval: 5000,
  abortSignal: controller.signal,
  recoveryAction: () => reconnectService(),
  onInterruption: (interruption) => {
    if (interruption.cause === 'failure') {
      console.error('Health check stopped', interruption.error);
      console.error('Recovery error', interruption.recoveryError);
    }

    if (interruption.cause === 'aborted') {
      console.log('Health check stopped manually');
    }
  },
});

```

> [!IMPORTANT]
> A tick can overlap a pending check or reconnect. An escaping exception from
> either rejects the tick’s callback without calling `onInterruption` or clearing
> the interval. The host may terminate on an unhandled rejection.
> See [periodic execution](execution.md#periodic-execution).

During shutdown, abort the controller to stop future ticks. In-flight operations
continue unless they honor the signal.

```ts
controller.abort();
```

A successful reconnect allows future checks. Without recovery, a typed check failure
stops the interval. A typed reconnect failure also stops it and supplies both errors
to `onInterruption`. Handle check exceptions in the health flow and reconnect
exceptions inside the recovery operation. See [`runPeriodically`](api-reference.md#runperiodically).

## Clean up after every outcome

An export needs a scratch buffer for the duration of one run. Acquire it inside the flow so each invocation owns the buffer it will release.

```ts
import { ResultFlow } from '@youldali/result-flow';
import { err, ok } from 'neverthrow';

let nextId = 0;

function acquireBuffer(available: boolean) {
  if (!available) return err('busy' as const);
  const id = ++nextId;
  const rows: string[] = [];
  console.log('open', id);
  return ok({
    write(row: string) {
      rows.push(row);
      return rows.length;
    },
    close() {
      rows.length = 0;
      console.log('close', id);
    },
  });
}

function exportRow(row: string, available = true) {
  return ResultFlow.from(() => acquireBuffer(available)).chain(buffer =>
    ResultFlow.from(() => {
      if (!row) return err('empty-row' as const);
      // Simulate an unexpected write exception.
      if (row === 'broken') throw new Error('write failed');
      return ok(buffer.write(row));
    }).finally(() => buffer.close()),
  );
}

const exportAda = exportRow('Ada');
await exportAda.run();           // open 1, close 1 → Ok(1)
await exportAda.run();           // open 2, close 2 → Ok(1)
await exportRow('').run();       // open 3, close 3 → Err('empty-row')
try {
  await exportRow('broken').run(); // open 4, close 4
} catch (cause) {
  console.log(cause instanceof Error && cause.message); // write failed
}
await exportRow('Ada', false).run(); // Err('busy'), no open or close
```

Only successful acquisition enters `chain`. Its callback captures that run’s buffer and attaches cleanup to the deferred write before it executes. Concurrent runs each close their own buffer. ResultFlow awaits cleanup and preserves the work’s outcome when cleanup succeeds. If cleanup throws or rejects, that exception replaces the original outcome. See [`finally`](api-reference.md#finally) and [cleanup ordering](failure-handling.md#cleanup-and-ordering).

> [!IMPORTANT]
> Cleanup runs after the wrapped work settles; attaching it does not cancel
> that work. For asynchronous operations, an outer timeout can settle before
> the underlying work and its cleanup finish. See
> [timeouts and cancellation](execution.md#timeouts-and-cancellation) and
> [generator cleanup](failure-handling.md#generator-cleanup).
