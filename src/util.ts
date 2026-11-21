import { NODE_KINDS, EDGE_TYPES, type EdgeType, type NodeKind } from './types.js';

/** Normalize a filesystem path to workspace-relative POSIX form. */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function unique<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

export function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Split identifiers into searchable terms: camelCase, snake_case, kebab-case, paths. */
export function splitTerms(input: string): string[] {
  const out = new Set<string>();
  const pieces = input.split(/[^\p{L}\p{N}_$]+/u);
  for (const piece of pieces) {
    if (!piece) continue;
    out.add(piece.toLowerCase());
    for (const part of piece
      .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
      .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')
      .split(/\s+/)) {
      if (part) out.add(part.toLowerCase());
    }
  }
  return [...out];
}

/** Build the FTS `terms` column for a node. */
export function buildTerms(name: string, path: string | null, extra: string[] = []): string {
  const terms = new Set<string>();
  for (const t of splitTerms(name)) terms.add(t);
  if (path) {
    for (const t of splitTerms(path)) terms.add(t);
  }
  for (const e of extra) {
    for (const t of splitTerms(e)) terms.add(t);
  }
  return [...terms].join(' ');
}

/** Escape user text for an FTS5 phrase, then make it a prefix query. */
export function ftsPrefixToken(token: string): string | null {
  const cleaned = token.replace(/["*()]/g, ' ').trim();
  if (!cleaned) return null;
  return `"${cleaned.replace(/"/g, '""')}"*`;
}

/** Escape a value used inside a LIKE pattern (escape char `\`). */
export function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** Turn a small glob (`**`, `*`, `?`) into a SQL LIKE pattern. */
export function globToLike(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '%';
        i += 1;
        if (glob[i + 1] === '/') i += 1; // `**/foo` also matches `foo`
      } else {
        out += '%';
      }
    } else if (ch === '?') {
      out += '_';
    } else if (ch === '\\' && i + 1 < glob.length) {
      i += 1;
      out += likeEscape(glob[i]);
    } else if ('%_'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return out;
}

export function isNodeKind(value: unknown): value is NodeKind {
  return typeof value === 'string' && (NODE_KINDS as readonly string[]).includes(value);
}

export function isEdgeType(value: unknown): value is EdgeType {
  return typeof value === 'string' && (EDGE_TYPES as readonly string[]).includes(value);
}

export function assertNodeKinds(values: string[]): NodeKind[] {
  const out: NodeKind[] = [];
  for (const v of values) {
    if (!isNodeKind(v)) {
      throw new Error(`Unknown node kind "${v}". Expected one of: ${NODE_KINDS.join(', ')}`);
    }
    out.push(v);
  }
  return out;
}

export function assertEdgeTypes(values: string[]): EdgeType[] {
  const out: EdgeType[] = [];
  for (const v of values) {
    if (!isEdgeType(v)) {
      throw new Error(`Unknown edge type "${v}". Expected one of: ${EDGE_TYPES.join(', ')}`);
    }
    out.push(v);
  }
  return out;
}

/** Collapse whitespace and cap a snippet to `max` characters. */
export function snippet(text: string | null | undefined, max = 160): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Line number (1-based) of a character index in `text`. */
export function lineAtIndex(lineStarts: number[], index: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (lineStarts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

export function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}
