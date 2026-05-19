import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import './style.css'

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

type ShapeType = 'rectangle' | 'l_shape' | 'u_shape' | 't_shape' | 'triangle' | 'trapeze'
type CellType = 'round' | 'prismatic'
type GridStyle = 'grid' | 'honeycomb'
type ExtrusionDir = 'z' | 'x' | 'y'
type VisMode = 'solid' | 'wire' | 'skeleton'

interface ShapeParams {
  type: ShapeType
  l: number      // length X
  w: number      // width Y
  h: number      // height Z
  cut_l: number  // l_shape / u_shape
  cut_w: number  // l_shape / u_shape
  stem_w: number // t_shape
  bar_h: number  // t_shape
  top_mm: number // trapeze
}

interface RoundCell {
  type: 'round'
  diam: number
  height: number
}

interface PrismaticCell {
  type: 'prismatic'
  width: number
  depth: number
  height: number
}

type CellParams = RoundCell | PrismaticCell

interface Point2D {
  x: number
  y: number
}

interface Point3D { x: number; y: number; z: number }
interface GridOffset3D { ox: number; oy: number; oz: number }

interface PackingResult {
  total: number
  extrusionDir: ExtrusionDir
  gridStyle: GridStyle
  positions: Point3D[]   // world-space cell centres
  polygon: Point2D[]     // original l×w footprint polygon (never swapped)
  sp: ShapeParams
  cell: CellParams
  gridOffset: GridOffset3D
}

// ─────────────────────────────────────────────────────────────────────────────
// PACKING PARAMETERS  (user-adjustable, read from inputs at runtime)
// ─────────────────────────────────────────────────────────────────────────────

// These are mutable — read via getPackingParams() at calculation time
let BOUNDARY_MARGIN = 5  // mm clearance from shape boundary
let CELL_GAP_ROUND  = 5  // mm gap between round cell walls
let CELL_GAP_PRISM  = 1  // mm gap between prismatic cell walls
let LAYER_GAP       = 2  // mm gap between layers (stack direction)

function getPackingParams() {
  BOUNDARY_MARGIN = parseFloat((document.getElementById('paramMargin')    as HTMLInputElement)?.value ?? '5') || 0
  CELL_GAP_ROUND  = parseFloat((document.getElementById('paramGapRound')  as HTMLInputElement)?.value ?? '5') || 0
  CELL_GAP_PRISM  = parseFloat((document.getElementById('paramGapPrism')  as HTMLInputElement)?.value ?? '1') || 0
  LAYER_GAP       = parseFloat((document.getElementById('paramLayerGap')  as HTMLInputElement)?.value ?? '2') || 0
}

const CELL_PRESETS: Record<string, CellParams> = {
  '18650': { type: 'round', diam: 18, height: 65 },
  '21700': { type: 'round', diam: 21, height: 70 },
  'BYD50': { type: 'prismatic', width: 148, depth: 27, height: 91 },
  'EVE50': { type: 'prismatic', width: 135, depth: 30, height: 185 },
}

const DIR_LABELS: Record<ExtrusionDir, string> = {
  z: 'von oben (Z)',
  x: 'von links (X)',
  y: 'von vorne (Y)',
}

const DIR_LABELS_SHORT: Record<ExtrusionDir, string> = {
  z: 'Z-Achse',
  x: 'X-Achse',
  y: 'Y-Achse',
}

const GS_LABELS: Record<GridStyle, string> = {
  grid: 'Grid',
  honeycomb: '⬡ HComb',
}

// ─────────────────────────────────────────────────────────────────────────────
// GEOMETRY – 2D POLYGON
// ─────────────────────────────────────────────────────────────────────────────

function getShapePolygon(sp: ShapeParams): Point2D[] {
  const { type, l, w, cut_l, cut_w, stem_w, bar_h, top_mm } = sp
  switch (type) {
    case 'rectangle':
      return [{ x: 0, y: 0 }, { x: l, y: 0 }, { x: l, y: w }, { x: 0, y: w }]

    case 'l_shape':
      return [
        { x: 0, y: 0 }, { x: l, y: 0 }, { x: l, y: w - cut_w },
        { x: l - cut_l, y: w - cut_w }, { x: l - cut_l, y: w }, { x: 0, y: w },
      ]

    case 'u_shape':
      return [
        { x: 0, y: 0 }, { x: l, y: 0 }, { x: l, y: w },
        { x: l - cut_l, y: w }, { x: l - cut_l, y: cut_w },
        { x: cut_l, y: cut_w }, { x: cut_l, y: w }, { x: 0, y: w },
      ]

    case 't_shape': {
      const cx = (l - stem_w) / 2
      return [
        { x: 0, y: 0 }, { x: l, y: 0 }, { x: l, y: bar_h },
        { x: cx + stem_w, y: bar_h }, { x: cx + stem_w, y: w },
        { x: cx, y: w }, { x: cx, y: bar_h }, { x: 0, y: bar_h },
      ]
    }

    case 'triangle':
      return [{ x: 0, y: 0 }, { x: l, y: 0 }, { x: 0, y: w }]

    case 'trapeze': {
      const off = (l - top_mm) / 2
      return [{ x: 0, y: 0 }, { x: l, y: 0 }, { x: l - off, y: w }, { x: off, y: w }]
    }
  }
}

function pointInPolygon(px: number, py: number, poly: Point2D[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y
    const xj = poly[j].x, yj = poly[j].y
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}


// ─────────────────────────────────────────────────────────────────────────────
// PACKING  —  3D Oversample + Clip
//
// World coordinate system (fixed, matches housing mesh):
//   X ∈ [0 .. sp.l],  Y ∈ [0 .. sp.h],  Z ∈ [0 .. sp.w]
//
// The housing is an extruded prism: footprint polygon (l×w in X-Z plane)
// extruded along Y to height h.
//
// A cell fits if:
//   • its X-Z centre passes the footprint polygon test (with margin)
//   • its full X-Z footprint is inside (circle / AABB)
//   • its Y extent [cy - halfH, cy + halfH] is inside [0, sp.h]
//
// extrusionDir controls which world axis is the cell's long axis:
//   z  →  cell stands upright  (long axis = Y)
//   x  →  cell lies along X    (long axis = X)
//   y  →  cell lies along Z    (long axis = Z)
// ─────────────────────────────────────────────────────────────────────────────

// Check if a 2D circle is fully inside poly+margin (footprint test)
function circleFootprintOk(cx2d: number, cz2d: number, r: number, poly: Point2D[]): boolean {
  const steps = 24
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2
    if (!pointInPolygon(cx2d + (r + BOUNDARY_MARGIN) * Math.cos(a),
                        cz2d + (r + BOUNDARY_MARGIN) * Math.sin(a), poly)) return false
  }
  return pointInPolygon(cx2d, cz2d, poly)
}

// Check if a 2D AABB is fully inside poly+margin (footprint test)
function rectFootprintOk(cx2d: number, cz2d: number, hw: number, hd: number, poly: Point2D[]): boolean {
  const m = BOUNDARY_MARGIN
  return pointInPolygon(cx2d - hw - m, cz2d - hd - m, poly)
      && pointInPolygon(cx2d + hw + m, cz2d - hd - m, poly)
      && pointInPolygon(cx2d - hw - m, cz2d + hd + m, poly)
      && pointInPolygon(cx2d + hw + m, cz2d + hd + m, poly)
}

