const express = require("express");
const crypto = require("crypto");

const app = express();
app.use(express.json());

// CORS — allow multiple origins (comma-separated CORS_ORIGIN env var)
const CORS_ORIGINS = new Set(
  (process.env.CORS_ORIGIN || "https://pecan.westernformularacing.org")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
app.use((_req, res, next) => {
  const origin = _req.headers.origin;
  if (origin && CORS_ORIGINS.has(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
  }
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (_req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Internal Grafana URL (same Docker network)
const GRAFANA_INTERNAL_URL =
  process.env.GRAFANA_INTERNAL_URL || "http://grafana:3000";
const GRAFANA_EXTERNAL_URL =
  process.env.GRAFANA_EXTERNAL_URL ||
  "https://grafana.westernformularacing.org";
const GRAFANA_API_TOKEN = process.env.GRAFANA_API_TOKEN;
const GRAFANA_FOLDER_UID = process.env.GRAFANA_FOLDER_UID || "";

// Default season table (lowercase Postgres table name)
// e.g. "wfr26"
const DEFAULT_SEASON_TABLE =
  (process.env.DEFAULT_SEASON_TABLE || "wfr26").toLowerCase();

// Only allow CAN signal name characters (alphanumeric, underscore, hyphen, dot)
const SIGNAL_NAME_RE = /^[A-Za-z0-9_.\-]+$/;

function validateSignalName(name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 128) {
    return false;
  }
  return SIGNAL_NAME_RE.test(name);
}

// ---------------------------------------------------------------------------
// Find the TimescaleDB (PostgreSQL) Grafana datasource UID
// ---------------------------------------------------------------------------
async function findPostgresDatasourceUid() {
  const response = await fetch(`${GRAFANA_INTERNAL_URL}/api/datasources`, {
    headers: { Authorization: `Bearer ${GRAFANA_API_TOKEN}` },
  });
  if (!response.ok) {
    throw new Error(`Grafana datasources API error: ${response.status}`);
  }
  const datasources = await response.json();

  // Prefer datasource named "TimescaleDB-WFR"; fall back to first postgres type
  const named = datasources.find(
    (ds) => ds.type === "postgres" && ds.name === "TimescaleDB-WFR"
  );
  if (named) return named.uid;

  const fallback = datasources.find((ds) => ds.type === "postgres");
  if (fallback) return fallback.uid;

  throw new Error("No PostgreSQL datasource found in Grafana");
}

// ---------------------------------------------------------------------------
// Query and panel builders
// ---------------------------------------------------------------------------

/**
 * TimescaleDB SQL for a single signal.
 * Uses time_bucket() for downsampling and Grafana's $__timeFrom()/$__timeTo()
 * macros for time-range injection.
 *
 * @param {string} signalName  - CAN signal / column name
 * @param {string} table       - lowercase Postgres table name, e.g. "wfr26"
 */
function buildQuery(signalName, table) {
  return [
    "SELECT",
    `  time_bucket('100 milliseconds', "time") AS "time",`,
    `  AVG("${signalName}") AS "${signalName}"`,
    "FROM",
    `  ${table}`,
    "WHERE",
    '  $__timeFilter("time")',
    `  AND "${signalName}" IS NOT NULL`,
    "GROUP BY 1",
    "ORDER BY 1 ASC",
  ].join("\n");
}

function buildPanel(signalName, index, dsUid, table) {
  return {
    type: "timeseries",
    title: signalName,
    targets: [
      {
        refId: "A",
        datasource: { type: "postgres", uid: dsUid },
        rawSql: buildQuery(signalName, table),
        format: "time_series",
      },
    ],
    gridPos: {
      h: 8,
      w: 12,
      x: (index % 2) * 12,
      y: Math.floor(index / 2) * 8,
    },
    fieldConfig: {
      defaults: {
        color: { mode: "palette-classic" },
        custom: {
          lineWidth: 2,
          fillOpacity: 10,
          pointSize: 5,
          spanNulls: false,
        },
      },
      overrides: [],
    },
    options: {
      tooltip: { mode: "multi", sort: "desc" },
      legend: { displayMode: "list", placement: "bottom" },
    },
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const router = express.Router();

router.post("/api/grafana/create-dashboard", async (req, res) => {
  const { signals, season_table } = req.body;

  if (!signals || !Array.isArray(signals) || signals.length === 0) {
    return res.status(400).json({ error: "signals array is required" });
  }
  if (signals.length > 50) {
    return res.status(400).json({ error: "Maximum 50 signals per dashboard" });
  }
  if (!GRAFANA_API_TOKEN) {
    return res.status(500).json({ error: "GRAFANA_API_TOKEN not configured on server" });
  }

  // Validate signal names
  const signalNames = [];
  for (const signal of signals) {
    const name = typeof signal === "string" ? signal : signal.signalName;
    if (!validateSignalName(name)) {
      return res.status(400).json({ error: `Invalid signal name: ${name}` });
    }
    signalNames.push(name);
  }

  // Use caller-supplied table or fall back to env default
  const table = (
    (typeof season_table === "string" ? season_table : "") ||
    DEFAULT_SEASON_TABLE
  ).toLowerCase();

  const uid = "pecan_" + crypto.randomBytes(4).toString("hex");
  const now = new Date();
  const title = `PECAN Analysis - ${now.toISOString().replace("T", " ").substring(0, 16)}`;

  // Fetch Postgres datasource UID
  let dsUid;
  try {
    dsUid = await findPostgresDatasourceUid();
  } catch (err) {
    console.error("Failed to find datasource UID:", err.message);
    return res.status(500).json({ error: `Failed to resolve datasource: ${err.message}` });
  }

  const panels = signalNames.map((name, i) => buildPanel(name, i, dsUid, table));

  const payload = {
    dashboard: {
      id: null,
      uid,
      title,
      tags: ["pecan", "daq"],
      timezone: "browser",
      schemaVersion: 39,
      version: 0,
      panels,
      time: { from: "now-24h", to: "now" },
    },
    overwrite: false,
  };

  if (GRAFANA_FOLDER_UID) {
    payload.folderUid = GRAFANA_FOLDER_UID;
  }

  try {
    const response = await fetch(`${GRAFANA_INTERNAL_URL}/api/dashboards/db`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GRAFANA_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const result = await response.json();

    if (!response.ok) {
      console.error("Grafana API error:", result);
      return res
        .status(response.status)
        .json({ error: result.message || "Grafana API error" });
    }

    res.json({
      url: `${GRAFANA_EXTERNAL_URL}${result.url}`,
      uid: result.uid,
      title,
    });
  } catch (err) {
    console.error("Failed to reach Grafana:", err.message);
    res.status(502).json({ error: "Failed to connect to Grafana" });
  }
});

// Health check
router.get("/api/grafana/health", (_req, res) => {
  res.json({
    status: "ok",
    grafana: GRAFANA_EXTERNAL_URL,
    tokenConfigured: !!GRAFANA_API_TOKEN,
    defaultSeasonTable: DEFAULT_SEASON_TABLE,
  });
});

// Mount at root (direct port 3001) and under /grafana-bridge (via tunnel)
app.use("/", router);
app.use("/grafana-bridge", router);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Grafana bridge listening on port ${PORT}`);
  console.log(`  Grafana internal: ${GRAFANA_INTERNAL_URL}`);
  console.log(`  Grafana external: ${GRAFANA_EXTERNAL_URL}`);
  console.log(`  Default season table: ${DEFAULT_SEASON_TABLE}`);
});
