# Hand Frame Glitch 🖼️✋

Draw picture frames in the air with your hands and fill them with glitch-art effects — all live in the browser, no installation, no backend.

Your two hands become the diagonal corners of a rectangle. Whatever you frame gets processed in real time, and holding the frame steady **saves the picture in place** — so you can compose a whole collage of frozen effect-frames around yourself.

Inspired by the frame-capture glitch aesthetic of editing-process videos.

## How it works

1. Open the page and allow camera access.
2. Hold **both hands** up — a white rectangle stretches between them.
3. The current effect renders live inside your frame.
4. **Hold steady (~0.6s)** — flash! — the picture is saved at that exact spot.
5. Move away and draw the next frame; the next effect is loaded automatically.
6. Press **C** to clear all saved pictures.

## The effects

Each save advances to the next style, cycling through seven:

| # | Effect | Look |
|---|--------|------|
| 1 | Embossed sketch | white bas-relief line drawing |
| 2 | Green poster | 4-level green/white posterization |
| 3 | Quadtree mosaic | adaptive blocks — fine where detail is, coarse elsewhere |
| 4 | Blue polaroid | inverted blue duotone with a white border |
| 5 | Hologram | dark plate, glowing blue image with animated wavy scanlines |
| 6 | Pop-art print | Warhol-style flat color bands (yellow/pink/cyan/violet) |
| 7 | Halftone newsprint | ink dots on warm paper, dot size follows shadows |

## Tech stack

- **[MediaPipe Hands](https://developers.google.com/mediapipe)** — 21-landmark hand tracking, running client-side via WebAssembly (loaded from CDN)
- **Vanilla JavaScript** — no framework, no build step
- **HTML5 Canvas 2D** — all effects are hand-rolled pixel processing (`getImageData`): emboss convolution, posterization, a real quadtree decomposition with summed-area tables, duotone mapping, per-row sine displacement, halftone dot rendering
- **getUserMedia** — webcam input; everything stays local, nothing is uploaded

## Run it locally

Camera access requires a secure context, so serve the folder instead of opening the file directly:

```bash
# any static server works, e.g.:
python -m http.server 8081
```

Then open http://localhost:8081 in Chrome and allow the camera.

## Files

```
index.html   – page shell, loads MediaPipe from CDN
style.css    – fullscreen mirrored canvas + loading overlay
script.js    – hand tracking, frame gesture, effect processors, save logic
```
