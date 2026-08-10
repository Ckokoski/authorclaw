/**
 * AuthorAgent Notifier Abstraction
 * A channel-agnostic way to push status events (gate opened, project
 * complete, ...) to external notification channels. TelegramNotifier is the
 * first implementation, wrapping the existing bridges/telegram.ts bot
 * without changing it. Discord (bridges/discord.ts) stays a stub — the
 * registry is what a future DiscordNotifier would plug into.
 */

import type { TelegramBridge } from '../bridges/telegram.js';

// ═══════════════════════════════════════════════════════════
// Events
// ═══════════════════════════════════════════════════════════

export interface GateOpenedEvent {
  type: 'gate.opened';
  projectId: string;
  projectTitle: string;
  stepLabel: string;
  wordCount?: number;
}

export interface GateBlockedStepsEvent {
  type: 'gate.blocked_steps';
  projectId: string;
  projectTitle: string;
  blockedSteps: string[];
}

export interface ProjectCompletedEvent {
  type: 'project.completed';
  projectId: string;
  projectTitle: string;
  totalSteps?: number;
  totalWords?: number;
}

/** Catch-all for the many free-text heartbeat/autonomous-mode status lines that
 *  don't warrant their own typed event (mode toggled, wake-cycle summary, ...). */
export interface StatusEvent {
  type: 'status';
  message: string;
}

export type NotifierEvent = GateOpenedEvent | GateBlockedStepsEvent | ProjectCompletedEvent | StatusEvent;

// ═══════════════════════════════════════════════════════════
// Notifier interface
// ═══════════════════════════════════════════════════════════

export interface Notifier {
  readonly id: string;
  /** Whether the underlying channel is currently connected and able to send. */
  isConnected(): boolean;
  notify(event: NotifierEvent): Promise<void>;
  /** Send a lightweight message to confirm the channel is wired up. Returns success. */
  test(): Promise<boolean>;
}

function formatMessage(event: NotifierEvent): string {
  switch (event.type) {
    case 'gate.opened':
      return `🔒 "${event.stepLabel}" is ready for your review — "${event.projectTitle}" is paused until you decide.`;
    case 'gate.blocked_steps':
      return `⏸ ${event.blockedSteps.length} step(s) blocked pending review on "${event.projectTitle}": ${event.blockedSteps.join(', ')}`;
    case 'project.completed': {
      const words = event.totalWords ? `\n📊 ~${event.totalWords.toLocaleString()} words` : '';
      return `🎉 Project "${event.projectTitle}" complete!${words}`;
    }
    case 'status':
      return event.message;
  }
}

// ═══════════════════════════════════════════════════════════
// Telegram implementation
// ═══════════════════════════════════════════════════════════

/** The slice of TelegramBridge this notifier actually needs — keeps tests light. */
type BroadcastCapable = Pick<TelegramBridge, 'broadcastToAllowed'>;

export class TelegramNotifier implements Notifier {
  readonly id = 'telegram';

  /** Bridges are created/torn down at runtime (dashboard connect/disconnect), so
   *  the notifier holds a getter rather than a direct reference. */
  constructor(private getBridge: () => BroadcastCapable | undefined) {}

  isConnected(): boolean {
    return !!this.getBridge();
  }

  async notify(event: NotifierEvent): Promise<void> {
    const bridge = this.getBridge();
    if (!bridge) return;
    await bridge.broadcastToAllowed(formatMessage(event));
  }

  async test(): Promise<boolean> {
    const bridge = this.getBridge();
    if (!bridge) return false;
    try {
      await bridge.broadcastToAllowed('✅ AuthorAgent notifications are connected to this Telegram channel.');
      return true;
    } catch {
      return false;
    }
  }
}

// ═══════════════════════════════════════════════════════════
// Registry
// ═══════════════════════════════════════════════════════════

export class NotifierRegistry {
  private notifiers = new Map<string, Notifier>();

  register(notifier: Notifier): void {
    this.notifiers.set(notifier.id, notifier);
  }

  unregister(id: string): void {
    this.notifiers.delete(id);
  }

  list(): Notifier[] {
    return Array.from(this.notifiers.values());
  }

  /**
   * Dispatch an event to every connected notifier. Runs concurrently; a
   * failure in one channel is logged and never blocks the others.
   */
  async dispatch(event: NotifierEvent): Promise<void> {
    const targets = this.list().filter(n => n.isConnected());
    await Promise.all(targets.map(n =>
      n.notify(event).catch(err => {
        console.error(`[notifier:${n.id}] notify failed:`, err);
      })
    ));
  }
}
