# SchemaForge MCP server image. One image, two roles: set SF_PROCESS_ROLE to core or executor.
# Build from the repository root: docker build -f deploy/Dockerfile .
FROM node:22.14.0-alpine AS build
WORKDIR /app
COPY mcp-server/package.json mcp-server/package-lock.json ./
RUN npm ci
COPY mcp-server/tsconfig.json ./
COPY mcp-server/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22.14.0-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY mcp-server/package.json ./
USER node
EXPOSE 3100 3101
CMD ["node", "dist/index.js"]
