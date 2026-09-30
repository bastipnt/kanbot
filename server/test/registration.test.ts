import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { env } from "../src/env.ts";
import { createSignupInvite } from "../src/services/auth.ts";
import { api, uniqueEmail } from "./helpers.ts";

const register = (email: string, inviteToken?: string) =>
  api("POST", "/auth/register", { body: { email, password: "s3cret-pass", name: "New", inviteToken } });

describe("registration disabled", () => {
  beforeEach(() => {
    env.registrationDisabled = true;
  });
  afterEach(() => {
    env.registrationDisabled = false;
  });

  test("requires an invite", async () => {
    const res = await register(uniqueEmail());
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
    expect((await register(uniqueEmail(), "not-a-real-invite")).status).toBe(403);
  });

  test("an invite is single use", async () => {
    const { token } = await createSignupInvite();
    const first = await register(uniqueEmail(), token);
    expect(first.status).toBe(200);
    expect((await api("GET", "/me", { token: first.body.accessToken })).status).toBe(200);
    expect((await register(uniqueEmail(), token)).status).toBe(403);
  });

  test("an email-bound invite only works for that email (case-insensitive)", async () => {
    const email = uniqueEmail("bound");
    const { token } = await createSignupInvite({ email: email.toUpperCase() });
    expect((await register(uniqueEmail(), token)).status).toBe(403);
    expect((await register(email, token)).status).toBe(200);
  });

  test("expired invites are rejected", async () => {
    const { token } = await createSignupInvite({ days: -1 });
    expect((await register(uniqueEmail(), token)).status).toBe(403);
  });

  test("a failed registration keeps the invite usable", async () => {
    const taken = uniqueEmail("taken");
    const { token: first } = await createSignupInvite();
    expect((await register(taken, first)).status).toBe(200);
    const { token } = await createSignupInvite();
    expect((await register(taken, token)).status).toBe(409);
    expect((await register(uniqueEmail(), token)).status).toBe(200);
  });

  test("login still works", async () => {
    const email = uniqueEmail();
    const { token } = await createSignupInvite();
    await register(email, token);
    expect((await api("POST", "/auth/login", { body: { email, password: "s3cret-pass" } })).status).toBe(200);
  });
});

test("open registration ignores inviteToken", async () => {
  expect((await register(uniqueEmail(), "anything")).status).toBe(200);
});
