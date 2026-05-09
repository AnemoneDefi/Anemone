import { createServer, IncomingMessage, ServerResponse } from "http";
import { logger } from "./logger";

/**
 * Minimal health endpoint for cloud hosts (Fly, Railway, etc) to detect a
 * stuck container. The keeper has no inbound traffic by design — this server
 * exists only so the platform's healthcheck has something to ping.
 *
 * `GET /health` always returns 200 while the Node process is alive, with a
 * JSON body that includes the unix-second timestamp of the last successful
 * run of each job. Operators can scrape this to spot silent stalls (e.g.
 * `updateRate` missed several ticks in a row → likely RPC issue).
 */

export interface HealthState {
  startedAt: number;
  lastTickByJob: Record<string, number>;
}

const state: HealthState = {
  startedAt: Math.floor(Date.now() / 1000),
  lastTickByJob: {},
};

export function recordJobSuccess(job: string): void {
  state.lastTickByJob[job] = Math.floor(Date.now() / 1000);
}

export function startHealthServer(port: number): void {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          startedAt: state.startedAt,
          uptimeSeconds: Math.floor(Date.now() / 1000) - state.startedAt,
          lastTickByJob: state.lastTickByJob,
        }),
      );
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  server.listen(port, () => {
    logger.info({ port }, "health server listening");
  });
}
