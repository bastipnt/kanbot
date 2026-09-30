function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

/** Placeholder markers from docs/examples; a secret containing one was never actually generated. */
const PLACEHOLDER_MARKERS = ["insecure", "change-me"];
export const MIN_JWT_SECRET_LENGTH = 32;

/** In production, reject short or placeholder JWT secrets. Returns the secret unchanged when acceptable. */
export function validateJwtSecret(secret: string, production: boolean): string {
  if (!production) return secret;
  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters in production (e.g. openssl rand -base64 48)`,
    );
  }
  const lower = secret.toLowerCase();
  if (PLACEHOLDER_MARKERS.some((m) => lower.includes(m))) {
    throw new Error("JWT_SECRET looks like a placeholder; generate one with e.g. openssl rand -base64 48");
  }
  return secret;
}

const isProd = process.env.NODE_ENV === "production";

export const env = {
  databaseUrl: required("DATABASE_URL", isProd ? undefined : "postgres://kanbot:kanbot@localhost:5432/kanbot"),
  jwtSecret: validateJwtSecret(required("JWT_SECRET", isProd ? undefined : "dev-insecure-jwt-secret"), isProd),
  publicUrl: (process.env.PUBLIC_URL ?? "http://localhost:8787").replace(/\/+$/, ""),
  port: Number(process.env.PORT ?? 8787),
};
