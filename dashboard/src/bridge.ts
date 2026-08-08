/**
 * Thin event bridge between the legacy dashboard script (dashboard/dist/index.html)
 * and Preact-mounted panels (this directory).
 *
 * This is intentionally the ONLY coupling point: no shared globals, no shared
 * state objects, no reaching into legacy DOM beyond a panel's own container
 * div. Both sides talk exclusively through namespaced window CustomEvents,
 * so either side can be rewritten independently.
 */

const NAMESPACE = 'authoragent';

export function emit<T>(name: string, detail?: T): void {
  window.dispatchEvent(new CustomEvent(`${NAMESPACE}:${name}`, { detail }));
}

export function on<T>(name: string, handler: (detail: T) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<T>).detail);
  window.addEventListener(`${NAMESPACE}:${name}`, listener);
  return () => window.removeEventListener(`${NAMESPACE}:${name}`, listener);
}
