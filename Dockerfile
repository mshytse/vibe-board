FROM node:20-alpine
WORKDIR /app
COPY . .
RUN mkdir -p /data
ENV HOST=0.0.0.0
ENV CONFIG_PATH=/data/config.json
EXPOSE 3000
CMD ["node", "server.js"]
