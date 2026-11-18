# Execution

[README](../README.md) · [Core concepts](core-concepts.md) · [API reference](api-reference.md)

Operator placement determines which work is guarded, repeated, timed, or coordinated.
Use factories for application operations that must be invoked anew.

## Guard before work; validate after success

[`precondition`](api-reference.md#precondition) checks before upstream execution.
A false predicate skips it and returns the error produced by `onFailure`.
[`ensure`](api-reference.md#ensure) checks a successful value and preserves it
when valid; an upstream Err bypasses validation. Both allow asynchronous predicates
and failure builders. Exceptions from either callback reject execution.

See the [shutdown recipe](recipes.md#guard-new-work-during-shutdown).

## Repeating work

| Method | Repeats when | Stops when | Execution result |
| --- | --- | --- | --- |
| [`retryPolicy`](api-reference.md#retrypolicy) | Err passes the condition | Ok, condition returns false, or retries exhausted | One final Result |
| [`repeatUntil`](api-reference.md#repeatuntil) | Ok and readiness predicate returns false | Ready, Err, or repeats exhausted | One final Result |
| [`runPeriodically`](api-reference.md#runperiodically) | Interval elapses | Abort event, unrecovered Err, or failed recovery | void; reports interruption via callbacks |

`maxRetries` and `maxRepeats` count additional executions: 2 allows up to 3 attempts.
Use nonnegative integer counts. Retries do not handle exceptions. Polling stops
on the first Err; exhaustion converts the last success into the error from
`onExhausted`. A ready value on the last allowed attempt still succeeds.

`beforeRetry` and `beforeRepeat` run before the corresponding delay and additional
attempt; numbering starts at 1. A throwing hook rejects execution. The retry
condition receives the error only; repeat predicates and hooks also receive extras.
Defaults and delay formulas are canonical in the [API reference](api-reference.md#delaystrategy).

Only upstream work is repeated. Append processing or validation after the policy
to keep it outside that scope. A later policy around the entire composed flow can
repeat it again. See [retry](recipes.md#retry-a-remote-read-then-process) and
[polling](recipes.md#poll-until-a-success-value-is-ready) recipes.

## Operator order

The following are schematic compositions; `flow`, callbacks, and options represent
application code.

| Composition | Scope |
| --- | --- |
| `flow.precondition(check, error).retryPolicy(policy)` | Rechecks on every attempt, including retries of a failed guard. |
| `flow.retryPolicy(policy).precondition(check, error)` | Checks once before entering the loop; if the predicate returns false, returns the guard error and skips the loop. |
| `flow.timeout(limit).retryPolicy(policy)` | Each attempt gets its own timeout. |
| `flow.retryPolicy(policy).timeout(limit)` | One timeout wraps the whole retry sequence. |
| `flow.finally(cleanup).timeout(limit)` | Timeout may return before upstream work and its cleanup finish. |
| `flow.timeout(limit).finally(cleanup)` | Awaits outer cleanup after the timeout wrapper settles; underlying work may still be running. |

## Timeouts and cancellation

> [!IMPORTANT]
> A timeout can end the caller’s wait while the operation keeps running. Cancellation
> is cooperative: pass the signal to the operation, which must honor it to stop.
> With `timeout` before `retryPolicy`, each attempt gets a fresh timeout. A retry
> can overlap an unfinished attempt, and the total workflow can exceed that limit.

[`timeout`](api-reference.md#timeout) races upstream execution against a timeout
signal. When the timeout wins, `onTimeout` creates a typed Err. It requires
`AbortSignal.timeout`; when a caller supplies an existing signal, combining it
requires `AbortSignal.any`. The composed signal is passed upstream through extras.

Pass that signal to operations that support cancellation. This illustrative example
leaves the operation's abort behavior to the application:

```ts
import { ResultFlow } from '@youldali/result-flow';
import type { ResultAsync } from 'neverthrow';

declare function readRemote(signal?: AbortSignal): ResultAsync<string, 'unavailable'>;
const flow = ResultFlow.of<string, 'unavailable'>(async ({ tryTo }, { abortSignal }) =>
  tryTo(readRemote(abortSignal)),
).timeout({ ms: 500, onTimeout: () => 'timeout' as const });
const controller = new AbortController();
const execution = flow.run({ abortSignal: controller.signal });
controller.abort();
const result = await execution;
```

An external abort is not automatically converted to
an Err and does not by itself settle `run()`. The operation may return a Result,
reject, or ignore the signal. If it ignores cancellation, the timeout can still
expire. The first settlement wins, including an operation's rejection in response
to an abort. A timeout does not interrupt synchronous CPU work.

> [!IMPORTANT]
> **Current limitation:** After abort, `retryPolicy` can retry a matching Err and
> `repeatUntil` can repeat a non-ready Ok. Backoff waits run for their full delay.
> Further attempts may start with an already-aborted signal, even after an outer
> timeout has returned.

Cleanup inside a timed flow belongs to the underlying execution and may finish
later, or never run if that execution never settles. Outer cleanup is awaited by
the outer flow but can race with still-running underlying work. Do not release a
resource that underlying work still uses merely because the timeout returned.
See [cleanup](failure-handling.md#cleanup-and-ordering).

## Periodic execution

> [!IMPORTANT]
> A new tick can start while a previous execution or its recovery is still pending.
> If either throws or rejects and the exception escapes, the async interval callback
> rejects. This bypasses `onInterruption` and leaves the interval registered.
> The host may terminate the process on an unhandled rejection.

`runPeriodically` returns `void` and schedules its first check after one interval.
A check that returns Err clears the interval unless `recoveryAction` returns Ok.
On failure, `onInterruption` receives the original error and the recovery error
(`undefined` when no recovery was supplied).

An abort event clears future ticks and reports `{ cause: 'aborted' }`. Checks and
recoveries already in progress must honor the signal to stop.

> [!IMPORTANT]
> **Current limitation:** Passing an already-aborted signal does not prevent
> scheduling. The scheduler listens for future abort events.

Handle expected exceptions in the executed flow with `catch`. Handle recovery
exceptions inside `recoveryAction`, which runs outside the main flow’s exception
boundary. See the [periodic health-check recipe](recipes.md#run-a-flow-periodically).

## Coordinate flows

| Method | Scheduling | Typed failure | Empty input |
| --- | --- | --- | --- |
| [`all`](api-reference.md#resultflowall) | Sequential, array order | First Err stops later flows | Ok([]) |
| [`allSettled`](api-reference.md#resultflowallsettled) | Concurrent | Collects all Results inside Ok, in input order | Ok([]) |
| [`firstOk`](api-reference.md#resultflowfirstok) | Sequential | Tries the next flow; returns all errors if none succeeds | Rejects |
| [`race`](api-reference.md#resultflowrace) | Concurrent | First settled outcome wins, even Err | Rejects |

Every executed flow receives the current extras. Wrapping eager operations does
not retroactively control their start order. Use factories if ordering matters.

Exceptions reject `all` and `firstOk` immediately instead of becoming typed errors.
`allSettled` waits for all executions, then rejects with the first rejection in input
order if any rejected. `race` rejects if its first settlement is a rejection; later
outcomes do not replace the winner. Losing operations are not cancelled automatically.

```ts
import { ResultFlow } from '@youldali/result-flow';
import { ok, err } from 'neverthrow';

const inputs = [
  ResultFlow.from(ok('cached')),
  ResultFlow.from<string, 'missing'>(err('missing')),
] as const;
await ResultFlow.all(inputs).run();        // Err('missing')
await ResultFlow.allSettled(inputs).run(); // Ok([Ok('cached'), Err('missing')])
await ResultFlow.firstOk(inputs).run();    // Ok('cached')
```

For tuple inference and combined context requirements, see [composition types](core-concepts.md#composition-and-types).
