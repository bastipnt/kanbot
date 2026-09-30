FROM oven/bun:1 AS base
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json drizzle.config.ts ./
COPY drizzle ./drizzle
COPY src ./src

ENV NODE_ENV=production
EXPOSE 8787
USER bun
CMD ["sh", "-c", "bun run db:migrate && bun run start"]
