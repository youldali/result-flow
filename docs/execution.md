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

Cancellation is cooperative. An external abort is not automatically converted to
an Err and does not by itself settle `run()`. The operation may return a Result,
reject, or ignore the signal. If it ignores cancellation, the timeout can still
expire. The first settlement wins, including an operation's rejection in response
to an abort. A timeout does not interrupt synchronous CPU work.

Backoff waits use ordinary `setTimeout` promises and do not observe abort signals.
Retry and polling loops do not automatically stop on abort: they can start another
attempt with an already-aborted signal. A timeout around them can return while the
loop continues. Likewise, per-attempt timeouts can leave earlier attempts running
when their underlying work ignores cancellation.

Cleanup inside a timed flow belongs to the underlying execution and may finish
later, or never run if that execution never settles. Outer cleanup is awaited by
the outer flow but can race with still-running underlying work. Do not release a
resource that underlying work still uses merely because the timeout returned.
See [cleanup](failure-handling.md#cleanup-and-ordering).

## Periodic execution

`runPeriodically` uses `setInterval`; the first execution occurs after the first
interval delay. It does not wait for the preceding run or recovery to finish,
so executions can overlap. It returns void and does not expose a completion promise.

An Err stops the interval unless `recoveryAction` returns Ok. A recovery that
returns Err also stops it; `onInterruption` receives the original error and `recoveryError`
(undefined without recovery). An abort event clears future ticks and reports
`{ cause: 'aborted' }`, but in-flight work still depends on cooperative cancellation.
The implementation only installs an abort listener: an already-aborted signal does
not automatically prevent scheduling. Avoid starting the loop in that state.

A `catch` on the main flow can convert its exceptions into typed errors, but
`recoveryAction` runs outside that flow's exception boundary. Its throws and
rejected promises need separate handling within the recovery operation; the main
flow's `catch` does not handle them. An escaping exception from either operation
rejects the async interval callback without invoking `onInterruption` or
automatically clearing the interval. If recovery instead returns Err, the interval
stops and `onInterruption` receives the original error and recovery error. See the
[periodic health-check recipe](recipes.md#run-a-flow-periodically).

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
