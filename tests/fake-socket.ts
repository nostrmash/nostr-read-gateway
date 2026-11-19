import type { GatewaySocket } from "../src/types";

export class FakeSocket implements GatewaySocket {
  static queue: Array<(socket: FakeSocket) => void> = [];
  static created: FakeSocket[] = [];
  sent: string[] = [];
  closed = false;
  private listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(readonly url: string) {
    FakeSocket.created.push(this);
    const start = FakeSocket.queue.shift();
    queueMicrotask(() => start?.(this));
  }

  static reset(): void {
    FakeSocket.queue = [];
    FakeSocket.created = [];
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const set = this.listeners.get(type) ?? new Set<(event: Event) => void>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", new Event("close"));
  }

  open(): void {
    this.emit("open", new Event("open"));
  }

  message(data: string): void {
    this.emit("message", new MessageEvent("message", { data }));
  }
}

export function frames(socket: FakeSocket, rows: unknown[]): void {
  socket.open();
  const sent = socket.sent[0];
  if (!sent) throw new Error("request was not sent");
  const parsed = JSON.parse(sent) as [string, string];
  for (const row of rows) {
    if (Array.isArray(row) && (row[0] === "EVENT" || row[0] === "EOSE" || row[0] === "NOTICE")) {
      socket.message(JSON.stringify([row[0], parsed[1], ...row.slice(1)]));
    } else {
      socket.message(JSON.stringify(row));
    }
  }
}
