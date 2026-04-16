import QRCode from 'qrcode';

const WORKER_URL = (import.meta.env.VITE_WORKER_URL ?? 'ws://localhost:8787').replace(/^http/, 'ws');
const ARENA_W = 800;
const ARENA_H = 600;
const PLAYER_COLORS = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#e91e63'];

interface PlayerSnapshot {
  id: string;
  x: number;
  y: number;
  heading: number;
  boost: boolean;
  hp: number;
  eliminated: boolean;
}

interface HitEvent {
  targetId: string;
  damage: number;
}

interface StateMsg {
  type: 'state';
  phase: 'lobby' | 'countdown' | 'active' | 'ended';
  countdownSecs: number;
  roundSecs: number;
  winnerId: string | null;
  endReason: 'last_standing' | 'timeout' | null;
  players: PlayerSnapshot[];
  hits: HitEvent[];
}

const playerColorMap = new Map<string, string>();
let colorIdx = 0;

function colorFor(id: string): string {
  if (!playerColorMap.has(id)) {
    playerColorMap.set(id, PLAYER_COLORS[colorIdx % PLAYER_COLORS.length]);
    colorIdx++;
  }
  return playerColorMap.get(id)!;
}

function setupCanvas(): HTMLCanvasElement {
  const canvas = document.getElementById('arena') as HTMLCanvasElement;
  function resize() {
    const scale = Math.min(window.innerWidth / ARENA_W, window.innerHeight / ARENA_H);
    canvas.style.width = `${ARENA_W * scale}px`;
    canvas.style.height = `${ARENA_H * scale}px`;
  }
  window.addEventListener('resize', resize);
  resize();
  return canvas;
}

function drawHP(ctx: CanvasRenderingContext2D, p: PlayerSnapshot, color: string) {
  const bw = 40, bh = 5;
  const bx = p.x - bw / 2;
  const by = p.y - 28;
  ctx.fillStyle = '#333';
  ctx.fillRect(bx, by, bw, bh);
  ctx.fillStyle = p.hp > 50 ? '#2ecc71' : p.hp > 25 ? '#f39c12' : '#e74c3c';
  ctx.fillRect(bx, by, bw * (p.hp / 100), bh);
  // Thin border
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.strokeRect(bx, by, bw, bh);
}

function drawArena(
  ctx: CanvasRenderingContext2D,
  players: PlayerSnapshot[],
  shakeX: number,
  shakeY: number,
) {
  ctx.save();
  ctx.translate(shakeX, shakeY);

  ctx.clearRect(-8, -8, ARENA_W + 16, ARENA_H + 16);

  // Ground
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, ARENA_W, ARENA_H);

  // Arena border
  ctx.strokeStyle = '#e94560';
  ctx.lineWidth = 4;
  ctx.strokeRect(10, 10, ARENA_W - 20, ARENA_H - 20);

  // Players
  for (const p of players) {
    const color = colorFor(p.id);

    if (p.eliminated) {
      // Ghost: faded X mark
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.globalAlpha = 0.25;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-12, -12); ctx.lineTo(12, 12);
      ctx.moveTo(12, -12); ctx.lineTo(-12, 12);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.restore();
      continue;
    }

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.heading);

    const w = 36, h = 20;
    ctx.fillStyle = p.boost ? '#fff' : color;
    ctx.shadowColor = p.boost ? '#fff' : color;
    ctx.shadowBlur = p.boost ? 16 : 6;
    ctx.fillRect(-w / 2, -h / 2, w, h);

    // Direction indicator
    ctx.fillStyle = '#000';
    ctx.shadowBlur = 0;
    ctx.fillRect(w / 2 - 8, -4, 8, 8);

    ctx.restore();

    // HP bar drawn in world-space (no rotation)
    drawHP(ctx, p, color);
  }

  // Player count HUD
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.font = '13px monospace';
  ctx.fillText(`players: ${players.filter(p => !p.eliminated).length}`, 20, ARENA_H - 15);

  ctx.restore();
}

