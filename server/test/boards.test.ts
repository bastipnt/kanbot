import { describe, expect, test } from "bun:test";
import { api, createTask, registerUser, setup } from "./helpers.ts";

const titlesIn = (snap: any, columnId: string) =>
  snap.tasks
    .filter((t: any) => t.columnId === columnId)
    .sort((a: any, b: any) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0))
    .map((t: any) => t.title);

describe("boards, columns, tasks", () => {
  test("board CRUD with seeded columns", async () => {
    const { user, ws, board, columns } = await setup();
    expect(columns.map((c) => c.name)).toEqual(["Backlog", "Ready for Dev", "In Progress", "Review", "Done"]);
    const positions = columns.map((c) => c.position);
    expect([...positions].sort()).toEqual(positions);
    expect(columns[0]).toEqual({ id: expect.any(String), boardId: board.id, name: "Backlog", position: expect.any(String), wipLimit: null });

    const list = await api("GET", `/workspaces/${ws.id}/boards`, { token: user.token });
    expect(list.body.map((b: any) => b.id)).toEqual([board.id]);

    const renamed = await api("PATCH", `/boards/${board.id}`, { token: user.token, body: { name: "Roadmap" } });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ id: board.id, workspaceId: ws.id, name: "Roadmap" });

    await createTask(user, board.id, columns[0].id, "doomed");
    expect((await api("DELETE", `/boards/${board.id}`, { token: user.token })).status).toBe(204);
    expect((await api("GET", `/boards/${board.id}`, { token: user.token })).status).toBe(404);
  });

  test("columns: create after, reorder, wip limit, delete only when empty", async () => {
    const { user, board, col } = await setup();
    const qa = await api("POST", `/boards/${board.id}/columns`, {
      token: user.token,
      body: { name: "QA", afterId: col("Review").id, wipLimit: 3 },
    });
    expect(qa.status).toBe(200);
    expect(qa.body).toMatchObject({ name: "QA", wipLimit: 3 });

    const order = async () =>
      (await api("GET", `/boards/${board.id}`, { token: user.token })).body.columns.map((c: any) => c.name);
    expect(await order()).toEqual(["Backlog", "Ready for Dev", "In Progress", "Review", "QA", "Done"]);

    const moved = await api("PATCH", `/columns/${qa.body.id}`, {
      token: user.token,
      body: { beforeId: col("Backlog").id, name: "Triage", wipLimit: null },
    });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ name: "Triage", wipLimit: null });
    expect(await order()).toEqual(["Triage", "Backlog", "Ready for Dev", "In Progress", "Review", "Done"]);

    await createTask(user, board.id, qa.body.id, "blocker");
    const conflict = await api("DELETE", `/columns/${qa.body.id}`, { token: user.token });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("conflict");
    expect((await api("DELETE", `/columns/${col("Done").id}`, { token: user.token })).status).toBe(204);
  });

  test("task CRUD, comments, search", async () => {
    const { user, ws, board, col } = await setup();
    const created = await api("POST", `/boards/${board.id}/tasks`, {
      token: user.token,
      body: {
        title: "Write docs",
        columnId: col("Backlog").id,
        description: "# Hello",
        labels: ["docs", "docs", " p1 "],
        dueAt: "2026-10-01T12:00:00Z",
        assigneeId: user.id,
      },
    });
    expect(created.status).toBe(200);
    const task = created.body;
    expect(task).toMatchObject({
      boardId: board.id,
      columnId: col("Backlog").id,
      title: "Write docs",
      description: "# Hello",
      labels: ["docs", "p1"],
      dueAt: "2026-10-01T12:00:00.000Z",
      assigneeId: user.id,
      createdBy: { type: "user", id: user.id, name: user.name },
    });

    const outsider = await registerUser("Outsider");
    const badAssignee = await api("PATCH", `/tasks/${task.id}`, { token: user.token, body: { assigneeId: outsider.id } });
    expect(badAssignee.status).toBe(400);

    const patched = await api("PATCH", `/tasks/${task.id}`, {
      token: user.token,
      body: { title: "Write API docs", dueAt: null, assigneeId: null, labels: [] },
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ title: "Write API docs", dueAt: null, assigneeId: null, labels: [], description: "# Hello" });

    const comment = await api("POST", `/tasks/${task.id}/comments`, { token: user.token, body: { body: "On it" } });
    expect(comment.status).toBe(200);
    expect(comment.body).toMatchObject({ taskId: task.id, body: "On it", actor: { type: "user", id: user.id } });

    const got = await api("GET", `/tasks/${task.id}`, { token: user.token });
    expect(got.body.task.title).toBe("Write API docs");
    expect(got.body.comments.map((c: any) => c.body)).toEqual(["On it"]);

    await createTask(user, board.id, col("Backlog").id, "Unrelated 100%_thing");
    const search = await api("GET", `/workspaces/${ws.id}/tasks/search?q=api`, { token: user.token });
    expect(search.status).toBe(200);
    expect(search.body.map((t: any) => t.id)).toEqual([task.id]);
    const like = await api("GET", `/workspaces/${ws.id}/tasks/search?q=${encodeURIComponent("%_")}`, { token: user.token });
    expect(like.body.map((t: any) => t.title)).toEqual(["Unrelated 100%_thing"]);

    expect((await api("DELETE", `/tasks/${task.id}`, { token: user.token })).status).toBe(204);
    expect((await api("GET", `/tasks/${task.id}`, { token: user.token })).status).toBe(404);
  });

  test("move ordering with beforeId/afterId", async () => {
    const { user, board, col } = await setup();
    const backlog = col("Backlog").id;
    const ready = col("Ready for Dev").id;
    const [a, b, c] = [
      await createTask(user, board.id, backlog, "A"),
      await createTask(user, board.id, backlog, "B"),
      await createTask(user, board.id, backlog, "C"),
    ];
    const snap = async () => (await api("GET", `/boards/${board.id}`, { token: user.token })).body;
    expect(titlesIn(await snap(), backlog)).toEqual(["A", "B", "C"]);

    const move = (id: string, body: object) => api("POST", `/tasks/${id}/move`, { token: user.token, body });

    // Within column: C before A.
    expect((await move(c.id, { columnId: backlog, beforeId: a.id })).status).toBe(200);
    expect(titlesIn(await snap(), backlog)).toEqual(["C", "A", "B"]);

    // Within column: C after A.
    await move(c.id, { columnId: backlog, afterId: a.id });
    expect(titlesIn(await snap(), backlog)).toEqual(["A", "C", "B"]);

    // To another column (end by default), then between.
    const movedB = await move(b.id, { columnId: ready });
    expect(movedB.body.columnId).toBe(ready);
    await move(a.id, { columnId: ready });
    await move(c.id, { columnId: ready, afterId: b.id, beforeId: a.id });
    const s = await snap();
    expect(titlesIn(s, backlog)).toEqual([]);
    expect(titlesIn(s, ready)).toEqual(["B", "C", "A"]);

    // Snapshot is returned in position order.
    expect(s.tasks.map((t: any) => t.title)).toEqual(["B", "C", "A"]);

    // Invalid placement references.
    const other = await createTask(user, board.id, backlog, "D");
    const bad = await move(c.id, { columnId: ready, beforeId: other.id });
    expect(bad.status).toBe(400);
    const wrongOrder = await move(c.id, { columnId: ready, afterId: a.id, beforeId: b.id });
    expect(wrongOrder.status).toBe(400);

    // Column from another board is rejected.
    const second = await api("POST", `/workspaces/${board.workspaceId}/boards`, { token: user.token, body: { name: "B2" } });
    const otherCols = (await api("GET", `/boards/${second.body.id}`, { token: user.token })).body.columns;
    expect((await move(c.id, { columnId: otherCols[0].id })).status).toBe(404);
  });

  test("REST move accepts a column name too", async () => {
    const { user, board, col } = await setup();
    const t = await createTask(user, board.id, col("Backlog").id, "x");
    const res = await api("POST", `/tasks/${t.id}/move`, { token: user.token, body: { columnId: "ready for dev" } });
    expect(res.status).toBe(200);
    expect(res.body.columnId).toBe(col("Ready for Dev").id);
  });
});
