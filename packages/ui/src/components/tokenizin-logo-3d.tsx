/**
 * Product-spin brand mark for CodeNomad empty / welcome cards.
 * Tokenizin palace (default) or Prestix 3D letter-P when this silo is Prestix.
 */

import { onCleanup, onMount, type Component } from "solid-js"
import * as THREE from "three"
import { buildPalaceMesh } from "../lib/tokenizin-palace-mesh"
import { buildPrestixMesh } from "../lib/prestix-p-mesh"
import { PRESTIX_LOGO_URL, TOKENIZIN_LOGO_URL } from "../lib/brand-assets"
import { resolveCodeNomadSilo, type CodeNomadSilo } from "../lib/silo-brand"

export interface TokenizinLogo3DProps {
  width?: number
  height?: number
  class?: string
  alt?: string
  /** Continuous Y-spin (honors prefers-reduced-motion). */
  spin?: boolean
  /** Override silo detection (tests). */
  silo?: CodeNomadSilo
}

const TokenizinLogo3D: Component<TokenizinLogo3DProps> = (props) => {
  let host!: HTMLDivElement
  let fallbackImg!: HTMLImageElement

  onMount(() => {
    const width = props.width ?? 192
    const height = props.height ?? 192
    const spinWanted = props.spin !== false
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const silo = props.silo ?? resolveCodeNomadSilo()
    const prestix = silo === "prestix"

    let renderer: THREE.WebGLRenderer | null = null
    let raf = 0
    let disposed = false

    try {
      const scene = new THREE.Scene()
      const camera = new THREE.PerspectiveCamera(22, width / Math.max(height, 1), 0.05, 120)

      const halfH = 1.85 * 0.5
      const halfW = Math.max(2.55, 1.85) * 0.5 * Math.SQRT2
      const fovY = THREE.MathUtils.degToRad(camera.fov)
      const fovX = 2 * Math.atan(Math.tan(fovY / 2) * camera.aspect)
      const margin = 0.92
      const dist =
        Math.max(halfH / Math.tan(fovY / 2), halfW / Math.tan(fovX / 2)) / margin
      camera.position.set(0, 0, dist)
      camera.lookAt(0, 0, 0)

      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: "high-performance",
      })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
      renderer.setSize(width, height, false)
      renderer.outputColorSpace = THREE.SRGBColorSpace
      renderer.toneMapping = THREE.ACESFilmicToneMapping
      renderer.toneMappingExposure = 1.0
      renderer.domElement.style.width = "100%"
      renderer.domElement.style.height = "100%"
      renderer.domElement.style.display = "block"
      renderer.domElement.setAttribute("aria-hidden", "true")

      if (prestix) {
        scene.add(new THREE.AmbientLight(0x2a1014, 0.42))
        const key = new THREE.DirectionalLight(0xffe8ec, 1.7)
        key.position.set(3.4, 0.15, 3.0)
        scene.add(key)
        const fill = new THREE.DirectionalLight(0x806070, 0.45)
        fill.position.set(-3.0, 0.0, 2.0)
        scene.add(fill)
        const rim = new THREE.DirectionalLight(0xff90a0, 0.4)
        rim.position.set(-0.8, 0.6, -3.0)
        scene.add(rim)
        const spark = new THREE.PointLight(0xffffff, 36, 5.5, 2)
        spark.position.set(2.35, 0.05, 2.2)
        scene.add(spark)
      } else {
        scene.add(new THREE.AmbientLight(0x2a2418, 0.35))
        const key = new THREE.DirectionalLight(0xfff4ec, 1.85)
        key.position.set(3.4, 0.15, 3.0)
        scene.add(key)
        const fill = new THREE.DirectionalLight(0x807078, 0.4)
        fill.position.set(-3.0, 0.0, 2.0)
        scene.add(fill)
        const rim = new THREE.DirectionalLight(0xffc8d0, 0.35)
        rim.position.set(-0.8, 0.6, -3.0)
        scene.add(rim)
        const spark = new THREE.PointLight(0xffffff, 44, 5.5, 2)
        spark.position.set(2.35, 0.05, 2.2)
        scene.add(spark)
        const ring = new THREE.PointLight(0xffffff, 6, 4.5, 2)
        ring.position.set(2.1, 0.35, 0)
        scene.add(ring)
      }

      const logo = prestix ? buildPrestixMesh() : buildPalaceMesh()
      scene.add(logo)

      host.replaceChildren(renderer.domElement)
      if (fallbackImg) fallbackImg.style.display = "none"

      const clock = new THREE.Clock()
      const spin = spinWanted && !reduceMotion
      const rate = (Math.PI * 2) / 5

      const tick = () => {
        if (disposed || !renderer) return
        const dt = clock.getDelta()
        if (spin) logo.rotation.y += rate * dt
        renderer.render(scene, camera)
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
    } catch {
      if (fallbackImg) fallbackImg.style.display = ""
    }

    onCleanup(() => {
      disposed = true
      cancelAnimationFrame(raf)
      if (renderer) {
        renderer.dispose()
        renderer.forceContextLoss?.()
        renderer.domElement.remove()
        renderer = null
      }
    })
  })

  const width = () => props.width ?? 192
  const height = () => props.height ?? 192
  const silo = () => props.silo ?? resolveCodeNomadSilo()

  return (
    <div
      ref={host}
      class={`tokenizin-logo-3d empty-state-logo ${props.class ?? ""}`.trim()}
      style={{
        width: `${width()}px`,
        height: `${height()}px`,
        position: "relative",
        overflow: "visible",
      }}
      role="img"
      aria-label={props.alt ?? (silo() === "prestix" ? "Prestix 3D logo" : "Tokenizin logo")}
    >
      <img
        ref={fallbackImg}
        src={silo() === "prestix" ? PRESTIX_LOGO_URL : TOKENIZIN_LOGO_URL}
        alt=""
        aria-hidden="true"
        class="absolute inset-0 m-auto h-full w-auto object-contain"
        loading="lazy"
      />
    </div>
  )
}

export default TokenizinLogo3D
