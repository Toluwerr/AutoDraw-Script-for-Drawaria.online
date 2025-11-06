// Paste this script into the drawaria.online console to auto-draw any image
// by replaying pixel-perfect strokes through Drawaria's websocket channel.
(() => {
  const SCRIPT_HANDLE = '__drawariaImageAutodraw';
  const MAX_COLOUR_CAPACITY = 1300;

  if (window[SCRIPT_HANDLE]?.cleanup) {
    try {
      window[SCRIPT_HANDLE].cleanup();
    } catch (err) {
      console.warn('drawaria image autodraw: cleanup error from previous run', err);
    }
  }

  const state = {
    running: false,
    abortRequested: false,
    prepared: false,
    previewDataUrl: null,
    pixelWidth: 0,
    pixelHeight: 0,
    palette: [],
    paletteUsage: [],
    assignments: null,
    sourceImageData: null,
    paletteSortMode: 'dark-first',
    selection: null,
    settings: {
      smoothnessPercent: 40,
      laneFanMultiplier: 100,
      coverageBoost: 100,
      detailMode: 'balanced',
      lowResEnhancer: true,
      edgeDetail: true,
      microDetail: true,
      autoStart: false,
      ditherStrength: 100,
      adaptiveTheme: true,
      spectralBoost: 120,
      highlightGlaze: true,
      textureWeave: false,
      gradientEcho: true,
    },
    metrics: {
      pixelCount: 0,
      paletteCount: 0,
      estimatedStrokes: 0,
      estimatedDurationMs: 0,
      laneCount: 0,
      scaleFactor: 1,
      boardWidth: 0,
      boardHeight: 0,
      targetWidth: 0,
      targetHeight: 0,
      selectionActive: false,
    },
    commandCache: null,
  };

  const funState = {
    running: false,
    abortRequested: false,
    pointerId: 8807,
    activeFeature: null,
  };

  const funSettings = {
    density: 70,
    tempo: 60,
    mirror: true,
    jitter: true,
  };

  const cleanupCallbacks = [];

  const wsBridge = installSocketBridge();
  cleanupCallbacks.push(() => wsBridge.release());

  function registerCleanup(fn) {
    cleanupCallbacks.push(fn);
  }

  function runCleanup() {
    while (cleanupCallbacks.length) {
      const fn = cleanupCallbacks.pop();
      try {
        fn();
      } catch (err) {
        console.warn('drawaria image autodraw: cleanup callback failed', err);
      }
    }
    delete window[SCRIPT_HANDLE];
  }

  function hexToRgb(hex) {
    const normalised = hex.replace('#', '');
    if (normalised.length !== 6) {
      return { r: 37, g: 99, b: 235 };
    }
    return {
      r: parseInt(normalised.slice(0, 2), 16),
      g: parseInt(normalised.slice(2, 4), 16),
      b: parseInt(normalised.slice(4, 6), 16),
    };
  }

  function rgbToHex(r, g, b) {
    return `#${[r, g, b]
      .map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0'))
      .join('')}`;
  }

  function mixHex(baseHex, targetHex, amount) {
    const base = hexToRgb(baseHex);
    const target = hexToRgb(targetHex);
    const ratio = Math.max(0, Math.min(1, amount));
    const inv = 1 - ratio;
    return rgbToHex(
      base.r * inv + target.r * ratio,
      base.g * inv + target.g * ratio,
      base.b * inv + target.b * ratio
    );
  }

  function lightenHex(hex, amount) {
    return mixHex(hex, '#ffffff', amount);
  }

  function darkenHex(hex, amount) {
    return mixHex(hex, '#000000', amount);
  }

  function computeColourProfile(colour) {
    if (!colour) {
      return {
        luminance: 0,
        saturation: 0,
        value: 0,
        lightness: 0,
      };
    }
    const r = (colour.r ?? 0) / 255;
    const g = (colour.g ?? 0) / 255;
    const b = (colour.b ?? 0) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const chroma = max - min;
    const saturation = max === 0 ? 0 : chroma / max;
    const lightness = (max + min) / 2;
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return {
      luminance,
      saturation,
      value: max,
      lightness,
    };
  }

  function formatNumber(value) {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      return '—';
    }
    return value.toLocaleString('en-US');
  }

  function formatDuration(ms) {
    if (!ms || ms <= 0) {
      return '0s';
    }
    const seconds = ms / 1000;
    if (seconds < 60) {
      return `${seconds.toFixed(Math.max(0, seconds >= 10 ? 0 : 1))}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remaining = Math.round(seconds % 60);
    return `${minutes}m ${remaining.toString().padStart(2, '0')}s`;
  }

  class AbortPainting extends Error {
    constructor() {
      super('Drawing aborted');
      this.name = 'AbortPainting';
    }
  }

  class FunAbort extends Error {
    constructor() {
      super('Fun effect aborted');
      this.name = 'FunAbort';
    }
  }

  function ensureNotAborted() {
    if (state.abortRequested) {
      throw new AbortPainting();
    }
  }

  function ensureFunNotAborted() {
    if (funState.abortRequested) {
      throw new FunAbort();
    }
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const ui = createPanel();
  ui.paletteOrderSelect.value = state.paletteSortMode;
  registerCleanup(() => {
    ui.panel.remove();
    ui.style.remove();
  });

  registerCleanup(() => {
    funState.abortRequested = true;
  });

  const hiddenCanvas = document.createElement('canvas');
  const hiddenCtx = hiddenCanvas.getContext('2d', { willReadFrequently: true });

  let metricsUpdateScheduled = false;

  async function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = event.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function resizeImageToFit(img, maxDimension) {
    const scale = Math.min(1, maxDimension / Math.max(img.width, img.height));
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));
    hiddenCanvas.width = width;
    hiddenCanvas.height = height;
    hiddenCtx.clearRect(0, 0, width, height);
    hiddenCtx.imageSmoothingEnabled = true;
    hiddenCtx.imageSmoothingQuality = 'high';
    hiddenCtx.drawImage(img, 0, 0, width, height);
    return hiddenCtx.getImageData(0, 0, width, height);
  }

  function previewImage(img, width, height) {
    const ctx = ui.previewCanvas.getContext('2d');
    const { width: previewW, height: previewH } = ui.previewCanvas;
    ctx.clearRect(0, 0, previewW, previewH);
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, previewW, previewH);
    ctx.save();
    ctx.shadowColor = 'rgba(15,23,42,0.45)';
    ctx.shadowBlur = 28;
    const scale = Math.min((previewW - 40) / width, (previewH - 40) / height);
    const drawW = width * scale;
    const drawH = height * scale;
    ctx.drawImage(hiddenCanvas, 0, 0, width, height, (previewW - drawW) / 2, (previewH - drawH) / 2, drawW, drawH);
    ctx.restore();
  }

  function quantizeToPalette(imageData, width, height, maxColors) {
    const data = imageData.data;
    const totalPixels = width * height;

    const map = new Map();

    for (let i = 0; i < totalPixels; i++) {
      const offset = i * 4;
      const alpha = data[offset + 3];
      if (alpha < 16) {
        continue;
      }
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      const key = (r << 16) | (g << 8) | b;
      const record = map.get(key);
      if (record) {
        record.count += 1;
      } else {
        map.set(key, { r, g, b, count: 1 });
      }
    }

    if (!map.size) {
      const fallbackPalette = [{ r: 0, g: 0, b: 0, hex: '#000000' }];
      return {
        palette: fallbackPalette,
        assignments: new Uint16Array(totalPixels).fill(0xffff),
      };
    }

    const colours = Array.from(map.values());
    const targetColors = Math.max(1, Math.min(maxColors, colours.length));

    const boxes = [createColorBox(colours.map((_, idx) => idx), colours)];

    while (boxes.length < targetColors) {
      boxes.sort((a, b) => b.score - a.score);
      const box = boxes.shift();
      if (!box || box.indices.length <= 1) {
        if (box) {
          boxes.unshift(box);
        }
        break;
      }
      const split = splitBox(box, colours);
      if (!split || !split.low.indices.length || !split.high.indices.length) {
        boxes.unshift(box);
        break;
      }
      boxes.push(split.low, split.high);
    }

    const palette = boxes.map((box) => {
      let total = 0;
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      for (const idx of box.indices) {
        const colour = colours[idx];
        total += colour.count;
        rSum += colour.r * colour.count;
        gSum += colour.g * colour.count;
        bSum += colour.b * colour.count;
      }
      if (!total) {
        total = 1;
      }
      const r = Math.round(rSum / total);
      const g = Math.round(gSum / total);
      const b = Math.round(bSum / total);
      return {
        r,
        g,
        b,
        hex: `#${[r, g, b]
          .map((component) => component.toString(16).padStart(2, '0'))
          .join('')}`,
      };
    });

    const assignments = assignPaletteWithDithering(imageData, width, height, palette);

    return { palette, assignments };
  }

  function createColorBox(indices, colours) {
    let rMin = 255;
    let rMax = 0;
    let gMin = 255;
    let gMax = 0;
    let bMin = 255;
    let bMax = 0;
    let population = 0;

    for (const idx of indices) {
      const colour = colours[idx];
      rMin = Math.min(rMin, colour.r);
      rMax = Math.max(rMax, colour.r);
      gMin = Math.min(gMin, colour.g);
      gMax = Math.max(gMax, colour.g);
      bMin = Math.min(bMin, colour.b);
      bMax = Math.max(bMax, colour.b);
      population += colour.count;
    }

    const rRange = rMax - rMin;
    const gRange = gMax - gMin;
    const bRange = bMax - bMin;
    const maxRange = Math.max(rRange, gRange, bRange, 1);

    return {
      indices,
      population,
      rRange,
      gRange,
      bRange,
      score: maxRange * Math.log(population + 1),
    };
  }

  function splitBox(box, colours) {
    const { rRange, gRange, bRange } = box;
    let component = 'r';
    if (gRange >= rRange && gRange >= bRange) {
      component = 'g';
    } else if (bRange >= rRange && bRange >= gRange) {
      component = 'b';
    }

    const sorted = [...box.indices].sort((a, b) => colours[a][component] - colours[b][component]);
    if (!sorted.length) {
      return null;
    }
    const total = sorted.reduce((acc, idx) => acc + colours[idx].count, 0);
    let midpoint = total / 2;
    let low = [];
    let high = [];
    let accumulator = 0;

    for (const idx of sorted) {
      if (accumulator < midpoint) {
        low.push(idx);
      } else {
        high.push(idx);
      }
      accumulator += colours[idx].count;
    }

    if (!low.length || !high.length) {
      const half = Math.ceil(sorted.length / 2);
      low = sorted.slice(0, half);
      high = sorted.slice(half);
    }

    return {
      low: createColorBox(low, colours),
      high: createColorBox(high, colours),
    };
  }

  function perceptualColourDistance(r1, g1, b1, r2, g2, b2) {
    const rMean = (r1 + r2) / 2;
    const dR = r1 - r2;
    const dG = g1 - g2;
    const dB = b1 - b2;
    return (
      (2 + rMean / 256) * dR * dR +
      4 * dG * dG +
      (2 + (255 - rMean) / 256) * dB * dB
    );
  }

  function clampChannel(value) {
    return Math.max(0, Math.min(255, value));
  }

  function assignPaletteWithDithering(imageData, width, height, palette) {
    const totalPixels = width * height;
    const assignments = new Uint16Array(totalPixels);
    if (!palette.length) {
      assignments.fill(0xffff);
      return assignments;
    }

    const ditherScale = (state.settings?.ditherStrength ?? 100) / 100;
    const data = imageData.data;
    const alphaChannel = new Uint8Array(totalPixels);
    const rBuffer = new Float32Array(totalPixels);
    const gBuffer = new Float32Array(totalPixels);
    const bBuffer = new Float32Array(totalPixels);

    for (let i = 0; i < totalPixels; i++) {
      const offset = i * 4;
      alphaChannel[i] = data[offset + 3];
      rBuffer[i] = data[offset];
      gBuffer[i] = data[offset + 1];
      bBuffer[i] = data[offset + 2];
    }

    const findNearest = (r, g, b) => {
      let bestIndex = 0;
      let bestDistance = Infinity;
      for (let j = 0; j < palette.length; j++) {
        const colour = palette[j];
        const distance = perceptualColourDistance(r, g, b, colour.r, colour.g, colour.b);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = j;
        }
      }
      return bestIndex;
    };

    const distributeError = (x, y, errR, errG, errB, factor) => {
      if (ditherScale <= 0) {
        return;
      }
      if (x < 0 || x >= width || y < 0 || y >= height) {
        return;
      }
      const idx = y * width + x;
      if (alphaChannel[idx] < 16) {
        return;
      }
      const scaledFactor = factor * ditherScale;
      rBuffer[idx] += errR * scaledFactor;
      gBuffer[idx] += errG * scaledFactor;
      bBuffer[idx] += errB * scaledFactor;
    };

    for (let y = 0; y < height; y++) {
      const serpentine = y % 2 === 1;
      if (serpentine) {
        for (let x = width - 1; x >= 0; x--) {
          const idx = y * width + x;
          if (alphaChannel[idx] < 16) {
            assignments[idx] = 0xffff;
            continue;
          }
          const sourceR = clampChannel(rBuffer[idx]);
          const sourceG = clampChannel(gBuffer[idx]);
          const sourceB = clampChannel(bBuffer[idx]);
          const paletteIndex = findNearest(sourceR, sourceG, sourceB);
          assignments[idx] = paletteIndex;
          const target = palette[paletteIndex];
          const errR = sourceR - target.r;
          const errG = sourceG - target.g;
          const errB = sourceB - target.b;
          distributeError(x - 1, y, errR, errG, errB, 7 / 16);
          distributeError(x + 1, y + 1, errR, errG, errB, 3 / 16);
          distributeError(x, y + 1, errR, errG, errB, 5 / 16);
          distributeError(x - 1, y + 1, errR, errG, errB, 1 / 16);
        }
      } else {
        for (let x = 0; x < width; x++) {
          const idx = y * width + x;
          if (alphaChannel[idx] < 16) {
            assignments[idx] = 0xffff;
            continue;
          }
          const sourceR = clampChannel(rBuffer[idx]);
          const sourceG = clampChannel(gBuffer[idx]);
          const sourceB = clampChannel(bBuffer[idx]);
          const paletteIndex = findNearest(sourceR, sourceG, sourceB);
          assignments[idx] = paletteIndex;
          const target = palette[paletteIndex];
          const errR = sourceR - target.r;
          const errG = sourceG - target.g;
          const errB = sourceB - target.b;
          distributeError(x + 1, y, errR, errG, errB, 7 / 16);
          distributeError(x - 1, y + 1, errR, errG, errB, 3 / 16);
          distributeError(x, y + 1, errR, errG, errB, 5 / 16);
          distributeError(x + 1, y + 1, errR, errG, errB, 1 / 16);
        }
      }
    }

    return assignments;
  }

  function renderPaletteSwatches(palette, usage = []) {
    if (!ui.paletteStrip) {
      return;
    }
    ui.paletteStrip.innerHTML = '';
    let dominantIndex = 0;
    if (usage.length) {
      let best = -Infinity;
      usage.forEach((value, index) => {
        if (value > best) {
          best = value;
          dominantIndex = index;
        }
      });
    }
    const totalUsage = usage.reduce((acc, value) => acc + value, 0) || 1;
    palette.forEach((color, index) => {
      const swatch = document.createElement('div');
      swatch.className = 'pxa-swatch';
      swatch.style.background = color.hex;
      if (index === dominantIndex) {
        swatch.dataset.dominant = 'true';
      }
      const percentage = usage[index] ? ((usage[index] / totalUsage) * 100).toFixed(2) : null;
      swatch.title = `${index + 1}. ${color.hex}${percentage ? ` • ${percentage}%` : ''}`;
      ui.paletteStrip.appendChild(swatch);
    });
    const summaryText = `${palette.length} colours (max ${MAX_COLOUR_CAPACITY})`;
    if (ui.paletteSummary) {
      ui.paletteSummary.textContent = summaryText;
    }
    if (ui.paletteSummarySecondary) {
      ui.paletteSummarySecondary.textContent = summaryText;
    }
  }

  function renderPaletteInsights(palette, usage = []) {
    if (!ui.paletteInsights) {
      return;
    }
    ui.paletteInsights.innerHTML = '';
    if (!palette.length) {
      const emptyCard = document.createElement('div');
      emptyCard.className = 'pxa-insight-card';
      emptyCard.innerHTML = '<strong>Palette pending</strong><span>Import an image to unlock coverage analytics and colour rankings.</span>';
      ui.paletteInsights.appendChild(emptyCard);
      return;
    }
    const totalUsage = usage.reduce((acc, value) => acc + value, 0) || 1;
    const ranked = palette
      .map((colour, index) => ({
        index,
        hex: colour.hex,
        percent: usage[index] ? (usage[index] / totalUsage) * 100 : 0,
      }))
      .sort((a, b) => b.percent - a.percent)
      .slice(0, 4);
    const topColoursCard = document.createElement('div');
    topColoursCard.className = 'pxa-insight-card';
    topColoursCard.innerHTML = `<strong>Dominant colours</strong>${ranked
      .map((entry) => `<span>${entry.index + 1}. ${entry.hex} — ${entry.percent.toFixed(2)}%</span>`)
      .join('')}`;
    ui.paletteInsights.appendChild(topColoursCard);

    const cadenceCard = document.createElement('div');
    cadenceCard.className = 'pxa-insight-card';
    cadenceCard.innerHTML = `<strong>Stroke cadence</strong><span>${formatNumber(
      state.metrics.estimatedStrokes
    )} planned strokes • lane fan ×${state.metrics.laneCount || 1}</span><span>Smoothness ${state.settings.smoothnessPercent}% • Coverage ${state.settings.coverageBoost}%</span>`;
    ui.paletteInsights.appendChild(cadenceCard);

    const detailLabels = {
      balanced: 'Balanced detail',
      max: 'Maximum detail',
      minimal: 'Minimal detail',
    };
    const detailCard = document.createElement('div');
    detailCard.className = 'pxa-insight-card';
    detailCard.innerHTML = `<strong>Detail profile</strong><span>${
      detailLabels[state.settings.detailMode] || state.settings.detailMode
    }</span><span>Dither strength ${state.settings.ditherStrength}% • Low-res enhancer ${
      state.settings.lowResEnhancer ? 'on' : 'off'
    }</span>`;
    ui.paletteInsights.appendChild(detailCard);

    const harmonyCard = document.createElement('div');
    harmonyCard.className = 'pxa-insight-card';
    harmonyCard.innerHTML = `<strong>Harmony engines</strong><span>Spectral accent ${
      state.settings.spectralBoost
    }%</span><span>Glow ${state.settings.highlightGlaze !== false ? 'on' : 'off'} • Texture ${
      state.settings.textureWeave ? 'on' : 'off'
    } • Echo ${state.settings.gradientEcho !== false ? 'on' : 'off'}</span>`;
    ui.paletteInsights.appendChild(harmonyCard);
  }

  function applyPanelThemeFromPalette(palette, usage = []) {
    if (!ui.panel) {
      return;
    }
    if (state.settings.adaptiveTheme === false || !palette.length) {
      ui.panel.style.setProperty('--pxa-accent', '#2563eb');
      ui.panel.style.setProperty('--pxa-accent-dark', '#1e3a8a');
      ui.panel.style.setProperty('--pxa-accent-soft', 'rgba(37,99,235,0.16)');
      ui.panel.style.setProperty('--pxa-ambient', 'rgba(148,163,184,0.22)');
      return;
    }
    let dominantIndex = 0;
    if (usage.length) {
      let best = -Infinity;
      usage.forEach((value, index) => {
        if (value > best) {
          best = value;
          dominantIndex = index;
        }
      });
    }
    const accent = palette[dominantIndex]?.hex || '#2563eb';
    ui.panel.style.setProperty('--pxa-accent', accent);
    ui.panel.style.setProperty('--pxa-accent-dark', darkenHex(accent, 0.35));
    ui.panel.style.setProperty('--pxa-accent-soft', lightenHex(accent, 0.75));
    ui.panel.style.setProperty('--pxa-ambient', lightenHex(accent, 0.9));
  }

  function updateModeLabel() {
    if (!ui.modeLabel) {
      return;
    }
    const detailLabels = {
      balanced: 'Balanced detail',
      max: 'Maximum detail',
      minimal: 'Minimal detail',
    };
    const detailLabel = detailLabels[state.settings.detailMode] || state.settings.detailMode;
    const extras = [];
    if (state.settings.highlightGlaze !== false) {
      extras.push('glow glaze');
    }
    if (state.settings.textureWeave) {
      extras.push('texture weave');
    }
    if (state.settings.gradientEcho !== false) {
      extras.push('edge echo');
    }
    ui.modeLabel.textContent = `${detailLabel} • ${state.settings.smoothnessPercent}% smooth${
      extras.length ? ` • ${extras.join(' + ')}` : ''
    }`;
  }

  const funFeatures = {
    aurora: {
      label: 'Aurora sweep',
      description: 'Layered sine ribbons glide horizontally with pointer-drawn passes.',
      estimate(region, options) {
        const stripes = Math.max(3, Math.round((options.density || 0) / 12));
        return Math.max(1, stripes * (options.mirror ? 2 : 1));
      },
      async run(ctx) {
        const stripes = Math.max(3, Math.round((ctx.options.density || 0) / 12));
        const width = Math.max(1, ctx.region.width);
        const height = Math.max(1, ctx.region.height);
        const baseAmplitude = Math.max(4, height / Math.max(6, stripes * 2));
        const steps = Math.max(60, Math.round(width / 3));
        for (let lane = 0; lane < stripes; lane += 1) {
          ctx.ensureActive();
          const amplitude = baseAmplitude * (1 + lane / (stripes * 1.25));
          const frequency = 1.6 + lane * 0.35;
          const centerY = ctx.region.y + (height / (stripes + 1)) * (lane + 0.6);
          const path = [];
          for (let step = 0; step <= steps; step += 1) {
            const t = step / steps;
            let x = ctx.region.x + t * width;
            let y = centerY + Math.sin(t * Math.PI * frequency + lane * 0.4) * amplitude;
            if (ctx.options.jitter) {
              y += Math.cos((t * Math.PI * 6) + lane) * amplitude * 0.18;
            }
            x = clamp(x, ctx.minCanvasX, ctx.maxCanvasX);
            y = clamp(y, ctx.minCanvasY, ctx.maxCanvasY);
            path.push({ x, y });
          }
          await ctx.stroke(path, 0.58);
          ctx.advanceProgress();
          if (ctx.options.mirror) {
            const mirrored = path.map((point, index) => {
              const offset = ctx.options.jitter ? Math.sin(index * 0.25) * amplitude * 0.08 : 0;
              return {
                x: clamp(ctx.region.x + ctx.region.width - (point.x - ctx.region.x), ctx.minCanvasX, ctx.maxCanvasX),
                y: clamp(point.y + offset, ctx.minCanvasY, ctx.maxCanvasY),
              };
            });
            await ctx.stroke(mirrored, 0.58);
            ctx.advanceProgress();
          }
        }
      },
    },
    vortex: {
      label: 'Vortex bloom',
      description: 'Spirals orbit from the centre to sketch swirling blooms with pointer strokes.',
      estimate(region, options) {
        const arms = options.mirror ? 4 : 3;
        return Math.max(arms, 1);
      },
      async run(ctx) {
        const arms = ctx.options.mirror ? 4 : 3;
        const loops = Math.max(3, Math.round((ctx.options.density || 0) / 15));
        const steps = loops * 160;
        for (let arm = 0; arm < arms; arm += 1) {
          ctx.ensureActive();
          const offset = (2 * Math.PI * arm) / arms;
          const path = [];
          for (let step = 0; step <= steps; step += 1) {
            const t = step / steps;
            const angle = t * loops * Math.PI * 2 + offset;
            let radius = (Math.min(ctx.region.width, ctx.region.height) / 2) * Math.pow(t, 0.9);
            if (ctx.options.jitter) {
              radius += Math.sin(angle * 0.6) * radius * 0.08;
            }
            let x = ctx.region.x + ctx.region.width / 2 + Math.cos(angle) * radius;
            let y = ctx.region.y + ctx.region.height / 2 + Math.sin(angle) * radius * (ctx.options.mirror ? 0.9 : 1);
            x = clamp(x, ctx.minCanvasX, ctx.maxCanvasX);
            y = clamp(y, ctx.minCanvasY, ctx.maxCanvasY);
            path.push({ x, y });
          }
          await ctx.stroke(path, 0.5);
          ctx.advanceProgress();
        }
      },
    },
    firefly: {
      label: 'Firefly scatter',
      description: 'Launches sparkling bursts of short pointer flutters across the region.',
      estimate(region, options) {
        const base = Math.max(12, Math.round((options.density || 0) * 0.8));
        return Math.max(1, base * (options.mirror ? 2 : 1));
      },
      async run(ctx) {
        const base = Math.max(12, Math.round((ctx.options.density || 0) * 0.8));
        for (let i = 0; i < base; i += 1) {
          ctx.ensureActive();
          const originX = ctx.region.x + ctx.random() * ctx.region.width;
          const originY = ctx.region.y + ctx.random() * ctx.region.height;
          const heading = ctx.random() * Math.PI * 2;
          const length = Math.max(10, Math.min(ctx.region.width, ctx.region.height) * (0.18 + ctx.random() * 0.12));
          const segments = 4 + Math.floor(ctx.random() * 4);
          const path = [];
          for (let s = 0; s <= segments; s += 1) {
            const t = s / segments;
            const curve = Math.sin(t * Math.PI);
            let x = originX + Math.cos(heading) * length * t;
            let y = originY + Math.sin(heading) * length * t + curve * length * 0.25;
            if (ctx.options.jitter) {
              x += (ctx.random() - 0.5) * length * 0.18;
              y += (ctx.random() - 0.5) * length * 0.12;
            }
            x = clamp(x, ctx.minCanvasX, ctx.maxCanvasX);
            y = clamp(y, ctx.minCanvasY, ctx.maxCanvasY);
            path.push({ x, y });
          }
          await ctx.stroke(path, 0.45);
          ctx.advanceProgress();
          if (ctx.options.mirror) {
            const mirrored = path.map((point) => ({
              x: clamp(ctx.region.x + ctx.region.width - (point.x - ctx.region.x), ctx.minCanvasX, ctx.maxCanvasX),
              y: point.y,
            }));
            await ctx.stroke(mirrored, 0.45);
            ctx.advanceProgress();
          }
        }
      },
    },
    cascade: {
      label: 'Cascade drapery',
      description: 'Pointer sweeps unfurl silky waterfall ribbons that ripple across the canvas.',
      estimate(region, options) {
        const rows = Math.max(4, Math.round((options.density || 0) / 10));
        return Math.max(1, rows * (options.mirror ? 2 : 1));
      },
      async run(ctx) {
        const rows = Math.max(4, Math.round((ctx.options.density || 0) / 10));
        const width = Math.max(1, ctx.region.width);
        const height = Math.max(1, ctx.region.height);
        const amplitudeBase = Math.max(6, height * 0.08);
        for (let row = 0; row < rows; row += 1) {
          ctx.ensureActive();
          const baseY = ctx.region.y + (height / (rows + 1)) * (row + 1);
          const waveAmp = amplitudeBase * (1 + row / (rows * 0.9));
          const steps = Math.max(80, Math.round(width / 4));
          const path = [];
          for (let step = 0; step <= steps; step += 1) {
            const t = step / steps;
            const x = clamp(ctx.region.x + t * width, ctx.minCanvasX, ctx.maxCanvasX);
            let y = baseY + Math.sin(t * Math.PI * (1.6 + row * 0.25)) * waveAmp;
            if (ctx.options.jitter) {
              y += (ctx.random() - 0.5) * waveAmp * 0.35;
            }
            y = clamp(y, ctx.minCanvasY, ctx.maxCanvasY);
            path.push({ x, y });
          }
          await ctx.stroke(path, 0.52);
          ctx.advanceProgress();
          if (ctx.options.mirror) {
            const mirrored = path.map((point, index) => ({
              x: clamp(ctx.region.x + ctx.region.width - (point.x - ctx.region.x), ctx.minCanvasX, ctx.maxCanvasX),
              y: clamp(
                ctx.region.y + ctx.region.height - (point.y - ctx.region.y) + Math.sin(index * 0.08) * waveAmp * 0.12,
                ctx.minCanvasY,
                ctx.maxCanvasY
              ),
            }));
            await ctx.stroke(mirrored, 0.48);
            ctx.advanceProgress();
          }
        }
      },
    },
  };

  function updateFunDescription() {
    if (!ui.funDescription || !ui.funModeSelect) {
      return;
    }
    const effect = funFeatures[ui.funModeSelect.value];
    if (effect) {
      ui.funDescription.textContent = effect.description;
    } else {
      ui.funDescription.textContent = 'Select an effect to view its details.';
    }
  }

  function resolveFunRegion(canvas) {
    const width = canvas?.width || 0;
    const height = canvas?.height || 0;
    if (!state.selection) {
      return { x: 0, y: 0, width, height };
    }
    const sel = state.selection;
    const x = clamp(Math.round(sel.normX * width), 0, width);
    const y = clamp(Math.round(sel.normY * height), 0, height);
    const w = Math.max(1, Math.round(sel.normWidth * width));
    const h = Math.max(1, Math.round(sel.normHeight * height));
    const maxWidth = Math.max(1, width - x);
    const maxHeight = Math.max(1, height - y);
    return {
      x,
      y,
      width: clamp(w, 1, maxWidth),
      height: clamp(h, 1, maxHeight),
    };
  }

  function canvasPointToClient(canvas, x, y) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width / canvas.width || 1;
    const scaleY = rect.height / canvas.height || 1;
    return {
      clientX: rect.left + x * scaleX,
      clientY: rect.top + y * scaleY,
    };
  }

  function dispatchCanvasPointer(canvas, type, pointerId, x, y, options = {}) {
    const coords = canvasPointToClient(canvas, x, y);
    const eventInit = {
      pointerId,
      pointerType: 'pen',
      clientX: coords.clientX,
      clientY: coords.clientY,
      buttons: type === 'pointerup' ? 0 : 1,
      pressure: type === 'pointerup' ? 0 : options.pressure ?? 0.6,
      tiltX: options.tiltX ?? 0,
      tiltY: options.tiltY ?? 0,
      bubbles: true,
      cancelable: true,
    };
    const event = new PointerEvent(type, eventInit);
    canvas.dispatchEvent(event);
  }

  async function performPointerStroke(canvas, pointerId, points, stepDelay, pressure = 0.6) {
    if (!points.length) {
      return;
    }
    ensureFunNotAborted();
    const first = points[0];
    dispatchCanvasPointer(canvas, 'pointerdown', pointerId, first.x, first.y, { pressure });
    try {
      if (canvas.setPointerCapture) {
        try {
          canvas.setPointerCapture(pointerId);
        } catch (err) {
          // ignore capture failures
        }
      }
      for (let i = 1; i < points.length; i += 1) {
        ensureFunNotAborted();
        const point = points[i];
        dispatchCanvasPointer(canvas, 'pointermove', pointerId, point.x, point.y, { pressure });
        await wait(stepDelay);
      }
    } finally {
      const last = points[points.length - 1];
      dispatchCanvasPointer(canvas, 'pointerup', pointerId, last.x, last.y, { pressure: 0 });
      if (canvas.releasePointerCapture) {
        try {
          canvas.releasePointerCapture(pointerId);
        } catch (err) {
          // ignore release failures
        }
      }
    }
  }

  function computeFunTiming(tempo) {
    const raw = Number(tempo);
    const clampedTempo = clamp(Number.isFinite(raw) ? raw : 60, 10, 160);
    const stepDelay = Math.max(2, Math.round(22 - clampedTempo / 6));
    const strokeGap = Math.max(6, Math.round(stepDelay * 2));
    return { stepDelay, strokeGap };
  }

  function createFunContext(canvas, region, options, stepDelay, strokeGap, onProgress) {
    const pointerId = funState.pointerId;
    const minCanvasX = Math.max(0, Math.min(canvas.width, region.x));
    const maxCanvasX = Math.max(minCanvasX + 1, Math.min(canvas.width, region.x + region.width));
    const minCanvasY = Math.max(0, Math.min(canvas.height, region.y));
    const maxCanvasY = Math.max(minCanvasY + 1, Math.min(canvas.height, region.y + region.height));
    let completed = 0;
    const clampPoint = (point) => ({
      x: clamp(point.x, minCanvasX, maxCanvasX),
      y: clamp(point.y, minCanvasY, maxCanvasY),
    });
    return {
      canvas,
      region,
      options,
      pointerId,
      stepDelay,
      strokeGap,
      minCanvasX,
      maxCanvasX,
      minCanvasY,
      maxCanvasY,
      random: Math.random,
      ensureActive: ensureFunNotAborted,
      async stroke(points, pressure = 0.6) {
        ensureFunNotAborted();
        if (!points || points.length < 2) {
          return;
        }
        const safePoints = points.map(clampPoint);
        await performPointerStroke(canvas, pointerId, safePoints, stepDelay, pressure);
        await wait(strokeGap);
      },
      advanceProgress(increment = 1) {
        completed += increment;
        if (typeof onProgress === 'function') {
          onProgress(completed);
        }
      },
      setProgress(value) {
        completed = value;
        if (typeof onProgress === 'function') {
          onProgress(completed);
        }
      },
    };
  }

  async function startFunEffect() {
    if (!ui.funModeSelect || !ui.funRunButton) {
      return;
    }
    if (state.running) {
      updateFunStatus('Stop the image painter before launching a fun effect.');
      return;
    }
    if (funState.running) {
      updateFunStatus('A fun effect is already running.');
      return;
    }
    const effectKey = ui.funModeSelect.value;
    const effect = funFeatures[effectKey];
    if (!effect) {
      updateFunStatus('Select a fun effect to begin.');
      return;
    }
    const canvas = selectLargestCanvas();
    if (!canvas) {
      updateFunStatus('Canvas not found — join a Drawaria room first.');
      return;
    }
    if (!canvas.width || !canvas.height) {
      updateFunStatus('Canvas is not ready yet — wait for it to load.');
      return;
    }
    const region = resolveFunRegion(canvas);
    if (!region.width || !region.height) {
      updateFunStatus('Selection is too small for the fun lab.');
      return;
    }
    const options = {
      density: funSettings.density,
      tempo: funSettings.tempo,
      mirror: funSettings.mirror,
      jitter: funSettings.jitter,
    };
    const { stepDelay, strokeGap } = computeFunTiming(options.tempo);
    const total = Math.max(1, effect.estimate(region, options));
    funState.running = true;
    funState.abortRequested = false;
    funState.activeFeature = effectKey;
    ui.funRunButton.disabled = true;
    if (ui.funStopButton) {
      ui.funStopButton.disabled = false;
    }
    updateFunProgress(0);
    updateFunStatus(`Running ${effect.label}…`);
    let aborted = false;
    try {
      const context = createFunContext(canvas, region, options, stepDelay, strokeGap, (completed) => {
        const percent = (completed / total) * 100;
        updateFunProgress(percent);
      });
      await effect.run(context);
      aborted = funState.abortRequested;
      if (aborted) {
        updateFunStatus('Fun effect aborted.');
      } else {
        updateFunProgress(100);
        updateFunStatus(`${effect.label} complete!`);
      }
    } catch (err) {
      if (err instanceof FunAbort) {
        updateFunStatus('Fun effect aborted.');
      } else {
        console.error('drawaria image autodraw fun lab error', err);
        updateFunStatus(`Fun effect error: ${err.message || err}`);
      }
    } finally {
      funState.running = false;
      funState.activeFeature = null;
      funState.abortRequested = false;
      if (ui.funRunButton) {
        ui.funRunButton.disabled = false;
      }
      if (ui.funStopButton) {
        ui.funStopButton.disabled = true;
      }
    }
  }

  function stopFunEffect() {
    if (!funState.running) {
      updateFunStatus('No fun effect is currently running.');
      return;
    }
    funState.abortRequested = true;
    updateFunStatus('Stopping fun effect…');
  }

  function updateFunProgress(percent) {
    if (!ui.funProgressBar) {
      return;
    }
    const numeric = Number(percent);
    const clampedPercent = clamp(Number.isFinite(numeric) ? numeric : 0, 0, 100);
    ui.funProgressBar.style.width = `${clampedPercent}%`;
  }

  function updateFunStatus(message) {
    if (!ui.funStatus) {
      return;
    }
    ui.funStatus.textContent = message;
  }

  function updateSelectionUI() {
    if (!ui.selectionDetails) {
      return;
    }
    if (state.selection) {
      const sel = state.selection;
      const boardW = state.metrics.boardWidth || sel.boardWidth || 0;
      const boardH = state.metrics.boardHeight || sel.boardHeight || 0;
      const widthPx = Math.round(boardW * sel.normWidth);
      const heightPx = Math.round(boardH * sel.normHeight);
      const startX = Math.round(boardW * sel.normX);
      const startY = Math.round(boardH * sel.normY);
      ui.selectionDetails.textContent = `Region ${widthPx}×${heightPx}px @ (${startX}, ${startY})`;
      ui.selectionDetails.dataset.state = 'active';
      if (ui.clearRegionButton) {
        ui.clearRegionButton.disabled = false;
      }
    } else {
      ui.selectionDetails.textContent = 'Full canvas coverage';
      ui.selectionDetails.dataset.state = 'inactive';
      if (ui.clearRegionButton) {
        ui.clearRegionButton.disabled = true;
      }
    }
  }

  function updateMetricsUI() {
    if (!ui.metricResolution) {
      return;
    }
    if (state.pixelWidth && state.pixelHeight) {
      ui.metricResolution.textContent = `${state.pixelWidth}×${state.pixelHeight}`;
    } else {
      ui.metricResolution.textContent = '—';
    }
    const scale = state.metrics.scaleFactor || 1;
    const targetWidth = state.metrics.targetWidth || state.metrics.boardWidth;
    const targetHeight = state.metrics.targetHeight || state.metrics.boardHeight;
    if (scale && targetWidth && targetHeight) {
      const label = state.metrics.selectionActive ? `selection ${Math.round(targetWidth)}×${Math.round(targetHeight)}` : `${Math.round(targetWidth)}×${Math.round(targetHeight)}`;
      ui.metricScale.textContent = `Scaled ×${scale.toFixed(2)} into ${label}`;
    } else {
      ui.metricScale.textContent = 'Fit-to-canvas ready';
    }
    ui.metricPalette.textContent = formatNumber(state.metrics.paletteCount || state.palette.length || 0);
    const orderLabels = {
      'dark-first': 'Dark → Light',
      'light-first': 'Light → Dark',
      coverage: 'Coverage priority',
    };
    ui.metricPaletteNote.textContent = orderLabels[state.paletteSortMode] || state.paletteSortMode;
    ui.metricStrokes.textContent = formatNumber(state.metrics.estimatedStrokes || 0);
    ui.metricLanes.textContent = `Lane fan ×${state.metrics.laneCount || 1}`;
    ui.metricEta.textContent = formatDuration(state.metrics.estimatedDurationMs || 0);
    ui.metricDelay.textContent = `8ms stroke delay • ${formatNumber(state.metrics.estimatedStrokes || 0)} strokes`;
  }

  function getSettingsSignature() {
    const s = state.settings;
    return [
      state.paletteSortMode,
      s.smoothnessPercent,
      s.laneFanMultiplier,
      s.coverageBoost,
      s.detailMode,
      s.lowResEnhancer,
      s.edgeDetail,
      s.microDetail,
      s.ditherStrength,
      s.spectralBoost,
      s.highlightGlaze,
      s.textureWeave,
      s.gradientEcho,
    ].join('|');
  }

  function getSelectionSignature() {
    if (!state.selection) {
      return 'full';
    }
    const sel = state.selection;
    const toFixed = (value, fallback) => {
      const num = Number(value);
      if (!Number.isFinite(num)) {
        return fallback;
      }
      return num.toFixed(4);
    };
    return [
      toFixed(sel.normX, '0.0000'),
      toFixed(sel.normY, '0.0000'),
      toFixed(sel.normWidth, '1.0000'),
      toFixed(sel.normHeight, '1.0000'),
    ].join('|');
  }

  async function scheduleMetricsUpdate() {
    if (metricsUpdateScheduled || !state.prepared || state.running) {
      return;
    }
    metricsUpdateScheduled = true;
    try {
      await wait(80);
      const canvas = selectLargestCanvas();
      if (!canvas) {
        updateMetricsUI();
        return;
      }
      const commands = buildPixelCommands(canvas.width, canvas.height);
      if (!commands.length) {
        updateMetricsUI();
      }
    } finally {
      metricsUpdateScheduled = false;
    }
  }

  async function prepareFromFile(file) {
    if (!file) {
      throw new Error('Select an image file to begin.');
    }

    ui.previewLoading.classList.add('visible');
    ui.progressBar.style.width = '0%';
    ui.progressLabel.textContent = '0%';
    ui.status.textContent = 'Loading image…';

    try {
      await wait(10);

      const maxDimension = Number(ui.dimensionInput.value) || 500;
      const image = await loadImageFromFile(file);
      const imageData = resizeImageToFit(image, maxDimension);
      const { width, height } = imageData;
      state.sourceImageData = imageData;
      state.pixelWidth = width;
      state.pixelHeight = height;
      previewImage(image, width, height);

      ui.status.textContent = `Quantising colours (≤${MAX_COLOUR_CAPACITY})…`;
      await wait(10);
      const { palette, assignments } = quantizeToPalette(
        imageData,
        width,
        height,
        MAX_COLOUR_CAPACITY
      );

      state.palette = palette;
      state.assignments = assignments;
      state.prepared = true;
      state.previewDataUrl = hiddenCanvas.toDataURL('image/png');
      state.commandCache = null;
      const usage = new Float64Array(palette.length);
      for (let i = 0; i < assignments.length; i++) {
        const paletteIndex = assignments[i];
        if (paletteIndex !== 0xffff && usage[paletteIndex] !== undefined) {
          usage[paletteIndex] += 1;
        }
      }
      state.paletteUsage = Array.from(usage);
      state.metrics.pixelCount = width * height;
      state.metrics.paletteCount = palette.length;
      state.metrics.estimatedStrokes = 0;
      state.metrics.estimatedDurationMs = 0;
      state.metrics.scaleFactor = 0;
      state.metrics.boardWidth = 0;
      state.metrics.boardHeight = 0;
      state.metrics.targetWidth = 0;
      state.metrics.targetHeight = 0;
      state.metrics.selectionActive = false;
      renderPaletteSwatches(palette, state.paletteUsage);
      renderPaletteInsights(palette, state.paletteUsage);
      applyPanelThemeFromPalette(palette, state.paletteUsage);
      updateModeLabel();
      updateMetricsUI();
      ui.status.textContent = `Ready: ${width}×${height}px, ${palette.length} colours.`;
      await scheduleMetricsUpdate();
    } finally {
      ui.previewLoading.classList.remove('visible');
    }
  }

  async function waitForSocket(timeout = 5000) {
    const start = performance.now();
    while (performance.now() - start < timeout) {
      const socket = wsBridge.getSocket();
      if (socket && socket.readyState === WebSocket.OPEN) {
        return socket;
      }
      await wait(120);
    }
    return null;
  }



  function buildPixelCommands(canvasWidth, canvasHeight) {
    const assignments = state.assignments;
    const palette = state.palette;
    const width = state.pixelWidth;
    const height = state.pixelHeight;
    const imageData = state.sourceImageData;

    if (
      !assignments ||
      !palette.length ||
      !width ||
      !height ||
      !canvasWidth ||
      !canvasHeight
    ) {
      return [];
    }

    const boardWidth = canvasWidth;
    const boardHeight = canvasHeight;
    let targetX = 0;
    let targetY = 0;
    let targetWidth = boardWidth;
    let targetHeight = boardHeight;
    let selectionActive = false;

    if (state.selection) {
      const sel = state.selection;
      const normWidth = clamp(sel.normWidth ?? 1, 1 / Math.max(1, boardWidth), 1);
      const normHeight = clamp(sel.normHeight ?? 1, 1 / Math.max(1, boardHeight), 1);
      const normX = clamp(sel.normX ?? 0, 0, 1 - normWidth);
      const normY = clamp(sel.normY ?? 0, 0, 1 - normHeight);
      targetWidth = Math.max(1, normWidth * boardWidth);
      targetHeight = Math.max(1, normHeight * boardHeight);
      targetX = clamp(normX * boardWidth, 0, Math.max(0, boardWidth - targetWidth));
      targetY = clamp(normY * boardHeight, 0, Math.max(0, boardHeight - targetHeight));
      selectionActive = true;
      sel.boardWidth = boardWidth;
      sel.boardHeight = boardHeight;
    }

    const scaleX = targetWidth / width;
    const scaleY = targetHeight / height;
    const scale = Math.min(scaleX, scaleY);
    const drawWidth = width * scale;
    const drawHeight = height * scale;
    const offsetX = clamp(targetX + (targetWidth - drawWidth) / 2, 0, Math.max(0, boardWidth - drawWidth));
    const offsetY = clamp(targetY + (targetHeight - drawHeight) / 2, 0, Math.max(0, boardHeight - drawHeight));

    state.metrics.scaleFactor = scale;
    state.metrics.boardWidth = boardWidth;
    state.metrics.boardHeight = boardHeight;
    state.metrics.targetWidth = targetWidth;
    state.metrics.targetHeight = targetHeight;
    state.metrics.selectionActive = selectionActive;

    const settingsSignature = getSettingsSignature();
    const selectionSignature = getSelectionSignature();
    const cacheKey = `${width}x${height}|${boardWidth}x${boardHeight}|${targetWidth.toFixed(2)}x${targetHeight.toFixed(2)}|${settingsSignature}|${selectionSignature}`;
    if (state.commandCache && state.commandCache.key === cacheKey) {
      Object.assign(state.metrics, state.commandCache.metrics);
      updateMetricsUI();
      updateSelectionUI();
      return state.commandCache.commands;
    }

    const colourCommands = Array.from({ length: palette.length }, () => []);
    const paletteProfiles = palette.map((colour) => computeColourProfile(colour));
    const colourCoverage = new Float64Array(palette.length);
    const phaseOrder = {
      fill: 0,
      'fill-secondary': 1,
      detail: 2,
      'detail-edge': 3,
      glaze: 4,
      texture: 5,
      echo: 6,
    };

    const alphaData = imageData?.data ?? null;
    const detailMask = new Uint8Array(width * height);
    if (alphaData) {
      const threshold = 4200;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = y * width + x;
          const paletteIndex = assignments[idx];
          if (paletteIndex === 0xffff) {
            continue;
          }
          const offset = idx * 4;
          const r = alphaData[offset];
          const g = alphaData[offset + 1];
          const b = alphaData[offset + 2];

          let maxDiff = 0;
          if (x > 0) {
            const left = offset - 4;
            maxDiff = Math.max(
              maxDiff,
              perceptualColourDistance(r, g, b, alphaData[left], alphaData[left + 1], alphaData[left + 2])
            );
          }
          if (x + 1 < width) {
            const right = offset + 4;
            maxDiff = Math.max(
              maxDiff,
              perceptualColourDistance(r, g, b, alphaData[right], alphaData[right + 1], alphaData[right + 2])
            );
          }
          if (y > 0) {
            const up = offset - width * 4;
            maxDiff = Math.max(
              maxDiff,
              perceptualColourDistance(r, g, b, alphaData[up], alphaData[up + 1], alphaData[up + 2])
            );
          }
          if (y + 1 < height) {
            const down = offset + width * 4;
            maxDiff = Math.max(
              maxDiff,
              perceptualColourDistance(r, g, b, alphaData[down], alphaData[down + 1], alphaData[down + 2])
            );
          }

          if (maxDiff > threshold) {
            detailMask[idx] = 1;
          }
        }
      }
    }

    const edgeMask = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const paletteIndex = assignments[idx];
        if (paletteIndex === 0xffff) {
          continue;
        }
        let isEdge = false;
        if (x > 0) {
          const neighbour = assignments[idx - 1];
          if (neighbour !== paletteIndex && neighbour !== 0xffff) {
            isEdge = true;
          }
        }
        if (x + 1 < width) {
          const neighbour = assignments[idx + 1];
          if (neighbour !== paletteIndex && neighbour !== 0xffff) {
            isEdge = true;
          }
        }
        if (y > 0) {
          const neighbour = assignments[idx - width];
          if (neighbour !== paletteIndex && neighbour !== 0xffff) {
            isEdge = true;
          }
        }
        if (y + 1 < height) {
          const neighbour = assignments[idx + width];
          if (neighbour !== paletteIndex && neighbour !== 0xffff) {
            isEdge = true;
          }
        }
        if (isEdge) {
          edgeMask[idx] = 1;
        }
      }
    }

    const pushStroke = (paletteIndex, x1, y1, x2, y2, orientation, phase = 'fill') => {
      if (paletteIndex < 0 || paletteIndex >= colourCommands.length) {
        return;
      }

      const minX = Math.min(x1, x2);
      const maxX = Math.max(x1, x2);
      const minY = Math.min(y1, y2);
      const maxY = Math.max(y1, y2);

      if (maxX <= 0 || maxY <= 0 || minX >= boardWidth || minY >= boardHeight) {
        return;
      }

      let nx1 = clamp(x1 / boardWidth, 0, 1);
      let ny1 = clamp(y1 / boardHeight, 0, 1);
      let nx2 = clamp(x2 / boardWidth, 0, 1);
      let ny2 = clamp(y2 / boardHeight, 0, 1);

      const epsilonX = boardWidth > 0 ? 0.75 / boardWidth : 0;
      const epsilonY = boardHeight > 0 ? 0.75 / boardHeight : 0;

      if (Math.abs(nx1 - nx2) < 1e-5) {
        nx2 = clamp(nx2 + (nx2 >= nx1 ? epsilonX : -epsilonX), 0, 1);
      }
      if (Math.abs(ny1 - ny2) < 1e-5) {
        ny2 = clamp(ny2 + (ny2 >= ny1 ? epsilonY : -epsilonY), 0, 1);
      }

      colourCommands[paletteIndex].push({
        nx1: nx1.toFixed(6),
        ny1: ny1.toFixed(6),
        nx2: nx2.toFixed(6),
        ny2: ny2.toFixed(6),
        orientation,
        phase,
      });
    };

    const smoothingPercent = state.settings.smoothnessPercent ?? 40;
    const laneMultiplier = state.settings.laneFanMultiplier ?? 100;
    const coverageBoost = (state.settings.coverageBoost ?? 100) / 100;
    const detailMode = state.settings.detailMode || 'balanced';
    const allowLowRes = state.settings.lowResEnhancer !== false;
    const allowEdgeDetail = state.settings.edgeDetail !== false;
    const allowMicroDetail = state.settings.microDetail !== false;
    const spectralBoost = Math.max(10, state.settings.spectralBoost ?? 120) / 100;
    const highlightGlaze = state.settings.highlightGlaze !== false;
    const weaveEnabled = state.settings.textureWeave === true;
    const gradientEcho = state.settings.gradientEcho !== false;

    const baseLaneSpacing = (() => {
      if (scale >= 24) {
        return 0.95;
      }
      if (scale >= 12) {
        return 0.88;
      }
      if (scale >= 6) {
        return 0.78;
      }
      return 0.64;
    })();

    const smoothingFactor = 1 + smoothingPercent / 100;
    const laneDensityFactor = Math.max(10, laneMultiplier) / 100;
    const laneSpacing = (baseLaneSpacing / smoothingFactor) / laneDensityFactor;

    const coveragePad = Math.min(
      scale * 0.45 * coverageBoost,
      Math.max(0.9, baseLaneSpacing * 1.5 * coverageBoost)
    );
    const detailMultiplier = detailMode === 'max' ? 1.35 : detailMode === 'minimal' ? 0.75 : 1;
    const detailLaneOffset = Math.min(
      scale * 0.28 * detailMultiplier,
      Math.max(0.45, baseLaneSpacing * 1.4 * detailMultiplier)
    );
    const microThreshold = detailMode === 'max' ? 4 : detailMode === 'minimal' ? 1 : 2;

    let laneCount = Math.max(1, Math.ceil((scale + laneSpacing * 0.5) / laneSpacing));
    if (allowLowRes) {
      if (scale < 1.5) {
        laneCount = Math.max(laneCount, 5);
      } else if (scale < 2.5) {
        laneCount = Math.max(laneCount, 4);
      } else if (scale < 4) {
        laneCount = Math.max(laneCount, 3);
      }
    }

    const laneOffsets = [];
    if (laneCount === 1) {
      laneOffsets.push(0);
    } else {
      const totalSpan = (laneCount - 1) * laneSpacing;
      const startOffset = -totalSpan / 2;
      for (let laneIndex = 0; laneIndex < laneCount; laneIndex++) {
        laneOffsets.push(startOffset + laneIndex * laneSpacing);
      }
    }
    state.metrics.laneCount = laneOffsets.length;

    for (let y = 0; y < height; y++) {
      let x = 0;
      while (x < width) {
        const idx = y * width + x;
        const paletteIndex = assignments[idx];
        if (paletteIndex === 0xffff) {
          x += 1;
          continue;
        }

        let runStart = x;
        let runEnd = x;
        let runDetail = false;
        let runEdge = false;
        while (runEnd < width && assignments[y * width + runEnd] === paletteIndex) {
          const runIdx = y * width + runEnd;
          if (detailMask[runIdx]) {
            runDetail = true;
          }
          if (edgeMask[runIdx]) {
            runEdge = true;
          }
          runEnd += 1;
        }

        const runLength = runEnd - runStart;
        const startX = offsetX + runStart * scale - coveragePad;
        const endX = offsetX + runEnd * scale + coveragePad;
        const centerY = offsetY + (y + 0.5) * scale;
        const profile = paletteProfiles[paletteIndex] || null;

        colourCoverage[paletteIndex] += runLength * laneOffsets.length;

        laneOffsets.forEach((laneOffset, laneIndex) => {
          pushStroke(
            paletteIndex,
            startX,
            centerY + laneOffset,
            endX,
            centerY + laneOffset,
            laneIndex === 0 ? 'run-primary' : 'run-lane',
            laneIndex === 0 ? 'fill' : 'fill-secondary'
          );
        });

        if (allowMicroDetail && runLength <= microThreshold) {
          const centerX = offsetX + (runStart + runLength / 2) * scale;
          const microHalf = Math.max(scale * 0.55, 0.85);
          pushStroke(
            paletteIndex,
            centerX - microHalf,
            centerY,
            centerX + microHalf,
            centerY,
            'micro-detail',
            'detail'
          );
        } else if ((runDetail && detailMode !== 'minimal') || (runEdge && allowEdgeDetail)) {
          pushStroke(
            paletteIndex,
            startX,
            centerY + detailLaneOffset,
            endX,
            centerY + detailLaneOffset,
            'detail-offset',
            'detail'
          );
        }

        if (runEdge && allowEdgeDetail) {
          const centerX = offsetX + (runStart + runLength / 2) * scale;
          const edgeHalf = Math.max(scale * 0.6, 0.9);
          pushStroke(
            paletteIndex,
            centerX - edgeHalf,
            centerY,
            centerX + edgeHalf,
            centerY,
            'edge-center',
            'detail-edge'
          );
        }

        let extraCoverage = 0;
        if (highlightGlaze && profile && profile.value > 0.62) {
          const glazeOffset = Math.max(scale * 0.35, detailLaneOffset * 0.45);
          pushStroke(
            paletteIndex,
            startX,
            centerY - glazeOffset,
            endX,
            centerY - glazeOffset,
            'glaze-upper',
            'glaze'
          );
          pushStroke(
            paletteIndex,
            startX,
            centerY + glazeOffset,
            endX,
            centerY + glazeOffset,
            'glaze-lower',
            'glaze'
          );
          extraCoverage += runLength * spectralBoost * 0.65;
        }

        if (gradientEcho && (runDetail || runEdge)) {
          const echoOffset = Math.max(scale * 0.42, detailLaneOffset * 0.6);
          pushStroke(
            paletteIndex,
            startX,
            centerY - echoOffset,
            endX,
            centerY - echoOffset,
            'echo-upper',
            'echo'
          );
          pushStroke(
            paletteIndex,
            startX,
            centerY + echoOffset,
            endX,
            centerY + echoOffset,
            'echo-lower',
            'echo'
          );
          extraCoverage += runLength * 0.55;
        }

        if (weaveEnabled && profile && profile.saturation > 0.4) {
          const weaveStep = Math.max(1, Math.round(4 / Math.max(0.5, spectralBoost)));
          const weaveSpan = Math.max(scale * 0.6, 0.9);
          const weaveTail = Math.max(scale * 0.3, 0.5);
          let weaveCount = 0;
          for (let px = runStart, alt = 0; px < runEnd; px += weaveStep, alt += 1) {
            const centerX = offsetX + (px + 0.5) * scale;
            const direction = alt % 2 === 0 ? 1 : -1;
            pushStroke(
              paletteIndex,
              centerX - weaveSpan,
              centerY - weaveTail * direction,
              centerX + weaveSpan,
              centerY + weaveTail * direction,
              'texture-weave',
              'texture'
            );
            weaveCount += 1;
          }
          if (weaveCount) {
            extraCoverage += runLength * 0.25 * spectralBoost + weaveCount * 0.6;
          }
        }

        if (extraCoverage > 0) {
          colourCoverage[paletteIndex] += extraCoverage;
        }

        x = runEnd;
      }
    }

    const paletteEntries = palette.map((colour, index) => ({
      index,
      coverage: colourCoverage[index],
      luminance: 0.2126 * colour.r + 0.7152 * colour.g + 0.0722 * colour.b,
    }));

    const sortMode = state.paletteSortMode || 'dark-first';
    paletteEntries.sort((a, b) => {
      if (sortMode === 'light-first') {
        if (b.luminance !== a.luminance) {
          return b.luminance - a.luminance;
        }
        return b.coverage - a.coverage;
      }
      if (sortMode === 'coverage') {
        if (b.coverage !== a.coverage) {
          return b.coverage - a.coverage;
        }
        return a.luminance - b.luminance;
      }
      if (a.luminance !== b.luminance) {
        return a.luminance - b.luminance;
      }
      return b.coverage - a.coverage;
    });

    const paletteOrder = paletteEntries.map((entry) => entry.index);

    const commands = [];
    for (const paletteIndex of paletteOrder) {
      const colour = palette[paletteIndex];
      const strokes = colourCommands[paletteIndex];
      strokes.sort((a, b) => (phaseOrder[a.phase] ?? 99) - (phaseOrder[b.phase] ?? 99));
      for (const stroke of strokes) {
        const { phase: _phase, ...rest } = stroke;
        commands.push({
          color: colour.hex,
          ...rest,
          pass: 'forward',
        });
      }
    }

    state.metrics.estimatedStrokes = commands.length;
    state.metrics.estimatedDurationMs = commands.length * 8;
    const metricsSnapshot = {
      pixelCount: state.metrics.pixelCount,
      paletteCount: palette.length,
      estimatedStrokes: state.metrics.estimatedStrokes,
      estimatedDurationMs: state.metrics.estimatedDurationMs,
      laneCount: state.metrics.laneCount,
      scaleFactor: scale,
      boardWidth,
      boardHeight,
      targetWidth,
      targetHeight,
      selectionActive,
    };
    Object.assign(state.metrics, metricsSnapshot);
    state.commandCache = { key: cacheKey, commands, metrics: metricsSnapshot };
    updateMetricsUI();
    updateSelectionUI();
    renderPaletteInsights(palette, state.paletteUsage);

    return commands;
  }

  async function streamCommands(commands, socket, delayMs) {
    const total = commands.length;
    let completed = 0;
    ui.progressBar.style.width = '0%';

    for (const command of commands) {
      ensureNotAborted();
      try {
        socket.send(
          `42["drawcmd",0,[${command.nx1},${command.ny1},${command.nx2},${command.ny2},false,-1,"${command.color}",0,0,{}]]`
        );
      } catch (err) {
        console.warn('drawaria image autodraw: socket send failed', err);
      }
      completed += 1;
      if (completed % 50 === 0 || completed === total) {
        const progress = (completed / total) * 100;
        ui.progressBar.style.width = `${progress}%`;
        ui.progressLabel.textContent = `${progress.toFixed(1)}%`;
        ui.status.textContent = `Drawing pixels… ${completed}/${total}`;
      }
      await wait(delayMs);
    }

    ui.progressBar.style.width = '100%';
    ui.progressLabel.textContent = '100%';
    ui.status.textContent = 'Drawing complete.';
  }

  async function runDrawing() {
    if (state.running) {
      return;
    }
    state.running = true;
    state.abortRequested = false;
    ui.startButton.disabled = true;
    ui.stopButton.disabled = false;
    ui.panel.classList.add('running');

    try {
      if (!state.prepared) {
        const file = ui.fileInput.files[0];
        await prepareFromFile(file);
      }
      ensureNotAborted();
      ui.status.textContent = 'Waiting for websocket…';
      const socket = await waitForSocket(5000);
      if (!socket) {
        throw new Error('Could not detect Drawaria websocket. Join a room and try again.');
      }
      const canvas = selectLargestCanvas();
      if (!canvas) {
        throw new Error('Canvas not found. Wait for Drawaria to finish loading.');
      }
      ensureNotAborted();
      ui.status.textContent = 'Mapping pixels to strokes…';
      await wait(10);
      const commands = buildPixelCommands(canvas.width, canvas.height);
      if (!commands.length) {
        throw new Error('No drawable pixels were detected.');
      }
      ensureNotAborted();
      ui.status.textContent = `Streaming ${commands.length} pixels…`;
      await streamCommands(commands, socket, 8);
      ensureNotAborted();
      ui.status.textContent = 'Image rendered successfully!';
    } catch (err) {
      if (err instanceof AbortPainting) {
        ui.status.textContent = 'Drawing aborted.';
      } else {
        console.error('drawaria image autodraw: error', err);
        ui.status.textContent = `Error: ${err.message || err}`;
      }
    } finally {
      state.running = false;
      state.abortRequested = false;
      ui.startButton.disabled = false;
      ui.stopButton.disabled = true;
      ui.panel.classList.remove('running');
    }
  }

  function handleStop() {
    if (!state.running) {
      return;
    }
    state.abortRequested = true;
    ui.status.textContent = 'Finishing current stroke…';
  }

  async function handleStartClick() {
    if (!ui.fileInput.files.length && !state.prepared) {
      ui.status.textContent = 'Please choose an image before drawing.';
      ui.fileInput.classList.add('shake');
      setTimeout(() => ui.fileInput.classList.remove('shake'), 500);
      return;
    }
    await runDrawing();
  }

  async function handleGeneratePreview() {
    const file = ui.fileInput.files[0];
    try {
      await prepareFromFile(file);
      if (state.settings.autoStart && !state.running) {
        ui.status.textContent = 'Auto start enabled — beginning draw…';
        await runDrawing();
      }
    } catch (err) {
      console.error('drawaria image autodraw: preview error', err);
      ui.status.textContent = `Error: ${err.message || err}`;
      ui.previewLoading.classList.remove('visible');
    }
  }

  const handleFileChange = () => {
    state.prepared = false;
    state.commandCache = null;
    if (ui.fileInput.files.length) {
      handleGeneratePreview();
    } else {
      ui.status.textContent = 'Select an image to begin (max 500px).';
      ui.paletteStrip.innerHTML = '';
      ui.paletteSummary.textContent = '0 colours';
      if (ui.paletteSummarySecondary) {
        ui.paletteSummarySecondary.textContent = '0 colours';
      }
      ui.progressBar.style.width = '0%';
      ui.progressLabel.textContent = '0%';
      applyPanelThemeFromPalette([], []);
      renderPaletteInsights([], []);
      updateMetricsUI();
    }
  };

  ui.fileInput.addEventListener('change', handleFileChange);
  registerCleanup(() => ui.fileInput.removeEventListener('change', handleFileChange));

  const handleDimensionInput = () => {
    ui.dimensionValue.textContent = `${ui.dimensionInput.value}px`;
    state.prepared = false;
    state.commandCache = null;
    if (ui.fileInput.files.length) {
      ui.status.textContent = 'Dimension changed — regenerate preview.';
    }
  };

  ui.dimensionInput.addEventListener('input', handleDimensionInput);
  registerCleanup(() => ui.dimensionInput.removeEventListener('input', handleDimensionInput));

  const handlePaletteOrderChange = () => {
    state.paletteSortMode = ui.paletteOrderSelect.value;
    state.commandCache = null;
    if (state.prepared) {
      const labelMap = {
        'dark-first': 'Dark → Light',
        'light-first': 'Light → Dark',
        coverage: 'Coverage Priority',
      };
      ui.status.textContent = `Colour order set to ${labelMap[state.paletteSortMode] || state.paletteSortMode}.`;
      scheduleMetricsUpdate();
    }
  };

  ui.paletteOrderSelect.addEventListener('change', handlePaletteOrderChange);
  registerCleanup(() => ui.paletteOrderSelect.removeEventListener('change', handlePaletteOrderChange));

  if (ui.selectRegionButton) {
    const handleSelectRegion = () => beginCanvasSelection();
    ui.selectRegionButton.addEventListener('click', handleSelectRegion);
    registerCleanup(() => ui.selectRegionButton.removeEventListener('click', handleSelectRegion));
  }

  if (ui.clearRegionButton) {
    const handleClearRegion = () => clearCanvasSelection();
    ui.clearRegionButton.addEventListener('click', handleClearRegion);
    registerCleanup(() => ui.clearRegionButton.removeEventListener('click', handleClearRegion));
  }

  function bindSlider(input, valueEl, key, suffix = '%', options = {}) {
    if (!input || !valueEl) {
      return;
    }
    if (state.settings[key] != null) {
      input.value = state.settings[key];
    }
    const update = () => {
      const rawValue = Number(input.value);
      const value = Number.isFinite(rawValue) ? rawValue : 0;
      valueEl.textContent = `${value}${suffix}`;
      state.settings[key] = value;
      if (options.onChange) {
        options.onChange(value);
      }
      if (options.requiresReprepare) {
        state.prepared = false;
        state.commandCache = null;
        ui.status.textContent = `${options.label || 'Setting'} changed — regenerate preview.`;
      } else {
        state.commandCache = null;
        if (state.prepared) {
          scheduleMetricsUpdate();
        }
      }
      updateModeLabel();
    };
    input.addEventListener('input', update);
    registerCleanup(() => input.removeEventListener('input', update));
    update();
  }

  function bindToggle(button, key, options = {}) {
    if (!button) {
      return;
    }
    const applyState = (active) => {
      button.dataset.active = active ? 'true' : 'false';
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      state.settings[key] = active;
      if (options.onChange) {
        options.onChange(active);
      }
      if (options.requiresReprepare) {
        state.prepared = false;
        state.commandCache = null;
        ui.status.textContent = `${options.label || 'Setting'} changed — regenerate preview.`;
      } else {
        state.commandCache = null;
        if (state.prepared) {
          scheduleMetricsUpdate();
        }
      }
      updateModeLabel();
    };
    const handleClick = () => {
      const nextState = button.dataset.active !== 'true';
      applyState(nextState);
    };
    button.addEventListener('click', handleClick);
    registerCleanup(() => button.removeEventListener('click', handleClick));
    const initial = options.initial !== undefined ? options.initial : state.settings[key] !== false;
    applyState(initial);
  }

  function bindFunSlider(input, valueEl, key) {
    if (!input || !valueEl) {
      return;
    }
    if (funSettings[key] != null) {
      input.value = funSettings[key];
    }
    const update = () => {
      const rawValue = Number(input.value);
      const value = Number.isFinite(rawValue) ? rawValue : 0;
      funSettings[key] = value;
      valueEl.textContent = `${value}`;
    };
    input.addEventListener('input', update);
    registerCleanup(() => input.removeEventListener('input', update));
    update();
  }

  function bindFunToggle(button, key) {
    if (!button) {
      return;
    }
    const apply = (active) => {
      const stateValue = !!active;
      button.dataset.active = stateValue ? 'true' : 'false';
      button.setAttribute('aria-pressed', stateValue ? 'true' : 'false');
      funSettings[key] = stateValue;
    };
    const handleClick = () => {
      apply(button.dataset.active !== 'true');
    };
    button.addEventListener('click', handleClick);
    registerCleanup(() => button.removeEventListener('click', handleClick));
    apply(funSettings[key]);
  }

  bindSlider(ui.smoothnessInput, ui.smoothnessValue, 'smoothnessPercent');
  bindSlider(ui.laneDensityInput, ui.laneDensityValue, 'laneFanMultiplier');
  bindSlider(ui.coverageInput, ui.coverageValue, 'coverageBoost');
  bindSlider(ui.ditherInput, ui.ditherValue, 'ditherStrength', '%', {
    requiresReprepare: true,
    label: 'Dither strength',
  });
  bindSlider(ui.spectralInput, ui.spectralValue, 'spectralBoost');

  if (ui.detailModeSelect) {
    ui.detailModeSelect.value = state.settings.detailMode;
    const handleDetailModeChange = () => {
      state.settings.detailMode = ui.detailModeSelect.value;
      state.commandCache = null;
      updateModeLabel();
      if (state.prepared) {
        scheduleMetricsUpdate();
      }
    };
    ui.detailModeSelect.addEventListener('change', handleDetailModeChange);
    registerCleanup(() => ui.detailModeSelect.removeEventListener('change', handleDetailModeChange));
  }

  bindToggle(ui.toggleLowRes, 'lowResEnhancer', { label: 'Low-res enhancer' });
  bindToggle(ui.toggleEdge, 'edgeDetail', { label: 'Edge emphasis' });
  bindToggle(ui.toggleMicro, 'microDetail', { label: 'Micro detail' });
  bindToggle(ui.toggleGlaze, 'highlightGlaze', { label: 'Glow glazing' });
  bindToggle(ui.toggleWeave, 'textureWeave', { label: 'Texture weave' });
  bindToggle(ui.toggleEcho, 'gradientEcho', { label: 'Gradient echo' });
  bindToggle(ui.toggleTheme, 'adaptiveTheme', {
    label: 'Adaptive theme',
    onChange(active) {
      applyPanelThemeFromPalette(active ? state.palette : [], active ? state.paletteUsage : []);
    },
  });

  bindFunSlider(ui.funDensityInput, ui.funDensityValue, 'density');
  bindFunSlider(ui.funTempoInput, ui.funTempoValue, 'tempo');
  bindFunToggle(ui.funMirrorToggle, 'mirror');
  bindFunToggle(ui.funJitterToggle, 'jitter');

  if (ui.funModeSelect) {
    const handleFunModeChange = () => {
      updateFunDescription();
      const effect = funFeatures[ui.funModeSelect.value];
      if (effect) {
        updateFunStatus(`${effect.label} ready — press play.`);
      } else {
        updateFunStatus('Select an effect and press play.');
      }
    };
    ui.funModeSelect.addEventListener('change', handleFunModeChange);
    registerCleanup(() => ui.funModeSelect.removeEventListener('change', handleFunModeChange));
    handleFunModeChange();
  } else {
    updateFunDescription();
    updateFunStatus('Select an effect and press play.');
  }

  if (ui.funRunButton) {
    const handleFunRun = () => {
      startFunEffect();
    };
    ui.funRunButton.addEventListener('click', handleFunRun);
    registerCleanup(() => ui.funRunButton.removeEventListener('click', handleFunRun));
  }

  if (ui.funStopButton) {
    const handleFunStop = () => {
      stopFunEffect();
    };
    ui.funStopButton.addEventListener('click', handleFunStop);
    registerCleanup(() => ui.funStopButton.removeEventListener('click', handleFunStop));
    ui.funStopButton.disabled = true;
  }

  updateFunProgress(0);

  if (ui.toggleAutoStart) {
    const setAutoStart = (active) => {
      ui.toggleAutoStart.dataset.active = active ? 'true' : 'false';
      ui.toggleAutoStart.setAttribute('aria-pressed', active ? 'true' : 'false');
      state.settings.autoStart = active;
    };
    const handleAutoStart = () => {
      const next = ui.toggleAutoStart.dataset.active !== 'true';
      setAutoStart(next);
      ui.status.textContent = next
        ? 'Auto start enabled — previews will launch drawing automatically.'
        : 'Auto start disabled.';
    };
    ui.toggleAutoStart.addEventListener('click', handleAutoStart);
    registerCleanup(() => ui.toggleAutoStart.removeEventListener('click', handleAutoStart));
    setAutoStart(state.settings.autoStart);
  }

  ui.previewButton.addEventListener('click', handleGeneratePreview);
  registerCleanup(() => ui.previewButton.removeEventListener('click', handleGeneratePreview));

  ui.startButton.addEventListener('click', handleStartClick);
  registerCleanup(() => ui.startButton.removeEventListener('click', handleStartClick));

  ui.stopButton.addEventListener('click', handleStop);
  registerCleanup(() => ui.stopButton.removeEventListener('click', handleStop));

  ui.closeButton.addEventListener('click', () => {
    state.abortRequested = true;
    runCleanup();
  });

  const socketWatcher = setInterval(() => {
    const socket = wsBridge.getSocket();
    let status = 'searching';
    let label = 'Socket: searching…';
    if (socket) {
      if (socket.readyState === WebSocket.OPEN) {
        status = 'connected';
        label = 'Socket: live';
      } else if (socket.readyState === WebSocket.CONNECTING) {
        status = 'searching';
        label = 'Socket: connecting…';
      } else {
        status = 'offline';
        label = 'Socket: offline';
      }
    }
    if (ui.socketChip && ui.socketChip.dataset.status !== status) {
      ui.socketChip.dataset.status = status;
    }
    if (ui.socketLabel && ui.socketLabel.textContent !== label) {
      ui.socketLabel.textContent = label;
    }
  }, 600);
  registerCleanup(() => clearInterval(socketWatcher));

  const handleExportPreview = () => {
    if (!state.previewDataUrl) {
      ui.status.textContent = 'Generate a preview before exporting.';
      return;
    }
    const link = document.createElement('a');
    link.href = state.previewDataUrl;
    const fileName = `autodraw-${state.pixelWidth || 'image'}x${state.pixelHeight || ''}.png`;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    ui.status.textContent = 'Preview PNG downloaded.';
  };

  if (ui.exportPreviewButton) {
    ui.exportPreviewButton.addEventListener('click', handleExportPreview);
    registerCleanup(() => ui.exportPreviewButton.removeEventListener('click', handleExportPreview));
  }

  const handleCopyPalette = async () => {
    if (!state.palette.length) {
      ui.status.textContent = 'No palette to copy yet — load an image first.';
      return;
    }
    const paletteText = state.palette.map((colour) => colour.hex).join('\n');
    try {
      await navigator.clipboard.writeText(paletteText);
      ui.status.textContent = 'Palette copied to clipboard.';
    } catch (err) {
      try {
        const textarea = document.createElement('textarea');
        textarea.value = paletteText;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        ui.status.textContent = 'Palette copied to clipboard.';
      } catch (fallbackErr) {
        console.warn('drawaria image autodraw: clipboard copy failed', err, fallbackErr);
        ui.status.textContent = 'Clipboard copy failed. Please copy manually from the console.';
      }
    }
  };

  if (ui.copyPaletteButton) {
    ui.copyPaletteButton.addEventListener('click', handleCopyPalette);
    registerCleanup(() => ui.copyPaletteButton.removeEventListener('click', handleCopyPalette));
  }

  applyPanelThemeFromPalette(state.palette, state.paletteUsage);
  renderPaletteInsights(state.palette, state.paletteUsage);
  updateModeLabel();
  updateMetricsUI();

  window[SCRIPT_HANDLE] = {
    cleanup: runCleanup,
    state,
  };

  ui.status.textContent = 'Select an image to begin (max 500px).';
  updateSelectionUI();

  function selectLargestCanvas() {
    const canvases = Array.from(document.querySelectorAll('canvas'));
    if (!canvases.length) {
      return null;
    }
    return canvases.reduce((largest, candidate) => {
      const largestArea = largest.width * largest.height;
      const candidateArea = candidate.width * candidate.height;
      return candidateArea > largestArea ? candidate : largest;
    }, canvases[0]);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  let activeSelectionTeardown = null;

  function clearActiveSelectionOverlay() {
    if (activeSelectionTeardown) {
      try {
        activeSelectionTeardown();
      } catch (err) {
        console.warn('drawaria image autodraw: selection overlay cleanup failed', err);
      }
      activeSelectionTeardown = null;
    }
  }

  function beginCanvasSelection() {
    if (state.running) {
      ui.status.textContent = 'Stop the current render before selecting a region.';
      return;
    }
    const canvas = selectLargestCanvas();
    if (!canvas) {
      ui.status.textContent = 'Canvas not found — join a room before selecting a region.';
      return;
    }

    clearActiveSelectionOverlay();

    const rect = canvas.getBoundingClientRect();
    const overlay = document.createElement('div');
    overlay.id = 'pxa-selection-overlay';
    overlay.style.left = `${rect.left}px`;
    overlay.style.top = `${rect.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;

    const selectionBox = document.createElement('div');
    selectionBox.id = 'pxa-selection-box';
    selectionBox.style.display = 'none';
    overlay.appendChild(selectionBox);

    document.body.appendChild(overlay);
    ui.status.textContent = 'Drag a rectangle to place the artwork.';

    let dragging = false;
    let startX = 0;
    let startY = 0;

    const clampToOverlay = (value, axis) => {
      const bounds = overlay.getBoundingClientRect();
      if (axis === 'x') {
        return clamp(value, bounds.left, bounds.right);
      }
      return clamp(value, bounds.top, bounds.bottom);
    };

    const updateBox = (currentX, currentY) => {
      const bounds = overlay.getBoundingClientRect();
      const clampedX = clampToOverlay(currentX, 'x');
      const clampedY = clampToOverlay(currentY, 'y');
      const left = Math.min(startX, clampedX) - bounds.left;
      const top = Math.min(startY, clampedY) - bounds.top;
      const width = Math.max(1, Math.abs(clampedX - startX));
      const height = Math.max(1, Math.abs(clampedY - startY));
      selectionBox.style.left = `${left}px`;
      selectionBox.style.top = `${top}px`;
      selectionBox.style.width = `${width}px`;
      selectionBox.style.height = `${height}px`;
      selectionBox.style.display = 'block';
    };

    const finishSelection = (apply) => {
      window.removeEventListener('mousemove', handlePointerMove, true);
      window.removeEventListener('mouseup', handlePointerUp, true);
      window.removeEventListener('keydown', handleKeyDown, true);

      if (!apply || !dragging) {
        overlay.remove();
        activeSelectionTeardown = null;
        if (apply) {
          ui.status.textContent = 'Canvas region selection cancelled.';
        }
        return;
      }

      const bounds = overlay.getBoundingClientRect();
      const cssWidth = bounds.width || 1;
      const cssHeight = bounds.height || 1;
      const boxRect = selectionBox.getBoundingClientRect();
      const leftPx = clamp(boxRect.left - bounds.left, 0, cssWidth);
      const topPx = clamp(boxRect.top - bounds.top, 0, cssHeight);
      const widthPx = clamp(boxRect.width, 1, cssWidth);
      const heightPx = clamp(boxRect.height, 1, cssHeight);

      const normX = leftPx / cssWidth;
      const normY = topPx / cssHeight;
      const normWidth = widthPx / cssWidth;
      const normHeight = heightPx / cssHeight;

      overlay.remove();
      activeSelectionTeardown = null;

      if (normWidth >= 0.995 && normHeight >= 0.995 && normX <= 0.002 && normY <= 0.002) {
        state.selection = null;
        ui.status.textContent = 'Canvas region reset to full coverage.';
      } else {
        state.selection = {
          normX,
          normY,
          normWidth,
          normHeight,
          boardWidth: canvas.width,
          boardHeight: canvas.height,
        };
        ui.status.textContent = `Region locked (${Math.round(normWidth * canvas.width)}×${Math.round(normHeight * canvas.height)}px).`;
      }

      state.commandCache = null;
      updateSelectionUI();
      if (state.prepared) {
        scheduleMetricsUpdate();
      }
    };

    const handlePointerDown = (event) => {
      if (event.button !== 0) {
        return;
      }
      dragging = true;
      startX = clampToOverlay(event.clientX, 'x');
      startY = clampToOverlay(event.clientY, 'y');
      updateBox(event.clientX, event.clientY);
      event.preventDefault();
    };

    const handlePointerMove = (event) => {
      if (!dragging) {
        return;
      }
      updateBox(event.clientX, event.clientY);
      event.preventDefault();
    };

    const handlePointerUp = (event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      finishSelection(true);
    };

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finishSelection(false);
      }
    };

    overlay.addEventListener('mousedown', handlePointerDown, { capture: true, passive: false });
    window.addEventListener('mousemove', handlePointerMove, true);
    window.addEventListener('mouseup', handlePointerUp, true);
    window.addEventListener('keydown', handleKeyDown, true);

    activeSelectionTeardown = () => {
      overlay.removeEventListener('mousedown', handlePointerDown, true);
      window.removeEventListener('mousemove', handlePointerMove, true);
      window.removeEventListener('mouseup', handlePointerUp, true);
      window.removeEventListener('keydown', handleKeyDown, true);
      if (overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
      }
    };

  }

  function clearCanvasSelection() {
    clearActiveSelectionOverlay();
    if (!state.selection) {
      ui.status.textContent = 'Canvas region already at full coverage.';
      return;
    }
    state.selection = null;
    state.commandCache = null;
    state.metrics.selectionActive = false;
    state.metrics.targetWidth = state.metrics.boardWidth || 0;
    state.metrics.targetHeight = state.metrics.boardHeight || 0;
    updateSelectionUI();
    ui.status.textContent = 'Canvas region reset to full coverage.';
    if (state.prepared) {
      scheduleMetricsUpdate();
    }
  }

  registerCleanup(() => clearActiveSelectionOverlay());

  function createPanel() {
    const style = document.createElement('style');
    style.textContent = `
      #pxa-panel { position: fixed; top: 24px; right: 24px; width: 520px; max-width: calc(100vw - 40px); max-height: calc(100vh - 40px); z-index: 999999; font-family: 'Inter', 'Segoe UI', sans-serif; color: #0f172a; border-radius: 24px; overflow: hidden; box-shadow: 0 32px 110px rgba(15, 23, 42, 0.45); background: linear-gradient(165deg, rgba(15,23,42,0.92), rgba(15,23,42,0.88)), linear-gradient(140deg, var(--pxa-ambient, rgba(148,163,184,0.18)), rgba(226,232,240,0.9)); backdrop-filter: blur(30px); border: 1px solid rgba(148,163,184,0.28); --pxa-accent: #2563eb; --pxa-accent-soft: rgba(37,99,235,0.16); --pxa-accent-dark: #1e3a8a; --pxa-chip-bg: rgba(255,255,255,0.16); --pxa-ambient: rgba(148,163,184,0.22); display: flex; flex-direction: column; }
      #pxa-panel::before { content: ''; position: absolute; inset: 0; pointer-events: none; background: linear-gradient(120deg, rgba(255,255,255,0.08), transparent 45%, rgba(255,255,255,0.12)); opacity: 0.9; }
      #pxa-panel::after { content: ''; position: absolute; inset: -40%; background: radial-gradient(circle at 20% 20%, rgba(37,99,235,0.25), transparent 55%), radial-gradient(circle at 80% 10%, rgba(6,182,212,0.18), transparent 45%); filter: blur(0); opacity: 0.75; animation: pxa-ambient 18s ease-in-out infinite alternate; pointer-events: none; }
      #pxa-panel.running { box-shadow: 0 48px 140px rgba(37, 99, 235, 0.55); }
      @keyframes pxa-ambient { 0% { transform: rotate(0deg) scale(1); opacity: 0.8; } 50% { transform: rotate(6deg) scale(1.08); opacity: 0.9; } 100% { transform: rotate(-4deg) scale(1.02); opacity: 0.75; } }
      @media (prefers-reduced-motion: reduce) { #pxa-panel::after { animation: none; } }
      #pxa-head { position: relative; display: flex; align-items: flex-start; gap: 16px; padding: 20px 28px 16px; cursor: grab; color: white; }
      #pxa-logo { display: grid; place-items: center; width: 72px; height: 72px; border-radius: 22px; background: linear-gradient(140deg, rgba(255,255,255,0.18), rgba(255,255,255,0.02)); border: 1px solid rgba(255,255,255,0.24); box-shadow: inset 0 1px 12px rgba(15,23,42,0.45), 0 12px 34px rgba(15,23,42,0.4); font-weight: 700; letter-spacing: 0.12em; font-size: 14px; text-transform: uppercase; }
      #pxa-logo span { display: block; text-align: center; }
      #pxa-logo .pxa-logo-icon { font-size: 20px; }
      #pxa-logo .pxa-logo-sub { font-size: 11px; opacity: 0.7; letter-spacing: 0.24em; }
      #pxa-title { flex: 1; min-width: 0; padding-top: 6px; }
      #pxa-title h1 { margin: 0; font-size: 22px; letter-spacing: 0.08em; font-weight: 700; text-transform: uppercase; }
      #pxa-title p { margin: 6px 0 10px; font-size: 12px; opacity: 0.85; letter-spacing: 0.18em; text-transform: uppercase; }
      #pxa-headline-band { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 6px; }
      .pxa-chip { display: inline-flex; align-items: center; gap: 8px; padding: 6px 14px; border-radius: 999px; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; background: var(--pxa-chip-bg); border: 1px solid rgba(255,255,255,0.16); box-shadow: inset 0 1px 1px rgba(255,255,255,0.22); backdrop-filter: blur(12px); }
      .pxa-chip-dot { width: 8px; height: 8px; border-radius: 50%; background: #facc15; box-shadow: 0 0 0 6px rgba(250,204,21,0.18); position: relative; }
      #pxa-chip-socket[data-status="connected"] .pxa-chip-dot { background: #34d399; box-shadow: 0 0 0 6px rgba(52,211,153,0.22); }
      #pxa-chip-socket[data-status="offline"] .pxa-chip-dot { background: #f87171; box-shadow: 0 0 0 6px rgba(248,113,113,0.22); }
      #pxa-chip-socket[data-status="searching"] .pxa-chip-dot { animation: pxa-pulse 1.8s ease infinite; }
      @keyframes pxa-pulse { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.35); opacity: 0.6; } }
      .pxa-chip-icon { font-size: 13px; filter: drop-shadow(0 2px 6px rgba(15,23,42,0.45)); }
      #pxa-close { border: none; background: rgba(15,23,42,0.45); color: white; width: 38px; height: 38px; border-radius: 12px; font-size: 16px; cursor: pointer; transition: transform 0.2s ease, background 0.2s ease; box-shadow: 0 12px 22px rgba(15,23,42,0.4); }
      #pxa-close:hover { transform: translateY(-2px) scale(1.04); background: rgba(15,23,42,0.65); }
      #pxa-body { position: relative; padding: 0 28px 20px; display: flex; flex-direction: column; gap: 18px; flex: 1; overflow: hidden; }
      #pxa-body::before { content: ''; position: absolute; inset: 12px 18px 18px; border-radius: 22px; background: linear-gradient(150deg, rgba(248,250,252,0.94), rgba(226,232,240,0.82)); box-shadow: inset 0 1px 0 rgba(255,255,255,0.7); }
      #pxa-body::after { content: ''; position: absolute; inset: 20px 24px 24px; border-radius: 18px; background: linear-gradient(120deg, rgba(255,255,255,0.25), transparent 60%); opacity: 0.35; pointer-events: none; }
      #pxa-body > * { position: relative; z-index: 2; }
      #pxa-scroll-area { position: relative; flex: 1; overflow-y: auto; padding: 12px 4px 16px 4px; display: flex; flex-direction: column; gap: 18px; scrollbar-color: var(--pxa-accent) rgba(148,163,184,0.16); }
      #pxa-scroll-area::-webkit-scrollbar { width: 8px; }
      #pxa-scroll-area::-webkit-scrollbar-track { background: rgba(148,163,184,0.12); border-radius: 999px; }
      #pxa-scroll-area::-webkit-scrollbar-thumb { background: linear-gradient(180deg, var(--pxa-accent), var(--pxa-accent-dark)); border-radius: 999px; box-shadow: 0 4px 12px rgba(37,99,235,0.32); }
      .pxa-tabs { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; background: rgba(255,255,255,0.72); border-radius: 18px; padding: 8px; box-shadow: inset 0 1px 0 rgba(255,255,255,0.6); border: 1px solid rgba(148,163,184,0.24); }
      .pxa-tab { border: none; border-radius: 12px; padding: 12px 0; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; font-size: 11px; cursor: pointer; color: rgba(30,41,59,0.72); background: rgba(148,163,184,0.12); transition: all 0.22s ease; }
      .pxa-tab:hover { filter: brightness(1.06); }
      .pxa-tab.active { background: linear-gradient(135deg, var(--pxa-accent), var(--pxa-accent-dark)); color: white; box-shadow: 0 14px 28px rgba(37,99,235,0.32); }
      .pxa-tab-panels { display: flex; flex-direction: column; gap: 18px; }
      .pxa-tab-panel { display: none; }
      .pxa-tab-panel.active { display: block; }
      .pxa-section { background: rgba(255,255,255,0.85); border-radius: 22px; padding: 22px 24px 24px; box-shadow: inset 0 1px 0 rgba(255,255,255,0.65), 0 22px 40px rgba(15,23,42,0.1); border: 1px solid rgba(148,163,184,0.28); }
      .pxa-section h2 { margin: 0 0 16px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--pxa-accent-dark); }
      .pxa-controls { display: grid; gap: 16px; }
      .pxa-field { display: grid; gap: 8px; }
      .pxa-label { font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: #475569; font-weight: 700; }
      .pxa-input, .pxa-slider, .pxa-select { width: 100%; border: 1px solid rgba(148,163,184,0.45); border-radius: 14px; padding: 11px 14px; font-size: 13px; background: rgba(255,255,255,0.86); color: #0f172a; box-shadow: inset 0 1px 1px rgba(255,255,255,0.9); transition: border 0.2s ease, box-shadow 0.2s ease; }
      .pxa-input:focus, .pxa-slider:focus, .pxa-select:focus { border-color: var(--pxa-accent); box-shadow: 0 0 0 3px rgba(37,99,235,0.18); outline: none; }
      .pxa-slider { -webkit-appearance: none; height: 8px; padding: 0; border-radius: 999px; background: linear-gradient(90deg, rgba(37,99,235,0.75), rgba(6,182,212,0.75)); position: relative; }
      .pxa-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 20px; height: 20px; background: white; border-radius: 50%; border: 3px solid var(--pxa-accent); box-shadow: 0 6px 16px rgba(37,99,235,0.35); cursor: grab; }
      .pxa-slider::-moz-range-thumb { width: 20px; height: 20px; background: white; border-radius: 50%; border: 3px solid var(--pxa-accent); box-shadow: 0 6px 16px rgba(37,99,235,0.35); cursor: grab; }
      .pxa-value { font-size: 11px; letter-spacing: 0.12em; color: #0f172a; text-transform: uppercase; display: inline-flex; justify-content: flex-end; }
      .pxa-buttons { display: grid; grid-template-columns: repeat(auto-fit, minmax(0, 1fr)); gap: 12px; }
      .pxa-btn { border: none; border-radius: 14px; padding: 14px 0; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; font-size: 11px; cursor: pointer; transition: transform 0.22s ease, box-shadow 0.22s ease, filter 0.22s ease; position: relative; overflow: hidden; }
      .pxa-btn:disabled { opacity: 0.45; cursor: not-allowed; box-shadow: none !important; transform: none !important; filter: none !important; }
      .pxa-btn::after { content: ''; position: absolute; inset: 0; background: linear-gradient(135deg, rgba(255,255,255,0.18), transparent 55%); opacity: 0; transition: opacity 0.22s ease; }
      .pxa-btn:hover::after { opacity: 1; }
      .pxa-btn.primary { background: linear-gradient(135deg, var(--pxa-accent), var(--pxa-accent-dark)); color: white; box-shadow: 0 18px 32px rgba(37,99,235,0.35); }
      .pxa-btn.primary:hover { transform: translateY(-2px); box-shadow: 0 24px 42px rgba(30,64,175,0.45); }
      .pxa-btn.secondary { background: rgba(255,255,255,0.92); color: #0f172a; border: 1px solid rgba(148,163,184,0.35); box-shadow: 0 16px 30px rgba(15,23,42,0.12); }
      .pxa-btn.secondary:hover { transform: translateY(-2px); filter: brightness(1.02); }
      .pxa-btn.danger { background: linear-gradient(135deg, #f43f5e, #be123c); color: white; box-shadow: 0 18px 34px rgba(244,63,94,0.36); }
      .pxa-btn.danger:hover { transform: translateY(-2px); }
      .pxa-toggle-row { display: flex; flex-wrap: wrap; gap: 18px; }
      .pxa-toggle-group { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: 14px; background: rgba(148,163,184,0.14); border: 1px solid rgba(148,163,184,0.28); }
      .pxa-selection-control { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 14px; padding: 14px 18px; border-radius: 18px; background: rgba(148,163,184,0.18); border: 1px solid rgba(148,163,184,0.32); box-shadow: inset 0 1px 0 rgba(255,255,255,0.18); }
      .pxa-selection-info { display: grid; gap: 6px; min-width: 200px; }
      #pxa-selection-details { font-size: 12px; letter-spacing: 0.1em; text-transform: uppercase; color: #1f2937; }
      #pxa-selection-details[data-state="active"] { color: var(--pxa-accent-dark); }
      .pxa-selection-actions { display: flex; flex-wrap: wrap; gap: 10px; }
      .pxa-mini-btn { border: none; border-radius: 999px; padding: 10px 18px; font-weight: 700; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; cursor: pointer; background: rgba(255,255,255,0.92); color: #0f172a; box-shadow: 0 12px 24px rgba(15,23,42,0.16); transition: transform 0.2s ease, box-shadow 0.2s ease, filter 0.2s ease; }
      .pxa-mini-btn.primary { background: linear-gradient(135deg, var(--pxa-accent), var(--pxa-accent-dark)); color: white; box-shadow: 0 16px 30px rgba(37,99,235,0.32); }
      .pxa-mini-btn:hover:not(:disabled) { transform: translateY(-1px); filter: brightness(1.02); }
      .pxa-mini-btn:disabled { opacity: 0.45; cursor: not-allowed; box-shadow: none; }
      .pxa-switch { position: relative; width: 54px; height: 28px; border-radius: 999px; border: none; cursor: pointer; background: rgba(148,163,184,0.4); transition: background 0.22s ease, box-shadow 0.22s ease; padding: 0; }
      .pxa-switch[data-active="true"] { background: linear-gradient(135deg, var(--pxa-accent), var(--pxa-accent-dark)); box-shadow: 0 10px 20px rgba(37,99,235,0.35); }
      .pxa-switch-handle { position: absolute; top: 4px; left: 4px; width: 20px; height: 20px; border-radius: 50%; background: white; box-shadow: 0 6px 12px rgba(15,23,42,0.25); transition: transform 0.22s ease; }
      .pxa-switch[data-active="true"] .pxa-switch-handle { transform: translateX(26px); }
      .pxa-preview-grid { display: grid; grid-template-columns: minmax(0, 1fr) 230px; gap: 20px; align-items: stretch; }
      @media (max-width: 720px) { .pxa-preview-grid { grid-template-columns: 1fr; } }
      #pxa-preview-wrapper { position: relative; border-radius: 18px; overflow: hidden; background: linear-gradient(145deg, rgba(15,23,42,0.96), rgba(15,23,42,0.86)); min-height: 220px; border: 1px solid rgba(15,23,42,0.4); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.12); }
      #pxa-preview { width: 100%; height: 100%; display: block; }
      #pxa-preview::selection { background: transparent; }
      #pxa-preview-loading { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(15,23,42,0.72); color: white; font-weight: 600; font-size: 14px; letter-spacing: 0.18em; text-transform: uppercase; opacity: 0; pointer-events: none; transition: opacity 0.3s ease; }
      #pxa-preview-loading.visible { opacity: 1; }
      .pxa-metrics-grid { display: grid; gap: 12px; align-content: flex-start; }
      .pxa-metric-card { background: rgba(15,23,42,0.05); border-radius: 16px; padding: 14px 16px; border: 1px solid rgba(148,163,184,0.25); box-shadow: inset 0 1px 0 rgba(255,255,255,0.65); display: grid; gap: 4px; }
      .pxa-metric-label { font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; color: #64748b; }
      .pxa-metric-value { font-size: 20px; font-weight: 700; color: #0f172a; letter-spacing: 0.02em; }
      .pxa-metric-sub { font-size: 11px; letter-spacing: 0.1em; color: #475569; text-transform: uppercase; }
      .pxa-secondary-actions { display: grid; gap: 10px; margin-top: 14px; }
      .pxa-secondary-actions .pxa-btn { font-size: 10px; padding: 12px; }
      .pxa-meta { display: flex; justify-content: space-between; align-items: center; font-size: 11px; text-transform: uppercase; color: #475569; letter-spacing: 0.08em; margin-top: 12px; }
      #pxa-progress { position: relative; height: 12px; border-radius: 999px; background: rgba(15,23,42,0.08); overflow: hidden; border: 1px solid rgba(148,163,184,0.24); }
      #pxa-progress-bar { position: absolute; inset: 0; width: 0%; background: linear-gradient(90deg, #22d3ee, var(--pxa-accent)); box-shadow: 0 8px 22px rgba(59,130,246,0.38); transition: width 0.2s ease; }
      #pxa-progress-label { position: absolute; right: 12px; top: 50%; transform: translateY(-50%); font-size: 11px; font-weight: 700; color: rgba(15,23,42,0.82); letter-spacing: 0.12em; }
      #pxa-status { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: #1f2937; font-weight: 700; margin-top: 12px; }
      #pxa-selection-overlay { position: fixed; z-index: 999998; border: 1px solid rgba(37,99,235,0.45); background: rgba(37,99,235,0.08); box-shadow: 0 0 0 1px rgba(37,99,235,0.32), 0 32px 80px rgba(15,23,42,0.25); cursor: crosshair; backdrop-filter: blur(4px); }
      #pxa-selection-overlay::after { content: 'Drag to place the artwork'; position: absolute; top: 12px; left: 50%; transform: translateX(-50%); padding: 6px 14px; border-radius: 999px; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: white; background: rgba(15,23,42,0.65); box-shadow: 0 12px 24px rgba(15,23,42,0.35); pointer-events: none; }
      #pxa-selection-box { position: absolute; border: 2px dashed rgba(255,255,255,0.85); border-radius: 12px; background: rgba(37,99,235,0.18); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.28), 0 18px 40px rgba(37,99,235,0.25); pointer-events: none; }
      #pxa-footer { padding: 16px 28px 22px; display: grid; gap: 10px; background: rgba(15,23,42,0.04); border-top: 1px solid rgba(148,163,184,0.25); box-shadow: inset 0 1px 0 rgba(255,255,255,0.6); }
      #pxa-palette-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(22px, 1fr)); gap: 6px; border-radius: 16px; padding: 12px; background: rgba(15,23,42,0.06); border: 1px solid rgba(148,163,184,0.32); max-height: 200px; overflow-y: auto; }
      .pxa-swatch { width: 100%; padding-bottom: 100%; border-radius: 10px; position: relative; box-shadow: inset 0 0 0 1px rgba(15,23,42,0.12); }
      .pxa-swatch::after { content: ''; position: absolute; inset: 0; border-radius: inherit; box-shadow: inset 0 1px 0 rgba(255,255,255,0.35); }
      .pxa-swatch[data-dominant="true"] { box-shadow: 0 0 0 2px var(--pxa-accent), inset 0 0 0 1px rgba(15,23,42,0.2); }
      .pxa-fun-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 18px; margin-bottom: 18px; }
      .pxa-fun-note { margin-top: -4px; margin-bottom: 18px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: rgba(15,23,42,0.6); }
      .pxa-fun-actions { display: flex; flex-wrap: wrap; gap: 12px; }
      .pxa-fun-progress { position: relative; width: 100%; height: 12px; border-radius: 999px; background: rgba(148,163,184,0.28); overflow: hidden; margin-top: 20px; box-shadow: inset 0 1px 0 rgba(255,255,255,0.45); }
      .pxa-fun-progress-bar { position: absolute; inset: 0; width: 0%; background: linear-gradient(135deg, rgba(37,99,235,0.85), rgba(6,182,212,0.85)); box-shadow: 0 10px 24px rgba(37,99,235,0.35); transition: width 0.3s ease; }
      .pxa-fun-status { margin-top: 12px; font-size: 12px; letter-spacing: 0.09em; text-transform: uppercase; color: #1f2937; }
      .pxa-fun-description { margin-bottom: 12px; font-size: 12px; letter-spacing: 0.06em; color: rgba(15,23,42,0.75); }
      #pxa-palette-insights { display: grid; gap: 12px; margin-top: 16px; }
      .pxa-insight-card { border-radius: 16px; padding: 16px; background: rgba(37,99,235,0.08); border: 1px solid rgba(37,99,235,0.16); box-shadow: inset 0 1px 0 rgba(255,255,255,0.45); display: grid; gap: 6px; }
      .pxa-insight-card strong { font-size: 14px; letter-spacing: 0.02em; color: var(--pxa-accent-dark); }
      .pxa-insight-card span { font-size: 12px; color: #334155; letter-spacing: 0.04em; }
      .pxa-advanced-grid { display: grid; gap: 18px; }
      .pxa-two-column { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; }
      #pxa-advanced-note { font-size: 11px; letter-spacing: 0.08em; color: #475569; text-transform: uppercase; }
      input[type='file'].shake { animation: pxa-shake 0.45s ease; }
      @keyframes pxa-shake { 0%, 100% { transform: translateX(0); } 20%, 60% { transform: translateX(-6px); } 40%, 80% { transform: translateX(6px); } }
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'pxa-panel';
    panel.innerHTML = `
      <div id="pxa-head">
        <div id="pxa-logo"><span class="pxa-logo-icon">PX</span><span class="pxa-logo-sub">Studio</span></div>
        <div id="pxa-title">
          <h1>Autodraw Studio</h1>
          <p>WebSocket Pixel Renderer</p>
          <div id="pxa-headline-band">
            <div class="pxa-chip" id="pxa-chip-socket" data-status="searching"><span class="pxa-chip-dot"></span><span id="pxa-socket-label">Socket: searching…</span></div>
            <div class="pxa-chip" id="pxa-chip-mode"><span class="pxa-chip-icon">✨</span><span id="pxa-mode-label">Balanced detail</span></div>
          </div>
        </div>
        <button id="pxa-close">✕</button>
      </div>
      <div id="pxa-body">
        <div class="pxa-tabs">
          <button class="pxa-tab active" data-tab="setup">Setup</button>
          <button class="pxa-tab" data-tab="preview">Preview</button>
          <button class="pxa-tab" data-tab="palette">Palette</button>
          <button class="pxa-tab" data-tab="advanced">Advanced</button>
          <button class="pxa-tab" data-tab="fun">Fun Lab</button>
        </div>
        <div id="pxa-scroll-area">
          <div class="pxa-tab-panels">
          <section class="pxa-section pxa-tab-panel active" data-tab="setup">
            <h2>Setup</h2>
            <div class="pxa-controls">
              <label class="pxa-field">
                <span class="pxa-label">Image File</span>
                <input id="pxa-file" type="file" accept="image/*" class="pxa-input" />
              </label>
              <label class="pxa-field">
                <span class="pxa-label">Max Dimension (px)</span>
                <input id="pxa-dimension" type="range" min="64" max="500" value="500" class="pxa-slider" />
                <div class="pxa-meta"><span>64px</span><span id="pxa-dimension-value">500px</span></div>
              </label>
              <label class="pxa-field">
                <span class="pxa-label">Colour Order</span>
                <select id="pxa-colour-order" class="pxa-select">
                  <option value="dark-first" selected>Dark → Light</option>
                  <option value="light-first">Light → Dark</option>
                  <option value="coverage">Coverage Priority</option>
                </select>
              </label>
              <div class="pxa-toggle-row">
                <div class="pxa-toggle-group">
                  <span class="pxa-label">Auto start after preview</span>
                  <button type="button" class="pxa-switch" id="pxa-toggle-autostart" data-active="false" aria-pressed="false"><span class="pxa-switch-handle"></span></button>
                </div>
                <div class="pxa-toggle-group">
                  <span class="pxa-label">Adaptive theme</span>
                  <button type="button" class="pxa-switch" id="pxa-toggle-theme" data-active="true" aria-pressed="true"><span class="pxa-switch-handle"></span></button>
                </div>
              </div>
              <div class="pxa-selection-control">
                <div class="pxa-selection-info">
                  <span class="pxa-label">Canvas region</span>
                  <span id="pxa-selection-details">Full canvas coverage</span>
                </div>
                <div class="pxa-selection-actions">
                  <button class="pxa-mini-btn primary" id="pxa-select-region" type="button">Set region</button>
                  <button class="pxa-mini-btn" id="pxa-clear-region" type="button" disabled>Reset</button>
                </div>
              </div>
              <div class="pxa-buttons">
                <button class="pxa-btn secondary" id="pxa-preview-btn">Generate Preview</button>
                <button class="pxa-btn primary" id="pxa-start">Start Drawing</button>
                <button class="pxa-btn danger" id="pxa-stop" disabled>Stop</button>
              </div>
            </div>
          </section>

          <section class="pxa-section pxa-tab-panel" data-tab="preview">
            <h2>Preview & Metrics</h2>
            <div class="pxa-preview-grid">
              <div id="pxa-preview-wrapper">
                <canvas id="pxa-preview" width="420" height="260"></canvas>
                <div id="pxa-preview-loading">Processing…</div>
              </div>
              <div class="pxa-metrics-grid">
                <div class="pxa-metric-card">
                  <span class="pxa-metric-label">Resolution</span>
                  <span class="pxa-metric-value" id="pxa-metric-resolution">—</span>
                  <span class="pxa-metric-sub" id="pxa-metric-scale">Fit-to-canvas ready</span>
                </div>
                <div class="pxa-metric-card">
                  <span class="pxa-metric-label">Palette</span>
                  <span class="pxa-metric-value" id="pxa-metric-palette">0</span>
                  <span class="pxa-metric-sub" id="pxa-metric-palette-note">Up to 1300 colours</span>
                </div>
                <div class="pxa-metric-card">
                  <span class="pxa-metric-label">Stroke Estimate</span>
                  <span class="pxa-metric-value" id="pxa-metric-strokes">0</span>
                  <span class="pxa-metric-sub" id="pxa-metric-lanes">Lane fan ×1</span>
                </div>
                <div class="pxa-metric-card">
                  <span class="pxa-metric-label">Estimated Runtime</span>
                  <span class="pxa-metric-value" id="pxa-metric-eta">0s</span>
                  <span class="pxa-metric-sub" id="pxa-metric-delay">8ms stroke delay</span>
                </div>
              </div>
            </div>
            <div class="pxa-secondary-actions">
              <button class="pxa-btn secondary" id="pxa-export-preview">Download processed PNG</button>
              <button class="pxa-btn secondary" id="pxa-copy-palette">Copy palette to clipboard</button>
            </div>
            <div class="pxa-meta"><span id="pxa-palette-summary">0 colours</span><span>1px brush</span></div>
          </section>

          <section class="pxa-section pxa-tab-panel" data-tab="palette">
            <h2>Palette Insights</h2>
            <div class="pxa-meta"><span id="pxa-palette-summary-secondary">0 colours</span><span>Order linked to setup tab</span></div>
            <div id="pxa-palette-strip"></div>
            <div id="pxa-palette-insights"></div>
          </section>

          <section class="pxa-section pxa-tab-panel" data-tab="advanced">
            <h2>Advanced Painter Controls</h2>
            <div class="pxa-advanced-grid">
              <div class="pxa-two-column">
                <label class="pxa-field">
                  <span class="pxa-label">Smoothness boost</span>
                  <input id="pxa-smoothness" type="range" min="0" max="100" value="40" class="pxa-slider" />
                  <span class="pxa-value" id="pxa-smoothness-value">40%</span>
                </label>
                <label class="pxa-field">
                  <span class="pxa-label">Lane density</span>
                  <input id="pxa-lane-density" type="range" min="60" max="200" value="100" class="pxa-slider" />
                  <span class="pxa-value" id="pxa-lane-density-value">100%</span>
                </label>
              <label class="pxa-field">
                <span class="pxa-label">Coverage padding</span>
                <input id="pxa-coverage" type="range" min="80" max="180" value="100" class="pxa-slider" />
                <span class="pxa-value" id="pxa-coverage-value">100%</span>
              </label>
              <label class="pxa-field">
                <span class="pxa-label">Dither strength</span>
                <input id="pxa-dither" type="range" min="0" max="200" value="100" class="pxa-slider" />
                <span class="pxa-value" id="pxa-dither-value">100%</span>
              </label>
              <label class="pxa-field">
                <span class="pxa-label">Spectral accent</span>
                <input id="pxa-spectral" type="range" min="50" max="200" value="120" class="pxa-slider" />
                <span class="pxa-value" id="pxa-spectral-value">120%</span>
              </label>
            </div>
            <div class="pxa-two-column">
              <label class="pxa-field">
                <span class="pxa-label">Detail cadence</span>
                <select id="pxa-detail-mode" class="pxa-select">
                    <option value="balanced" selected>Balanced</option>
                    <option value="max">Maximum</option>
                    <option value="minimal">Minimal</option>
                  </select>
                </label>
                <div class="pxa-toggle-group">
                  <span class="pxa-label">Low-res enhancer</span>
                  <button type="button" class="pxa-switch" id="pxa-toggle-lowres" data-active="true" aria-pressed="true"><span class="pxa-switch-handle"></span></button>
                </div>
              <div class="pxa-toggle-group">
                <span class="pxa-label">Edge emphasis</span>
                <button type="button" class="pxa-switch" id="pxa-toggle-edge" data-active="true" aria-pressed="true"><span class="pxa-switch-handle"></span></button>
              </div>
              <div class="pxa-toggle-group">
                <span class="pxa-label">Micro detail</span>
                <button type="button" class="pxa-switch" id="pxa-toggle-micro" data-active="true" aria-pressed="true"><span class="pxa-switch-handle"></span></button>
              </div>
              <div class="pxa-toggle-group">
                <span class="pxa-label">Glow glazing</span>
                <button type="button" class="pxa-switch" id="pxa-toggle-glaze" data-active="true" aria-pressed="true"><span class="pxa-switch-handle"></span></button>
              </div>
              <div class="pxa-toggle-group">
                <span class="pxa-label">Texture weave</span>
                <button type="button" class="pxa-switch" id="pxa-toggle-weave" data-active="false" aria-pressed="false"><span class="pxa-switch-handle"></span></button>
              </div>
              <div class="pxa-toggle-group">
                <span class="pxa-label">Gradient echo</span>
                <button type="button" class="pxa-switch" id="pxa-toggle-echo" data-active="true" aria-pressed="true"><span class="pxa-switch-handle"></span></button>
              </div>
            </div>
            <div id="pxa-advanced-note">Changes apply to the next draw and live estimates will update automatically.</div>
          </div>
        </section>
          <section class="pxa-section pxa-tab-panel" data-tab="fun">
            <h2>Fun Lab Experiments</h2>
            <div class="pxa-fun-description" id="pxa-fun-description">Layer playful pointer-driven effects over your canvas without touching the websocket painter.</div>
            <div class="pxa-fun-grid">
              <label class="pxa-field">
                <span class="pxa-label">Effect</span>
                <select id="pxa-fun-mode" class="pxa-select">
                  <option value="aurora">Aurora sweep</option>
                  <option value="vortex">Vortex bloom</option>
                  <option value="firefly">Firefly scatter</option>
                  <option value="cascade">Cascade drapery</option>
                </select>
              </label>
              <label class="pxa-field">
                <span class="pxa-label">Density</span>
                <input id="pxa-fun-density" type="range" min="10" max="120" value="70" class="pxa-slider" />
                <span class="pxa-value" id="pxa-fun-density-value">70</span>
              </label>
              <label class="pxa-field">
                <span class="pxa-label">Tempo</span>
                <input id="pxa-fun-tempo" type="range" min="10" max="160" value="60" class="pxa-slider" />
                <span class="pxa-value" id="pxa-fun-tempo-value">60</span>
              </label>
            </div>
            <div class="pxa-toggle-row">
              <div class="pxa-toggle-group">
                <span class="pxa-label">Mirror sweeps</span>
                <button type="button" class="pxa-switch" id="pxa-fun-toggle-mirror" data-active="true" aria-pressed="true"><span class="pxa-switch-handle"></span></button>
              </div>
              <div class="pxa-toggle-group">
                <span class="pxa-label">Jitter accents</span>
                <button type="button" class="pxa-switch" id="pxa-fun-toggle-jitter" data-active="true" aria-pressed="true"><span class="pxa-switch-handle"></span></button>
              </div>
            </div>
            <div class="pxa-fun-note">Prep your brush size &amp; colour in Drawaria before pressing play — the fun lab reuses whatever is active.</div>
            <div class="pxa-fun-actions">
              <button class="pxa-btn primary" id="pxa-fun-run" type="button">Play effect</button>
              <button class="pxa-btn danger" id="pxa-fun-stop" type="button" disabled>Stop</button>
            </div>
            <div class="pxa-fun-progress"><div class="pxa-fun-progress-bar" id="pxa-fun-progress-bar"></div></div>
            <div class="pxa-fun-status" id="pxa-fun-status">Select an effect and press play.</div>
          </section>
          </div>
        </div>
      </div>
      <div id="pxa-footer">
        <div id="pxa-progress"><div id="pxa-progress-bar"></div><div id="pxa-progress-label">0%</div></div>
        <div id="pxa-status">Select an image to begin (max 500px).</div>
      </div>
    `;
    document.body.appendChild(panel);

    const head = panel.querySelector('#pxa-head');
    let dragOffsetX = 0;
    let dragOffsetY = 0;
    let dragging = false;

    const handlePointerDown = (event) => {
      dragging = true;
      const rect = panel.getBoundingClientRect();
      dragOffsetX = event.clientX - rect.left;
      dragOffsetY = event.clientY - rect.top;
      panel.style.transition = 'none';
      head.style.cursor = 'grabbing';
      event.preventDefault();
    };

    const handlePointerMove = (event) => {
      if (!dragging) return;
      panel.style.left = `${event.clientX - dragOffsetX}px`;
      panel.style.top = `${event.clientY - dragOffsetY}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    };

    const handlePointerUp = () => {
      dragging = false;
      head.style.cursor = 'grab';
      panel.style.transition = '';
    };

    head.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('mousemove', handlePointerMove);
    window.addEventListener('mouseup', handlePointerUp);

    registerCleanup(() => {
      head.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('mousemove', handlePointerMove);
      window.removeEventListener('mouseup', handlePointerUp);
    });

    const tabButtons = Array.from(panel.querySelectorAll('.pxa-tab'));
    const tabPanels = Array.from(panel.querySelectorAll('.pxa-tab-panel'));

    const activateTab = (name) => {
      tabButtons.forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.tab === name);
      });
      tabPanels.forEach((tabPanel) => {
        tabPanel.classList.toggle('active', tabPanel.dataset.tab === name);
      });
    };

    tabButtons.forEach((btn) => {
      const onClick = () => activateTab(btn.dataset.tab);
      btn.addEventListener('click', onClick);
      registerCleanup(() => btn.removeEventListener('click', onClick));
    });

    activateTab('setup');

    return {
      panel,
      style,
      fileInput: panel.querySelector('#pxa-file'),
      dimensionInput: panel.querySelector('#pxa-dimension'),
      previewCanvas: panel.querySelector('#pxa-preview'),
      previewButton: panel.querySelector('#pxa-preview-btn'),
      startButton: panel.querySelector('#pxa-start'),
      stopButton: panel.querySelector('#pxa-stop'),
      closeButton: panel.querySelector('#pxa-close'),
      status: panel.querySelector('#pxa-status'),
      progressBar: panel.querySelector('#pxa-progress-bar'),
      progressLabel: panel.querySelector('#pxa-progress-label'),
      paletteStrip: panel.querySelector('#pxa-palette-strip'),
      paletteSummary: panel.querySelector('#pxa-palette-summary'),
      paletteSummarySecondary: panel.querySelector('#pxa-palette-summary-secondary'),
      paletteInsights: panel.querySelector('#pxa-palette-insights'),
      selectionDetails: panel.querySelector('#pxa-selection-details'),
      selectRegionButton: panel.querySelector('#pxa-select-region'),
      clearRegionButton: panel.querySelector('#pxa-clear-region'),
      previewLoading: panel.querySelector('#pxa-preview-loading'),
      dimensionValue: panel.querySelector('#pxa-dimension-value'),
      paletteOrderSelect: panel.querySelector('#pxa-colour-order'),
      socketChip: panel.querySelector('#pxa-chip-socket'),
      socketLabel: panel.querySelector('#pxa-socket-label'),
      modeLabel: panel.querySelector('#pxa-mode-label'),
      metricResolution: panel.querySelector('#pxa-metric-resolution'),
      metricScale: panel.querySelector('#pxa-metric-scale'),
      metricPalette: panel.querySelector('#pxa-metric-palette'),
      metricPaletteNote: panel.querySelector('#pxa-metric-palette-note'),
      metricStrokes: panel.querySelector('#pxa-metric-strokes'),
      metricLanes: panel.querySelector('#pxa-metric-lanes'),
      metricEta: panel.querySelector('#pxa-metric-eta'),
      metricDelay: panel.querySelector('#pxa-metric-delay'),
      exportPreviewButton: panel.querySelector('#pxa-export-preview'),
      copyPaletteButton: panel.querySelector('#pxa-copy-palette'),
      smoothnessInput: panel.querySelector('#pxa-smoothness'),
      smoothnessValue: panel.querySelector('#pxa-smoothness-value'),
      laneDensityInput: panel.querySelector('#pxa-lane-density'),
      laneDensityValue: panel.querySelector('#pxa-lane-density-value'),
      coverageInput: panel.querySelector('#pxa-coverage'),
      coverageValue: panel.querySelector('#pxa-coverage-value'),
      ditherInput: panel.querySelector('#pxa-dither'),
      ditherValue: panel.querySelector('#pxa-dither-value'),
      spectralInput: panel.querySelector('#pxa-spectral'),
      spectralValue: panel.querySelector('#pxa-spectral-value'),
      detailModeSelect: panel.querySelector('#pxa-detail-mode'),
      toggleLowRes: panel.querySelector('#pxa-toggle-lowres'),
      toggleEdge: panel.querySelector('#pxa-toggle-edge'),
      toggleMicro: panel.querySelector('#pxa-toggle-micro'),
      toggleGlaze: panel.querySelector('#pxa-toggle-glaze'),
      toggleWeave: panel.querySelector('#pxa-toggle-weave'),
      toggleEcho: panel.querySelector('#pxa-toggle-echo'),
      toggleTheme: panel.querySelector('#pxa-toggle-theme'),
      toggleAutoStart: panel.querySelector('#pxa-toggle-autostart'),
      funModeSelect: panel.querySelector('#pxa-fun-mode'),
      funDensityInput: panel.querySelector('#pxa-fun-density'),
      funDensityValue: panel.querySelector('#pxa-fun-density-value'),
      funTempoInput: panel.querySelector('#pxa-fun-tempo'),
      funTempoValue: panel.querySelector('#pxa-fun-tempo-value'),
      funMirrorToggle: panel.querySelector('#pxa-fun-toggle-mirror'),
      funJitterToggle: panel.querySelector('#pxa-fun-toggle-jitter'),
      funRunButton: panel.querySelector('#pxa-fun-run'),
      funStopButton: panel.querySelector('#pxa-fun-stop'),
      funProgressBar: panel.querySelector('#pxa-fun-progress-bar'),
      funStatus: panel.querySelector('#pxa-fun-status'),
      funDescription: panel.querySelector('#pxa-fun-description'),
    };
  }

  function installSocketBridge() {
    const HANDLE = '__drawariaAutodrawSocketBridge';
    if (window[HANDLE]) {
      window[HANDLE].refCount += 1;
      return window[HANDLE];
    }

    const sockets = new Set();
    const originalSend = WebSocket.prototype.send;

    function track(socket) {
      if (sockets.has(socket)) {
        return;
      }
      sockets.add(socket);
      socket.addEventListener('close', () => sockets.delete(socket));
      socket.addEventListener('error', () => sockets.delete(socket));
    }

    function patchedSend(...args) {
      track(this);
      return originalSend.apply(this, args);
    }

    WebSocket.prototype.send = patchedSend;

    const bridge = {
      refCount: 1,
      release() {
        bridge.refCount -= 1;
        if (bridge.refCount <= 0) {
          WebSocket.prototype.send = originalSend;
          sockets.clear();
          delete window[HANDLE];
        }
      },
      getSocket() {
        const list = Array.from(sockets);
        for (let i = list.length - 1; i >= 0; i--) {
          const socket = list[i];
          if (socket && socket.readyState === WebSocket.OPEN) {
            return socket;
          }
        }
        return null;
      },
    };

    window[HANDLE] = bridge;
    return bridge;
  }
})();
