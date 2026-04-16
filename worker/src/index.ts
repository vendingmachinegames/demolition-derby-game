import { GameRoom } from './room';

export { GameRoom };

export interface Env {
  GAME_ROOM: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      const id = env.GAME_ROOM.idFromName('lobby');
      const room = env.GAME_ROOM.get(id);
      return room.fetch(request);
    }

    return new Response('Demolition Derby Worker — OK', { status: 200 });
  },
} satisfies ExportedHandler<Env>;
