import { SchemaIR, TableIR } from "../ir/types.js";

export interface TopoResult {
  order: TableIR[];
  /** Set of table names whose at least one inbound FK was nullable and broken to resolve a cycle. */
  cyclicNullableSides: Set<string>;
  /** Tables involved in a hard (non-nullable) cycle — error condition. */
  hardCycles: string[][];
}

interface Edge {
  from: string; // child / referencing table
  to: string; // parent / referenced table
  nullable: boolean;
}

export function topoSort(ir: SchemaIR): TopoResult {
  const byName = new Map(ir.tables.map((t) => [t.name, t]));

  // Build dependency edges: child → parent, ignoring self-references (those are
  // resolved internally during row emission, not by ordering).
  const edges: Edge[] = [];
  for (const t of ir.tables) {
    for (const c of t.columns) {
      if (!c.foreignKey) continue;
      if (c.foreignKey.table === t.name) continue; // self-ref: handle within table
      if (!byName.has(c.foreignKey.table)) continue; // dangling — surface elsewhere
      edges.push({ from: t.name, to: c.foreignKey.table, nullable: c.nullable });
    }
  }

  const cyclicNullable = new Set<string>();
  const hardCycles: string[][] = [];

  // Try Kahn; if we can't finish, find a cycle and try to break it on a nullable edge.
  // Repeat until either we sort everything or no nullable edge breaks the deadlock.
  let activeEdges = [...edges];
  let order: string[] = [];

  while (true) {
    const result = kahn(ir.tables.map((t) => t.name), activeEdges);
    if (result.ok) {
      order = result.order;
      break;
    }
    // Find a cycle, then a nullable edge inside it to break.
    const cycle = findCycle(result.remaining, activeEdges);
    if (!cycle) {
      // No cycle but Kahn failed — shouldn't happen, but be safe.
      hardCycles.push(result.remaining);
      // Fall back to the partial order + remaining nodes in IR order.
      order = result.order.concat(
        ir.tables.map((t) => t.name).filter((n) => !result.order.includes(n)),
      );
      break;
    }
    const breakIdx = activeEdges.findIndex(
      (e) =>
        e.nullable &&
        cycle.includes(e.from) &&
        cycle.includes(e.to),
    );
    if (breakIdx === -1) {
      hardCycles.push(cycle);
      // Can't recover — give the user a partial order + remaining nodes.
      order = result.order.concat(cycle.filter((n) => !result.order.includes(n)));
      break;
    }
    cyclicNullable.add(activeEdges[breakIdx]!.from);
    activeEdges.splice(breakIdx, 1);
  }

  const orderTables = order
    .map((n) => byName.get(n))
    .filter((t): t is TableIR => Boolean(t));

  return { order: orderTables, cyclicNullableSides: cyclicNullable, hardCycles };
}

interface KahnResult {
  ok: boolean;
  order: string[];
  remaining: string[];
}

function kahn(nodes: string[], edges: Edge[]): KahnResult {
  const inDeg = new Map<string, number>();
  for (const n of nodes) inDeg.set(n, 0);
  for (const e of edges) inDeg.set(e.from, (inDeg.get(e.from) ?? 0) + 1);

  const ready: string[] = [];
  for (const n of nodes) if ((inDeg.get(n) ?? 0) === 0) ready.push(n);
  // Sort deterministically by name so identical inputs produce identical output.
  ready.sort();

  const order: string[] = [];
  while (ready.length > 0) {
    const n = ready.shift()!;
    order.push(n);
    for (const e of edges) {
      if (e.to !== n) continue;
      const d = (inDeg.get(e.from) ?? 0) - 1;
      inDeg.set(e.from, d);
      if (d === 0) {
        const i = sortedInsert(ready, e.from);
        ready.splice(i, 0, e.from);
      }
    }
  }

  const remaining = nodes.filter((n) => !order.includes(n));
  return { ok: remaining.length === 0, order, remaining };
}

function sortedInsert(arr: string[], v: string): number {
  let lo = 0,
    hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function findCycle(nodes: string[], edges: Edge[]): string[] | null {
  // DFS-based cycle detection restricted to the given subset of nodes.
  const subset = new Set(nodes);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  let cycle: string[] | null = null;

  function dfs(n: string) {
    if (cycle) return;
    if (visited.has(n)) return;
    visiting.add(n);
    stack.push(n);
    for (const e of edges) {
      if (e.from !== n) continue;
      if (!subset.has(e.to)) continue;
      if (visiting.has(e.to)) {
        const i = stack.indexOf(e.to);
        if (i >= 0) cycle = stack.slice(i).concat(e.to);
        return;
      }
      dfs(e.to);
      if (cycle) return;
    }
    visiting.delete(n);
    stack.pop();
    visited.add(n);
  }
  for (const n of nodes) {
    if (cycle) break;
    dfs(n);
  }
  return cycle;
}
