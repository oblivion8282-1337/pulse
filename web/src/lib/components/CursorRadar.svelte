<script lang="ts">
  // Cursor-folgendes Radar-Sonar: strahlt aus der übergebenen Position (x/y in
  // px relativ zum positionierten Eltern-Container), verblasst sanft wenn
  // `active=false`. pointer-events-none → schluckt keine Klicks/Eingaben.
  // Die transform-Transition (120 ms) gibt ein leichtes, sanftes Nachziehen.
  interface Props {
    x: number;
    y: number;
    active: boolean;
  }

  let { x, y, active }: Props = $props();
</script>

<div
  class="pointer-events-none absolute left-0 top-0 h-[120px] w-[120px]"
  style="transform: translate3d(calc({x}px - 50%), calc({y}px - 50%), 0);
         opacity: {active ? 1 : 0};
         transition: transform 120ms ease-out, opacity 500ms ease;"
  aria-hidden="true"
>
  <!-- Statischer Rahmen-Ring -->
  <div
    class="absolute inset-0 rounded-full border"
    style="border-color: rgba(255,255,255,.12);"
  ></div>
  <!-- Strahlende Ringe (Basis-opacity:0 → ohne Animation unsichtbar) -->
  <div
    class="absolute inset-0 rounded-full border-2 opacity-0 motion-safe:animate-sonar-emit"
    style="border-color: rgba(96,165,250,.7);"
  ></div>
  <div
    class="absolute inset-0 rounded-full border-2 opacity-0 motion-safe:animate-sonar-emit"
    style="border-color: rgba(96,165,250,.55); animation-delay: 1s;"
  ></div>
  <div
    class="absolute inset-0 rounded-full border-2 opacity-0 motion-safe:animate-sonar-emit"
    style="border-color: rgba(74,222,128,.5); animation-delay: 2s;"
  ></div>
  <!-- Glühender Kern-Punkt -->
  <div
    class="absolute rounded-full bg-white motion-safe:animate-core-glow"
    style="inset: 50px;"
  ></div>
</div>
