/*
 * DJGABO CDG Player - SDF LAB V2
 *
 * Distance-transform core adapted from mapbox/tiny-sdf (BSD-2-Clause).
 * Copyright (c) 2016-2024 Mapbox, Inc.
 *
 * Adaptation: the source is a decoded CDG bitmap mask rather than a system-font glyph.
 * The renderer exposes TinySDF-style controls (halo/cutoff/gamma/radius) and draws
 * the diagnostic result over a medium-gray LAB background.
 */
(() => {
  'use strict';

  const INF = 1e20;

  const alphaTable = new Float64Array(256);
  for (let i = 0; i < 256; i++) {
    const d = 0.5 - Math.pow(i / 255, 1 / 2.2);
    alphaTable[i] = d * Math.abs(d);
  }
  alphaTable[255] = -INF;

  function edt(data, width, height, f, v, z) {
    for (let x = 0; x < width; x++) edt1d(data, x, width, height, f, v, z);
    for (let y = 0; y < height; y++) edt1d(data, y * width, 1, width, f, v, z);
  }

  function edt1d(grid, offset, stride, length, f, v, z) {
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    f[0] = grid[offset];

    for (let q = 1, k = 0, s = 0; q < length; q++) {
      f[q] = grid[offset + q * stride];
      const q2 = q * q;
      do {
        const r = v[k];
        s = (f[q] - f[r] + q2 - r * r) / (q - r) / 2;
      } while (s <= z[k] && --k > -1);

      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }

    for (let q = 0, k = 0; q < length; q++) {
      while (z[k + 1] < q) k++;
      const r = v[k];
      const qr = q - r;
      grid[offset + q * stride] = f[r] + qr * qr;
    }
  }

  const VERTEX_SHADER = `
    attribute vec2 a_position;
    attribute vec2 a_uv;
    varying vec2 v_uv;

    void main() {
      gl_Position = vec4(a_position, 0.0, 1.0);
      v_uv = a_uv;
    }
  `;

  const FRAGMENT_SHADER = `
    precision mediump float;

    uniform sampler2D u_source;
    uniform sampler2D u_sdf;
    uniform vec2 u_sourceSize;
    uniform float u_scale;
    uniform float u_halo;
    uniform float u_cutoff;
    uniform float u_gamma;
    uniform float u_expansion;
    uniform float u_radius;
    uniform float u_threshold;
    uniform vec3 u_labBackground;
    uniform float u_transparentBackground;

    varying vec2 v_uv;

    float luminance(vec3 c) {
      return dot(c, vec3(0.2126, 0.7152, 0.0722));
    }

    void main() {
      vec2 texel = 1.0 / u_sourceSize;

      // SDF is encoded with 0.5 at the mask edge; higher values are inside.
      float sdf = texture2D(u_sdf, v_uv).r;
      sdf += u_expansion / max(2.0 * u_radius, 0.001);

      // TinySDF demo-style gamma: scaled down as internal render resolution grows.
      float aa = max(0.00035, u_gamma * 0.05 / max(u_scale, 1.0));

      // Lower buffer -> larger shape. Halo should normally be below cutoff.
      float haloAlpha = smoothstep(u_halo - aa, u_halo + aa, sdf);
      float fillAlpha = smoothstep(u_cutoff - aa, u_cutoff + aa, sdf);
      float outlineAlpha = max(0.0, haloAlpha - fillAlpha);

      vec3 sourceColor = texture2D(u_source, v_uv).rgb;

      // Follow the SDF gradient inward so antialiased edge pixels inherit the
      // actual CDG fill color (white/yellow/etc.) instead of the old black bg.
      float sx1 = texture2D(u_sdf, v_uv + vec2(texel.x, 0.0)).r;
      float sx0 = texture2D(u_sdf, v_uv - vec2(texel.x, 0.0)).r;
      float sy1 = texture2D(u_sdf, v_uv + vec2(0.0, texel.y)).r;
      float sy0 = texture2D(u_sdf, v_uv - vec2(0.0, texel.y)).r;

      vec2 grad = vec2(sx1 - sx0, sy1 - sy0);
      float glen = length(grad);
      if (glen > 0.00001) grad /= glen;

      vec3 c1 = texture2D(u_source, v_uv + grad * texel * 0.9).rgb;
      vec3 c2 = texture2D(u_source, v_uv + grad * texel * 1.8).rgb;

      vec3 fillColor = sourceColor;
      if (luminance(fillColor) < u_threshold) fillColor = c1;
      if (luminance(fillColor) < u_threshold) fillColor = c2;

      vec3 color = u_labBackground;
      color = mix(color, vec3(0.0), haloAlpha);
      color = mix(color, fillColor, fillAlpha);

      if (u_transparentBackground > 0.5) {
        float alpha = clamp(max(haloAlpha, fillAlpha), 0.0, 1.0);
        vec3 transparentColor = vec3(0.0);
        transparentColor = mix(transparentColor, vec3(0.0), haloAlpha);
        transparentColor = mix(transparentColor, fillColor, fillAlpha);
        gl_FragColor = vec4(clamp(transparentColor, 0.0, 1.0), alpha);
      } else {
        gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
      }
    }
  `;

  class SDFHDRenderer {
    constructor(canvas, width, height, params) {
      this.canvas = canvas;
      this.width = width;
      this.height = height;
      this.count = width * height;

      this.params = Object.assign({
        halo: 0.46,
        cutoff: 0.56,
        gamma: 1.5,
        radius: 8,
        threshold: 0.08,
        preSmooth: 1,
        expansion: 0.0,
        scale: 5,
        transparentBackground: false
      }, params || {});

      this.rawMask = new Uint8Array(this.count);
      this.lastRawMask = new Uint8Array(this.count);
      this.maskAlpha = new Uint8Array(this.count);
      this.coverageA = new Float64Array(this.count);
      this.coverageB = new Float64Array(this.count);

      this.outer = new Float64Array(this.count);
      this.inner = new Float64Array(this.count);
      this.signedDistance = new Float32Array(this.count);
      this.sdfBytes = new Uint8Array(this.count);

      const maxAxis = Math.max(width, height);
      this.f = new Float64Array(maxAxis);
      this.z = new Float64Array(maxAxis + 1);
      this.v = new Uint32Array(maxAxis);

      this.hasRawMask = false;
      this.hasDistances = false;
      this.needsMaskRebuild = true;
      this.needsEncode = true;

      const gl = canvas.getContext('webgl', {
        alpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false
      });

      if (!gl) throw new Error('WebGL no disponible para SDF LAB V2');

      this.gl = gl;
      this.program = this._createProgram(VERTEX_SHADER, FRAGMENT_SHADER);
      gl.useProgram(this.program);

      const vertices = new Float32Array([
        -1, -1, 0, 1,
         1, -1, 1, 1,
        -1,  1, 0, 0,
         1,  1, 1, 0
      ]);

      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

      const stride = 4 * Float32Array.BYTES_PER_ELEMENT;
      const posLoc = gl.getAttribLocation(this.program, 'a_position');
      const uvLoc = gl.getAttribLocation(this.program, 'a_uv');

      gl.enableVertexAttribArray(posLoc);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, stride, 0);

      gl.enableVertexAttribArray(uvLoc);
      gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);

      this.sourceTexture = this._createTexture(gl.NEAREST, gl.NEAREST);
      this.sdfTexture = this._createTexture(gl.LINEAR, gl.LINEAR);

      this.uniforms = {
        source: gl.getUniformLocation(this.program, 'u_source'),
        sdf: gl.getUniformLocation(this.program, 'u_sdf'),
        sourceSize: gl.getUniformLocation(this.program, 'u_sourceSize'),
        scale: gl.getUniformLocation(this.program, 'u_scale'),
        halo: gl.getUniformLocation(this.program, 'u_halo'),
        cutoff: gl.getUniformLocation(this.program, 'u_cutoff'),
        gamma: gl.getUniformLocation(this.program, 'u_gamma'),
        expansion: gl.getUniformLocation(this.program, 'u_expansion'),
        radius: gl.getUniformLocation(this.program, 'u_radius'),
        threshold: gl.getUniformLocation(this.program, 'u_threshold'),
        labBackground: gl.getUniformLocation(this.program, 'u_labBackground'),
        transparentBackground: gl.getUniformLocation(this.program, 'u_transparentBackground')
      };

      gl.uniform1i(this.uniforms.source, 0);
      gl.uniform1i(this.uniforms.sdf, 1);
      gl.uniform2f(this.uniforms.sourceSize, width, height);
      gl.uniform3f(this.uniforms.labBackground, 0.43, 0.45, 0.48);
      gl.uniform1f(this.uniforms.transparentBackground, this.params.transparentBackground ? 1.0 : 0.0);

      this._resize();
      this._uploadEmptyTextures();
    }

    _createTexture(minFilter, magFilter) {
      const gl = this.gl;
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, magFilter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return texture;
    }

    _uploadEmptyTextures() {
      const gl = this.gl;

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.sdfTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, this.width, this.height, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, null);
    }

    _compile(type, source) {
      const gl = this.gl;
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);

      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = (gl.getShaderInfoLog(shader) || 'Error de shader').replace(/\s+/g, ' ');
        gl.deleteShader(shader);
        throw new Error(log);
      }
      return shader;
    }

    _createProgram(vertexSource, fragmentSource) {
      const gl = this.gl;
      const vertex = this._compile(gl.VERTEX_SHADER, vertexSource);
      const fragment = this._compile(gl.FRAGMENT_SHADER, fragmentSource);
      const program = gl.createProgram();

      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);

      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const log = (gl.getProgramInfoLog(program) || 'Error enlazando shader').replace(/\s+/g, ' ');
        gl.deleteProgram(program);
        throw new Error(log);
      }
      return program;
    }

    _resize() {
      const scale = Math.max(2, Math.min(8, Math.round(Number(this.params.scale) || 5)));
      this.params.scale = scale;
      this.canvas.width = this.width * scale;
      this.canvas.height = this.height * scale;
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }

    setParams(next) {
      const before = Object.assign({}, this.params);
      Object.assign(this.params, next || {});

      this.params.halo = Math.max(0.01, Math.min(0.99, Number(this.params.halo)));
      this.params.cutoff = Math.max(0.01, Math.min(0.99, Number(this.params.cutoff)));
      this.params.gamma = Math.max(0, Math.min(4, Number(this.params.gamma)));
      this.params.radius = Math.max(1, Math.min(32, Number(this.params.radius)));
      this.params.threshold = Math.max(0.001, Math.min(0.99, Number(this.params.threshold)));
      this.params.preSmooth = Math.max(0, Math.min(4, Math.round(Number(this.params.preSmooth))));
      this.params.expansion = Math.max(-4, Math.min(4, Number(this.params.expansion)));
      this.params.scale = Math.max(2, Math.min(8, Math.round(Number(this.params.scale))));

      if (this.params.scale !== before.scale) this._resize();

      if (this.params.threshold !== before.threshold || this.params.preSmooth !== before.preSmooth) {
        this.needsMaskRebuild = true;
      }

      if (this.params.radius !== before.radius) {
        this.needsEncode = true;
      }
    }

    _updateRawMask(rgba) {
      const threshold = Number(this.params.threshold);
      let changed = !this.hasRawMask;

      for (let i = 0, p = 0; i < this.count; i++, p += 4) {
        const r = rgba[p] / 255;
        const g = rgba[p + 1] / 255;
        const b = rgba[p + 2] / 255;
        const lum = r * 0.2126 + g * 0.7152 + b * 0.0722;
        const value = lum >= threshold ? 255 : 0;
        this.rawMask[i] = value;
        if (!changed && value !== this.lastRawMask[i]) changed = true;
      }

      if (changed) {
        this.lastRawMask.set(this.rawMask);
        this.hasRawMask = true;
        this.needsMaskRebuild = true;
      }
    }

    _blurCoverage() {
      const passes = Number(this.params.preSmooth) | 0;
      const W = this.width;
      const H = this.height;
      const A = this.coverageA;
      const B = this.coverageB;

      for (let i = 0; i < this.count; i++) A[i] = this.rawMask[i] / 255;

      if (passes <= 0) {
        for (let i = 0; i < this.count; i++) this.maskAlpha[i] = this.rawMask[i];
        return;
      }

      let src = A;
      let tmp = B;

      for (let pass = 0; pass < passes; pass++) {
        for (let y = 0; y < H; y++) {
          const row = y * W;
          for (let x = 0; x < W; x++) {
            const xm = x > 0 ? x - 1 : x;
            const xp = x + 1 < W ? x + 1 : x;
            tmp[row + x] = (src[row + xm] + 2 * src[row + x] + src[row + xp]) * 0.25;
          }
        }

        const swap1 = src;
        src = tmp;
        tmp = swap1;

        for (let y = 0; y < H; y++) {
          const ym = y > 0 ? y - 1 : y;
          const yp = y + 1 < H ? y + 1 : y;
          for (let x = 0; x < W; x++) {
            tmp[y * W + x] = (
              src[ym * W + x] +
              2 * src[y * W + x] +
              src[yp * W + x]
            ) * 0.25;
          }
        }

        const swap2 = src;
        src = tmp;
        tmp = swap2;
      }

      for (let i = 0; i < this.count; i++) {
        this.maskAlpha[i] = Math.max(0, Math.min(255, Math.round(src[i] * 255)));
      }
    }

    _rebuildDistances() {
      this._blurCoverage();

      for (let i = 0; i < this.count; i++) {
        const a = this.maskAlpha[i];

        if (a === 0) {
          this.outer[i] = INF;
          this.inner[i] = 0;
        } else if (a === 255) {
          this.outer[i] = 0;
          this.inner[i] = INF;
        } else {
          const t = alphaTable[a];
          this.outer[i] = Math.max(0, t);
          this.inner[i] = Math.max(0, -t);
        }
      }

      edt(this.outer, this.width, this.height, this.f, this.v, this.z);
      edt(this.inner, this.width, this.height, this.f, this.v, this.z);

      for (let i = 0; i < this.count; i++) {
        this.signedDistance[i] = Math.sqrt(this.outer[i]) - Math.sqrt(this.inner[i]);
      }

      this.hasDistances = true;
      this.needsMaskRebuild = false;
      this.needsEncode = true;
    }

    _encodeSDF() {
      if (!this.hasDistances) return;

      const radius = Math.max(1, Number(this.params.radius));

      for (let i = 0; i < this.count; i++) {
        // 0.5 is exactly the reconstructed edge. Radius controls how quickly
        // the encoded value ramps toward fully outside/inside.
        const normalized = 0.5 - this.signedDistance[i] / (2 * radius);
        this.sdfBytes[i] = Math.max(0, Math.min(255, Math.round(normalized * 255)));
      }

      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.sdfTexture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.LUMINANCE,
        this.width,
        this.height,
        0,
        gl.LUMINANCE,
        gl.UNSIGNED_BYTE,
        this.sdfBytes
      );

      this.needsEncode = false;
    }

    render(rgba) {
      const gl = this.gl;

      this._updateRawMask(rgba);
      if (this.needsMaskRebuild || !this.hasDistances) this._rebuildDistances();
      if (this.needsEncode) this._encodeSDF();

      gl.useProgram(this.program);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        this.width,
        this.height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        rgba
      );

      gl.uniform1f(this.uniforms.scale, Number(this.params.scale));
      gl.uniform1f(this.uniforms.halo, Number(this.params.halo));
      gl.uniform1f(this.uniforms.cutoff, Number(this.params.cutoff));
      gl.uniform1f(this.uniforms.gamma, Number(this.params.gamma));
      gl.uniform1f(this.uniforms.expansion, Number(this.params.expansion));
      gl.uniform1f(this.uniforms.radius, Number(this.params.radius));
      gl.uniform1f(this.uniforms.threshold, Number(this.params.threshold));
      gl.uniform1f(this.uniforms.transparentBackground, this.params.transparentBackground ? 1.0 : 0.0);

      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  window.SDFHDRenderer = SDFHDRenderer;
})();
