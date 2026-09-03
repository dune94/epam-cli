# The API. Node 22 for node:sqlite — zero runtime dependencies, so there is no npm install here and
# nothing for a client security review to accept beyond Node itself.
FROM node:22-alpine

# Non-root. The only thing this container writes is the spool and its database, both bind mounts.
RUN addgroup -S epam && adduser -S epam -G epam

WORKDIR /app
COPY package.json ./
COPY src ./src

# /data holds runs.db (history must survive a restart); /spool is the boundary to the host runner.
RUN mkdir -p /data /spool && chown -R epam:epam /app /data /spool
USER epam

ENV PORT=8099 HOST=0.0.0.0 RUNS_DB=/data/runs.db SPOOL_DIR=/spool
EXPOSE 8099

# No shell form: signals must reach node so SIGTERM closes the server cleanly.
CMD ["node", "src/server.js"]
