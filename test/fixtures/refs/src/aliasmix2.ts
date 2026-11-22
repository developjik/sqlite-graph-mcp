import { load as realLoad, read as load } from './reader';

// Same bindings as aliasmix.ts in the opposite clause order.
export function useMix2(): number {
  const a = load();
  return a + realLoad();
}