function pack3D(
  sp: ShapeParams,
  cell: CellParams,
  extDir: ExtrusionDir,
  gridStyle: GridStyle,
  offset: GridOffset3D,
): Point3D[] {
  const { l, h, w } = sp
  const poly = getShapePolygon(sp)   // always original l×w polygon, never swapped

  // Cell half-dimensions in world axes depending on extrusion direction
  // extDir='z': cell is a cylinder/box standing along Y → footprint in X-Z
  // extDir='x': cell lies along X                       → footprint in Y-Z (rotated: long=X)
  // extDir='y': cell lies along Z                       → footprint in X-Y (rotated: long=Z)

  // Footprint half-sizes (the two axes perpendicular to the cell's long axis)
  let fpA: number, fpB: number  // half-size in the two "cross" directions
  let longH: number             // half-size along the cell's long axis
  const gap = cell.type === 'round' ? CELL_GAP_ROUND : CELL_GAP_PRISM

  if (cell.type === 'round') {
    fpA = fpB = cell.diam / 2
    longH = cell.height / 2
  } else {
    fpA = cell.width / 2
    fpB = cell.depth / 2
    longH = cell.height / 2
  }

  const stepFpA  = fpA * 2 + gap
  const stepFpB  = fpB * 2 + gap
  const stepLong = longH * 2 + LAYER_GAP

  // ── Per-direction: which world axes carry (footprintA, footprintB, long)?
  // The housing footprint polygon is always in X-Z (coords: x=worldX, y=worldZ).
  // For every direction we must test the cell's X-Z projection against poly,
  // AND check that the cell's Y extent fits within [0..h].
  //
  // extDir='z': long axis=Y,  cross-section in X-Z  → stepX=stepFpA, stepZ=stepFpB, stepY=stepLong
  // extDir='x': long axis=X,  cross-section in Y-Z  → stepX=stepLong, stepZ=fpA(~radius), stepY=stepFpB
  //   but the Z footprint of each cell still matters for the polygon test:
  //   the cell occupies X=[cx-longH..cx+longH], Y=[cy-fpB..cy+fpB], Z=[cz-fpA..cz+fpA]
  //   → polygon test: (cx, cz) with half-sizes (0=ignored for long axis, fpA for Z)
  //   Actually we project the cell onto X-Z: occupies X=[cx-longH..cx+longH], Z=[cz-fpA..cz+fpA]
  //   → use rectFootprintOk(cx, cz, longH, fpA) against poly, plus Y range check
  //
  // extDir='y': long axis=Z,  cross-section in X-Y
  //   cell occupies X=[cx-fpA..cx+fpA], Y=[cy-fpB..cy+fpB], Z=[cz-longH..cz+longH]
  //   → polygon test: (cx, cz) with half-sizes (fpA for X, longH for Z)
  //   → use rectFootprintOk(cx, cz, fpA, longH) / circleFootprintOk(cx, cz, fpA) with Z extent,
  //      plus Y range check

  // Helper: does the cell's full X-Z footprint fit inside poly?
  function xzOk(cx: number, cz: number, hx: number, hz: number): boolean {
    if (cell.type === 'round') {
      // For round cells the cross-section is always circular with radius = diam/2
      // regardless of direction. hx == hz == fpA always for round cells.
      return circleFootprintOk(cx, cz, hx, poly)
    }
    return rectFootprintOk(cx, cz, hx, hz, poly)
  }

  const positions: Point3D[] = []

  if (extDir === 'z') {
    // long=Y, cross in X-Z: hx=fpA, hz=fpB
    // stepX=stepFpA, stepZ=stepFpB, stepY=stepLong
    const stepX = stepFpA, stepZ = stepFpB, stepY = stepLong
    // For honeycomb: row pitch in Z = stepX * √3/2 so diagonal gap equals the cell gap
    const hcStepZ = stepX * (Math.sqrt(3) / 2)
    const oX = ((offset.ox % stepX) + stepX) % stepX
    const oZ = gridStyle === 'honeycomb'
      ? ((offset.oy % hcStepZ) + hcStepZ) % hcStepZ
      : ((offset.oy % stepZ)   + stepZ)   % stepZ
    const oY = ((offset.oz % stepY) + stepY) % stepY

    for (let cy = longH + oY - stepY; cy <= h + stepY; cy += stepY) {
      if (cy - longH < 0 || cy + longH > h) continue
      if (gridStyle === 'honeycomb') {
        let row = 0
        for (let cz = fpA + oZ - hcStepZ; cz <= w + hcStepZ; cz += hcStepZ, row++) {
          const hcOff = row % 2 === 0 ? 0 : stepX / 2
          for (let cx = fpA + oX - stepX + hcOff; cx <= l + stepX; cx += stepX) {
            if (xzOk(cx, cz, fpA, fpA)) positions.push({ x: cx, y: cy, z: cz })
          }
        }
      } else {
        for (let cx = fpA + oX - stepX; cx <= l + stepX; cx += stepX) {
          for (let cz = fpB + oZ - stepZ; cz <= w + stepZ; cz += stepZ) {
            if (xzOk(cx, cz, fpA, fpB)) positions.push({ x: cx, y: cy, z: cz })
          }
        }
      }
    }

  } else if (extDir === 'x') {
    // long=X. Cross-section is a circle (radius fpA) in the Y-Z plane.
    // Honeycomb in Y-Z: rows along Z, offset every other row in Z by stepZ/2,
    // row pitch in Y = stepZ * √3/2  (so diagonal wall-to-wall gap = cell gap).
    const hzXZ = fpA
    const hxXZ = longH
    const stepX = stepLong
    const stepZ = stepFpA                         // Z centre-to-centre
    const hcStepY = stepZ * (Math.sqrt(3) / 2)   // honeycomb row pitch in Y
    const stepY = stepFpB                         // grid row pitch in Y

    const oX = ((offset.oz % stepX) + stepX) % stepX
    const oZ = ((offset.ox % stepZ) + stepZ) % stepZ
    const oY_hc   = ((offset.oy % hcStepY) + hcStepY) % hcStepY
    const oY_grid = ((offset.oy % stepY)   + stepY)   % stepY

    for (let cx = longH + oX - stepX; cx <= l + stepX; cx += stepX) {
      if (cx - longH < 0 || cx + longH > l) continue
      if (gridStyle === 'honeycomb') {
        let row = 0
        for (let cy = fpA + oY_hc - hcStepY; cy <= h + hcStepY; cy += hcStepY, row++) {
          if (cy - fpA < 0 || cy + fpA > h) continue
          const hcOff = row % 2 === 0 ? 0 : stepZ / 2
          for (let cz = fpA + oZ - stepZ + hcOff; cz <= w + stepZ; cz += stepZ) {
            if (rectFootprintOk(cx, cz, hxXZ, hzXZ, poly)) positions.push({ x: cx, y: cy, z: cz })
          }
        }
      } else {
        for (let cy = fpB + oY_grid - stepY; cy <= h + stepY; cy += stepY) {
          if (cy - fpB < 0 || cy + fpB > h) continue
          for (let cz = hzXZ + oZ - stepZ; cz <= w + stepZ; cz += stepZ) {
            if (rectFootprintOk(cx, cz, hxXZ, hzXZ, poly)) positions.push({ x: cx, y: cy, z: cz })
          }
        }
      }
    }

  } else {
    // extDir='y': long=Z. Cross-section is a circle (radius fpA) in the X-Y plane.
    // Honeycomb in X-Y: rows along X, offset every other row in X by stepX/2,
    // row pitch in Y = stepX * √3/2.
    const hxXZ = fpA
    const hzXZ = longH
    const stepZ = stepLong
    const stepX = stepFpA                         // X centre-to-centre
    const hcStepY = stepX * (Math.sqrt(3) / 2)   // honeycomb row pitch in Y
    const stepY = stepFpB                         // grid row pitch in Y

    const oX = ((offset.ox % stepX) + stepX) % stepX
    const oZ = ((offset.oz % stepZ) + stepZ) % stepZ
    const oY_hc   = ((offset.oy % hcStepY) + hcStepY) % hcStepY
    const oY_grid = ((offset.oy % stepY)   + stepY)   % stepY

    for (let cz = longH + oZ - stepZ; cz <= w + stepZ; cz += stepZ) {
      if (cz - longH < 0 || cz + longH > w) continue
      if (gridStyle === 'honeycomb') {
        let row = 0
        for (let cy = fpA + oY_hc - hcStepY; cy <= h + hcStepY; cy += hcStepY, row++) {
          if (cy - fpA < 0 || cy + fpA > h) continue
          const hcOff = row % 2 === 0 ? 0 : stepX / 2
          for (let cx = fpA + oX - stepX + hcOff; cx <= l + stepX; cx += stepX) {
            if (rectFootprintOk(cx, cz, hxXZ, hzXZ, poly)) positions.push({ x: cx, y: cy, z: cz })
          }
        }
      } else {
        for (let cy = fpB + oY_grid - stepY; cy <= h + stepY; cy += stepY) {
          if (cy - fpB < 0 || cy + fpB > h) continue
          for (let cx = hxXZ + oX - stepX; cx <= l + stepX; cx += stepX) {
            if (rectFootprintOk(cx, cz, hxXZ, hzXZ, poly)) positions.push({ x: cx, y: cy, z: cz })
          }
        }
      }
    }
  }

  return positions
}

