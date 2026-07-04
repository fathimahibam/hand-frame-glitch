// Frame Pictures — draw frames with your hands, fill them with effects, save them.
//
// Flow:
//   1. Hold up both hands — they are the diagonal corners of a rectangle.
//   2. The current effect renders live inside your rectangle.
//   3. Hold the rectangle steady for ~1s — snap! — the picture is saved in place.
//   4. Move away and draw the next rectangle: the next effect is loaded.
//   Press C to clear all saved pictures.
//
// Effect order (from the wxll.hx video):
//   white embossed sketch -> green posterized -> quadtree mosaic
//   -> blue duotone polaroid -> blue wavy hologram.

const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const loadingEl = document.getElementById("loading");

const grabCanvas = document.createElement("canvas");
const grabCtx = grabCanvas.getContext("2d", { willReadFrequently: true });
const previewCanvas = document.createElement("canvas"); // shared buffer for live preview

const PROCESS_MAX = 480;   // max processing dimension
const SMOOTH = 0.35;       // box smoothing
const STEADY_MS = 600;     // steady hold duration required to save
const FORCE_SAVE_MS = 1800;// frame open this long always saves, steady or not
const REARM_DIST = 110;    // how far you must move before the next save can happen
const MAX_STAMPS = 14;

let stamps = [];           // saved pictures: {type, src, box}
let styleIndex = 0;
let smoothBox = null;
let steadyMs = 0;
let openMs = 0;            // how long the frame has been held open
let jitter = 0;            // smoothed per-frame movement
let lastFrameAt = 0;
let armed = true;
let lastSaveCenter = null;
let flashAt = -1;
let flashBox = null;
let ready = false;

// ---------------------------------------------------------------- helpers --

function luminance(d, i) {
  return d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
}

function palmCenter(landmarks) {
  const ids = [0, 5, 9, 13, 17];
  let x = 0, y = 0;
  for (const i of ids) {
    x += landmarks[i].x;
    y += landmarks[i].y;
  }
  return { x: (x / ids.length) * canvas.width, y: (y / ids.length) * canvas.height };
}

function boxFromHands(h1, h2) {
  const p1 = palmCenter(h1);
  const p2 = palmCenter(h2);
  let x = Math.min(p1.x, p2.x);
  let y = Math.min(p1.y, p2.y);
  let w = Math.abs(p2.x - p1.x);
  let h = Math.abs(p2.y - p1.y);
  x = Math.max(0, x);
  y = Math.max(0, y);
  w = Math.min(canvas.width - x, w);
  h = Math.min(canvas.height - y, h);
  return { x, y, w, h };
}

function smoothTo(target) {
  if (!smoothBox) {
    smoothBox = { ...target };
    return { moved: 0, box: smoothBox };
  }
  const moved =
    Math.abs(target.x - smoothBox.x) + Math.abs(target.y - smoothBox.y) +
    Math.abs(target.w - smoothBox.w) + Math.abs(target.h - smoothBox.h);
  smoothBox.x += (target.x - smoothBox.x) * SMOOTH;
  smoothBox.y += (target.y - smoothBox.y) * SMOOTH;
  smoothBox.w += (target.w - smoothBox.w) * SMOOTH;
  smoothBox.h += (target.h - smoothBox.h) * SMOOTH;
  return { moved, box: smoothBox };
}

function captureRegion(box) {
  const scale = Math.min(1, PROCESS_MAX / Math.max(box.w, box.h));
  const w = Math.max(2, Math.round(box.w * scale));
  const h = Math.max(2, Math.round(box.h * scale));
  grabCanvas.width = w;
  grabCanvas.height = h;
  grabCtx.drawImage(video, box.x, box.y, box.w, box.h, 0, 0, w, h);
  return grabCtx.getImageData(0, 0, w, h);
}

// ------------------------------------------------------------- processing --
// Each processor renders the effect's pixels into `target` and returns it.

