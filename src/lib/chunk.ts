/** PostgREST puts `in.(…)` lists in the URL. 500 uuids ≈ 19 KB and 300 token ids ≈ 23 KB — past common URL limits.
 *  Every IN list is therefore split into chunks of IN_CHUNK values (≈ 4–8 KB), and every chunk's error is surfaced. */
export const IN_CHUNK = 100;

/** Run `run` once per IN_CHUNK values and concatenate the rows. Any chunk's error throws — never a silent partial result. */
export async function selectIn<T = Record<string, any>>(values: unknown[], run: (chunk: unknown[]) => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < values.length; i += IN_CHUNK) {
    const { data, error } = await run(values.slice(i, i + IN_CHUNK));
    if (error) throw new Error(`query failed: ${(error as { message?: string }).message ?? String(error)}`);
    out.push(...((data ?? []) as T[]));
  }
  return out;
}
