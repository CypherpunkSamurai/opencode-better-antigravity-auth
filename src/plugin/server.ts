import { createServer } from "node:http";

import { ANTIGRAVITY_REDIRECT_URI } from "../constants";

interface OAuthListenerOptions {
  /**
   * How long to wait for the OAuth redirect before timing out (in milliseconds).
   */
  timeoutMs?: number;
}

export interface OAuthListener {
  /**
   * Resolves with the callback URL once Google redirects back to the local server.
   */
  waitForCallback(): Promise<URL>;
  /**
   * Cleanly stop listening for callbacks.
   */
  close(): Promise<void>;
}

const redirectUri = new URL(ANTIGRAVITY_REDIRECT_URI);
const callbackPath = redirectUri.pathname || "/";

/**
 * Starts a lightweight HTTP server that listens for the Antigravity OAuth redirect
 * and resolves with the captured callback URL.
 */
export async function startOAuthListener({
  timeoutMs = 5 * 60 * 1000,
}: OAuthListenerOptions = {}): Promise<OAuthListener> {
  const port = redirectUri.port
    ? Number.parseInt(redirectUri.port, 10)
    : redirectUri.protocol === "https:"
      ? 443
      : 80;
  const origin = `${redirectUri.protocol}//${redirectUri.host}`;

  let settled = false;
  let resolveCallback: (url: URL) => void;
  let rejectCallback: (error: Error) => void;
  let timeoutHandle: NodeJS.Timeout;
  const callbackPromise = new Promise<URL>((resolve, reject) => {
    resolveCallback = (url: URL) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve(url);
    };
    rejectCallback = (error: Error) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      reject(error);
    };
  });

  timeoutHandle = setTimeout(() => {
    rejectCallback(new Error("Timed out waiting for OAuth callback"));
  }, timeoutMs);
  timeoutHandle.unref?.();

  const server = createServer((request, response) => {
    if (!request.url) {
      response.writeHead(400, { "Content-Type": "text/plain" });
      response.end("Invalid request");
      return;
    }

    const url = new URL(request.url, origin);
    if (url.pathname !== callbackPath) {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("Not found");
      return;
    }

    // Return 302 like Antigravity
    response.writeHead(302, {
      Location: "https://antigravity.google/auth-success",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Origin": "*",
    });
    response.end();

    resolveCallback(url);

    setImmediate(() => {
      server.close();
    });
  });

  await new Promise<void>((resolve, reject) => {
    const handleError = (error: NodeJS.ErrnoException) => {
      server.off("error", handleError);
      if (error.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${port} is already in use. ` +
              `Another process is occupying this port. ` +
              `Please terminate the process or try again later.`,
          ),
        );
        return;
      }
      reject(error);
    };
    server.once("error", handleError);
    server.listen(port, () => {
      server.off("error", handleError);
      resolve();
    });
  });

  server.on("error", (error) => {
    rejectCallback(error instanceof Error ? error : new Error(String(error)));
  });

  return {
    waitForCallback: () => callbackPromise,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (
            error &&
            (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
          ) {
            reject(error);
            return;
          }
          if (!settled) {
            rejectCallback(new Error("OAuth listener closed before callback"));
          }
          resolve();
        });
      }),
  };
}
