import { describe, expect, test } from "bun:test";
import { api, baseUrl, createTask, createWorkspace, registerUser, setup } from "./helpers.ts";

/** A board with a custom column, an assigned task with details and comments from a user and an agent. */
async function populatedBoard() {
  const s = await setup("Owner");
  const { user, board, col } = s;
  const qa = await api("POST", `/boards/${board.id}/columns`, {
    token: user.token,
    body: { name: "QA", afterId: col("Review").id, wipLimit: 2 },
  });
  const a = await createTask(user, board.id, col("Backlog").id, "A");
  const b = await createTask(user, board.id, col("Backlog").id, "B");
  await api("POST", `/tasks/${b.id}/move`, { token: user.token, body: { columnId: col("Backlog").id, beforeId: a.id } });
  const detailed = await api("POST", `/boards/${board.id}/tasks`, {
    token: user.token,
    body: {
      title: "Ship it",
      columnId: qa.body.id,
      description: "## Steps",
      labels: ["release", "p1"],
      dueAt: "2026-10-01T12:00:00Z",
      assigneeId: user.id,
    },
  });
  await api("POST", `/tasks/${detailed.body.id}/comments`, { token: user.token, body: { body: "first" } });
  const key = await api("POST", `/workspaces/${s.ws.id}/api-keys`, { token: user.token, body: { name: "Bot" } });
  await api("POST", `/tasks/${detailed.body.id}/comments`, { token: key.body.secret, body: { body: "second" } });
  return { ...s, secret: key.body.secret as string, detailed: detailed.body };
}

const outline = (snap: any) =>
  snap.columns.map((c: any) => ({
    name: c.name,
    wipLimit: c.wipLimit,
    tasks: snap.tasks
      .filter((t: any) => t.columnId === c.id)
      .sort((x: any, y: any) => (x.position < y.position ? -1 : x.position > y.position ? 1 : 0))
      .map((t: any) => t.title),
  }));

