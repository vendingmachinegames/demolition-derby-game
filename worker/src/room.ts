import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';

export class GameRoom extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    ws.send(`echo: ${message}`);
  }

  webSocketClose(ws: WebSocket, _code: number, _reason: string): void {
    ws.close();
  }

  webSocketError(ws: WebSocket, _error: unknown): void {
    ws.close(1011, 'internal error');
  }
}
