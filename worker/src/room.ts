import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';

const TICK_MS = 33; // ~30 Hz
const ARENA_W = 800;
const ARENA_H = 600;
const TILT_FACTOR = 0.35;
const DAMPING = 0.88;
const MAX_SPEED = 10;
const BOOST_IMPULSE = 12;
const BOOST_DURATION_TICKS = 8;

interface PlayerState {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  heading: number;
  boostTicks: number;
}

type WsTag = { type: 'controller'; id: string } | { type: 'screen' };

// Shared world state (survives tilt events arriving between ticks)
const players = new Map<string, PlayerState>();
const pendingTilts = new Map<string, { beta: number; gamma: number }>();
const pendingBoosts = new Set<string>();

export class GameRoom extends DurableObject<Env> {
  private tickInterval: ReturnType<typeof setInterval> | null = null;

  private startLoop(): void {
    if (this.tickInterval) return;
    this.tickInterval = setInterval(() => this.tick(), TICK_MS);
  }

  private stopLoop(): void {
    if (!this.tickInterval) return;
    clearInterval(this.tickInterval);
    this.tickInterval = null;
  }

  private tick(): void {
    for (const [id, p] of players) {
      const tilt = pendingTilts.get(id);
      const boosting = pendingBoosts.has(id);

      if (tilt) {
        // gamma = side tilt → x axis; beta = forward/back → y axis
        p.vx += tilt.gamma * TILT_FACTOR;
        p.vy += tilt.beta * TILT_FACTOR;
        p.heading = Math.atan2(p.vy, p.vx);
      }

      if (boosting) {
        const angle = p.heading;
        p.vx += Math.cos(angle) * BOOST_IMPULSE;
        p.vy += Math.sin(angle) * BOOST_IMPULSE;
        p.boostTicks = BOOST_DURATION_TICKS;
        pendingBoosts.delete(id);
      }

      if (p.boostTicks > 0) p.boostTicks--;

      p.vx *= DAMPING;
      p.vy *= DAMPING;

      const speed = Math.hypot(p.vx, p.vy);
      if (speed > MAX_SPEED) {
        p.vx = (p.vx / speed) * MAX_SPEED;
        p.vy = (p.vy / speed) * MAX_SPEED;
      }

      p.x += p.vx;
      p.y += p.vy;

      // Bounce off walls
      if (p.x < 20) { p.x = 20; p.vx = Math.abs(p.vx); }
      if (p.x > ARENA_W - 20) { p.x = ARENA_W - 20; p.vx = -Math.abs(p.vx); }
      if (p.y < 20) { p.y = 20; p.vy = Math.abs(p.vy); }
      if (p.y > ARENA_H - 20) { p.y = ARENA_H - 20; p.vy = -Math.abs(p.vy); }
    }

    this.broadcast();
  }

  private broadcast(): void {
    const payload = JSON.stringify({
      type: 'state',
      players: [...players.values()].map(({ id, x, y, heading, boostTicks }) => ({
        id,
        x,
        y,
        heading,
        boost: boostTicks > 0,
      })),
    });

    for (const ws of this.ctx.getWebSockets('screen')) {
      try { ws.send(payload); } catch { /* client gone */ }
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const url = new URL(request.url);
    const clientType = url.searchParams.get('type');

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    if (clientType === 'controller') {
      const id = crypto.randomUUID().slice(0, 8);
      this.ctx.acceptWebSocket(server, ['controller']);
      server.serializeAttachment({ type: 'controller', id } satisfies WsTag);

      players.set(id, {
        id,
        x: ARENA_W / 2 + (Math.random() - 0.5) * 200,
        y: ARENA_H / 2 + (Math.random() - 0.5) * 200,
        vx: 0,
        vy: 0,
        heading: 0,
        boostTicks: 0,
      });

      // Tell the controller its ID after the response is returned
      queueMicrotask(() => {
        try { server.send(JSON.stringify({ type: 'assigned', id })); } catch { /* race */ }
      });

      this.startLoop();
    } else {
      this.ctx.acceptWebSocket(server, ['screen']);
      server.serializeAttachment({ type: 'screen' } satisfies WsTag);
      // Send current state immediately
      queueMicrotask(() => this.broadcast());
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const tag = ws.deserializeAttachment() as WsTag;
    if (tag.type !== 'controller') return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
    } catch {
      return;
    }

    if (msg.type === 'tilt') {
      pendingTilts.set(tag.id, {
        beta: Number(msg.beta) || 0,
        gamma: Number(msg.gamma) || 0,
      });
    } else if (msg.type === 'boost') {
      pendingBoosts.add(tag.id);
    }
  }

  webSocketClose(ws: WebSocket, _code: number, _reason: string): void {
    const tag = ws.deserializeAttachment() as WsTag;
    if (tag.type === 'controller') {
      players.delete(tag.id);
      pendingTilts.delete(tag.id);
      pendingBoosts.delete(tag.id);
    }

    const activeControllers = this.ctx.getWebSockets('controller').length;
    if (activeControllers === 0) this.stopLoop();
    // Notify screens of disconnect
    this.broadcast();
  }

  webSocketError(ws: WebSocket, _error: unknown): void {
    this.webSocketClose(ws, 1011, 'internal error');
    try { ws.close(1011, 'internal error'); } catch { /* already closed */ }
  }
}
