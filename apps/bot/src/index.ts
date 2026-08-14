import { AsterismBot } from "./bot.js";
import { loadConfig } from "./config.js";

const bot = new AsterismBot(loadConfig());

const close = async (signal: string): Promise<void> => {
  console.info(`Received ${signal}; shutting down`);
  await bot.stop();
  process.exit(0);
};

process.once("SIGINT", () => void close("SIGINT"));
process.once("SIGTERM", () => void close("SIGTERM"));

await bot.start();
