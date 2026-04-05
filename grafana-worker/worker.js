export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin");

    const allowedOrigins = [
      "https://pecan.westernformularacing.org",
      "https://pecan-dev.westernformularacing.org",
      "https://pecan-internal.westernformularacing.org",
    ];

    const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

    const corsHeaders = {
      "Access-Control-Allow-Origin": corsOrigin,
      "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Restrict /create-dashboard to pecan-internal only
    const url = new URL(request.url);
    if (url.pathname.endsWith("/create-dashboard") && origin !== "https://pecan-internal.westernformularacing.org") {
      return new Response("Forbidden", { status: 403, headers: corsHeaders });
    }

    const destinationURL = request.url.replace(
      url.origin,
      "https://grafana-api.westernformularacing.org"
    );

    const newHeaders = new Headers(request.headers);
    newHeaders.delete("Host");
    newHeaders.set("CF-Access-Client-Id", env.CF_ACCESS_CLIENT_ID);
    newHeaders.set("CF-Access-Client-Secret", env.CF_ACCESS_CLIENT_SECRET);

    const hasBody = !["GET", "HEAD"].includes(request.method);
    const requestBody = hasBody ? await request.arrayBuffer() : null;

    const modifiedRequest = new Request(destinationURL, {
      method: request.method,
      headers: newHeaders,
      body: requestBody,
    });

    try {
      const response = await fetch(modifiedRequest);
      const newResponse = new Response(response.body, response);
      for (const [key, value] of Object.entries(corsHeaders)) {
        newResponse.headers.set(key, value);
      }
      return newResponse;
    } catch (e) {
      return new Response(`Proxy Error: ${e.message}`, { status: 500, headers: corsHeaders });
    }
  },
};
