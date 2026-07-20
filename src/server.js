import cors from "cors";
import express from "express";
import morgan from "morgan";
import net from "node:net";
import { initDb } from "./db.js";
import { config } from "./config.js";
import { createRoutes } from "./routes.js";
import { adminRouter } from "./adminRoutes.js";
import { startDailyEmailReports } from "./emailReports.js";
import { listQueues } from "./queueService.js";
import { broadcast, startWsServer } from "./wsHub.js";

function listenHttpWithFallback(app, preferredPort, maxAttempts = 10) {
  return new Promise((resolve, reject) => {
    let attempt = 0;

    const tryListen = () => {
      const port = preferredPort + attempt;
      const server = app.listen(port, () => resolve({ server, port }));

      server.once("error", (error) => {
        if (error.code === "EADDRINUSE" && attempt < maxAttempts) {
          attempt += 1;
          tryListen();
          return;
        }
        reject(error);
      });
    };

    tryListen();
  });
}

function startWsWithFallback(preferredPort, maxAttempts = 10) {
  return findAvailablePort(preferredPort, maxAttempts).then((port) => {
    startWsServer(port);
    return port;
  });
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();

    tester.once("error", () => {
      resolve(false);
    });

    tester.once("listening", () => {
      tester.close(() => resolve(true));
    });

    tester.listen(port);
  });
}

async function findAvailablePort(preferredPort, maxAttempts = 10) {
  for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
    const candidate = preferredPort + attempt;
    const free = await isPortAvailable(candidate);
    if (free) {
      return candidate;
    }
  }

  throw new Error(`No free port found from ${preferredPort} to ${preferredPort + maxAttempts}`);
}

async function bootstrap() {
  await initDb();

  const app = express();
  app.use(cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept"],
    optionsSuccessStatus: 204
  }));
  app.options("*", cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept"],
    optionsSuccessStatus: 204
  }));
  app.use(express.json());
  app.use(morgan("dev"));

  const onQueueChanged = async () => {
    const queues = await listQueues();
    broadcast("queue_update", queues);
  };

  app.use("/api/admin", adminRouter);
  app.use(createRoutes({ onQueueChanged }));

  const { port: httpPort } = await listenHttpWithFallback(app, config.port, 0);
  console.log(`HTTP server running on http://localhost:${httpPort}`);

  const legacyProxyPort = Number(process.env.LEGACY_PROXY_PORT || 0);
  if (legacyProxyPort && legacyProxyPort !== httpPort) {
    try {
      await listenHttpWithFallback(app, legacyProxyPort, 0);
      console.log(`HTTP compatibility listener running on http://localhost:${legacyProxyPort}`);
    } catch (error) {
      console.warn(`HTTP compatibility listener skipped on ${legacyProxyPort}: ${error?.message || error}`);
    }
  }

  const wsPort = await startWsWithFallback(config.wsPort, 0);
  console.log(`WebSocket server running on ws://localhost:${wsPort}`);
  startDailyEmailReports();
}

bootstrap().catch((error) => {
  console.error("Failed to start backend", error);
  process.exit(1);
});
