const WORKER_URL = (import.meta.env.VITE_WORKER_URL ?? 'ws://localhost:8787').replace(/^http/, 'ws');
const TILT_HZ = 30;
const TILT_INTERVAL = Math.floor(1000 / TILT_HZ);

const statusEl = document.getElementById('status')!;
const boostBtn = document.getElementById('boost') as HTMLButtonElement;
const startOverlay = document.getElementById('start-overlay')!;

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

  ws.onopen = () => updateStatus(myId ? `ID: ${myId}` : 'Connected');
  ws.onclose = () => {
    updateStatus('Disconnected — tap to reconnect');
    ws = null;
    setTimeout(connect, 2000);
  };
  ws.onerror = () => updateStatus('Connection error');
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'assigned') {
        myId = msg.id as string;
        updateStatus(`Car: ${myId}`);
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
  // iOS 13+ requires an explicit permission request
  if (typeof (DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> }).requestPermission === 'function') {
    const result = await (DeviceOrientationEvent as unknown as { requestPermission: () => Promise<string> }).requestPermission();
    return result === 'granted';
  }
  return true; // Android / desktop — no permission needed
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
