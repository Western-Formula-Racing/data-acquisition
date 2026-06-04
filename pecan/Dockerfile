FROM node:20-alpine AS build

WORKDIR /app

# Build arguments for WebSocket configuration (baked in at build time)
ARG VITE_WS_URL
ENV VITE_WS_URL=$VITE_WS_URL
ARG VITE_WS_PRESETS
ENV VITE_WS_PRESETS=$VITE_WS_PRESETS
# Charging dashboard relay (Pecan internal build → slackbot HTTP receiver).
# Inlined at build time; leave unset for public/test builds to disable the dashboard.
ARG VITE_INTERNAL
ENV VITE_INTERNAL=$VITE_INTERNAL
ARG VITE_CHARGE_RELAY_URL
ENV VITE_CHARGE_RELAY_URL=$VITE_CHARGE_RELAY_URL
ARG VITE_CHARGE_RELAY_TOKEN
ENV VITE_CHARGE_RELAY_TOKEN=$VITE_CHARGE_RELAY_TOKEN

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
