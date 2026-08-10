#!/usr/bin/env python3
"""Die Uebertragungskennlinie der ganzen Kette, aus einem einzigen Scanout.

Der Scanout enthaelt das Original UND das Player-Fenster, das denselben Schirm
verkleinert zeigt. Aus korrespondierenden Bildpunkten laesst sich ablesen, was
die Kette mit einem Codewert macht -- bei einer farbtreuen Kette die Identitaet.

**Die Zuordnung wird nicht geglaubt, sondern gesucht.** Ein Versatz von wenigen
Bildpunkten wuerde die Kennlinie verfaelschen; deshalb wird die Fenstergeometrie
ueber die hoechste Korrelation bestimmt und ihr Wert mit ausgegeben.
"""
import sys
import numpy as np

W, H = 2560, 1440
Y = np.fromfile(sys.argv[1], dtype=np.uint16)[: W * H].reshape(H, W).astype(np.float64)

# Statischer Teil des Schirms: oberhalb der Fenster liegt nur Hintergrund, der
# sich zwischen Aufnahme und Anzeige nicht aendert (das Video im Browser schon).
OY0, OY1, OX0, OX1 = 20, 205, 40, 2500


def probieren(px, py, ps):
    """Korrelation zwischen Original und Player fuer eine Geometrie."""
    ys, xs = np.mgrid[OY0:OY1:4, OX0:OX1:8]
    o = Y[ys, xs]
    tx = (px + ps * xs).astype(int)
    ty = (py + ps * ys).astype(int)
    if tx.max() >= W or ty.max() >= H or tx.min() < 0 or ty.min() < 0:
        return -1, None, None
    p = Y[ty, tx]
    gut = o > 70  # reines Schwarz traegt nichts zur Zuordnung bei
    if gut.sum() < 200:
        return -1, None, None
    return np.corrcoef(o[gut], p[gut])[0, 1], o[gut], p[gut]


bestes = (-1, None)
for ps in np.arange(0.480, 0.510, 0.002):
    for px in range(1180, 1230, 2):
        for py in range(285, 320, 2):
            k, _, _ = probieren(px, py, ps)
            if k > bestes[0]:
                bestes = (k, (px, py, ps))
k, (px, py, ps) = bestes
print(f"Zuordnung gefunden: Ursprung ({px}, {py}), Massstab {ps:.3f}, Korrelation {k:.4f}")
if k < 0.9:
    print("  ACHTUNG: schwache Korrelation -- die Kennlinie unten ist nicht belastbar.")

_, o, p = probieren(px, py, ps)
print(f"Bildpunktpaare: {len(o)}\n")


def nits(c):
    e = np.clip((c - 64.0) / 876.0, 0.0, 1.0)
    m1, m2, c1, c2, c3 = 0.1593017578125, 78.84375, 0.8359375, 18.8515625, 18.6875
    x = np.power(e, 1.0 / m2)
    return 10000.0 * np.power(np.maximum(x - c1, 0.0) / (c2 - c3 * x), 1.0 / m1)


print(f"{'Original':>18} | {'Player':>18} | {'Verhaeltnis'}")
print(f"{'Code':>8}{'cd/m2':>10} | {'Code':>8}{'cd/m2':>10} |")
print("-" * 58)
kanten = [70, 100, 130, 160, 200, 250, 300, 400, 500, 600, 700, 940]
for lo, hi in zip(kanten, kanten[1:]):
    m = (o >= lo) & (o < hi)
    if m.sum() < 20:
        continue
    oc, pc = o[m].mean(), p[m].mean()
    on, pn = nits(oc), nits(pc)
    v = f"{pn / on:.2f}x" if on > 0.2 else "-"
    print(f"{oc:>8.0f}{on:>10.2f} | {pc:>8.0f}{pn:>10.2f} | {v:>10}")
