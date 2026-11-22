import { helperA, helperB } from './helpers';

export const bag = { helperA };

export function run(): number {
  return helperB();
}
