import { Component, onMount, onCleanup, createSignal } from "solid-js"
import * as THREE from "three"

/**
 * ConstellationConvergence — 3D particle animation prototype.
 *
 * Particles drift in volumetric space, then converge to form a target image.
 * Five-phase timeline mapped to an estimated duration (no progress % from
 * the AI gateway, so the animation is time-driven, not progress-driven).
 *
 * Phases:
 *   1. Dormant Drift      (0–15%)  — slow Brownian + Perlin flow
 *   2. Attraction Wake    (15–30%) — gravity wells pulse at target positions
 *   3. Convergence Surge  (30–85%) — particles accelerate along curved paths
 *   4. Lock & Resolve     (85–95%) — snap-to-grid, micro-jitter decays
 *   5. Image Hold         (95–100%) — near-static, subtle breathing
 *   6. Overtime Grace     (>100%)  — slow reverse-dissolve if gen exceeds estimate
 *
 * Tunable via the control panel rendered beside the canvas.
 */

export interface ConstellationConvergenceProps {
  /** Estimated generation time in ms. Drives the phase timeline. */
  estimatedDuration?: number
  /** Target image URL — particles arrange to approximate this image. */
  targetImageUrl?: string
  /** Particle count (GPU budget). Default 10000, min floor 100. */
  particleCount?: number
  /** Brand color for particles (hex). */
  brandColor?: string
  /** Show the tuning panel. */
  showControls?: boolean
  /** Called when the full cycle completes (after hold phase). */
  onComplete?: () => void
}

/** Default target — Tokenizin logo (served from renderer public dir). */
const DEFAULT_TARGET_IMAGE = "Tokenizin-Logo.png"

interface PhaseConfig {
  name: string
  startPct: number
  endPct: number
}

const PHASES: PhaseConfig[] = [
  { name: "Dormant Drift", startPct: 0, endPct: 15 },
  { name: "Attraction Wake", startPct: 15, endPct: 30 },
  { name: "Convergence Surge", startPct: 30, endPct: 85 },
  { name: "Lock & Resolve", startPct: 85, endPct: 95 },
  { name: "Image Hold", startPct: 95, endPct: 100 },
]

/** Smoothstep easing — classic for particle convergence (slow in/out). */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** Perlin-like noise approximation using sin combos (cheap, GPU-friendly). */
function pseudoNoise(x: number, y: number, z: number, t: number): number {
  return (
    Math.sin(x * 0.5 + t * 0.3) * 0.4 +
    Math.sin(y * 0.7 + t * 0.2) * 0.3 +
    Math.sin(z * 0.6 + t * 0.25) * 0.3
  )
}

/** Ramp a phase from 0→1 across its window. */
function phaseRamp(progressPct: number, phase: PhaseConfig): number {
  return smoothstep(phase.startPct, phase.endPct, progressPct)
}

/** Inverse ramp (1→0) for phases that should fade out. */
function phaseRampOut(progressPct: number, phase: PhaseConfig): number {
  return 1 - smoothstep(phase.startPct, phase.endPct, progressPct)
}

