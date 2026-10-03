// server.js — Logik der Server-App-Oberfläche (server.html). Bewusst pures
// Browser-JS ohne Framework/Bundler; aus server.html ausgelagert, als die
// Datei über die Größen-Policy wuchs. Wird von build:electron:server + dem
// Flatpak-Manifest neben server.html kopiert.
const $ = (id) => document.getElementById(id);
const host = window.pulse && window.pulse.host;
let provisionFailed = false;

const PHASE_TEXT = {
  idle: 'Bereit.', 'checking-network': 'Netzwerk wird geprüft …', 'opening-door': 'Router wird konfiguriert …',
  preparing: 'Server wird gestartet …', 'going-live': 'Fast geschafft …', live: 'Server läuft.',
  'needs-your-help': 'Manuelle Einrichtung nötig.', 'not-possible-here': 'Hier leider nicht möglich (CGNAT).',
  'something-paused': 'Pause — bitte erneut versuchen.', 'needs-windows-setup': 'Windows braucht erst WSL2.',
  superseded: 'Auf ein anderes Gerät umgezogen.',
};
const PREP = ['checking-network', 'opening-door', 'preparing', 'going-live'];
const ERR = ['needs-your-help', 'not-possible-here', 'something-paused', 'needs-windows-setup', 'superseded'];

// ── Zweisprachigkeit: Deutsch ist der Quelltext, Englisch kommt aus der
// Tabelle (Schlüssel = der deutsche Text). Alles dynamisch Erzeugte läuft
// durch ui().
const SPRACHE = (navigator.language || 'de').toLowerCase().startsWith('de') ? 'de' : 'en';
const UI_EN = {
  'Bereit.': 'Ready.',
  'Server läuft.': 'Server is running.',
  'Server wird gestoppt …': 'Server is stopping …',
  'Server wird gestartet …': 'Server is starting …',
  'Einrichten …': 'Setting up …',
  'Bereit zum Einrichten.': 'Ready to set up.',
  'Automatische Einrichtung fehlgeschlagen — Token-Fallback.': 'Automatic setup failed — token fallback.',
  'Kein Podman/Docker erkannt — Container-Runtime wird benötigt.': 'No Podman/Docker detected — a container runtime is required.',
  'Server nicht mehr registriert.': 'Server is no longer registered.',
  'Auf ein anderes Gerät umgezogen.': 'Moved to another device.',
  'Update wird installiert …': 'Installing update …',
  'Kopiert': 'Copied',
  'Noch kein Backup erstellt.': 'No backup created yet.',
  'Letztes Backup: ': 'Last backup: ',
  'Belegter Speicher: ': 'Disk usage: ',
  'Belegter Speicher: nicht ermittelbar.': 'Disk usage: cannot be determined.',
  ' — über 30 Tage her.': ' — more than 30 days ago.',
  'Prüfe … (bis zu einer Minute)': 'Checking … (up to a minute)',
  'Alles in Ordnung — alle Glieder grün.': 'All good — every link is green.',
  'Nicht geprüft: ': 'Not checked: ',
  'Prüfung fehlgeschlagen: ': 'Check failed: ',
  'Klemmt: ': 'Blocked by: ',
  ' — alles danach hängt daran.': ' — everything after this depends on it.',
  'Cloud-Prüfung nicht erreichbar: ': 'Cloud check unreachable: ',
  'Einrichten …': 'Setting up …',
  'Einrichtung fehlgeschlagen: ': 'Setup failed: ',
  'Verbinden fehlgeschlagen: ': 'Pairing failed: ',
  'Start fehlgeschlagen: ': 'Start failed: ',
  'Export fehlgeschlagen: ': 'Export failed: ',
  'Backup gespeichert.': 'Backup saved.',
  'Backup importiert.': 'Backup imported.',
  'Zieldatei wählen …': 'Choose target file …',
  'Backup-Datei wählen …': 'Choose backup file …',
  'Prüfung fehlgeschlagen': 'Check failed',
  'Container-Runtime': 'Container runtime',
  'Docker oder Podman wurde auf diesem Gerät nicht gefunden.': 'Docker or Podman was not found on this device.',
  'Docker installieren und die Server-App neu starten.': 'Install Docker and restart the server app.',
  'Server-Container': 'Server container',
  'Der Server-Container ist gestoppt.': 'The server container is stopped.',
  'Knopf „Server starten“ oben betätigen.': 'Press the "Start server" button above.',
  'Innere Gesundheit': 'Inner health',
  'Der Container antwortet am Verwaltungsport nicht.': 'The container does not answer on its management port.',
  'Eine Minute warten. Bleibt der Schritt rot: Server stoppen und wieder starten.': 'Wait a minute. If it stays red: stop and start the server again.',
  'Automatisches Backup': 'Automatic backup',
  'Es gibt noch keinen automatischen Datenbank-Snapshot.': 'There is no automatic database snapshot yet.',
  'Nichts zu tun — der Backup-Service sichert täglich selbst; nach der Erstinstallation dauert es bis zum ersten Lauf.': 'Nothing to do — the backup service backs up daily on its own; after first setup the first run takes a while.',
  'Sprache (Signalweg)': 'Voice (signaling)',
  'Über die Relay-Adresse kommt kein Kontakt zum Sprachserver zustande.': 'No contact with the voice server via the relay address.',
  'Server läuft? Kurz warten und erneut prüfen. Bleibt es rot: Server stoppen und starten.': 'Server running? Wait a moment and check again. If it stays red: stop and start the server.',
  'Streams (Senden + Empfangen)': 'Streams (send + receive)',
  'Die Stream-Prüfung brach mit einem Fehler ab.': 'The stream check aborted with an error.',
  'Erneut prüfen. Bleibt es rot: Server stoppen und starten.': 'Check again. If it stays red: stop and start the server.',
};
const ui = (s) => {
  if (SPRACHE === 'de') return s;
  const e = UI_EN[String(s).trim()];
  return e !== undefined ? e : s;
};

