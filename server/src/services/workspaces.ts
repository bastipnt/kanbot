import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { db, type Executor } from "../db/index.ts";
import { events, invites, users, workspaceMembers, workspaces, type Role } from "../db/schema.ts";
import { env } from "../env.ts";
import { randomToken, sha256 } from "../lib/crypto.ts";
import { forbidden, notFound } from "../lib/errors.ts";
import { actorOf, type Principal } from "../lib/principal.ts";
import { toMember, toWorkspace, type Member, type Workspace } from "../lib/serialize.ts";
import { hub } from "../realtime/hub.ts";
import { authorize } from "./access.ts";
import { mutate } from "./events.ts";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function requireUser(p: Principal) {
  if (p.kind !== "user") throw forbidden("This action requires a user account");
  return p.user;
}

export async function listWorkspaces(p: Principal): Promise<Workspace[]> {
  if (p.kind === "agent") {
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, p.apiKey.workspaceId));
    return ws ? [toWorkspace(ws, "member")] : [];
  }
  const rows = await db
    .select({ ws: workspaces, role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, p.user.id))
    .orderBy(asc(workspaces.createdAt));
  return rows.map((r) => toWorkspace(r.ws, r.role));
}

export async function createWorkspace(p: Principal, name: string): Promise<Workspace> {
  const user = requireUser(p);
  const actor = actorOf(p);
  // One transaction: workspace, owner membership and its `member.added` event (seq 1).
  // Nobody can be subscribed to a brand-new workspace, so there is nothing to publish.
  const ws = await db.transaction(async (tx) => {
    const [ws] = await tx.insert(workspaces).values({ name: name.trim(), eventSeq: 1 }).returning();
    const member = await addMember(tx, ws!.id, user.id, "owner");
    await tx.insert(events).values({
      workspaceId: ws!.id,
      seq: 1,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      type: "member.added",
      entityId: user.id,
      payload: member,
    });
    return ws!;
  });
  return toWorkspace(ws, "owner");
}

async function memberRow(ex: Executor, workspaceId: string, userId: string): Promise<Member | undefined> {
  const [row] = await ex
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      role: workspaceMembers.role,
      joinedAt: workspaceMembers.joinedAt,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
  return row && toMember(row);
}

async function addMember(ex: Executor, workspaceId: string, userId: string, role: Role): Promise<Member> {
  await ex.insert(workspaceMembers).values({ workspaceId, userId, role });
  return (await memberRow(ex, workspaceId, userId))!;
}

export async function listMembers(p: Principal, workspaceId: string): Promise<Member[]> {
  await authorize(p, workspaceId);
  const rows = await db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      role: workspaceMembers.role,
      joinedAt: workspaceMembers.joinedAt,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .orderBy(asc(workspaceMembers.joinedAt));
  return rows.map(toMember);
}

/** Admin+ creates a single-use invite link valid for 7 days. Only owners may invite admins. */
export async function createInvite(
  p: Principal,
  workspaceId: string,
  role: "admin" | "member",
): Promise<{ token: string; url: string }> {
  const user = requireUser(p);
  await authorize(p, workspaceId, "admin");
  const token = randomToken(24);
  await db.insert(invites).values({
    workspaceId,
    tokenHash: sha256(token),
    role,
    createdBy: user.id,
    expiresAt: new Date(Date.now() + INVITE_TTL_MS),
  });
  return { token, url: `${env.publicUrl}/invites/${token}` };
}

export async function acceptInvite(p: Principal, token: string): Promise<Workspace> {
  const user = requireUser(p);
  const [invite] = await db
    .select()
    .from(invites)
    .where(and(eq(invites.tokenHash, sha256(token)), gt(invites.expiresAt, new Date())));
  if (!invite) throw notFound("Invite");

  const role = await mutate(invite.workspaceId, actorOf(p), async (tx, emit) => {
    const [existing] = await tx
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, invite.workspaceId), eq(workspaceMembers.userId, user.id)));
    if (existing) return existing.role; // Already a member: idempotent, invite stays unused.

    const [claimed] = await tx
      .update(invites)
      .set({ acceptedBy: user.id, acceptedAt: new Date() })
      .where(and(eq(invites.id, invite.id), isNull(invites.acceptedAt)))
      .returning();
    if (!claimed) throw notFound("Invite");
    const member = await addMember(tx, invite.workspaceId, user.id, invite.role);
    emit({ type: "member.added", entityId: user.id, payload: member });
    return invite.role;
  });

  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, invite.workspaceId));
  return toWorkspace(ws!, role);
}

/**
 * Remove a member. Admin+ may remove members; only owners may remove admins; the owner cannot be removed.
 * Any member may remove themselves (leave), except the owner.
 */
export async function removeMember(p: Principal, workspaceId: string, userId: string): Promise<void> {
  const self = p.kind === "user" && p.user.id === userId;
  const myRole = await authorize(p, workspaceId, self ? "member" : "admin");
  await mutate(workspaceId, actorOf(p), async (tx, emit) => {
    const [target] = await tx
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
    if (!target) throw notFound("Member");
    if (target.role === "owner") throw forbidden("The workspace owner cannot be removed");
    if (!self && target.role === "admin" && myRole !== "owner") throw forbidden("Only the owner can remove admins");
    await tx
      .delete(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
    emit({ type: "member.removed", entityId: userId, payload: { id: userId } });
  });
  hub.kick(workspaceId, userId);
}
