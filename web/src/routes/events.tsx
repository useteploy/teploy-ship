import { subscribe } from "../lib/sse-hub.server.js";

export const config = { mode: "app" };

/**
 * Server-sent events stream. A resource route (no default export) that keeps
 * the connection open and pushes a `change` event whenever the shared hub
 * detects new dashboard state. Auth is the same bearer/cookie the layout
 * middleware enforces — EventSource sends the ship_token cookie automatically.
 *
 * No default export → the framework serves the loader's raw Response.
 */
export async function loader({ request }: { request: Request }): Promise<Response> {
  const encoder = new TextEncoder();
  let unsubscribe: () => void = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (line: string): void => {
        try {
          controller.enqueue(encoder.encode(line));
        } catch {
          /* stream already closed */
        }
      };

      send(": connected\n\n");
      unsubscribe = subscribe((version) => send(`event: change\ndata: ${version}\n\n`));
      // Comment heartbeats keep intermediaries from closing an idle stream.
      heartbeat = setInterval(() => send(": ping\n\n"), 25_000);
      heartbeat.unref?.();

      const close = (): void => {
        if (heartbeat !== undefined) clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      request.signal.addEventListener("abort", close);
    },
    cancel() {
      if (heartbeat !== undefined) clearInterval(heartbeat);
      unsubscribe();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