function dotClass(phase) {
  if (phase === 'live') return 'dot live';
  if (PREP.includes(phase)) return 'dot prep';
  if (ERR.includes(phase)) return 'dot err';
  return 'dot';
}

function setStatus(phase, detail) {
  const klasse = dotClass(phase);
  $('dot').className = klasse;
  // Der blande graue Punkt (Leerlauf) sagt nichts aus — nur grün/gelb/rot
  // darf man sehen.
  $('dot').classList.toggle('hidden', klasse === 'dot');
  let text = ui(PHASE_TEXT[phase] ?? phase);
  if (phase === 'superseded' && detail && detail.reason === 'deleted') {
    text = ui('Server nicht mehr registriert.');
  }
  if (phase === 'preparing' && detail && detail.step) {
    // 'update' kommt vom 24h-Update-Check des Main-Prozesses — eigener Text
    // statt eines generischen Neustarts.
    text = detail.step === 'update' ? ui('Update wird installiert …') : text + ' (' + detail.step + ')';
  }
  $('statustext').textContent = text;
  // Live zeigt immer den Einladungs-Wegweiser + Cloud-Status; die kopierbare
  // Adresse nur bei Bestandsinstanzen mit Relay-Subdomain — neue App-Hosts
  // haben keine mehr (Relay-Fallback abgeschafft, Beitritt läuft über
  // Einladungslinks aus dem Pulse-Client).
  const relayUrl = (detail && detail.relayUrl) || null;
  $('addrRow').classList.toggle('hidden', phase !== 'live');
  $('addrBox').classList.toggle('hidden', !relayUrl);
  if (relayUrl) $('addrText').textContent = relayUrl;
  maybeCloudStatus(phase);
}

// Cloud-Registrierungs-Status: einmal beim Erreichen von 'live' abfragen; der
// Main-Prozess pollt danach alle 60s und pusht Updates (onCloudStatus). true =
// registriert & auffindbar (grün), false = läuft noch (neutral), null = kein
// Signal → nichts anzeigen (fail-safe).
let cloudStatusStarted = false;
function maybeCloudStatus(phase) {
  if (phase !== 'live') { cloudStatusStarted = false; $('cloudStatusText').classList.add('hidden'); return; }
  if (cloudStatusStarted || !host || !host.cloudStatus) return;
  cloudStatusStarted = true;
  host.cloudStatus().then(renderCloudStatus).catch(() => {});
}
function renderCloudStatus(r) {
  const registered = r && r.registered;
  const el = $('cloudStatusText');
  el.classList.remove('ok');
  if (registered === true) {
    el.classList.add('ok');
    el.textContent = 'Dein Server ist in der Cloud registriert und für Freunde auffindbar.';
    el.classList.remove('hidden');
  } else if (registered === false) {
    el.textContent = 'Registrierung bei der Cloud läuft …';
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden'); // null → kein Signal, nichts anzeigen
  }
}

