import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';

const TICK_MS = 33; // ~30 Hz
const TICK_HZ = 1000 / TICK_MS;
const ARENA_W = 800;
const ARENA_H = 600;
const CAR_RADIUS = 18;
const TILT_FACTOR = 0.35;
const DAMPING = 0.88;
const MAX_SPEED = 10;
const BOOST_IMPULSE = 12;
const BOOST_DURATION_TICKS = 8;
const MAX_HP = 100;
const COLLISION_DAMAGE_FACTOR = 0.6;
const BOOST_DAMAGE_MULT = 2.2;
const ROUND_DURATION_TICKS = Math.round(90 * TICK_HZ);
const COUNTDOWN_TICKS = Math.round(3 * TICK_HZ);
const AUTO_RESTART_TICKS = Math.round(5 * TICK_HZ);

function genRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

interface PlayerState {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  heading: number;
  boostTicks: number;
  hp: number;
  eliminated: boolean;
}

interface HitEvent {
  targetId: string;
  damage: number;
}

type RoundPhase = 'lobby' | 'countdown' | 'active' | 'ended';
type WsTag = { type: 'controller'; id: string } | { type: 'screen' };

export class GameRoom extends DurableObject<Env> {
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private readonly players = new Map<string, PlayerState>();
  private readonly pendingTilts = new Map<string, { beta: number; gamma: number }>();
  private readonly pendingBoosts = new Set<string>();
  private readonly playerLabels = new Map<string, string>();
  private nextLabelIndex = 1;
  private readonly roomCode = genRoomCode();

  private roundPhase: RoundPhase = 'lobby';
  private roundTickCount = 0;
  private winnerId: string | null = null;
  private endReason: 'last_standing' | 'timeout' | null = null;

  private startLoop(): void {
    if (this.tickInterval) return;
    this.tickInterval = setInterval(() => this.tick(), TICK_MS);
  }

  private stopLoop(): void {
    if (!this.tickInterval) return;
    clearInterval(this.tickInterval);
    this.tickInterval = null;
  }

  private spawnPosition(): { x: number; y: number } {
    return {
      x: 100 + Math.random() * (ARENA_W - 200),
      y: 80 + Math.random() * (ARENA_H - 160),
    };
  }

  private tryStartCountdown(): void {
    if (this.roundPhase !== 'lobby') return;
    if (this.players.size >= 2) {
      this.roundPhase = 'countdown';
      this.roundTickCount = 0;
    }
  }

