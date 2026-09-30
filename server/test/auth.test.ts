import { describe, expect, test } from "bun:test";
import { api, registerUser, uniqueEmail } from "./helpers.ts";

describe("auth", () => {
  test("register, login, me, refresh rotation", async () => {
    const email = uniqueEmail("alice");
    const reg = await api("POST", "/auth/register", { body: { email, password: "s3cret-pass", name: "Alice" } });
    expect(reg.status).toBe(200);
    expect(reg.body.user).toMatchObject({ email, name: "Alice" });
    expect(reg.body.user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(reg.body.user.id[14]).toBe("7"); // UUID v7
    expect(typeof reg.body.accessToken).toBe("string");
    expect(typeof reg.body.refreshToken).toBe("string");

    const dup = await api("POST", "/auth/register", {
      body: { email: email.toUpperCase(), password: "s3cret-pass", name: "Alice" },
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("conflict");

    const bad = await api("POST", "/auth/login", { body: { email, password: "wrong-password" } });
    expect(bad.status).toBe(401);
    expect(bad.body).toEqual({ error: { code: "unauthorized", message: expect.any(String) } });

    const login = await api("POST", "/auth/login", { body: { email, password: "s3cret-pass" } });
    expect(login.status).toBe(200);
    expect(login.body.user.id).toBe(reg.body.user.id);

    const me = await api("GET", "/me", { token: login.body.accessToken });
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ id: reg.body.user.id, email, name: "Alice", createdAt: expect.any(String) });

    const r1 = await api("POST", "/auth/refresh", { body: { refreshToken: login.body.refreshToken } });
    expect(r1.status).toBe(200);
    expect(r1.body.refreshToken).not.toBe(login.body.refreshToken);
    expect((await api("GET", "/me", { token: r1.body.accessToken })).status).toBe(200);

    // Refresh tokens are single use.
    const reuse = await api("POST", "/auth/refresh", { body: { refreshToken: login.body.refreshToken } });
    expect(reuse.status).toBe(401);
    const r2 = await api("POST", "/auth/refresh", { body: { refreshToken: r1.body.refreshToken } });
    expect(r2.status).toBe(200);
  });

  test("rejects missing/invalid credentials and bad input", async () => {
    expect((await api("GET", "/me")).status).toBe(401);
    expect((await api("GET", "/me", { token: "garbage" })).status).toBe(401);
    expect((await api("GET", "/workspaces", { token: "kb_nope" })).status).toBe(401);

    const invalid = await api("POST", "/auth/register", { body: { email: "not-an-email", password: "x", name: "" } });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("bad_request");
  });

  test("malformed JSON is a bad_request", async () => {
    const user = await registerUser();
    const { baseUrl } = await import("./helpers.ts");
    const res = await fetch(`${baseUrl()}/workspaces`, {
      method: "POST",
      headers: { Authorization: `Bearer ${user.token}`, "Content-Type": "application/json" },
      body: "{nope",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe("bad_request");
  });
});
