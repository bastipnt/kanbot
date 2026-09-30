import { asc, count, eq } from "drizzle-orm";
import type { Executor, Tx } from "../db/index.ts";
import { columns, tasks, type ColumnRow } from "../db/schema.ts";
import { isUuid } from "../lib/crypto.ts";
import { ApiError, badRequest, conflict, notFound } from "../lib/errors.ts";
import { computePosition, initialPositions, type Placement } from "../lib/position.ts";
import { actorOf, type Principal } from "../lib/principal.ts";
import { toColumn, type Column } from "../lib/serialize.ts";
import { loadBoard, loadColumn } from "./access.ts";
import { lockedBoard } from "./boards.ts";
import { mutate } from "./events.ts";

export async function boardColumns(ex: Executor, boardId: string): Promise<ColumnRow[]> {
  return ex.select().from(columns).where(eq(columns.boardId, boardId)).orderBy(asc(columns.position), asc(columns.id));
}

/**
 * Resolve a column on a board by id or by case-insensitive name (e.g. "ready for dev").
 * Throws not_found listing the available columns so agents can self-correct.
 */
export async function resolveColumn(ex: Executor, boardId: string, idOrName: string): Promise<ColumnRow> {
  const cols = await boardColumns(ex, boardId);
  const needle = idOrName.trim();
  const byId = isUuid(needle) ? cols.find((c) => c.id === needle.toLowerCase()) : undefined;
  if (byId) return byId;
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const byName = cols.filter((c) => norm(c.name) === norm(needle));
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) throw conflict(`Multiple columns named "${needle}" on this board; use the column id`);
  throw new ApiError(
    "not_found",
    `Column "${needle}" not found on this board. Available columns: ${cols.map((c) => `"${c.name}"`).join(", ")}`,
  );
}

export async function createColumn(
  p: Principal,
  boardId: string,
  /** `after`: insert after this column (id or name); default is the end. */
  input: { name: string; after?: string | null; wipLimit?: number | null },
): Promise<Column> {
  const board = await loadBoard(p, boardId);
  return mutate(board.workspaceId, actorOf(p), async (tx, emit) => {
    await lockedBoard(tx, boardId);
    const siblings = await boardColumns(tx, boardId);
    const after = input.after ? await resolveColumn(tx, boardId, input.after) : undefined;
    const position = computePosition(siblings, { afterId: after?.id });
    const [col] = await tx
      .insert(columns)
      .values({ boardId, name: input.name.trim(), position, wipLimit: input.wipLimit ?? null })
      .returning();
    emit({ type: "column.created", entityId: col!.id, payload: toColumn(col!) });
    return toColumn(col!);
  });
}

async function currentColumn(tx: Tx, columnId: string): Promise<ColumnRow> {
  const [col] = await tx.select().from(columns).where(eq(columns.id, columnId));
  if (!col) throw notFound("Column");
  return col;
}

export async function updateColumn(
  p: Principal,
  columnId: string,
  patch: { name?: string; wipLimit?: number | null } & Placement,
): Promise<Column> {
  const { workspaceId } = await loadColumn(p, columnId);
  return mutate(workspaceId, actorOf(p), async (tx, emit) => {
    const col = await currentColumn(tx, columnId);
    const reposition = Boolean(patch.beforeId || patch.afterId);
    const position = reposition ? computePosition(await boardColumns(tx, col.boardId), patch, col.id) : col.position;
    const [updated] = await tx
      .update(columns)
      .set({
        ...(patch.name !== undefined && { name: patch.name.trim() }),
        ...(patch.wipLimit !== undefined && { wipLimit: patch.wipLimit }),
        position,
      })
      .where(eq(columns.id, columnId))
      .returning();
    emit({ type: "column.updated", entityId: columnId, payload: toColumn(updated!) });
    return toColumn(updated!);
  });
}

/** Deletes an empty column; 409 conflict if it still contains tasks. */
export async function deleteColumn(p: Principal, columnId: string): Promise<void> {
  const { workspaceId } = await loadColumn(p, columnId);
  await mutate(workspaceId, actorOf(p), async (tx, emit) => {
    await currentColumn(tx, columnId);
    const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(tasks).where(eq(tasks.columnId, columnId));
    if (n > 0) throw conflict(`Column still contains ${n} task(s); move or delete them first`);
    await tx.delete(columns).where(eq(columns.id, columnId));
    emit({ type: "column.deleted", entityId: columnId, payload: { id: columnId } });
  });
}

/**
 * Reorder all columns of a board. `order` must list every column exactly once (ids or names).
 * Positions are regenerated; a `column.updated` event is emitted for each column whose position changed.
 */
export async function reorderColumns(p: Principal, boardId: string, order: string[]): Promise<Column[]> {
  const board = await loadBoard(p, boardId);
  return mutate(board.workspaceId, actorOf(p), async (tx, emit) => {
    await lockedBoard(tx, boardId);
    const current = await boardColumns(tx, boardId);
    const resolved: ColumnRow[] = [];
    for (const ref of order) resolved.push(await resolveColumn(tx, boardId, ref));
    const ids = new Set(resolved.map((c) => c.id));
    if (ids.size !== resolved.length) throw badRequest("Each column may appear only once in the new order");
    if (ids.size !== current.length) {
      const missing = current.filter((c) => !ids.has(c.id)).map((c) => `"${c.name}"`);
      throw badRequest(`The new order must include every column of the board; missing: ${missing.join(", ")}`);
    }
    const positions = initialPositions(resolved.length);
    const result: Column[] = [];
    for (const [i, col] of resolved.entries()) {
      const position = positions[i]!;
      if (position === col.position) {
        result.push(toColumn(col));
        continue;
      }
      const [updated] = await tx.update(columns).set({ position }).where(eq(columns.id, col.id)).returning();
      emit({ type: "column.updated", entityId: col.id, payload: toColumn(updated!) });
      result.push(toColumn(updated!));
    }
    return result;
  });
}
