import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// neutron-ts injects its own configured neutronPlugin() in build and dev; a
// second copy here is concatenated, not replaced (CLI 0.5 warns about it).
export default defineConfig({
  plugins: [preact()],
});
