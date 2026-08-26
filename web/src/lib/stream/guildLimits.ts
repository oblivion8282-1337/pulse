/**
 * Per-community (per-guild) effective quality caps.
 *
 * Each community may override the instance-wide caps (the `capabilities`
 * store) with its own ceilings — the Boost foundation. NULL override = inherit
 * the instance default. These helpers resolve the guild owning a channel and
 * return the effective max, so the stream/voice publish paths clamp to
 * `override ?? instanceDefault` instead of the instance value directly.
 *
 * Client-side / best-effort, exactly like the instance caps — see the honor-
 * system note in the owner UI.
 */

import { capabilities } from '$lib/stores/capabilities.svelte';
import { guilds } from '$lib/stores/guilds.svelte';

// The per-guild resolution override uses the HQ vocabulary (Native/4K/1440p/
// 1080p/720p/480p). The screenshare (ns) path has a narrower ladder, so map
// down; 'Native' → 'native' (uncapped), anything above 1080p → 1080p.
const HQ_TO_NS: Record<string, string> = {
  Native: 'native',
  '4K': '1080p',
  '1440p': '1080p',
  '1080p': '1080p',
  '720p': '720p',
  '480p': '480p'
};

function guildForChannel(channelId: string | null | undefined) {
  const gid = channelId ? guilds.guildIdForChannel(channelId) : null;
  return gid ? guilds.byId[gid] : undefined;
}

/** HQ-stream (desktop) effective ceilings for the channel's community. */
export function effectiveHqLimits(channelId: string | null | undefined): {
  bitrateMaxKbps: number;
  fpsMax: number;
  resolutionMax: string;
} {
  const g = guildForChannel(channelId);
  return {
    bitrateMaxKbps: g?.stream_bitrate_max_kbps ?? capabilities.hqBitrateMaxKbps,
    fpsMax: g?.stream_fps_max ?? capabilities.hqFpsMax,
    resolutionMax: g?.stream_resolution_max ?? capabilities.hqResolutionMax
  };
}

/** Normal screenshare (browser LiveKit) effective ceilings for the community. */
export function effectiveNsLimits(channelId: string | null | undefined): {
  bitrateMaxKbps: number;
  fpsMax: number;
  resolutionMax: string;
} {
  const g = guildForChannel(channelId);
  const res = g?.stream_resolution_max;
  return {
    bitrateMaxKbps: g?.stream_bitrate_max_kbps ?? capabilities.nsBitrateMaxKbps,
    fpsMax: g?.stream_fps_max ?? capabilities.nsFpsMax,
    resolutionMax: res ? (HQ_TO_NS[res] ?? capabilities.nsResolutionMax) : capabilities.nsResolutionMax
  };
}

/** DIE Voice-(Opus-)Bitrate in kbps für den Kanal: Guild-Override ?? Instanz-
 *  wert. Kein Nutzer-Regler — der Server bestimmt die Sprachqualität; ein
 *  Override darf auch über dem Instanzwert liegen (Boost). DMs (kein Guild)
 *  nutzen den Instanzwert. */
export function effectiveVoiceBitrateMaxKbps(channelId: string | null | undefined): number {
  return (
    guildForChannel(channelId)?.voice_bitrate_max_kbps ?? capabilities.voiceBitrateMaxKbps
  );
}
