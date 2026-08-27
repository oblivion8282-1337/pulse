<!--
  Die beiden Compose-Dateien für den manuellen Installationspfad.

  Bewusst NICHT über die API, sondern als statische Datei vom selben Ursprung
  (`/self-host/*`, ausgeliefert vom Web-nginx aus `infra/self-host/`): sie
  enthalten keine Geheimnisse und sind für jeden gleich. Nur die `.env` daneben
  ist personalisiert und muss deshalb über den authentifizierten POST-Weg gehen.

  nginx liefert die Dateien als `text/plain` aus — ohne `download` würde der
  Browser sie anzeigen statt zu speichern. Das Attribut wirkt nur bei gleichem
  Ursprung, was hier gilt (App und Dateien liegen auf derselben Domain).
-->
<script lang="ts">
  import { m } from '$lib/paraglide/messages.js';
  import FileDownIcon from '@lucide/svelte/icons/file-down';

  let { base }: { base: string } = $props();

  const DATEIEN = [
    { name: 'docker-compose.yml', label: () => m.instance_setup_manual_compose_default() },
    {
      name: 'docker-compose.behind-proxy.yml',
      label: () => m.instance_setup_manual_compose_proxy()
    }
  ];
</script>

<div class="flex flex-col gap-1.5">
  <p class="text-text-muted text-xs">{m.instance_setup_manual_compose_hint()}</p>
  <div class="flex flex-wrap gap-2">
    {#each DATEIEN as datei (datei.name)}
      <a
        href="{base}/self-host/{datei.name}"
        download={datei.name}
        class="border-border hover:bg-bg-input text-text-bright flex items-center gap-2 rounded-md border px-3 py-2 text-xs font-medium"
        data-testid="instance-setup-compose-{datei.name}"
      >
        <FileDownIcon class="size-3.5" />
        {datei.label()}
      </a>
    {/each}
  </div>
</div>
