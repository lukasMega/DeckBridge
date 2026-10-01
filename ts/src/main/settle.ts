// Attempt every cleanup, then report all failures together: one failing owner
// must never skip the others, and shutdown needs to see that something failed.
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Settles every promise; rejects afterwards with the failure(s), if any. */
export async function settleAll(label: string, tasks: readonly Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(tasks);
  const errors = results.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []));
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, `${label}: ${errors.map(message).join('; ')}`);
}

/** Starts `fn` now, turning a synchronous throw into a rejection. */
export function begin(fn: () => Promise<unknown> | undefined): Promise<unknown> {
  try {
    return Promise.resolve(fn());
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
}