// "Angemeldet als <Name>": der eingeloggte Cloud-User (host.me() →
// /api/auth/me über den Session-Cookie). Fehlt die Session (gepairter Server
// ohne frischen Login), bleibt die Zeile ausgeblendet. Einmal beim Laden
// aufgerufen — nach einem Logout+Neu-Login lädt server.html ohnehin frisch.
async function loadIdentity() {
  if (!host || !host.me) return;
  const me = await host.me().catch(() => null);
  const loggedIn = !!(me && me.username);
  // Kein Namensschild (2026-10-01): die Anmeldung am Anfang bestimmt die Welt.
  // Wichtig ist nur der Sitzungszustand — und der /me-Aufruf selbst, der
  // MAIN-seitig den Benutzer-Weltwechsel treibt.
  // hatTokens (MAIN: Tokens im Store, aber /me fiel durch — falsches Realm,
  // Refresh tot …): "Abmelden" statt "Anmelden" zeigen, sonst hängt der User
  // in einer Session fest, die er nicht mehr loswird.
  const hatTokens = !!(me && me.hatTokens);
  $('identRow').classList.remove('hidden');
  $('btnLogout').classList.toggle('hidden', !(loggedIn || hatTokens));
  // "Anmelden" nur zeigen, wenn keine Session da ist (gepairter Server ohne
  // durablen Login → damit sich die Identität überhaupt etablieren lässt).
  $('btnLogin').classList.toggle('hidden', loggedIn || hatTokens);
}

// "Deine Daten": Größe + letztes Backup. Die Größenermittlung startet ggf.
// einen Wegwerf-Container → nicht bei jedem Phase-Event laden; neu gemessen
// wird bei jedem Übergang in 'live' (genau dann ändert sich die Größe, und
// ein früh beim Container-Boot gemessener Wert wäre schlicht falsch) sowie
// nach Export/Import (Flag-Reset durch die beiden Funktionen).
let dataInfoLoaded = false;
let letzteGesehenePhase = null;
function formatBytes(n) {
  if (n == null) return null;
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return Math.max(1, Math.round(n / 1024)) + ' kB';
}
// HTML-Ausbruch verhindern: alle Texte der Prüfung kommen zwar aus eigener
// Cloud/eigener App, aber die Zeilen werden per innerHTML gebaut.
function flucht(text) {
  const d = document.createElement('div');
  d.textContent = String(text ?? '');
  return d.innerHTML;
}

// "Verbindungen": lokale Glieder (nur die App sieht sie) + dieselbe
// Cloud-Kette wie die Instance-Diagnose im Web. Der ERSTE Fehlschlag bekommt
// die volle Erklärung (was_ist + was_tun) — alles danach ist in aller Regel
// nur Folge und wird abgedimmt.
let verbindungLaeuft = false;
async function doVerbindungstest() {
  if (verbindungLaeuft || !host || !host.verbindungstest) return;
  verbindungLaeuft = true;
  $('btnVerbindungstest').disabled = true;
  $('verbindungStatus').classList.remove('hidden');
  $('verbindungStatus').textContent = ui('Prüfe … (bis zu einer Minute)');
  $('verbindungErgebnis').classList.add('hidden');
  const r = await host.verbindungstest().catch((e2) => ({ ok: false, error: e2.message }));
  verbindungLaeuft = false;
  $('btnVerbindungstest').disabled = false;
  $('verbindungStatus').classList.add('hidden');
  const box = $('verbindungErgebnis');
  box.classList.remove('hidden');
  if (!r || !r.ok) {
    box.innerHTML = '<div class="hint warn">' + flucht(ui('Prüfung fehlgeschlagen: ') + ((r && r.error) || 'unbekannt')) + '</div>';
    return;
  }
  const alles = [
    ...(r.lokal || []),
    ...(((r.cloud && r.cloud.schritte) || []).map((s) => ({
      schritt: s.schritt, titel: s.titel, ok: s.ok,
      was_ist: s.was_ist || '', was_tun: s.was_tun || '', einzelheit: s.einzelheit,
    }))),
  ];
  const erster = alles.findIndex((s) => !s.ok);
  const zeilen = alles.map((s, i) => {
    const klasse = s.ok ? 'vok' : (i === erster ? 'vschlimm' : 'vfolge');
    let html = '<div class="vzeile ' + klasse + '"><span class="vhaken">'
      + (s.ok ? '✓' : '✗') + '</span><span><b>' + flucht(s.titel || s.schritt) + '</b>';
    if (s.einzelheit) html += ' <span class="hint">— ' + flucht(s.einzelheit) + '</span>';
    // JEDER rote Schritt bekommt seine Begründung — die Liste mischt lokale
    // Glieder und Cloud-Kette, da sind spätere Rots oft EIGENE Ursachen und
    // keine Folgen (2026-10-01: Backup fehlt + Login abgelaufen = zwei
    // unabhängige Dinge).
    if (!s.ok && s.was_ist) {
      html += '<br><span class="hint">' + flucht(s.was_ist) + '</span>';
    }
    if (!s.ok && s.was_tun) {
      html += '<span class="vtun">' + flucht(s.was_tun) + '</span>';
    }
    return html + '</span></div>';
  }).join('');
  let kopf;
  if (erster === -1) {
    kopf = '<div class="hint" style="color:#22c55e">' + flucht(ui('Alles in Ordnung — alle Glieder grün.')) + '</div>';
  } else {
    kopf = '<div class="hint warn">' + flucht(ui('Klemmt: ') + (alles[erster].titel || alles[erster].schritt) + ui(' — alles danach hängt daran.')) + '</div>';
  }
  let fuss = '';
  if (r.cloudFehler) {
    fuss = '<div class="hint warn">' + flucht(ui('Cloud-Prüfung nicht erreichbar: ') + r.cloudFehler) + '</div>';
  } else if (r.cloud && r.cloud.nicht_geprueft && r.cloud.nicht_geprueft.length) {
    fuss = '<div class="hint">' + flucht(ui('Nicht geprüft: ') + r.cloud.nicht_geprueft.join(', ')) + '</div>';
  }
  box.innerHTML = kopf + zeilen + fuss;
}

