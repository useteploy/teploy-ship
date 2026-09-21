import { defineConfig, adapterNode } from "@neutron-build/core";

export default defineConfig({
  runtime: "preact",
  adapter: adapterNode(),
  server: {
    // Local preview stays private; the container explicitly sets 0.0.0.0 so
    // Docker's published port can reach it. Do not rely on framework defaults.
    host: process.env.SHIP_WEB_HOST ?? "127.0.0.1",
    port: Number(process.env.SHIP_WEB_PORT ?? process.env.PORT ?? 7460),
  },
});
