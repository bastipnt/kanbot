import { describe, expect, test } from "bun:test";
import { api, connectWs, createTask, setup } from "./helpers.ts";

describe("events & realtime", () => {
  test("seq is strictly increasing and gap-free under concurrency; events endpoint pages with since", async () => {
    const { user, ws, board, col } = await setup();
    const backlog = col("Backlog").id;

    // Fire many concurrent mutations at the same workspace.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        api("POST", `/boards/${board.id}/tasks`, { token: user.token, body: { title: `T${i}`, columnId: backlog } }),
      ),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);

    const all = await api("GET", `/workspaces/${ws.id}/events?since=0`, { token: user.token });
    expect(all.status).toBe(200);
    const seqs: number[] = all.body.events.map((e: any) => e.seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
    expect(all.body.latestSeq).toBe(seqs.at(-1));
    // member.added(owner) + board.created + 5 column.created + 20 task.created
    expect(seqs.length).toBe(27);
    expect(all.body.events.slice(0, 3).map((e: any) => e.type)).toEqual(["member.added", "board.created", "column.created"]);

    // Concurrent inserts into the same column got distinct positions.
    const snap = await api("GET", `/boards/${board.id}`, { token: user.token });
    const positions = snap.body.tasks.map((t: any) => t.position);
    expect(new Set(positions).size).toBe(20);

    const ev = all.body.events.find((e: any) => e.type === "task.created");
    expect(ev).toMatchObject({
      workspaceId: ws.id,
      actor: { type: "user", id: user.id, name: user.name },
      entityId: ev.payload.id,
      payload: { boardId: board.id, columnId: backlog },
      createdAt: expect.any(String),
    });

    const since = await api("GET", `/workspaces/${ws.id}/events?since=20&limit=3`, { token: user.token });
    expect(since.body.events.map((e: any) => e.seq)).toEqual([21, 22, 23]);
    expect(since.body.latestSeq).toBe(27);

    // Delete emits {id} payload.
    const t = snap.body.tasks[0];
    await api("DELETE", `/tasks/${t.id}`, { token: user.token });
    const del = await api("GET", `/workspaces/${ws.id}/events?since=27`, { token: user.token });
    expect(del.body.events).toEqual([
      expect.objectContaining({ seq: 28, type: "task.deleted", entityId: t.id, payload: { id: t.id } }),
    ]);

    const bad = await api("GET", `/workspaces/${ws.id}/events?since=-1`, { token: user.token });
    expect(bad.status).toBe(400);
  });

  test("websocket: hello with latestSeq, event push, ping/pong", async () => {
    const { user, ws, board, col } = await setup();
    const before = await api("GET", `/workspaces/${ws.id}/events`, { token: user.token });

    const sock = connectWs(user.token, ws.id);
    await sock.opened;
    const hello = await sock.next((m) => m.kind === "hello");
    expect(hello).toEqual({ kind: "hello", latestSeq: before.body.latestSeq });

    const task = await createTask(user, board.id, col("Backlog").id, "Realtime!");
    const pushed = await sock.next((m) => m.kind === "event");
    expect(pushed.event).toMatchObject({
      seq: before.body.latestSeq + 1,
      type: "task.created",
      entityId: task.id,
      payload: { title: "Realtime!" },
      actor: { type: "user", id: user.id },
    });

    await api("POST", `/tasks/${task.id}/move`, { token: user.token, body: { columnId: col("Done").id } });
    const moved = await sock.next((m) => m.kind === "event" && m.event.type === "task.moved");
    expect(moved.event.seq).toBe(before.body.latestSeq + 2);
    expect(moved.event.payload.columnId).toBe(col("Done").id);

    sock.ws.send(JSON.stringify({ kind: "ping" }));
    expect(await sock.next((m) => m.kind === "pong")).toEqual({ kind: "pong" });
    sock.ws.close();
  });

  test("websocket rejects bad token and foreign workspaces", async () => {
    const a = await setup("A");
    const b = await setup("B");
    const { baseUrl } = await import("./helpers.ts");
    const res = await fetch(`${baseUrl()}/ws?token=bad&workspaceId=${a.ws.id}`, { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(401);
    const res2 = await fetch(`${baseUrl()}/ws?token=${b.user.token}&workspaceId=${a.ws.id}`, {
      headers: { Upgrade: "websocket" },
    });
    expect(res2.status).toBe(403);
    expect(((await res2.json()) as any).error.code).toBe("forbidden");
  });
  test("deleting an API key closes its WebSockets with 4403", async () => {
    const { user, ws, board, col } = await setup();
    const mk = async (name: string) =>
      (await api("POST", `/workspaces/${ws.id}/api-keys`, { token: user.token, body: { name } })).body;
    const revoked = await mk("Revoked");
    const kept = await mk("Kept");

    const closed = (s: ReturnType<typeof connectWs>) =>
      new Promise<{ code: number; reason: string }>((resolve) => {
        s.ws.onclose = (e) => resolve({ code: e.code, reason: e.reason });
      });
    const agent = connectWs(revoked.secret, ws.id);
    const other = connectWs(kept.secret, ws.id);
    const human = connectWs(user.token, ws.id);
    for (const s of [agent, other, human]) {
      await s.opened;
      await s.next((m) => m.kind === "hello");
    }
    const agentClosed = closed(agent);

    expect((await api("DELETE", `/api-keys/${revoked.apiKey.id}`, { token: user.token })).status).toBe(204);
    expect(await agentClosed).toEqual({ code: 4403, reason: "API key revoked" });

    // Other connections in the workspace keep receiving events.
    const task = await createTask(user, board.id, col("Backlog").id, "still live");
    for (const s of [other, human]) {
      const msg = await s.next((m) => m.kind === "event" && m.event.type === "task.created");
      expect(msg.event.entityId).toBe(task.id);
      expect(s.ws.readyState).toBe(WebSocket.OPEN);
      s.ws.close();
    }
  });
});
