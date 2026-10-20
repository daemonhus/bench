# Build context is the repo root.
# Run: docker build -t bench .

# --- Build frontend ---
FROM node:20-alpine AS frontend
# The platform UI compiles the workbench source in /repo/src through the @bench alias, so those
# files must resolve the workbench's own dependencies (visx, d3-force, ...) from /repo/node_modules.
WORKDIR /repo
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
WORKDIR /repo/platform/ui
COPY platform/ui/package.json platform/ui/package-lock.json* ./
RUN npm ci
COPY platform/ui/tsconfig.json platform/ui/vite.config.ts platform/ui/index.html ./
COPY platform/ui/public/ public/
COPY platform/ui/src/ src/
RUN npm run build

# --- Build backend ---
FROM golang:1.24-alpine AS backend
RUN apk add --no-cache git
WORKDIR /app/backend
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ .
COPY --from=frontend /repo/platform/ui/dist ./internal/server/dist
RUN CGO_ENABLED=0 go build -o /benchd ./cmd/benchd

# --- Runtime ---
FROM alpine:3.20
RUN apk add --no-cache git
COPY --from=backend /benchd /usr/local/bin/benchd
# Project databases (platform.db plus one <slug>.db per project) live in /data.
# Repositories to review are mounted wherever you like and registered by path.
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["benchd"]
CMD ["-data", "/data", "-addr", ":8080"]
