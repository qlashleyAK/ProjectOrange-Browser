export interface Transport {
  send(data: Uint8Array | string): void;
  close(): void;
  onopen: () => void;
  onmessage: (data: ArrayBuffer | string) => void;
  onclose: (reason: string) => void;
  readonly bytesIn: number;
  readonly bytesOut: number;
}

export class WsTransport implements Transport {
  private ws: WebSocket;
  onopen = () => {};
  onmessage: (data: ArrayBuffer | string) => void = () => {};
  onclose: (reason: string) => void = () => {};
  bytesIn = 0;
  bytesOut = 0;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => this.onopen();
    this.ws.onmessage = (e) => {
      const d = e.data as ArrayBuffer | string;
      this.bytesIn += typeof d === 'string' ? d.length : d.byteLength;
      this.onmessage(d);
    };
    this.ws.onclose = (e) => this.onclose(e.reason || `closed (${e.code})`);
    this.ws.onerror = () => { /* close follows */ };
  }

  send(data: Uint8Array | string): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.bytesOut += typeof data === 'string' ? data.length : data.byteLength;
    this.ws.send(data);
  }
  close(): void { this.ws.onclose = null; this.ws.close(); }
}

/** Offline practice: the authoritative room runs in a Web Worker and speaks the same protocol. */
export class WorkerTransport implements Transport {
  private worker: Worker;
  onopen = () => {};
  onmessage: (data: ArrayBuffer | string) => void = () => {};
  onclose: (reason: string) => void = () => {};
  bytesIn = 0;
  bytesOut = 0;

  constructor(botSkill: string, arena?: string) {
    this.worker = new Worker(new URL('../worker/offlineWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent) => {
      const d = e.data as { t: 'ready' } | { t: 'msg'; d: ArrayBuffer | string } | { t: 'error'; e: string };
      if (d.t === 'ready') this.onopen();
      else if (d.t === 'msg') this.onmessage(d.d);
      else if (d.t === 'error') this.onclose(d.e);
    };
    this.worker.onerror = (e) => this.onclose(e.message || 'worker error');
    this.worker.postMessage({ t: 'init', botSkill, arena });
  }

  send(data: Uint8Array | string): void {
    if (typeof data === 'string') this.worker.postMessage({ t: 'msg', d: data });
    else {
      const copy = data.slice();
      this.worker.postMessage({ t: 'msg', d: copy.buffer }, [copy.buffer]);
    }
  }
  close(): void { this.worker.terminate(); }
}