async function loadDataInfo() {
  if (!host || !host.dataInfo) return;
  const info = await host.dataInfo().catch(() => null);
  const size = info ? formatBytes(info.sizeBytes) : null;
  $('dataSize').textContent = size ? ui('Belegter Speicher: ') + size : ui('Belegter Speicher: nicht ermittelbar.');
  // Neuestes Backup: manueller Export ODER automatischer pg_dump des
  // Backup-Services — wer jünger ist, gewinnt. Ohne die automatische Seite
  // würde die Zeile fälschlich "Noch kein Backup erstellt" zeigen, obwohl
  // täglich gesichert wird.
  const last = Math.max(info?.lastBackupAt ?? 0, info?.lastAutoBackupAt ?? 0) || null;
  const backupEl = $('dataBackup');
  backupEl.classList.remove('warn');
  if (!last) {
    backupEl.classList.add('warn');
    backupEl.textContent = ui('Noch kein Backup erstellt.');
  } else {
    const dateText = new Date(last).toLocaleDateString('de-DE');
    const over30d = Date.now() - last > 30 * 24 * 60 * 60 * 1000;
    if (over30d) backupEl.classList.add('warn');
    backupEl.textContent = ui('Letztes Backup: ') + dateText + (over30d ? ui(' — über 30 Tage her.') : '');
  }
}

const EXPORT_STEP_TEXT = {
  stopping: 'Server wird kurz gestoppt …',
  exporting: 'Daten werden exportiert …',
  importing: 'Backup wird importiert …',
  restarting: 'Server wird wieder gestartet …',
};
async function doExport() {
  if (!host || !host.exportData) return;
  $('btnExport').disabled = true;
  $('exportStatus').classList.remove('hidden');
  $('exportStatus').classList.remove('warn');
  $('exportStatus').textContent = 'Zieldatei wählen …';
  const r = await host.exportData().catch((e) => ({ ok: false, error: e.message }));
  $('btnExport').disabled = false;
  if (r && r.ok) {
    $('exportStatus').textContent = 'Backup gespeichert.';
    loadDataInfo(); // "Letztes Backup" sofort aktualisieren
  } else if (r && r.canceled) {
    $('exportStatus').classList.add('hidden');
  } else {
    $('exportStatus').classList.add('warn');
    $('exportStatus').textContent = 'Export fehlgeschlagen: ' + ((r && r.error) || 'unbekannt');
  }
}

