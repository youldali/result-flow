export type DelayStrategy =
  | { type: "immediate" }
  | { type: "exponentialBackoff"; baseDelayMs: number; maxDelayMs?: number };

export function calculateDelay(
  retryStrategy: DelayStrategy,
  attempt: number
): number {
  switch (retryStrategy.type) {
    case "immediate":
      return 0;
    case "exponentialBackoff":
      return calculateExponentialDelay(
        attempt,
        retryStrategy.baseDelayMs,
        retryStrategy.maxDelayMs
      );
  }
}

export function calculateExponentialDelay(
  attempt: number,
  baseDelay: number,
  maxDelay?: number
): number {
  const delay = baseDelay * 2 ** (attempt - 1)
  return maxDelay ? Math.min(delay, maxDelay) : delay
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
