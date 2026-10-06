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
import { confirmDialog } from '$lib/components/feedback/confirm.svelte';
import { errText } from '$lib/utils/errText';

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

/**
 * Gemeinsamer Rahmen aller Handler: ``working`` setzen, Aktion laufen
 * lassen, Fehler als Toast (mit ``errText``-Beschreibung) zeigen,
 * ``working`` immer zuruecksetzen. Die Zulassungs-Pruefung bleibt im
 * jeweiligen Handler — sie entscheidet vor dem ``setWorking``.
 */
async function withWorking(
  ctx: ActionCtx,
  failKey: () => string,
  run: () => Promise<void>
): Promise<void> {
  ctx.setWorking(true);
  try {
    await run();
  } catch (err) {
    toast.error(failKey(), {
      description: errText(err)
    });
  } finally {
    ctx.setWorking(false);
  }
}

export async function startDM(ctx: ActionCtx): Promise<void> {
  if (ctx.isSelf || ctx.isWorking()) return;
  await withWorking(ctx, () => m.popover_actions_dm_open_failed(), async () => {
    const dm = await chatApi.createOrGetDMChannel(ctx.userId);
    directMessages.upsert(dm);
    ctx.close();
    ctx.onAction?.();
    await goto(`/app/@me/${dm.id}`);
  });
}

export async function toggleMute(ctx: ActionCtx): Promise<void> {
  const voiceChannelId = ctx.targetVoiceChannelId;
  if (!ctx.canMute || !voiceChannelId || ctx.isWorking()) return;
  await withWorking(ctx, () => m.popover_actions_mute_failed(), async () => {
    const next = !ctx.isForceMuted;
    const result = await setVoiceOverride(voiceChannelId, ctx.userId, {
      mute: next
    });
    // Optimistic local update — the WS event echo will reconfirm.
    voicePresence.applyOverride(
      voiceChannelId,
      ctx.userId,
      result.muted,
      result.deafened
    );
    toast.success(next ? m.popover_actions_muted({ displayName: ctx.displayName }) : m.popover_actions_unmuted());
  });
}

export async function toggleDeafen(ctx: ActionCtx): Promise<void> {
  const voiceChannelId = ctx.targetVoiceChannelId;
  if (!ctx.canDeafen || !voiceChannelId || ctx.isWorking()) return;
  await withWorking(ctx, () => m.popover_actions_deafen_failed(), async () => {
    const next = !ctx.isForceDeafened;
    const result = await setVoiceOverride(voiceChannelId, ctx.userId, {
      deafen: next
    });
    voicePresence.applyOverride(
      voiceChannelId,
      ctx.userId,
      result.muted,
      result.deafened
    );
    toast.success(next ? m.popover_actions_deafened({ displayName: ctx.displayName }) : m.popover_actions_undeafened());
  });
}

export async function disconnectVoice(ctx: ActionCtx): Promise<void> {
  const voiceChannelId = ctx.targetVoiceChannelId;
  if (!ctx.canDisconnectVoice || !voiceChannelId || ctx.isWorking()) return;
  await withWorking(ctx, () => m.popover_actions_voice_disconnect_failed(), async () => {
    await disconnectFromVoice(voiceChannelId, ctx.userId);
    toast.success(m.popover_actions_voice_disconnected({ displayName: ctx.displayName }));
    ctx.close();
    ctx.onAction?.();
  });
}

export async function moveIntoVoice(ctx: ActionCtx, targetChannelId: string): Promise<void> {
  if (!ctx.canMoveVoice || ctx.isSelf || ctx.isWorking()) return;
  if (targetChannelId === ctx.targetVoiceChannelId) return;
  await withWorking(ctx, () => m.popover_actions_voice_move_failed(), async () => {
    await moveIntoVoiceChannel(targetChannelId, ctx.userId);
    toast.success(m.popover_actions_voice_moved({ displayName: ctx.displayName }));
    ctx.close();
    ctx.onAction?.();
  });
}

export async function kick(ctx: ActionCtx): Promise<void> {
  const gid = ctx.guildId;
  if (!gid || ctx.isWorking()) return;
  await withWorking(ctx, () => m.popover_actions_kick_failed(), async () => {
    await chatApi.kickMember(gid, ctx.userId);
    toast.success(m.popover_actions_kicked({ displayName: ctx.displayName }));
    ctx.close();
    ctx.onAction?.();
  });
}

