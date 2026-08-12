import { Component, onMount, onCleanup, createSignal } from "solid-js"
import * as THREE from "three"

/**
 * ConstellationConvergence — 3D particle animation with click-to-burst.
 *
 * Particles drift in volumetric space, then converge to form a target image.
 * Clicking the canvas emits all particles from a single 3D point with a
 * cinematic camera fly-through navigation transition.
 *
 * Five-phase timeline (time-driven — no progress % from the AI gateway):
 *   1. Burst Emission     (0–15%)  — emit from origin OR dormant drift
 *   2. Attraction Wake     (15–30%) — gravity wells pulse at target positions
 *   3. Convergence Surge   (30–85%) — particles accelerate along curved paths
 *   4. Lock & Resolve      (85–95%) — snap-to-grid, micro-jitter decays
 *   5. Image Hold          (95–100%) — near-static, subtle breathing
 *   6. Overtime Grace      (>100%)  — slow reverse-dissolve if gen exceeds estimate
 *
 * Interaction:
 *   Left-click  → burst from clicked 3D point + camera fly-through
 *   Right-click → clear burst origin → diffuse volume mode
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
  /** Camera fly-through duration in ms (default 2000). */
  navTransitionMs?: number
  /** Called when the full cycle completes (after hold phase). */
  onComplete?: () => void
}

/** Default target — Tokenizin logo (served from renderer public dir). */
const DEFAULT_TARGET_IMAGE = "Tokenizin-Logo.png"

const PHASES = [
  { name: "Burst Emission", startPct: 0, endPct: 15 },
  { name: "Attraction Wake", startPct: 15, endPct: 30 },
  { name: "Convergence Surge", startPct: 30, endPct: 85 },
  { name: "Lock & Resolve", startPct: 85, endPct: 95 },
  { name: "Image Hold", startPct: 95, endPct: 100 },
] as const

