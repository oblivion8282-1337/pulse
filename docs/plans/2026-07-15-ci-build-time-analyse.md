# CI-Bauzeit-Analyse + Beschleunigungs-Plan

Datum: 2026-07-15. Status: **UMGESETZT (2026-07-15).** Hebel 1 (ARM nativ,
Drei-Job-Split prepare→build-Matrix→merge) + Hebel 2 (Pfad-Filter) sind in
`.github/workflows/allinone.yml` gebaut. Entscheidung des Owners: arm64
**behalten**, aber nativ statt QEMU. Hebel 3 (Abbruch-Verhalten) + der optionale
`ci`-images-Pfadfilter bleiben ungebaut (bewusst). CI-Workflows sind erst nach
Merge auf main real testbar (kein PR-Check) → erster `allinone`-Lauf nach Merge
beobachten.

## Ausloeser

Frage des Owners: "GitHub Pro (4 $/Monat) scheint nicht zu langen fuer das
staendige Neubauen." Vermutung war ein Geld-/Kontingent-Limit.

## Befund 1: Geld ist NICHT das Problem

Echte Abrechnung ueber die GitHub-Billing-API (`/users/.../settings/billing/usage`,
`user`-Scope noetig) geprueft:

- **Netto-Kosten jeden Monat 2026 = 0,00 $.** Das Repo ist **oeffentlich** → alle
  Actions-Minuten (auch macOS/Windows) sind gratis und unbegrenzt. Die "Brutto"-
  Zahlen (Jan 7 $, Mai 22 $, Jun 50 $, Jul 31 $) sind der "haette-gekostet"-Betrag,
  der in derselben Zeile zu 100 % als Rabatt wieder abgezogen wird. Wer die 50 $
  irgendwo sieht, erschrickt, zahlt sie aber nicht.
- Das 4-$-Pro-Abo wird von den Pulse-Builds nicht mal angeknabbert. Fuer ein
  oeffentliches Repo bringt es fuer die Builds nichts.
- Groesster Minuten-Verbraucher ist uebrigens ein anderes Repo (`CS-Terminal`,
  ~7800 min im Juni) — Pulse ist in der Abrechnung winzig. Alles gratis.

**Fazit:** Der Engpass ist verschwendete **Bauzeit / Wartegefuehl**, kein Geld.

## Befund 2: Der `allinone`-Build verursacht ~90 % des Problems

Laufzeiten der letzten ~80 Runs:

| Workflow | O Dauer | Max | Zuverlaessigkeit |
|---|---|---|---|
| **allinone** | **35 min** | **108 min** | **8 von 13 abgebrochen** |
| ci (Tests + 7 Server-Images) | 8 min | 10 min | stabil gruen |
| mac-build | 8 min | 10 min | ok |
| win-build | 5 min | 6 min | ok |
| flatpak | 2,5 min | 3 min | ok |

Alles ausser `allinone` ist schnell und solide. Der Teufelskreis bei `allinone`:

1. **Zaeh, weil Multi-Arch mit Emulation.** Baut `linux/amd64` + `linux/arm64`
   auf einer Intel-Maschine; arm64 laeuft per QEMU emuliert (5–10× langsamer).
   Warm ~10 min, kalt 78–108 min.
2. **Wird staendig mitten im Bau abgeschossen.** `concurrency: cancel-in-progress:
   true` auf main → jeder neue Push killt den laufenden Bau. Push-Abstand im
   Schnitt 37 min, aber 4 von 11 Pushes kamen enger als 35 min.
3. **Abgebrochener Bau hinterlaesst KEINEN warmen Cache** (steht als Kommentar im
   Workflow) → naechster Bau wieder kalt → 60+ min → wieder abgebrochen.
   **In dem Messfenster: 333 Minuten Bauzeit auf 8 abgebrochenen Laeufen verpufft.**

Praktische Folge: fuehlt sich an wie "baut ewig"; fuer Selbst-Hoster kann das neue
Image real Stunden bis zur Veroeffentlichung brauchen.

## Nebenbefunde

- **`ci` und `allinone` laufen bei JEDEM main-Push** ohne Pfad-Filter — auch bei
  reinen Doku-/Desktop-/Packaging-Aenderungen. `win`/`mac`/`flatpak` haben schon
  Filter und starten nur bei relevanten Dateien.
- **Backend wird pro Push doppelt gebaut**: 7 Einzel-Service-Images (ci → images,
  fuer die Cloud) + kombiniertes `allinone`-Image ×2 Arch (Selbst-Host). Liegt in
  der Natur der Sache (Cloud-Microservices vs. Self-Host-Monolith).

### Was steckt im `allinone`-Image (fuer den Pfad-Filter wichtig)

Aus `infra/self-host/Dockerfile`: Python-Services (`shared/`, `services/`),
**Web-Frontend** (`web/`, `plugins/`), Rust-Direktpfad-Adapter
(`infra/self-host/direct-adapter/`) + heruntergeladene Binaries (caddy, livekit,
mediamtx, minio, frp — nicht aus dem Repo). → Frontend-Aenderungen muessen `allinone`
DOCH neu bauen; Desktop/Packaging/Docs/Mac-Win-Sidecars nicht.

