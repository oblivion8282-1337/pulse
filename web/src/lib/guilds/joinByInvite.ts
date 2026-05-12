import { goto } from '$app/navigation';
import { chatApi } from '$lib/api/chat';
import { guilds } from '$lib/stores/guilds.svelte';

/**
 * Pull the invite code out of a pasted full link (e.g.
 * `https://pulse.unicutmedia.com/invite/abcd1234`) or accept a bare code.
 */
export function parseInviteCode(input: string): string {
	const trimmed = input.trim();
	const m = trimmed.match(/\/invite\/([^/?#\s]+)/i);
	return (m ? m[1] : trimmed).trim();
}

/**
 * Accept an invite (given a pasted link or a bare code), refresh the guild
 * list, and navigate into the joined guild. Throws on an empty input or an
 * invalid/expired code (ApiError) — callers should surface that to the user.
 */
export async function joinGuildByInvite(input: string): Promise<void> {
	const code = parseInviteCode(input);
	if (!code) throw new Error('Bitte einen Einladungslink oder -code eingeben.');
	const result = await chatApi.acceptInvite(code);
	await guilds.hydrate();
	await goto(
		result.channel_id
			? `/app/guilds/${result.guild.id}/channels/${result.channel_id}`
			: `/app/guilds/${result.guild.id}/channels/_`
	);
}
