import { describe, expect, test } from "bun:test";
import { api, createTask, registerUser, setup } from "./helpers.ts";

describe("permissions", () => {
  test("users cannot touch other workspaces", async () => {
    const a = await setup("Alice");
    const mallory = await registerUser("Mallory");
    const task = await createTask(a.user, a.board.id, a.col("Backlog").id, "secret");
    const t = mallory.token;

    const denied: [string, string, unknown?][] = [
      ["GET", `/workspaces/${a.ws.id}/boards`],
      ["POST", `/workspaces/${a.ws.id}/boards`, { name: "x" }],
      ["GET", `/workspaces/${a.ws.id}/members`],
      ["GET", `/workspaces/${a.ws.id}/events`],
      ["GET", `/workspaces/${a.ws.id}/tasks/search?q=secret`],
      ["GET", `/boards/${a.board.id}`],
      ["PATCH", `/boards/${a.board.id}`, { name: "pwned" }],
      ["DELETE", `/boards/${a.board.id}`],
      ["POST", `/boards/${a.board.id}/tasks`, { title: "x", columnId: a.col("Backlog").id }],
      ["GET", `/tasks/${task.id}`],
      ["PATCH", `/tasks/${task.id}`, { title: "pwned" }],
      ["POST", `/tasks/${task.id}/move`, { columnId: a.col("Done").id }],
      ["DELETE", `/tasks/${task.id}`],
      ["POST", `/tasks/${task.id}/comments`, { body: "hi" }],
      ["PATCH", `/columns/${a.col("Done").id}`, { name: "x" }],
      ["DELETE", `/columns/${a.col("Done").id}`],
    ];
    for (const [method, path, body] of denied) {
      const res = await api(method, path, { token: t, body });
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 403 });
      expect(res.body.error.code).toBe("forbidden");
    }

    const list = await api("GET", "/workspaces", { token: t });
    expect(list.body).toEqual([]);

    // Nothing changed.
    const snap = await api("GET", `/boards/${a.board.id}`, { token: a.user.token });
    expect(snap.body.board.name).toBe("Board");
    expect(snap.body.tasks).toHaveLength(1);
  });

  test("unknown ids are not_found", async () => {
    const a = await setup();
    const missing = "01900000-0000-7000-8000-000000000000";
    for (const path of [`/boards/${missing}`, `/tasks/${missing}`, `/boards/not-a-uuid`]) {
      const res = await api("GET", path, { token: a.user.token });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("not_found");
    }
  });

  test("invites, roles and member removal", async () => {
    const a = await setup("Owner");
    const bob = await registerUser("Bob");
    const carol = await registerUser("Carol");

    const inv = await api("POST", `/workspaces/${a.ws.id}/invites`, { token: a.user.token, body: { role: "member" } });
    expect(inv.status).toBe(200);
    expect(inv.body.url).toContain(inv.body.token);

    const accepted = await api("POST", `/invites/${inv.body.token}/accept`, { token: bob.token });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ id: a.ws.id, role: "member" });

    // Single use.
    expect((await api("POST", `/invites/${inv.body.token}/accept`, { token: carol.token })).status).toBe(404);

    // Members are not admins: can't invite, manage keys or remove others.
    expect((await api("POST", `/workspaces/${a.ws.id}/invites`, { token: bob.token, body: { role: "member" } })).status).toBe(403);
    expect((await api("GET", `/workspaces/${a.ws.id}/api-keys`, { token: bob.token })).status).toBe(403);
    expect((await api("POST", `/workspaces/${a.ws.id}/api-keys`, { token: bob.token, body: { name: "x" } })).status).toBe(403);
    expect((await api("DELETE", `/workspaces/${a.ws.id}/members/${a.user.id}`, { token: bob.token })).status).toBe(403);

    // But can work on boards.
    expect((await api("GET", `/boards/${a.board.id}`, { token: bob.token })).status).toBe(200);

    const members = await api("GET", `/workspaces/${a.ws.id}/members`, { token: bob.token });
    expect(members.body.map((m: any) => [m.name, m.role])).toEqual([
      ["Owner", "owner"],
      ["Bob", "member"],
    ]);

    // Owner cannot be removed; owner removes Bob.
    expect((await api("DELETE", `/workspaces/${a.ws.id}/members/${a.user.id}`, { token: a.user.token })).status).toBe(403);
    expect((await api("DELETE", `/workspaces/${a.ws.id}/members/${bob.id}`, { token: a.user.token })).status).toBe(204);
    expect((await api("GET", `/boards/${a.board.id}`, { token: bob.token })).status).toBe(403);

    const events = await api("GET", `/workspaces/${a.ws.id}/events`, { token: a.user.token });
    const types = events.body.events.map((e: any) => e.type);
    expect(types.filter((t: string) => t.startsWith("member."))).toEqual(["member.added", "member.added", "member.removed"]);
  });

  test("api keys are confined to their workspace and cannot do admin actions", async () => {
    const a = await setup("Owner");
    const b = await setup("Other");
    const created = await api("POST", `/workspaces/${a.ws.id}/api-keys`, { token: a.user.token, body: { name: "Claude" } });
    expect(created.status).toBe(200);
    const key = created.body.secret as string;
    expect(key).toStartWith("kb_");
    expect(created.body.apiKey).toMatchObject({ name: "Claude", workspaceId: a.ws.id, prefix: key.slice(0, 8), lastUsedAt: null });

    // Works in its workspace via REST.
    expect((await api("GET", `/boards/${a.board.id}`, { token: key })).status).toBe(200);
    const wsList = await api("GET", "/workspaces", { token: key });
    expect(wsList.body.map((w: any) => w.id)).toEqual([a.ws.id]);

    // Denied elsewhere and for admin operations.
    expect((await api("GET", `/boards/${b.board.id}`, { token: key })).status).toBe(403);
    expect((await api("GET", `/workspaces/${b.ws.id}/boards`, { token: key })).status).toBe(403);
    expect((await api("GET", `/workspaces/${a.ws.id}/api-keys`, { token: key })).status).toBe(403);
    expect((await api("POST", `/workspaces/${a.ws.id}/invites`, { token: key, body: { role: "member" } })).status).toBe(403);
    expect((await api("POST", "/workspaces", { token: key, body: { name: "x" } })).status).toBe(403);

    const keys = await api("GET", `/workspaces/${a.ws.id}/api-keys`, { token: a.user.token });
    expect(keys.body).toHaveLength(1);
    expect(keys.body[0].lastUsedAt).not.toBeNull();
    expect(JSON.stringify(keys.body)).not.toContain(key);

    // Other workspace's owner can't delete it; own owner can, and then it stops working.
    expect((await api("DELETE", `/api-keys/${created.body.apiKey.id}`, { token: b.user.token })).status).toBe(403);
    expect((await api("DELETE", `/api-keys/${created.body.apiKey.id}`, { token: a.user.token })).status).toBe(204);
    expect((await api("GET", `/boards/${a.board.id}`, { token: key })).status).toBe(401);
  });
  test("only admins may delete boards; agents cannot delete boards, columns or tasks", async () => {
    const a = await setup("Owner");
    const bob = await registerUser("Bob");
    const inv = await api("POST", `/workspaces/${a.ws.id}/invites`, { token: a.user.token, body: { role: "member" } });
    expect((await api("POST", `/invites/${inv.body.token}/accept`, { token: bob.token })).status).toBe(200);
    const key = (await api("POST", `/workspaces/${a.ws.id}/api-keys`, { token: a.user.token, body: { name: "Agent" } }))
      .body.secret as string;
    const task = await createTask(a.user, a.board.id, a.col("Backlog").id, "keep me");
    const emptyCol = a.col("Done").id;

    // Agents: forbidden for all three deletes, nothing removed.
    for (const path of [`/boards/${a.board.id}`, `/columns/${emptyCol}`, `/tasks/${task.id}`]) {
      const res = await api("DELETE", path, { token: key });
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
      expect(res.body.error.code).toBe("forbidden");
    }
    // Agents can still do regular member work.
    expect((await api("PATCH", `/tasks/${task.id}`, { token: key, body: { title: "renamed" } })).status).toBe(200);

    // Plain members cannot delete a board, but can delete tasks and columns.
    const del = await api("DELETE", `/boards/${a.board.id}`, { token: bob.token });
    expect(del.status).toBe(403);
    expect(del.body.error.message).toContain("admin");
    const snap = await api("GET", `/boards/${a.board.id}`, { token: a.user.token });
    expect(snap.body.tasks).toHaveLength(1);
    expect(snap.body.columns.map((c: any) => c.id)).toContain(emptyCol);
    expect((await api("DELETE", `/tasks/${task.id}`, { token: bob.token })).status).toBe(204);
    expect((await api("DELETE", `/columns/${emptyCol}`, { token: bob.token })).status).toBe(204);

    // Admins (and the owner) may delete boards.
    const carol = await registerUser("Carol");
    const adminInv = await api("POST", `/workspaces/${a.ws.id}/invites`, { token: a.user.token, body: { role: "admin" } });
    expect((await api("POST", `/invites/${adminInv.body.token}/accept`, { token: carol.token })).status).toBe(200);
    expect((await api("DELETE", `/boards/${a.board.id}`, { token: carol.token })).status).toBe(204);
    expect((await api("GET", `/boards/${a.board.id}`, { token: a.user.token })).status).toBe(404);
  });
});
