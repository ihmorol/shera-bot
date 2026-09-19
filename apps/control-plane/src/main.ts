/**
 * Control-plane entrypoint. Reads environment references (G3), applies
 * committed migrations (D24), and serves HTTP. Configuration states:
 * - DATABASE_URL missing → fail fast with a clear message.
 * - OAuth credentials missing → the server still boots; /healthz reports
 *   `auth.configured: false` and sign-in returns a typed configuration
 *   error (G4: never a fake login).
 */
import { createControlPlaneApp } from "./index.ts";
import { readEnv } from "./config.ts";

async function main(): Promise<void> {
  const env = readEnv();
  if (!env.DATABASE_URL) {
    console.error(
      JSON.stringify({
        level: "error",
        service: "control-plane",
        message: "DATABASE_URL is required to start the control plane.",
      }),
    );
    process.exitCode = 1;
    return;
  }

  const controlPlane = await createControlPlaneApp({ env: process.env });
  const port = Number(env.PORT ?? 3000);
  const server = controlPlane.app.listen(port, () => {
    controlPlane.logger.info("control_plane_listening", {
      port,
      auth_configured: controlPlane.authConfigured,
    });
  });

  const shutdown = (signal: string): void => {
    controlPlane.logger.info("control_plane_shutdown", { signal });
    server.close(() => {
      void controlPlane.close().then(() => process.exit(0));
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

void main();
