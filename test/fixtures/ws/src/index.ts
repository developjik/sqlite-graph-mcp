import { greet } from './greet.js';
import { walkGraph } from './graph/walker';
import leftPad from 'left-pad';

export const VERSION = '1.0.0';

export function main(name: string): string {
  const padded = leftPad(name, 10);
  const path = walkGraph(['a', 'b']);
  return `${greet(padded)} ${path.join('>')}`;
}

function unusedHelper(): number {
  return 42;
}
