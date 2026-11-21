import { cycleA } from './cycle-a.js';

export interface WalkOptions {
  maxDepth?: number;
}

export function walkGraph(nodes: string[], options: WalkOptions = {}): string[] {
  void options.maxDepth;
  return [...nodes, cycleA()];
}

export class GraphWalker {
  walk(): string {
    return walkGraph(['x']).join(',');
  }
}
