# Stage 1: build
FROM node:20-bullseye AS builder

WORKDIR /app
COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY prisma/ ./prisma/
RUN npx prisma generate

COPY src/ ./src/
RUN npm run build


# Stage 2: production image
FROM node:20-bullseye AS runner

RUN apt-get update && apt-get install -y dumb-init && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/package.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma

# Log directory used by pino-roll file transport
RUN mkdir -p ./logs && useradd -m nodejs && chown -R nodejs:nodejs ./logs
USER nodejs

EXPOSE 3005
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