function runAllCombinations(
  sp: ShapeParams,
  cell: CellParams,
  gridStyle: GridStyle,
  gridOffset: GridOffset3D = { ox: 0, oy: 0, oz: 0 },
): PackingResult[] {
  const results: PackingResult[] = []
  const extrusionDirs: ExtrusionDir[] = ['z', 'x', 'y']
  const gridStyles: GridStyle[] =
    cell.type === 'round'
      ? gridStyle === 'honeycomb' ? ['honeycomb'] : ['grid', 'honeycomb']
      : ['grid']

  const gap = cell.type === 'round' ? CELL_GAP_ROUND : CELL_GAP_PRISM
  const stepA = (cell.type === 'round' ? cell.diam : cell.width)  + gap
  const stepB = (cell.type === 'round' ? cell.diam : (cell as PrismaticCell).depth) + gap
  const stepL = cell.height + LAYER_GAP

  const isManual = gridOffset.ox !== 0 || gridOffset.oy !== 0 || gridOffset.oz !== 0

  for (const extDir of extrusionDirs) {
    for (const gs of gridStyles) {
      let bestPositions: Point3D[] = []
      let bestOffset: GridOffset3D = { ...gridOffset }

      if (isManual) {
        bestPositions = pack3D(sp, cell, extDir, gs, gridOffset)
        bestOffset = { ...gridOffset }
      } else {
        // Auto-sweep 6³ = 216 offset combinations to find the best placement
        const S = 6
        for (let si = 0; si < S; si++) {
          for (let sj = 0; sj < S; sj++) {
            for (let sk = 0; sk < S; sk++) {
              const off: GridOffset3D = {
                ox: (si / S) * stepA,
                oy: (sj / S) * stepB,
                oz: (sk / S) * stepL,
              }
              const pos = pack3D(sp, cell, extDir, gs, off)
              if (pos.length > bestPositions.length) {
                bestPositions = pos
                bestOffset = off
              }
            }
          }
        }
      }

      if (bestPositions.length === 0) continue

      results.push({
        total: bestPositions.length,
        extrusionDir: extDir,
        gridStyle: gs,
        positions: bestPositions,
        polygon: getShapePolygon(sp),
        sp: { ...sp },
        cell: { ...cell } as CellParams,
        gridOffset: bestOffset,
      })
    }
  }

  results.sort((a, b) => b.total - a.total)
  return results
}

// ─────────────────────────────────────────────────────────────────────────────
// THREE.JS SETUP
// ─────────────────────────────────────────────────────────────────────────────

const canvas = document.getElementById('c') as HTMLCanvasElement

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
renderer.setPixelRatio(devicePixelRatio)
renderer.shadowMap.enabled = true
renderer.setClearColor(0xe8edf4, 1)

const scene = new THREE.Scene()

const camera = new THREE.OrthographicCamera(-500, 500, 500, -500, -10000, 10000)
camera.position.set(600, 500, 700)
camera.lookAt(0, 0, 0)

// Lights
scene.add(new THREE.AmbientLight(0xffffff, 2.0))
const dl = new THREE.DirectionalLight(0xffffff, 1.4)
dl.position.set(200, 400, 300)
scene.add(dl)
const dl2 = new THREE.DirectionalLight(0xaaccff, 0.5)
dl2.position.set(-300, 100, -200)
scene.add(dl2)

scene.add(new THREE.AxesHelper(80))

// Resize
function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight
  renderer.setSize(w, h, false)
  const ortho = camera as THREE.OrthographicCamera
  const aspect = w / h
  const half = ortho.right  // current half-size
  ortho.left   = -half * aspect
  ortho.right  =  half * aspect
  ortho.updateProjectionMatrix()
}

new ResizeObserver(resize).observe(canvas)
resize()

// ─────────────────────────────────────────────────────────────────────────────
// ORBIT CONTROLS
// ─────────────────────────────────────────────────────────────────────────────

const controls = new OrbitControls(camera, canvas)
controls.enableDamping = false   // damping causes continuous re-renders and flicker
controls.mouseButtons = {
  LEFT:   THREE.MOUSE.ROTATE,
  MIDDLE: THREE.MOUSE.DOLLY,
  RIGHT:  THREE.MOUSE.PAN,
}
controls.minDistance = 10
controls.maxDistance = 8000

function animate() {
  requestAnimationFrame(animate)
  controls.update()
  renderer.render(scene, camera)
}
animate()

// ─────────────────────────────────────────────────────────────────────────────
// SCENE MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

let visMode: VisMode = 'solid'
let currentResult: PackingResult | null = null
let sceneObjects: THREE.Object3D[] = []
let bboxObject: THREE.Object3D | null = null
// Grid offset in mm (3D, applied to the active result)
let gridOffset: GridOffset3D = { ox: 0, oy: 0, oz: 0 }
// Wrap mesh (shrink-foil)
let wrapMesh: THREE.Mesh | null = null

function clearScene() {
  sceneObjects.forEach(o => scene.remove(o))
  sceneObjects = []
}

function addObj(obj: THREE.Object3D) {
  scene.add(obj)
  sceneObjects.push(obj)
}

function updateBoundingBox(_sp: ShapeParams) {
  if (bboxObject) { scene.remove(bboxObject); bboxObject = null }
  // Bounding box removed — housing shape mesh already shows the volume
}

// ─────────────────────────────────────────────────────────────────────────────
// SHAPE MESH
// ─────────────────────────────────────────────────────────────────────────────

// The housing shape is ALWAYS built from the original sp (l × w footprint, h tall),
// centered at world origin (X: -l/2..l/2, Y: 0..h, Z: -w/2..w/2).
// Only cells change orientation per extrusionDir — the housing never moves.
function buildShapeMesh(result: PackingResult): THREE.Group {
  const { sp } = result
  const { l, w, h } = sp

  // Always use the original footprint polygon (l × w) extruded to height h
  const origPolygon = getShapePolygon(sp)
  const pts = origPolygon.map(p => new THREE.Vector2(p.x - l / 2, p.y - w / 2))
  const shape = new THREE.Shape(pts)
  // Extrude upward (along local Z of Shape = world Y after rotation below)
  const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false })

  const mat = new THREE.MeshStandardMaterial({
    color: 0xadc8e0,
    transparent: true,
    opacity: visMode === 'skeleton' ? 0.04 : 0.22,
    side: THREE.DoubleSide,
    wireframe: visMode === 'wire',
    depthWrite: false,        // housing is transparent — don't block cell depth writes
    polygonOffset: true,
    polygonOffsetFactor: 1,   // push housing faces slightly back to avoid z-fighting
    polygonOffsetUnits: 1,
  })
  const mesh = new THREE.Mesh(geo, mat)
  const wf = new THREE.LineSegments(
    new THREE.EdgesGeometry(geo),
    new THREE.LineBasicMaterial({ color: 0x5588aa, opacity: 0.55, transparent: true }),
  )

  const grp = new THREE.Group()
  grp.add(mesh, wf)
  // ExtrudeGeometry extrudes along local +Z. Rotate so it extrudes along world +Y.
  grp.rotation.x = -Math.PI / 2

  return grp
}

