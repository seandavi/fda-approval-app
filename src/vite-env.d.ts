/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OPENFDA_API_KEY?: string;
  readonly VITE_GA_MEASUREMENT_ID?: string;
  readonly VITE_BATCH_LIMIT?: string;
  readonly VITE_GITHUB_REPO?: string;
  readonly VITE_GIT_SHA?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    dataLayer?: unknown[];
  }
}

export {};
