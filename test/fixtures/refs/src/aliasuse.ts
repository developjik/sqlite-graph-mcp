import { read as load } from './reader';

// `load` is this file's own name for `read` — it never refers to reader's
// `load` export, so no reference to `reader.ts#load` may be produced.
export function use(): number {
  return load();
}
