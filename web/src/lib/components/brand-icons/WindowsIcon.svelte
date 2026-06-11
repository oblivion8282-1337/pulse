<!-- Windows-Logo (vier Flächen, Windows-8-Stil) — handgezeichnet, da
     simple-icons Microsoft-Marken nicht mehr führt. fill=currentColor,
     Größe über `class` (analog Lucide). -->
<script lang="ts">
  let { class: className = '' }: { class?: string } = $props();
</script>

<svg
  viewBox="0 0 24 24"
  fill="currentColor"
  xmlns="http://www.w3.org/2000/svg"
  class={className}
  aria-hidden="true"
>
  <path
    d="M0 3.45 9.75 2.1v9.45H0zM10.95 1.95 24 0v11.4H10.95zM0 12.6h9.75v9.45L0 20.7zM10.95 12.6H24V24l-13.05-1.95z"
  />
</svg>
