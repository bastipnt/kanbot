import { describe, expect, test } from "bun:test";
import { extractReferenceIds } from "../src/services/references.ts";
import { api, createBoard, createTask, registerUser, createWorkspace, setup } from "./helpers.ts";

const ID = "01a1f513-b47f-7000-8000-000000000001";

describe("extractReferenceIds", () => {
  test("finds bare and explicit ids once, lower-cased; explicit wins", () => {
    const up = ID.toUpperCase();
    expect(extractReferenceIds([`see ${ID} and #task:${up}, again ${ID}`, "none"])).toEqual([{ id: ID, explicit: true }]);
    expect(extractReferenceIds([`x${ID}`])).toEqual([]);
    expect(extractReferenceIds(["01a1f513-b47f-…"])).toEqual([]);
  });
});

describe("task references", () => {
  test("GET /tasks/:id resolves ids from description and comments, flags broken explicit ones", async () => {
    const s = await setup();
    const other = await createTask(s.user, s.board.id, s.col("Review").id, "Other card");
    const task = await createTask(s.user, s.board.id, s.col("Backlog").id, "T");
    const missing = "01a1f513-b47f-7000-8000-0000000000ff";
    await api("PATCH", `/tasks/${task.id}`, {
      token: s.user.token,
      body: { description: `Blocked by ${other.id}; self ${task.id}; unknown bare ${missing}` },
    });
    await api("POST", `/tasks/${task.id}/comments`, { token: s.user.token, body: { body: `typo #task:${missing}` } });

    const res = await api("GET", `/tasks/${task.id}`, { token: s.user.token });
    expect(res.status).toBe(200);
    expect(res.body.references).toEqual([
      { id: other.id, broken: false, title: "Other card", boardId: s.board.id, boardName: s.board.name, columnId: s.col("Review").id, columnName: "Review" },
      { id: missing, broken: true },
    ]);

    const noDesc = await api("GET", `/tasks/${task.id}?description=false`, { token: s.user.token });
    expect(noDesc.body.references).toEqual([{ id: missing, broken: true }]);
  });

  test("a card of another workspace is reported broken, without its title", async () => {
    const s = await setup();
    const stranger = await registerUser("Stranger");
    const ws2 = await createWorkspace(stranger);
    const b2 = await createBoard(stranger, ws2.id);
    const foreign = await createTask(stranger, b2.board.id, b2.columns[0].id, "Secret");
    const task = await createTask(s.user, s.board.id, s.col("Backlog").id, "T");
    await api("POST", `/tasks/${task.id}/comments`, { token: s.user.token, body: { body: `#task:${foreign.id}` } });
    const res = await api("GET", `/tasks/${task.id}`, { token: s.user.token });
    expect(res.body.references).toEqual([{ id: foreign.id, broken: true }]);
  });
});
