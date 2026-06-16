/*
 * `any` is intentionally weird in TypeScript: intersecting anything with `any`
 * gives `any` back. For ordinary types, `1 & T` is narrow:
 *
 *   1 & number  -> 1
 *   1 & string  -> never
 *   1 & unknown -> 1
 *
 * But:
 *
 *   1 & any -> any
 *
 * That makes `0 extends (1 & T)` true only when `T` is `any`.
 */
export type IsAny<T> = 0 extends (1 & T) ? true : false;

/*
 * Turns a union like `A | B` into an intersection like `A & B`.
 *
 * The first conditional distributes over the union:
 *
 *   A | B -> ((value: A) => void) | ((value: B) => void)
 *
 * Then TypeScript infers one parameter type that is valid for the union of
 * functions. Function parameters are inferred contravariantly, so the single
 * compatible parameter type becomes `A & B`.
 */
export type UnionToIntersection<U> =
  (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void
    ? I
    : never;
