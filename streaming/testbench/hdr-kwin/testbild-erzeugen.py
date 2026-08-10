import numpy as np
W,H=1920,1080
def code(L):
    Yn=L/10000.0; m1,m2,c1,c2,c3=0.1593017578125,78.84375,0.8359375,18.8515625,18.6875
    yp=Yn**m1; e=((c1+c2*yp)/(1+c3*yp))**m2
    return int(round(e*876+64))          # begrenzter Bereich, 10 bit
STUFEN=[1,5,20,50,100,203,400,800]
Y=np.zeros((H,W),dtype=np.uint16); h=H//len(STUFEN)
for i,L in enumerate(STUFEN):
    Y[i*h:(i+1)*h,:]=code(L)
    print(f"  {L:5d} cd/m2 -> Code {code(L)}")
U=np.full((H//2,W//2),512,dtype=np.uint16)  # neutral
with open("/tmp/tb.yuv","wb") as f:
    f.write(Y.tobytes()); f.write(U.tobytes()); f.write(U.tobytes())
print("Balken von oben nach unten:", STUFEN)
