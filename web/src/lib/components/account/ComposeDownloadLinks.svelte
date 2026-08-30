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
  import { Button } from '$lib/components/ui/button';
  import FileDownIcon from '@lucide/svelte/icons/file-down';

  let { base }: { base: string } = $props();

  const DATEIEN = [
    { name: 'docker-compose.yml', label: () => m.instance_setup_manual_compose_default() },
    {
      name: 'docker-compose.behind-proxy.yml',
      label: () => m.instance_setup_manual_compose_proxy()
    },
    {
      name: 'pulse-update.sh',
      label: () => m.instance_setup_manual_update_script()
    }
  ];
</script>

<div class="flex flex-col gap-1.5">
  <p class="text-text-muted text-xs">{m.instance_setup_manual_compose_hint()}</p>
  <div class="flex flex-wrap gap-2">
    {#each DATEIEN as datei (datei.name)}
      <!-- `Button` mit `href` statt eines eigens gestylten Links: der
           .env-Download direkt darüber ist ein `variant="outline" size="xs"`,
           und zwei Downloads nebeneinander sollen nicht zwei Formsprachen
           haben. `download` reicht die Komponente als Fremdattribut durch. -->
      <Button
        variant="outline"
        size="xs"
        href="{base}/self-host/{datei.name}"
        download={datei.name}
        data-testid="instance-setup-compose-{datei.name}"
      >
        <FileDownIcon class="size-3.5" />
        {datei.label()}
      </Button>
    {/each}
  </div>
</div>
