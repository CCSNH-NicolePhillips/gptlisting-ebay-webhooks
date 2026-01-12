# Use Node.js 20 LTS
FROM node:20-slim

# Install dependencies for sharp (image processing)
RUN apt-get update && apt-get install -y \
    libvips-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy built files and source
COPY dist/ ./dist/
COPY public/ ./public/
COPY netlify/functions/ ./netlify/functions/

# Set environment
ENV NODE_ENV=production
ENV PORT=8080

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Start server
CMD ["node", "dist/src/server/index.js"]
