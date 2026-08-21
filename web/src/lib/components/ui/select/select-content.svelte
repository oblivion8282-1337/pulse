<script lang="ts">
	import { Select as SelectPrimitive } from "bits-ui";
	import ChevronUpIcon from '@lucide/svelte/icons/chevron-up';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";
	import type { Snippet } from "svelte";

	let {
		ref = $bindable(null),
		sideOffset = 4,
		align = "start",
		class: className,
		children: childrenProp,
		...restProps
	}: WithoutChildrenOrChild<SelectPrimitive.ContentProps> & {
		children?: Snippet;
	} = $props();
</script>

<!-- Dieselbe Popover-Optik wie dropdown-menu-content (bg-popover, rounded-xl,
     Ring, Blur, dieselben Animationen) — Menü und Auswahlliste sind im
     Produktauge dieselbe Gattung und sollen es auch aussehen. -->
<SelectPrimitive.Portal>
	<SelectPrimitive.Content
		bind:ref
		data-slot="select-content"
		{sideOffset}
		{align}
		class={cn(
			"data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 ring-border bg-popover text-popover-foreground backdrop-blur-xl rounded-xl p-1.5 shadow-xl ring-1 duration-100 z-50 relative max-h-(--bits-select-content-available-height) overflow-y-auto overflow-x-hidden outline-none",
			className
		)}
		{...restProps}
	>
		<SelectPrimitive.ScrollUpButton
			class="flex cursor-default items-center justify-center py-1 [&_svg:not([class*='size-'])]:size-4"
		>
			<ChevronUpIcon />
		</SelectPrimitive.ScrollUpButton>
		<SelectPrimitive.Viewport data-slot="select-viewport">
			{@render childrenProp?.()}
		</SelectPrimitive.Viewport>
		<SelectPrimitive.ScrollDownButton
			class="flex cursor-default items-center justify-center py-1 [&_svg:not([class*='size-'])]:size-4"
		>
			<ChevronDownIcon />
		</SelectPrimitive.ScrollDownButton>
	</SelectPrimitive.Content>
</SelectPrimitive.Portal>
