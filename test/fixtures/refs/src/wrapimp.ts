declare function wrapPromise<T>(fn: () => Promise<T>): Promise<T>;

// A wrapped dynamic import (opencode: `yield* Effect.promise(() => import(…))`):
// a literal import() inside the declarator's initializer still supplies the
// destructured names.
export async function loadRun(): Promise<number> {
  const { reportRunError, runNonInteractive } = await wrapPromise(() => import('./wraplib'));
  return reportRunError() + runNonInteractive();
}