export async function ban(ctx: ActionCtx): Promise<void> {
  const gid = ctx.guildId;
  if (!ctx.canBan || !gid || ctx.isWorking()) return;
  await withWorking(ctx, () => m.popover_actions_ban_failed(), async () => {
    await chatApi.banUser(gid, ctx.userId, null);
    toast.success(m.popover_actions_banned({ displayName: ctx.displayName }));
    ctx.close();
    ctx.onAction?.();
  });
}

export async function sendFriendRequest(ctx: ActionCtx): Promise<void> {
  if (ctx.isSelf || ctx.isWorking()) return;
  await withWorking(ctx, () => m.popover_actions_friend_request_send_failed(), async () => {
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
  });
}

export async function cancelFriendRequest(ctx: ActionCtx, reqId: string): Promise<void> {
  if (ctx.isWorking()) return;
  await withWorking(ctx, () => m.popover_actions_friend_request_cancel_failed(), async () => {
    await friendsApi.cancelRequest(reqId);
    // Backend fans friend_request_cancelled to the RECEIVER only (no echo to
    // the actor) — mirror locally so the popover swaps back to "send" and the
    // Pending tab drops the row without waiting for a reconnect reseed.
    friendRequests.removeOutgoing(reqId);
    toast.success(m.popover_actions_friend_request_cancelled());
  });
}

export async function acceptFriendRequest(ctx: ActionCtx, reqId: string): Promise<void> {
  if (ctx.isWorking()) return;
  await withWorking(ctx, () => m.popover_actions_friend_request_accept_failed(), async () => {
    const friendship = await friendsApi.acceptRequest(reqId);
    friends.add(ctx.userId, friendship.since);
    toast.success(m.popover_actions_friend_added({ displayName: ctx.displayName }));
  });
}

export async function declineFriendRequest(ctx: ActionCtx, reqId: string): Promise<void> {
  if (ctx.isWorking()) return;
  await withWorking(ctx, () => m.popover_actions_friend_request_decline_failed(), async () => {
    await friendsApi.declineRequest(reqId);
    // Backend fans friend_request_declined to the SENDER only (no echo to the
    // declining actor) — mirror locally so the popover swaps back to "send"
    // and the Pending tab drops the row without waiting for a reconnect reseed.
    friendRequests.removeIncoming(reqId);
    toast.success(m.popover_actions_friend_request_declined());
  });
}

export async function removeFriend(ctx: ActionCtx): Promise<void> {
  if (ctx.isSelf || ctx.isWorking()) return;
  const ok = await confirmDialog({
    description: m.popover_actions_remove_friend_confirm({ displayName: ctx.displayName }),
    destructive: true
  });
  if (!ok) return;
  await withWorking(ctx, () => m.popover_actions_remove_friend_failed(), async () => {
    await friendsApi.removeFriend(ctx.userId);
    friends.remove(ctx.userId);
    toast.success(m.popover_actions_friend_removed({ displayName: ctx.displayName }));
    ctx.close();
  });
}

export async function blockUser(ctx: ActionCtx): Promise<void> {
  if (ctx.isSelf || ctx.isWorking()) return;
  const ok = await confirmDialog({
    description: m.popover_actions_block_confirm({ displayName: ctx.displayName }),
    destructive: true
  });
  if (!ok) return;
  await withWorking(ctx, () => m.popover_actions_block_failed(), async () => {
    const result = await friendsApi.blockUser(ctx.userId);
    blocks.add(ctx.userId, result.since);
    friends.remove(ctx.userId);
    toast.success(m.popover_actions_blocked({ displayName: ctx.displayName }));
    ctx.close();
  });
}

export async function unblockUser(ctx: ActionCtx): Promise<void> {
  if (ctx.isSelf || ctx.isWorking()) return;
  await withWorking(ctx, () => m.popover_actions_unblock_failed(), async () => {
    await friendsApi.unblockUser(ctx.userId);
    blocks.remove(ctx.userId);
    toast.success(m.popover_actions_unblocked({ displayName: ctx.displayName }));
  });
}
