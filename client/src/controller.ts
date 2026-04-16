const WORKER_URL = (import.meta.env.VITE_WORKER_URL ?? 'ws://localhost:8787').replace(/^http/, 'ws');
const TILT_HZ = 30;
const TILT_INTERVAL = Math.floor(1000 / TILT_HZ);

const statusEl = document.getElementById('status')!;
const boostBtn = document.getElementById('boost') as HTMLButtonElement;
const startOverlay = document.getElementById('start-overlay')!;
const eliminatedOverlay = document.getElementById('eliminated-overlay')!;
const hpFill = document.getElementById('hp-fill') as HTMLElement;
const hpText = document.getElementById('hp-text') as HTMLElement;
const roundInfoEl = document.getElementById('round-info')!;

let ws: WebSocket | null = null;
let myId: string | null = null;
let lastTiltSent = 0;
let motionGranted = false;

function updateStatus(msg: string) {
  statusEl.textContent = msg;
}

function send(obj: unknown) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function setHP(hp: number) {
  const pct = Math.max(0, Math.min(100, hp));
  hpFill.style.width = `${pct}%`;
  hpFill.style.background = hp > 50 ? '#2ecc71' : hp > 25 ? '#f39c12' : '#e74c3c';
  hpText.textContent = `HP ${hp}`;
}

function onOrientation(e: DeviceOrientationEvent) {
  if (!motionGranted) return;
  const now = Date.now();
  if (now - lastTiltSent < TILT_INTERVAL) return;
  lastTiltSent = now;
  send({ type: 'tilt', beta: e.beta ?? 0, gamma: e.gamma ?? 0 });
}

function connect() {
  updateStatus('Connecting…');
  ws = new WebSocket(`${WORKER_URL}/ws?type=controller`);

  ws.onopen = () => updateStatus(myId ? `Car: ${myId}` : 'Connected');
  ws.onclose = () => {
    updateStatus('Disconnected — reconnecting…');
    ws = null;
    setTimeout(connect, 2000);
  };
  ws.onerror = () => updateStatus('Connection error');

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data) as Record<string, unknown>;

      if (msg.type === 'assigned') {
        myId = msg.id as string;
        updateStatus(`Car: ${myId}`);
        if (msg.spectating) {
          roundInfoEl.textContent = 'Round in progress — you join next round';
        }
      }

      if (msg.type === 'state' && myId) {
        const players = msg.players as Array<{ id: string; hp: number; eliminated: boolean }>;
        const me = players.find(p => p.id === myId);
        if (me) {
          setHP(me.hp);
          if (me.eliminated) {
            eliminatedOverlay.style.display = 'flex';
            boostBtn.disabled = true;
          } else {
            eliminatedOverlay.style.display = 'none';
            boostBtn.disabled = false;
          }
        }

        const hits = msg.hits as Array<{ targetId: string; damage: number }>;
        const wasHit = hits.some(h => h.targetId === myId);
        if (wasHit && navigator.vibrate) {
          navigator.vibrate(80);
        }

        const phase = msg.phase as string;
        if (phase === 'lobby') {
          roundInfoEl.textContent = 'Waiting for players…';
        } else if (phase === 'countdown') {
          roundInfoEl.textContent = `Starting in ${msg.countdownSecs as number}s`;
        } else if (phase === 'active') {
          const secs = msg.roundSecs as number;
          roundInfoEl.textContent = `Round: ${90 - secs}s left`;
        } else if (phase === 'ended') {
          const winner = msg.winnerId as string | null;
          roundInfoEl.textContent = winner === myId ? '🏆 YOU WIN!' : winner ? `Winner: ${winner}` : 'Draw!';
        }
      }
    } catch { /* ignore */ }
  };
}

boostBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  send({ type: 'boost' });
  boostBtn.classList.add('active');
});
boostBtn.addEventListener('pointerup', () => boostBtn.classList.remove('active'));
boostBtn.addEventListener('pointercancel', () => boostBtn.classList.remove('active'));

async function requestMotionPermission(): Promise<boolean> {
  if (typeof (DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> }).requestPermission === 'function') {
    const result = await (DeviceOrientationEvent as unknown as { requestPermission: () => Promise<string> }).requestPermission();
    return result === 'granted';
  }
  return true;
}

startOverlay.addEventListener('click', async () => {
  const granted = await requestMotionPermission();
  if (!granted) {
    updateStatus('Motion permission denied — tilt won\'t work');
  } else {
    motionGranted = true;
    window.addEventListener('deviceorientation', onOrientation, { passive: true });
  }
  startOverlay.style.display = 'none';
  connect();
}, { once: true });
