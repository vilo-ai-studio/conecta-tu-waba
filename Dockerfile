FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.output ./.output
COPY --from=build /app/database ./database
COPY --from=build /app/scripts ./scripts
EXPOSE 3000
CMD ["sh", "-c", "npm run db:migrate && npm run start"]