export const ConstellationConvergence: Component<ConstellationConvergenceProps> = (props) => {
  let canvasRef: HTMLCanvasElement | undefined
  const [currentPhase, setCurrentPhase] = createSignal("Idle")
  const [progressPct, setProgressPct] = createSignal(0)
  const [elapsedMs, setElapsedMs] = createSignal(0)
  const [isPlaying, setIsPlaying] = createSignal(true)

  const estimatedDuration = () => props.estimatedDuration ?? 75000 // 75s default
  const particleCount = () => Math.max(100, props.particleCount ?? 10000)
  const brandColor = () => props.brandColor ?? "#d4af37"

  // ── Three.js scene refs (kept outside reactive system for perf) ────────
  let renderer: THREE.WebGLRenderer
  let scene: THREE.Scene
  let camera: THREE.PerspectiveCamera
  let geometry: THREE.BufferGeometry
  let material: THREE.ShaderMaterial
  let points: THREE.Points
  let animationId = 0
  let startTime = 0
  let targetPositions: Float32Array
  let initialPositions: Float32Array

  // ── Shader (GLSL) ──────────────────────────────────────────────────────
  // Vertex shader: computes position by blending initial drift → target.
  // Fragment shader: renders soft circular particles with brand color.

  const vertexShader = /* glsl */ `
    uniform float uProgress;
    uniform float uTime;
    uniform float uConvergence;   // 0 = drift, 1 = locked at target
    uniform float uBreath;        // 0–1 subtle scale pulse in hold
    uniform float uGrace;         // >0 when overtime; reverse dissolve
    uniform vec3 uBrandColor;
    uniform float uPixelRatio;

    attribute vec3 aInitialPos;
    attribute vec3 aTargetPos;
    attribute float aSize;
    attribute float aPhaseOffset;

    varying float vAlpha;
    varying vec3 vColor;

    // Cheap pseudo-noise for dormant drift
    float noise(vec3 p, float t) {
      return sin(p.x * 0.5 + t * 0.3) * 0.4
           + sin(p.y * 0.7 + t * 0.2) * 0.3
           + sin(p.z * 0.6 + t * 0.25) * 0.3;
    }

    void main() {
      // Convergence: lerp from initial to target with smoothstep
      float c = smoothstep(0.0, 1.0, uConvergence);

      // Curved path: add a perpendicular arc that diminishes as c→1
      vec3 mid = (aInitialPos + aTargetPos) * 0.5;
      vec3 perp = normalize(cross(aTargetPos - aInitialPos, vec3(0.0, 1.0, 0.0))) * 8.0;
      float arc = sin(c * 3.14159) * (1.0 - c) * 0.6;
      vec3 arcPos = mid + perp * arc;

      // Quadratic bezier: initial → arc → target
      vec3 p0 = aInitialPos;
      vec3 p1 = arcPos;
      vec3 p2 = aTargetPos;
      vec3 bez = p0 * (1.0 - c) * (1.0 - c) + p1 * 2.0 * (1.0 - c) * c + p2 * c * c;

      // Dormant drift: slow noise displacement (fades as convergence rises)
      float drift = noise(aInitialPos * 0.1, uTime + aPhaseOffset) * (1.0 - c) * 3.0;
      vec3 driftVec = vec3(
        sin(uTime * 0.4 + aPhaseOffset) * drift,
        cos(uTime * 0.3 + aPhaseOffset) * drift,
        sin(uTime * 0.5 + aPhaseOffset * 2.0) * drift
      );

      vec3 finalPos = bez + driftVec;

      // Micro-jitter during Lock & Resolve (decays)
      float jitterAmt = (1.0 - smoothstep(0.85, 0.95, uProgress)) * smoothstep(0.8, 0.9, uProgress) * 0.15;
      finalPos += vec3(
        sin(uTime * 40.0 + aPhaseOffset * 7.0),
        cos(uTime * 38.0 + aPhaseOffset * 5.0),
        sin(uTime * 42.0 + aPhaseOffset * 9.0)
      ) * jitterAmt;

      // Breath in hold phase
      float breathScale = 1.0 + uBreath * 0.005 * sin(uTime * 1.5);
      finalPos *= breathScale;

      // Grace (overtime): push particles back out slightly
      finalPos += normalize(aInitialPos - aTargetPos) * uGrace * 2.0;

      vec4 mvPosition = modelViewMatrix * vec4(finalPos, 1.0);

      // Size: larger when closer to camera; boost during convergence
      float sizeBoost = 1.0 + c * 0.3;
      gl_PointSize = aSize * sizeBoost * uPixelRatio * (300.0 / -mvPosition.z);

      gl_Position = projectionMatrix * mvPosition;

      // Alpha: fade in during drift, steady through convergence, slight glow at lock
      vAlpha = 0.4 + c * 0.5;
      vAlpha += smoothstep(0.85, 1.0, uProgress) * 0.1; // lock glow
      vAlpha -= uGrace * 0.15;
      vAlpha = clamp(vAlpha, 0.1, 1.0);

      vColor = uBrandColor;
    }
  `

  const fragmentShader = /* glsl */ `
    varying float vAlpha;
    varying vec3 vColor;

    void main() {
      // Soft circular particle (distance from center → alpha)
      vec2 uv = gl_PointCoord - 0.5;
      float dist = length(uv);
      if (dist > 0.5) discard;

      float soft = smoothstep(0.5, 0.0, dist);
      // Core glow — brighter center, softer edge
      float core = smoothstep(0.25, 0.0, dist) * 0.6 + soft * 0.4;

      vec3 col = vColor;
      // Hot core highlight when near locked
      col = mix(col, vec3(1.0, 0.97, 0.9), smoothstep(0.85, 1.0, vAlpha) * core * 0.5);

      gl_FragColor = vec4(col, core * vAlpha);
    }
  `

  // ── Generate target positions from an image (or procedural fallback) ───

  async function generateTargetPositions(
    imageUrl: string | undefined,
    count: number,
  ): Promise<Float32Array> {
    if (!imageUrl) {
      // Fallback: sphere shell — particles form a sphere surface
      const positions = new Float32Array(count * 3)
      for (let i = 0; i < count; i++) {
        const theta = Math.random() * Math.PI * 2
        const phi = Math.acos(2 * Math.random() - 1)
        const r = 12 + Math.random() * 1.5
        positions[i * 3] = r * Math.sin(phi) * Math.cos(theta)
        positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta)
        positions[i * 3 + 2] = r * Math.cos(phi)
      }
      return positions
    }

    // Load image → offscreen canvas → sample pixels → 3D positions
    return new Promise((resolve) => {
      const img = new Image()
      img.crossOrigin = "anonymous"
      img.onload = () => {
        const canvas = document.createElement("canvas")
        const maxSize = 120
        const scale = Math.min(maxSize / img.width, maxSize / img.height)
        canvas.width = Math.floor(img.width * scale)
        canvas.height = Math.floor(img.height * scale)
        const ctx = canvas.getContext("2d")!
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const positions = new Float32Array(count * 3)
        const { data, width: w, height: h } = imageData

        // Map each particle to a pixel with brightness > threshold
        // Z depth from brightness: brighter = closer to camera
        for (let i = 0; i < count; i++) {
          let attempts = 0
          let x = 0, y = 0, brightness = 0
          while (attempts < 10) {
            x = Math.floor(Math.random() * w)
            y = Math.floor(Math.random() * h)
            const idx = (y * w + x) * 4
            brightness = (data[idx] + data[idx + 1] + data[idx + 2]) / 3 / 255
            if (brightness > 0.15) break
            attempts++
          }

          // Normalize to [-10, 10] range
          const nx = (x / w - 0.5) * 20
          const ny = -(y / h - 0.5) * 20 // flip Y
          const nz = (brightness - 0.5) * 4 // depth from brightness

          positions[i * 3] = nx
          positions[i * 3 + 1] = ny
          positions[i * 3 + 2] = nz
        }
        resolve(positions)
      }
      img.onerror = () => resolve(generateTargetPositions(undefined, count))
      img.src = imageUrl
    })
  }

  function generateInitialPositions(count: number): Float32Array {
    const positions = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      // Large diffuse volume — wider than target for convergence distance
      positions[i * 3] = (Math.random() - 0.5) * 80
      positions[i * 3 + 1] = (Math.random() - 0.5) * 80
      positions[i * 3 + 2] = (Math.random() - 0.5) * 80
    }
    return positions
  }

  // ── Init Three.js scene ────────────────────────────────────────────────

  onMount(async () => {
    if (!canvasRef) return

    const width = canvasRef.clientWidth
    const height = canvasRef.clientHeight

    renderer = new THREE.WebGLRenderer({
      canvas: canvasRef,
      antialias: true,
      alpha: true,
    })
    renderer.setSize(width, height, false)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(0x04040a, 1)

    scene = new THREE.Scene()
    scene.fog = new THREE.FogExp2(0x04040a, 0.012)

    camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 200)
    camera.position.set(0, 0, 35)

    const count = particleCount()
    initialPositions = generateInitialPositions(count)
    targetPositions = await generateTargetPositions(props.targetImageUrl ?? DEFAULT_TARGET_IMAGE, count)

    geometry = new THREE.BufferGeometry()

    const sizes = new Float32Array(count)
    const phaseOffsets = new Float32Array(count)

    for (let i = 0; i < count; i++) {
      sizes[i] = 1.5 + Math.random() * 2.5
      phaseOffsets[i] = Math.random() * Math.PI * 2
    }

    geometry.setAttribute("position", new THREE.BufferAttribute(initialPositions.slice(), 3))
    geometry.setAttribute("aInitialPos", new THREE.BufferAttribute(initialPositions, 3))
    geometry.setAttribute("aTargetPos", new THREE.BufferAttribute(targetPositions, 3))
    geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1))
    geometry.setAttribute("aPhaseOffset", new THREE.BufferAttribute(phaseOffsets, 1))

    const brand = new THREE.Color(brandColor())
    material = new THREE.ShaderMaterial({
      uniforms: {
        uProgress: { value: 0 },
        uTime: { value: 0 },
        uConvergence: { value: 0 },
        uBreath: { value: 0 },
        uGrace: { value: 0 },
        uBrandColor: { value: brand },
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })

    points = new THREE.Points(geometry, material)
    scene.add(points)

    startTime = performance.now()

    // Resize handler
    const handleResize = () => {
      if (!canvasRef) return
      const w = canvasRef.clientWidth
      const h = canvasRef.clientHeight
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    window.addEventListener("resize", handleResize)

    // Animation loop
    const animate = () => {
      animationId = requestAnimationFrame(animate)
      if (!isPlaying()) {
        renderer.render(scene, camera)
        return
      }

      const elapsed = performance.now() - startTime
      setElapsedMs(elapsed)

      const estMs = estimatedDuration()
      const rawProgress = (elapsed / estMs) * 100
      const progress = Math.min(rawProgress, 150) // allow 50% overtime display
      setProgressPct(progress)

      // Determine current phase
      const currentPhaseName =
        progress < 15 ? "Dormant Drift" :
        progress < 30 ? "Attraction Wake" :
        progress < 85 ? "Convergence Surge" :
        progress < 95 ? "Lock & Resolve" :
        progress < 100 ? "Image Hold" :
        "Overtime Grace"
      setCurrentPhase(currentPhaseName)

      // Map progress → uniforms
      // uConvergence ramps through Convergence Surge phase (30–85%)
      const convergence = smoothstep(30, 85, progress)
      material.uniforms.uConvergence.value = convergence
      material.uniforms.uProgress.value = progress / 100
      material.uniforms.uTime.value = elapsed * 0.001

      // Breath only during Image Hold (95–100%)
      const breath = smoothstep(95, 100, progress) * (progress <= 100 ? 1 : 1)
      material.uniforms.uBreath.value = breath

      // Grace factor when overtime (>100%)
      const grace = Math.max(0, (progress - 100) / 50) * 0.25
      material.uniforms.uGrace.value = grace

      // Slow camera orbit during dormant drift, settle as convergence rises
      const orbitAngle = elapsed * 0.0003 * (1 - convergence * 0.8)
      const orbitRadius = 35 - convergence * 5
      camera.position.x = Math.sin(orbitAngle) * orbitRadius
      camera.position.z = Math.cos(orbitAngle) * orbitRadius
      camera.position.y = Math.sin(elapsed * 0.0001) * 3 * (1 - convergence)
      camera.lookAt(0, 0, 0)

      renderer.render(scene, camera)
    }
    animate()

    onCleanup(() => {
      window.removeEventListener("resize", handleResize)
      cancelAnimationFrame(animationId)
      geometry?.dispose()
      material?.dispose()
      renderer?.dispose()
    })
  })

  // ── Controls ───────────────────────────────────────────────────────────

  const handleRestart = () => {
    startTime = performance.now()
    setIsPlaying(true)
  }

  const handleTogglePlay = () => setIsPlaying(!isPlaying())

  const formatMs = (ms: number) => {
    const s = (ms / 1000).toFixed(1)
    return `${s}s`
  }

  return (
    <div class="w-full h-full flex flex-col bg-[#04040a]">
      {/* Canvas — fills available space */}
      <div class="flex-1 min-h-0 relative">
        <canvas
          ref={canvasRef}
          class="w-full h-full block"
          style={{ "touch-action": "none" }}
        />

        {/* Phase indicator overlay (top-left) */}
        <div class="absolute top-3 left-3 px-3 py-2 bg-black/60 border border-white/10 text-xs">
          <div class="text-[#d4af37] font-semibold tracking-wide uppercase text-[10px]">
            Phase
          </div>
          <div class="text-white/90 font-mono">{currentPhase()}</div>
        </div>

        {/* Progress + time overlay (top-right) */}
        <div class="absolute top-3 right-3 px-3 py-2 bg-black/60 border border-white/10 text-xs text-right">
          <div class="text-white/50 text-[10px] uppercase tracking-wide">Progress</div>
          <div class="text-[#d4af37] font-mono">
            {progressPct().toFixed(1)}%
          </div>
          <div class="text-white/40 text-[10px] font-mono mt-0.5">
            {formatMs(elapsedMs())} / {formatMs(estimatedDuration())}
          </div>
        </div>

        {/* Phase timeline bar (bottom) */}
        <div class="absolute bottom-0 left-0 right-0 h-1 bg-white/5">
          <div
            class="h-full bg-[#d4af37] transition-[width] duration-100"
            style={{ width: `${Math.min(progressPct(), 100)}%` }}
          />
        </div>
        {/* Phase boundary ticks */}
        <div class="absolute bottom-1 left-0 right-0 flex px-0">
          {PHASES.map((p) => (
            <div
              class="text-[8px] text-white/30 font-mono text-center"
              style={{ width: `${p.endPct - p.startPct}%` }}
            >
              {p.startPct}%
            </div>
          ))}
        </div>
      </div>

      {/* Controls panel */}
      {props.showControls !== false && (
        <div class="flex-shrink-0 px-4 py-3 border-t border-white/10 bg-[#06060e] flex items-center gap-4">
          <button
            type="button"
            class="px-3 py-1.5 bg-[#d4af37] text-black text-xs font-semibold"
            onClick={handleTogglePlay}
          >
            {isPlaying() ? "Pause" : "Play"}
          </button>
          <button
            type="button"
            class="px-3 py-1.5 border border-white/20 text-white/80 text-xs"
            onClick={handleRestart}
          >
            Restart
          </button>
          <div class="text-[10px] text-white/40 font-mono">
            {particleCount().toLocaleString()} particles · est. {formatMs(estimatedDuration())}
          </div>
          <div class="flex-1" />
          <div class="text-[10px] text-white/30">
            Seedance v1.0 Pro Fast estimate: 60–90s @ 480p / 5s clip
          </div>
        </div>
      )}
    </div>
  )
}

export default ConstellationConvergence