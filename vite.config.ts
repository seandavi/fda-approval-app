import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Set VITE_BASE_PATH at build time to deploy under a subpath.
//   "/"                 (default)  — Netlify, Cloudflare Pages, custom domain
//   "/fda-drug-lookup/" (GH Pages project page)
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE_PATH ?? "/",
});
