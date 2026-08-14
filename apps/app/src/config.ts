import { resolve } from "node:path";

export interface AppConfig {
  host: string;
  port: number;
  databasePath: string;
  publicUrl: string;
  sitePasswordHash: string;
  sessionSecret: string;
  serviceToken: string;
  cookieSecure: boolean;
  trustProxy: boolean | string | string[] | number;
  webDistDir: string;
}

function parseTrustProxy(value: string | undefined): AppConfig["trustProxy"] {
  const normalized = value?.trim();
  if (!normalized || normalized === "false") return false;
  if (normalized === "true") return true;
  if (/^[1-9]\d*$/.test(normalized)) return Number.parseInt(normalized, 10);
  return normalized;
}

function required(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const sessionSecret = required("SESSION_SECRET", env);
  const serviceToken = required("BOT_SERVICE_TOKEN", env);
  if (sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters");
  }
  if (serviceToken.length < 32) {
    throw new Error("BOT_SERVICE_TOKEN must contain at least 32 characters");
  }

  const publicUrl = required("PUBLIC_URL", env).replace(/\/$/, "");
  const parsedPublicUrl = new URL(publicUrl);
  if (!['http:', 'https:'].includes(parsedPublicUrl.protocol)) {
    throw new Error("PUBLIC_URL must be an http(s) URL");
  }
  const cookieSecure = env.COOKIE_SECURE !== "false";
  if (cookieSecure && parsedPublicUrl.protocol !== "https:") {
    throw new Error("PUBLIC_URL must use https when COOKIE_SECURE is enabled");
  }

  const trustProxy = parseTrustProxy(env.TRUST_PROXY);
  if (cookieSecure && trustProxy === true) {
    throw new Error(
      "TRUST_PROXY=true is unsafe in production; use the number of trusted proxy hops",
    );
  }

  return {
    host: env.HOST ?? "0.0.0.0",
    port: Number.parseInt(env.PORT ?? "3000", 10),
    databasePath: resolve(env.DATABASE_PATH ?? "./data/asterism.sqlite"),
    publicUrl,
    sitePasswordHash: required("SITE_PASSWORD_HASH", env),
    sessionSecret,
    serviceToken,
    cookieSecure,
    trustProxy,
    webDistDir: resolve(env.WEB_DIST_DIR ?? "./apps/web/dist"),
  };
}