function drawCountdown(ctx: CanvasRenderingContext2D, secs: number) {
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, ARENA_W, ARENA_H);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 120px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(secs > 0 ? String(secs) : 'GO!', ARENA_W / 2, ARENA_H / 2);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function drawLobby(ctx: CanvasRenderingContext2D, playerCount: number) {
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.font = 'bold 28px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(
    playerCount < 2 ? 'Waiting for players… (need 2+)' : 'Get ready!',
    ARENA_W / 2, ARENA_H / 2,
  );
  ctx.textAlign = 'left';
}

function drawWinner(ctx: CanvasRenderingContext2D, winnerId: string | null, endReason: string | null, restartIn: number) {
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(0, 0, ARENA_W, ARENA_H);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (winnerId) {
    const color = colorFor(winnerId);
    ctx.fillStyle = color;
    ctx.font = 'bold 52px monospace';
    ctx.fillText(`WINNER: ${winnerId}`, ARENA_W / 2, ARENA_H / 2 - 30);
    if (endReason === 'timeout') {
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.font = '22px monospace';
      ctx.fillText('(time limit — most HP wins)', ARENA_W / 2, ARENA_H / 2 + 20);
    }
  } else {
    ctx.fillStyle = '#e94560';
    ctx.font = 'bold 52px monospace';
    ctx.fillText('DRAW!', ARENA_W / 2, ARENA_H / 2 - 20);
  }

  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '18px monospace';
  ctx.fillText(`Restarting in ${restartIn}s…`, ARENA_W / 2, ARENA_H / 2 + 70);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function drawTimer(ctx: CanvasRenderingContext2D, roundSecs: number) {
  const remaining = Math.max(0, 90 - roundSecs);
  const color = remaining <= 10 ? '#e94560' : 'rgba(255,255,255,0.7)';
  ctx.fillStyle = color;
  ctx.font = 'bold 20px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`${remaining}s`, ARENA_W / 2, 35);
  ctx.textAlign = 'left';
}

async function renderQR(canvas: HTMLCanvasElement) {
  const controllerUrl = `${window.location.origin}/controller`;
  try {
    await QRCode.toCanvas(canvas, controllerUrl, {
      width: 140,
      margin: 1,
      color: { dark: '#ffffff', light: '#00000088' },
    });
  } catch (e) {
    console.error('QR render failed', e);
  }
}

function connect(arenaCanvas: HTMLCanvasElement) {
  const ctx = arenaCanvas.getContext('2d')!;
  const statusEl = document.getElementById('status')!;

  let state: StateMsg = {
    type: 'state',
    phase: 'lobby',
    countdownSecs: 0,
    roundSecs: 0,
    winnerId: null,
    endReason: null,
    players: [],
    hits: [],
  };

  let shakeFrames = 0;

  const ws = new WebSocket(`${WORKER_URL}/ws?type=screen`);

  ws.onopen = () => { statusEl.textContent = ''; };
  ws.onclose = () => {
    statusEl.textContent = 'Disconnected — reconnecting…';
    setTimeout(() => connect(arenaCanvas), 2000);
  };
  ws.onerror = () => { statusEl.textContent = 'Connection error'; };

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data) as StateMsg;
      if (msg.type === 'state') {
        if (msg.hits && msg.hits.length > 0) shakeFrames = 6;
        state = msg;
      }
    } catch { /* ignore */ }
  };

  function loop() {
    let sx = 0, sy = 0;
    if (shakeFrames > 0) {
      sx = (Math.random() - 0.5) * 8;
      sy = (Math.random() - 0.5) * 8;
      shakeFrames--;
    }

    drawArena(ctx, state.players, sx, sy);

    if (state.phase === 'active') {
      drawTimer(ctx, state.roundSecs);
    } else if (state.phase === 'countdown') {
      drawCountdown(ctx, state.countdownSecs);
    } else if (state.phase === 'lobby') {
      drawLobby(ctx, state.players.length);
    } else if (state.phase === 'ended') {
      const restartIn = Math.max(0, 5 - Math.floor(state.roundSecs));
      drawWinner(ctx, state.winnerId, state.endReason, restartIn);
    }

    requestAnimationFrame(loop);
  }
  loop();
}

async function main() {
  const arenaCanvas = setupCanvas();
  const qrCanvas = document.getElementById('qr') as HTMLCanvasElement;
  await renderQR(qrCanvas);
  connect(arenaCanvas);
}

main();
