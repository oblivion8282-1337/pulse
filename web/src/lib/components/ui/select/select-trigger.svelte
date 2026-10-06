<script lang="ts">
	import { Select as SelectPrimitive } from "bits-ui";
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";
	import type { Snippet } from "svelte";

	let {
		ref = $bindable(null),
		class: className,
		children: childrenProp,
		...restProps
	}: WithoutChildrenOrChild<SelectPrimitive.TriggerProps> & {
		children?: Snippet;
	} = $props();
</script>

<!-- Die geschlossene Optik ist DIE des Textfeldes (`ui/input/input.svelte`):
     gleiche Höhe, Rahmen, Fokus-Ring — ein Auswahlfeld soll neben einem
     Eingabefeld nicht wie ein fremdes Bauteil wirken. Die nativen <select>s,
     die dieser Baustein ersetzt, sahen anders aus (bg-bg-input, rounded-md);
     die Wanderung hat sie bewusst EINGEDEUTET statt übernommen. -->
<SelectPrimitive.Trigger
	bind:ref
	data-slot="select-trigger"
	class={cn(
		"dark:bg-input/30 border-input focus-visible:border-ring focus-visible:ring-ring/50 h-9 rounded-xl border bg-card px-3 py-1 text-base shadow-xs transition-[color,box-shadow] focus-visible:ring-3 md:text-sm w-full min-w-0 outline-none flex items-center justify-between gap-2 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 data-placeholder:text-muted-foreground [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:opacity-50",
		className
	)}
	{...restProps}
>
	{#snippet children()}
		{@render childrenProp?.()}
		<ChevronDownIcon class="data-open:rotate-180 transition-transform duration-150" />
	{/snippet}
</SelectPrimitive.Trigger>