// Import: ersetzt den Bestand durch die gewählte Backup-Datei (Overlay hat die
// Konsequenz schon bestätigt; die Dateiwahl macht der Main-Prozess-Dialog).
async function doImport() {
  if (!host || !host.importData) return;
  $('btnImport').disabled = true;
  $('exportStatus').classList.remove('hidden');
  $('exportStatus').classList.remove('warn');
  $('exportStatus').textContent = 'Backup-Datei wählen …';
  const r = await host.importData().catch((e) => ({ ok: false, error: e.message }));
  $('btnImport').disabled = false;
  if (r && r.ok) {
    $('exportStatus').textContent = 'Backup importiert.';
    dataInfoLoaded = false; // Größe hat sich geändert → neu laden
    loadDataInfo();
  } else if (r && r.canceled) {
    $('exportStatus').classList.add('hidden');
  } else {
    $('exportStatus').classList.add('warn');
    $('exportStatus').textContent = 'Import fehlgeschlagen: ' + ((r && r.error) || 'unbekannt');
  }
}

async function refresh() {
  if (!host) { $('statustext').textContent = ui('Fehler: Host-Bridge nicht verfügbar.'); $('dot').className = 'dot err'; return; }
  // Zustands-Abgleich zuerst: hebt die Phase auf 'live', falls der
  // Container (--restart unless-stopped) über einen App-Neustart hinweg
  // weiterlief — ohne das zeigt die UI fälschlich "Bereit"/"Server starten".
  await host.refresh().catch(() => {});
  const runtimeOk = await host.runtimeAvailable().catch(() => false);
  const pairing = await host.getPairing().catch(() => null);
  const paired = !!(pairing && typeof pairing === 'object' && pairing.paired);
  // getStatus() liefert immer ein Objekt (Snapshot bzw. catch-Fallback) —
  // ab hier reicht die abgeleitete `phase`, kein `st &&`-Guard mehr nötig.
  const st = await host.getStatus().catch(() => ({ phase: 'idle' }));
  const phase = st.phase || 'idle';
  // Übergang in 'live' → Daten-Info ungültig machen (Größe/Backup-Zeit sind
  // genau dann neu zu messen; s. Kommentar an dataInfoLoaded).
  if (phase === 'live' && letzteGesehenePhase !== 'live') dataInfoLoaded = false;
  letzteGesehenePhase = phase;
  setStatus(phase, st.detail);
  const running = ['preparing', 'going-live', 'live'].includes(phase);
  const superseded = phase === 'superseded';

  $('setupRow').classList.toggle('hidden', paired || running || superseded);
  $('btnStartRow').classList.toggle('hidden', !paired || running || superseded);
  $('btnStopRow').classList.toggle('hidden', phase !== 'live');
  // Token-Fallback nur, wenn automatische Provisionierung fehl schlug.
  $('pairRow').classList.toggle('hidden', paired || !provisionFailed || superseded);
  $('btnPairRow').classList.toggle('hidden', paired || !provisionFailed || superseded);
  $('supersededRow').classList.toggle('hidden', !superseded);
  if (superseded) {
    // 'deleted' (Instanz in der Cloud gelöscht) → "Neu einrichten" als
    // Primärweg; 'rotated' (Geräte-Umzug) → bisheriger Reset-Hinweis.
    const deleted = !!(st.detail && st.detail.reason === 'deleted');
    $('supersededHint').textContent = deleted
      ? 'Dieser Server ist nicht mehr registriert — die Instanz wurde in der Cloud gelöscht. Du kannst dieses Gerät neu einrichten.'
      : 'Dieser Server wurde auf ein anderes Gerät umgezogen.';
    $('btnReprovision').classList.toggle('hidden', !deleted);
    $('btnReset').classList.toggle('hidden', deleted);
  }
  $('autostartRow').classList.toggle('hidden', !paired || superseded);
  $('dataSection').classList.toggle('hidden', !paired || superseded);
  $('verbindungenSection').classList.toggle('hidden', !paired || superseded);
  // Aufgeben nur gepairt; im superseded-Zustand übernimmt der Zweitknopf
  // "Lokale Daten löschen …" in der supersededRow denselben Flow.
  $('giveUpSection').classList.toggle('hidden', !paired || superseded);

  if (paired && !superseded) {
    if (host.getAutostart) {
      host.getAutostart().then((a) => { $('autostartToggle').checked = !!(a && a.enabled); }).catch(() => {});
    }
    if (!dataInfoLoaded) { dataInfoLoaded = true; loadDataInfo(); }
  } else {
    dataInfoLoaded = false;
  }

  if (!paired && !running && phase === 'idle') {
    $('statustext').textContent = provisionFailed ? ui('Automatische Einrichtung fehlgeschlagen — Token-Fallback.') : ui('Bereit zum Einrichten.');
  }
  if (!runtimeOk && !running && !superseded) {
    $('statustext').textContent = ui('Kein Podman/Docker erkannt — Container-Runtime wird benötigt.');
    $('dot').className = 'dot err';
  }
}

