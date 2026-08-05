"""Traegt der P010-Weg des Sidecars wirklich mehr als 8 bit?

Die Frage ist nicht, was der Strom BEHAUPTET (yuv420p10le steht im Kopf), sondern
ob die Werte darin feiner aufgeloest sind als 8 bit. Zwei Kennzahlen aus der
Y-Ebene eines dekodierten Bildes:

* **Anzahl verschiedener Werte.** Ein aus 8 bit hochgeschobenes Bild kann nicht
  mehr als 256 haben.
* **Verteilung von (Y mod 4).** Genau das unterscheidet die beiden Faelle: ein
  hochgeschobener 8-bit-Wert ist immer durch 4 teilbar (`v << 2`), eine echt in
  10 bit gerechnete Umwandlung trifft alle vier Reste ungefaehr gleich haeufig.

Aufruf: python praezision.py <datei.raw> [breite] [hoehe]
"""
import sys
from array import array
from collections import Counter

pfad = sys.argv[1]
breite = int(sys.argv[2]) if len(sys.argv) > 2 else 1920
hoehe = int(sys.argv[3]) if len(sys.argv) > 3 else 1080

with open(pfad, "rb") as f:
    roh = f.read(breite * hoehe * 2)   # nur die Y-Ebene, 16 bit je Wert

y = array("H")
y.frombytes(roh)
if sys.byteorder != "little":
    y.byteswap()

verschieden = len(set(y))
reste = Counter(v & 3 for v in y)
gesamt = len(y)
teilbar = reste[0] / gesamt * 100

print(f"Y-Werte:            {gesamt}")
print(f"verschiedene Werte: {verschieden}   (mehr als 256 => feiner als 8 bit)")
print(f"kleinster/groesster: {min(y)} / {max(y)}")
print("Rest bei Teilung durch 4:")
for r in range(4):
    print(f"   {r}: {reste[r] / gesamt * 100:5.1f} %")
groesster_rest = max(reste[r] / gesamt for r in range(4)) * 100
if teilbar > 90:
    print("=> BEFUND: praktisch alles durch 4 teilbar - hochgeschobenes 8-bit-Bild.")
elif groesster_rest < 70:
    print("=> BEFUND: die Werte liegen ZWISCHEN den 8-bit-Stufen - echte 10-bit-Rechnung.")
else:
    print("=> BEFUND: unklar - die Reste haeufen sich, aber nicht auf der Null.")
