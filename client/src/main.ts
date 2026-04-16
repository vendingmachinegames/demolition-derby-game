const WORKER_URL = import.meta.env.VITE_WORKER_URL ?? 'ws://localhost:8787';

const statusEl = document.getElementById('status')!;
const logEl = document.getElementById('log')!;

function log(msg: string) {
  const line = document.createElement('div');
  line.textContent = `[${new Date().toISOString()}] ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

const ws = new WebSocket(`${WORKER_URL}/ws`);

ws.onopen = () => {
  statusEl.textContent = 'Connected';
  log('Connected to worker');
  ws.send('hello from client');
};

ws.onmessage = (ev) => {
  log(`Received: ${ev.data}`);
};

ws.onerror = () => {
  statusEl.textContent = 'Error';
  log('WebSocket error');
};

ws.onclose = () => {
  statusEl.textContent = 'Disconnected';
  log('Disconnected');
};
