import { DurableObject } from 'cloudflare:workers';

export interface Env {
  RELAY_ROOM: DurableObjectNamespace<TelemetryRelayRoom>;
}

type ClientRole = 'ingest' | 'viewer';

interface SessionInfo {
  role: ClientRole;
}

function isWebSocketRequest(request: Request): boolean {
  return request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
}

function cors(response: Response): Response {
  const next = new Response(response.body, response);
  next.headers.set('Access-Control-Allow-Origin', '*');
  next.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  next.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return next;
}

function webSocketUrl(request: Request, path: '/ingest' | '/view', room: string): string {
  const url = new URL(request.url);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.pathname = path;
  url.searchParams.set('room', room);
  return url.toString();
}

function createRoomName(): string {
  return `fr-${crypto.randomUUID().slice(0, 8)}`;
}

function withRoom(request: Request, room: string): Request {
  const url = new URL(request.url);
  url.searchParams.set('room', room);
  return new Request(url, request);
}

export class TelemetryRelayRoom extends DurableObject<Env> {
  private sessions = new Map<WebSocket, SessionInfo>();

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
  }

  async fetch(request: Request): Promise<Response> {
    if (!isWebSocketRequest(request)) {
      return Response.json(this.stats());
    }

    const url = new URL(request.url);
    const role = url.pathname === '/ingest' ? 'ingest' : url.pathname === '/view' ? 'viewer' : null;
    if (!role) return new Response('Use /ingest or /view', { status: 404 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.sessions.set(server, { role });

    server.addEventListener('message', (event) => this.handleMessage(server, event));
    server.addEventListener('close', () => this.sessions.delete(server));
    server.addEventListener('error', () => this.sessions.delete(server));

    server.send(JSON.stringify({
      type: 'relay_status',
      role,
      room: url.searchParams.get('room') || 'default',
      ...this.stats(),
    }));

    return new Response(null, { status: 101, webSocket: client });
  }

  private handleMessage(sender: WebSocket, event: MessageEvent) {
    const info = this.sessions.get(sender);
    if (!info) return;

    if (info.role === 'viewer') {
      this.handleViewerMessage(sender, event.data);
      return;
    }

    this.broadcastToViewers(event.data);
  }

  private handleViewerMessage(viewer: WebSocket, data: unknown) {
    if (typeof data !== 'string') return;
    try {
      const parsed = JSON.parse(data) as { type?: string; timestamp?: unknown };
      if (parsed.type === 'ping') {
        viewer.send(JSON.stringify({
          type: 'pong',
          timestamp: parsed.timestamp,
          serverTime: Date.now(),
        }));
      }
    } catch {
      // Viewer frames are control-only; ignore non-JSON messages.
    }
  }

  private broadcastToViewers(data: string | ArrayBuffer) {
    for (const [socket, info] of this.sessions) {
      if (info.role !== 'viewer') continue;
      try {
        socket.send(data);
      } catch {
        this.sessions.delete(socket);
      }
    }
  }

  private stats() {
    let ingesters = 0;
    let viewers = 0;
    for (const info of this.sessions.values()) {
      if (info.role === 'ingest') ingesters += 1;
      if (info.role === 'viewer') viewers += 1;
    }
    return { ingesters, viewers };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }));
    }

    if (url.pathname === '/health') {
      return cors(Response.json({ ok: true }));
    }

    if (url.pathname === '/session') {
      const room = url.searchParams.get('room') || createRoomName();
      return cors(Response.json({
        room,
        ingestUrl: webSocketUrl(request, '/ingest', room),
        viewerUrl: webSocketUrl(request, '/view', room),
      }));
    }

    if (url.pathname !== '/ingest' && url.pathname !== '/view') {
      return new Response('Use /ingest?room=<name> or /view?room=<name>', { status: 404 });
    }

    if (!isWebSocketRequest(request)) {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const room = url.searchParams.get('room') || 'default';
    const id = env.RELAY_ROOM.idFromName(room);
    return env.RELAY_ROOM.get(id).fetch(withRoom(request, room));
  },
};
