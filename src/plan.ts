import type { GraphStore } from './db.js';
import { filterNodes, findNodes, minusNodes, toEdgeViews, toNodeView, walkNodes } from './query.js';
import type {
  AnswerResult,
  EdgeView,
  FindOptions,
  GraphNode,
  NodePredicate,
  NodeRef,
  Plan,
  PlanStep,
  StepSummary,
  WalkOptions,
} from './types.js';
import { clamp } from './util.js';

const DEFAULT_ANSWER_LIMIT = 50;
const MAX_ANSWER_LIMIT = 500;

/* ------------------------------------------------------------------ */
/* Plan parsing: JSON object, step array, or a compact pipeline DSL.   */
/* ------------------------------------------------------------------ */

/**
 * Parse a plan from
 *  - a {@link Plan} object,
 *  - an array of steps,
 *  - a pipeline string: `find "graph" kind=symbol | walk type=imports depth=2 | filter path=src/**`
 */
export function parsePlan(input: unknown): Plan {
  if (typeof input === 'string') {
    return parseDsl(input);
  }
  if (Array.isArray(input)) {
    return { steps: input.map(normalizeStep) };
  }
  if (input && typeof input === 'object') {
    const obj = input as { steps?: unknown; plan?: unknown; limit?: unknown };
    const raw = obj.steps ?? obj.plan;
    if (!Array.isArray(raw)) {
      throw new Error('Plan object must have a "steps" array');
    }
    return {
      steps: raw.map(normalizeStep),
      limit: obj.limit === undefined ? undefined : Number(obj.limit),
    };
  }
  throw new Error('Plan must be a pipeline string, a step array, or { steps: [...] }');
}

function normalizeStep(input: unknown): PlanStep {
  if (!input || typeof input !== 'object') {
    throw new Error('Each plan step must be an object');
  }
  const step = input as Record<string, unknown>;
  const op = step.op;
  switch (op) {
    case 'find':
      return {
        op: 'find',
        query: typeof step.query === 'string' ? step.query : '',
        kind: step.kind as FindOptions['kind'],
        limit: step.limit === undefined ? undefined : Number(step.limit),
      };
    case 'walk':
      return {
        op: 'walk',
        start: step.start as NodeRef[] | undefined,
        edgeType: step.edgeType as WalkOptions['edgeType'],
        direction: (step.direction as WalkOptions['direction']) ?? 'out',
        maxDepth: step.maxDepth === undefined ? undefined : Number(step.maxDepth),
        limit: step.limit === undefined ? undefined : Number(step.limit),
      };
    case 'filter': {
      const predicate =
        (step.predicate as NodePredicate | undefined) ??
        (Object.fromEntries(
          Object.entries(step).filter(([key]) => key !== 'op' && key !== 'predicate'),
        ) as NodePredicate);
      return { op: 'filter', predicate };
    }
    case 'minus': {
      const set = step.set;
      if (!Array.isArray(set)) {
        throw new Error('minus step needs a "set" array of steps');
      }
      return { op: 'minus', set: set.map(normalizeStep) };
    }
    default:
      throw new Error(`Unknown plan op "${String(op)}" (expected find, walk, filter, minus)`);
  }
}

/** Tokenize a pipeline, keeping quoted strings together. */
export function tokenize(input: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i] as string;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < input.length) {
        i += 1;
        current += input[i];
      } else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (quote) throw new Error('Unterminated quote in plan');
  if (current) out.push(current);
  return out;
}

export function parseDsl(input: string): Plan {
  const segments = splitPipeline(input);
  if (segments.length === 0) throw new Error('Empty plan');
  return { steps: segments.map((segment) => parseSegment(segment)) };
}

