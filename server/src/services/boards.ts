import { asc, eq } from "drizzle-orm";
import { db, type Tx } from "../db/index.ts";
import { boards, columns, tasks, type BoardRow } from "../db/schema.ts";
import { ApiError, notFound } from "../lib/errors.ts";
import { initialPositions } from "../lib/position.ts";
import { actorOf, type Principal } from "../lib/principal.ts";
import { toBoard, toColumn, toTask, type Board, type Column, type Task } from "../lib/serialize.ts";
import { authorize, loadBoard, requireUser } from "./access.ts";
import { mutate } from "./events.ts";

export const DEFAULT_COLUMNS = ["Backlog", "Ready for Dev", "In Progress", "Review", "Done"] as const;

export async function listBoards(p: Principal, workspaceId: string): Promise<Board[]> {
  await authorize(p, workspaceId);
  const rows = await db.select().from(boards).where(eq(boards.workspaceId, workspaceId)).orderBy(asc(boards.createdAt));
  return rows.map(toBoard);
}

/** Creates a board and seeds the default columns; emits `board.created` then one `column.created` per column. */
export async function createBoard(p: Principal, workspaceId: string, name: string): Promise<Board> {
  await authorize(p, workspaceId);
  return mutate(workspaceId, actorOf(p), async (tx, emit) => {
    const [board] = await tx.insert(boards).values({ workspaceId, name: name.trim() }).returning();
    emit({ type: "board.created", entityId: board!.id, payload: toBoard(board!) });
    const positions = initialPositions(DEFAULT_COLUMNS.length);
    const cols = await tx
      .insert(columns)
      .values(DEFAULT_COLUMNS.map((colName, i) => ({ boardId: board!.id, name: colName, position: positions[i]! })))
      .returning();
    for (const col of cols) emit({ type: "column.created", entityId: col.id, payload: toColumn(col) });
    return toBoard(board!);
  });
}

/**
 * Find a board in a workspace by id or case-insensitive name. When `ref` is omitted and the workspace
 * has exactly one board, that board is returned.
 */
export async function findBoard(p: Principal, workspaceId: string, ref?: string): Promise<Board> {
  const all = await listBoards(p, workspaceId);
  const available = () => all.map((b) => `"${b.name}" (${b.id})`).join(", ") || "none";
  if (!ref) {
    if (all.length === 1) return all[0]!;
    throw new ApiError("bad_request", `Specify a board; available boards: ${available()}`);
  }
  const needle = ref.trim().toLowerCase();
  const matches = all.filter((b) => b.id === needle || b.name.trim().toLowerCase() === needle);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new ApiError("conflict", `Several boards are named "${ref}"; use the board id`);
  throw new ApiError("not_found", `Board "${ref}" not found; available boards: ${available()}`);
}

export interface BoardSnapshot {
  board: Board;
  columns: Column[];
  tasks: Task[];
}

export async function getBoard(p: Principal, boardId: string): Promise<BoardSnapshot> {
  const board = await loadBoard(p, boardId);
  const [cols, taskRows] = await Promise.all([
    db.select().from(columns).where(eq(columns.boardId, board.id)).orderBy(asc(columns.position), asc(columns.id)),
    db.select().from(tasks).where(eq(tasks.boardId, board.id)).orderBy(asc(tasks.position), asc(tasks.id)),
  ]);
  return { board: toBoard(board), columns: cols.map(toColumn), tasks: taskRows.map(toTask) };
}

/** Re-read a board inside a mutation transaction (it may have been deleted since the permission check). */
export async function lockedBoard(tx: Tx, boardId: string): Promise<BoardRow> {
  const [board] = await tx.select().from(boards).where(eq(boards.id, boardId));
  if (!board) throw notFound("Board");
  return board;
}

export async function updateBoard(p: Principal, boardId: string, patch: { name?: string }): Promise<Board> {
  const board = await loadBoard(p, boardId);
  return mutate(board.workspaceId, actorOf(p), async (tx, emit) => {
    await lockedBoard(tx, boardId);
    const [updated] = await tx
      .update(boards)
      .set({ ...(patch.name !== undefined && { name: patch.name.trim() }), updatedAt: new Date() })
      .where(eq(boards.id, boardId))
      .returning();
    emit({ type: "board.updated", entityId: boardId, payload: toBoard(updated!) });
    return toBoard(updated!);
  });
}

/** Deletes the board with all its columns, tasks and comments. Emits a single `board.deleted`. */
/** Deleting a board (with all its columns, tasks and comments) requires the admin role; agents cannot. */
export async function deleteBoard(p: Principal, boardId: string): Promise<void> {
  const board = await loadBoard(p, boardId);
  requireUser(p);
  await authorize(p, board.workspaceId, "admin");
  await mutate(board.workspaceId, actorOf(p), async (tx, emit) => {
    const deleted = await tx.delete(boards).where(eq(boards.id, boardId)).returning({ id: boards.id });
    if (deleted.length === 0) throw notFound("Board");
    emit({ type: "board.deleted", entityId: boardId, payload: { id: boardId } });
  });
}
