<!--
  Gemeinsame Unterstreichungs-Tab-Leiste für die Admin-Bereiche mit Badge
  (AdminComplaints + AdminInstances). Labels kommen als Props (die m.*-Keys der
  Aufrufer) — die Komponente bleibt textfrei. Der optionale Badge sitzt auf
  genau einem Tab (z. B. „pending" bei den Instanz-Anträgen).
-->
<script lang="ts">
  let {
    tabs,
    active = $bindable(),
    testIdPrefix,
    badgeTab,
    badgeCount = null
  }: {
    tabs: { id: string; label: string }[];
    active: string;
    /** Basis der data-testids (`{prefix}-{tab.id}`). */
    testIdPrefix: string;
    /** Tab, der den Badge trägt; fehlt → kein Badge. */
    badgeTab?: string;
    badgeCount?: number | null;
  } = $props();
</script>

<div class="border-border mb-4 flex gap-1 border-b">
  {#each tabs as t (t.id)}
    <button
      type="button"
      onclick={() => (active = t.id)}
      class="-mb-px border-b-2 px-3 py-2 text-sm transition-colors {active === t.id
        ? 'border-primary text-text-bright font-medium'
        : 'border-transparent text-text-muted hover:text-text-base'}"
      data-testid="{testIdPrefix}-{t.id}"
    >
      {t.label}
      {#if badgeTab === t.id && badgeCount && badgeCount > 0}
        <span
          class="ml-1.5 inline-flex min-w-4 items-center justify-center rounded-full bg-warning px-1 align-middle text-2xs font-semibold text-black"
        >
          {badgeCount}
        </span>
      {/if}
    </button>
  {/each}
</div>
