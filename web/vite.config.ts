import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev` in api/ serves the Worker on 8787; Vite forwards API calls to it.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://localhost:8787" } },
});
