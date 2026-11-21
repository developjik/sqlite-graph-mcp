import { greet as sayHello } from '@/greet';
import { SHARED } from '@shared';
import libEntry from 'local-lib';
import * as undeclaredPkg from 'undeclared-pkg';
import ext from 'some-external';

export function runApp(): string {
  void undeclaredPkg;
  void ext;
  return `${sayHello()} ${SHARED}`;
}
