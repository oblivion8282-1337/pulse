import { Room } from 'livekit-client';

export type ResolvedDevice = {
  /** Best-matching deviceId from the current device list, or '' if none. */
  deviceId: string;
  /** Label of the matched device (for re-persisting), or ''. */
  label: string;
};

/**
 * Pick the device that best matches a previously persisted `(id, label)` pair.
 *
 * deviceIds are not 100% stable across reloads/reconnects, so we fall back to
 * matching by label and finally to a sensible default — never a blind `[0]`.
 */
export function matchDevice(
  devices: MediaDeviceInfo[],
  persistedId: string,
  persistedLabel: string
): ResolvedDevice {
  if (devices.length === 0) return { deviceId: '', label: '' };

  if (persistedId) {
    const byId = devices.find((d) => d.deviceId === persistedId);
    if (byId) return { deviceId: byId.deviceId, label: byId.label };
  }
  if (persistedLabel) {
    const byLabel = devices.find((d) => d.label && d.label === persistedLabel);
    if (byLabel) return { deviceId: byLabel.deviceId, label: byLabel.label };
  }
  const dflt = devices.find((d) => d.deviceId === 'default');
  if (dflt) return { deviceId: dflt.deviceId, label: dflt.label };
  return { deviceId: devices[0].deviceId, label: devices[0].label };
}

export async function enumerate(kind: MediaDeviceKind): Promise<MediaDeviceInfo[]> {
  try {
    return await Room.getLocalDevices(kind);
  } catch {
    return [];
  }
}

/** A friendly label for a device when the browser hasn't granted label access yet. */
export function deviceDisplayName(d: MediaDeviceInfo, fallbackKind: string): string {
  return d.label || `${fallbackKind} ${d.deviceId.slice(0, 6)}`;
}
