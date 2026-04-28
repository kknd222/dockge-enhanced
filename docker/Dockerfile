############################################
# Healthcheck Binary
############################################
FROM golang:1.22-bookworm AS build_healthcheck
WORKDIR /app
COPY ./extra/healthcheck.go ./extra/healthcheck.go
RUN go build -trimpath -ldflags="-s -w" -o ./extra/healthcheck ./extra/healthcheck.go

############################################
# Runtime Base
############################################
FROM node:22-bookworm-slim AS runtime_base
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
         ca-certificates \
         curl \
         dumb-init \
         gnupg \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo \
         "deb [arch="$(dpkg --print-architecture)" signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
         "$(. /etc/os-release && echo "$VERSION_CODENAME")" stable" | \
         tee /etc/apt/sources.list.d/docker.list > /dev/null \
    && apt-get update \
    && apt-get install --yes --no-install-recommends \
         docker-ce-cli \
         docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

############################################
# Production Dependencies
############################################
FROM runtime_base AS prod_deps
WORKDIR /app
COPY ./package.json ./package.json
COPY ./package-lock.json ./package-lock.json
RUN npm ci --omit=dev \
    && npm cache clean --force

############################################
# Frontend Build
############################################
FROM node:22-bookworm-slim AS frontend_build
WORKDIR /app
COPY ./package.json ./package.json
COPY ./package-lock.json ./package-lock.json
RUN npm ci
COPY ./frontend ./frontend
COPY ./common ./common
COPY ./tsconfig.json ./tsconfig.json
RUN npm run build:frontend \
    && npm cache clean --force

############################################
# Release
############################################
FROM runtime_base AS release
WORKDIR /app
COPY --from=build_healthcheck /app/extra/healthcheck /app/extra/healthcheck
COPY --from=prod_deps /app/node_modules /app/node_modules
COPY --from=frontend_build /app/frontend-dist /app/frontend-dist
COPY ./backend ./backend
COPY ./common ./common
COPY ./extra ./extra
COPY ./package.json ./package.json
COPY ./tsconfig.json ./tsconfig.json
RUN mkdir ./data

ENV DOCKGE_IS_CONTAINER=1
ENV NODE_ENV=production
ENV UV_USE_IO_URING=0

VOLUME /app/data
EXPOSE 5001
HEALTHCHECK --interval=60s --timeout=30s --start-period=60s --retries=5 CMD ["/app/extra/healthcheck"]
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "./node_modules/tsx/dist/cli.mjs", "./backend/index.ts"]
