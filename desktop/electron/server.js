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
  $('dot').className = dotClass(phase);
  let text = PHASE_TEXT[phase] ?? phase;
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

// "Deine Daten": Größe + letztes Backup. Die Größenermittlung startet ggf.
// einen Wegwerf-Container → nur einmal pro Pairing laden (dataInfoLoaded),
// nicht bei jedem Phase-Event; Export/Reset setzen das Flag zurück.
let dataInfoLoaded = false;
function formatBytes(n) {
  if (n == null) return null;
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return Math.max(1, Math.round(n / 1024)) + ' kB';
}
async function loadDataInfo() {
  if (!host || !host.dataInfo) return;
  const info = await host.dataInfo().catch(() => null);
  const size = info ? formatBytes(info.sizeBytes) : null;
  $('dataSize').textContent = size ? 'Belegter Speicher: ' + size : 'Belegter Speicher: nicht ermittelbar.';
  const last = info && info.lastBackupAt;
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
  stopping: 'Server wird für den Export gestoppt …',
  exporting: 'Daten werden exportiert …',
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
  $('autostartRow').classList.toggle('hidden', !paired || superseded);
  $('dataSection').classList.toggle('hidden', !paired || superseded);
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
    $('btnStart').disabled = true;
    await host.start({}).catch((e) => alert('Start fehlgeschlagen: ' + e.message));
    $('btnStart').disabled = false; refresh();
  };
  $('btnStop').onclick = async () => { await host.stop().catch(() => {}); refresh(); };
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
