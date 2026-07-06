import { defineConfig, adapterNode } from "@neutron-build/core";

export default defineConfig({
  runtime: "preact",
  adapter: adapterNode(),
  server: {
    port: Number(process.env.SHIP_WEB_PORT ?? 7460),
  },
});
