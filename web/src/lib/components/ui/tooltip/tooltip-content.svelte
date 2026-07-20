<!--
	Tooltip-Blase — OHNE Zipfel (2026-07-20 entfernt).

	Der Zipfel war ein um 45 Grad gedrehtes Quadrat mit Füllung, aber ohne Rand.
	Das fiel nicht auf, solange der Rand der Blase im hellen Modus auf `weiss 55 %`
	stand und selbst unsichtbar war. Seit er dunkel ist, hing ein konturloser Fleck
	an einer umrandeten Blase.

	Nachrüsten ist mehr Aufwand als es aussieht — drei Dinge müssten gleichzeitig
	stimmen:
	  - Rand nur auf den zwei nach aussen zeigenden Kanten (welche zwei, hängt von
	    der Seite ab), sonst zieht er einen Strich quer durch die Blase.
	  - Rundung nur an der Spitze, sonst Kerben an der Naht.
	  - `--border` ist DURCHSCHEINEND: als `border` läge er auf der eigenen Füllung
	    statt auf dem Untergrund und käme 56 Helligkeitsstufen zu hell heraus
	    (#dddee1 statt #c6cbd3 des Blasenrands). Zu lösen mit
	    `background-clip: padding-box`.

	Lösbar, aber dem Nutzen nicht angemessen — die Nähe zum Auslöser trägt die
	Zuordnung ohnehin. Entscheidung mit dem Nutzer, nicht aus Bequemlichkeit.
-->
<script lang="ts">
	import { Tooltip as TooltipPrimitive } from "bits-ui";
	import { cn } from "$lib/utils.js";
	import TooltipPortal from "./tooltip-portal.svelte";
	import type { ComponentProps } from "svelte";
	import type { WithoutChildrenOrChild } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		// 8 statt 0: Mit dem Zipfel (s. Kopf-Kommentar) entfiel der Abstand, den die
		// Positionierung automatisch für seine Höhe einrechnete — die Blase klebte
		// sonst am Auslöser. Gemessen: vorher 10 px, jetzt 8 px.
		sideOffset = 8,
		side = "top",
		children,
		portalProps,
		...restProps
	}: TooltipPrimitive.ContentProps & {
		portalProps?: WithoutChildrenOrChild<ComponentProps<typeof TooltipPortal>>;
	} = $props();
</script>

<TooltipPortal {...portalProps}>
	<TooltipPrimitive.Content
		bind:ref
		data-slot="tooltip-content"
		{sideOffset}
		{side}
		class={cn(
			"data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs has-data-[slot=kbd]:pr-1.5 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm ring-border bg-popover text-popover-foreground backdrop-blur-xl shadow-xl ring-1 z-50 w-fit max-w-xs origin-(--bits-tooltip-content-transform-origin)",
			className
		)}
		{...restProps}
	>
		{@render children?.()}
	</TooltipPrimitive.Content>
</TooltipPortal>
