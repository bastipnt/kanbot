import { describe, expect, test } from "bun:test";
import { api, createTask, setup } from "./helpers.ts";

async function labelled(labels: string[]) {
  const s = await setup();
  const task = await createTask(s.user, s.board.id, s.col("Backlog").id, "T");
  if (labels.length) await api("PATCH", `/tasks/${task.id}`, { token: s.user.token, body: { labels } });
  const edit = (op: "add" | "remove", body: unknown) =>
    api("POST", `/tasks/${task.id}/labels/${op}`, { token: s.user.token, body });
  return { ...s, task, edit };
}

describe("single label edits", () => {
  test("add keeps others, skips present labels, no duplicates", async () => {
    const { edit } = await labelled(["a", "b"]);
    const res = await edit("add", { labels: [" b ", "c", "c", "d"] });
    expect(res.status).toBe(200);
    expect(res.body.labels).toEqual(["a", "b", "c", "d"]);
  });

  test("remove keeps others; removing a missing label is a no-op", async () => {
    const { edit } = await labelled(["a", "b", "c"]);
    expect((await edit("remove", { labels: ["b", "zzz"] })).body.labels).toEqual(["a", "c"]);
    expect((await edit("remove", { labels: ["zzz"] })).body.labels).toEqual(["a", "c"]);
  });

  test("concurrent adds and removes do not lose each other's changes", async () => {
    const { edit, task, user } = await labelled(["keep", "drop"]);
    const adds = ["x1", "x2", "x3", "x4", "x5", "x6"].map((l) => edit("add", { labels: [l] }));
    const res = await Promise.all([...adds, edit("remove", { labels: ["drop"] })]);
    expect(res.every((r) => r.status === 200)).toBe(true);
    const got = await api("GET", `/tasks/${task.id}`, { token: user.token });
    expect([...got.body.task.labels].sort()).toEqual(["keep", "x1", "x2", "x3", "x4", "x5", "x6"]);
  });

  test("records actor and emits task.updated events", async () => {
    const { edit, ws, user } = await labelled([]);
    await edit("add", { labels: ["bug"] });
    const ev = await api("GET", `/workspaces/${ws.id}/events?since=0`, { token: user.token });
    const last = ev.body.events.at(-1);
    expect(last).toMatchObject({ type: "task.updated", actor: { type: "user", id: user.id } });
    expect(last.payload.labels).toEqual(["bug"]);
  });

  test("malformed input is 400, unknown task 404, over 50 labels 400 and unchanged", async () => {
    const { edit, task, user } = await labelled(["a"]);
    for (const body of [{}, { labels: [] }, { labels: "x" }, { labels: [""] }, { labels: ["x".repeat(65)] }, { labels: [1] }]) {
      expect((await edit("add", body)).status).toBe(400);
      expect((await edit("remove", body)).status).toBe(400);
    }
    const many = Array.from({ length: 50 }, (_, i) => `l${i}`);
    expect((await edit("add", { labels: many })).status).toBe(400);
    const got = await api("GET", `/tasks/${task.id}`, { token: user.token });
    expect(got.body.task.labels).toEqual(["a"]);
    const missing = await api("POST", `/tasks/00000000-0000-4000-8000-000000000000/labels/add`, {
      token: user.token,
      body: { labels: ["a"] },
    });
    expect(missing.status).toBe(404);
  });
});
