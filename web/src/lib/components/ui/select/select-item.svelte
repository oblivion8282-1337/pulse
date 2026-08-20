<script lang="ts">
	import { Select as SelectPrimitive } from "bits-ui";
	import CheckIcon from '@lucide/svelte/icons/check';
	import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";
	import type { Snippet } from "svelte";

	let {
		ref = $bindable(null),
		class: className,
		children: childrenProp,
		...restProps
	}: WithoutChildrenOrChild<SelectPrimitive.ItemProps> & {
		children?: Snippet;
	} = $props();
</script>

<SelectPrimitive.Item
	bind:ref
	data-slot="select-item"
	class={cn(
		"focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm select-none outline-hidden data-disabled:pointer-events-none data-disabled:opacity-50",
		className
	)}
	{...restProps}
>
	{#snippet children({ selected })}
		<span
			class="absolute right-2 flex items-center justify-center pointer-events-none"
			data-slot="select-item-indicator"
		>
			{#if selected}
				<CheckIcon />
			{/if}
		</span>
		<span class="min-w-0 flex-1 truncate">
			{@render childrenProp?.()}
		</span>
	{/snippet}
</SelectPrimitive.Item>
