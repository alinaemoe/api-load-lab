# syntax=docker/dockerfile:1
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
CMD ["node", "dist/server.js"]
