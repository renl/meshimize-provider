import { createServer, type Server } from "node:http";
import type { HealthResponse } from "./types.js";

export function startHealthServer(port: number, getHealth: () => HealthResponse): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        const health = getHealth();
        const statusCode = health.status === "healthy" ? 200 : 503;
        res.writeHead(statusCode, { "Content-Type": "application/json" });
        res.end(JSON.stringify(health));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.on("error", reject);
    server.listen(port, () => resolve(server));
  });
}
