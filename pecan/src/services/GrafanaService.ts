// Bridge base URL: defaults to the hosted proxy; override for local/staging/self-hosted.
// Set VITE_GRAFANA_BRIDGE_URL to your bridge (e.g. http://localhost:3001/api/grafana for local).
const GRAFANA_BRIDGE_URL =
  import.meta.env.VITE_GRAFANA_BRIDGE_URL ||
  "https://grafana-proxy.westernformularacing.workers.dev/grafana-bridge/api/grafana";

interface CreateDashboardResponse {
  url: string;
  uid: string;
  title: string;
}

export async function createGrafanaDashboard(
  signals: { signalName: string }[]
): Promise<CreateDashboardResponse> {
  const response = await fetch(`${GRAFANA_BRIDGE_URL}/create-dashboard`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      signals: signals.map((s) => s.signalName),
    }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      body.error || `Grafana bridge returned ${response.status}`
    );
  }

  return response.json();
}
