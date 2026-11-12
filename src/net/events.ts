/** A tiny typed event emitter, so the UI can subscribe to network sessions. */
export class Emitter<Events extends Record<string, unknown>> {
  private handlers: { [K in keyof Events]?: Array<(payload: Events[K]) => void> } = {};

  on<K extends keyof Events>(name: K, fn: (payload: Events[K]) => void): void {
    (this.handlers[name] ??= []).push(fn);
  }

  emit<K extends keyof Events>(name: K, payload: Events[K]): void {
    for (const fn of this.handlers[name] ?? []) fn(payload);
  }
}

/** One line in the debug network log. */
export interface NetLogEntry {
  dir: "in" | "out";
  peer: string;
  msg: unknown;
}
