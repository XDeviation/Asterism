import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const app = await buildServer(config);

const close = async (signal: string): Promise<void> => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  process.exit(0);
};

process.once("SIGINT", () => void close("SIGINT"));
process.once("SIGTERM", () => void close("SIGTERM"));

await app.listen({ host: config.host, port: config.port });
