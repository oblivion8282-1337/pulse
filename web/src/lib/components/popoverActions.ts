/**
 * Async action handlers used by ``PopoverActions.svelte``.
 *
 * Pulled out of the component so the Svelte file stays under the
 * §12.1 size cap. Each factory returns a handler closure bound to
 * the component-local ``ctx`` (props + the ``working`` setter the
 * component drives to disable buttons during the call).
 */
import { toast } from 'svelte-sonner';
import { goto } from '$app/navigation';
import { chatApi } from '$lib/api/chat';
import { friendsApi } from '$lib/api/friends';
import { setVoiceOverride, disconnectFromVoice } from '$lib/api/voice';
import { directMessages } from '$lib/stores/directMessages.svelte';
import { voicePresence } from '$lib/stores/voicePresence.svelte';
import { friends } from '$lib/stores/friends.svelte';
import { blocks } from '$lib/stores/blocks.svelte';

export interface ActionCtx {
  userId: string;
  displayName: string;
  guildId: string | undefined;
  isSelf: boolean;
  /** Voice channel the target is currently in within ``guildId``,
   *  or ``null`` if not in any. Drives force-mute/deafen/disconnect. */
  targetVoiceChannelId: string | null;
  isForceMuted: boolean;
  isForceDeafened: boolean;
  canMute: boolean;
  canDeafen: boolean;
  canDisconnectVoice: boolean;
  canBan: boolean;
  /** Component-local working flag; getter so handlers re-read the
   *  current value (re-entrancy guard). */
  isWorking: () => boolean;
  setWorking: (v: boolean) => void;
  /** Close the parent popover after a successful destructive/nav action. */
  close: () => void;
  /** Caller-supplied — closes parent overlays (e.g. mobile sheet). */
  onAction?: () => void;
}

export async function startDM(ctx: ActionCtx): Promise<void> {
  if (ctx.isSelf || ctx.isWorking()) return;
  ctx.setWorking(true);
  try {
    const dm = await chatApi.createOrGetDMChannel(ctx.userId);
    directMessages.upsert(dm);
    ctx.close();
    ctx.onAction?.();
    await goto(`/app/@me/${dm.id}`);
  } catch (err) {
    toast.error('DM konnte nicht geöffnet werden', {
      description: err instanceof Error ? err.message : String(err)
    });
  } finally {
    ctx.setWorking(false);
  }
}

export async function toggleMute(ctx: ActionCtx): Promise<void> {
  if (!ctx.canMute || !ctx.targetVoiceChannelId || ctx.isWorking()) return;
  ctx.setWorking(true);
  try {
    const next = !ctx.isForceMuted;
    const result = await setVoiceOverride(ctx.targetVoiceChannelId, ctx.userId, {
      mute: next
    });
    // Optimistic local update — the WS event echo will reconfirm.
    voicePresence.applyOverride(
      ctx.targetVoiceChannelId,
      ctx.userId,
      result.muted,
      result.deafened
    );
    toast.success(next ? `${ctx.displayName} stummgeschaltet` : `Stummschaltung aufgehoben`);
  } catch (err) {
    toast.error('Stummschaltung fehlgeschlagen', {
      description: err instanceof Error ? err.message : String(err)
    });
  } finally {
    ctx.setWorking(false);
  }
}

export async function toggleDeafen(ctx: ActionCtx): Promise<void> {
  if (!ctx.canDeafen || !ctx.targetVoiceChannelId || ctx.isWorking()) return;
  ctx.setWorking(true);
  try {
    const next = !ctx.isForceDeafened;
    const result = await setVoiceOverride(ctx.targetVoiceChannelId, ctx.userId, {
      deafen: next
    });
    voicePresence.applyOverride(
      ctx.targetVoiceChannelId,
      ctx.userId,
      result.muted,
      result.deafened
    );
    toast.success(next ? `${ctx.displayName} taubgeschaltet` : `Taubschaltung aufgehoben`);
  } catch (err) {
    toast.error('Taubschaltung fehlgeschlagen', {
      description: err instanceof Error ? err.message : String(err)
    });
  } finally {
    ctx.setWorking(false);
  }
}

export async function disconnectVoice(ctx: ActionCtx): Promise<void> {
  if (!ctx.canDisconnectVoice || !ctx.targetVoiceChannelId || ctx.isWorking()) return;
  ctx.setWorking(true);
  try {
    await disconnectFromVoice(ctx.targetVoiceChannelId, ctx.userId);
    toast.success(`${ctx.displayName} aus dem Voice-Channel entfernt`);
    ctx.close();
    ctx.onAction?.();
  } catch (err) {
    toast.error('Trennen aus Voice fehlgeschlagen', {
      description: err instanceof Error ? err.message : String(err)
    });
  } finally {
    ctx.setWorking(false);
  }
}