/** Smoothstep easing — classic for particle convergence (slow in/out). */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** Ease-in-out cubic for cinematic camera transitions. */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
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
  const navTransitionMs = () => props.navTransitionMs ?? 2000

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

  // Burst origin mode — null = diffuse, THREE.Vector3 = emit from point
  let burstOrigin: THREE.Vector3 | null = null

  // Camera navigation transition state
  let navTransition: {
    startMs: number
    fromPos: THREE.Vector3
    toPos: THREE.Vector3
    fromLook: THREE.Vector3
    toLook: THREE.Vector3
    durationMs: number
  } | null = null

  // ── Shaders ───────────────────────────────────────────────────────────

  const vertexShader = /* glsl */ `
    uniform float uProgress;
    uniform float uTime;
    uniform float uConvergence;
    uniform float uBreath;
    uniform float uGrace;
    uniform float uBurst;
    uniform vec3 uBurstOrigin;
    uniform vec3 uBrandColor;
    uniform float uPixelRatio;

    attribute vec3 aInitialPos;
    attribute vec3 aTargetPos;
    attribute float aSize;
    attribute float aPhaseOffset;

    varying float vAlpha;
    varying vec3 vColor;

    void main() {
      float c = smoothstep(0.0, 1.0, uConvergence);

      // Effective start position: diffuse OR burst origin
      vec3 startPos = mix(aInitialPos, uBurstOrigin, uBurst);

      // Curved bezier path from start → target
      vec3 mid = (startPos + aTargetPos) * 0.5;
      vec3 diff = aTargetPos - startPos;
      vec3 perp = normalize(cross(diff, vec3(0.0, 1.0, 0.0) + vec3(0.001))) * 8.0;
      float arc = sin(c * 3.14159) * (1.0 - c) * 0.6;
      vec3 arcPos = mid + perp * arc;

      vec3 p0 = startPos;
      vec3 p1 = arcPos;
      vec3 p2 = aTargetPos;
      vec3 bez = p0 * (1.0 - c) * (1.0 - c) + p1 * 2.0 * (1.0 - c) * c + p2 * c * c;

      // Dormant drift (fades as convergence rises; suppressed during burst)
      float driftAmt = (1.0 - c) * 3.0 * (1.0 - uBurst * 0.8);
      vec3 drift = vec3(
        sin(uTime * 0.4 + aPhaseOffset) * driftAmt,
        cos(uTime * 0.3 + aPhaseOffset) * driftAmt,
        sin(uTime * 0.5 + aPhaseOffset * 2.0) * driftAmt
      );
      vec3 finalPos = bez + drift;

      // Burst expansion: early particles spread outward from origin
      float burstSpread = uBurst * (1.0 - smoothstep(0.0, 0.15, uProgress)) * 0.3;
      finalPos += normalize(aInitialPos + vec3(0.001)) * burstSpread * aPhaseOffset;

      // Micro-jitter during Lock & Resolve (85–95%)
      float jitter = smoothstep(0.8, 0.9, uProgress) * (1.0 - smoothstep(0.9, 0.95, uProgress)) * 0.15;
      finalPos += vec3(
        sin(uTime * 40.0 + aPhaseOffset * 7.0),
        cos(uTime * 38.0 + aPhaseOffset * 5.0),
        sin(uTime * 42.0 + aPhaseOffset * 9.0)
      ) * jitter;

      // Breath during hold
      float breathScale = 1.0 + uBreath * 0.005 * sin(uTime * 1.5);
      finalPos *= breathScale;

      // Grace (overtime): push back out
      finalPos += normalize(aInitialPos - aTargetPos + vec3(0.001)) * uGrace * 2.0;

      vec4 mvPosition = modelViewMatrix * vec4(finalPos, 1.0);

      float sizeBoost = 1.0 + c * 0.3;
      // Burst particles start smaller, grow as they travel
      sizeBoost += uBurst * (1.0 - smoothstep(0.0, 0.2, uProgress)) * 0.5;
      gl_PointSize = aSize * sizeBoost * uPixelRatio * (300.0 / -mvPosition.z);
      gl_Position = projectionMatrix * mvPosition;

      vAlpha = 0.4 + c * 0.5;
      vAlpha += smoothstep(0.85, 1.0, uProgress) * 0.1;
      vAlpha -= uGrace * 0.15;
      // Burst particles glow brighter at launch
      vAlpha += uBurst * (1.0 - smoothstep(0.0, 0.15, uProgress)) * 0.3;
      vAlpha = clamp(vAlpha, 0.1, 1.0);

      vColor = uBrandColor;
    }
  `

  const fragmentShader = /* glsl */ `
    varying float vAlpha;
    varying vec3 vColor;

    void main() {
      vec2 uv = gl_PointCoord - 0.5;
      float dist = length(uv);
      if (dist > 0.5) discard;

      float soft = smoothstep(0.5, 0.0, dist);
      float core = smoothstep(0.25, 0.0, dist) * 0.6 + soft * 0.4;

      vec3 col = vColor;
      col = mix(col, vec3(1.0, 0.97, 0.9), smoothstep(0.85, 1.0, vAlpha) * core * 0.5);

      gl_FragColor = vec4(col, core * vAlpha);
    }
  `

  // ── Position generation ───────────────────────────────────────────────

  function generateInitialPositions(count: number): Float32Array {
    const positions = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 80
      positions[i * 3 + 1] = (Math.random() - 0.5) * 80
      positions[i * 3 + 2] = (Math.random() - 0.5) * 80
    }
    return positions
  }

  function generateSphereTargets(count: number): Float32Array {
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

  function generateImageTargets(url: string, count: number): Promise<Float32Array> {
    return new Promise((resolve) => {
      const img = new Image()
      img.crossOrigin = "anonymous"
      img.onload = () => {
        const canvas2d = document.createElement("canvas")
        const maxSize = 120
        const scale = Math.min(maxSize / img.width, maxSize / img.height)
        canvas2d.width = Math.floor(img.width * scale)
        canvas2d.height = Math.floor(img.height * scale)
        const ctx = canvas2d.getContext("2d")!
        ctx.drawImage(img, 0, 0, canvas2d.width, canvas2d.height)
        const imageData = ctx.getImageData(0, 0, canvas2d.width, canvas2d.height)
        const positions = new Float32Array(count * 3)
        const { data, width: w, height: h } = imageData

        for (let i = 0; i < count; i++) {
          let x = 0, y = 0, brightness = 0
          for (let a = 0; a < 10; a++) {
            x = Math.floor(Math.random() * w)
            y = Math.floor(Math.random() * h)
            const idx = (y * w + x) * 4
            brightness = (data[idx] + data[idx + 1] + data[idx + 2]) / 3 / 255
            if (brightness > 0.15) break
          }
          positions[i * 3] = (x / w - 0.5) * 20
          positions[i * 3 + 1] = -(y / h - 0.5) * 20
          positions[i * 3 + 2] = (brightness - 0.5) * 4
        }
        resolve(positions)
      }
      img.onerror = () => resolve(generateSphereTargets(count))
      img.src = url
    })
  }

  // ── Build / rebuild scene ─────────────────────────────────────────────

  async function buildScene() {
    if (points) {
      scene.remove(points)
      geometry.dispose()
      material.dispose()
    }

    const count = particleCount()
    initialPositions = generateInitialPositions(count)
    targetPositions = await generateImageTargets(
      props.targetImageUrl ?? DEFAULT_TARGET_IMAGE,
      count,
    )

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
        uBurst: { value: 0 },
        uBurstOrigin: { value: new THREE.Vector3(0, 0, 0) },
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
  }

  // ── Animation loop ─────────────────────────────────────────────────────

  function animate() {
    animationId = requestAnimationFrame(animate)
    if (!isPlaying()) {
      renderer.render(scene, camera)
      return
    }

    const elapsed = performance.now() - startTime
    const rawProgress = (elapsed / estimatedDuration()) * 100
    const progress = Math.min(rawProgress, 150)

    const phaseName =
      progress < 15 ? "Burst Emission" :
      progress < 30 ? "Attraction Wake" :
      progress < 85 ? "Convergence Surge" :
      progress < 95 ? "Lock & Resolve" :
      progress < 100 ? "Image Hold" :
      "Overtime Grace"
    setCurrentPhase(phaseName)
    setProgressPct(progress)
    setElapsedMs(elapsed)

    const convergence = smoothstep(30, 85, progress)
    material.uniforms.uConvergence.value = convergence
    material.uniforms.uProgress.value = progress / 100
    material.uniforms.uTime.value = elapsed * 0.001
    material.uniforms.uBreath.value = smoothstep(95, 100, progress)
    material.uniforms.uGrace.value = Math.max(0, (progress - 100) / 50) * 0.25

    // Burst uniform
    material.uniforms.uBurst.value = burstOrigin ? 1 : 0
    if (burstOrigin) {
      material.uniforms.uBurstOrigin.value.copy(burstOrigin)
    }

    // ── Camera: navigation transition OR normal orbit ─────────────────
    if (navTransition) {
      const navElapsed = performance.now() - navTransition.startMs
      const navT = Math.min(navElapsed / navTransition.durationMs, 1)
      const eased = easeInOutCubic(navT)

      camera.position.lerpVectors(navTransition.fromPos, navTransition.toPos, eased)
      const lookTarget = new THREE.Vector3().lerpVectors(
        navTransition.fromLook,
        navTransition.toLook,
        eased,
      )
      camera.lookAt(lookTarget)

      if (navT >= 1) {
        navTransition = null
      }
    } else {
      const orbitAngle = elapsed * 0.0003 * (1 - convergence * 0.8)
      const orbitRadius = 35 - convergence * 5
      camera.position.x = Math.sin(orbitAngle) * orbitRadius
      camera.position.z = Math.cos(orbitAngle) * orbitRadius
      camera.position.y = Math.sin(elapsed * 0.0001) * 3 * (1 - convergence)
      camera.lookAt(0, 0, 0)
    }

    renderer.render(scene, camera)
  }

  // ── Click → burst + camera fly-through ─────────────────────────────────

  function handleCanvasClick(event: MouseEvent) {
    if (!canvasRef) return
    const rect = canvasRef.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    )

    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(ndc, camera)
    const burstPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
    const hitPoint = new THREE.Vector3()
    const hit = raycaster.ray.intersectPlane(burstPlane, hitPoint)
    if (!hit) return

    burstOrigin = hitPoint.clone()

    // Restart timeline so burst emission plays from start
    startTime = performance.now()
    setIsPlaying(true)

    // Camera navigation transition: from close-up near burst → orbit position
    const orbitRadius = 35
    const toPos = new THREE.Vector3(0, 0, orbitRadius)
    const camDir = new THREE.Vector3().subVectors(toPos, hitPoint).normalize()
    const fromPos = hitPoint.clone().add(camDir.multiplyScalar(6))

    navTransition = {
      startMs: performance.now(),
      fromPos,
      toPos,
      fromLook: hitPoint.clone(),
      toLook: new THREE.Vector3(0, 0, 0),
      durationMs: navTransitionMs(),
    }
  }

  function handleCanvasContextMenu(event: MouseEvent) {
    event.preventDefault()
    burstOrigin = null
    startTime = performance.now()
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

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

    await buildScene()

    startTime = performance.now()
    animate()

    // Click + right-click handlers
    canvasRef.addEventListener("click", handleCanvasClick)
    canvasRef.addEventListener("contextmenu", handleCanvasContextMenu)

    const handleResize = () => {
      if (!canvasRef) return
      const w = canvasRef.clientWidth
      const h = canvasRef.clientHeight
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    window.addEventListener("resize", handleResize)

    onCleanup(() => {
      window.removeEventListener("resize", handleResize)
      canvasRef?.removeEventListener("click", handleCanvasClick)
      canvasRef?.removeEventListener("contextmenu", handleCanvasContextMenu)
      cancelAnimationFrame(animationId)
      geometry?.dispose()
      material?.dispose()
      renderer?.dispose()
    })
  })

  // ── Controls ──────────────────────────────────────────────────────────

  const handleRestart = () => {
    startTime = performance.now()
    setIsPlaying(true)
  }

  const handleTogglePlay = () => setIsPlaying(!isPlaying())

  const formatMs = (ms: number) => `${(ms / 1000).toFixed(1)}s`

  const formatParticles = (n: number) => (n >= 1000 ? `${n / 1000}k` : `${n}`)

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
          <div class="text-[#d4af37] font-mono">{progressPct().toFixed(1)}%</div>
          <div class="text-white/40 text-[10px] font-mono mt-0.5">
            {formatMs(elapsedMs())} / {formatMs(estimatedDuration())}
          </div>
        </div>

        {/* Click hint (bottom-center, non-interactive) */}
        <div class="absolute bottom-5 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-[#d4af37]/10 border border-[#d4af37]/30 text-[#d4af37] text-[11px] font-mono pointer-events-none">
          Click to emit particles from a point · Right-click to reset
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
            {formatParticles(particleCount())} particles · est. {formatMs(estimatedDuration())}
          </div>
          <div class="flex-1" />
          <div class="text-[10px] text-white/30">
            Seedance v1.0 Pro Fast: 60–90s @ 480p / 5s clip
          </div>
        </div>
      )}
    </div>
  )
}

export default ConstellationConvergence