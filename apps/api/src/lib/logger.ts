import { pino, type Logger } from "pino";
import { env } from "../env";

export type { Logger };

// Never log secrets or tokens: these paths are censored wherever they appear.
const REDACT = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "*.access_token",
  "*.accessToken",
  "*.client_secret",
  "*.clientSecret",
  "*.password",
  "*.d", // private JWK member
];

export function createLogger(): Logger {
  const pretty = env.NODE_ENV === "development" && process.stdout.isTTY;
  return pino({
    level: env.NODE_ENV === "test" ? "silent" : env.LOG_LEVEL,
    redact: { paths: REDACT, censor: "[redacted]" },
    ...(pretty
      ? {
          transport: {
            target: "pino-pretty",
            options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" },
          },
        }
      : {}),
  });
}

export const logger: Logger = createLogger();
