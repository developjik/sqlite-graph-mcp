import { coreFn, type CoreType } from 'refs-pkg';
import { deepOnly } from 'refs-pkg/sub';

export const out: CoreType = { value: coreFn() + deepOnly() };
