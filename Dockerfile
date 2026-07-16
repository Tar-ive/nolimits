FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev dependencies for build)
RUN npm ci

# Copy source files
COPY tsconfig.json ./
COPY src ./src
COPY public ./public

# Build TypeScript
RUN npm run build

# Remove dev dependencies to reduce image size
RUN npm prune --production

# Expose ports
EXPOSE 9095

# Set environment variables
ENV NODE_ENV=production
ENV PORT=9095

# Start the server
CMD ["node", "dist/server.js"]