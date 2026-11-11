import { Capacitor, registerPlugin } from '@capacitor/core';

type CallAction = { action: 'answer' | 'decline' | 'open'; callId?: string; orderId?: string; type?: string };
type Status = { notifications: boolean; fullScreen: boolean; batteryIgnored: boolean; microphone: boolean };

interface AletwendeCallsPlugin {
  getToken(): Promise<{ token?: string }>;
  getPendingAction(): Promise<Partial<CallAction>>;
  cancel(o: { tag: string }): Promise<void>;
  askRuntimePermissions(): Promise<void>;
  getStatus(): Promise<Status>;
  openSettings(o: { type: 'fullScreen' | 'notifications' | 'battery' | 'app' }): Promise<void>;
  startCallService(o: { title?: string }): Promise<void>;
  stopCallService(): Promise<void>;
  addListener(ev: 'callAction', cb: (a: CallAction) => void): Promise<{ remove: () => void }>;
  addListener(ev: 'token', cb: (t: { token: string }) => void): Promise<{ remove: () => void }>;
}

export const NativeCalls: AletwendeCallsPlugin | null = Capacitor.isNativePlatform()
  ? registerPlugin<AletwendeCallsPlugin>('AletwendeCalls')
  : null;

export const isNative = () => !!NativeCalls;

const handled = new Set<string>();
let handles: { remove: () => void }[] = [];

export async function initNativeCalls(opts: {
  saveToken: (token: string) => Promise<void> | void;
  onAnswer: (callId: string) => void;
  onOpen?: (orderId?: string, type?: string) => void;
}) {
  if (!NativeCalls) return;
  await disposeNativeCalls();
  try { await NativeCalls.askRuntimePermissions(); } catch {}
  try {
    const { token } = await NativeCalls.getToken();
    if (token) await opts.saveToken(token);
  } catch (e) { console.warn('[calls] token', e); }

  const handle = (a: Partial<CallAction>) => {
    if (!a || !a.action) return;
    const key = `${a.action}:${a.callId ?? a.orderId ?? ''}`;
    if (handled.has(key)) return;
    handled.add(key);
    setTimeout(() => handled.delete(key), 15000);
    if (a.action === 'answer' && a.callId) opts.onAnswer(a.callId);
    else if (a.action === 'open') opts.onOpen?.(a.orderId, a.type);
  };

  handles.push(await NativeCalls.addListener('callAction', handle));
  handles.push(await NativeCalls.addListener('token', (t) => t?.token && opts.saveToken(t.token)));
  try { handle(await NativeCalls.getPendingAction()); } catch {}
}

export async function disposeNativeCalls() {
  handles.forEach((h) => { try { h.remove(); } catch {} });
  handles = [];
}

export const cancelCallNotification = (tag?: string | null) => {
  if (NativeCalls && tag) NativeCalls.cancel({ tag }).catch(() => {});
};
export const callServiceStart = (title = 'Call in progress') => NativeCalls?.startCallService({ title }).catch(() => {});
export const callServiceStop = () => NativeCalls?.stopCallService().catch(() => {});
export const getCallPermissionStatus = () => NativeCalls?.getStatus() ?? Promise.resolve(null);
export const openCallSettings = (type: 'fullScreen' | 'notifications' | 'battery' | 'app') =>
  NativeCalls?.openSettings({ type });

export async function requestNativeMicrophonePermission(): Promise<boolean> {
  if (!NativeCalls) return false;
  try { await NativeCalls.askRuntimePermissions(); } catch (error) {
    console.warn('[calls] Could not request microphone permission:', error);
  }
  const deadline = Date.now() + 20_000;
  while (Date.now() <= deadline) {
    const status = await getCallPermissionStatus().catch(() => null);
    if (status?.microphone) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => window.setTimeout(resolve, 500));
  }
  return false;
}