function processEmboss(box, target) {
  const img = captureRegion(box);
  const { width: w, height: h, data: d } = img;
  const out = grabCtx.createImageData(w, h);
  const o = out.data;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      const a = luminance(d, ((y - 1) * w + (x - 1)) * 4);
      const b = luminance(d, ((y + 1) * w + (x + 1)) * 4);
      const v = Math.max(0, Math.min(255, 225 + (b - a) * 0.9));
      o[i] = o[i + 1] = o[i + 2] = v;
      o[i + 3] = 255;
    }
  }
  target.width = w;
  target.height = h;
  target.getContext("2d").putImageData(out, 0, 0);
  return target;
}

function processPoster(box, target) {
  const img = captureRegion(box);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const l = luminance(d, i);
    let rgb;
    if (l > 185) rgb = [246, 250, 242];
    else if (l > 125) rgb = [190, 226, 174];
    else if (l > 70) rgb = [42, 156, 62];
    else rgb = [10, 82, 28];
    d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2];
  }
  target.width = img.width;
  target.height = img.height;
  target.getContext("2d").putImageData(img, 0, 0);
  return target;
}

function processQuadtree(box, target) {
  const img = captureRegion(box);
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  const gray = new Float64Array(n);
  for (let i = 0; i < n; i++) gray[i] = luminance(d, i * 4);
  const W = w + 1;
  const sat = new Float64Array(W * (h + 1));
  const sat2 = new Float64Array(W * (h + 1));
  for (let y = 1; y <= h; y++) {
    let row = 0, row2 = 0;
    for (let x = 1; x <= w; x++) {
      const g = gray[(y - 1) * w + (x - 1)];
      row += g; row2 += g * g;
      sat[y * W + x] = sat[(y - 1) * W + x] + row;
      sat2[y * W + x] = sat2[(y - 1) * W + x] + row2;
    }
  }
  const stat = (x, y, bw, bh) => {
    const x2 = x + bw, y2 = y + bh;
    const s = sat[y2 * W + x2] - sat[y * W + x2] - sat[y2 * W + x] + sat[y * W + x];
    const s2 = sat2[y2 * W + x2] - sat2[y * W + x2] - sat2[y2 * W + x] + sat2[y * W + x];
    const cnt = bw * bh;
    const mean = s / cnt;
    return { mean, variance: s2 / cnt - mean * mean };
  };

  target.width = w;
  target.height = h;
  const qctx = target.getContext("2d");
  (function subdivide(x, y, bw, bh, depth) {
    const { mean, variance } = stat(x, y, bw, bh);
    if (depth >= 7 || bw <= 7 || bh <= 7 || variance < 260) {
      qctx.fillStyle = `rgb(${mean | 0}, ${(mean * 0.97) | 0}, ${(mean * 0.92) | 0})`;
      qctx.fillRect(x, y, bw, bh);
      qctx.strokeStyle = "rgba(0,0,0,0.8)";
      qctx.lineWidth = 1;
      qctx.strokeRect(x + 0.5, y + 0.5, bw, bh);
      return;
    }
    const hw = Math.floor(bw / 2), hh = Math.floor(bh / 2);
    subdivide(x, y, hw, hh, depth + 1);
    subdivide(x + hw, y, bw - hw, hh, depth + 1);
    subdivide(x, y + hh, hw, bh - hh, depth + 1);
    subdivide(x + hw, y + hh, bw - hw, bh - hh, depth + 1);
  })(0, 0, w, h, 0);
  return target;
}

function processPolaroid(box, target) {
  const img = captureRegion(box);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const t = luminance(d, i) / 255;
    d[i]     = 30  + t * (244 - 30);
    d[i + 1] = 73  + t * (248 - 73);
    d[i + 2] = 200 + t * (255 - 200);
  }
  target.width = img.width;
  target.height = img.height;
  target.getContext("2d").putImageData(img, 0, 0);
  return target;
}

function processWave(box, target) {
  const img = captureRegion(box);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let t = luminance(d, i) / 255;
    t = Math.pow(t, 1.35);
    d[i]     = 2  + t * 150;
    d[i + 1] = 8  + t * 215;
    d[i + 2] = 18 + t * 235;
  }
  target.width = img.width;
  target.height = img.height;
  target.getContext("2d").putImageData(img, 0, 0);
  return target;
}

