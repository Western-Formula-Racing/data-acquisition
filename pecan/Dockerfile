FROM node:20-alpine AS build

WORKDIR /app

# Build arguments for WebSocket configuration (baked in at build time)
ARG VITE_WS_URL
ENV VITE_WS_URL=$VITE_WS_URL
ARG VITE_WS_PRESETS
ENV VITE_WS_PRESETS=$VITE_WS_PRESETS

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Production stage
FROM nginx:alpine

# Copy built files from build stage
COPY --from=build /app/dist /usr/share/nginx/html

# Copy nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Expose port 80
EXPOSE 80

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
