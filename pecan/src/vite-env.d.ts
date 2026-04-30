/// <reference types="vite/client" />

/** Git commit hash (short) injected at build time for version display */
declare const __GIT_COMMIT__: string;

interface ImportMetaEnv {
  readonly VITE_INTERNAL?: string;
  readonly VITE_GITHUB_DBC_READONLY_TOKEN?: string;
  readonly VITE_RELAY_TOKEN?: string;
  readonly VITE_GRAFANA_BRIDGE_URL?: string;
  readonly VITE_WS_URL?: string;
  readonly VITE_WS_PRESETS?: string;
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_STORAGE_BUCKET?: string;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
