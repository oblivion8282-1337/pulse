import { goto } from '$app/navigation';
import { chatApi } from '$lib/api/chat';
import { rolesApi } from '$lib/api/roles';
import { guilds } from '$lib/stores/guilds.svelte';
import { guildSounds } from '$lib/stores/guildSounds.svelte';
import { roles } from '$lib/stores/roles.svelte';
import { parseInviteLink } from './inviteLink';

/**
 * Accept an invite (given a pasted link or a bare code), refresh the guild
 * list, and navigate into the joined guild. Throws on an empty input or an
 * invalid/expired code (ApiError) — callers should surface that to the user.
 *
 * Self-Host (Link trägt ``?host=``): NICHT inline gegen den aktiven Server
 * akzeptieren (der Code lebt auf einem anderen Backend) → auf die
 * ``/invite/[code]?host=``-Route umleiten, die den Server hinzufügt,
 * cert-login macht und dann beitritt.
 */
export async function joinGuildByInvite(input: string): Promise<void> {
	const { code, host } = parseInviteLink(input);
	if (!code) throw new Error('Bitte einen Einladungslink oder -code eingeben.');
	if (host) {
		await goto(`/invite/${code}?host=${encodeURIComponent(host)}`);
		return;
	}
	const result = await chatApi.acceptInvite(code);
	await guilds.hydrate();
	// Pull roles for the newly-joined guild so UI gates resolve correctly
	// before the next WS reconnect rebuilds ``ready``. recomputeGuild
	// runs after upsert so the @everyone permissions feed the resolver.
	try {
		const rows = await rolesApi.list(result.guild.id);
		for (const r of rows) roles.upsertRole(r);
		roles.recomputeGuild(result.guild.id);
	} catch {
		/* best-effort; the user sees the guild listed either way */
	}
	// Pull this guild's sound overrides for the same reason — without it
	// the voice/notification sounds use defaults until WS reconnect.
	guildSounds.ensureSlot(result.guild.id);
	void guildSounds.refresh(result.guild.id);
	await goto(
		result.channel_id
			? `/app/guilds/${result.guild.id}/channels/${result.channel_id}`
			: `/app/guilds/${result.guild.id}/channels/_`
	);
}
