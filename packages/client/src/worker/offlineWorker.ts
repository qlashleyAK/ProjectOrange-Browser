/// <reference lib="webworker" />
import { GameRoom, initPhysics, type BotSkill, type ClientLink } from '@orange/shared';

declare const self: DedicatedWorkerGlobalScope;

let room: GameRoom | null = null;
let link: ClientLink | null = null;

self.onmessage = async (e: MessageEvent) => {
  const m = e.data as { t: 'init'; botSkill: BotSkill; arena?: string } | { t: 'msg'; d: ArrayBuffer | string };
  if (m.t === 'init') {
    try {
      await initPhysics();
      room = new GameRoom({ id: 'OFFLINE', offline: true, botSkill: m.botSkill, arena: m.arena });
      link = {
        send: (data) => {
          if (typeof data === 'string') self.postMessage({ t: 'msg', d: data });
          else {
            const copy = data.slice();
            self.postMessage({ t: 'msg', d: copy.buffer }, [copy.buffer]);
          }
        },
        close: () => {},
      };
      room.connect(link);
      room.start();
      self.postMessage({ t: 'ready' });
    } catch (err) {
      self.postMessage({ t: 'error', e: String(err) });
    }
    return;
  }
  if (!room || !link) return;
  room.message(link, typeof m.d === 'string' ? m.d : new Uint8Array(m.d));
};