// Builds a visible grid overlay: lines along all three axes through the cell grid.
// Shows the repeating cell pattern as thin lines so the user can see what
// the offset sliders are doing.
function buildGridLines(result: PackingResult): THREE.Object3D {
  const { cell, gridOffset, extrusionDir, sp } = result
  const { l, w, h } = sp
  const gap = cell.type === 'round' ? CELL_GAP_ROUND : CELL_GAP_PRISM

  // Step sizes per world axis — depend on extrusion direction
  let stepX: number, stepY: number, stepZ: number
  if (cell.type === 'round') {
    const d = cell.diam
    if (extrusionDir === 'z') {
      stepX = d + gap; stepZ = d + gap; stepY = cell.height + LAYER_GAP
    } else if (extrusionDir === 'x') {
      stepY = d + gap; stepZ = d + gap; stepX = cell.height + LAYER_GAP
    } else {
      stepX = d + gap; stepY = d + gap; stepZ = cell.height + LAYER_GAP
    }
  } else {
    const pc = cell as PrismaticCell
    if (extrusionDir === 'z') {
      stepX = pc.width + gap; stepZ = pc.depth + gap; stepY = pc.height + LAYER_GAP
    } else if (extrusionDir === 'x') {
      stepY = pc.width + gap; stepZ = pc.depth + gap; stepX = pc.height + LAYER_GAP
    } else {
      stepX = pc.width + gap; stepY = pc.depth + gap; stepZ = pc.height + LAYER_GAP
    }
  }

  const ox = ((gridOffset.ox % stepX) + stepX) % stepX
  const oy = ((gridOffset.oy % stepY) + stepY) % stepY
  const oz = ((gridOffset.oz % stepZ) + stepZ) % stepZ

  const verts: number[] = []

  // Housing world bounds: X ∈ [0..l], Y ∈ [0..h], Z ∈ [0..w]
  // Housing mesh is centered: X-l/2, Y as-is, Z → -(Z - w/2)
  // Grid lines in mesh-centred coords: X ∈ [-l/2..l/2], Y ∈ [0..h], Z ∈ [-w/2..w/2]

  // Lines along Y (vertical), varying X & Z
  for (let gx = ox - stepX; gx <= l + stepX; gx += stepX) {
    const wx = gx - l / 2
    if (wx < -l / 2 || wx > l / 2) continue
    for (let gz = oz - stepZ; gz <= w + stepZ; gz += stepZ) {
      const wz = -(gz - w / 2)
      if (wz < -w / 2 || wz > w / 2) continue
      verts.push(wx, 0, wz,  wx, h, wz)
    }
  }
  // Lines along X (horizontal in XZ-plane), varying Y & Z
  for (let gy = oy - stepY; gy <= h + stepY; gy += stepY) {
    if (gy < 0 || gy > h) continue
    for (let gz = oz - stepZ; gz <= w + stepZ; gz += stepZ) {
      const wz = -(gz - w / 2)
      if (wz < -w / 2 || wz > w / 2) continue
      verts.push(-l / 2, gy, wz,  l / 2, gy, wz)
    }
  }

  if (verts.length === 0) return new THREE.Group()

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3))
  const mat = new THREE.LineBasicMaterial({ color: 0xee8800, opacity: 0.55, transparent: true })
  const lines = new THREE.LineSegments(geo, mat)
  lines.frustumCulled = false
  return lines
}

// ─────────────────────────────────────────────────────────────────────────────
// DIMENSION LABELS
// ─────────────────────────────────────────────────────────────────────────────

function makeTextSprite(text: string, color = '#1a2430'): THREE.Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = 256; canvas.height = 64
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, 256, 64)
  ctx.font = 'bold 28px "JetBrains Mono", "Courier New", monospace'
  ctx.fillStyle = color
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 128, 32)
  const tex = new THREE.CanvasTexture(canvas)
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true })
  const sprite = new THREE.Sprite(mat)
  sprite.renderOrder = 10
  return sprite
}

function makeDimLine(a: THREE.Vector3, b: THREE.Vector3, color: number): THREE.Line {
  const geo = new THREE.BufferGeometry().setFromPoints([a, b])
  const mat = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.75 })
  const line = new THREE.Line(geo, mat)
  line.renderOrder = 9
  return line
}

// Builds dimension annotations for the housing.
// Housing mesh world coords: X ∈ [-l/2..l/2], Y ∈ [0..h], Z ∈ [-w/2..w/2]
// Polygon space → world: wx = px - l/2,  wz = -(pz - w/2)
function buildDimensionLines(sp: ShapeParams): THREE.Group {
  const { type, l, w, h, cut_l, cut_w, stem_w, bar_h, top_mm } = sp
  const grp = new THREE.Group()
  const col  = 0x0055aa
  const col2 = 0x007755   // secondary dims (cutouts etc.)
  const ref  = Math.max(l, w, h)
  const off  = ref * 0.07 + 6    // perpendicular offset for dim line
  const sScale = ref * 0.11      // sprite scale

  // Convert polygon-space (px ∈ [0..l], pz ∈ [0..w]) to world XZ at given Y
  function pw(px: number, pz: number, y = 0): THREE.Vector3 {
    return new THREE.Vector3(px - l / 2, y, -(pz - w / 2))
  }

  function addDim(
    p1: THREE.Vector3, p2: THREE.Vector3,
    extDir: THREE.Vector3,
    label: string,
    color = col,
  ) {
    const o = extDir.clone().normalize().multiplyScalar(off)
    const a = p1.clone().add(o)
    const b = p2.clone().add(o)
    grp.add(makeDimLine(a, b, color))
    grp.add(makeDimLine(p1.clone(), a.clone(), color))
    grp.add(makeDimLine(p2.clone(), b.clone(), color))
    const mid = a.clone().lerp(b, 0.5).add(extDir.clone().normalize().multiplyScalar(sScale * 0.38))
    const sprite = makeTextSprite(label)
    sprite.position.copy(mid)
    sprite.scale.set(sScale, sScale * 0.25, 1)
    grp.add(sprite)
  }

  // Polygon space → world coordinate mapping:
  //   pw(px=0,  pz)  → worldX = -l/2  (left)
  //   pw(px=l,  pz)  → worldX = +l/2  (right)
  //   pw(px, pz=0)   → worldZ = +w/2  (front in world)
  //   pw(px, pz=w)   → worldZ = -w/2  (back in world)
  // "Away from bounding box" directions:
  const outFront = new THREE.Vector3(0, 0,  1)   // pz=0 edge  → worldZ+
  const outBack  = new THREE.Vector3(0, 0, -1)   // pz=w edge  → worldZ-
  const outRight = new THREE.Vector3(1, 0,  0)   // px=l edge  → worldX+
  const outLeft  = new THREE.Vector3(-1, 0, 0)   // px=0 edge  → worldX-

  // ── Always: L (X), W (Z), H (Y) ──────────────────────────────────────────
  // L: front edge (pz=0), offset outFront
  addDim(pw(0, 0), pw(l, 0), outFront, `L ${l}`)
  // W: right edge (px=l), offset outRight
  addDim(pw(l, 0), pw(l, w), outRight, `W ${w}`)
  // H: right-front vertical edge (px=l, pz=0), offset outRight
  addDim(pw(l, 0, 0), pw(l, 0, h), outRight, `H ${h}`)

  // ── Shape-specific secondary dims ────────────────────────────────────────
  if (type === 'l_shape') {
    // Notch is at top-right in polygon space: px ∈ [l-cut_l..l], pz ∈ [w-cut_w..w]
    // cut_l: along the inner horizontal step (pz = w-cut_w), offset outBack (away from notch)
    addDim(pw(l - cut_l, w - cut_w), pw(l, w - cut_w), outBack, `cut_l ${cut_l}`, col2)
    // cut_w: along the inner vertical step (px = l-cut_l), offset outLeft (into open space)
    addDim(pw(l - cut_l, w - cut_w), pw(l - cut_l, w), outLeft, `cut_w ${cut_w}`, col2)

  } else if (type === 'u_shape') {
    // Notch opens at pz=0 side (front in polygon = world front)
    // cut_l: inner span of notch bottom (pz=cut_w), offset outBack
    addDim(pw(cut_l, cut_w), pw(l - cut_l, cut_w), outBack, `cut_l ${cut_l}`, col2)
    // cut_w: left outer wall height (px=0), offset outLeft
    addDim(pw(0, 0), pw(0, cut_w), outLeft, `cut_w ${cut_w}`, col2)

  } else if (type === 't_shape') {
    const cx = (l - stem_w) / 2
    // stem_w: along the bar/stem boundary (pz=bar_h), offset outBack
    addDim(pw(cx, bar_h), pw(cx + stem_w, bar_h), outBack, `stem_w ${stem_w}`, col2)
    // bar_h: right edge of bar (px=l), offset outRight
    addDim(pw(l, 0), pw(l, bar_h), outRight, `bar_h ${bar_h}`, col2)

  } else if (type === 'triangle') {
    // Hypotenuse floating label
    const hyp = Math.round(Math.sqrt(l * l + w * w))
    const mid = pw(l / 2, w / 2)
    mid.x += off * 0.8
    mid.z -= off * 0.4
    const sprite = makeTextSprite(`↗ ${hyp}`, '#007755')
    sprite.position.copy(mid)
    sprite.scale.set(sScale, sScale * 0.25, 1)
    grp.add(sprite)

  } else if (type === 'trapeze') {
    const edgeOff = (l - top_mm) / 2
    // top edge (pz=w = worldZ back), offset outBack
    addDim(pw(edgeOff, w), pw(l - edgeOff, w), outBack, `top ${top_mm}`, col2)
  }

  return grp
}

