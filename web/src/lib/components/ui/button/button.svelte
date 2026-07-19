<script lang="ts" module>
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from "svelte/elements";
	import { type VariantProps, tv } from "tailwind-variants";

	export const buttonVariants = tv({
		// `rounded-md` statt shadcn-Default `rounded-full`: 120 von 145 rohen Buttons
		// der App runden als Rechteck ab — die Komponente war der Ausreisser.
		// Beleg: docs/2026-07-19-design-vereinheitlichung-bestandsaufnahme.md
		base: "focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 rounded-md border border-transparent bg-clip-padding text-sm font-semibold focus-visible:ring-3 active:not-aria-[haspopup]:translate-y-px aria-invalid:ring-3 [&_svg:not([class*='size-'])]:size-4 group/button inline-flex shrink-0 items-center justify-center whitespace-nowrap transition-all outline-none select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
		variants: {
			variant: {
				default: "accent-gradient text-primary-foreground shadow-[0_4px_14px_rgba(37,99,235,0.25)] hover:brightness-110",
				outline: "border-border bg-card hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground shadow-xs backdrop-blur-sm",
				secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80 aria-expanded:bg-secondary aria-expanded:text-secondary-foreground backdrop-blur-sm",
				ghost: "hover:bg-muted hover:text-foreground dark:hover:bg-muted/50 aria-expanded:bg-muted aria-expanded:text-foreground",
				destructive: "bg-destructive/10 hover:bg-destructive/20 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/20 text-destructive focus-visible:border-destructive/40 dark:hover:bg-destructive/30",
				// Voll gefülltes Rot neben der zarten Tönung von `destructive`: getönt
				// für Nebenhandlungen ("Abmelden"), gefüllt für den Endpunkt einer
				// Gefahrenzone ("Konto löschen"). Bisher 15x von Hand nachgebaut.
				"destructive-solid":
					"bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 focus-visible:border-destructive/40",
				// Erfolg und Warnung gespiegelt zu `destructive`: getönt für den
				// Normalfall, gefüllt für die Haupthandlung. Gebraucht in der
				// Moderation, wo "grün = genehmigen, gelb = eskalieren" eine
				// Arbeitshilfe ist und nicht Zierde.
				//
				// `text-black` bei den gefüllten Fassungen ist KEIN Versehen: weiss
				// erreicht auf --success/--warning im Dunkelmodus nur 2,5 bzw. 2,1
				// zu 1 und ist damit unlesbar; schwarz liegt bei 8,3 bzw. 9,8.
				success:
					"bg-success/10 text-success hover:bg-success/20 dark:bg-success/20 dark:hover:bg-success/30 focus-visible:ring-success/20 focus-visible:border-success/40",
				"success-solid":
					"bg-success text-black hover:bg-success/90 focus-visible:ring-success/20 focus-visible:border-success/40",
				warning:
					"bg-warning/10 text-warning hover:bg-warning/20 dark:bg-warning/20 dark:hover:bg-warning/30 focus-visible:ring-warning/20 focus-visible:border-warning/40",
				"warning-solid":
					"bg-warning text-black hover:bg-warning/90 focus-visible:ring-warning/20 focus-visible:border-warning/40",
				link: "text-primary underline-offset-4 hover:underline",
			},
			// Feste Höhen, KEINE responsive Vergrösserung auf Touch-Geräten.
			//
			// Ein Versuch am 2026-07-19, hier pauschal `h-9 md:h-8` einzuziehen (um
			// die beim Umstellen verlorenen `py-2 md:py-1.5` der handgebauten
			// Buttons aufzufangen), ist zurückgenommen: er hat die Voice-Leiste
			// umbrechen lassen, sodass das Auflegen-Symbol in die nächste Zeile
			// rutschte. Grund ist, dass die Aufrufstellen, denen Trefferflächen
			// wirklich wichtig sind, das SELBST und gezielter lösen — die
			// Voice-Leiste etwa mit `size-14 md:size-8`, also 56px statt der 4px,
			// die eine pauschale Regel gebracht hätte. Eine Komponenten-weite
			// Vergrösserung addiert sich dort nur dazu und sprengt enge Leisten.
			//
			// Wer für einen Knopf grössere Touch-Flächen braucht: an der
			// Aufrufstelle über `class` lösen, nicht hier.
			size: {
				default: "h-9 gap-1.5 px-3.5 in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
				xs: "h-6 gap-1 px-2.5 text-xs in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
				sm: "h-8 gap-1 px-3 in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
				lg: "h-10 gap-1.5 px-4 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
				icon: "size-9",
				"icon-xs": "size-6 in-data-[slot=button-group]:rounded-md [&_svg:not([class*='size-'])]:size-3",
				"icon-sm": "size-8 in-data-[slot=button-group]:rounded-md",
				"icon-lg": "size-10",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	});

	export type ButtonVariant = VariantProps<typeof buttonVariants>["variant"];
	export type ButtonSize = VariantProps<typeof buttonVariants>["size"];

	export type ButtonProps = WithElementRef<HTMLButtonAttributes> &
		WithElementRef<HTMLAnchorAttributes> & {
			variant?: ButtonVariant;
			size?: ButtonSize;
		};
</script>

<script lang="ts">
	let {
		class: className,
		variant = "default",
		size = "default",
		ref = $bindable(null),
		href = undefined,
		type = "button",
		disabled,
		children,
		...restProps
	}: ButtonProps = $props();
</script>

{#if href}
	<a
		bind:this={ref}
		data-slot="button"
		class={cn(buttonVariants({ variant, size }), className)}
		href={disabled ? undefined : href}
		aria-disabled={disabled}
		role={disabled ? "link" : undefined}
		tabindex={disabled ? -1 : undefined}
		{...restProps}
	>
		{@render children?.()}
	</a>
{:else}
	<button
		bind:this={ref}
		data-slot="button"
		class={cn(buttonVariants({ variant, size }), className)}
		{type}
		{disabled}
		{...restProps}
	>
		{@render children?.()}
	</button>
{/if}
