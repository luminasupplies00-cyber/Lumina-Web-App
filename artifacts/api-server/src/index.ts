import app from "./app";
import { logger } from "./lib/logger";
import { seedAIBrainMemory } from "./lib/aiBrainSeed";
import { startAutoSync } from "./lib/autoSync";
import { startAutopilot } from "./lib/autopilot";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Seed AI brain memory on first boot (idempotent — no-op when populated).
  seedAIBrainMemory().catch((seedErr) => {
    logger.error({ err: seedErr }, "AI brain seed crashed unexpectedly");
  });

  // Start the auto-sync scheduler (reads SYNC_INTERVAL_MINUTES from DB).
  startAutoSync().catch((syncErr) => {
    logger.error({ err: syncErr }, "Auto-sync scheduler failed to start");
  });

  // Start the AI autopilot scheduler (reads AUTOPILOT_ENABLED from DB).
  startAutopilot().catch((apErr) => {
    logger.error({ err: apErr }, "Autopilot scheduler failed to start");
  });
});