// ─────────────────────────────────────────────────────────────────────────────
// SHRINK WRAP GEOMETRY
// Strategy: for each "layer" of cells (grouped by their stack-axis coordinate),
// rasterise an SDF (signed distance field) in the cross-section plane, then
// run marching squares at threshold=0 to get the contour polyline that hugs
// the cell outlines. Finally extrude the contour into a thin 3D shell.
// ─────────────────────────────────────────────────────────────────────────────

interface LayerInfo {
  centers2D: { a: number; b: number }[]  // cross-section centres
  stackVal: number                        // coordinate along stack axis (mesh space)
  halfThick: number                       // half-extent along stack axis
}

/** Collect per-layer data from the result's positions (already in pack3D coords). */
function collectLayers(result: PackingResult): LayerInfo[] {
  const { positions, extrusionDir, cell, sp } = result
  const { l, w } = sp

  // half-extent of one cell along the stack axis
  const halfThick = cell.height / 2

  const map = new Map<number, LayerInfo>()

  for (const p of positions) {
    // Convert pack3D → mesh-centred coords: x' = x-l/2, y' = y, z' = -(z-w/2)
    const mx = p.x - l / 2
    const my = p.y
    const mz = -(p.z - w / 2)

    // Which axis is the "stack" (long) axis, and which two form the cross-section?
    let stackVal: number
    let a: number, b: number  // cross-section axes

    if (extrusionDir === 'z') {
      stackVal = my;  a = mx;  b = mz
    } else if (extrusionDir === 'x') {
      stackVal = mx;  a = my;  b = mz
    } else {
      stackVal = mz;  a = mx;  b = my
    }

    const key = Math.round(stackVal * 100)
    if (!map.has(key)) {
      map.set(key, { centers2D: [], stackVal, halfThick })
    }
    map.get(key)!.centers2D.push({ a, b })
  }

  return Array.from(map.values()).sort((x, y) => x.stackVal - y.stackVal)
}

/** Marching-squares on a Float32Array SDF grid, returns closed-ish polyline segments. */
function marchingSquaresContour(
  sdf: Float32Array, cols: number, rows: number,
  res: number, minA: number, minB: number,
): [number, number][][] {
  // Edge table for 16 cases (each entry = list of [edgeA, edgeB] pairs, edges 0=bottom 1=right 2=top 3=left)
  const ET: number[][][] = [
    [],[[3,0]],[[0,1]],[[3,1]],
    [[1,2]],[[3,0],[1,2]],[[0,2]],[[3,2]],
    [[2,3]],[[2,0]],[[2,3],[0,1]],[[2,1]],
    [[1,3]],[[1,0]],[[0,3]],[],
  ]

  function interp(v0: number, v1: number): number {
    if (Math.abs(v1 - v0) < 1e-9) return 0.5
    return Math.max(0, Math.min(1, -v0 / (v1 - v0)))
  }

  function edgePt(col: number, row: number, edge: number): [number, number] {
    // corners: 0=BL 1=BR 2=TR 3=TL
    const v = [
      sdf[ row      * cols + col],
      sdf[ row      * cols + col + 1],
      sdf[(row + 1) * cols + col + 1],
      sdf[(row + 1) * cols + col],
    ]
    const cx = minA + col * res
    const cy = minB + row * res
    switch (edge) {
      case 0: { const t = interp(v[0], v[1]); return [cx + t * res, cy] }
      case 1: { const t = interp(v[1], v[2]); return [cx + res, cy + t * res] }
      case 2: { const t = interp(v[3], v[2]); return [cx + t * res, cy + res] }
      case 3: { const t = interp(v[0], v[3]); return [cx, cy + t * res] }
    }
    return [cx, cy]
  }

  const segments: [number, number][][] = []

  for (let row = 0; row < rows - 1; row++) {
    for (let col = 0; col < cols - 1; col++) {
      const bl = sdf[ row      * cols + col    ] <= 0 ? 1 : 0
      const br = sdf[ row      * cols + col + 1] <= 0 ? 1 : 0
      const tr = sdf[(row + 1) * cols + col + 1] <= 0 ? 1 : 0
      const tl = sdf[(row + 1) * cols + col    ] <= 0 ? 1 : 0
      const caseIdx = bl | (br << 1) | (tr << 2) | (tl << 3)
      const pairs = ET[caseIdx]
      for (const [e0, e1] of pairs) {
        segments.push([edgePt(col, row, e0), edgePt(col, row, e1)])
      }
    }
  }
  return segments
}

/** Build a 3D wrap mesh for one layer given its 2D cross-section centres and the cell footprint radius. */
function buildLayerWrapGeo(
  layer: LayerInfo,
  cellFootprintRadius: number,
  extrusionDir: ExtrusionDir,
  wrapThickness: number,
): THREE.BufferGeometry | null {
  const { centers2D, stackVal, halfThick } = layer
  if (centers2D.length === 0) return null

  // Morphological CLOSE: inflate radius enough so neighbouring cell circles fully
  // merge into one blob → single outer contour per layer, not per-cell lobes.
  // Estimate the gap from the nearest-neighbour centre-to-centre distance.
  let minNeighbourDist = Infinity
  for (let i = 0; i < centers2D.length; i++) {
    for (let j = i + 1; j < centers2D.length; j++) {
      const d = Math.hypot(centers2D[i].a - centers2D[j].a, centers2D[i].b - centers2D[j].b)
      if (d < minNeighbourDist) minNeighbourDist = d
    }
  }
  // r must reach past the midpoint between neighbours so circles overlap in SDF
  const r = centers2D.length > 1
    ? minNeighbourDist / 2 + wrapThickness
    : cellFootprintRadius + wrapThickness

  // Bounding box
  let minA = Infinity, minB = Infinity, maxA = -Infinity, maxB = -Infinity
  for (const c of centers2D) {
    minA = Math.min(minA, c.a - r - 2)
    minB = Math.min(minB, c.b - r - 2)
    maxA = Math.max(maxA, c.a + r + 2)
    maxB = Math.max(maxB, c.b + r + 2)
  }

  const res = Math.max(0.8, cellFootprintRadius * 0.12)
  const cols = Math.ceil((maxA - minA) / res) + 2
  const rows = Math.ceil((maxB - minB) / res) + 2

  // SDF: min distance to nearest inflated cell circle (negative = inside)
  const sdf = new Float32Array(cols * rows)
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const pa = minA + col * res
      const pb = minB + row * res
      let minDist = Infinity
      for (const c of centers2D) {
        const d = Math.hypot(pa - c.a, pb - c.b) - r
        if (d < minDist) minDist = d
      }
      sdf[row * cols + col] = minDist
    }
  }

  // Marching squares → outer hull contour of the merged blob
  const segs = marchingSquaresContour(sdf, cols, rows, res, minA, minB)
  if (segs.length === 0) return null

  // Extrude each segment pair into a quad (two triangles) forming the side wall
  // The layer occupies [stackVal - halfThick, stackVal + halfThick] along the stack axis.
  const wallBottom = stackVal - halfThick
  const wallTop    = stackVal + halfThick

  const verts: number[] = []
  const idx:   number[] = []

  function toWorld(a: number, b: number, s: number): [number, number, number] {
    if (extrusionDir === 'z') return [a, s, b]
    if (extrusionDir === 'x') return [s, a, b]
    return [a, b, s]   // extDir='y'
  }

  for (const [[a0, b0], [a1, b1]] of segs) {
    const base = verts.length / 3

    const [x0b, y0b, z0b] = toWorld(a0, b0, wallBottom)
    const [x0t, y0t, z0t] = toWorld(a0, b0, wallTop)
    const [x1b, y1b, z1b] = toWorld(a1, b1, wallBottom)
    const [x1t, y1t, z1t] = toWorld(a1, b1, wallTop)

    verts.push(x0b, y0b, z0b)   // 0 bottom-left
    verts.push(x0t, y0t, z0t)   // 1 top-left
    verts.push(x1b, y1b, z1b)   // 2 bottom-right
    verts.push(x1t, y1t, z1t)   // 3 top-right

    idx.push(base, base + 1, base + 2)
    idx.push(base + 1, base + 3, base + 2)
  }

  if (verts.length === 0) return null

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  return geo
}

