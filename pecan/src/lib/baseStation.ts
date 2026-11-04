/**
 * Detects a page served by a base station Pi.
 *
 * The Pi mounts /base-station.json into its PECAN container. The hosted site and
 * the laptop stacks don't have that file, so the same image behaves normally there.
 */
export interface BaseStationConfig {
  viewerOnly: boolean;
  wsPort: number;
  dbcUrl: string | null;
}

const CONFIG_TIMEOUT_MS = 1500;
const DEFAULT_WS_PORT = 9080;

/** Pages that send to the car, need the internet, or need something on this device. */
const VIEWER_HIDDEN_PATHS = new Set([
  "/",
  "/account",
  "/can-transmitter",
  "/chargecart",
  "/comms",
  "/sensor-validator",
  "/system-link",
  "/throttle-mapper",
]);

let config: BaseStationConfig | null = null;

function parseConfig(raw: unknown): BaseStationConfig | null {
  if (typeof raw !== "object" || raw === null) return null;
  const fields = raw as Record<string, unknown>;
  if (fields.mode !== "base-station") return null;

  const wsPort = fields.wsPort;
  return {
    viewerOnly: fields.viewerOnly !== false,
    wsPort:
      typeof wsPort === "number" && Number.isInteger(wsPort) && wsPort > 0 && wsPort < 65536
        ? wsPort
        : DEFAULT_WS_PORT,
    dbcUrl: typeof fields.dbcUrl === "string" && fields.dbcUrl ? fields.dbcUrl : null,
  };
}

/** Never rejects, and gives up quickly so the page still renders without the file. */
export async function loadBaseStationConfig(): Promise<BaseStationConfig | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG_TIMEOUT_MS);
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}base-station.json`, {
      cache: "no-store",
      signal: controller.signal,
    });
    config = res.ok ? parseConfig(await res.json()) : null;
  } catch {
    config = null;
  } finally {
    clearTimeout(timeout);
  }
  return config;
}

export function getBaseStationConfig(): BaseStationConfig | null {
  return config;
}

export function isViewerOnly(): boolean {
  return config?.viewerOnly === true;
}

export function isHiddenFromViewers(pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return VIEWER_HIDDEN_PATHS.has(path);
}
