import type { Result } from 'neverthrow';

export interface PromiseHelpers {
  mapError<A, E, E2>(
    promise: Promise<Result<A, E>>,
    mapper: (error: E) => E2,
  ): Promise<Result<A, E2>>;
}

export const mapError: PromiseHelpers['mapError'] = async (promise, mapper) => {
  const result = await promise;
  return result.mapErr(mapper);
};
