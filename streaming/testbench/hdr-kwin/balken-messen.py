import sys, numpy as np
W,H=2560,1440
Y=np.fromfile(sys.argv[1],dtype=np.uint16)[:W*H].reshape(H,W).astype(np.float64)
def nits(c):
    e=np.clip((c-64.0)/876.0,0,1); m1,m2,c1,c2,c3=0.1593017578125,78.84375,0.8359375,18.8515625,18.6875
    x=np.power(e,1.0/m2); return 10000.0*np.power(np.maximum(x-c1,0)/(c2-c3*x),1.0/m1)
SOLL=[1,5,20,50,100,203,400,800]
# Das Testbild ist die einzige Flaeche im Bild mit 8 breiten, waagerechten,
# in sich homogenen Streifen. Gesucht wird die Spalte, an der genau das steht.
beste=None
for xc in range(300, 2300, 40):
    sp=np.median(Y[:, xc-60:xc+60], axis=1)
    var=Y[:, xc-60:xc+60].std(axis=1)
    ruhig=var<4                       # Zeile in sich homogen
    # Plateaus zusammenfassen
    plat=[]; i=0
    while i<H:
        if not ruhig[i]: i+=1; continue
        j=i
        while j+1<H and ruhig[j+1] and abs(sp[j+1]-sp[i])<6: j+=1
        if j-i>=35: plat.append((i,j,float(np.median(sp[i:j+1]))))
        i=j+1
    # aufsteigende Folge von 8 Plateaus suchen
    for s in range(len(plat)-7):
        f=plat[s:s+8]
        if all(f[k][2] < f[k+1][2]-8 for k in range(7)):
            spanne=f[-1][2]-f[0][2]
            if beste is None or spanne>beste[0]: beste=(spanne,xc,f)
if not beste:
    print("Testbild nicht gefunden"); sys.exit(1)
_,xc,f=beste
print(f"Testbild gefunden bei Spalte x={xc}, Balken y={f[0][0]}..{f[-1][1]}\n")
print(f"{'Soll cd/m2':>11}{'Soll Code':>11} | {'Ist Code':>10}{'Ist cd/m2':>11} | {'Faktor':>8}")
print("-"*58)
def code(L):
    Yn=L/10000.0; m1,m2,c1,c2,c3=0.1593017578125,78.84375,0.8359375,18.8515625,18.6875
    yp=Yn**m1; return ((c1+c2*yp)/(1+c3*yp))**m2*876+64
for L,(y0,y1,c) in zip(SOLL,f):
    print(f"{L:>11}{code(L):>11.0f} | {c:>10.0f}{nits(c):>11.1f} | {nits(c)/L:>7.2f}x")
