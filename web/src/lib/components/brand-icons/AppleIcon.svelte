<!-- Apple-Logo — handgezeichnet (simple-icons führt Apple-Marken nicht mehr).
     fill=currentColor, Größe über `class` (analog Lucide). -->
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
    d="M16.365 1.43c0 1.14-.42 2.2-1.13 2.98-.84.95-2.22 1.68-3.38 1.6-.13-1.1.42-2.27 1.08-3 .76-.83 2.06-1.46 3.43-1.58zM20.7 17.3c-.6 1.36-.89 1.97-1.66 3.18-1.07 1.68-2.58 3.78-4.45 3.79-1.66.02-2.09-1.08-4.34-1.07-2.25.01-2.72 1.09-4.38 1.07-1.87-.02-3.3-1.9-4.37-3.58C-1.4 16.78-1.73 11.06.84 8.05c1.13-1.36 2.9-2.22 4.57-2.22 1.7 0 2.77 1.08 4.18 1.08 1.36 0 2.19-1.08 4.16-1.08 1.49 0 3.07.81 4.2 2.21-3.69 2.02-3.09 7.28-1.25 9.26z"
  />
</svg>
