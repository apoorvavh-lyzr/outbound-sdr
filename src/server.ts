import { WebSocketServer } from "ws";
import { buildApp } from "./app.js";
import { getEnv } from "./config/env.js";
import { mockConnectAgent } from "./lyzr/mock.js";
import { registerMediaGateway } from "./websocket/twilioMedia.js";
import { createLogger, setLogger } from "./utils/logging.js";

const MEDIA_PATH = "/twilio-media";

async function main(): Promise<void> {
  let env;
  try {
    env = getEnv();
  } catch (err) {
    // Configuration errors must be loud and fatal, not partially-started.
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
    return;
  }

  const logger = createLogger(env.LOG_LEVEL);
  setLogger(logger);

  const built = await buildApp({ env, logger });
  const { app, db, service, repository, lyzr, cleanup } = built;

  // HTTP and WebSocket share one server, on one Railway port.
  const wss = new WebSocketServer({ noServer: true });
  registerMediaGateway(wss, {
    env,
    service,
    repository,
    lyzr,
    logger,
    ...(env.MOCK_EXTERNAL_SERVICES ? { connectAgent: mockConnectAgent } : {}),
  });

  app.server.on("upgrade", (request, socket, head) => {
    const path = (request.url ?? "").split("?")[0];
    if (path !== MEDIA_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  // Sweep abandoned agent clones hourly; no-op in mock mode.
  if (!env.MOCK_EXTERNAL_SERVICES) cleanup.start();

  await app.listen({ host: "0.0.0.0", port: env.PORT });
  logger.info(
    { event: "server_started", port: env.PORT, mock: env.MOCK_EXTERNAL_SERVICES, dialect: db.dialect },
    `listening on 0.0.0.0:${env.PORT}`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ event: "shutdown_started", signal }, "shutting down");

    // Close live conversations before the HTTP server, so bridges tear down.
    cleanup.stop();
    for (const client of wss.clients) client.close(1001, "server shutting down");
    wss.close();

    await app.close().catch(() => undefined);
    await db.close().catch(() => undefined);

    logger.info({ event: "shutdown_complete" }, "shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // A dropped socket or a failed callback must never take the process down.
  process.on("unhandledRejection", (reason) => {
    logger.error({ event: "unhandled_rejection", err: String(reason) }, "unhandled promise rejection");
  });
  process.on("uncaughtException", (err) => {
    logger.error({ event: "uncaught_exception", err: err.message }, "uncaught exception");
  });
}

void main();
