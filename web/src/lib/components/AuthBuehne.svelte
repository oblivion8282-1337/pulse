<!--
  Hintergrund der Anmelde- und der Einladungsseite: durchgehender Verlauf plus
  atmende Glow-Blobs über die GANZE Fläche (sonst wirkt nur eine Hälfte
  glühend). Nur nicht-handy — am Handy bleibt der Standard-Seitengrund. Der
  Elternknoten braucht `relative` und `overflow-hidden`.
-->
<div
  class="pointer-events-none absolute inset-0 -z-10 hidden nicht-handy:block"
  style="background: linear-gradient(150deg, #0e1f3a, #0a1525 60%, #08130c);"
></div>
<div
  class="pointer-events-none absolute inset-0 -z-10 hidden motion-safe:animate-blob-breathe nicht-handy:block"
  style="background:
    radial-gradient(520px 380px at 22% 20%, rgba(59,130,246,.22), transparent 60%),
    radial-gradient(560px 400px at 82% 88%, rgba(16,185,129,.16), transparent 60%);"
></div>