---

## Vorschlag Hebel 1: ARM nativ bauen statt emulieren

Standard-Docker-Multi-Arch-Muster in zwei Jobs:

1. **Bau-Job (Matrix, je echte Maschine pro Arch, parallel):**
   - `linux/amd64` → `ubuntu-24.04`
   - `linux/arm64` → `ubuntu-24.04-arm` (echte ARM-Maschine, oeffentliches Repo = gratis)
   - Beide bauen ohne Emulation, pushen per Digest (noch ohne finalen Tag).
   - Cache-Scope pro Arch trennen (`scope=allinone-amd64` / `-arm64`), sonst
     ueberschreiben sie sich.
2. **Merge-Job:** wartet auf beide, `docker buildx imagetools create` klebt zum
   Multi-Arch-Manifest unter den echten Tags (`:edge`/`:stable`/`:sha-…`), danach
   der `registry.howispulse.com`-Mirror (aus dem heutigen Workflow uebernehmen).
   Die Tag-/Versions-Berechnung (Step "Compute version + tags") wandert in den
   Merge-Job.

**Effekt:** Kaltbau von ~90 min auf ~15 min (arm64 nativ + beide parallel →
Gesamtzeit ~ der langsamere einzelne Bau).

**Kosten/Risiken:** aus einem Job werden zwei (Digest weiterreichen); Cache pro
Arch; `ubuntu-24.04-arm` ist GA + gratis fuer oeffentliche Repos (geringes Risiko).

**Guenstigere Alternative:** Wenn niemand Pulse auf ARM selbst hostet → arm64 GANZ
streichen. Dann bleibt ein einziger schneller Intel-Bau ohne Emulation und ohne
Zwei-Job-Umbau (einfachste + schnellste Loesung). **Offene Frage an Owner s.u.**

## Vorschlag Hebel 2: `allinone` nur bauen, wenn noetig

Pfad-Filter analog zu `win`/`mac`/`flatpak`:

```yaml
on:
  push:
    branches: [main]
    paths:
      - 'services/**'
      - 'shared/**'
      - 'web/**'               # Frontend steckt im Image!
      - 'plugins/**'
      - 'infra/self-host/**'   # Dockerfile + Direktpfad-Adapter
      - 'pyproject.toml'
      - 'uv.lock'
      - 'pnpm-lock.yaml'
      - 'pnpm-workspace.yaml'
      - '.github/workflows/allinone.yml'
    tags: ['v*.*.*']
```

**Uebersprungen:** reine `docs/`-/`*.md`, `desktop/**`, `packaging/**`,
`infra/prod/**`, Mac/Windows-Sidecars. Weniger Starts → weniger Abbruch-Chaos.

**Stolperstein (ehrlich):** GitHub wendet `paths` auch auf Tag-Pushes an. Ein
Release-Tag auf einen reinen Doku-Commit wuerde den Release-Bau ueberspringen. In
der Praxis kaum relevant (Image existiert dann schon vom main-Push); Notausgang ist
der "Run workflow"-Handstart (baut immer).

**Optional/spaeter:** auch die 7 Service-Images in `ci` per-Pfad filtern (Frontend-
Change baut sonst alle 7 Backend-Images neu). Aufwaendiger (Matrix + Pro-Service-
Pfad), kleinerer Gewinn — erst nach den beiden Haupthebeln erwaegen.

## Nicht gewaehlt: Hebel 3 (Abbruch-Verhalten)

`cancel-in-progress: false` fuer allinone (laufenden Bau zu Ende bauen → Cache wird
warm). Vom Owner nicht als Prioritaet gewaehlt; Hebel 1+2 entschaerfen das Problem
ohnehin. Hier nur als Notiz.

---

## Offene Entscheidungen (Start morgen hier)

1. **ARM ja oder nein?** Nutzt ein Selbst-Hoster Pulse auf ARM (Raspberry-Pi-artig /
   Ampere-VPS / Apple-Silicon-Server)? Falls nein → Hebel 1 = arm64 streichen
   (einfachster Weg). Falls ja → Zwei-Job-Umbau.
2. **Umfang:** nur Hebel 2, nur Hebel 1, oder beides ausarbeiten?
3. Umsetzung auf einem **Feature-Branch** (`fix/ci-build-time`), nicht direkt main;
   Merge nach main = Prod-Deploy → nur auf ausdrueckliche Freigabe.

## Nuetzliche Fakten fuer die Umsetzung

- Billing pruefen: `gh api "/users/oblivion8282-1337/settings/billing/usage"`
  (braucht `user`-Scope: `gh auth refresh -h github.com -s user`, interaktiv).
- Laufzeiten: `gh run list --limit 80 --json workflowName,status,conclusion,createdAt,updatedAt`.
- Betroffene Dateien: `.github/workflows/allinone.yml` (Hebel 1+2),
  ggf. `.github/workflows/ci.yml` (optionaler images-Filter).
- Changelog-Gate: CI-only-Aenderungen (`.github/**`) sind NON_USER_FACING →
  brauchen KEINEN changelog.json-Eintrag.