function processPopArt(box, target) {
  const img = captureRegion(box);
  const d = img.data;
  // Warhol-style flat color bands
  for (let i = 0; i < d.length; i += 4) {
    const l = luminance(d, i);
    let rgb;
    if (l > 190) rgb = [255, 241, 118];      // bright -> lemon yellow
    else if (l > 130) rgb = [255, 64, 129];  // light mid -> hot pink
    else if (l > 75) rgb = [0, 188, 212];    // dark mid -> cyan
    else rgb = [49, 27, 146];                // shadows -> deep violet
    d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2];
  }
  target.width = img.width;
  target.height = img.height;
  target.getContext("2d").putImageData(img, 0, 0);
  return target;
}

function processHalftone(box, target) {
  const img = captureRegion(box);
  const { width: w, height: h, data: d } = img;
  target.width = w;
  target.height = h;
  const hctx = target.getContext("2d");

  hctx.fillStyle = "#f4f0e4"; // warm newsprint paper
  hctx.fillRect(0, 0, w, h);

  const cell = Math.max(5, Math.round(w / 64));
  const maxR = cell * 0.62;
  hctx.fillStyle = "#17172b";
  for (let cy = 0; cy < h; cy += cell) {
    for (let cx = 0; cx < w; cx += cell) {
      // average luminance of the cell
      let sum = 0, cnt = 0;
      const yEnd = Math.min(h, cy + cell), xEnd = Math.min(w, cx + cell);
      for (let y = cy; y < yEnd; y += 2) {
        for (let x = cx; x < xEnd; x += 2) {
          sum += luminance(d, (y * w + x) * 4);
          cnt++;
        }
      }
      const r = (1 - sum / cnt / 255) * maxR;
      if (r < 0.4) continue;
      hctx.beginPath();
      hctx.arc(cx + cell / 2, cy + cell / 2, r, 0, Math.PI * 2);
      hctx.fill();
    }
  }
  return target;
}

const styles = [
  { type: "emboss",   process: processEmboss },
  { type: "poster",   process: processPoster },
  { type: "quad",     process: processQuadtree },
  { type: "polaroid", process: processPolaroid },
  { type: "wave",     process: processWave },
  { type: "popart",   process: processPopArt },
  { type: "halftone", process: processHalftone },
];

// ---------------------------------------------------------------- drawing --

function drawStyled(type, src, box, now) {
  switch (type) {
    case "emboss":
    case "poster":
    case "popart":
    case "halftone":
      ctx.drawImage(src, box.x, box.y, box.w, box.h);
      break;

    case "quad":
      ctx.drawImage(src, box.x, box.y, box.w, box.h);
      ctx.fillStyle = "#e9e4d6";
      ctx.fillRect(box.x + box.w * 0.30, box.y - Math.min(34, box.h * 0.12), box.w * 0.28, Math.min(26, box.h * 0.09));
      ctx.fillStyle = "#1d9e33";
      ctx.fillRect(box.x + box.w * 0.34, box.y + box.h + 4, box.w * 0.24, Math.min(20, box.h * 0.07));
      break;

    case "polaroid": {
      const b = 6;
      ctx.fillStyle = "#fff";
      ctx.fillRect(box.x - b, box.y - b, box.w + b * 2, box.h + b * 2);
      ctx.drawImage(src, box.x, box.y, box.w, box.h);
      break;
    }

    case "wave": {
      const phase = now / 260;
      const scaleY = box.h / src.height;
      ctx.fillStyle = "#01060f";
      ctx.fillRect(box.x, box.y, box.w, box.h);
      for (let pass = 0; pass < 2; pass++) {
        if (pass === 1) {
          ctx.globalCompositeOperation = "lighter";
          ctx.globalAlpha = 0.35;
        }
        const ghost = pass === 1 ? 8 : 0;
        for (let row = 0; row < src.height; row += 2) {
          const off =
            Math.sin(row * 0.05 + phase * 2.1) * 6 * Math.sin(row * 0.009 + phase * 0.7) + ghost;
          ctx.drawImage(src, 0, row, src.width, 2, box.x + off, box.y + row * scaleY, box.w, 2 * scaleY + 1);
        }
      }
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(box.x + box.w * 0.08, box.y + box.h * 0.10, box.w * 0.84, box.h * 0.76);
      break;
    }
  }
}

