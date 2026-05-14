# Upstream MediaMTX issue draft

Copy-paste-ready issue + reproduction for filing against `bluenviron/mediamtx`.
Verified on MediaMTX **1.17.1** (still the latest as of 2026-05-14 if you're
pinned because of issue #5728).

---

## Title

AV1 over WHEP fails for AMD-VAAPI (mesa) publishers — bitstream lacks Temporal Delimiters + emits large Padding OBUs

## Body

### Summary

Streams encoded by Mesa's `av1_vaapi` (AMD GPUs) decode reliably as files but
freeze in Chromium-based WHEP receivers within a few seconds — first GOP looks
fine, then the reference chain breaks and the picture stalls while RTP packets
keep arriving. Streams encoded by `av1_nvenc` (NVIDIA) over the same pipeline
work flawlessly.

The Chromium-side `RTCInboundRtpStreamStats` for the AMD case shows the symptom
cleanly:

```
framesReceived:   730   ← RTP keeps flowing
framesDecoded:    145   ← 80 % failure
keyFramesDecoded:   7
framesDropped:     21
pliCount:          53
decoderImplementation: "dav1d (fallback from: ExternalDecoder (VaapiVideoDecoder))"
```

### Repro

Push an AV1-FLV from AMD hardware via Enhanced-RTMP, consume via WHEP from
Chromium / Electron. Or — without AMD hardware — take any FLV captured from
`av1_vaapi` on a Linux box with Mesa ≥ 23 and `gpu-screen-recorder`'s `-k av1
-c flv` settings. The freeze is encoder-shape-dependent, not content-dependent.

Two small attached samples illustrate the structural difference (FLV/AV1+Opus,
~10 s, 1080p):

- `amd-vaapi-av1.flv` (Mesa `av1_vaapi`) — freezes in WHEP
- `nvenc-av1.flv` (NVIDIA `av1_nvenc`) — works in WHEP

### Root cause — two AV1 OBU-shape asymmetries

Type counts from `ffmpeg -bsf:v trace_headers` on each file:

| OBU type | AMD-VAAPI | NVENC |
|---|---|---|
| 1 — Sequence Header | 6 | 4 |
| **2 — Temporal Delimiter** | **0** | **331** |
| 3 — Frame | 504 | 331 |
| 4 — Redundant Frame Header | 504 | 331 |
| **15 — Padding** | **29 (1232–8230 bytes each)** | **0** |

1. **No `OBU_TEMPORAL_DELIMITER`.** Spec-permitted in low-overhead bitstream
   form (AV1 5.6), but libwebrtc-side AV1 RTP receivers tend to lean on them
   for frame-boundary detection. NVENC emits one per frame; Mesa's
   `av1_vaapi` emits none.
2. **Large `OBU_PADDING`.** Mesa pads the bitstream to meet CBR bitrate on
   low-motion content with multi-KB padding OBUs (we saw 1.2–8.2 KB each).
   Per spec they're no-ops, but in practice an 8 KB padding OBU fragmented
   across ~6 RTP packets seems to break libwebrtc's reassembly — the
   "first ~20 frames after each keyframe decode, then break until the next
   keyframe" symptom matches a per-GOP reassembly breakdown.

### Workaround / suggested fix

Normalising the temporal unit in `internal/protocols/rtmp/to_stream.go`'s
`OnDataAV1` callback fixes both at once and matches NVENC's input shape:

```go
r.OnDataAV1(track, func(pts time.Duration, tu [][]byte) {
    // Prepend OBU_TEMPORAL_DELIMITER if missing; strip OBU_PADDING.
    needTD := len(tu) == 0 || len(tu[0]) == 0 || (tu[0][0]>>3)&0xF != 2
    hasPadding := false
    for _, obu := range tu {
        if len(obu) > 0 && (obu[0]>>3)&0xF == 15 {
            hasPadding = true
            break
        }
    }
    if needTD || hasPadding {
        out := make([][]byte, 0, len(tu)+1)
        if needTD {
            out = append(out, []byte{0x10}) // TempDelim, has_size=0 per mediacommon convention
        }
        for _, obu := range tu {
            if len(obu) == 0 || (obu[0]>>3)&0xF != 15 {
                out = append(out, obu)
            }
        }
        tu = out
    }
    (*subStream).WriteUnit(medi, forma, &unit.Unit{ /* ... */ })
})
```

Verified locally on a forked 1.17.1 image — AMD-VAAPI HQ streams that froze
within 5 s now decode cleanly for arbitrary durations, with the same receiver
stats no longer showing the dav1d-fallback or PLI flood.

Equivalent to running `ffmpeg -bsf:v "av1_metadata=td=insert:delete_padding=1"`
on the bitstream before muxing.

Happy to send a PR if the patch looks reasonable. Putting it inside `OnDataAV1`
keeps the fix scoped to the RTMP-ingest path; an arguably nicer home would be
the AV1 packetizer in `gortsplib/pkg/format/rtpav1` or even Pion's level, but
that depends on what the project considers "publisher input that should be
normalised" vs "packetizer responsibility to be tolerant".

### Notes

- `gpu-screen-recorder` (the publisher) uses Enhanced-RTMP with
  `AV_CODEC_FLAG_GLOBAL_HEADER`, so the AV1 sequence header is in the FLV
  config message rather than inline at each IDR. Both encoders treat that
  the same way, so it's not the differentiator.
- The receiver was Chromium 148 / Electron 42, but the same behaviour
  reproduces in stock Chromium and Firefox.
- Sample FLVs available on request — they're screen recordings so we'd rather
  share them via a non-public channel.
