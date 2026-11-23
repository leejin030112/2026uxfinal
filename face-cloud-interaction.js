(() => {
  const data = window.FACE_CLOUD_DATA;
  const canvas = document.getElementById("face-cloud-canvas");
  const brush = document.getElementById("face-cloud-brush");
  if (!data || !canvas || !window.WebGLRenderingContext) return;

  const host = canvas.parentElement;
  const gl = canvas.getContext("webgl", { alpha: false, antialias: true, depth: true, powerPreference: "high-performance" });
  if (!gl) return;

  const decode64 = (value) => {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };
  let positions = new Float32Array(decode64(data.positions).buffer);
  const rawColors = decode64(data.colors);
  const count = data.count;
  const colors = new Float32Array(count * 3);
  const opacity = new Float32Array(count);
  opacity.fill(1);
  for (let i = 0; i < count * 3; i++) colors[i] = rawColors[i] / 255;

  const vertexSource = `
    attribute vec3 aPosition;
    attribute vec3 aColor;
    attribute float aOpacity;
    uniform float uYaw;
    uniform float uPitch;
    uniform float uZoom;
    uniform float uDpr;
    varying vec3 vColor;
    varying float vOpacity;
    void main() {
      float cy = cos(uYaw), sy = sin(uYaw);
      vec3 p = vec3(aPosition.x * cy + aPosition.z * sy, aPosition.y, -aPosition.x * sy + aPosition.z * cy);
      float cx = cos(uPitch), sx = sin(uPitch);
      p = vec3(p.x, p.y * cx - p.z * sx, p.y * sx + p.z * cx);
      float depth = 4.2 - uZoom - p.z;
      float focal = 1.8;
      float zClip = 1.002002 * depth - 0.2002002;
      gl_Position = vec4(p.x * focal, p.y * focal, zClip, depth);
      gl_PointSize = clamp(2.4 * uDpr * (4.2 / depth), 1.0, 7.0);
      vColor = aColor;
      vOpacity = aOpacity;
    }
  `;
  const fragmentSource = `
    precision mediump float;
    varying vec3 vColor;
    varying float vOpacity;
    uniform float uRoundPoints;
    void main() {
      if (uRoundPoints > 0.5) {
        vec2 p = gl_PointCoord - vec2(0.5);
        if (dot(p, p) > 0.25) discard;
      }
      gl_FragColor = vec4(vColor, vOpacity);
    }
  `;

  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
  gl.useProgram(program);

  const locations = {
    position: gl.getAttribLocation(program, "aPosition"),
    color: gl.getAttribLocation(program, "aColor"),
    opacity: gl.getAttribLocation(program, "aOpacity"),
    yaw: gl.getUniformLocation(program, "uYaw"),
    pitch: gl.getUniformLocation(program, "uPitch"),
    zoom: gl.getUniformLocation(program, "uZoom"),
    dpr: gl.getUniformLocation(program, "uDpr"),
    round: gl.getUniformLocation(program, "uRoundPoints"),
  };

  const pointPositionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, pointPositionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(locations.position);
  gl.vertexAttribPointer(locations.position, 3, gl.FLOAT, false, 0, 0);

  const pointColorBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, pointColorBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(locations.color);
  gl.vertexAttribPointer(locations.color, 3, gl.FLOAT, false, 0, 0);

  const opacityBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, opacityBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, opacity, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(locations.opacity);
  gl.vertexAttribPointer(locations.opacity, 1, gl.FLOAT, false, 0, 0);

  const linePositionBuffer = gl.createBuffer();
  const lineColorBuffer = gl.createBuffer();
  let lineVertexCount = 0;
  let width = 1;
  let height = 1;
  let dpr = 1;
  let yaw = 0.22;
  let pitch = 0.1;
  let zoom = 0;
  let brushRadius = 78;
  let mode = "idle";
  let pointerStart = null;
  let activeEffect = null;
  const effects = [];
  const focal = 1.8;

  const bindAttribute = (buffer, location, size) => {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
  };

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = rect.width;
    height = rect.height;
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  const rotateToCamera = (x, y, z, yawValue = yaw, pitchValue = pitch) => {
    const cy = Math.cos(yawValue), sy = Math.sin(yawValue);
    let px = x * cy + z * sy;
    let py = y;
    let pz = -x * sy + z * cy;
    const cx = Math.cos(pitchValue), sx = Math.sin(pitchValue);
    const nextY = py * cx - pz * sx;
    const nextZ = py * sx + pz * cx;
    py = nextY;
    pz = nextZ;
    return [px, py, pz];
  };

  const project = (index, yawValue = yaw, pitchValue = pitch) => {
    const p = rotateToCamera(positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2], yawValue, pitchValue);
    const depth = 4.2 - zoom - p[2];
    const factor = focal / depth;
    return [width * 0.5 + p[0] * factor * width * 0.5, height * 0.5 - p[1] * factor * height * 0.5, depth];
  };

  function findNearest(x, y) {
    const candidates = [];
    for (let i = 0; i < count; i++) {
      const p = project(i);
      if (p[2] <= 0.1) continue;
      const distance = Math.hypot(p[0] - x, p[1] - y);
      // Approximate the visible point footprint, then prefer the closest
      // point in camera depth so a click cannot select a point behind it.
      if (distance <= 6) candidates.push({ index: i, distance, depth: p[2] });
    }
    if (!candidates.length) return { index: -1, distance: Infinity, screen: null };
    candidates.sort((a, b) => a.depth - b.depth || a.distance - b.distance);
    const front = candidates[0];
    return { index: front.index, distance: front.distance, screen: project(front.index) };
  }

  function collectInRadius(seedIndex, radiusPixels) {
    const selected = [];
    const seed = [positions[seedIndex * 3], positions[seedIndex * 3 + 1], positions[seedIndex * 3 + 2]];
    const depth = project(seedIndex)[2];
    const worldPerPixel = (2 * depth) / (focal * Math.max(1, height));
    const radiusWorld = radiusPixels * worldPerPixel;
    const radiusSquared = radiusWorld * radiusWorld;
    for (let i = 0; i < count; i++) {
      const ox = positions[i * 3] - seed[0];
      const oy = positions[i * 3 + 1] - seed[1];
      const oz = positions[i * 3 + 2] - seed[2];
      const distanceSquared = ox * ox + oy * oy + oz * oz;
      if (distanceSquared > radiusSquared) continue;
      selected.push({
        index: i,
        weight: 1,
        origin: [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]],
        baseOpacity: opacity[i],
      });
    }
    if (selected.length > 1800) {
      const stride = Math.ceil(selected.length / 1800);
      return selected.filter((_, i) => i % stride === 0);
    }
    return selected;
  }

  function linesFor(effect) {
    if (!effect || Math.hypot(effect.dx, effect.dy) < 1) return { positions: new Float32Array(0), colors: new Float32Array(0) };
    const outPositions = new Float32Array(effect.points.length * 6);
    const outColors = new Float32Array(effect.points.length * 6);
    let out = 0;
    for (const item of effect.points) {
      const i = item.index, w = item.weight;
      const x = item.origin[0], y = item.origin[1], z = item.origin[2];
      const ex = x + effect.delta[0] * w;
      const ey = y + effect.delta[1] * w;
      const ez = z + effect.delta[2] * w;
      const col = [colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]];
      outPositions.set([x, y, z, ex, ey, ez], out);
      outColors.set([...col, ...col], out);
      out += 6;
    }
    return { positions: outPositions, colors: outColors };
  }

  function applyActiveDeformation() {
    if (!activeEffect) return;
    const cy = Math.cos(activeEffect.yaw), sy = Math.sin(activeEffect.yaw);
    const sp = Math.sin(activeEffect.pitch), cp = Math.cos(activeEffect.pitch);
    const right = [cy, 0, sy];
    const up = [sp * sy, cp, -sp * cy];
    const moveRight = activeEffect.dx * activeEffect.worldPerPixel;
    const moveUp = -activeEffect.dy * activeEffect.worldPerPixel;
    activeEffect.delta = [
      right[0] * moveRight + up[0] * moveUp,
      right[1] * moveRight + up[1] * moveUp,
      right[2] * moveRight + up[2] * moveUp,
    ];
    for (const item of activeEffect.points) {
      const offset = item.index * 3;
      positions[offset] = item.origin[0] + activeEffect.delta[0] * item.weight;
      positions[offset + 1] = item.origin[1] + activeEffect.delta[1] * item.weight;
      positions[offset + 2] = item.origin[2] + activeEffect.delta[2] * item.weight;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, pointPositionBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, positions);
    activeEffect.lines = linesFor(activeEffect);
  }
  function refreshLines() {
    const batches = effects.map((effect) => effect.lines).filter((batch) => batch && batch.positions.length);
    if (activeEffect && activeEffect.lines && activeEffect.lines.positions.length) batches.push(activeEffect.lines);
    lineVertexCount = batches.reduce((sum, batch) => sum + batch.positions.length / 3, 0);
    if (!lineVertexCount) return;
    const allPositions = new Float32Array(lineVertexCount * 3);
    const allColors = new Float32Array(lineVertexCount * 3);
    let offset = 0;
    for (const batch of batches) {
      allPositions.set(batch.positions, offset);
      allColors.set(batch.colors, offset);
      offset += batch.positions.length;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, linePositionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, allPositions, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, lineColorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, allColors, gl.DYNAMIC_DRAW);
  }

  function updateBrush(x, y, show = true) {
    if (!brush) return;
    brush.style.display = show ? "block" : "none";
    brush.style.width = `${brushRadius * 2}px`;
    brush.style.height = `${brushRadius * 2}px`;
    brush.style.left = `${x}px`;
    brush.style.top = `${y}px`;
  }

  function render() {
    resize();
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(program);
    gl.uniform1f(locations.yaw, yaw);
    gl.uniform1f(locations.pitch, pitch);
    gl.uniform1f(locations.zoom, zoom);
    gl.uniform1f(locations.dpr, dpr);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.uniform1f(locations.round, 1);
    bindAttribute(pointPositionBuffer, locations.position, 3);
    bindAttribute(pointColorBuffer, locations.color, 3);
    bindAttribute(opacityBuffer, locations.opacity, 1);
    gl.drawArrays(gl.POINTS, 0, count);

    if (lineVertexCount > 0) {
      gl.disable(gl.DEPTH_TEST);
      gl.uniform1f(locations.round, 0);
      bindAttribute(linePositionBuffer, locations.position, 3);
      bindAttribute(lineColorBuffer, locations.color, 3);
      gl.disableVertexAttribArray(locations.opacity);
      gl.vertexAttrib1f(locations.opacity, 0.96);
      gl.drawArrays(gl.LINES, 0, lineVertexCount);
      gl.enableVertexAttribArray(locations.opacity);
      bindAttribute(opacityBuffer, locations.opacity, 1);
      gl.enable(gl.DEPTH_TEST);
    }
    requestAnimationFrame(render);
  }

  const localPoint = (event) => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  canvas.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    const p = localPoint(event);
    pointerStart = { x: p.x, y: p.y, clientX: event.clientX, clientY: event.clientY, yaw, pitch, radius: brushRadius };
    if (event.button === 2) {
      mode = "radius";
      updateBrush(p.x, p.y, true);
      return;
    }
    if (event.button === 1 || event.altKey) {
      mode = "orbit";
      return;
    }
    const nearest = findNearest(p.x, p.y);
    if (nearest.index >= 0) {
      mode = "draw";
      activeEffect = {
        points: collectInRadius(nearest.index, brushRadius),
        worldPerPixel: (2 * nearest.screen[2]) / (focal * Math.max(1, height)),
        delta: [0, 0, 0],
        dx: 0,
        dy: 0,
        yaw,
        pitch,
        lines: null,
      };
    } else {
      mode = "orbit";
    }
  });

  canvas.addEventListener("pointermove", (event) => {
    const p = localPoint(event);
    if (mode === "radius" && pointerStart) {
      brushRadius = Math.max(14, Math.min(220, pointerStart.radius + (event.clientX - pointerStart.clientX) * 0.65));
      updateBrush(p.x, p.y, true);
    } else if (mode === "draw" && pointerStart && activeEffect) {
      activeEffect.dx = p.x - pointerStart.x;
      activeEffect.dy = p.y - pointerStart.y;
      applyActiveDeformation();
      if (!activeEffect.dimmed) {
        for (const item of activeEffect.points) opacity[item.index] = item.baseOpacity * (1 - 0.55 * item.weight);
        gl.bindBuffer(gl.ARRAY_BUFFER, opacityBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, opacity, gl.DYNAMIC_DRAW);
        activeEffect.dimmed = true;
      }
      refreshLines();
    } else if (mode === "orbit" && pointerStart) {
      yaw += (event.clientX - pointerStart.clientX) * 0.006;
      pitch = Math.max(-1.35, Math.min(1.35, pitch + (event.clientY - pointerStart.clientY) * 0.006));
      pointerStart.clientX = event.clientX;
      pointerStart.clientY = event.clientY;
    } else {
      updateBrush(p.x, p.y, true);
    }
  });

  function finishPointer(event, cancelled = false) {
    if (mode === "draw" && activeEffect && !cancelled && Math.hypot(activeEffect.dx, activeEffect.dy) > 4 && activeEffect.points.length) {
      const completedEffect = activeEffect;
      completedEffect.lines = linesFor(completedEffect);
      effects.push({ lines: completedEffect.lines });
      if (effects.length > 20) effects.shift();
      for (const item of completedEffect.points) opacity[item.index] = item.baseOpacity;
      gl.bindBuffer(gl.ARRAY_BUFFER, opacityBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, opacity, gl.DYNAMIC_DRAW);
      activeEffect = null;
      refreshLines();
    } else if (mode === "draw") {
      if (activeEffect) {
        for (const item of activeEffect.points) {
          const offset = item.index * 3;
          positions[offset] = item.origin[0];
          positions[offset + 1] = item.origin[1];
          positions[offset + 2] = item.origin[2];
          opacity[item.index] = item.baseOpacity;
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, pointPositionBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, positions);
        gl.bindBuffer(gl.ARRAY_BUFFER, opacityBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, opacity, gl.DYNAMIC_DRAW);
      }
      activeEffect = null;
      refreshLines();
    }
    if (mode === "radius") updateBrush(0, 0, false);
    mode = "idle";
    pointerStart = null;
    activeEffect = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  }
  canvas.addEventListener("pointerup", (event) => finishPointer(event, false));
  canvas.addEventListener("pointercancel", (event) => finishPointer(event, true));
  canvas.addEventListener("pointerleave", (event) => {
    if (mode === "idle") updateBrush(0, 0, false);
  });
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    zoom = Math.max(-1.1, Math.min(1.5, zoom + event.deltaY * 0.0012));
  }, { passive: false });

  new ResizeObserver(resize).observe(host);
  resize();
  render();
})();






