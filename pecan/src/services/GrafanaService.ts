// In production the bridge runs in daq-server-components alongside Grafana.
// Set VITE_GRAFANA_BRIDGE_URL to the tunnel/public URL of the bridge service.
// Example: https://grafana-bridge.westernformularacing.org/api/grafana
const GRAFANA_BRIDGE_URL =
  import.meta.env.VITE_GRAFANA_BRIDGE_URL ||
  "http://localhost:3001/api/grafana";

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
