import { strictEqual } from 'node:assert';
import { describe, it } from 'node:test';
import { calculateExponentialDelay, calculateDelay, type DelayStrategy } from './delay';

describe('calculateDelay', () => {
  it('should return 0 for immediate strategy', () => {
    const strategy: DelayStrategy = { type: "immediate" };
    strictEqual(calculateDelay(strategy, 1), 0);
    strictEqual(calculateDelay(strategy, 5), 0);
    strictEqual(calculateDelay(strategy, 10), 0);
  });

  it('should calculate exponential backoff delay without maxDelay', () => {
    const strategy: DelayStrategy = { 
      type: "exponentialBackoff", 
      baseDelayMs: 100 
    };
    strictEqual(calculateDelay(strategy, 1), 100);
    strictEqual(calculateDelay(strategy, 2), 200);
    strictEqual(calculateDelay(strategy, 3), 400);
    strictEqual(calculateDelay(strategy, 4), 800);
  });

  it('should calculate exponential backoff delay with maxDelay', () => {
    const strategy: DelayStrategy = { 
      type: "exponentialBackoff", 
      baseDelayMs: 100,
      maxDelayMs: 500
    };
    strictEqual(calculateDelay(strategy, 1), 100);
    strictEqual(calculateDelay(strategy, 2), 200);
    strictEqual(calculateDelay(strategy, 3), 400);
    strictEqual(calculateDelay(strategy, 4), 500); // capped at maxDelay
    strictEqual(calculateDelay(strategy, 5), 500); // capped at maxDelay
  });
});

describe('calculateExponentialDelay', () => {
  it('should calculate exponential delay without maxDelay', () => {
    strictEqual(calculateExponentialDelay(1, 100), 100);
    strictEqual(calculateExponentialDelay(2, 100), 200);
    strictEqual(calculateExponentialDelay(3, 100), 400);
    strictEqual(calculateExponentialDelay(4, 100), 800);
  });

  it('should calculate exponential delay with maxDelay', () => {
    strictEqual(calculateExponentialDelay(1, 100, 500), 100);
    strictEqual(calculateExponentialDelay(2, 100, 500), 200);
    strictEqual(calculateExponentialDelay(3, 100, 500), 400);
    strictEqual(calculateExponentialDelay(4, 100, 500), 500); // capped at maxDelay
    strictEqual(calculateExponentialDelay(5, 100, 500), 500); // capped at maxDelay
  });
});
