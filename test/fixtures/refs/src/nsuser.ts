import { Ns } from './nsbarrel';

const a = Ns.inner;

export function boom() {
  throw new Ns.InnerError('x');
}
