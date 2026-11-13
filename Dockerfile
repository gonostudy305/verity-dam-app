FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat gcompat

# Install dependencies only when needed
FROM base AS deps
WORKDIR /app

COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci

# Rebuild the source code only when needed
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The app currently has no static public assets, but the runner copies this
# directory explicitly. Keep the production image build valid until assets are
# added.
RUN mkdir -p public

ENV NEXT_TELEMETRY_DISABLED=1
RUN --mount=type=cache,target=/app/.next/cache npm run build

# Production image, copy all the files and run next
FROM base AS runner
ARG VERITY_RELEASE_SHA=unknown
LABEL org.opencontainers.image.revision="${VERITY_RELEASE_SHA}"
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/scripts/start-local.mjs ./scripts/start-local.mjs
RUN printf '%s\n' "$VERITY_RELEASE_SHA" > /app/RELEASE_SHA

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["npm", "start"]