function drawHint(text) {
  ctx.save();
  ctx.font = "600 15px -apple-system, 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  const y = canvas.height - 26;
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  const w = ctx.measureText(text).width + 28;
  ctx.beginPath();
  ctx.roundRect(canvas.width / 2 - w / 2, y - 20, w, 30, 15);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.fillText(text, canvas.width / 2, y);
  ctx.restore();
}

// ------------------------------------------------------------- main loop --

const hands = new Hands({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
});

hands.setOptions({
  maxNumHands: 2,
  modelComplexity: 1,
  minDetectionConfidence: 0.7,
  minTrackingConfidence: 0.5,
});

hands.onResults((results) => {
  if (!ready) {
    ready = true;
    loadingEl.classList.add("hidden");
  }
  if (canvas.width !== video.videoWidth) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }

  const now = performance.now();
  const dt = lastFrameAt ? now - lastFrameAt : 16;
  lastFrameAt = now;
  const handsList = results.multiHandLandmarks || [];

  // live frame
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  // saved pictures stay exactly where they were saved
  for (const s of stamps) {
    drawStyled(s.type, s.src, s.box, now);
  }

  if (handsList.length === 2) {
    const { moved, box } = smoothTo(boxFromHands(handsList[0], handsList[1]));
    const bigEnough = box.w > 40 && box.h > 40;

    let progress = 0;
    if (bigEnough) {
      // live preview of the current effect inside your frame
      const style = styles[styleIndex];
      const src = style.process(box, previewCanvas);
      drawStyled(style.type, src, box, now);

      // re-arm once you've moved far enough from the last save
      if (!armed && lastSaveCenter) {
        const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
        if (Math.hypot(cx - lastSaveCenter.x, cy - lastSaveCenter.y) > REARM_DIST) {
          armed = true;
          openMs = 0;
          steadyMs = 0;
        }
      }

      if (armed) {
        openMs += dt;
        // jitter-tolerant steadiness: smoothed movement vs box-relative threshold
        jitter += (moved - jitter) * 0.25;
        const steadyThreshold = Math.max(20, (box.w + box.h) * 0.035);
        steadyMs = jitter < steadyThreshold ? steadyMs + dt : 0;

        progress = Math.max(
          Math.min(1, steadyMs / STEADY_MS),
          Math.min(1, openMs / FORCE_SAVE_MS)
        );

        if (steadyMs >= STEADY_MS || openMs >= FORCE_SAVE_MS) {
          const keeper = document.createElement("canvas");
          style.process(box, keeper);
          stamps.push({ type: style.type, src: keeper, box: { ...box } });
          if (stamps.length > MAX_STAMPS) stamps.shift();

          styleIndex = (styleIndex + 1) % styles.length;
          armed = false;
          lastSaveCenter = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
          steadyMs = 0;
          openMs = 0;
          flashAt = now;
          flashBox = { ...box };
        }
      }
    } else {
      steadyMs = 0;
      openMs = 0;
    }

    // white frame + save progress
    ctx.strokeStyle = `rgba(255,255,255,${0.6 + 0.4 * progress})`;
    ctx.lineWidth = 1.5 + progress * 2.5;
    ctx.strokeRect(box.x, box.y, box.w, box.h);

    if (!bigEnough) drawHint("spread your hands to open the frame");
    else if (!armed) drawHint("saved ✓ — move away and draw the next frame");
    else drawHint(`effect ${styleIndex + 1}/${styles.length} — saving…`);
  } else {
    smoothBox = null;
    steadyMs = 0;
    openMs = 0;
    armed = true;
    if (stamps.length === 0) drawHint("draw a frame with both hands");
  }

  // camera-snap flash on save
  if (flashAt > 0 && now - flashAt < 260 && flashBox) {
    ctx.fillStyle = `rgba(255,255,255,${0.75 * (1 - (now - flashAt) / 260)})`;
    ctx.fillRect(flashBox.x, flashBox.y, flashBox.w, flashBox.h);
  }
});

window.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "c") stamps = [];
});

async function start() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();

  const camera = new Camera(video, {
    onFrame: async () => {
      await hands.send({ image: video });
    },
    width: video.videoWidth || 1280,
    height: video.videoHeight || 720,
  });
  camera.start();
}

start().catch((err) => {
  loadingEl.querySelector("p").textContent = "Camera access failed: " + err.message;
});
