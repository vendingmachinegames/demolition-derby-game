import QRCode from 'qrcode';

const WORKER_URL = (import.meta.env.VITE_WORKER_URL ?? 'ws://localhost:8787').replace(/^http/, 'ws');
const ARENA_W = 800;
const ARENA_H = 600;

// Locked palette from mood-board-round-1
const VERMILION   = '#FF5A3C';
const SCHOOL_BUS  = '#FFC83D';
const CRAYON_BLUE = '#3DA9FF';
const CREAM       = '#FFF4E0';
const ASPHALT     = '#3A3F47';
const LIME        = '#7BD63A';

const PLAYER_COLORS = [
  VERMILION,
  SCHOOL_BUS,
  CRAYON_BLUE,
  LIME,
  '#FF8C42', // orange
  '#C46FFF', // purple
  '#FF5AB8', // pink
  '#4DFFC4', // teal
];

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

// Chunky low-poly top-down car. Forward = +X in local space.
function drawCar(ctx: CanvasRenderingContext2D, color: string, boosting: boolean) {
  const W = 46, H = 28;

  // Drop shadow
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath();
  ctx.ellipse(3, 3, W / 2 + 3, H / 2 + 3, 0, 0, Math.PI * 2);
  ctx.fill();

  // Wheels — fat dark ellipses at four corners
  const wheelPositions: [number, number][] = [
    [W / 2 - 9, -(H / 2 + 4)],
    [W / 2 - 9,  (H / 2 + 4)],
    [-(W / 2 - 9), -(H / 2 + 4)],
    [-(W / 2 - 9),  (H / 2 + 4)],
  ];
  for (const [wx, wy] of wheelPositions) {
    ctx.fillStyle = ASPHALT;
    ctx.beginPath();
    ctx.ellipse(wx, wy, 8, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#5A6070';
    ctx.beginPath();
    ctx.ellipse(wx, wy, 4, 2.5, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Main body — chunky octagon
  ctx.fillStyle = boosting ? '#FFFFFF' : color;
  ctx.beginPath();
  ctx.moveTo( W / 2 - 4, -H / 2);
  ctx.lineTo( W / 2,     -H / 2 + 6);
  ctx.lineTo( W / 2,      H / 2 - 6);
  ctx.lineTo( W / 2 - 4,  H / 2);
  ctx.lineTo(-W / 2 + 8,  H / 2);
  ctx.lineTo(-W / 2,      H / 2 - 4);
  ctx.lineTo(-W / 2,     -H / 2 + 4);
  ctx.lineTo(-W / 2 + 8, -H / 2);
  ctx.closePath();
  ctx.fill();

  // Roof panel (subtle bright highlight, flat-shading)
  ctx.fillStyle = 'rgba(255,255,255,0.20)';
  ctx.beginPath();
  ctx.moveTo( W / 2 - 8, -H / 2 + 8);
  ctx.lineTo( W / 2 - 8,  H / 2 - 8);
  ctx.lineTo(-W / 2 + 13, H / 2 - 8);
  ctx.lineTo(-W / 2 + 13,-H / 2 + 8);
  ctx.closePath();
  ctx.fill();

  // Front bumper bar (asphalt / white on boost)
  ctx.fillStyle = boosting ? SCHOOL_BUS : ASPHALT;
  ctx.beginPath();
  ctx.moveTo( W / 2,      -H / 2 + 6);
  ctx.lineTo( W / 2 + 5,  -H / 2 + 8);
  ctx.lineTo( W / 2 + 5,   H / 2 - 8);
  ctx.lineTo( W / 2,       H / 2 - 6);
  ctx.closePath();
  ctx.fill();

  // Rear bumper
  ctx.fillStyle = 'rgba(0,0,0,0.30)';
  ctx.beginPath();
  ctx.moveTo(-W / 2,     -H / 2 + 4);
  ctx.lineTo(-W / 2 - 4, -H / 2 + 6);
  ctx.lineTo(-W / 2 - 4,  H / 2 - 6);
  ctx.lineTo(-W / 2,      H / 2 - 4);
  ctx.closePath();
  ctx.fill();

  // Headlight "eyes" — personality detail
  ctx.fillStyle = boosting ? SCHOOL_BUS : CREAM;
  ctx.beginPath();
  ctx.arc(W / 2 + 3, -H / 2 + 9, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(W / 2 + 3,  H / 2 - 9, 3.5, 0, Math.PI * 2);
  ctx.fill();

  // Boost glow ring around headlights
  if (boosting) {
    ctx.fillStyle = 'rgba(255,200,61,0.5)';
    ctx.beginPath();
    ctx.arc(W / 2 + 3, -H / 2 + 9, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(W / 2 + 3,  H / 2 - 9, 7, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawHP(ctx: CanvasRenderingContext2D, p: PlayerSnapshot, color: string) {
  const bw = 44, bh = 6;
  const bx = p.x - bw / 2;
  const by = p.y - 32;

  // Track
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath();
  ctx.rect(bx - 1, by - 1, bw + 2, bh + 2);
  ctx.fill();

  // Fill — palette-based health color
  const hpColor = p.hp > 50 ? LIME : p.hp > 25 ? SCHOOL_BUS : VERMILION;
  ctx.fillStyle = hpColor;
  ctx.fillRect(bx, by, bw * (p.hp / 100), bh);

  // Color accent border
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
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

  // Outer fill — asphalt
  ctx.fillStyle = ASPHALT;
  ctx.fillRect(-8, -8, ARENA_W + 16, ARENA_H + 16);

  // Arena floor — cream pit
  const PAD = 18;
  ctx.fillStyle = CREAM;
  ctx.fillRect(PAD, PAD, ARENA_W - PAD * 2, ARENA_H - PAD * 2);

  // Floor markings — concentric target rings
  const cx = ARENA_W / 2, cy = ARENA_H / 2;
  ctx.strokeStyle = 'rgba(58,63,71,0.12)';
  ctx.lineWidth = 1.5;
  for (const r of [80, 160, 240]) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Cross-hair lines
  ctx.strokeStyle = 'rgba(58,63,71,0.10)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx, PAD); ctx.lineTo(cx, ARENA_H - PAD);
  ctx.moveTo(PAD, cy); ctx.lineTo(ARENA_W - PAD, cy);
  ctx.stroke();

  // Chunky boundary wall — thick crayon-blue stroke
  ctx.strokeStyle = CRAYON_BLUE;
  ctx.lineWidth = 10;
  ctx.strokeRect(PAD, PAD, ARENA_W - PAD * 2, ARENA_H - PAD * 2);
  // Inner shadow stripe on wall
  ctx.strokeStyle = 'rgba(0,0,0,0.20)';
  ctx.lineWidth = 3;
  ctx.strokeRect(PAD + 5, PAD + 5, ARENA_W - PAD * 2 - 10, ARENA_H - PAD * 2 - 10);

  // Players
  for (const p of players) {
    const color = colorFor(p.id);

    if (p.eliminated) {
      // Ghost: faded X mark in player color
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.globalAlpha = 0.30;
      ctx.strokeStyle = color;
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-13, -13); ctx.lineTo(13, 13);
      ctx.moveTo(13, -13);  ctx.lineTo(-13, 13);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.restore();
      continue;
    }

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.heading);
    drawCar(ctx, color, p.boost);
    ctx.restore();

    drawHP(ctx, p, color);
  }

  // HUD — active player count
  ctx.fillStyle = ASPHALT;
  ctx.font = 'bold 13px "Arial Black", Impact, sans-serif';
  ctx.textBaseline = 'bottom';
  const alive = players.filter(p => !p.eliminated).length;
  ctx.fillText(`${alive} car${alive === 1 ? '' : 's'} alive`, PAD + 8, ARENA_H - PAD - 8);
  ctx.textBaseline = 'alphabetic';

  ctx.restore();
}

function drawCountdown(ctx: CanvasRenderingContext2D, secs: number) {
  ctx.fillStyle = 'rgba(58,63,71,0.65)';
  ctx.fillRect(0, 0, ARENA_W, ARENA_H);

  ctx.fillStyle = SCHOOL_BUS;
  ctx.font = 'bold 130px Impact, "Arial Black", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Drop shadow
  ctx.fillStyle = ASPHALT;
  ctx.fillText(secs > 0 ? String(secs) : 'GO!', ARENA_W / 2 + 4, ARENA_H / 2 + 4);
  ctx.fillStyle = secs > 0 ? SCHOOL_BUS : LIME;
  ctx.fillText(secs > 0 ? String(secs) : 'GO!', ARENA_W / 2, ARENA_H / 2);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function drawLobby(ctx: CanvasRenderingContext2D, playerCount: number) {
  const msg = playerCount < 2 ? 'WAITING FOR PLAYERS…' : 'GET READY!';
  ctx.font = 'bold 32px Impact, "Arial Black", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = ASPHALT;
  ctx.fillText(msg, ARENA_W / 2 + 2, ARENA_H / 2 + 2);
  ctx.fillStyle = CRAYON_BLUE;
  ctx.fillText(msg, ARENA_W / 2, ARENA_H / 2);
  ctx.fillStyle = 'rgba(58,63,71,0.6)';
  ctx.font = '16px "Arial Black", Impact, sans-serif';
  ctx.fillText('scan QR to join →', ARENA_W / 2, ARENA_H / 2 + 38);
  ctx.textAlign = 'left';
}

function drawWinner(ctx: CanvasRenderingContext2D, winnerId: string | null, endReason: string | null, restartIn: number) {
  ctx.fillStyle = 'rgba(58,63,71,0.75)';
  ctx.fillRect(0, 0, ARENA_W, ARENA_H);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (winnerId) {
    const color = colorFor(winnerId);
    // Shadow
    ctx.fillStyle = ASPHALT;
    ctx.font = 'bold 56px Impact, "Arial Black", sans-serif';
    ctx.fillText(`🏆 WINNER!`, ARENA_W / 2 + 3, ARENA_H / 2 - 28);
    ctx.fillStyle = color;
    ctx.fillText(`🏆 WINNER!`, ARENA_W / 2, ARENA_H / 2 - 30);

    ctx.fillStyle = CREAM;
    ctx.font = 'bold 26px "Arial Black", Impact, sans-serif';
    ctx.fillText(`Car ${winnerId}`, ARENA_W / 2, ARENA_H / 2 + 14);

    if (endReason === 'timeout') {
      ctx.fillStyle = 'rgba(255,244,224,0.65)';
      ctx.font = '16px "Arial Black", Impact, sans-serif';
      ctx.fillText('(time limit — most HP wins)', ARENA_W / 2, ARENA_H / 2 + 42);
    }
  } else {
    ctx.fillStyle = ASPHALT;
    ctx.font = 'bold 56px Impact, "Arial Black", sans-serif';
    ctx.fillText('DRAW!', ARENA_W / 2 + 3, ARENA_H / 2 - 3);
    ctx.fillStyle = SCHOOL_BUS;
    ctx.fillText('DRAW!', ARENA_W / 2, ARENA_H / 2 - 5);
  }

  ctx.fillStyle = 'rgba(255,244,224,0.70)';
  ctx.font = '18px "Arial Black", Impact, sans-serif';
  ctx.fillText(`Restarting in ${restartIn}s…`, ARENA_W / 2, ARENA_H / 2 + 76);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function drawTimer(ctx: CanvasRenderingContext2D, roundSecs: number) {
  const remaining = Math.max(0, 90 - roundSecs);
  const urgent = remaining <= 10;
  const timerColor = urgent ? VERMILION : CREAM;

  ctx.font = 'bold 24px Impact, "Arial Black", sans-serif';
  ctx.textAlign = 'center';
  // Shadow
  ctx.fillStyle = ASPHALT;
  ctx.fillText(`${remaining}s`, ARENA_W / 2 + 1, 39);
  ctx.fillStyle = timerColor;
  ctx.fillText(`${remaining}s`, ARENA_W / 2, 38);
  ctx.textAlign = 'left';
}

async function renderQR(canvas: HTMLCanvasElement) {
  const controllerUrl = `${window.location.origin}/controller`;
  try {
    await QRCode.toCanvas(canvas, controllerUrl, {
      width: 140,
      margin: 1,
      color: { dark: ASPHALT, light: CREAM },
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
