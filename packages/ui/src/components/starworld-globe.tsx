/**
 * Rotating gold orthographic globe — Solid port of StarWorldGlobe (portal loaders).
 * Atlas: `public/geo/countries-110m.json` (same-origin via BASE_URL).
 */
import { Show, createEffect, createSignal, onCleanup, type Component, type JSX } from "solid-js"

const LAND_FILL = "rgba(212, 175, 55, 0.45)"
const LAND_STROKE = "rgba(255, 199, 19, 0.7)"
const GRATICULE = "rgba(212, 175, 55, 0.3)"
const GOLD = "#d4af37"
const GOLD_LIGHT = "#ffc713"

export interface StarWorldGlobeProps {
  size?: number
  /** Radians per animation frame (default matches portal loader). */
  rotationSpeed?: number
  class?: string
  decorative?: boolean
}

const atlasUrl = () => `${import.meta.env.BASE_URL}geo/countries-110m.json`

const StarWorldGlobe: Component<StarWorldGlobeProps> = (props) => {
  const size = () => props.size ?? 120
  const rotationSpeed = () => props.rotationSpeed ?? 0.117
  const decorative = () => props.decorative !== false

  const [svgEl, setSvgEl] = createSignal<SVGSVGElement | null>(null)
  const [failed, setFailed] = createSignal(false)
  const prefersReducedMotion = () =>
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches

  createEffect(() => {
    const svg = svgEl()
    if (!svg || failed()) return

    let cancelled = false
    let animFrame = 0
    let rotation = 0
    const abort = new AbortController()
    const speed = rotationSpeed()

    void (async () => {
      try {
        const [d3Geo, topojson] = await Promise.all([
          import("d3-geo"),
          import("topojson-client"),
        ])
        if (cancelled) return

        const { geoOrthographic, geoPath, geoGraticule10 } = d3Geo
        const { feature } = topojson

        const response = await fetch(atlasUrl(), { signal: abort.signal })
        if (cancelled) return
        if (!response.ok) throw new Error(`world-atlas fetch failed: ${response.status}`)

        const topology = await response.json()
        if (cancelled) return

        svg.innerHTML = ""

        const projection = geoOrthographic().scale(46).translate([60, 60]).clipAngle(90)
        const pathGen = geoPath(projection)
        const graticule = geoGraticule10() as GeoJSON.MultiLineString
        const ns = "http://www.w3.org/2000/svg"

        const ocean = document.createElementNS(ns, "circle")
        ocean.setAttribute("cx", "60")
        ocean.setAttribute("cy", "60")
        ocean.setAttribute("r", "46")
        ocean.setAttribute("fill", "rgba(20, 18, 12, 0.95)")
        ocean.setAttribute("stroke", GOLD)
        ocean.setAttribute("stroke-width", "0.6")
        ocean.setAttribute("opacity", "0.85")

        const graticuleEl = document.createElementNS(ns, "path")
        graticuleEl.setAttribute("fill", "none")
        graticuleEl.setAttribute("stroke", GRATICULE)
        graticuleEl.setAttribute("stroke-width", "0.3")

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const countries = feature(topology as any, (topology as any).objects.countries)
        const landEl = document.createElementNS(ns, "path")
        landEl.setAttribute("fill", LAND_FILL)
        landEl.setAttribute("stroke", LAND_STROKE)
        landEl.setAttribute("stroke-width", "0.4")

        svg.appendChild(ocean)
        svg.appendChild(graticuleEl)
        svg.appendChild(landEl)

        projection.rotate([0, -12, 0])
        const g0 = pathGen(graticule)
        if (g0) graticuleEl.setAttribute("d", g0)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const l0 = pathGen(countries as any)
        if (l0) landEl.setAttribute("d", l0)

        if (!prefersReducedMotion()) {
          const animate = () => {
            rotation += speed
            projection.rotate([rotation, -12, 0])
            const gD = pathGen(graticule)
            if (gD) graticuleEl.setAttribute("d", gD)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const lD = pathGen(countries as any)
            if (lD) landEl.setAttribute("d", lD)
            animFrame = requestAnimationFrame(animate)
          }
          animFrame = requestAnimationFrame(animate)
        }
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()

    onCleanup(() => {
      cancelled = true
      abort.abort()
      if (animFrame) cancelAnimationFrame(animFrame)
    })
  })

  const dim = () => `${size()}px`

  const wrapperStyle = (): JSX.CSSProperties => ({
    position: "relative",
    width: dim(),
    height: dim(),
    "flex-shrink": "0",
  })

  return (
    <Show
      when={!failed()}
      fallback={
        <div
          class={props.class}
          aria-hidden={decorative() || undefined}
          style={{
            width: dim(),
            height: dim(),
            "border-radius": "50%",
            background: `radial-gradient(circle at 35% 30%, ${GOLD_LIGHT}, ${GOLD} 55%, #5c4810)`,
            border: `1px solid ${GOLD}`,
            animation: prefersReducedMotion() ? undefined : "sw-globe-spin 4s linear infinite",
          }}
        />
      }
    >
      <div class={props.class} aria-hidden={decorative() || undefined} style={wrapperStyle()}>
        <svg
          ref={setSvgEl}
          width={size()}
          height={size()}
          viewBox="0 0 120 120"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
          style={{ display: "block", width: "100%", height: "100%" }}
        >
          <circle
            cx="60"
            cy="60"
            r="46"
            fill="rgba(20, 18, 12, 0.95)"
            stroke={GOLD}
            stroke-width="0.6"
            opacity="0.85"
          />
        </svg>
      </div>
    </Show>
  )
}

export default StarWorldGlobe
