# AREA platform image (self-hosting the Next.js app).
# Build:  docker build -t area-platform .
# Run:    docker run -p 3000:3000 -v area-data:/app/db -v area-storage:/app/storage area-platform
# NOTE: Docker-based command/RE-tool sandboxing requires a docker socket or
# dockerd-in-docker; without it the platform runs its process-jail sandbox.
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

FROM oven/bun:1 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bunx prisma generate && bun run build

FROM oven/bun:1 AS run
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/benchmarks ./benchmarks
COPY --from=build /app/scripts ./scripts
VOLUME ["/app/db", "/app/storage"]
EXPOSE 3000
CMD ["bun", ".next/standalone/server.js"]
