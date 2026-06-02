FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate --schema=src/prisma/schema.prisma
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Fix Prisma OpenSSL compatibility on Alpine
RUN apk add --no-cache openssl

COPY package*.json ./
RUN npm ci --omit=dev

# Copy build output
COPY --from=builder /app/dist ./dist

# Copy Prisma artifacts — needed for prisma migrate deploy at container start
COPY --from=builder /app/node_modules/.prisma   ./node_modules/.prisma
COPY --from=builder /app/node_modules/prisma     ./node_modules/prisma
COPY --from=builder /app/node_modules/@prisma    ./node_modules/@prisma
COPY --from=builder /app/src/prisma/schema.prisma   ./prisma/schema.prisma
COPY --from=builder /app/src/prisma/migrations      ./prisma/migrations

EXPOSE 3000
CMD ["node", "dist/index.js"]
