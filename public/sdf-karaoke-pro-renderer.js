/*
 * DJGABO CDG Player - SDF KARAOKE PRO
 *
 * Independent quality mode combining the stable SDF renderer with
 * karaoke-style gradient, outline and shadow controls.
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
    uniform sampler2D u_gradientRows;
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
    uniform float u_karaokeHD;
    uniform vec2 u_shadowOffset;
    uniform float u_shadowAlpha;
    uniform float u_shadowBlur;
    uniform float u_proOutline;

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

      // Base SDF contour plus an independent PRO outline expansion.
      float outlineShift = u_proOutline / max(2.0 * u_radius, 0.001);
      float proHalo = u_halo - outlineShift;
      float haloAlpha = smoothstep(proHalo - aa, proHalo + aa, sdf);
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

      // Optional KARAOKE HD layer for SDF KARAOKE PRO.
      // Gradient rows are precomputed from the decoded glyph mask.
      float gradientFactor = texture2D(u_gradientRows, vec2(0.5, v_uv.y)).r * 1.5;
      fillColor *= gradientFactor;

      // Directional soft shadow from the exact same SDF geometry.
      vec2 shadowUv = clamp(v_uv - u_shadowOffset, vec2(0.0), vec2(1.0));
      vec2 blurStep = texel * u_shadowBlur;

      float shadowMask = 0.0;
      shadowMask += smoothstep(proHalo - aa, proHalo + aa,
        texture2D(u_sdf, shadowUv).r + u_expansion / max(2.0 * u_radius, 0.001));
      shadowMask += smoothstep(proHalo - aa, proHalo + aa,
        texture2D(u_sdf, shadowUv + vec2( blurStep.x, 0.0)).r + u_expansion / max(2.0 * u_radius, 0.001));
      shadowMask += smoothstep(proHalo - aa, proHalo + aa,
        texture2D(u_sdf, shadowUv + vec2(-blurStep.x, 0.0)).r + u_expansion / max(2.0 * u_radius, 0.001));
      shadowMask += smoothstep(proHalo - aa, proHalo + aa,
        texture2D(u_sdf, shadowUv + vec2(0.0,  blurStep.y)).r + u_expansion / max(2.0 * u_radius, 0.001));
      shadowMask += smoothstep(proHalo - aa, proHalo + aa,
        texture2D(u_sdf, shadowUv + vec2(0.0, -blurStep.y)).r + u_expansion / max(2.0 * u_radius, 0.001));
      shadowMask += smoothstep(proHalo - aa, proHalo + aa,
        texture2D(u_sdf, shadowUv + vec2( blurStep.x,  blurStep.y)).r + u_expansion / max(2.0 * u_radius, 0.001));
      shadowMask += smoothstep(proHalo - aa, proHalo + aa,
        texture2D(u_sdf, shadowUv + vec2(-blurStep.x,  blurStep.y)).r + u_expansion / max(2.0 * u_radius, 0.001));
      shadowMask += smoothstep(proHalo - aa, proHalo + aa,
        texture2D(u_sdf, shadowUv + vec2( blurStep.x, -blurStep.y)).r + u_expansion / max(2.0 * u_radius, 0.001));
      shadowMask += smoothstep(proHalo - aa, proHalo + aa,
        texture2D(u_sdf, shadowUv + vec2(-blurStep.x, -blurStep.y)).r + u_expansion / max(2.0 * u_radius, 0.001));
      shadowMask /= 9.0;

      float shadowOnly = max(0.0, shadowMask - haloAlpha);

      vec3 color = u_labBackground;
      color = mix(color, vec3(0.0), shadowOnly * u_shadowAlpha);
      color = mix(color, vec3(0.0), haloAlpha);
      color = mix(color, fillColor, fillAlpha);

      if (u_transparentBackground > 0.5) {
        float alpha = clamp(max(fillAlpha, max(haloAlpha, shadowOnly * u_shadowAlpha)), 0.0, 1.0);
        vec3 transparentColor = vec3(0.0);
        transparentColor = mix(transparentColor, vec3(0.0), shadowOnly * u_shadowAlpha);
        transparentColor = mix(transparentColor, vec3(0.0), haloAlpha);
        transparentColor = mix(transparentColor, fillColor, fillAlpha);
        gl_FragColor = vec4(clamp(transparentColor, 0.0, 1.0), alpha);
      } else {
        gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
      }
    }
  `;

  class SDFKaraokeProRenderer {
    constructor(canvas, width, height, params) {
      this.canvas = canvas;
      this.width = width;
      this.height = height;
      this.count = width * height;

      this.params = Object.assign({
        halo: 0.47,
        cutoff: 0.54,
        gamma: 0.85,
        radius: 7,
        threshold: 0.01,
        preSmooth: 0,
        expansion: 0.60,
        scale: 8,
        karaokeHD: true,
        programGradient: 35,
        proOutline: 0.60,
        shadowX: 1.25,
        shadowY: 1.00,
        shadowBlur: 0.85,
        shadowAlpha: 0.75,
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
      this.gradientRows = new Uint8Array(this.height);
      this.gradientRows.fill(Math.round((1 / 1.5) * 255));
      this.lastLineCount = 0;

      const maxAxis = Math.max(width, height);
      this.f = new Float64Array(maxAxis);
      this.z = new Float64Array(maxAxis + 1);
      this.v = new Uint32Array(maxAxis);

      this.hasRawMask = false;
      this.hasDistances = false;
      this.needsMaskRebuild = true;
      this.needsEncode = true;
      this.needsGradientRebuild = true;

      const gl = canvas.getContext('webgl', {
        alpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false
      });

      if (!gl) throw new Error('WebGL no disponible para SDF KARAOKE PRO');

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
      this.gradientTexture = this._createTexture(gl.LINEAR, gl.LINEAR);

      this.uniforms = {
        source: gl.getUniformLocation(this.program, 'u_source'),
        sdf: gl.getUniformLocation(this.program, 'u_sdf'),
        gradientRows: gl.getUniformLocation(this.program, 'u_gradientRows'),
        sourceSize: gl.getUniformLocation(this.program, 'u_sourceSize'),
        scale: gl.getUniformLocation(this.program, 'u_scale'),
        halo: gl.getUniformLocation(this.program, 'u_halo'),
        cutoff: gl.getUniformLocation(this.program, 'u_cutoff'),
        gamma: gl.getUniformLocation(this.program, 'u_gamma'),
        expansion: gl.getUniformLocation(this.program, 'u_expansion'),
        radius: gl.getUniformLocation(this.program, 'u_radius'),
        threshold: gl.getUniformLocation(this.program, 'u_threshold'),
        labBackground: gl.getUniformLocation(this.program, 'u_labBackground'),
        transparentBackground: gl.getUniformLocation(this.program, 'u_transparentBackground'),
        karaokeHD: gl.getUniformLocation(this.program, 'u_karaokeHD'),
        shadowOffset: gl.getUniformLocation(this.program, 'u_shadowOffset'),
        shadowAlpha: gl.getUniformLocation(this.program, 'u_shadowAlpha'),
        shadowBlur: gl.getUniformLocation(this.program, 'u_shadowBlur'),
        proOutline: gl.getUniformLocation(this.program, 'u_proOutline')
      };

      gl.uniform1i(this.uniforms.source, 0);
      gl.uniform1i(this.uniforms.sdf, 1);
      gl.uniform1i(this.uniforms.gradientRows, 2);
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

      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.gradientTexture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.LUMINANCE,
        1,
        this.height,
        0,
        gl.LUMINANCE,
        gl.UNSIGNED_BYTE,
        this.gradientRows
      );
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
      this.params.karaokeHD = true;
      this.params.programGradient = Math.max(1, Math.min(100, Math.round(Number(this.params.programGradient) || 100)));
      this.params.proOutline = Math.max(0, Math.min(2.5, Number(this.params.proOutline) || 0));
      this.params.shadowX = Math.max(-2, Math.min(4, Number(this.params.shadowX) || 0));
      this.params.shadowY = Math.max(-2, Math.min(5, Number(this.params.shadowY) || 0));
      this.params.shadowBlur = Math.max(0, Math.min(3, Number(this.params.shadowBlur) || 0));
      this.params.shadowAlpha = Math.max(0, Math.min(0.9, Number(this.params.shadowAlpha) || 0));

      if (this.params.scale !== before.scale) this._resize();

      if (this.params.threshold !== before.threshold || this.params.preSmooth !== before.preSmooth) {
        this.needsMaskRebuild = true;
      }

      if (this.params.radius !== before.radius) {
        this.needsEncode = true;
      }

      if (
        this.params.programGradient !== before.programGradient
      ) {
        this.needsGradientRebuild = true;
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
        this.needsGradientRebuild = true;
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

    _rebuildGradientRows() {
      const neutral = Math.round((1 / 1.5) * 255);
      this.gradientRows.fill(neutral);

      if (!this.hasRawMask) {
        this._uploadGradientRows();
        this.needsGradientRebuild = false;
        return;
      }

      const rowCounts = new Uint16Array(this.height);
      const active = new Uint8Array(this.height);

      for (let y = 0; y < this.height; y++) {
        let count = 0;
        const row = y * this.width;
        for (let x = 0; x < this.width; x++) {
          if (this.rawMask[row + x] > 0) count++;
        }
        rowCounts[y] = count;
        active[y] = count >= 6 ? 1 : 0;
      }

      // Bridge gaps up to 2 rows so counters/sparse strokes remain one lyric band.
      for (let y = 1; y < this.height - 1; y++) {
        if (active[y]) continue;
        if (active[y - 1] && active[y + 1]) active[y] = 1;
        if (
          y + 2 < this.height &&
          active[y - 1] &&
          active[y + 2]
        ) {
          active[y] = 1;
          active[y + 1] = 1;
        }
      }

      const lines = [];
      let y = 0;
      while (y < this.height) {
        while (y < this.height && !active[y]) y++;
        if (y >= this.height) break;

        let top = y;
        while (y < this.height && active[y]) y++;
        let bottom = y - 1;

        if (bottom - top + 1 >= 2) {
          top = Math.max(0, top - 1);
          bottom = Math.min(this.height - 1, bottom + 1);
          lines.push({ top, bottom });
        }
      }

      this.lastLineCount = lines.length;

      // Extended 1..100 intensity scale.
      // 1..25 reproduces the previous useful range; 25 is approximately
      // the old maximum. 26..100 intentionally pushes beyond that range
      // for aggressive/experimental gradient tests.
      const level = Math.max(1, Math.min(100, Number(this.params.programGradient) || 1));
      let strength;

      if (level <= 25) {
        strength = 0.35 + ((level - 1) / 24) * 0.65;
      } else {
        strength = 1.0 + ((level - 25) / 75) * 3.0;
      }

      for (const line of lines) {
        const h = Math.max(1, line.bottom - line.top + 1);

        for (let row = line.top; row <= line.bottom; row++) {
          const rel = row - line.top;
          let phase = Math.floor(((rel + 1) * 64) / (h + 1));
          phase = Math.max(0, Math.min(64, phase));

          let mapped;
          if (phase < 42) {
            mapped = Math.floor((phase * 64) / 42);
          } else {
            mapped = Math.floor(((64 - phase) * 64) / 22);
          }
          mapped = Math.max(0, Math.min(64, mapped));

          const x = (mapped / 64) * 2.5 - 2.5;
          const bell = Math.pow(2, -(x * x));
          const factor = (1 - 0.20 * strength) + (0.50 * strength * bell);

          this.gradientRows[row] = Math.max(
            0,
            Math.min(255, Math.round((factor / 1.5) * 255))
          );
        }
      }

      this._uploadGradientRows();
      this.needsGradientRebuild = false;
    }

    _uploadGradientRows() {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.gradientTexture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.LUMINANCE,
        1,
        this.height,
        0,
        gl.LUMINANCE,
        gl.UNSIGNED_BYTE,
        this.gradientRows
      );
    }

    render(rgba) {
      const gl = this.gl;

      this._updateRawMask(rgba);
      if (this.needsMaskRebuild || !this.hasDistances) this._rebuildDistances();
      if (this.needsEncode) this._encodeSDF();
      if (this.needsGradientRebuild) this._rebuildGradientRows();

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
      gl.uniform1f(this.uniforms.karaokeHD, 1.0);
      gl.uniform1f(this.uniforms.proOutline, Number(this.params.proOutline));

      gl.uniform2f(
        this.uniforms.shadowOffset,
        Number(this.params.shadowX) / this.width,
        Number(this.params.shadowY) / this.height
      );
      gl.uniform1f(this.uniforms.shadowBlur, Number(this.params.shadowBlur));
      gl.uniform1f(this.uniforms.shadowAlpha, Number(this.params.shadowAlpha));

      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.gradientTexture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    getState() {
      return {
        version: SDFKaraokeProRenderer.VERSION,
        lineCount: this.lastLineCount,
        programGradient: Number(this.params.programGradient)
      };
    }
  }

  SDFKaraokeProRenderer.VERSION = '1.2-sdf-karaoke-pro-extended-gradient-100';
  window.SDFKaraokeProRenderer = SDFKaraokeProRenderer;
})();