function bind() {
  if (!host) return;
  host.onPhase((e) => { setStatus(e.phase, e.detail); refresh(); });
  // Cloud-Status-Updates aus dem Main-Prozess-Poll (60s bis registriert).
  if (host.onCloudStatus) host.onCloudStatus(renderCloudStatus);
  if (host.onExportStep) {
    host.onExportStep((step) => {
      $('exportStatus').classList.remove('hidden');
      $('exportStatus').textContent = EXPORT_STEP_TEXT[step] || step;
    });
  }
  // Übernahme-Warnung: meldet die Provisionierung needsTakeoverConfirm,
  // läuft für dieses Konto schon ein eingerichteter Server — Bestätigungs-
  // Dialog statt stiller Übernahme (reset entwertet dessen Zugang sofort).
  const doProvision = async (opts) => {
    $('giveupHint').classList.add('hidden'); // alter Aufgabe-Hinweis ist ab jetzt obsolet
    $('btnSetup').disabled = true; $('statustext').textContent = 'Einrichten …'; $('dot').className = 'dot prep';
    const r = await host.provision(opts);
    $('btnSetup').disabled = false;
    if (r && r.needsTakeoverConfirm) { $('takeoverOverlay').classList.remove('hidden'); }
    else if (r && r.ok) { provisionFailed = false; }
    else { provisionFailed = true; alert(ui('Einrichtung fehlgeschlagen: ') + ((r && r.error) || 'unbekannt')); }
    refresh();
  };
  $('btnSetup').onclick = () => doProvision();
  $('btnTakeover').onclick = () => {
    $('takeoverOverlay').classList.add('hidden');
    doProvision({ confirmTakeover: true });
  };
  $('btnTakeoverCancel').onclick = () => { $('takeoverOverlay').classList.add('hidden'); refresh(); };
  $('btnExport').onclick = () => doExport();
  $('btnVerbindungstest').onclick = () => { void doVerbindungstest(); };
  // Import: erst das Bestätigungs-Overlay (Bestand wird ersetzt), dann Dateiwahl.
  $('btnImport').onclick = () => $('importOverlay').classList.remove('hidden');
  $('btnImportCancel').onclick = () => $('importOverlay').classList.add('hidden');
  $('btnImportConfirm').onclick = () => {
    $('importOverlay').classList.add('hidden');
    doImport();
  };
  $('autostartToggle').onchange = async () => {
    const on = $('autostartToggle').checked;
    const r = await host.setAutostart(on).catch(() => ({ ok: false }));
    // Konnte das OS den Wunsch nicht übernehmen → Schalter ehrlich zurückdrehen.
    if (!r || !r.ok) $('autostartToggle').checked = !on;
  };
  $('btnPair').onclick = async () => {
    const t = $('token').value.trim();
    if (!t) return;
    $('btnPair').disabled = true;
    try { const r = await host.pair(t); if (r && r.error) alert(ui('Verbinden fehlgeschlagen: ') + r.error); }
    catch (e) { alert(ui('Verbinden fehlgeschlagen: ') + e.message); }
    finally { $('btnPair').disabled = false; refresh(); }
  };
  $('btnStart').onclick = async () => {
    // Bughunt Runde 8: in der Phase "needs-windows-setup" (Windows ohne
    // WSL2) verweigert host.start() nur mit derselben Phase — der dafür
    // gebaute WSL2-Assistent (pulse.host.setupWindows → installWsl, mit
    // UAC-Abfrage) war vom Server-App-UI aus unerreichbar. Jetzt führt der
    // Start-Knopf in dieser Phase zuerst den Assistenten aus.
    const statusVorher = await host.getStatus().catch(() => null);
    if (statusVorher && statusVorher.phase === 'needs-windows-setup' && host.setupWindows) {
      $('btnStart').disabled = true;
      const wsl = await host.setupWindows().catch(() => null);
      $('btnStart').disabled = false; refresh();
      if (!wsl || wsl.ok !== true) return;
    }
    $('btnStart').disabled = true;
    await host.start({}).catch((e) => alert(ui('Start fehlgeschlagen: ') + e.message));
    $('btnStart').disabled = false; refresh();
  };
  $('btnStop').onclick = async () => {
    // Stoppen dauert (docker stop -t 20) — ehrlicher Zwischenstand, sonst
    // sieht die UI bis zu 20 s "läuft" aus, und ein paralleler Start-Klick
    // rennt gegen den laufenden Stopp.
    $('btnStop').disabled = true;
    $('btnStart').disabled = true;
    $('statustext').textContent = ui('Server wird gestoppt …');
    $('dot').className = 'dot prep';
    await host.stop().catch(() => {});
    $('btnStop').disabled = false;
    $('btnStart').disabled = false;
    refresh();
  };
  // "Abmelden": Session-Cookie löschen + zurück zum Login (Main-Prozess
  // navigiert das Fenster). Danach kann sich ein anderer Account anmelden;
  // diese server.html wird dabei verlassen, daher kein Button-Reset im Erfolg.
  $('btnLogout').onclick = async () => {
    $('btnLogout').disabled = true;
    await host.logout().catch(() => { $('btnLogout').disabled = false; });
  };
  // "Anmelden" (gepairter Server ohne Session): navigiert zum Login; server.html
  // wird verlassen, danach lädt sie mit etablierter Identität neu.
  $('btnLogin').onclick = async () => {
    $('btnLogin').disabled = true;
    await host.login().catch(() => { $('btnLogin').disabled = false; });
  };
  // "Server aufgeben": gemeinsames Overlay für den Danger-Knopf (Checkbox
  // default AUS) und den superseded-Zweitknopf (Datenlöschung ist dort der
  // Zweck → Checkbox vorbelegt AN; Cloud-Delete überspringt der Main-Prozess
  // im superseded-Zustand selbst).
  const openGiveUp = (dataChecked) => {
    $('giveupData').checked = dataChecked;
    $('giveupOverlay').classList.remove('hidden');
  };
  $('btnGiveUp').onclick = () => openGiveUp(false);
  $('btnWipeLocal').onclick = () => openGiveUp(true);
  $('btnGiveUpCancel').onclick = () => $('giveupOverlay').classList.add('hidden');
  $('btnGiveUpConfirm').onclick = async () => {
    $('btnGiveUpConfirm').disabled = true;
    $('statustext').textContent = 'Server wird aufgegeben …'; $('dot').className = 'dot prep';
    const r = await host.giveUp({ deleteData: $('giveupData').checked }).catch(() => null);
    $('btnGiveUpConfirm').disabled = false;
    $('giveupOverlay').classList.add('hidden');
    provisionFailed = false;
    await refresh();
    $('statustext').textContent = 'Server aufgegeben.';
    // Liegengebliebene Cloud-Löschung ehrlich melden (Client-Weg als Ausweg).
    const cloudFailed = r && r.cloudDeleted === false;
    $('giveupHint').classList.toggle('hidden', !cloudFailed);
    if (cloudFailed) {
      $('giveupHint').textContent =
        'Die Registrierung in der Cloud konnte nicht gelöscht werden — melde dich im Pulse-Client an und lösche den Server unter Einstellungen → Self-Host → Meine Instanzen.';
    }
    if (r && r.dataDeleted === false) alert('Die lokalen Serverdaten konnten nicht gelöscht werden (Volume pulse-host-data).');
  };
  $('btnReset').onclick = async () => {
    $('btnReset').disabled = true;
    await host.unpair().catch(() => {});
    $('btnReset').disabled = false;
    provisionFailed = false;
    refresh();
  };
  // "Neu einrichten" (gelöschte Instanz): totes Pairing lösen und direkt in
  // den normalen Einricht-Flow (inkl. Übernahme-Warnung) — statt den User
  // über "Server aufgeben" zu schicken, das nach Löschen klingt.
  $('btnReprovision').onclick = async () => {
    $('btnReprovision').disabled = true;
    await host.unpair().catch(() => {});
    $('btnReprovision').disabled = false;
    provisionFailed = false;
    await doProvision();
  };
  // Kurze Sicht-Rückmeldung: ohne sie ist nicht erkennbar, ob der Klick ankam.
  let copyTimer = null;
  $('addr').onclick = async () => {
    try {
      await navigator.clipboard.writeText($('addrText').textContent);
      $('addrIcon').classList.add('hidden');
      $('addrDone').classList.remove('hidden');
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        $('addrDone').classList.add('hidden');
        $('addrIcon').classList.remove('hidden');
      }, 1400);
    } catch { /* Clipboard verweigert → Adresse bleibt markierbar */ }
  };
}