/** Build and add the shrink-wrap mesh to the scene. */
function buildWrapMesh(result: PackingResult): THREE.Mesh | null {
  const { cell, positions, extrusionDir, sp } = result
  const { l, w } = sp

  const wrapThicknessEl = document.getElementById('wrapThickness') as HTMLInputElement
  const wrapThickness = wrapThicknessEl ? parseFloat(wrapThicknessEl.value) : 2

  let cellRadius: number
  if (cell.type === 'round') {
    cellRadius = cell.diam / 2
  } else {
    cellRadius = Math.max(cell.width, cell.depth) / 2
  }

  if (positions.length === 0) return null

  // Build a SINGLE tube wrapping ALL cells together.
  // Step 1: convert every position to mesh-centred coords.
  // Step 2: take only the two cross-section axes (drop the stack axis).
  // Step 3: deduplicate so repeated grid positions don't slow down the SDF.
  // Step 4: find the full stack extent for the extrusion length.

  const seen = new Set<string>()
  const centers2D: { a: number; b: number }[] = []
  let stackMin = Infinity, stackMax = -Infinity
  const halfThick = cell.height / 2

  for (const p of positions) {
    const mx = p.x - l / 2
    const my = p.y
    const mz = -(p.z - w / 2)

    let stackVal: number
    let a: number, b: number

    if (extrusionDir === 'z') {
      stackVal = my; a = mx; b = mz
    } else if (extrusionDir === 'x') {
      stackVal = mx; a = my; b = mz
    } else {
      stackVal = mz; a = mx; b = my
    }

    stackMin = Math.min(stackMin, stackVal - halfThick)
    stackMax = Math.max(stackMax, stackVal + halfThick)

    // Deduplicate cross-section positions (rounded to 0.1 mm)
    const key = `${Math.round(a * 10)},${Math.round(b * 10)}`
    if (!seen.has(key)) {
      seen.add(key)
      centers2D.push({ a, b })
    }
  }

  const fullLayer: LayerInfo = {
    centers2D,
    stackVal: (stackMin + stackMax) / 2,
    halfThick: (stackMax - stackMin) / 2,
  }

  const geo = buildLayerWrapGeo(fullLayer, cellRadius, extrusionDir, wrapThickness)
  if (!geo) return null

  const colorEl   = document.getElementById('wrapColor')   as HTMLInputElement
  const opacityEl = document.getElementById('wrapOpacity') as HTMLInputElement
  const color   = colorEl   ? colorEl.value               : '#44aaff'
  const opacity = opacityEl ? parseFloat(opacityEl.value) : 0.35

  const mat = new THREE.MeshPhysicalMaterial({
    color,
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
    roughness: 0.15,
    metalness: 0.0,
    depthWrite: false,
  })

  return new THREE.Mesh(geo, mat)
}

/** Minimal geometry merger (avoids importing BufferGeometryUtils). */
function mergeBufferGeometries(geos: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  let totalVerts = 0, totalIdx = 0
  for (const g of geos) {
    totalVerts += (g.getAttribute('position') as THREE.BufferAttribute).count
    totalIdx   += g.index ? g.index.count : 0
  }
  if (totalVerts === 0) return null

  const allPos = new Float32Array(totalVerts * 3)
  const allIdx = new Uint32Array(totalIdx)
  let vOff = 0, iOff = 0, baseVert = 0

  for (const g of geos) {
    const pos = g.getAttribute('position') as THREE.BufferAttribute
    for (let i = 0; i < pos.count; i++) {
      allPos[(vOff + i) * 3]     = pos.getX(i)
      allPos[(vOff + i) * 3 + 1] = pos.getY(i)
      allPos[(vOff + i) * 3 + 2] = pos.getZ(i)
    }
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) {
        allIdx[iOff + i] = baseVert + g.index.getX(i)
      }
      iOff += g.index.count
    }
    baseVert += pos.count
    vOff     += pos.count
  }

  const merged = new THREE.BufferGeometry()
  merged.setAttribute('position', new THREE.Float32BufferAttribute(allPos, 3))
  if (totalIdx > 0) merged.setIndex(new THREE.BufferAttribute(allIdx, 1))
  merged.computeVertexNormals()
  return merged
}

