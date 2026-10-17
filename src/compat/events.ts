export interface EventRef {
  readonly name: string;
  readonly callback: (...data: unknown[]) => unknown;
  readonly context: unknown;
}

interface Listener {
  ref: EventRef;
}

const unregisterEventRef = new WeakMap<EventRef, () => void>();

export function detachEventRef(ref: EventRef): void {
  unregisterEventRef.get(ref)?.();
}

export class Events {
  private readonly listeners = new Map<string, Set<Listener>>();

  on(name: string, callback: (...data: unknown[]) => unknown, ctx?: unknown): EventRef {
    const ref: EventRef = { name, callback, context: ctx };
    const listeners = this.listeners.get(name) ?? new Set<Listener>();
    listeners.add({ ref });
    this.listeners.set(name, listeners);
    unregisterEventRef.set(ref, () => this.offref(ref));
    return ref;
  }

  off(name: string, callback: (...data: unknown[]) => unknown): void {
    const listeners = this.listeners.get(name);
    if (!listeners) return;
    for (const { ref } of [...listeners]) {
      if (ref.callback === callback) this.offref(ref);
    }
  }

  offref(ref: EventRef): void {
    const listeners = this.listeners.get(ref.name);
    if (listeners) {
      for (const listener of listeners) {
        if (listener.ref === ref) listeners.delete(listener);
      }
      if (listeners.size === 0) this.listeners.delete(ref.name);
    }
    unregisterEventRef.delete(ref);
  }

  trigger(name: string, ...data: unknown[]): void {
    const listeners = [...(this.listeners.get(name) ?? [])];
    for (const { ref } of listeners) ref.callback.apply(ref.context, data);
  }

  tryTrigger(evt: EventRef, args: unknown[]): void {
    if ([...(this.listeners.get(evt.name) ?? [])].some(({ ref }) => ref === evt)) {
      evt.callback.apply(evt.context, args);
    }
  }
}
