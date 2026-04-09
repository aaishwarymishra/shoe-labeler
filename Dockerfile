# Multi-stage build for the step labeling tool

# Builder: install deps and build static assets
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY index.html ./
COPY src ./src

RUN npm run build

# Runtime: serve static assets with nginx
FROM nginx:1.27-alpine
WORKDIR /usr/share/nginx/html

COPY --from=builder /app/dist ./

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