bind();
refresh();
loadIdentity();


// ── Statische Markup-Texte auf Englisch (Zweisprachigkeit 2026-10-01):
// Deutsch steht im Markup; bei nicht-deutscher Browsersprache werden die
// Textknoten aus dieser Tabelle ersetzt. Läuft einmalig nach dem DOM-Aufbau —
// als externe Datei, weil die CSP Inline-Scripts verbietet.
if (SPRACHE !== 'de') {
  const STATISCH_EN = {
    'Selbst-gehosteter Pulse-Server auf diesem Gerät.': 'Your self-hosted Pulse server on this device.',
    'Initialisiere …': 'Initializing …',
    'Server einrichten': 'Set up server',
    'Du bist eingeloggt. Die Einrichtung findet deine freigegebene Instanz und verbindet dieses Gerät automatisch.': 'You are signed in. Setup will find your provisioned instance and connect this device automatically.',
    'Bootstrap-Token (Fallback)': 'Bootstrap token (fallback)',
    'Automatische Einrichtung fehlgeschlagen — minte das Token manuell in deinem Konto und füge es ein.': 'Automatic setup failed — mint the token manually in your account and paste it here.',
    'Gerät verbinden': 'Connect device',
    'Server starten': 'Start server',
    'Server stoppen': 'Stop server',
    'Dieser Server wurde auf ein anderes Gerät umgezogen.': 'This server was moved to another device.',
    'Neu einrichten': 'Set up again',
    'Verstanden — Gerät zurücksetzen': 'Understood — reset this device',
    'Lokale Daten löschen …': 'Delete local data …',
    'Server-Adresse (zum Teilen)': 'Server address (to share)',
    'Kopiert': 'Copied',
    'Beim Anmelden automatisch starten': 'Start automatically on sign-in',
    'Dauerbetrieb einrichten': 'Set up always-on operation',
    'Den Schalter oben aktivieren — die Server-App startet dann mit deiner Anmeldung.': 'Turn on the switch above — the server app will then start with your sign-in.',
    'Automatische Anmeldung deines Benutzerkontos in den Systemeinstellungen aktivieren, damit das Gerät ohne Zutun hochkommt.': 'Enable automatic sign-in of your user account in the system settings, so the device starts up without any input.',
    'Im BIOS/UEFI (bzw. bei Macs in den Energieeinstellungen) „Nach Stromausfall automatisch einschalten“ aktivieren.': 'In the BIOS/UEFI (on Macs: energy settings), enable "Start up automatically after a power failure".',
    'Deine Daten': 'Your data',
    'Alle Nachrichten und Dateien deines Servers liegen auf diesem Gerät — nichts davon in der Cloud.': 'All messages and files of your server live on this device — none of it in the cloud.',
    'Alles exportieren': 'Export everything',
    'Backup importieren …': 'Import backup …',
    'Verbindungen': 'Connections',
    'Verbindung prüfen': 'Check connection',
    'Abmelden': 'Sign out',
    'Anmelden': 'Sign in',
    'Server aufgeben …': 'Shut down server …',
    'Server übernehmen?': 'Take over server?',
    'Für dieses Konto läuft bereits ein eingerichteter Server. Übernehmen? Der bisherige Server verliert dauerhaft den Zugang.': 'A set up server is already running for this account. Take over? The previous server permanently loses access.',
    'Übernehmen': 'Take over',
    'Abbrechen': 'Cancel',
    'Backup importieren?': 'Import backup?',
    'Ersetzt alle aktuellen Serverdaten auf diesem Gerät durch den Inhalt der Backup-Datei (Nachrichten, Dateien — unwiderruflich). Der Server wird dafür kurz gestoppt.': 'Replaces all current server data on this device with the contents of the backup file (messages, files — irreversible). The server will be stopped briefly for this.',
    'Backup-Datei wählen und importieren': 'Choose backup file and import',
    'Server aufgeben?': 'Shut down server?',
    'Dein Server wird dauerhaft gelöscht. Mitglieder verlieren den Zugang und der Server verschwindet aus ihren Listen.': 'Your server will be permanently deleted. Members lose access and the server disappears from their lists.',
    'Auch die lokalen Serverdaten auf diesem Gerät löschen (Nachrichten, Dateien — unwiderruflich)': 'Also delete the local server data on this device (messages, files — irreversible)',
    'Server dauerhaft aufgeben': 'Shut down server permanently',
  };
  const wanderer = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const knoten = [];
  while (wanderer.nextNode()) knoten.push(wanderer.currentNode);
  for (const k of knoten) {
    const t = k.textContent.replace(/\s+/g, ' ').trim();
    const en = STATISCH_EN[t];
    if (en) k.textContent = k.textContent.replace(t, en);
  }
}