  private resolveCollisions(hits: HitEvent[]): void {
    const alive = [...this.players.values()].filter(p => !p.eliminated);
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i], b = alive[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        const minDist = CAR_RADIUS * 2;
        if (dist >= minDist || dist < 0.001) continue;

        // Separate overlapping cars
        const overlap = minDist - dist;
        const nx = dx / dist;
        const ny = dy / dist;
        a.x -= nx * overlap * 0.5;
        a.y -= ny * overlap * 0.5;
        b.x += nx * overlap * 0.5;
        b.y += ny * overlap * 0.5;

        // Relative velocity along collision normal
        const relVn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (relVn >= 0) continue; // already separating

        // Equal-mass elastic impulse
        const impulse = -relVn;
        a.vx -= impulse * nx;
        a.vy -= impulse * ny;
        b.vx += impulse * nx;
        b.vy += impulse * ny;

        // Damage proportional to impact speed
        const speed = Math.abs(relVn);
        const aIsBoosting = a.boostTicks > 0;
        const bIsBoosting = b.boostTicks > 0;
        const base = speed * COLLISION_DAMAGE_FACTOR;
        const aDmg = Math.round(base * (bIsBoosting ? BOOST_DAMAGE_MULT : 1));
        const bDmg = Math.round(base * (aIsBoosting ? BOOST_DAMAGE_MULT : 1));

        if (aDmg > 0) {
          a.hp = Math.max(0, a.hp - aDmg);
          hits.push({ targetId: a.id, damage: aDmg });
        }
        if (bDmg > 0) {
          b.hp = Math.max(0, b.hp - bDmg);
          hits.push({ targetId: b.id, damage: bDmg });
        }
      }
    }
  }

  private tick(): void {
    const hits: HitEvent[] = [];

    // Move all non-eliminated players
    for (const [id, p] of this.players) {
      if (p.eliminated) continue;
      const tilt = this.pendingTilts.get(id);
      const boosting = this.pendingBoosts.has(id);

      if (tilt) {
        p.vx += tilt.gamma * TILT_FACTOR;
        p.vy += tilt.beta * TILT_FACTOR;
        p.heading = Math.atan2(p.vy, p.vx);
      }

      if (boosting) {
        p.vx += Math.cos(p.heading) * BOOST_IMPULSE;
        p.vy += Math.sin(p.heading) * BOOST_IMPULSE;
        p.boostTicks = BOOST_DURATION_TICKS;
        this.pendingBoosts.delete(id);
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

      const r = CAR_RADIUS;
      if (p.x < 10 + r) { p.x = 10 + r; p.vx = Math.abs(p.vx); }
      if (p.x > ARENA_W - 10 - r) { p.x = ARENA_W - 10 - r; p.vx = -Math.abs(p.vx); }
      if (p.y < 10 + r) { p.y = 10 + r; p.vy = Math.abs(p.vy); }
      if (p.y > ARENA_H - 10 - r) { p.y = ARENA_H - 10 - r; p.vy = -Math.abs(p.vy); }
    }

    // Round lifecycle
    if (this.roundPhase === 'countdown') {
      this.roundTickCount++;
      if (this.roundTickCount >= COUNTDOWN_TICKS) {
        this.roundPhase = 'active';
        this.roundTickCount = 0;
        for (const p of this.players.values()) {
          p.hp = MAX_HP;
          p.eliminated = false;
        }
      }
    } else if (this.roundPhase === 'active') {
      this.roundTickCount++;
      this.resolveCollisions(hits);

      for (const p of this.players.values()) {
        if (!p.eliminated && p.hp <= 0) {
          p.eliminated = true;
          p.vx = 0;
          p.vy = 0;
        }
      }

      const alive = [...this.players.values()].filter(p => !p.eliminated);
      if (alive.length <= 1 || this.roundTickCount >= ROUND_DURATION_TICKS) {
        this.roundPhase = 'ended';
        this.roundTickCount = 0;
        if (alive.length === 1) {
          this.winnerId = alive[0].id;
          this.endReason = 'last_standing';
        } else if (alive.length === 0) {
          this.winnerId = null;
          this.endReason = 'last_standing';
        } else {
          // Timeout: most HP wins
          const winner = alive.reduce((a, b) => a.hp >= b.hp ? a : b);
          this.winnerId = winner.id;
          this.endReason = 'timeout';
        }
      }
    } else if (this.roundPhase === 'ended') {
      this.roundTickCount++;
      if (this.roundTickCount >= AUTO_RESTART_TICKS) {
        this.restartRound();
      }
    }

    this.broadcast(hits);
  }

  private restartRound(): void {
    for (const p of this.players.values()) {
      const pos = this.spawnPosition();
      p.x = pos.x;
      p.y = pos.y;
      p.vx = 0;
      p.vy = 0;
      p.hp = MAX_HP;
      p.eliminated = false;
      p.boostTicks = 0;
    }
    this.winnerId = null;
    this.endReason = null;
    this.roundTickCount = 0;
    this.roundPhase = this.players.size >= 2 ? 'countdown' : 'lobby';
  }

  private broadcast(hits: HitEvent[] = []): void {
    const countdownSecs = this.roundPhase === 'countdown'
      ? Math.ceil((COUNTDOWN_TICKS - this.roundTickCount) / TICK_HZ)
      : 0;
    const roundSecs = this.roundPhase === 'active'
      ? Math.floor(this.roundTickCount / TICK_HZ)
      : 0;

    const payload = JSON.stringify({
      type: 'state',
      phase: this.roundPhase,
      roomCode: this.roomCode,
      countdownSecs,
      roundSecs,
      winnerId: this.winnerId,
      endReason: this.endReason,
      players: [...this.players.values()].map(({ id, x, y, heading, boostTicks, hp, eliminated }) => ({
        id,
        label: this.playerLabels.get(id) ?? id,
        x, y, heading, boost: boostTicks > 0, hp, eliminated,
      })),
      hits,
    });

    for (const ws of this.ctx.getWebSockets()) {
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

      const label = `P${this.nextLabelIndex++}`;
      this.playerLabels.set(id, label);

      const pos = this.spawnPosition();
      this.players.set(id, {
        id,
        x: pos.x,
        y: pos.y,
        vx: 0,
        vy: 0,
        heading: 0,
        boostTicks: 0,
        hp: MAX_HP,
        // Mid-round joiners spectate
        eliminated: this.roundPhase === 'active',
      });

      queueMicrotask(() => {
        try {
          server.send(JSON.stringify({
            type: 'assigned',
            id,
            label,
            roomCode: this.roomCode,
            spectating: this.roundPhase === 'active',
          }));
        } catch { /* race */ }
      });

      this.startLoop();
      if (this.roundPhase === 'lobby') {
        queueMicrotask(() => this.tryStartCountdown());
      }
    } else {
      this.ctx.acceptWebSocket(server, ['screen']);
      server.serializeAttachment({ type: 'screen' } satisfies WsTag);
      queueMicrotask(() => this.broadcast());
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const tag = ws.deserializeAttachment() as WsTag;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
    } catch {
      return;
    }

    if (tag.type === 'controller') {
      if (msg.type === 'tilt') {
        this.pendingTilts.set(tag.id, {
          beta: Number(msg.beta) || 0,
          gamma: Number(msg.gamma) || 0,
        });
      } else if (msg.type === 'boost') {
        this.pendingBoosts.add(tag.id);
      }
    }

    if (msg.type === 'restart' && this.roundPhase === 'ended') {
      this.restartRound();
      this.broadcast();
    }
  }

  webSocketClose(ws: WebSocket, _code: number, _reason: string): void {
    const tag = ws.deserializeAttachment() as WsTag;
    if (tag.type === 'controller') {
      this.players.delete(tag.id);
      this.pendingTilts.delete(tag.id);
      this.pendingBoosts.delete(tag.id);
      this.playerLabels.delete(tag.id);

      if (this.roundPhase === 'active') {
        const alive = [...this.players.values()].filter(p => !p.eliminated);
        if (alive.length <= 1) {
          this.roundPhase = 'ended';
          this.winnerId = alive.length === 1 ? alive[0].id : null;
          this.endReason = 'last_standing';
          this.roundTickCount = 0;
        }
      }

      if (this.roundPhase === 'countdown' && this.players.size < 2) {
        this.roundPhase = 'lobby';
        this.roundTickCount = 0;
      }
    }

    if (this.ctx.getWebSockets('controller').length === 0) this.stopLoop();
    this.broadcast();
  }

  webSocketError(ws: WebSocket, _error: unknown): void {
    this.webSocketClose(ws, 1011, 'internal error');
    try { ws.close(1011, 'internal error'); } catch { /* already closed */ }
  }
}
