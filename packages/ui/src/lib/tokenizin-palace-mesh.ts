/**
 * Tokenizin palace extrude mesh — SSOT port of StarWorld
 * `src/lib/video-studio/product-spin/meshes/palace.ts` for Solid/CodeNomad.
 */

import * as THREE from "three"

function palacePx(x: number, y: number): THREE.Vector2 {
  const s = 2 / 144
  return new THREE.Vector2((x - 144) * s, -(y - 145) * s)
}

function shapeFromPx(points: Array<{ x: number; y: number }>): THREE.Shape {
  const shape = new THREE.Shape()
  shape.moveTo(points[0].x, points[0].y)
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i].x, points[i].y)
  shape.closePath()
  return shape
}

function extrudeShape(shape: THREE.Shape, depth = 0.28): THREE.ExtrudeGeometry {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: 0.045,
    bevelSize: 0.04,
    bevelOffset: 0,
    bevelSegments: 3,
    curveSegments: 8,
  })
  geo.translate(0, 0, -depth / 2)
  geo.computeVertexNormals()
  return geo
}

function boundsOf(object3d: THREE.Object3D) {
  object3d.updateWorldMatrix(true, true)
  const box = new THREE.Box3().setFromObject(object3d)
  const size = new THREE.Vector3()
  box.getSize(size)
  return { x: size.x, y: size.y, z: size.z, box }
}

/** Tokenizin Palace logo — gold L-pillars + silver wings/base. */
export function buildPalaceMesh(): THREE.Group {
  const leftGoldPts = [
    palacePx(135, 74),
    palacePx(130, 74),
    palacePx(124, 90),
    palacePx(123, 120),
    palacePx(122, 160),
    palacePx(122, 173),
    palacePx(70, 177),
    palacePx(69, 185),
    palacePx(135, 186),
  ].map((v) => ({ x: v.x, y: v.y }))

  const rightGoldPts = [
    palacePx(154, 74),
    palacePx(159, 74),
    palacePx(164, 90),
    palacePx(165, 120),
    palacePx(166, 160),
    palacePx(166, 173),
    palacePx(218, 177),
    palacePx(219, 185),
    palacePx(154, 186),
  ].map((v) => ({ x: v.x, y: v.y }))

  const leftWingPts = [
    palacePx(103, 128),
    palacePx(100, 132),
    palacePx(94, 140),
    palacePx(88, 150),
    palacePx(87, 154),
    palacePx(95, 154),
    palacePx(103, 148),
    palacePx(103, 136),
  ].map((v) => ({ x: v.x, y: v.y }))

  const rightWingPts = [
    palacePx(185, 128),
    palacePx(188, 132),
    palacePx(194, 140),
    palacePx(199, 150),
    palacePx(199, 154),
    palacePx(192, 154),
    palacePx(185, 148),
    palacePx(185, 136),
  ].map((v) => ({ x: v.x, y: v.y }))

  const basePts = [
    palacePx(63, 205),
    palacePx(225, 205),
    palacePx(239, 215),
    palacePx(49, 215),
  ].map((v) => ({ x: v.x, y: v.y }))

  const goldMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0xf2c85a),
    metalness: 1.0,
    roughness: 0.22,
    clearcoat: 0.65,
    clearcoatRoughness: 0.12,
    envMapIntensity: 2.4,
    specularIntensity: 1.2,
    specularColor: new THREE.Color(0xffe6a0),
    side: THREE.FrontSide,
  })
  const silverMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0xd6d8dc),
    metalness: 1.0,
    roughness: 0.18,
    clearcoat: 0.55,
    clearcoatRoughness: 0.1,
    envMapIntensity: 2.6,
    specularIntensity: 1.25,
    specularColor: new THREE.Color(0xffffff),
    side: THREE.FrontSide,
  })

  const group = new THREE.Group()
  const parts = [
    { pts: leftGoldPts, mat: goldMat, name: "palace-gold-left" },
    { pts: rightGoldPts, mat: goldMat.clone(), name: "palace-gold-right" },
    { pts: leftWingPts, mat: silverMat, name: "palace-silver-wing-left" },
    { pts: rightWingPts, mat: silverMat.clone(), name: "palace-silver-wing-right" },
    { pts: basePts, mat: silverMat.clone(), name: "palace-silver-base" },
  ]

  for (const p of parts) {
    const mesh = new THREE.Mesh(extrudeShape(shapeFromPx(p.pts), 0.3), p.mat)
    mesh.name = p.name
    group.add(mesh)
  }

  const b = boundsOf(group)
  const targetH = 1.85
  const s = targetH / Math.max(b.y, 0.001)
  group.scale.setScalar(s)
  const b2 = boundsOf(group)
  const c = new THREE.Vector3()
  b2.box.getCenter(c)
  group.position.sub(c)
  group.rotation.set(0, 0, 0)
  group.name = "product-spin-palace"
  return group
}
