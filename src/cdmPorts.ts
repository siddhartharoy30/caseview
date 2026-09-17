import * as net from "net";
import { cdmConfig } from "./cdmHelperConfig";

/**
 * Bind-test port allocation for the CDM tunnel pool (9770-9799 by default).
 * There is a real TOCTOU window between this bind-and-close probe and
 * `portal_client forward`'s own bind a moment later -- deliberately not
 * eliminated with a lockfile or mutex (single operator, one QView helper).
 * The residual case is detected, not silently broken: if `portal_client`
 * still fails to bind, that surfaces as a `port_taken` session error with a
 * one-click retry, not a silent hang.
 */

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

// Rotating cursor so two sessions started seconds apart don't both probe from
// portMin and race on the same first candidate.
let cursor = cdmConfig.portMin;

export async function allocatePort(reserved: Set<number>): Promise<number | null> {
  const { portMin, portMax } = cdmConfig;
  const span = portMax - portMin + 1;
  for (let i = 0; i < span; i++) {
    const port = portMin + ((cursor - portMin + i) % span);
    if (reserved.has(port)) continue;
    if (await isPortFree(port)) {
      cursor = port + 1;
      return port;
    }
  }
  return null;
}