function splitPipeline(input: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i] as string;
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '|') {
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (quote) throw new Error('Unterminated quote in plan');
  segments.push(current);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

function parseSegment(segment: string): PlanStep {
  const tokens = tokenize(segment);
  const op = tokens.shift();
  if (!op) throw new Error('Empty plan step');

  if (op === 'minus') {
    const nested = tokens.join(' ');
    if (!nested) throw new Error('minus needs a sub-plan, e.g. `minus find "*.test.ts"`');
    return { op: 'minus', set: parseDsl(nested).steps };
  }

  const { options, positional } = splitOptions(tokens);

  switch (op) {
    case 'find': {
      const kind = options.kind ?? options.kinds;
      const limit = numberOption(options, 'limit');
      return {
        op: 'find',
        query: positional.join(' ').trim(),
        kind: kind
          ? (kind.split(',').map((k) => k.trim()).filter(Boolean) as never)
          : undefined,
        limit,
      };
    }
    case 'walk': {
      const type = options.type ?? options.edge ?? options.edgeType;
      const start = options.start ?? options.from;
      const direction = options.dir ?? options.direction;
      if (direction && !['out', 'in', 'both'].includes(direction)) {
        throw new Error(`walk dir must be out, in, or both (got "${direction}")`);
      }
      return {
        op: 'walk',
        start: start ? start.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        edgeType: type
          ? (type.split(',').map((t) => t.trim()).filter(Boolean) as never)
          : undefined,
        direction: direction as 'out' | 'in' | 'both' | undefined,
        maxDepth: numberOption(options, 'depth') ?? numberOption(options, 'maxDepth'),
        limit: numberOption(options, 'limit'),
      };
    }
    case 'filter': {
      const predicate: NodePredicate = {};
      const kind = options.kind ?? options.kinds;
      if (kind) predicate.kind = kind.split(',').map((k) => k.trim()).filter(Boolean) as never;
      const notKind = options.notKind ?? options['not-kind'];
      if (notKind) predicate.notKind = notKind.split(',').map((k) => k.trim()).filter(Boolean) as never;
      const pathPrefix = options.prefix ?? options.pathPrefix;
      if (pathPrefix) predicate.pathPrefix = pathPrefix;
      const pathSuffix = options.suffix ?? options.pathSuffix;
      if (pathSuffix) predicate.pathSuffix = pathSuffix;
      if (options.path) predicate.pathGlob = options.path;
      const name = options.name ?? options.nameContains;
      if (name) predicate.nameContains = name;
      if (options.regex) predicate.nameMatches = options.regex;
      if (options.tag) predicate.tag = options.tag;
      const limit = numberOption(options, 'limit');
      if (limit !== undefined) predicate.limit = limit;
      if (positional.length > 0) {
        predicate.nameContains = positional.join(' ');
      }
      return { op: 'filter', predicate };
    }
    default:
      throw new Error(`Unknown plan op "${op}" (expected find, walk, filter, minus)`);
  }
}

function splitOptions(tokens: string[]): { options: Record<string, string>; positional: string[] } {
  const options: Record<string, string> = {};
  const positional: string[] = [];
  for (const token of tokens) {
    const eq = token.indexOf('=');
    if (eq > 0) {
      const key = token.slice(0, eq);
      options[key] = token.slice(eq + 1);
    } else {
      positional.push(token);
    }
  }
  return { options, positional };
}

function numberOption(options: Record<string, string>, key: string): number | undefined {
  const raw = options[key];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Option ${key} must be a number (got "${raw}")`);
  return value;
}

/* ------------------------------------------------------------------ */
/* Plan execution: answer with citations.                              */
/* ------------------------------------------------------------------ */

/**
 * Operator 5 — `answer`: run a chained plan and return nodes, the edges that
 * were touched, `path:line` citations, and a per-step trace.
 */
export function executePlan(store: GraphStore, input: unknown): AnswerResult {
  const plan = parsePlan(input);
  if (plan.steps.length === 0) throw new Error('Plan has no steps');

  const steps: StepSummary[] = [];
  const explain: string[] = [];
  const depths = new Map<number, number>();
  let touchedEdges: EdgeView[] = [];
  let current: number[] = [];

  plan.steps.forEach((step, index) => {
    const before = current.length;
    let result: GraphNode[] = [];

    switch (step.op) {
      case 'find': {
        const found = findNodes(store, step.query, { kind: step.kind, limit: step.limit });
        result = found.nodes;
        explain.push(
          `find(${JSON.stringify(step.query)}${step.kind ? `, kind=${String(step.kind)}` : ''}) → ${result.length} nodes`,
        );
        break;
      }
      case 'walk': {
        const start = step.start && step.start.length > 0 ? step.start : current;
        if (start.length === 0) {
          throw new Error('walk needs a start set: run find first or pass start=[...]');
        }
        const walked = walkNodes(store, start, {
          edgeType: step.edgeType,
          direction: step.direction,
          maxDepth: step.maxDepth,
          limit: step.limit,
        });
        result = walked.nodes;
        for (const [id, depth] of walked.depths) depths.set(id, depth);
        const edges = store.edgesFor(
          result.map((n) => n.id),
          step.direction === 'in' ? 'in' : step.direction === 'both' ? 'both' : 'out',
        );
        const filtered = step.edgeType
          ? edges.filter((e) => (Array.isArray(step.edgeType) ? step.edgeType : [step.edgeType]).includes(e.type))
          : edges;
        touchedEdges = toEdgeViews(store, filtered.slice(0, 200));
        explain.push(
          `walk(from ${start.length}, ${step.direction ?? 'out'}${step.edgeType ? `, ${[step.edgeType].flat().join('/')}` : ''}, depth=${step.maxDepth ?? 6}) → ${result.length} nodes`,
        );
        break;
      }
      case 'filter': {
        const filtered = filterNodes(store, current, step.predicate);
        result = filtered.nodes;
        explain.push(
          `filter(${JSON.stringify(step.predicate)}) ${before} → ${result.length} nodes`,
        );
        break;
      }
      case 'minus': {
        const excluded: number[] = [];
        for (const sub of step.set) {
          const subResult = runSubPlan(store, sub, current);
          excluded.push(...subResult);
        }
        current = minusNodes(current, excluded);
        result = store.nodesByIds(current);
        explain.push(`minus(${excluded.length} nodes) ${before} → ${current.length} nodes`);
        break;
      }
    }

    current = result.map((node) => node.id);
    steps.push({
      index,
      op: step.op,
      params: stepParams(step),
      inputCount: before,
      outputCount: current.length,
    });
  });

  const total = current.length;
  const limit = clamp(plan.limit ?? DEFAULT_ANSWER_LIMIT, 1, MAX_ANSWER_LIMIT);
  const limited = current.slice(0, limit);
  const nodes = store.nodesByIds(limited).map((node) => toNodeView(node, depths.get(node.id)));
  const citations = [...new Set(nodes.map((n) => n.citation).filter((c): c is string => Boolean(c)))];
  const edges = touchedEdges.filter(
    (edge) => limited.includes(edge.src) || limited.includes(edge.dst),
  );

  return {
    count: total,
    nodes,
    edges,
    citations,
    steps,
    explain,
    truncated: total > limited.length,
  };
}

function stepParams(step: PlanStep): Record<string, unknown> {
  switch (step.op) {
    case 'find':
      return { query: step.query, kind: step.kind, limit: step.limit };
    case 'walk':
      return {
        start: step.start,
        edgeType: step.edgeType,
        direction: step.direction ?? 'out',
        maxDepth: step.maxDepth ?? 6,
      };
    case 'filter':
      return { predicate: step.predicate };
    case 'minus':
      return { set: step.set.map((s) => s.op) };
  }
}

/** Run a single step against an explicit input set (used by `minus`). */
function runSubPlan(store: GraphStore, step: PlanStep, input: number[]): number[] {
  switch (step.op) {
    case 'find':
      return findNodes(store, step.query, { kind: step.kind, limit: step.limit }).nodes.map((n) => n.id);
    case 'walk': {
      const start = step.start && step.start.length > 0 ? step.start : input;
      return walkNodes(store, start, {
        edgeType: step.edgeType,
        direction: step.direction,
        maxDepth: step.maxDepth,
        limit: step.limit,
      }).nodes.map((n) => n.id);
    }
    case 'filter':
      return filterNodes(store, input, step.predicate).ids;
    case 'minus': {
      let acc = input;
      for (const sub of step.set) acc = minusNodes(acc, runSubPlan(store, sub, acc));
      return acc;
    }
  }
}
