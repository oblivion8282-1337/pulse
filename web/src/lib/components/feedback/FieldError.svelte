<!--
  Fehlermeldung unter einem Formularfeld oder Abschnitt.

  Ersetzt 33 handgebaute `{#if error}`-Blöcke, die sich in drei Farben
  (`text-red-400` 69x, `text-destructive` 23x, `text-red-500` 4x), drei Größen
  und wechselnder Klassenreihenfolge unterschieden. `text-sm` ist die
  Mehrheitsgröße (29 gegen 5), `text-destructive` der einzige Token, der beim
  Umfärben des Themes mitgeht.

  Rendert nichts, wenn `message` leer/undefined ist — Aufrufer brauchen also
  kein eigenes `{#if}` mehr:

      <FieldError message={error} />
      <FieldError message={error} testId="profile-error" />
-->
<script lang="ts">
  let {
    message,
    class: extraClass = '',
    testId = undefined
  }: {
    /** Fehlertext. Leer/undefined → es wird nichts gerendert. */
    message?: string | null;
    class?: string;
    /**
     * Wird als `data-testid` durchgereicht. Nötig, weil die Hausregel verlangt,
     * dass Testids beim Umbau identisch bleiben — ohne diese Prop müssten
     * getestete Fehlerstellen handgebaut bleiben.
     */
    testId?: string;
  } = $props();
</script>

{#if message}
  <p class="text-destructive text-sm {extraClass}" role="alert" data-testid={testId}>{message}</p>
{/if}
