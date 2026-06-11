FROM node:20-alpine
WORKDIR /app
COPY server.js responses.js ./
EXPOSE 4000
HEALTHCHECK --interval=5s --timeout=3s --retries=5 \
  CMD wget -qO- http://localhost:4000/health || exit 1
CMD ["node", "server.js"]
