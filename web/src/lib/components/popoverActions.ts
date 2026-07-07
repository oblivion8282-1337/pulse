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
import { setVoiceOverride, disconnectFromVoice, moveIntoVoiceChannel } from '$lib/api/voice';
import { directMessages } from '$lib/stores/directMessages.svelte';
import { voicePresence } from '$lib/stores/voicePresence.svelte';
import { friends } from '$lib/stores/friends.svelte';
import { friendRequests } from '$lib/stores/friendRequests.svelte';
import { blocks } from '$lib/stores/blocks.svelte';
import { m } from '$lib/paraglide/messages.js';

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
  /** Local user can bring the target into a voice channel (MOVE_MEMBERS).
   *  Works whether or not the target is currently in voice. */
  canMoveVoice: boolean;
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
    toast.error(m.popover_actions_dm_open_failed(), {
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
    toast.success(next ? m.popover_actions_muted({ displayName: ctx.displayName }) : m.popover_actions_unmuted());
  } catch (err) {
    toast.error(m.popover_actions_mute_failed(), {
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
    toast.success(next ? m.popover_actions_deafened({ displayName: ctx.displayName }) : m.popover_actions_undeafened());
  } catch (err) {
    toast.error(m.popover_actions_deafen_failed(), {
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
    toast.success(m.popover_actions_voice_disconnected({ displayName: ctx.displayName }));
    ctx.close();
    ctx.onAction?.();
  } catch (err) {
    toast.error(m.popover_actions_voice_disconnect_failed(), {
      description: err instanceof Error ? err.message : String(err)
    });
  } finally {
    ctx.setWorking(false);
  }
}

export async function moveIntoVoice(ctx: ActionCtx, targetChannelId: string): Promise<void> {
  if (!ctx.canMoveVoice || ctx.isSelf || ctx.isWorking()) return;
  if (targetChannelId === ctx.targetVoiceChannelId) return;
  ctx.setWorking(true);
  try {
    await moveIntoVoiceChannel(targetChannelId, ctx.userId);
    toast.success(m.popover_actions_voice_moved({ displayName: ctx.displayName }));
    ctx.close();
    ctx.onAction?.();
  } catch (err) {
    toast.error(m.popover_actions_voice_move_failed(), {
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
    toast.success(m.popover_actions_kicked({ displayName: ctx.displayName }));
    ctx.close();
    ctx.onAction?.();
  } catch (err) {
    toast.error(m.popover_actions_kick_failed(), {
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
    toast.success(m.popover_actions_banned({ displayName: ctx.displayName }));
    ctx.close();
    ctx.onAction?.();
  } catch (err) {
    toast.error(m.popover_actions_ban_failed(), {
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
    // Pending request path. The backend fans friend_request_received to the
    // receiver only — no WS echo to the sender (the REST response is our only
    // signal) — so mirror it locally: the popover switches to "withdraw" and
    // the Pending tab shows the row without waiting for a reconnect reseed.
    // Negated ``in`` (rather than ``in && prop``) so TS narrows res to the
    // pending variant here without a cast.
    if (!('auto_accepted' in res)) {
      friendRequests.addOutgoing(res);
      toast.success(m.popover_actions_friend_request_sent({ displayName: ctx.displayName }));
      return;
    }
    // Auto-accept path: a reverse request was already pending, the backend
    // installs the friendship and returns auto_accepted.
    friends.add(ctx.userId, res.friendship.since);
    toast.success(m.popover_actions_friend_added({ displayName: ctx.displayName }));
  } catch (err) {
    toast.error(m.popover_actions_friend_request_send_failed(), {
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
    // Backend fans friend_request_cancelled to the RECEIVER only (no echo to
    // the actor) — mirror locally so the popover swaps back to "send" and the
    // Pending tab drops the row without waiting for a reconnect reseed.
    friendRequests.removeOutgoing(reqId);
    toast.success(m.popover_actions_friend_request_cancelled());
  } catch (err) {
    toast.error(m.popover_actions_friend_request_cancel_failed(), {
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
    toast.success(m.popover_actions_friend_added({ displayName: ctx.displayName }));
  } catch (err) {
    toast.error(m.popover_actions_friend_request_accept_failed(), {
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
    // Backend fans friend_request_declined to the SENDER only (no echo to the
    // declining actor) — mirror locally so the popover swaps back to "send"
    // and the Pending tab drops the row without waiting for a reconnect reseed.
    friendRequests.removeIncoming(reqId);
    toast.success(m.popover_actions_friend_request_declined());
  } catch (err) {
    toast.error(m.popover_actions_friend_request_decline_failed(), {
      description: err instanceof Error ? err.message : String(err)
    });
  } finally {
    ctx.setWorking(false);
  }
}

export async function removeFriend(ctx: ActionCtx): Promise<void> {
  if (ctx.isSelf || ctx.isWorking()) return;
  if (!confirm(m.popover_actions_remove_friend_confirm({ displayName: ctx.displayName }))) return;
  ctx.setWorking(true);
  try {
    await friendsApi.removeFriend(ctx.userId);
    friends.remove(ctx.userId);
    toast.success(m.popover_actions_friend_removed({ displayName: ctx.displayName }));
    ctx.close();
  } catch (err) {
    toast.error(m.popover_actions_remove_friend_failed(), {
      description: err instanceof Error ? err.message : String(err)
    });
  } finally {
    ctx.setWorking(false);
  }
}

export async function blockUser(ctx: ActionCtx): Promise<void> {
  if (ctx.isSelf || ctx.isWorking()) return;
  if (!confirm(m.popover_actions_block_confirm({ displayName: ctx.displayName }))) return;
  ctx.setWorking(true);
  try {
    const result = await friendsApi.blockUser(ctx.userId);
    blocks.add(ctx.userId, result.since);
    friends.remove(ctx.userId);
    toast.success(m.popover_actions_blocked({ displayName: ctx.displayName }));
    ctx.close();
  } catch (err) {
    toast.error(m.popover_actions_block_failed(), {
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
    toast.success(m.popover_actions_unblocked({ displayName: ctx.displayName }));
  } catch (err) {
    toast.error(m.popover_actions_unblock_failed(), {
      description: err instanceof Error ? err.message : String(err)
    });
  } finally {
    ctx.setWorking(false);
  }
}
