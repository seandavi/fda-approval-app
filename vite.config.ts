import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Resolve the git SHA at build time. Netlify provides COMMIT_REF (wired into
// VITE_GIT_SHA via netlify.toml); for local builds and `npm run dev` we fall
// back to `git rev-parse`. The UI shortens to 7 chars at the call site.
function resolveGitSha(): string {
  const fromEnv = process.env.VITE_GIT_SHA ?? process.env.COMMIT_REF;
  if (fromEnv && fromEnv !== "$COMMIT_REF") return fromEnv;
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "dev";
  }
}

// Set VITE_BASE_PATH at build time to deploy under a subpath.
//   "/"                 (default)  — Netlify, Cloudflare Pages, custom domain
//   "/fda-drug-lookup/" (GH Pages project page)
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE_PATH ?? "/",
  define: {
    "import.meta.env.VITE_GIT_SHA": JSON.stringify(resolveGitSha()),
  },
});
