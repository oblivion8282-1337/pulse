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
  let text = PHASE_TEXT[phase] ?? phase;
  if (phase === 'superseded' && detail && detail.reason === 'deleted') {
    text = 'Server nicht mehr registriert.';
  }
  if (phase === 'preparing' && detail && detail.step) {
    // 'update' kommt vom 24h-Update-Check des Main-Prozesses — eigener Text
    // statt eines generischen Neustarts.
    text = detail.step === 'update' ? 'Update wird installiert …' : text + ' (' + detail.step + ')';
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
  $('identRow').classList.remove('hidden');
  $('btnLogout').classList.toggle('hidden', !loggedIn);
  // "Anmelden" nur zeigen, wenn keine Session da ist (gepairter Server ohne
  // durablen Login → damit sich die Identität überhaupt etablieren lässt).
  $('btnLogin').classList.toggle('hidden', loggedIn);
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
  $('verbindungStatus').textContent = 'Prüfe … (bis zu einer Minute)';
  $('verbindungErgebnis').classList.add('hidden');
  const r = await host.verbindungstest().catch((e2) => ({ ok: false, error: e2.message }));
  verbindungLaeuft = false;
  $('btnVerbindungstest').disabled = false;
  $('verbindungStatus').classList.add('hidden');
  const box = $('verbindungErgebnis');
  box.classList.remove('hidden');
  if (!r || !r.ok) {
    box.innerHTML = '<div class="hint warn">Prüfung fehlgeschlagen: '
      + flucht((r && r.error) || 'unbekannt') + '</div>';
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
    if (!s.ok && i === erster && s.was_ist) {
      html += '<br><span class="hint">' + flucht(s.was_ist) + '</span>';
    }
    if (!s.ok && i === erster && s.was_tun) {
      html += '<span class="vtun">' + flucht(s.was_tun) + '</span>';
    }
    return html + '</span></div>';
  }).join('');
  let kopf;
  if (erster === -1) {
    kopf = '<div class="hint" style="color:#22c55e">Alles in Ordnung — alle Glieder grün.</div>';
  } else {
    kopf = '<div class="hint warn">Klemmt: ' + flucht(alles[erster].titel || alles[erster].schritt)
      + ' — alles danach hängt daran.</div>';
  }
  let fuss = '';
  if (r.cloudFehler) {
    fuss = '<div class="hint warn">Cloud-Prüfung nicht erreichbar: ' + flucht(r.cloudFehler) + '</div>';
  } else if (r.cloud && r.cloud.nicht_geprueft && r.cloud.nicht_geprueft.length) {
    fuss = '<div class="hint">Nicht geprüft: ' + flucht(r.cloud.nicht_geprueft.join(', ')) + '</div>';
  }
  box.innerHTML = kopf + zeilen + fuss;
}

async function loadDataInfo() {
  if (!host || !host.dataInfo) return;
  const info = await host.dataInfo().catch(() => null);
  const size = info ? formatBytes(info.sizeBytes) : null;
  $('dataSize').textContent = size ? 'Belegter Speicher: ' + size : 'Belegter Speicher: nicht ermittelbar.';
  // Neuestes Backup: manueller Export ODER automatischer pg_dump des
  // Backup-Services — wer jünger ist, gewinnt. Ohne die automatische Seite
  // würde die Zeile fälschlich "Noch kein Backup erstellt" zeigen, obwohl
  // täglich gesichert wird.
  const last = Math.max(info?.lastBackupAt ?? 0, info?.lastAutoBackupAt ?? 0) || null;
  const backupEl = $('dataBackup');
  backupEl.classList.remove('warn');
  if (!last) {
    backupEl.classList.add('warn');
    backupEl.textContent = 'Noch kein Backup erstellt.';
  } else {
    const dateText = new Date(last).toLocaleDateString('de-DE');
    const over30d = Date.now() - last > 30 * 24 * 60 * 60 * 1000;
    if (over30d) backupEl.classList.add('warn');
    backupEl.textContent = 'Letztes Backup: ' + dateText + (over30d ? ' — über 30 Tage her.' : '');
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
  if (!host) { $('statustext').textContent = 'Fehler: Host-Bridge nicht verfügbar.'; $('dot').className = 'dot err'; return; }
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
    $('statustext').textContent = provisionFailed ? 'Automatische Einrichtung fehlgeschlagen — Token-Fallback.' : 'Bereit zum Einrichten.';
  }
  if (!runtimeOk && !running && !superseded) {
    $('statustext').textContent = 'Kein Podman/Docker erkannt — Container-Runtime wird benötigt.';
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
    else { provisionFailed = true; alert('Einrichtung fehlgeschlagen: ' + ((r && r.error) || 'unbekannt')); }
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
    try { const r = await host.pair(t); if (r && r.error) alert('Verbinden fehlgeschlagen: ' + r.error); }
    catch (e) { alert('Verbinden fehlgeschlagen: ' + e.message); }
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
    await host.start({}).catch((e) => alert('Start fehlgeschlagen: ' + e.message));
    $('btnStart').disabled = false; refresh();
  };
  $('btnStop').onclick = async () => {
    // Stoppen dauert (docker stop -t 20) — ehrlicher Zwischenstand, sonst
    // sieht die UI bis zu 20 s "läuft" aus, und ein paralleler Start-Klick
    // rennt gegen den laufenden Stopp.
    $('btnStop').disabled = true;
    $('btnStart').disabled = true;
    $('statustext').textContent = 'Server wird gestoppt …';
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
