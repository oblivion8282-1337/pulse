// @ts-nocheck — Diese Datei läuft ausschließlich als AudioWorklet-Modul
// (geladen per `?url`): AudioWorkletProcessor & sampleRate existieren nur im
// Worklet-Scope, nicht im lib-TS-Kontext. Typen hier wären belastend ohne
// Nutzen; die Nutzung in noiseFilter.ts ist vollständig getippt.
/**
 * GTCRN-Ferry-Worklet — trägt Audioblöcke zwischen dem Live-Graph (48 kHz,
 * RT-Thread) und der Main-Thread-Inference (sherpa-onnx OnlineSpeechDenoiser,
 * 16 kHz) hin und her.
 *
 * Warum Main-Thread: Das sherpa-onnx-Emscripten-Glue ist ein klassisches
 * Skript (globales `Module`, script-Tag) und lässt sich nicht als Modul in
 * einen AudioWorklet-Import laden. Die DFN3-Lehre (2026-05-16) war, Inference
 * IM Realtime-Thread endet in Underruns (=Wortanschnitt) — deshalb läuft das
 * Modell hier außerhalb und dieses Worklet puffert:
 *
 *   Eingang  → 1024er-Blöcke (≈21 ms @48 kHz) → postMessage 'in'
 *   Ausgang  ← postMessage 'out' (48 kHz)      → Ringpuffer → 128er-Quanten
 *
 * Der Ringpuffer prittelt erst, wenn TARGET_SAMPLES erreicht sind
 * (Anlauf-Latenz ~96 ms), danach fließt er kontinuierlich. Main-Thread-Jank
 * frisst Puffer, bis er leer läuft — dann Stille (Underrun-Zähler), nie
 * blockiert das Audio-Rendering.
 */

const IN_BLOCK = 1024;
/** Anlauf: so viele Samples müssen im Ring liegen, bevor die Wiedergabe
 *  beginnt. 4608 @48 kHz ≈ 96 ms — großzügig gegen ersten Main-Thread-Ruckel. */
const TARGET_SAMPLES = 4608;
/** Hartes Limit des Ringpuffers (≈342 ms). Überlauf verwirft das Älteste. */
const RING_MAX = 16384;

class GtcrnFerryProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inBuf = new Float32Array(IN_BLOCK);
    this.inFill = 0;
    this.ring = new Float32Array(RING_MAX);
    this.ringRead = 0;
    this.ringWrite = 0;
    this.primed = false;
    this.underruns = 0;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'out' && e.data.samples instanceof Float32Array) {
        this.#enqueue(e.data.samples);
      }
    };
    this.port.postMessage({ type: 'ready' });
  }

  #ringCount() {
    return this.ringWrite - this.ringRead;
  }

  #enqueue(samples) {
    for (let i = 0; i < samples.length; i++) {
      if (this.ringWrite - this.ringRead >= RING_MAX) this.ringRead++;
      this.ring[this.ringWrite % RING_MAX] = samples[i];
      this.ringWrite++;
    }
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    if (!output) return true;

    if (input) {
      for (let i = 0; i < input.length; i++) {
        this.inBuf[this.inFill++] = input[i];
        if (this.inFill === IN_BLOCK) {
          const block = this.inBuf.slice();
          this.port.postMessage({ type: 'in', samples: block }, [block.buffer]);
          this.inFill = 0;
        }
      }
    }

    if (!this.primed) {
      if (this.#ringCount() >= TARGET_SAMPLES) this.primed = true;
      output.fill(0);
      return true;
    }

    let starved = false;
    for (let i = 0; i < output.length; i++) {
      if (this.ringRead < this.ringWrite) {
        output[i] = this.ring[this.ringRead % RING_MAX];
        this.ringRead++;
      } else {
        output[i] = 0;
        starved = true;
      }
    }
    if (starved) this.underruns++;
    return true;
  }
}

registerProcessor('gtcrn-ferry', GtcrnFerryProcessor);
