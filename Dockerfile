FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Create a non-root user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S scraper -u 1001

# Change ownership
RUN chown -R scraper:nodejs /app
USER scraper

# Default command
CMD ["npm", "start"]
