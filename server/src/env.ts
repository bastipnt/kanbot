function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

const isProd = process.env.NODE_ENV === "production";

export const env = {
  databaseUrl: required("DATABASE_URL", isProd ? undefined : "postgres://kanbot:kanbot@localhost:5432/kanbot"),
  jwtSecret: required("JWT_SECRET", isProd ? undefined : "dev-insecure-jwt-secret"),
  publicUrl: (process.env.PUBLIC_URL ?? "http://localhost:8787").replace(/\/+$/, ""),
  port: Number(process.env.PORT ?? 8787),
};
