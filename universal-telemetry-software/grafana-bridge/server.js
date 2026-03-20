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

// Internal URL for API calls (same Docker network, bypasses Cloudflare)
const GRAFANA_INTERNAL_URL =
  process.env.GRAFANA_INTERNAL_URL || "http://grafana:3000";
// External URL for user-facing redirect links
const GRAFANA_EXTERNAL_URL =
  process.env.GRAFANA_EXTERNAL_URL ||
  "https://grafana.westernformularacing.org";
const GRAFANA_API_TOKEN = process.env.GRAFANA_API_TOKEN;
const GRAFANA_FOLDER_UID = process.env.GRAFANA_FOLDER_UID || "";
const DATASOURCE_UID = process.env.GRAFANA_DATASOURCE_UID || "influxdb-wfr-v2";

// Only allow CAN signal name characters (alphanumeric, underscore, hyphen, dot)
const SIGNAL_NAME_RE = /^[A-Za-z0-9_.\-]+$/;

function validateSignalName(name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 128) {
    return false;
  }
  return SIGNAL_NAME_RE.test(name);
}

const INFLUX_TABLE = process.env.INFLUX_TABLE || "WFR26";

function buildQuery(signalName) {
  return [
    "SELECT",
    '  DATE_BIN(INTERVAL \'100 milliseconds\', t."time", TIMESTAMP \'1970-01-01 00:00:00\') AS "time",',
    `  AVG(t."${signalName}") AS "value"`,
    "FROM",
    `  "iox"."${INFLUX_TABLE}" AS t`,
    "WHERE",
    '  t."time" >= $__timeFrom()',
    '  AND t."time" <= $__timeTo()',
    "GROUP BY",
    '  1',
    "ORDER BY",
    '  "time" ASC',
  ].join("\n");
}

function buildPanel(signalName, index) {
  return {
    type: "timeseries",
    title: signalName,
    datasource: {
      type: "influxdb",
      uid: DATASOURCE_UID,
    },
    targets: [
      {
        refId: "A",
        query: buildQuery(signalName),
        rawQuery: true,
        resultFormat: "time_series",
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

app.post("/api/grafana/create-dashboard", async (req, res) => {
  const { signals } = req.body;

  if (!signals || !Array.isArray(signals) || signals.length === 0) {
    return res.status(400).json({ error: "signals array is required" });
  }

  if (signals.length > 50) {
    return res
      .status(400)
      .json({ error: "Maximum 50 signals per dashboard" });
  }

  if (!GRAFANA_API_TOKEN) {
    return res
      .status(500)
      .json({ error: "GRAFANA_API_TOKEN not configured on server" });
  }

  // Validate and extract signal names
  const signalNames = [];
  for (const signal of signals) {
    const name = typeof signal === "string" ? signal : signal.signalName;
    if (!validateSignalName(name)) {
      return res
        .status(400)
        .json({ error: `Invalid signal name: ${name}` });
    }
    signalNames.push(name);
  }

  const uid = "pecan_" + crypto.randomBytes(4).toString("hex");
  const now = new Date();
  const title = `PECAN Analysis - ${now.toISOString().replace("T", " ").substring(0, 16)}`;

  const panels = signalNames.map((name, i) => buildPanel(name, i));

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
      time: { from: "now-1h", to: "now" },
    },
    overwrite: false,
  };

  if (GRAFANA_FOLDER_UID) {
    payload.folderUid = GRAFANA_FOLDER_UID;
  }

  try {
    const response = await fetch(
      `${GRAFANA_INTERNAL_URL}/api/dashboards/db`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GRAFANA_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );

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
app.get("/api/grafana/health", (_req, res) => {
  res.json({
    status: "ok",
    grafana: GRAFANA_EXTERNAL_URL,
    tokenConfigured: !!GRAFANA_API_TOKEN,
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Grafana bridge listening on port ${PORT}`);
  console.log(`  Grafana internal: ${GRAFANA_INTERNAL_URL}`);
  console.log(`  Grafana external: ${GRAFANA_EXTERNAL_URL}`);
});
