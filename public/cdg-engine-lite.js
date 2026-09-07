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
      this.transparentBackground = false;
      this.renderCount = 0;
      this.totalRenderMs = 0;
      this.maxRenderMs = 0;
    }

    load(bytes) {
      this.data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      this.reset();
      this.processTo(1);
      this.render(true);
    }

    reset() {
      this.decoder.reset();
      this.processedPacket = 0;
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
          const index = this.decoder.frame[sy * WIDTH + sx] & 0x0f;
          const rgba = this.decoder.palette[index] || [0, 0, 0, 255];
          out[o] = rgba[0];
          out[o + 1] = rgba[1];
          out[o + 2] = rgba[2];
          out[o + 3] = this.transparentBackground && index === this.decoder.memoryColor ? 0 : 255;
          o += 4;
        }
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
          transparentBackground: this.transparentBackground
        });
      }
    }

    setTransparentBackground(enabled) {
      const next = Boolean(enabled);
      if (next === this.transparentBackground) return;
      this.transparentBackground = next;
      this.render(true);
    }

    getMetrics() {
      return {
        renderCount: this.renderCount,
        avgRenderMs: this.renderCount ? Number((this.totalRenderMs / this.renderCount).toFixed(3)) : 0,
        maxRenderMs: Number(this.maxRenderMs.toFixed(3)),
        transparentBackground: this.transparentBackground,
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
