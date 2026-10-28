# CodeMeet backend image: the single-file CLI bundle is all that is needed at runtime.
FROM node:22-slim AS build
RUN npm install -g pnpm@10.18.0
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm -r --filter '!./extension' run build

FROM node:22-slim
WORKDIR /app
COPY --from=build /app/cli/dist/codemeet.cjs cli/dist/codemeet.cjs
USER node
ENV HOST=0.0.0.0 PORT=3001
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3001/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "cli/dist/codemeet.cjs", "server", "start", "--migrate"]
