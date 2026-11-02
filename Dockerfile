FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.18.3 --activate
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build && pnpm --filter @finmichi/server deploy --legacy --prod /prod && cp apps/server/healthcheck.mjs /prod/healthcheck.mjs
FROM build AS worker-build
RUN pnpm --filter @finmichi/worker deploy --legacy --prod /worker-prod && cp apps/worker/healthcheck.mjs /worker-prod/healthcheck.mjs
FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:ec2313763dd43931543bd03830466e0c409ce73a487e8d46f10db72d3b816c1c AS worker
WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Taipei
COPY --from=worker-build --chown=65532:65532 /worker-prod /app
USER 65532:65532
CMD ["dist/index.js"]
FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:ec2313763dd43931543bd03830466e0c409ce73a487e8d46f10db72d3b816c1c AS runtime
WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Taipei
COPY --from=build --chown=65532:65532 /prod /app
COPY --from=build --chown=65532:65532 /app/apps/web/dist /web/dist
USER 65532:65532
EXPOSE 8080
CMD ["dist/index.js"]
