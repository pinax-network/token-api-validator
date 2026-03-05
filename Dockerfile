FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun build --compile src/index.ts --outfile token-api-validator

FROM gcr.io/distroless/base-debian12
COPY --from=build /app/token-api-validator /app/token-api-validator
COPY --from=build /app/tokens.json /app/tokens.json
WORKDIR /app
USER 1000
ENTRYPOINT ["/app/token-api-validator"]
