<!--
  Select — Auswahlfeld mit Popover-Liste, Erbe der nativen <select>s.

  Bis 2026-08-20 waren Auswahllisten native <select>-Elemente: im geschlossenen
  Zustand unauffällig, geöffnet ein OS-Chrome, das zum Rest der Oberfläche
  nicht passte (unter Linux hell, egal was das Thema sagt). Dieser Wrapper
  setzt den vendored ui/select (bits-ui) so ein, dass eine Wanderstelle nur
  value/options/onchange umstöpselt — Styling, Tastatur-Navigation,
  Typeahead und das Verhalten in Popovern leben hier EINMAL.

  `value` ist bewusst KEIN `$bindable`: der Wrapper schreibt den Wert nie
  zurück, die Wanderstelle muss `onchange` mitführen. Mit `$bindable`
  kompilierte auch ein vergessenes onchange — und das Feld erschiene tot.

  Für Playwright: `data-testid` sitzt auf dem Trigger-Button; die Auswahl
  erfolgt mit Klicks (Trigger, dann Eintrag), nicht mehr selectOption().
-->
<script lang="ts">
  import {
    Select as UISelect,
    SelectContent,
    SelectItem,
    SelectTrigger,
  } from '$lib/components/ui/select/index.js';

  export type SelectOption = { value: string; label: string; disabled?: boolean };

  let {
    id,
    class: className,
    value = '',
    options,
    placeholder,
    onchange,
    disabled = false,
    'data-testid': testid,
    'aria-label': ariaLabel,
  }: {
    id?: string;
    class?: string;
    value?: string;
    options: ReadonlyArray<SelectOption>;
    placeholder?: string;
    onchange?: (value: string) => void;
    disabled?: boolean;
    'data-testid'?: string;
    /** Durchgereicht — manche Wanderstellen haben kein `<label for=>`
     *  daneben, sondern trugen den Feldnamen als aria-label. */
    'aria-label'?: string;
  } = $props();

  // Fehlt der Wert in der Liste (kann nach Filter-Wechseln einen Tick lang
  // vorkommen), zeigt der Trigger den Platzhalter statt leer zu bleiben —
  // ein leeres Feld sähe nach „nichts gewählt" aus, und das ist es nicht.
  const anzeige = $derived(
    options.find((o) => o.value === value)?.label ?? placeholder ?? value,
  );
</script>

<UISelect
  type="single"
  {value}
  {disabled}
  onValueChange={(v: string) => {
    if (v !== undefined) onchange?.(v);
  }}
>
  <SelectTrigger {id} class={className} data-testid={testid} aria-label={ariaLabel}>
    {anzeige}
  </SelectTrigger>
  <SelectContent>
    {#each options as o (o.value)}
      <SelectItem value={o.value} label={o.label} disabled={o.disabled}>
        {o.label}
      </SelectItem>
    {/each}
  </SelectContent>
</UISelect>
