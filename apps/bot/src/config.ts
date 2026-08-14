import { resolve } from "node:path";

export interface BotConfig {
  discordToken: string;
  guildId: string;
  appApiUrl: string;
  serviceToken: string;
  databasePath: string;
  refreshIntervalMs: number;
}

function required(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const serviceToken = required("BOT_SERVICE_TOKEN", env);
  if (serviceToken.length < 32) {
    throw new Error("BOT_SERVICE_TOKEN must contain at least 32 characters");
  }
  return {
    discordToken: required("DISCORD_TOKEN", env),
    guildId: required("DISCORD_GUILD_ID", env),
    appApiUrl: required("APP_API_URL", env).replace(/\/$/, ""),
    serviceToken,
    databasePath: resolve(env.BOT_DATABASE_PATH ?? "./data/bot.sqlite"),
    refreshIntervalMs: Number.parseInt(env.IMAGE_REFRESH_INTERVAL_MS ?? "14400000", 10),
  };
}