/** Toggle wrap on/off and refresh its appearance. */
function updateWrap() {
  if (wrapMesh) { scene.remove(wrapMesh); wrapMesh = null }

  const toggle = document.getElementById('wrapToggle') as HTMLInputElement
  if (!toggle?.checked || !currentResult) return

  wrapMesh = buildWrapMesh(currentResult)
  if (wrapMesh) {
    wrapMesh.renderOrder = 2
    scene.add(wrapMesh)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// VISUALIZE RESULT
// ─────────────────────────────────────────────────────────────────────────────

const CELL_COLORS = [0x0077cc, 0x00aa77, 0xdd6600, 0x9933cc]

function makeCellGeo(cell: CellParams, extDir: ExtrusionDir): THREE.BufferGeometry {
  // Geometry is always built with the long axis along Y (Three.js CylinderGeometry default).
  // Rotation to the correct world axis is applied via instanceQuat below.
  const h = cell.height
  if (cell.type === 'round') {
    return new THREE.CylinderGeometry(cell.diam / 2, cell.diam / 2, h, 16)
  }
  // prismatic: width × depth cross-section, height is long axis
  // extDir=z → stands along Y: X=width, Z=depth
  // extDir=x → lies along X (rotated later): X=width, Z=depth
  // extDir=y → lies along Z (rotated later): X=width, Z=depth
  void extDir
  return new THREE.BoxGeometry(cell.width, h, cell.depth)
}

function visualizeResult(result: PackingResult, keepCamera = false) {
  clearScene()
  currentResult = result

  const { cell, extrusionDir, sp, positions, gridOffset } = result
  const { l, w, h } = sp

  updateBoundingBox(sp)
  addObj(buildShapeMesh(result))
  addObj(buildGridLines(result))
  addObj(buildDimensionLines(result.sp))

  // Cell geometry: long axis along Y, rotated per extrusionDir
  const cellGeo = makeCellGeo(cell, extrusionDir)

  // Rotation quaternion: pack3D returns world-space positions with cell long axis along:
  //   extDir=z → world Y  (no rotation needed)
  //   extDir=x → world X  (rotate 90° around Z)
  //   extDir=y → world Z  (rotate 90° around X)
  const instanceQuat = new THREE.Quaternion()
  if (extrusionDir === 'x') {
    instanceQuat.setFromEuler(new THREE.Euler(0, 0, Math.PI / 2))
  } else if (extrusionDir === 'y') {
    instanceQuat.setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0))
  }

  // pack3D returns world coords: X ∈ [0..l], Y ∈ [0..h], Z ∈ [0..w]
  // Housing mesh is centred: X → X-l/2, Y stays, Z → -(Z-w/2)
  const totalCount = positions.length

  // Assign a colour per "layer" — group cells by their stack-axis coordinate
  // so visually distinct layers get different colours.
  const stackCoords = new Map<number, number>()
  for (const p of positions) {
    const key = extrusionDir === 'z' ? p.y
              : extrusionDir === 'x' ? p.x
              : p.z
    const rounded = Math.round(key * 10) / 10
    if (!stackCoords.has(rounded)) stackCoords.set(rounded, stackCoords.size)
  }

  const cellColor = new THREE.Color()

  // Build one merged BufferGeometry with all cell vertices baked into world coordinates.
  const srcGeo = visMode === 'skeleton' ? new THREE.EdgesGeometry(cellGeo) : cellGeo
  const srcPos = srcGeo.getAttribute('position') as THREE.BufferAttribute
  const srcIdx = srcGeo.index
  const vertsPerCell = srcPos.count
  const trisPerCell  = srcIdx ? srcIdx.count : vertsPerCell

  const allPos    = new Float32Array(totalCount * vertsPerCell * 3)
  const allColors = new Float32Array(totalCount * vertsPerCell * 3)
  const allIdx    = srcIdx ? new Uint32Array(totalCount * trisPerCell) : null

  const tmpVec = new THREE.Vector3()
  let vOffset = 0
  let iOffset = 0

  for (const p of positions) {
    // Convert pack3D world coords → mesh-centred world coords
    const worldPos = new THREE.Vector3(p.x - l / 2, p.y, -(p.z - w / 2))

    const stackKey = extrusionDir === 'z' ? Math.round(p.y * 10) / 10
                   : extrusionDir === 'x' ? Math.round(p.x * 10) / 10
                   : Math.round(p.z * 10) / 10
    const layerIdx = stackCoords.get(stackKey) ?? 0
    cellColor.set(CELL_COLORS[layerIdx % CELL_COLORS.length])

    const baseVert = vOffset / 3
    for (let v = 0; v < vertsPerCell; v++) {
      tmpVec.set(srcPos.getX(v), srcPos.getY(v), srcPos.getZ(v))
      tmpVec.applyQuaternion(instanceQuat).add(worldPos)
      allPos[vOffset]     = tmpVec.x
      allPos[vOffset + 1] = tmpVec.y
      allPos[vOffset + 2] = tmpVec.z
      allColors[vOffset]     = cellColor.r
      allColors[vOffset + 1] = cellColor.g
      allColors[vOffset + 2] = cellColor.b
      vOffset += 3
    }
    if (allIdx && srcIdx) {
      for (let i = 0; i < trisPerCell; i++) {
        allIdx[iOffset++] = baseVert + srcIdx.getX(i)
      }
    }
  }

  const mergedGeo = new THREE.BufferGeometry()
  mergedGeo.setAttribute('position', new THREE.BufferAttribute(allPos, 3))
  mergedGeo.setAttribute('color',    new THREE.BufferAttribute(allColors, 3))
  if (allIdx) mergedGeo.setIndex(new THREE.BufferAttribute(allIdx, 1))

  let obj: THREE.Object3D
  if (visMode === 'skeleton') {
    obj = new THREE.LineSegments(mergedGeo, new THREE.LineBasicMaterial({ vertexColors: true }))
  } else if (visMode === 'wire') {
    obj = new THREE.Mesh(mergedGeo, new THREE.MeshStandardMaterial({ wireframe: true, vertexColors: true }))
  } else {
    obj = new THREE.Mesh(mergedGeo, new THREE.MeshStandardMaterial({
      metalness: cell.type === 'round' ? 0.7 : 0.5,
      roughness: cell.type === 'round' ? 0.3 : 0.4,
      vertexColors: true,
    }))
  }
  obj.frustumCulled = false
  obj.renderOrder = 1
  addObj(obj)

  updateCountUI(totalCount, stackCoords.size, result)

  show('overlay')
  show('visControls')
  show('wrapCard')

  // suppress unused
  void gridOffset

  // Rebuild wrap mesh after scene is updated
  updateWrap()

  if (!keepCamera) {
    const size = Math.max(l, w, h)
    controls.target.set(0, h / 2, 0)
    // Isometric-style position: equal angle on all three axes
    camera.position.set(
      size * 1.2 + 0,
      h / 2 + size * 1.0,
      size * 1.2,
    )
    // Fit the housing into view via orthographic frustum half-size
    const ortho = camera as THREE.OrthographicCamera
    const half = size * 1.4
    const aspect = canvas.clientWidth / canvas.clientHeight
    ortho.left   = -half * aspect
    ortho.right  =  half * aspect
    ortho.top    =  half
    ortho.bottom = -half
    ortho.updateProjectionMatrix()
    controls.update()
  }
}

