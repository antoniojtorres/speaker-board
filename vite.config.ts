import { createConnection, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const BUS_PORT = Number(process.env.PORT ?? 8787);
const BUS_HOST = "127.0.0.1";

/** The slice of http-proxy's server that this config touches. Declared locally
 * because `@types/http-proxy` is not a dependency. */
interface WsProxy {
  on(
    event: "proxyReqWs",
    cb: (proxyReq: unknown, req: unknown, socket: Socket) => void,
  ): void;
}

/** Block Vite listen until the Node bus is accepting TCP, so a browser tab
 * that reconnects on boot does not hit an empty /bus proxy (Vite logs EPIPE). */
function waitForBus(port: number, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = (): void => {
      const socket = createConnection({ port, host: BUS_HOST }, () => {
        socket.end();
        resolve();
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() - started >= timeoutMs) {
          reject(new Error(`bus not listening on ${BUS_HOST}:${port}`));
          return;
        }
        setTimeout(tryOnce, 150);
      });
    };
    tryOnce();
  });
}

// The frontend is a pure display client. In dev, Vite serves the page on :5173
// and proxies the event-bus WebSocket to the Node server, so the client always
// opens `ws://${location.host}/bus` regardless of dev/prod.
export default defineConfig(async ({ command }) => {
  if (command === "serve") {
    try {
      await waitForBus(BUS_PORT);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`vite: ${message}; /bus proxy will fail until the server starts`);
    }
  }
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
    server: {
      host: true, // listen on 0.0.0.0 so LAN peers can reach http://<your-ip>:5173
      port: 5173,
      proxy: {
        "/bus": {
          // http:// (not ws://) — http-proxy upgrades the connection itself.
          // 127.0.0.1 avoids localhost resolving to ::1 while the bus is on IPv4.
          target: `http://${BUS_HOST}:${BUS_PORT}`,
          ws: true,
          changeOrigin: true,
          configure: (proxy: WsProxy) => {
            // The bus broadcasts an audio level every 60ms, so a display client
            // that goes away mid-broadcast (tab closed, laptop asleep, dev
            // reload) makes the proxy write into a dead socket: EPIPE. That is
            // expected, but Vite logs a full stack for it and leaves the
            // half-open pair up, which keeps a phantom client on the server.
            // Take over the socket's error handling and tear the pair down.
            proxy.on("proxyReqWs", (_proxyReq, _req, socket) => {
              // Vite attaches its own logging handler after this hook returns.
              setImmediate(() => {
                socket.removeAllListeners("error");
                socket.on("error", () => socket.destroy());
              });
            });
          },
        },
      },
    },
  };
});
