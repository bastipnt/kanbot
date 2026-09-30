import { describe, expect, test } from "bun:test";
import { validateJwtSecret } from "../src/env.ts";

describe("JWT secret validation", () => {
  const strong = "x7Kq9vR2mN4pL8sT1wY6zB3cD5fG0hJ-aE_iO";

  test("development accepts anything", () => {
    expect(validateJwtSecret("dev-insecure-jwt-secret", false)).toBe("dev-insecure-jwt-secret");
    expect(validateJwtSecret("short", false)).toBe("short");
  });

  test("production rejects short secrets", () => {
    expect(() => validateJwtSecret("a".repeat(31), true)).toThrow(/at least 32/);
    expect(validateJwtSecret(strong, true)).toBe(strong);
  });

  test("production rejects placeholder secrets", () => {
    expect(() => validateJwtSecret("dev-insecure-jwt-secret-change-me-please-now", true)).toThrow(/placeholder/);
    expect(() => validateJwtSecret("change-me-to-a-long-random-string-xxxxxxx", true)).toThrow(/placeholder/);
    expect(() => validateJwtSecret("THIS-IS-INSECURE-BUT-LONG-ENOUGH-1234567", true)).toThrow(/placeholder/);
  });

  test("server refuses to start in production with a weak secret", () => {
    const run = (secret: string) =>
      Bun.spawnSync(["bun", "-e", 'await import("./src/env.ts")'], {
        cwd: `${import.meta.dir}/..`,
        env: { ...process.env, NODE_ENV: "production", JWT_SECRET: secret, DATABASE_URL: "postgres://x@localhost/x" },
      });
    const weak = run("dev-insecure-jwt-secret-change-me");
    expect(weak.exitCode).not.toBe(0);
    expect(weak.stderr.toString()).toContain("JWT_SECRET");
    expect(run(strong).exitCode).toBe(0);
  });
});
