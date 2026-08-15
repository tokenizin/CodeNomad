/**
 * Port of StarWorld `src/lib/video-studio/product-spin/meshes/prestix.ts`.
 * Keep this file in sync with that SSOT (19-sphere letter P).
 */
import * as THREE from "three"

/** Prestix.vip brand red — sphere-grid letter P (prestix manifest). */
const PRESTIX_RED = 0xc41e3a
const PRESTIX_RED_BRIGHT = 0xe23a4c

const P_GRID = [
  [1, 1, 1, 1, 0],
  [1, 1, 0, 1, 1],
  [1, 1, 0, 0, 1],
  [1, 1, 1, 1, 0],
  [1, 1, 0, 0, 0],
  [1, 1, 0, 0, 0],
]

function boundsOf(object3d: THREE.Object3D) {
  object3d.updateWorldMatrix(true, true)
  const box = new THREE.Box3().setFromObject(object3d)
  const size = new THREE.Vector3()
  box.getSize(size)
  return { box, size }
}

function pearlMaterial(hex: number) {
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(hex),
    metalness: 0.42,
    roughness: 0.32,
    ior: 1.7,
    clearcoat: 0.45,
    clearcoatRoughness: 0.22,
    envMapIntensity: 1.6,
    specularIntensity: 1.1,
    specularColor: new THREE.Color(0xff8a95),
    sheen: 0.2,
    sheenColor: new THREE.Color(hex),
    sheenRoughness: 0.1,
    side: THREE.FrontSide,
  })
}

/** Prestix.vip 19-sphere letter P — matches brand3d prestix manifest. */
export function buildPrestixMesh(): THREE.Group {
  const radius = 0.1
  const spacing = 0.3
  const rows = P_GRID.length
  const cols = P_GRID[0]?.length ?? 0
  const offsetX = (-(cols - 1) * spacing) / 2
  const offsetY = ((rows - 1) * spacing) / 2

  const geo = new THREE.SphereGeometry(radius, 32, 32)
  const primary = pearlMaterial(PRESTIX_RED)
  const secondary = pearlMaterial(PRESTIX_RED_BRIGHT)

  const group = new THREE.Group()
  let n = 0
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!P_GRID[r][c]) continue
      const mat = n % 2 === 0 ? primary : secondary.clone()
      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.set(offsetX + c * spacing, offsetY - r * spacing, 0)
      mesh.name = `prestix-dot-${n}`
      group.add(mesh)
      n++
    }
  }

  const { size } = boundsOf(group)
  const targetH = 1.85
  group.scale.setScalar(targetH / Math.max(size.y, 0.001))
  const after = boundsOf(group)
  const center = new THREE.Vector3()
  after.box.getCenter(center)
  group.position.sub(center)
  group.rotation.set(0, 0, 0)
  group.name = "product-spin-prestix"
  return group
}

/** @deprecated Use buildPrestixMesh — alias for older CodeNomad imports. */
export const buildPrestixPMesh = buildPrestixMesh
