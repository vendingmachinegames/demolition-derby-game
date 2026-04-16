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
    const scaleX = window.innerWidth / ARENA_W;
    const scaleY = window.innerHeight / ARENA_H;
    const scale = Math.min(scaleX, scaleY);
    canvas.style.width = `${ARENA_W * scale}px`;
    canvas.style.height = `${ARENA_H * scale}px`;
  }
  window.addEventListener('resize', resize);
  resize();
  return canvas;
}

function drawArena(ctx: CanvasRenderingContext2D, players: PlayerSnapshot[]) {
  ctx.clearRect(0, 0, ARENA_W, ARENA_H);

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
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.heading);

    // Car body
    const w = 36, h = 20;
    ctx.fillStyle = p.boost ? '#fff' : color;
    ctx.shadowColor = p.boost ? '#fff' : color;
    ctx.shadowBlur = p.boost ? 16 : 6;
    ctx.fillRect(-w / 2, -h / 2, w, h);

    // Direction indicator
    ctx.fillStyle = '#000';
    ctx.fillRect(w / 2 - 8, -4, 8, 8);

    ctx.restore();
  }

  // Player count
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '14px monospace';
  ctx.fillText(`players: ${players.length}`, 20, ARENA_H - 15);
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
  let players: PlayerSnapshot[] = [];

  const ws = new WebSocket(`${WORKER_URL}/ws?type=screen`);

  ws.onopen = () => { statusEl.textContent = ''; };
  ws.onclose = () => {
    statusEl.textContent = 'Disconnected — reconnecting…';
    setTimeout(() => connect(arenaCanvas), 2000);
  };
  ws.onerror = () => { statusEl.textContent = 'Connection error'; };

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'state') players = msg.players as PlayerSnapshot[];
    } catch { /* ignore */ }
  };

  function loop() {
    drawArena(ctx, players);
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
