/**
 * D24 (compare side): a decision that never opened a lot keeps whatever exit / resolution part its input_hash was stored with,
 * so an incrementally-run database and a from-scratch replay of the same inputs can differ in `input_hash` (and in the
 * `record_hash` that covers it) for exactly those decisions, and in nothing else. Equality checks between the two drop both
 * hashes for those decisions only: every decision that opened a lot keeps them, so its whole hash is still compared.
 */
export const opensLot = (d: Record<string, any>): boolean => Number(d.filled_shares) > 0;
export function noLotHashAside<T extends Record<string, any>>(d: T): Omit<T, "input_hash" | "record_hash"> | T {
  if (opensLot(d)) return d;
  const { input_hash: _i, record_hash: _r, ...rest } = d; void _i; void _r; return rest;
}
