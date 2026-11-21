import { describe, expect, it } from 'vitest';

import { walkGraph } from './walker.js';

describe('walkGraph', () => {
  it('keeps the starting nodes', () => {
    expect(walkGraph(['a'])).toContain('a');
  });
});
