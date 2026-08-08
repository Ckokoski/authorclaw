import { render, type ComponentType } from 'preact';

/**
 * Mounts one panel component into its own container div. Every panel gets
 * its own root and its own call to mountPanel — panels never share a root
 * or reach into each other's trees, so panels can be added/migrated one at
 * a time without the others knowing.
 */
export function mountPanel(containerId: string, Component: ComponentType): void {
  const container = document.getElementById(containerId);
  if (!container) return;
  render(<Component />, container);
}
