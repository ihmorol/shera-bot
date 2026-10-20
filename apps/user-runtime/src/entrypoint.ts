import { startRuntimeNode } from "./main.ts";

void startRuntimeNode({ signals: true })
  .then((node) => {
    console.log(
      JSON.stringify({
        event: "runtime_listening",
        local_port: node.port,
        management_port: node.managementPort,
      }),
    );
  })
  .catch((error) => {
    console.error(
      JSON.stringify({
        event: "runtime_start_failed",
        error: error instanceof Error ? error.name : "Error",
      }),
    );
    process.exitCode = 1;
  });
