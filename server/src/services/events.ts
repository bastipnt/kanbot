import { and, asc, eq, gt } from "drizzle-orm";
import { db, type Tx } from "../db/index.ts";
import { events, workspaces, type EventRow } from "../db/schema.ts";
import { notFound } from "../lib/errors.ts";
import type { Actor, Principal } from "../lib/principal.ts";
import { toEvent, type Event } from "../lib/serialize.ts";
import { hub } from "../realtime/hub.ts";
import { authorize } from "./access.ts";

export type EventType =
  | "board.created"
  | "board.updated"
  | "board.deleted"
  | "column.created"
  | "column.updated"
  | "column.deleted"
  | "task.created"
  | "task.updated"
  | "task.moved"
  | "task.deleted"
  | "comment.created"
  | "member.added"
  | "member.removed";

export interface EventDraft {
  type: EventType;
  entityId: string;
  /** Full entity after the change (API shape), or `{ id }` on delete. */
  payload: unknown;
}

export type Emit = (draft: EventDraft) => void;

/** Rows per multi-row INSERT, keeping well under Postgres' 65 535 bind-parameter limit. */
export const INSERT_CHUNK = 1000;

export function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

/**
 * Run a workspace mutation. Inside one transaction:
 *  1. lock the workspace row (`SELECT ... FOR UPDATE`) — this serialises all mutations of a workspace,
 *     which makes seq allocation gap-free and position computation race-free;
 *  2. run `fn`, which writes entities and calls `emit` for each resulting event;
 *  3. insert the events with consecutive seqs and bump the workspace counter.
 * After COMMIT the events are published to the realtime hub.
 */
export async function mutate<T>(
  workspaceId: string,
  actor: Actor,
  fn: (tx: Tx, emit: Emit) => Promise<T>,
): Promise<T> {
  const written: EventRow[] = [];
  const result = await db.transaction(async (tx) => {
    const [ws] = await tx
      .select({ seq: workspaces.eventSeq })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .for("update");
    if (!ws) throw notFound("Workspace");

    const drafts: EventDraft[] = [];
    const value = await fn(tx, (d) => drafts.push(d));

    if (drafts.length > 0) {
      let seq = ws.seq;
      const rows = drafts.map((d) => ({
        workspaceId,
        seq: ++seq,
        actorType: actor.type,
        actorId: actor.id,
        actorName: actor.name,
        type: d.type,
        entityId: d.entityId,
        payload: d.payload ?? {},
      }));
      for (const chunk of chunks(rows, INSERT_CHUNK)) {
        written.push(...(await tx.insert(events).values(chunk).returning()));
      }
      await tx.update(workspaces).set({ eventSeq: seq }).where(eq(workspaces.id, workspaceId));
    }
    return value;
  });

  for (const e of written.sort((a, b) => a.seq - b.seq)) hub.publish(toEvent(e));
  return result;
}

export async function latestSeq(workspaceId: string): Promise<number> {
  const [ws] = await db
    .select({ seq: workspaces.eventSeq })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!ws) throw notFound("Workspace");
  return ws.seq;
}

export async function listEvents(
  p: Principal,
  workspaceId: string,
  since = 0,
  limit = 500,
): Promise<{ events: Event[]; latestSeq: number }> {
  await authorize(p, workspaceId);
  // Read latestSeq first: every event with seq <= latestSeq is committed, so a client that
  // stores `latestSeq` and later asks `since=latestSeq` never skips anything.
  const latest = await latestSeq(workspaceId);
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.workspaceId, workspaceId), gt(events.seq, since)))
    .orderBy(asc(events.seq))
    .limit(limit);
  // A page shorter than `limit` means the client is caught up to `latestSeq`; otherwise it pages
  // again with `since = last event's seq`.
  return { events: rows.filter((r) => r.seq <= latest).map(toEvent), latestSeq: latest };
}
