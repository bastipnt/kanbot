import { describe, expect, test } from "bun:test";
import { api, createTask, setup } from "./helpers.ts";

async function modifiable() {
  const s = await setup();
  const task = await createTask(s.user, s.board.id, s.col("Backlog").id, "T");
  const change = (body: unknown) => api("POST", `/tasks/${task.id}/metadata`, { token: s.user.token, body });
  const read = async () => (await api("GET", `/tasks/${task.id}`, { token: s.user.token })).body.task.metadata;
  return { ...s, task, change, read };
}

describe("task metadata", () => {
  test("a new task has an empty map; set and unset change single keys", async () => {
    const { change, read } = await modifiable();
    expect(await read()).toEqual({});
    const set = await change({ set: { step: "review", branch: "agent/x", "base.commit": "1a1fe55" } });
    expect(set.status).toBe(200);
    expect(set.body.metadata).toEqual({ step: "review", branch: "agent/x", "base.commit": "1a1fe55" });

    const both = await change({ unset: ["branch"], set: { step: "done" } });
    expect(both.body.metadata).toEqual({ step: "done", "base.commit": "1a1fe55" });

    // A key in both lists is unset first, then set, so set wins.
    expect((await change({ unset: ["step"], set: { step: "green" } })).body.metadata.step).toBe("green");
    // Unsetting an absent key is a no-op.
    expect((await change({ unset: ["nope"] })).body.metadata.step).toBe("green");
    expect(await read()).toEqual({ step: "green", "base.commit": "1a1fe55" });
  });

  test("concurrent changes to different keys all land", async () => {
    const { change, read } = await modifiable();
    const sets = Array.from({ length: 8 }, (_, i) => change({ set: { [`agent-${i}`]: `v${i}` } }));
    const res = await Promise.all([...sets, change({ set: { step: "queued" }, unset: ["base"] })]);
    expect(res.every((r) => r.status === 200)).toBe(true);
    const got = await read();
    expect(Object.keys(got).sort()).toEqual([...Array.from({ length: 8 }, (_, i) => `agent-${i}`), "step"].sort());
    expect(got.step).toBe("queued");
  });

  test("limits: 50 entries, key and value bounds, and a body with neither list", async () => {
    const { change, read, user } = await modifiable();
    const full = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, "v"]));
    expect((await change({ set: full })).status).toBe(200);
    expect(Object.keys(await read()).length).toBe(50);
    expect((await change({ set: { one_more: "v" } })).status).toBe(400);
    expect(Object.keys(await read()).length).toBe(50);

    for (const body of [
      {},
      { set: {} },
      { unset: [] },
      { set: "x" },
      { unset: "x" },
      { set: { Step: "v" } },
      { set: { "a b": "v" } },
      { set: { "": "v" } },
      { set: { ["x".repeat(65)]: "v" } },
      { set: { step: 1 } },
      { set: { step: "x".repeat(513) } },
      { set: { step: "v" }, unset: ["Step"] },
      { set: { ok: "v" }, unset: [true] },
    ]) {
      expect((await change(body)).status).toBe(400);
    }
    expect(Object.keys(await read()).length).toBe(50);

    const missing = await api("POST", "/tasks/00000000-0000-4000-8000-000000000000/metadata", {
      token: user.token,
      body: { set: { step: "v" } },
    });
    expect(missing.status).toBe(404);
  });

  test("records the actor and emits task.updated", async () => {
    const { change, ws, user } = await modifiable();
    await change({ set: { step: "review" } });
    const ev = await api("GET", `/workspaces/${ws.id}/events?since=0`, { token: user.token });
    const last = ev.body.events.at(-1);
    expect(last).toMatchObject({ type: "task.updated", actor: { type: "user", id: user.id } });
    expect(last.payload.metadata).toEqual({ step: "review" });
  });
});