// Updates every count-related UI element from the same values.
function updateCountUI(total: number, layers: number, result: PackingResult) {
  const perLayer = layers > 0 ? Math.round(total / layers) : 0
  // 3D overlay
  el('ov_total').textContent  = String(total)
  el('ov_grid').textContent   = String(perLayer)
  el('ov_layers').textContent = String(layers)
  el('ov_orient').textContent =
    `${DIR_LABELS[result.extrusionDir]} · ${GS_LABELS[result.gridStyle]}`

  // Header above the result list (shows the active result, not necessarily the best)
  el('bestCount').textContent = `${total} Zellen`
  el('bestDesc').textContent =
    `${perLayer} × ${layers} Ebenen · ${result.extrusionDir.toUpperCase()}-Richtung`

  // Update the active row in the list in-place (no full re-render)
  const activeRow = el('resultList').querySelector('.result-row.active')
  if (activeRow) {
    const countEl = activeRow.querySelector('.count')
    const subEl   = activeRow.querySelector('span[style]')
    if (countEl) countEl.textContent = String(total)
    if (subEl)   subEl.textContent   = `${perLayer}×${layers}`
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UI HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function el(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement
}

function val(id: string): number {
  return parseFloat((document.getElementById(id) as HTMLInputElement).value)
}

function selVal(id: string): string {
  return (document.getElementById(id) as HTMLSelectElement).value
}

function show(id: string) { el(id).style.display = '' }
function hide(id: string) { el(id).style.display = 'none' }

// ─────────────────────────────────────────────────────────────────────────────
// UI STATE
// ─────────────────────────────────────────────────────────────────────────────

function onShapeChange() {
  const t = selVal('shapeType') as ShapeType
  el('extra_cut').style.display = (t === 'l_shape' || t === 'u_shape') ? '' : 'none'
  el('extra_t').style.display = t === 't_shape' ? '' : 'none'
  el('extra_trap').style.display = t === 'trapeze' ? '' : 'none'
}

function onCellTypeChange() {
  const t = selVal('cellType') as CellType
  el('round_dims').style.display = t === 'round' ? '' : 'none'
  el('prism_dims').style.display = t === 'prismatic' ? '' : 'none'
  el('grid_opts_round').style.display = t === 'round' ? '' : 'none'
}

function setPreset(key: string) {
  document.querySelectorAll('.preset-btn').forEach(b =>
    b.classList.toggle('active', (b as HTMLElement).dataset.preset === key)
  )
  if (key === 'custom') return

  const p = CELL_PRESETS[key]
  if (!p) return

  ;(document.getElementById('cellType') as HTMLSelectElement).value = p.type
  onCellTypeChange()

  if (p.type === 'round') {
    ;(document.getElementById('cell_diam') as HTMLInputElement).value = String(p.diam)
    ;(document.getElementById('cell_h_round') as HTMLInputElement).value = String(p.height)
  } else {
    ;(document.getElementById('cell_w') as HTMLInputElement).value = String(p.width)
    ;(document.getElementById('cell_d') as HTMLInputElement).value = String(p.depth)
    ;(document.getElementById('cell_h_prism') as HTMLInputElement).value = String(p.height)
  }
}

function getShapeParams(): ShapeParams {
  return {
    type: selVal('shapeType') as ShapeType,
    l: val('dim_l'),
    w: val('dim_w'),
    h: val('dim_h'),
    cut_l: val('dim_cut_l'),
    cut_w: val('dim_cut_w'),
    stem_w: val('dim_stem_w'),
    bar_h: val('dim_bar_h'),
    top_mm: val('dim_top_mm'),
  }
}

function getCellParams(): CellParams {
  const t = selVal('cellType') as CellType
  if (t === 'round') {
    return { type: 'round', diam: val('cell_diam'), height: val('cell_h_round') }
  }
  return { type: 'prismatic', width: val('cell_w'), depth: val('cell_d'), height: val('cell_h_prism') }
}

// ─────────────────────────────────────────────────────────────────────────────
// RESULTS UI
// ─────────────────────────────────────────────────────────────────────────────

let allResults: PackingResult[] = []
let activeResultIdx = 0

// Renders the result list and wires click handlers. Does NOT touch the 3D scene.
function renderResultList(results: PackingResult[], activeIdx = 0) {
  if (results.length === 0) {
    el('bestCount').textContent = '0'
    el('bestDesc').textContent = 'Keine Zellen passen in den Bauraum.'
    el('resultList').innerHTML = ''
    return
  }

  el('resultList').innerHTML = results.slice(0, 20).map((r, i) => `
    <div class="result-row${i === activeIdx ? ' active' : ''}" data-idx="${i}">
      <div>
        <span class="count">${r.total}</span>
      </div>
      <div class="desc">${DIR_LABELS_SHORT[r.extrusionDir]} · ${GS_LABELS[r.gridStyle]}</div>
    </div>
  `).join('')

  el('resultList').querySelectorAll('.result-row').forEach(row => {
    row.addEventListener('click', () => {
      const idx = parseInt((row as HTMLElement).dataset.idx ?? '0')
      selectResult(idx)
    })
  })
}

function showResults(results: PackingResult[]) {
  show('resultsPanel')
  activeResultIdx = 0
  renderResultList(results, 0)
  if (results.length > 0) selectResult(0)
}

function selectResult(idx: number) {
  activeResultIdx = idx
  el('resultList').querySelectorAll('.result-row').forEach((r, i) =>
    r.classList.toggle('active', i === idx)
  )
  const r = allResults[idx]
  // Sync global offset + sliders to this result's stored optimal offset
  gridOffset = { ...r.gridOffset }
  syncOffsetSliders(r)
  visualizeResult(r)
}

function syncOffsetSliders(r: PackingResult) {
  const c = r.cell
  const gap = c.type === 'round' ? CELL_GAP_ROUND : CELL_GAP_PRISM
  const stepX = (c.type === 'round' ? c.diam : c.width)  + gap
  const stepY = (c.type === 'round' ? c.diam : (c as PrismaticCell).depth) + gap
  const stepZ = c.height + LAYER_GAP
  ;(el('gridOffX') as HTMLInputElement).max   = String(stepX)
  ;(el('gridOffY') as HTMLInputElement).max   = String(stepY)
  ;(el('gridOffZ') as HTMLInputElement).max   = String(stepZ)
  ;(el('gridOffX') as HTMLInputElement).value = String(r.gridOffset.ox)
  ;(el('gridOffY') as HTMLInputElement).value = String(r.gridOffset.oy)
  ;(el('gridOffZ') as HTMLInputElement).value = String(r.gridOffset.oz)
  el('gridOffXVal').textContent = r.gridOffset.ox.toFixed(1)
  el('gridOffYVal').textContent = r.gridOffset.oy.toFixed(1)
  el('gridOffZVal').textContent = r.gridOffset.oz.toFixed(1)
}

// Re-packs only the active result with the current offset/params and re-renders it.
// All other results in allResults stay untouched.
function liveRefresh() {
  if (allResults.length === 0) return
  getPackingParams()

  const ref = allResults[activeResultIdx]
  const newPositions = pack3D(ref.sp, ref.cell, ref.extrusionDir, ref.gridStyle, gridOffset)

  // Update only the active entry in-place
  allResults[activeResultIdx] = {
    ...ref,
    positions: newPositions,
    total:     newPositions.length,
    gridOffset: { ...gridOffset },
  }

  // Re-render list row count for the active result only
  const activeRow = el('resultList').querySelector(`.result-row[data-idx="${activeResultIdx}"]`)
  if (activeRow) {
    const countEl = activeRow.querySelector('.count')
    if (countEl) countEl.textContent = String(newPositions.length)
  }

  visualizeResult(allResults[activeResultIdx], true)
}

// ─────────────────────────────────────────────────────────────────────────────
// OPTIMIZER RUNNER
// ─────────────────────────────────────────────────────────────────────────────

function runOptimizer() {
  const sp = getShapeParams()
  const cell = getCellParams()
  const gridStyle = selVal('gridType') as GridStyle

  ;(el('runBtn') as HTMLButtonElement).disabled = true
  show('progress')
  el('prog_text').textContent = 'Berechnung läuft…'
  el('prog_sub').textContent = 'Prüfe alle Kombinationen…'
  hide('resultsPanel')

  // Defer to next tick so the browser can repaint first
  setTimeout(() => {
    try {
      getPackingParams()
      gridOffset = { ox: 0, oy: 0, oz: 0 }
      allResults = runAllCombinations(sp, cell, gridStyle, gridOffset)
      showResults(allResults)
      if (allResults.length > 0) resetOffsetSliders(allResults[0])
    } catch (e) {
      el('prog_text').textContent = 'Fehler: ' + (e as Error).message
    }
    ;(el('runBtn') as HTMLButtonElement).disabled = false
    hide('progress')
  }, 20)
}

// ─────────────────────────────────────────────────────────────────────────────
// VIS MODE
// ─────────────────────────────────────────────────────────────────────────────

function setVis(mode: VisMode) {
  visMode = mode
  ;(['Solid', 'Wire', 'Skeleton'] as const).forEach(m =>
    el('btn' + m).classList.toggle('active', m.toLowerCase() === mode)
  )
  if (currentResult) visualizeResult(currentResult, true)
}

// ─────────────────────────────────────────────────────────────────────────────
// GRID OFFSET
// ─────────────────────────────────────────────────────────────────────────────

function resetOffsetSliders(result: PackingResult) {
  syncOffsetSliders(result)
  show('offsetCard')
}

function onOffsetChange() {
  if (!currentResult) return
  gridOffset = {
    ox: parseFloat((el('gridOffX') as HTMLInputElement).value),
    oy: parseFloat((el('gridOffY') as HTMLInputElement).value),
    oz: parseFloat((el('gridOffZ') as HTMLInputElement).value),
  }
  el('gridOffXVal').textContent = gridOffset.ox.toFixed(1)
  el('gridOffYVal').textContent = gridOffset.oy.toFixed(1)
  el('gridOffZVal').textContent = gridOffset.oz.toFixed(1)
  liveRefresh()
}

// ─────────────────────────────────────────────────────────────────────────────
// WIRE UP EVENT LISTENERS
// ─────────────────────────────────────────────────────────────────────────────

document.getElementById('shapeType')!.addEventListener('change', onShapeChange)
document.getElementById('cellType')!.addEventListener('change', onCellTypeChange)
document.getElementById('runBtn')!.addEventListener('click', runOptimizer)

document.getElementById('btnSolid')!.addEventListener('click', () => setVis('solid'))
document.getElementById('btnWire')!.addEventListener('click', () => setVis('wire'))
document.getElementById('btnSkeleton')!.addEventListener('click', () => setVis('skeleton'))

document.getElementById('gridOffX')!.addEventListener('input', onOffsetChange)
document.getElementById('gridOffY')!.addEventListener('input', onOffsetChange)
document.getElementById('gridOffZ')!.addEventListener('input', onOffsetChange)

// Wrap controls
document.getElementById('wrapToggle')!.addEventListener('change', updateWrap)
document.getElementById('wrapColor')!.addEventListener('input', updateWrap)
document.getElementById('wrapOpacity')!.addEventListener('input', () => {
  const v = (document.getElementById('wrapOpacity') as HTMLInputElement).value
  const lbl = document.getElementById('wrapOpacityVal')
  if (lbl) lbl.textContent = parseFloat(v).toFixed(2)
  updateWrap()
})
document.getElementById('wrapThickness')!.addEventListener('input', updateWrap)

// Live refresh when spacing params change
;['paramMargin', 'paramGapRound', 'paramGapPrism', 'paramLayerGap'].forEach(id => {
  document.getElementById(id)!.addEventListener('input', () => { if (allResults.length) liveRefresh() })
})

document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => setPreset((btn as HTMLElement).dataset.preset ?? ''))
})

// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────

onShapeChange()
setPreset('18650')
