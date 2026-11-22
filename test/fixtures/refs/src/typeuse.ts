import type { T1 } from './types';
import { type T2, val } from './types2';

export function f(x: T1): Promise<T2> {
  return Promise.resolve(val());
}

export interface Box extends T1 {
  extra: T2;
}

export class Impl implements Base {
  m(arg: T1): T1 {
    return arg;
  }
}

interface Base {
  m(arg: T1): T1;
}
