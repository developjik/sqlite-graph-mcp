import { read as load, load as realLoad } from './reader';

// The alias `load` still means `read`; only `realLoad` refers to `load`.
export function useMix(): number {
  const a = load();
  return a + realLoad();
}
