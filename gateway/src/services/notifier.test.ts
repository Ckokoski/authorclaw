import { describe, it, expect, vi } from 'vitest';
import { NotifierRegistry, TelegramNotifier, type Notifier, type NotifierEvent } from './notifier.js';

function makeFakeBridge(broadcastToAllowed = vi.fn(async (_message: string) => {})) {
  return { broadcastToAllowed };
}

describe('TelegramNotifier', () => {
  it('is disconnected when the bridge getter returns undefined', () => {
    const notifier = new TelegramNotifier(() => undefined);
    expect(notifier.isConnected()).toBe(false);
  });

  it('is connected when the bridge getter returns a bridge', () => {
    const bridge = makeFakeBridge();
    const notifier = new TelegramNotifier(() => bridge as any);
    expect(notifier.isConnected()).toBe(true);
  });

  it('notify() is a no-op when there is no bridge', async () => {
    const notifier = new TelegramNotifier(() => undefined);
    await expect(notifier.notify({ type: 'status', message: 'hi' })).resolves.toBeUndefined();
  });

  it('notify() formats gate.opened and sends via broadcastToAllowed', async () => {
    const bridge = makeFakeBridge();
    const notifier = new TelegramNotifier(() => bridge as any);
    await notifier.notify({
      type: 'gate.opened',
      projectId: 'p1',
      projectTitle: 'My Novel',
      stepLabel: 'Chapter 3',
    });
    expect(bridge.broadcastToAllowed).toHaveBeenCalledTimes(1);
    const [message] = bridge.broadcastToAllowed.mock.calls[0];
    expect(message).toContain('Chapter 3');
    expect(message).toContain('My Novel');
  });

  it('notify() formats gate.blocked_steps with the blocked step list', async () => {
    const bridge = makeFakeBridge();
    const notifier = new TelegramNotifier(() => bridge as any);
    await notifier.notify({
      type: 'gate.blocked_steps',
      projectId: 'p1',
      projectTitle: 'My Novel',
      blockedSteps: ['Chapter 4', 'Chapter 5'],
    });
    const [message] = bridge.broadcastToAllowed.mock.calls[0];
    expect(message).toContain('Chapter 4');
    expect(message).toContain('Chapter 5');
    expect(message).toContain('2');
  });

  it('notify() formats project.completed', async () => {
    const bridge = makeFakeBridge();
    const notifier = new TelegramNotifier(() => bridge as any);
    await notifier.notify({
      type: 'project.completed',
      projectId: 'p1',
      projectTitle: 'My Novel',
      totalWords: 1234,
    });
    const [message] = bridge.broadcastToAllowed.mock.calls[0];
    expect(message).toContain('My Novel');
    expect(message).toContain('1,234');
  });

  it('notify() passes a status event message through verbatim', async () => {
    const bridge = makeFakeBridge();
    const notifier = new TelegramNotifier(() => bridge as any);
    await notifier.notify({ type: 'status', message: '⏸ Paused mid-cycle' });
    expect(bridge.broadcastToAllowed).toHaveBeenCalledWith('⏸ Paused mid-cycle');
  });

  it('test() sends a confirmation message and returns true on success', async () => {
    const bridge = makeFakeBridge();
    const notifier = new TelegramNotifier(() => bridge as any);
    await expect(notifier.test()).resolves.toBe(true);
    expect(bridge.broadcastToAllowed).toHaveBeenCalledTimes(1);
  });

  it('test() returns false when there is no bridge', async () => {
    const notifier = new TelegramNotifier(() => undefined);
    await expect(notifier.test()).resolves.toBe(false);
  });

  it('test() returns false when the bridge throws', async () => {
    const bridge = makeFakeBridge(vi.fn(async () => { throw new Error('network down'); }));
    const notifier = new TelegramNotifier(() => bridge as any);
    await expect(notifier.test()).resolves.toBe(false);
  });
});

describe('NotifierRegistry', () => {
  function makeNotifier(id: string, connected = true): Notifier & { notify: any } {
    return {
      id,
      isConnected: () => connected,
      notify: vi.fn(async () => {}),
      test: vi.fn(async () => true),
    };
  }

  it('dispatches an event only to connected notifiers', async () => {
    const registry = new NotifierRegistry();
    const connected = makeNotifier('connected', true);
    const disconnected = makeNotifier('disconnected', false);
    registry.register(connected);
    registry.register(disconnected);

    const event: NotifierEvent = { type: 'status', message: 'hi' };
    await registry.dispatch(event);

    expect(connected.notify).toHaveBeenCalledWith(event);
    expect(disconnected.notify).not.toHaveBeenCalled();
  });

  it('a failing notifier does not prevent others from being notified', async () => {
    const registry = new NotifierRegistry();
    const failing = makeNotifier('failing');
    failing.notify.mockRejectedValueOnce(new Error('boom'));
    const healthy = makeNotifier('healthy');
    registry.register(failing);
    registry.register(healthy);

    const event: NotifierEvent = { type: 'status', message: 'hi' };
    await expect(registry.dispatch(event)).resolves.toBeUndefined();

    expect(healthy.notify).toHaveBeenCalledWith(event);
  });

  it('unregister removes a notifier from future dispatches', async () => {
    const registry = new NotifierRegistry();
    const notifier = makeNotifier('telegram');
    registry.register(notifier);
    registry.unregister('telegram');

    await registry.dispatch({ type: 'status', message: 'hi' });

    expect(notifier.notify).not.toHaveBeenCalled();
    expect(registry.list()).toEqual([]);
  });

  it('list() returns all registered notifiers', () => {
    const registry = new NotifierRegistry();
    const a = makeNotifier('a');
    const b = makeNotifier('b');
    registry.register(a);
    registry.register(b);
    expect(registry.list().map(n => n.id).sort()).toEqual(['a', 'b']);
  });
});
