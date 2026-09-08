(() => {
  "use strict";

  const PACKETS_PER_SECOND = 300;
  const PACK_SIZE = 24;
  const WIDTH = 300;
  const HEIGHT = 216;
  const VISIBLE_X = 6;
  const VISIBLE_Y = 12;
  const VISIBLE_W = 288;
  const VISIBLE_H = 192;

  class Decoder {
    constructor() {
      this.frame = new Uint8Array(WIDTH * HEIGHT);
      this.palette = Array.from({ length: 16 }, () => [0, 0, 0, 255]);
      this.border = 0;
      this.transparent = 0;
      this.memoryColor = 0;
      this.hOffset = 0;
      this.vOffset = 0;
    }

    reset() {
      this.frame.fill(0);
      this.palette = Array.from({ length: 16 }, () => [0, 0, 0, 255]);
      this.border = 0;
      this.transparent = 0;
      this.memoryColor = 0;
      this.hOffset = 0;
      this.vOffset = 0;
    }

    clear(color) {
      this.memoryColor = color & 0x0f;
      this.frame.fill(this.memoryColor);
    }

    scroll(color, hcmd, vcmd, copyMode) {
      const hdir = (hcmd >> 4) & 0x03;
      const vdir = (vcmd >> 4) & 0x03;
      this.hOffset = hcmd & 0x07;
      this.vOffset = vcmd & 0x0f;
      const dx = hdir === 1 ? 6 : (hdir === 2 ? -6 : 0);
      const dy = vdir === 1 ? 12 : (vdir === 2 ? -12 : 0);
      if (!dx && !dy) return;

      const old = this.frame.slice();
      const fill = color & 0x0f;
      for (let y = 0; y < HEIGHT; y += 1) {
        for (let x = 0; x < WIDTH; x += 1) {
          const sx = x - dx;
          const sy = y - dy;
          const dst = y * WIDTH + x;
          if (sx >= 0 && sx < WIDTH && sy >= 0 && sy < HEIGHT) {
            this.frame[dst] = old[sy * WIDTH + sx];
          } else if (copyMode) {
            const wx = ((sx % WIDTH) + WIDTH) % WIDTH;
            const wy = ((sy % HEIGHT) + HEIGHT) % HEIGHT;
            this.frame[dst] = old[wy * WIDTH + wx];
          } else {
            this.frame[dst] = fill;
          }
        }
      }
    }

    packet(p) {
      if (!p || p.length !== PACK_SIZE || ((p[0] & 0x3f) !== 0x09)) return;
      const ins = p[1] & 0x3f;
      const d = new Uint8Array(16);
      for (let i = 0; i < 16; i += 1) d[i] = p[4 + i] & 0x3f;

      if (ins === 1) {
        this.clear(d[0]);
      } else if (ins === 2) {
        this.border = d[0] & 0x0f;
      } else if (ins === 6 || ins === 38) {
        const c0 = d[0] & 0x0f;
        const c1 = d[1] & 0x0f;
        const row = d[2] & 0x1f;
        const col = d[3] & 0x3f;
        const y0 = row * 12;
        const x0 = col * 6;

        for (let r = 0; r < 12; r += 1) {
          const bits = d[4 + r];
          const y = y0 + r;
          if (y >= HEIGHT) continue;
          for (let c = 0; c < 6; c += 1) {
            const x = x0 + c;
            if (x >= WIDTH) continue;
            const value = (bits & (1 << (5 - c))) ? c1 : c0;
            const idx = y * WIDTH + x;
            this.frame[idx] = ins === 38 ? (this.frame[idx] ^ value) : value;
          }
        }
      } else if (ins === 20) {
        this.scroll(d[0], d[1], d[2], false);
      } else if (ins === 24) {
        this.scroll(d[0], d[1], d[2], true);
      } else if (ins === 30 || ins === 31) {
        const base = ins === 30 ? 0 : 8;
        for (let i = 0; i < 8; i += 1) {
          const a = d[i * 2];
          const b = d[i * 2 + 1];
          const r = (a & 0x3c) >> 2;
          const g = ((a & 0x03) << 2) | ((b & 0x30) >> 4);
          const bl = b & 0x0f;
          this.palette[base + i] = [r * 17, g * 17, bl * 17, 255];
        }
      } else if (ins === 28) {
        this.transparent = d[0] & 0x0f;
      }
    }
  }

  class CdgEngine {
    constructor(canvas, onFrame) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d", { alpha: true });
      this.ctx.imageSmoothingEnabled = false;
      this.canvas.width = VISIBLE_W;
      this.canvas.height = VISIBLE_H;
      this.imageData = this.ctx.createImageData(VISIBLE_W, VISIBLE_H);
      this.decoder = new Decoder();
      this.data = null;
      this.processedPacket = 0;
      this.lastRenderAt = 0;
      this.onFrame = typeof onFrame === "function" ? onFrame : null;

      // "auto": elimina fondos grandes conectados al borde.
      // "force": umbral más agresivo.
      // "original": conserva exactamente el fondo del CDG.
      this.transparencyMode = "auto";
      this.transparentBackground = true;

      this.renderCount = 0;
      this.totalRenderMs = 0;
      this.maxRenderMs = 0;
      this.visibleIndex = new Uint8Array(VISIBLE_W * VISIBLE_H);
      this.backgroundMask = new Uint8Array(VISIBLE_W * VISIBLE_H);
      this.componentStack = new Int32Array(VISIBLE_W * VISIBLE_H);
      this.visitStamp = new Uint32Array(VISIBLE_W * VISIBLE_H);
      this.visitRevision = 1;
      this.backgroundAnalysis = {
        mode: "auto",
        status: "pending",
        candidateComponents: 0,
        removedComponents: 0,
        removedPixels: 0,
        removedCoverage: 0,
        dominantColorIndex: null,
        dominantColorRgb: null,
        memoryColorIndex: 0
      };
      this.backgroundAnalysisSignature = "";
      this.backgroundAnalysisRevision = 0;
    }

    load(bytes) {
      this.data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      this.resetMetrics();
      this.backgroundAnalysisSignature = "";
      this.backgroundAnalysisRevision = 0;
      this.reset();
      this.processTo(1);
      this.render(true);
    }

    reset() {
      this.decoder.reset();
      this.processedPacket = 0;
    }

    resetMetrics() {
      this.renderCount = 0;
      this.totalRenderMs = 0;
      this.maxRenderMs = 0;
      this.lastRenderAt = 0;
    }

    processTo(targetPacket) {
      if (!this.data) return;
      const total = Math.floor(this.data.length / PACK_SIZE);
      const target = Math.max(0, Math.min(total, targetPacket | 0));
      if (target < this.processedPacket) this.reset();

      for (let i = this.processedPacket; i < target; i += 1) {
        const start = i * PACK_SIZE;
        this.decoder.packet(this.data.subarray(start, start + PACK_SIZE));
      }
      this.processedPacket = target;
    }

    sync(seconds) {
      const safe = Math.max(0, Number(seconds) || 0);
      const target = Math.floor(safe * PACKETS_PER_SECOND);
      const changed = target !== this.processedPacket;
      if (changed) this.processTo(target);

      const now = performance.now();
      if (changed && now - this.lastRenderAt >= 16) {
        this.render(false);
        this.lastRenderAt = now;
      }

      return {
        audioTime: safe,
        cdgTime: this.processedPacket / PACKETS_PER_SECOND,
        skewMs: Math.round(((this.processedPacket / PACKETS_PER_SECOND) - safe) * 1000)
      };
    }

    _nextVisitRevision() {
      this.visitRevision += 1;
      if (this.visitRevision >= 0xffffffff) {
        this.visitStamp.fill(0);
        this.visitRevision = 1;
      }
      return this.visitRevision;
    }

    _buildBackgroundMask() {
      this.backgroundMask.fill(0);

      const mode = this.transparencyMode;
      const totalPixels = this.visibleIndex.length;
      const memoryColor = this.decoder.memoryColor & 0x0f;

      if (mode === "original") {
        return {
          mode,
          status: "skipped-original",
          candidateComponents: 0,
          removedComponents: 0,
          removedPixels: 0,
          removedCoverage: 0,
          dominantColorIndex: null,
          dominantColorRgb: null,
          memoryColorIndex: memoryColor
        };
      }

      const revision = this._nextVisitRevision();
      const autoThreshold = Math.max(320, Math.round(totalPixels * 0.025));
      const forceThreshold = Math.max(96, Math.round(totalPixels * 0.004));
      const threshold = mode === "force" ? forceThreshold : autoThreshold;

      let candidateComponents = 0;
      let removedComponents = 0;
      let removedPixels = 0;
      let dominantSize = 0;
      let dominantColorIndex = null;

      const visitComponent = (seed) => {
        if (this.visitStamp[seed] === revision) return;
        const color = this.visibleIndex[seed] & 0x0f;
        let read = 0;
        let write = 0;
        this.componentStack[write++] = seed;
        this.visitStamp[seed] = revision;

        while (read < write) {
          const idx = this.componentStack[read++];
          const x = idx % VISIBLE_W;
          const y = (idx / VISIBLE_W) | 0;

          const add = (next) => {
            if (
              this.visitStamp[next] !== revision &&
              (this.visibleIndex[next] & 0x0f) === color
            ) {
              this.visitStamp[next] = revision;
              this.componentStack[write++] = next;
            }
          };

          if (x > 0) add(idx - 1);
          if (x + 1 < VISIBLE_W) add(idx + 1);
          if (y > 0) add(idx - VISIBLE_W);
          if (y + 1 < VISIBLE_H) add(idx + VISIBLE_W);
        }

        candidateComponents += 1;
        const accept =
          color === memoryColor ||
          write >= threshold;

        if (!accept) return;

        removedComponents += 1;
        removedPixels += write;
        if (write > dominantSize) {
          dominantSize = write;
          dominantColorIndex = color;
        }
        for (let i = 0; i < write; i += 1) {
          this.backgroundMask[this.componentStack[i]] = 1;
        }
      };

      // Solo analizamos regiones que tocan el borde. Esto evita borrar letras
      // interiores aunque compartan un color con el fondo.
      for (let x = 0; x < VISIBLE_W; x += 1) {
        visitComponent(x);
        visitComponent((VISIBLE_H - 1) * VISIBLE_W + x);
      }
      for (let y = 1; y < VISIBLE_H - 1; y += 1) {
        visitComponent(y * VISIBLE_W);
        visitComponent(y * VISIBLE_W + VISIBLE_W - 1);
      }

      const coverage = totalPixels ? removedPixels / totalPixels : 0;
      const dominantRgba = dominantColorIndex == null
        ? null
        : (this.decoder.palette[dominantColorIndex] || [0, 0, 0, 255]);

      return {
        mode,
        status: removedPixels > 0 ? "applied" : "no-safe-background",
        candidateComponents,
        removedComponents,
        removedPixels,
        removedCoverage: Number(coverage.toFixed(4)),
        dominantColorIndex,
        dominantColorRgb: dominantRgba
          ? [dominantRgba[0], dominantRgba[1], dominantRgba[2]]
          : null,
        memoryColorIndex: memoryColor,
        thresholdPixels: threshold
      };
    }

    render(force) {
      if (!this.data && !force) return;
      const started = performance.now();
      const out = this.imageData.data;
      let o = 0;
      const hFine = Math.min(5, this.decoder.hOffset);
      const vFine = Math.min(11, this.decoder.vOffset);

      for (let y = 0; y < VISIBLE_H; y += 1) {
        const sy = Math.min(HEIGHT - 1, VISIBLE_Y + y + vFine);
        for (let x = 0; x < VISIBLE_W; x += 1) {
          const sx = Math.min(WIDTH - 1, VISIBLE_X + x + hFine);
          this.visibleIndex[y * VISIBLE_W + x] = this.decoder.frame[sy * WIDTH + sx] & 0x0f;
        }
      }

      const analysis = this._buildBackgroundMask();
      const signature = [
        analysis.mode,
        analysis.status,
        analysis.dominantColorIndex == null ? "x" : analysis.dominantColorIndex,
        Math.round((analysis.removedCoverage || 0) * 20)
      ].join(":");
      const analysisChanged = signature !== this.backgroundAnalysisSignature;
      if (analysisChanged) {
        this.backgroundAnalysisSignature = signature;
        this.backgroundAnalysisRevision += 1;
      }
      this.backgroundAnalysis = analysis;

      const useTransparency = this.transparencyMode !== "original";
      for (let i = 0; i < this.visibleIndex.length; i += 1) {
        const index = this.visibleIndex[i];
        const rgba = this.decoder.palette[index] || [0, 0, 0, 255];
        out[o] = rgba[0];
        out[o + 1] = rgba[1];
        out[o + 2] = rgba[2];
        out[o + 3] = useTransparency && this.backgroundMask[i] ? 0 : 255;
        o += 4;
      }

      this.ctx.putImageData(this.imageData, 0, 0);
      const renderMs = performance.now() - started;
      this.renderCount += 1;
      this.totalRenderMs += renderMs;
      this.maxRenderMs = Math.max(this.maxRenderMs, renderMs);
      if (this.onFrame) {
        this.onFrame(this.imageData.data, {
          force: Boolean(force),
          packet: this.processedPacket,
          renderMs: Number(renderMs.toFixed(3)),
          transparentBackground: useTransparency,
          transparencyMode: this.transparencyMode,
          backgroundAnalysis: this.backgroundAnalysis,
          backgroundAnalysisRevision: this.backgroundAnalysisRevision,
          backgroundAnalysisChanged: analysisChanged
        });
      }
    }

    setTransparencyMode(mode) {
      const normalized = ["auto", "original", "force"].includes(String(mode || "").toLowerCase())
        ? String(mode).toLowerCase()
        : "auto";
      if (normalized === this.transparencyMode) return;
      this.transparencyMode = normalized;
      this.transparentBackground = normalized !== "original";
      this.backgroundAnalysisSignature = "";
      this.render(true);
    }

    setTransparentBackground(enabled) {
      this.setTransparencyMode(enabled ? "auto" : "original");
    }

    getBackgroundAnalysis() {
      return { ...this.backgroundAnalysis };
    }

    getMetrics() {
      return {
        renderCount: this.renderCount,
        avgRenderMs: this.renderCount ? Number((this.totalRenderMs / this.renderCount).toFixed(3)) : 0,
        maxRenderMs: Number(this.maxRenderMs.toFixed(3)),
        transparentBackground: this.transparencyMode !== "original",
        transparencyMode: this.transparencyMode,
        backgroundAnalysis: { ...this.backgroundAnalysis },
        processedPacket: this.processedPacket
      };
    }

    stop() {
      this.reset();
      this.render(true);
    }

    get packets() {
      return this.data ? Math.floor(this.data.length / PACK_SIZE) : 0;
    }
  }

  window.KITKARAOKE_CDG_ENGINE = Object.freeze({
    create(canvas, onFrame) {
      return new CdgEngine(canvas, onFrame);
    },
    PACKETS_PER_SECOND
  });
})();
