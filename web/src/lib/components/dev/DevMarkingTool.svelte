<script lang="ts">
  /**
   * Dev-only-Markiermodus für die Zusammenarbeit mit dem Coding-Agenten.
   *
   * Bedienung:
   *   Alt+Klick       Element markieren (farbiger Rahmen + Nummern-Badge);
   *                   Klick auf ein schon markiertes Element (oder ein Kind
   *                   davon) entfernt die Markierung wieder
   *   Alt+Shift+C     alle Markierungen löschen
   *
   * Jede Markierung setzt `data-mark="N"` auf das Element und legt einen
   * Badge darüber, dessen zugänglicher Name den CSS-Selector enthält
   * („Markierung 1: div.glass-panel …"). Der Agent liest beides aus dem
   * DOM-Snapshot und weiss so exakt, welches Element gemeint ist —
   * „Nummer 2 ist zu gross" reicht dann als Beschreibung.
   *
   * Nur in dev eingebaut (Aufrufstelle gated auf import.meta.env.DEV).
   */
  import { onMount, onDestroy } from 'svelte';

  const COLORS = ['#f59e0b', '#10b981', '#8b5cf6', '#ef4444', '#06b6d4', '#ec4899'];

  interface Mark {
    el: HTMLElement;
    badge: HTMLDivElement;
    prevOutline: string;
  }

  let marks: Mark[] = [];
  let next = 1;

  function selectorFor(el: HTMLElement): string {
    let s = el.tagName.toLowerCase();
    if (el.id) s += `#${el.id}`;
    for (const c of [...el.classList].slice(0, 4)) s += `.${c}`;
    const tid = el.getAttribute('data-testid');
    if (tid) s += `[data-testid=${tid}]`;
    return s;
  }

  function clearOne(mark: Mark) {
    mark.el.style.outline = mark.prevOutline;
    mark.el.removeAttribute('data-mark');
    mark.badge.remove();
  }

  function clearAll() {
    for (const m of marks) clearOne(m);
    marks = [];
    next = 1;
  }

  function place(mark: Mark) {
    const r = mark.el.getBoundingClientRect();
    mark.badge.style.left = `${Math.max(0, r.left)}px`;
    mark.badge.style.top = `${Math.max(0, r.top - 22)}px`;
  }

  function reposition() {
    for (const m of marks) place(m);
  }

  function onClick(ev: MouseEvent) {
    if (!ev.altKey) return;
    const target = ev.target as HTMLElement | null;
    if (!target || target === document.body || target === document.documentElement) return;
    ev.preventDefault();
    ev.stopPropagation();

    // Entmarkieren: Klick auf das markierte Element ODER eines seiner Kinder
    // (Klicks landen meist auf innerem Text/Icons, nicht auf dem Container).
    const markedAncestor = target.closest('[data-mark]') as HTMLElement | null;
    const existing = markedAncestor
      ? marks.find((m) => m.el === markedAncestor)
      : marks.find((m) => m.el === target);
    if (existing) {
      clearOne(existing);
      marks = marks.filter((m) => m !== existing);
      return;
    }
    if (markedAncestor) return; // fremde data-mark-Kennung — nicht anfassen

    const n = next++;
    const color = COLORS[(n - 1) % COLORS.length];
    const prevOutline = target.style.outline;
    target.style.outline = `2px solid ${color}`;
    target.setAttribute('data-mark', String(n));

    const badge = document.createElement('div');
    badge.textContent = String(n);
    badge.setAttribute('role', 'note');
    badge.setAttribute(
      'aria-label',
      `Markierung ${n}: ${selectorFor(target)}`
    );
    badge.style.cssText = `position:fixed;z-index:2147483647;pointer-events:none;
      background:${color};color:#000;font:700 11px/18px ui-sans-serif,sans-serif;
      min-width:18px;height:18px;padding:0 4px;border-radius:4px;text-align:center;
      box-shadow:0 1px 4px rgba(0,0,0,.4);`;
    document.body.appendChild(badge);
    const mark = { el: target, badge, prevOutline };
    marks.push(mark);
    place(mark);
  }

  function onKey(ev: KeyboardEvent) {
    // `code` statt `key`: mit Alt liefern manche Layouts Sonderzeichen
    // (ç, ć …), physisch ist aber immer C gemeint.
    if (ev.altKey && ev.shiftKey && ev.code === 'KeyC') {
      ev.preventDefault();
      clearAll();
    }
  }

  let onScroll = () => requestAnimationFrame(reposition);

  onMount(() => {
    window.addEventListener('click', onClick, { capture: true });
    window.addEventListener('keydown', onKey, { capture: true });
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    window.addEventListener('resize', onScroll);
  });
  onDestroy(() => {
    window.removeEventListener('click', onClick, { capture: true });
    window.removeEventListener('keydown', onKey, { capture: true });
    window.removeEventListener('scroll', onScroll, { capture: true });
    window.removeEventListener('resize', onScroll);
    clearAll();
  });
</script>

<!-- Rendert nichts — Rahmen und Badges leben direkt im Dokument. -->