describe("board export/import", () => {
  test("export is a portable file in board order", async () => {
    const { user, board, detailed } = await populatedBoard();
    const res = await fetch(`${baseUrl()}/boards/${board.id}/export`, {
      headers: { Authorization: `Bearer ${user.token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe(`attachment; filename="Board.json"; filename*=UTF-8''Board.json`);
    const file = (await res.json()) as any;

    expect(file).toMatchObject({ format: "kanbot.board", version: 1, board: { name: "Board" } });
    expect(file.columns.map((c: any) => [c.name, c.wipLimit, c.tasks.map((t: any) => t.title)])).toEqual([
      ["Backlog", null, ["B", "A"]],
      ["Ready for Dev", null, []],
      ["In Progress", null, []],
      ["Review", null, []],
      ["QA", 2, ["Ship it"]],
      ["Done", null, []],
    ]);
    const task = file.columns[4].tasks[0];
    expect(task).toEqual({
      title: "Ship it",
      description: "## Steps",
      labels: ["release", "p1"],
      dueAt: "2026-10-01T12:00:00.000Z",
      assignee: { name: user.name, email: user.email },
      createdBy: { type: "user", id: user.id, name: user.name },
      createdAt: detailed.createdAt,
      comments: [
        { body: "first", actor: { type: "user", id: user.id, name: user.name }, createdAt: expect.any(String) },
        { body: "second", actor: { type: "agent", id: expect.any(String), name: "Bot" }, createdAt: expect.any(String) },
      ],
    });
    expect(JSON.stringify(file)).not.toContain(board.id);
  });

  test("import into the same workspace recreates the board as a new one", async () => {
    const { user, ws, board } = await populatedBoard();
    const file = (await api("GET", `/boards/${board.id}/export`, { token: user.token })).body;
    const { latestSeq: before } = (await api("GET", `/workspaces/${ws.id}/events?since=0&limit=1`, { token: user.token }))
      .body;

    const imported = await api("POST", `/workspaces/${ws.id}/boards/import`, { token: user.token, body: file });
    expect(imported.status).toBe(200);
    expect(imported.body).toMatchObject({ workspaceId: ws.id, name: "Board" });
    expect(imported.body.id).not.toBe(board.id);

    const [orig, copy] = await Promise.all(
      [board.id, imported.body.id].map(async (id) => (await api("GET", `/boards/${id}`, { token: user.token })).body),
    );
    expect(outline(copy)).toEqual(outline(orig));
    const task = copy.tasks.find((t: any) => t.title === "Ship it");
    expect(task).toMatchObject({
      description: "## Steps",
      labels: ["release", "p1"],
      dueAt: "2026-10-01T12:00:00.000Z",
      assigneeId: user.id,
      createdBy: { type: "user", id: user.id },
    });
    const origTask = orig.tasks.find((t: any) => t.title === "Ship it");
    expect(task.createdAt).toBe(origTask.createdAt);

    const detail = (await api("GET", `/tasks/${task.id}`, { token: user.token })).body;
    expect(detail.comments.map((c: any) => [c.body, c.actor.id])).toEqual([
      ["first", user.id],
      ["*Originally by Bot*\n\nsecond", user.id],
    ]);

    const { events } = (await api("GET", `/workspaces/${ws.id}/events?since=${before}`, { token: user.token })).body;
    expect(events.map((e: any) => e.type)).toEqual([
      "board.created",
      ...Array(6).fill("column.created"),
      ...Array(3).fill("task.created"),
      ...Array(2).fill("comment.created"),
    ]);
    expect(events.every((e: any) => e.actor.id === user.id)).toBe(true);
  });

  test("import elsewhere drops assignees who are not members and attributes to the importer", async () => {
    const { user, board } = await populatedBoard();
    const file = (await api("GET", `/boards/${board.id}/export`, { token: user.token })).body;
    const other = await registerUser("Other");
    const ws2 = await createWorkspace(other, "Elsewhere");

    const imported = await api("POST", `/workspaces/${ws2.id}/boards/import`, { token: other.token, body: file });
    expect(imported.status).toBe(200);
    const copy = (await api("GET", `/boards/${imported.body.id}`, { token: other.token })).body;
    const task = copy.tasks.find((t: any) => t.title === "Ship it");
    expect(task.assigneeId).toBeNull();
    expect(task.createdBy).toEqual({ type: "user", id: other.id, name: "Other" });
    const detail = (await api("GET", `/tasks/${task.id}`, { token: other.token })).body;
    expect(detail.comments.map((c: any) => c.body)).toEqual([
      "*Originally by Owner*\n\nfirst",
      "*Originally by Bot*\n\nsecond",
    ]);
  });

  test("minimal hand-written file", async () => {
    const { user, ws } = await setup();
    const res = await api("POST", `/workspaces/${ws.id}/boards/import`, {
      token: user.token,
      body: {
        format: "kanbot.board",
        version: 1,
        board: { name: " Roadmap " },
        columns: [{ name: "Todo", tasks: [{ title: "One", labels: ["x", "x "] }] }, { name: "Done" }],
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Roadmap");
    const snap = (await api("GET", `/boards/${res.body.id}`, { token: user.token })).body;
    expect(outline(snap)).toEqual([
      { name: "Todo", wipLimit: null, tasks: ["One"] },
      { name: "Done", wipLimit: null, tasks: [] },
    ]);
    expect(snap.tasks[0]).toMatchObject({ labels: ["x"], description: "", assigneeId: null, dueAt: null });
  });

  test("rejects invalid files", async () => {
    const { user, ws } = await setup();
    const post = (body: unknown) => api("POST", `/workspaces/${ws.id}/boards/import`, { token: user.token, body });
    const base = { format: "kanbot.board", version: 1, board: { name: "B" }, columns: [] };

    for (const body of [
      { ...base, format: "trello" },
      { ...base, version: 2 },
      { ...base, board: { name: "" } },
      { ...base, columns: [{ name: "C", tasks: [{ title: "" }] }] },
      { ...base, columns: [{ name: "C", tasks: [{ title: "T", dueAt: "tomorrow" }] }] },
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("bad_request");
    }
    const tooMany = { ...base, columns: [0, 1].map((i) => ({ name: `C${i}`, tasks: Array(5001).fill({ title: "t" }) })) };
    expect((await post(tooMany)).status).toBe(400);

    const malformed = await fetch(`${baseUrl()}/workspaces/${ws.id}/boards/import`, {
      method: "POST",
      headers: { Authorization: `Bearer ${user.token}`, "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
  });

  test("permissions", async () => {
    const { user, ws, board, secret } = await populatedBoard();
    const outsider = await registerUser("Outsider");
    const file = (await api("GET", `/boards/${board.id}/export`, { token: user.token })).body;

    expect((await api("GET", `/boards/${board.id}/export`, { token: outsider.token })).status).toBe(403);
    expect((await api("POST", `/workspaces/${ws.id}/boards/import`, { token: outsider.token, body: file })).status).toBe(
      403,
    );

    // API keys act as members in their own workspace only.
    expect((await api("GET", `/boards/${board.id}/export`, { token: secret })).status).toBe(200);
    const byAgent = await api("POST", `/workspaces/${ws.id}/boards/import`, { token: secret, body: file });
    expect(byAgent.status).toBe(200);
    const otherWs = await createWorkspace(user, "Other");
    expect((await api("POST", `/workspaces/${otherWs.id}/boards/import`, { token: secret, body: file })).status).toBe(403);
  });

  test("large import is written in chunks", async () => {
    const { user, ws } = await setup();
    const tasks = Array.from({ length: 2500 }, (_, i) => ({ title: `T${i}`, comments: [{ body: "c" }] }));
    const res = await api("POST", `/workspaces/${ws.id}/boards/import`, {
      token: user.token,
      body: { format: "kanbot.board", version: 1, board: { name: "Big" }, columns: [{ name: "All", tasks }] },
    });
    expect(res.status).toBe(200);
    const snap = (await api("GET", `/boards/${res.body.id}`, { token: user.token })).body;
    expect(outline(snap)[0].tasks).toEqual(tasks.map((t) => t.title));
  });
});
