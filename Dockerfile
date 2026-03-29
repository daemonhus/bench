# Build context is the bench/ root.
# Run: docker build -t bench .
FROM node:20-alpine AS frontend
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY src/ src/
RUN npm run build

# --- Build backend ---
FROM golang:1.23-alpine AS backend
RUN apk add --no-cache git
WORKDIR /app/backend
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ .
COPY --from=frontend /app/dist ./dist
RUN CGO_ENABLED=0 go build -o /benchd ./cmd/server

# --- Runtime ---
FROM alpine:3.20
RUN apk add --no-cache git
COPY --from=backend /benchd /usr/local/bin/benchd
EXPOSE 8080
ENTRYPOINT ["benchd"]
CMD ["-repo", "/repo", "-db", "/data/bench.db", "-addr", ":8080"]
