FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY .env.example ./
COPY README.en.md ./
COPY README.md ./
COPY openapi.yaml ./

RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/.env.example ./.env.example
COPY --from=build /app/README.en.md ./README.en.md
COPY --from=build /app/README.md ./README.md
COPY --from=build /app/openapi.yaml ./openapi.yaml

EXPOSE 8080

CMD ["node", "dist/index.js"]