export async function kick(ctx: ActionCtx): Promise<void> {
  if (!ctx.guildId || ctx.isWorking()) return;
  ctx.setWorking(true);
  try {
    await chatApi.kickMember(ctx.guildId, ctx.userId);
    toast.success(`${ctx.displayName} entfernt`);
    ctx.close();
    ctx.onAction?.();
  } catch (err) {
    toast.error('Mitglied konnte nicht entfernt werden', {
      description: err instanceof Error ? err.message : String(err)
    });
  } finally {
    ctx.setWorking(false);
  }
}

export async function ban(ctx: ActionCtx): Promise<void> {
  if (!ctx.canBan || !ctx.guildId || ctx.isWorking()) return;
  ctx.setWorking(true);
  try {
    await chatApi.banUser(ctx.guildId, ctx.userId, null);
    toast.success(`${ctx.displayName} gesperrt`);
    ctx.close();
    ctx.onAction?.();
  } catch (err) {
    toast.error('Sperren fehlgeschlagen', {
      description: err instanceof Error ? err.message : String(err)
    });
  } finally {
    ctx.setWorking(false);
  }
}

export async function sendFriendRequest(ctx: ActionCtx): Promise<void> {
  if (ctx.isSelf || ctx.isWorking()) return;
  ctx.setWorking(true);
  try {
    const res = await friendsApi.sendFriendRequest(ctx.userId);
    if ('auto_accepted' in res && res.auto_accepted) {
      friends.add(ctx.userId, res.friendship.since);
      toast.success(`${ctx.displayName} ist jetzt dein Freund!`);
    } else {
      toast.success(`Freundschaftsanfrage an ${ctx.displayName} gesendet`);
    }
  } catch (err) {
    toast.error('Anfrage konnte nicht gesendet werden', {
      description: err instanceof Error ? err.message : String(err)
    });
  } finally {
    ctx.setWorking(false);
  }
}

export async function cancelFriendRequest(ctx: ActionCtx, reqId: string): Promise<void> {
  if (ctx.isWorking()) return;
  ctx.setWorking(true);
  try {
    await friendsApi.cancelRequest(reqId);
    toast.success('Anfrage zurückgezogen');
  } catch (err) {
    toast.error('Anfrage konnte nicht zurückgezogen werden', {
      description: err instanceof Error ? err.message : String(err)
    });
  } finally {
    ctx.setWorking(false);
  }
}

export async function acceptFriendRequest(ctx: ActionCtx, reqId: string): Promise<void> {
  if (ctx.isWorking()) return;
  ctx.setWorking(true);
  try {
    const friendship = await friendsApi.acceptRequest(reqId);
    friends.add(ctx.userId, friendship.since);
    toast.success(`${ctx.displayName} ist jetzt dein Freund!`);
  } catch (err) {
    toast.error('Annehmen fehlgeschlagen', {
      description: err instanceof Error ? err.message : String(err)
    });
  } finally {
    ctx.setWorking(false);
  }
}

export async function declineFriendRequest(ctx: ActionCtx, reqId: string): Promise<void> {
  if (ctx.isWorking()) return;
  ctx.setWorking(true);
  try {
    await friendsApi.declineRequest(reqId);
    toast.success('Anfrage abgelehnt');
  } catch (err) {
    toast.error('Ablehnen fehlgeschlagen', {
      description: err instanceof Error ? err.message : String(err)
    });
  } finally {
    ctx.setWorking(false);
  }
}

export async function removeFriend(ctx: ActionCtx): Promise<void> {
  if (ctx.isSelf || ctx.isWorking()) return;
  if (!confirm(`${ctx.displayName} aus der Freundesliste entfernen?`)) return;
  ctx.setWorking(true);
  try {
    await friendsApi.removeFriend(ctx.userId);
    friends.remove(ctx.userId);
    toast.success(`${ctx.displayName} entfernt`);
    ctx.close();
  } catch (err) {
    toast.error('Entfernen fehlgeschlagen', {
      description: err instanceof Error ? err.message : String(err)
    });
  } finally {
    ctx.setWorking(false);
  }
}

export async function blockUser(ctx: ActionCtx): Promise<void> {
  if (ctx.isSelf || ctx.isWorking()) return;
  if (!confirm(`${ctx.displayName} blockieren?`)) return;
  ctx.setWorking(true);
  try {
    const result = await friendsApi.blockUser(ctx.userId);
    blocks.add(ctx.userId, result.since);
    friends.remove(ctx.userId);
    toast.success(`${ctx.displayName} blockiert`);
    ctx.close();
  } catch (err) {
    toast.error('Blockieren fehlgeschlagen', {
      description: err instanceof Error ? err.message : String(err)
    });
  } finally {
    ctx.setWorking(false);
  }
}

export async function unblockUser(ctx: ActionCtx): Promise<void> {
  if (ctx.isSelf || ctx.isWorking()) return;
  ctx.setWorking(true);
  try {
    await friendsApi.unblockUser(ctx.userId);
    blocks.remove(ctx.userId);
    toast.success(`${ctx.displayName} entblockiert`);
  } catch (err) {
    toast.error('Entblockieren fehlgeschlagen', {
      description: err instanceof Error ? err.message : String(err)
    });
  } finally {
    ctx.setWorking(false);
  }
}
