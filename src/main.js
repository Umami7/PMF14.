import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import './style.css';
// ─────────────────────────────────────────────────────────────────────────────
// PACKING PARAMETERS  (user-adjustable, read from inputs at runtime)
// ─────────────────────────────────────────────────────────────────────────────
// These are mutable — read via getPackingParams() at calculation time
let BOUNDARY_MARGIN = 5; // mm clearance from shape boundary
let CELL_GAP_ROUND = 5; // mm gap between round cell walls
let CELL_GAP_PRISM = 1; // mm gap between prismatic cell walls
let LAYER_GAP = 2; // mm gap between layers (stack direction)
function getPackingParams() {
    BOUNDARY_MARGIN = parseFloat(document.getElementById('paramMargin')?.value ?? '5') || 0;
    CELL_GAP_ROUND = parseFloat(document.getElementById('paramGapRound')?.value ?? '5') || 0;
    CELL_GAP_PRISM = parseFloat(document.getElementById('paramGapPrism')?.value ?? '1') || 0;
    LAYER_GAP = parseFloat(document.getElementById('paramLayerGap')?.value ?? '2') || 0;
}
const CELL_PRESETS = {
    '18650': { type: 'round', diam: 18, height: 65 },
    '21700': { type: 'round', diam: 21, height: 70 },
    'BYD50': { type: 'prismatic', width: 148, depth: 27, height: 91 },
    'EVE50': { type: 'prismatic', width: 135, depth: 30, height: 185 },
};
const DIR_LABELS = {
    z: 'von oben (Z)',
    x: 'von links (X)',
    y: 'von vorne (Y)',
};
const DIR_LABELS_SHORT = {
    z: 'Z-Achse',
    x: 'X-Achse',
    y: 'Y-Achse',
};
const GS_LABELS = {
    grid: 'Grid',
    honeycomb: '⬡ HComb',
};
// ─────────────────────────────────────────────────────────────────────────────
// GEOMETRY – 2D POLYGON
// ─────────────────────────────────────────────────────────────────────────────
function getShapePolygon(sp) {
    const { type, l, w, cut_l, cut_w, stem_w, bar_h, top_mm } = sp;
    switch (type) {
        case 'rectangle':
            return [{ x: 0, y: 0 }, { x: l, y: 0 }, { x: l, y: w }, { x: 0, y: w }];
        case 'l_shape':
            return [
                { x: 0, y: 0 }, { x: l, y: 0 }, { x: l, y: w - cut_w },
                { x: l - cut_l, y: w - cut_w }, { x: l - cut_l, y: w }, { x: 0, y: w },
            ];
        case 'u_shape':
            return [
                { x: 0, y: 0 }, { x: l, y: 0 }, { x: l, y: w },
                { x: l - cut_l, y: w }, { x: l - cut_l, y: cut_w },
                { x: cut_l, y: cut_w }, { x: cut_l, y: w }, { x: 0, y: w },
            ];
        case 't_shape': {
            const cx = (l - stem_w) / 2;
            return [
                { x: 0, y: 0 }, { x: l, y: 0 }, { x: l, y: bar_h },
                { x: cx + stem_w, y: bar_h }, { x: cx + stem_w, y: w },
                { x: cx, y: w }, { x: cx, y: bar_h }, { x: 0, y: bar_h },
            ];
        }
        case 'triangle':
            return [{ x: 0, y: 0 }, { x: l, y: 0 }, { x: 0, y: w }];
        case 'trapeze': {
            const off = (l - top_mm) / 2;
            return [{ x: 0, y: 0 }, { x: l, y: 0 }, { x: l - off, y: w }, { x: off, y: w }];
        }
    }
}
function pointInPolygon(px, py, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x, yi = poly[i].y;
        const xj = poly[j].x, yj = poly[j].y;
        if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
            inside = !inside;
        }
    }
    return inside;
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
function circleFootprintOk(cx2d, cz2d, r, poly) {
    const steps = 24;
    for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        if (!pointInPolygon(cx2d + (r + BOUNDARY_MARGIN) * Math.cos(a), cz2d + (r + BOUNDARY_MARGIN) * Math.sin(a), poly))
            return false;
    }
    return pointInPolygon(cx2d, cz2d, poly);
}
// Check if a 2D AABB is fully inside poly+margin (footprint test)
function rectFootprintOk(cx2d, cz2d, hw, hd, poly) {
    const m = BOUNDARY_MARGIN;
    return pointInPolygon(cx2d - hw - m, cz2d - hd - m, poly)
        && pointInPolygon(cx2d + hw + m, cz2d - hd - m, poly)
        && pointInPolygon(cx2d - hw - m, cz2d + hd + m, poly)
        && pointInPolygon(cx2d + hw + m, cz2d + hd + m, poly);
}
function pack3D(sp, cell, extDir, gridStyle, offset) {
    const { l, h, w } = sp;
    const poly = getShapePolygon(sp); // always original l×w polygon, never swapped
    // Cell half-dimensions in world axes depending on extrusion direction
    // extDir='z': cell is a cylinder/box standing along Y → footprint in X-Z
    // extDir='x': cell lies along X                       → footprint in Y-Z (rotated: long=X)
    // extDir='y': cell lies along Z                       → footprint in X-Y (rotated: long=Z)
    // Footprint half-sizes (the two axes perpendicular to the cell's long axis)
    let fpA, fpB; // half-size in the two "cross" directions
    let longH; // half-size along the cell's long axis
    const gap = cell.type === 'round' ? CELL_GAP_ROUND : CELL_GAP_PRISM;
    if (cell.type === 'round') {
        fpA = fpB = cell.diam / 2;
        longH = cell.height / 2;
    }
    else {
        fpA = cell.width / 2;
        fpB = cell.depth / 2;
        longH = cell.height / 2;
    }
    const stepFpA = fpA * 2 + gap;
    const stepFpB = fpB * 2 + gap;
    const stepLong = longH * 2 + LAYER_GAP;
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
    function xzOk(cx, cz, hx, hz) {
        if (cell.type === 'round') {
            // For round cells the cross-section is always circular with radius = diam/2
            // regardless of direction. hx == hz == fpA always for round cells.
            return circleFootprintOk(cx, cz, hx, poly);
        }
        return rectFootprintOk(cx, cz, hx, hz, poly);
    }
    const positions = [];
    if (extDir === 'z') {
        // long=Y, cross in X-Z: hx=fpA, hz=fpB
        // stepX=stepFpA, stepZ=stepFpB, stepY=stepLong
        const stepX = stepFpA, stepZ = stepFpB, stepY = stepLong;
        // For honeycomb: row pitch in Z = stepX * √3/2 so diagonal gap equals the cell gap
        const hcStepZ = stepX * (Math.sqrt(3) / 2);
        const oX = ((offset.ox % stepX) + stepX) % stepX;
        const oZ = gridStyle === 'honeycomb'
            ? ((offset.oy % hcStepZ) + hcStepZ) % hcStepZ
            : ((offset.oy % stepZ) + stepZ) % stepZ;
        const oY = ((offset.oz % stepY) + stepY) % stepY;
        for (let cy = longH + oY - stepY; cy <= h + stepY; cy += stepY) {
            if (cy - longH < 0 || cy + longH > h)
                continue;
            if (gridStyle === 'honeycomb') {
                let row = 0;
                for (let cz = fpA + oZ - hcStepZ; cz <= w + hcStepZ; cz += hcStepZ, row++) {
                    const hcOff = row % 2 === 0 ? 0 : stepX / 2;
                    for (let cx = fpA + oX - stepX + hcOff; cx <= l + stepX; cx += stepX) {
                        if (xzOk(cx, cz, fpA, fpA))
                            positions.push({ x: cx, y: cy, z: cz });
                    }
                }
            }
            else {
                for (let cx = fpA + oX - stepX; cx <= l + stepX; cx += stepX) {
                    for (let cz = fpB + oZ - stepZ; cz <= w + stepZ; cz += stepZ) {
                        if (xzOk(cx, cz, fpA, fpB))
                            positions.push({ x: cx, y: cy, z: cz });
                    }
                }
            }
        }
    }
    else if (extDir === 'x') {
        // long=X. Cross-section is a circle (radius fpA) in the Y-Z plane.
        // Honeycomb in Y-Z: rows along Z, offset every other row in Z by stepZ/2,
        // row pitch in Y = stepZ * √3/2  (so diagonal wall-to-wall gap = cell gap).
        const hzXZ = fpA;
        const hxXZ = longH;
        const stepX = stepLong;
        const stepZ = stepFpA; // Z centre-to-centre
        const hcStepY = stepZ * (Math.sqrt(3) / 2); // honeycomb row pitch in Y
        const stepY = stepFpB; // grid row pitch in Y
        const oX = ((offset.oz % stepX) + stepX) % stepX;
        const oZ = ((offset.ox % stepZ) + stepZ) % stepZ;
        const oY_hc = ((offset.oy % hcStepY) + hcStepY) % hcStepY;
        const oY_grid = ((offset.oy % stepY) + stepY) % stepY;
        for (let cx = longH + oX - stepX; cx <= l + stepX; cx += stepX) {
            if (cx - longH < 0 || cx + longH > l)
                continue;
            if (gridStyle === 'honeycomb') {
                let row = 0;
                for (let cy = fpA + oY_hc - hcStepY; cy <= h + hcStepY; cy += hcStepY, row++) {
                    if (cy - fpA < 0 || cy + fpA > h)
                        continue;
                    const hcOff = row % 2 === 0 ? 0 : stepZ / 2;
                    for (let cz = fpA + oZ - stepZ + hcOff; cz <= w + stepZ; cz += stepZ) {
                        if (rectFootprintOk(cx, cz, hxXZ, hzXZ, poly))
                            positions.push({ x: cx, y: cy, z: cz });
                    }
                }
            }
            else {
                for (let cy = fpB + oY_grid - stepY; cy <= h + stepY; cy += stepY) {
                    if (cy - fpB < 0 || cy + fpB > h)
                        continue;
                    for (let cz = hzXZ + oZ - stepZ; cz <= w + stepZ; cz += stepZ) {
                        if (rectFootprintOk(cx, cz, hxXZ, hzXZ, poly))
                            positions.push({ x: cx, y: cy, z: cz });
                    }
                }
            }
        }
    }
    else {
        // extDir='y': long=Z. Cross-section is a circle (radius fpA) in the X-Y plane.
        // Honeycomb in X-Y: rows along X, offset every other row in X by stepX/2,
        // row pitch in Y = stepX * √3/2.
        const hxXZ = fpA;
        const hzXZ = longH;
        const stepZ = stepLong;
        const stepX = stepFpA; // X centre-to-centre
        const hcStepY = stepX * (Math.sqrt(3) / 2); // honeycomb row pitch in Y
        const stepY = stepFpB; // grid row pitch in Y
        const oX = ((offset.ox % stepX) + stepX) % stepX;
        const oZ = ((offset.oz % stepZ) + stepZ) % stepZ;
        const oY_hc = ((offset.oy % hcStepY) + hcStepY) % hcStepY;
        const oY_grid = ((offset.oy % stepY) + stepY) % stepY;
        for (let cz = longH + oZ - stepZ; cz <= w + stepZ; cz += stepZ) {
            if (cz - longH < 0 || cz + longH > w)
                continue;
            if (gridStyle === 'honeycomb') {
                let row = 0;
                for (let cy = fpA + oY_hc - hcStepY; cy <= h + hcStepY; cy += hcStepY, row++) {
                    if (cy - fpA < 0 || cy + fpA > h)
                        continue;
                    const hcOff = row % 2 === 0 ? 0 : stepX / 2;
                    for (let cx = fpA + oX - stepX + hcOff; cx <= l + stepX; cx += stepX) {
                        if (rectFootprintOk(cx, cz, hxXZ, hzXZ, poly))
                            positions.push({ x: cx, y: cy, z: cz });
                    }
                }
            }
            else {
                for (let cy = fpB + oY_grid - stepY; cy <= h + stepY; cy += stepY) {
                    if (cy - fpB < 0 || cy + fpB > h)
                        continue;
                    for (let cx = hxXZ + oX - stepX; cx <= l + stepX; cx += stepX) {
                        if (rectFootprintOk(cx, cz, hxXZ, hzXZ, poly))
                            positions.push({ x: cx, y: cy, z: cz });
                    }
                }
            }
        }
    }
    return positions;
}
function runAllCombinations(sp, cell, gridStyle, gridOffset = { ox: 0, oy: 0, oz: 0 }) {
    const results = [];
    const extrusionDirs = ['z', 'x', 'y'];
    const gridStyles = cell.type === 'round'
        ? gridStyle === 'honeycomb' ? ['honeycomb'] : ['grid', 'honeycomb']
        : ['grid'];
    const gap = cell.type === 'round' ? CELL_GAP_ROUND : CELL_GAP_PRISM;
    const stepA = (cell.type === 'round' ? cell.diam : cell.width) + gap;
    const stepB = (cell.type === 'round' ? cell.diam : cell.depth) + gap;
    const stepL = cell.height + LAYER_GAP;
    const isManual = gridOffset.ox !== 0 || gridOffset.oy !== 0 || gridOffset.oz !== 0;
    for (const extDir of extrusionDirs) {
        for (const gs of gridStyles) {
            let bestPositions = [];
            let bestOffset = { ...gridOffset };
            if (isManual) {
                bestPositions = pack3D(sp, cell, extDir, gs, gridOffset);
                bestOffset = { ...gridOffset };
            }
            else {
                // Auto-sweep 6³ = 216 offset combinations to find the best placement
                const S = 6;
                for (let si = 0; si < S; si++) {
                    for (let sj = 0; sj < S; sj++) {
                        for (let sk = 0; sk < S; sk++) {
                            const off = {
                                ox: (si / S) * stepA,
                                oy: (sj / S) * stepB,
                                oz: (sk / S) * stepL,
                            };
                            const pos = pack3D(sp, cell, extDir, gs, off);
                            if (pos.length > bestPositions.length) {
                                bestPositions = pos;
                                bestOffset = off;
                            }
                        }
                    }
                }
            }
            if (bestPositions.length === 0)
                continue;
            results.push({
                total: bestPositions.length,
                extrusionDir: extDir,
                gridStyle: gs,
                positions: bestPositions,
                polygon: getShapePolygon(sp),
                sp: { ...sp },
                cell: { ...cell },
                gridOffset: bestOffset,
            });
        }
    }
    results.sort((a, b) => b.total - a.total);
    return results;
}
// ─────────────────────────────────────────────────────────────────────────────
// THREE.JS SETUP
// ─────────────────────────────────────────────────────────────────────────────
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.shadowMap.enabled = true;
renderer.setClearColor(0xe8edf4, 1);
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-500, 500, 500, -500, -10000, 10000);
camera.position.set(600, 500, 700);
camera.lookAt(0, 0, 0);
// Lights
scene.add(new THREE.AmbientLight(0xffffff, 2.0));
const dl = new THREE.DirectionalLight(0xffffff, 1.4);
dl.position.set(200, 400, 300);
scene.add(dl);
const dl2 = new THREE.DirectionalLight(0xaaccff, 0.5);
dl2.position.set(-300, 100, -200);
scene.add(dl2);
scene.add(new THREE.AxesHelper(80));
// Resize
function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    const ortho = camera;
    const aspect = w / h;
    const half = ortho.right; // current half-size
    ortho.left = -half * aspect;
    ortho.right = half * aspect;
    ortho.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas);
resize();
// ─────────────────────────────────────────────────────────────────────────────
// ORBIT CONTROLS
// ─────────────────────────────────────────────────────────────────────────────
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = false; // damping causes continuous re-renders and flicker
controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.PAN,
};
controls.minDistance = 10;
controls.maxDistance = 8000;
function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}
animate();
// ─────────────────────────────────────────────────────────────────────────────
// SCENE MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────
let visMode = 'solid';
let currentResult = null;
let sceneObjects = [];
let bboxObject = null;
// Grid offset in mm (3D, applied to the active result)
let gridOffset = { ox: 0, oy: 0, oz: 0 };
function clearScene() {
    sceneObjects.forEach(o => scene.remove(o));
    sceneObjects = [];
}
function addObj(obj) {
    scene.add(obj);
    sceneObjects.push(obj);
}
function updateBoundingBox(_sp) {
    if (bboxObject) {
        scene.remove(bboxObject);
        bboxObject = null;
    }
    // Bounding box removed — housing shape mesh already shows the volume
}
// ─────────────────────────────────────────────────────────────────────────────
// SHAPE MESH
// ─────────────────────────────────────────────────────────────────────────────
// The housing shape is ALWAYS built from the original sp (l × w footprint, h tall),
// centered at world origin (X: -l/2..l/2, Y: 0..h, Z: -w/2..w/2).
// Only cells change orientation per extrusionDir — the housing never moves.
function buildShapeMesh(result) {
    const { sp } = result;
    const { l, w, h } = sp;
    // Always use the original footprint polygon (l × w) extruded to height h
    const origPolygon = getShapePolygon(sp);
    const pts = origPolygon.map(p => new THREE.Vector2(p.x - l / 2, p.y - w / 2));
    const shape = new THREE.Shape(pts);
    // Extrude upward (along local Z of Shape = world Y after rotation below)
    const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
    const mat = new THREE.MeshStandardMaterial({
        color: 0xadc8e0,
        transparent: true,
        opacity: visMode === 'skeleton' ? 0.04 : 0.22,
        side: THREE.DoubleSide,
        wireframe: visMode === 'wire',
        depthWrite: false, // housing is transparent — don't block cell depth writes
        polygonOffset: true,
        polygonOffsetFactor: 1, // push housing faces slightly back to avoid z-fighting
        polygonOffsetUnits: 1,
    });
    const mesh = new THREE.Mesh(geo, mat);
    const wf = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x5588aa, opacity: 0.55, transparent: true }));
    const grp = new THREE.Group();
    grp.add(mesh, wf);
    // ExtrudeGeometry extrudes along local +Z. Rotate so it extrudes along world +Y.
    grp.rotation.x = -Math.PI / 2;
    return grp;
}
// Builds a visible grid overlay: lines along all three axes through the cell grid.
// Shows the repeating cell pattern as thin lines so the user can see what
// the offset sliders are doing.
function buildGridLines(result) {
    const { cell, gridOffset, extrusionDir, sp } = result;
    const { l, w, h } = sp;
    const gap = cell.type === 'round' ? CELL_GAP_ROUND : CELL_GAP_PRISM;
    // Step sizes per world axis — depend on extrusion direction
    let stepX, stepY, stepZ;
    if (cell.type === 'round') {
        const d = cell.diam;
        if (extrusionDir === 'z') {
            stepX = d + gap;
            stepZ = d + gap;
            stepY = cell.height + LAYER_GAP;
        }
        else if (extrusionDir === 'x') {
            stepY = d + gap;
            stepZ = d + gap;
            stepX = cell.height + LAYER_GAP;
        }
        else {
            stepX = d + gap;
            stepY = d + gap;
            stepZ = cell.height + LAYER_GAP;
        }
    }
    else {
        const pc = cell;
        if (extrusionDir === 'z') {
            stepX = pc.width + gap;
            stepZ = pc.depth + gap;
            stepY = pc.height + LAYER_GAP;
        }
        else if (extrusionDir === 'x') {
            stepY = pc.width + gap;
            stepZ = pc.depth + gap;
            stepX = pc.height + LAYER_GAP;
        }
        else {
            stepX = pc.width + gap;
            stepY = pc.depth + gap;
            stepZ = pc.height + LAYER_GAP;
        }
    }
    const ox = ((gridOffset.ox % stepX) + stepX) % stepX;
    const oy = ((gridOffset.oy % stepY) + stepY) % stepY;
    const oz = ((gridOffset.oz % stepZ) + stepZ) % stepZ;
    const verts = [];
    // Housing world bounds: X ∈ [0..l], Y ∈ [0..h], Z ∈ [0..w]
    // Housing mesh is centered: X-l/2, Y as-is, Z → -(Z - w/2)
    // Grid lines in mesh-centred coords: X ∈ [-l/2..l/2], Y ∈ [0..h], Z ∈ [-w/2..w/2]
    // Lines along Y (vertical), varying X & Z
    for (let gx = ox - stepX; gx <= l + stepX; gx += stepX) {
        const wx = gx - l / 2;
        if (wx < -l / 2 || wx > l / 2)
            continue;
        for (let gz = oz - stepZ; gz <= w + stepZ; gz += stepZ) {
            const wz = -(gz - w / 2);
            if (wz < -w / 2 || wz > w / 2)
                continue;
            verts.push(wx, 0, wz, wx, h, wz);
        }
    }
    // Lines along X (horizontal in XZ-plane), varying Y & Z
    for (let gy = oy - stepY; gy <= h + stepY; gy += stepY) {
        if (gy < 0 || gy > h)
            continue;
        for (let gz = oz - stepZ; gz <= w + stepZ; gz += stepZ) {
            const wz = -(gz - w / 2);
            if (wz < -w / 2 || wz > w / 2)
                continue;
            verts.push(-l / 2, gy, wz, l / 2, gy, wz);
        }
    }
    if (verts.length === 0)
        return new THREE.Group();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
    const mat = new THREE.LineBasicMaterial({ color: 0xee8800, opacity: 0.55, transparent: true });
    const lines = new THREE.LineSegments(geo, mat);
    lines.frustumCulled = false;
    return lines;
}
// ─────────────────────────────────────────────────────────────────────────────
// DIMENSION LABELS
// ─────────────────────────────────────────────────────────────────────────────
function makeTextSprite(text, color = '#1a2430') {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 256, 64);
    ctx.font = 'bold 28px "JetBrains Mono", "Courier New", monospace';
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 32);
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
    const sprite = new THREE.Sprite(mat);
    sprite.renderOrder = 10;
    return sprite;
}
function makeDimLine(a, b, color) {
    const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
    const mat = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.75 });
    const line = new THREE.Line(geo, mat);
    line.renderOrder = 9;
    return line;
}
// Builds dimension annotations for the housing.
// Housing mesh world coords: X ∈ [-l/2..l/2], Y ∈ [0..h], Z ∈ [-w/2..w/2]
// Polygon space → world: wx = px - l/2,  wz = -(pz - w/2)
function buildDimensionLines(sp) {
    const { type, l, w, h, cut_l, cut_w, stem_w, bar_h, top_mm } = sp;
    const grp = new THREE.Group();
    const col = 0x0055aa;
    const col2 = 0x007755; // secondary dims (cutouts etc.)
    const ref = Math.max(l, w, h);
    const off = ref * 0.07 + 6; // perpendicular offset for dim line
    const sScale = ref * 0.11; // sprite scale
    // Convert polygon-space (px ∈ [0..l], pz ∈ [0..w]) to world XZ at given Y
    function pw(px, pz, y = 0) {
        return new THREE.Vector3(px - l / 2, y, -(pz - w / 2));
    }
    function addDim(p1, p2, extDir, label, color = col) {
        const o = extDir.clone().normalize().multiplyScalar(off);
        const a = p1.clone().add(o);
        const b = p2.clone().add(o);
        grp.add(makeDimLine(a, b, color));
        grp.add(makeDimLine(p1.clone(), a.clone(), color));
        grp.add(makeDimLine(p2.clone(), b.clone(), color));
        const mid = a.clone().lerp(b, 0.5).add(extDir.clone().normalize().multiplyScalar(sScale * 0.38));
        const sprite = makeTextSprite(label);
        sprite.position.copy(mid);
        sprite.scale.set(sScale, sScale * 0.25, 1);
        grp.add(sprite);
    }
    // Polygon space → world coordinate mapping:
    //   pw(px=0,  pz)  → worldX = -l/2  (left)
    //   pw(px=l,  pz)  → worldX = +l/2  (right)
    //   pw(px, pz=0)   → worldZ = +w/2  (front in world)
    //   pw(px, pz=w)   → worldZ = -w/2  (back in world)
    // "Away from bounding box" directions:
    const outFront = new THREE.Vector3(0, 0, 1); // pz=0 edge  → worldZ+
    const outBack = new THREE.Vector3(0, 0, -1); // pz=w edge  → worldZ-
    const outRight = new THREE.Vector3(1, 0, 0); // px=l edge  → worldX+
    const outLeft = new THREE.Vector3(-1, 0, 0); // px=0 edge  → worldX-
    // ── Always: L (X), W (Z), H (Y) ──────────────────────────────────────────
    // L: front edge (pz=0), offset outFront
    addDim(pw(0, 0), pw(l, 0), outFront, `L ${l}`);
    // W: right edge (px=l), offset outRight
    addDim(pw(l, 0), pw(l, w), outRight, `W ${w}`);
    // H: right-front vertical edge (px=l, pz=0), offset outRight
    addDim(pw(l, 0, 0), pw(l, 0, h), outRight, `H ${h}`);
    // ── Shape-specific secondary dims ────────────────────────────────────────
    if (type === 'l_shape') {
        // Notch is at top-right in polygon space: px ∈ [l-cut_l..l], pz ∈ [w-cut_w..w]
        // cut_l: along the inner horizontal step (pz = w-cut_w), offset outBack (away from notch)
        addDim(pw(l - cut_l, w - cut_w), pw(l, w - cut_w), outBack, `cut_l ${cut_l}`, col2);
        // cut_w: along the inner vertical step (px = l-cut_l), offset outLeft (into open space)
        addDim(pw(l - cut_l, w - cut_w), pw(l - cut_l, w), outLeft, `cut_w ${cut_w}`, col2);
    }
    else if (type === 'u_shape') {
        // Notch opens at pz=0 side (front in polygon = world front)
        // cut_l: inner span of notch bottom (pz=cut_w), offset outBack
        addDim(pw(cut_l, cut_w), pw(l - cut_l, cut_w), outBack, `cut_l ${cut_l}`, col2);
        // cut_w: left outer wall height (px=0), offset outLeft
        addDim(pw(0, 0), pw(0, cut_w), outLeft, `cut_w ${cut_w}`, col2);
    }
    else if (type === 't_shape') {
        const cx = (l - stem_w) / 2;
        // stem_w: along the bar/stem boundary (pz=bar_h), offset outBack
        addDim(pw(cx, bar_h), pw(cx + stem_w, bar_h), outBack, `stem_w ${stem_w}`, col2);
        // bar_h: right edge of bar (px=l), offset outRight
        addDim(pw(l, 0), pw(l, bar_h), outRight, `bar_h ${bar_h}`, col2);
    }
    else if (type === 'triangle') {
        // Hypotenuse floating label
        const hyp = Math.round(Math.sqrt(l * l + w * w));
        const mid = pw(l / 2, w / 2);
        mid.x += off * 0.8;
        mid.z -= off * 0.4;
        const sprite = makeTextSprite(`↗ ${hyp}`, '#007755');
        sprite.position.copy(mid);
        sprite.scale.set(sScale, sScale * 0.25, 1);
        grp.add(sprite);
    }
    else if (type === 'trapeze') {
        const edgeOff = (l - top_mm) / 2;
        // top edge (pz=w = worldZ back), offset outBack
        addDim(pw(edgeOff, w), pw(l - edgeOff, w), outBack, `top ${top_mm}`, col2);
    }
    return grp;
}
// ─────────────────────────────────────────────────────────────────────────────
// VISUALIZE RESULT
// ─────────────────────────────────────────────────────────────────────────────
const CELL_COLORS = [0x0077cc, 0x00aa77, 0xdd6600, 0x9933cc];
function makeCellGeo(cell, extDir) {
    // Geometry is always built with the long axis along Y (Three.js CylinderGeometry default).
    // Rotation to the correct world axis is applied via instanceQuat below.
    const h = cell.height;
    if (cell.type === 'round') {
        return new THREE.CylinderGeometry(cell.diam / 2, cell.diam / 2, h, 16);
    }
    // prismatic: width × depth cross-section, height is long axis
    // extDir=z → stands along Y: X=width, Z=depth
    // extDir=x → lies along X (rotated later): X=width, Z=depth
    // extDir=y → lies along Z (rotated later): X=width, Z=depth
    void extDir;
    return new THREE.BoxGeometry(cell.width, h, cell.depth);
}
function visualizeResult(result, keepCamera = false) {
    clearScene();
    currentResult = result;
    const { cell, extrusionDir, sp, positions, gridOffset } = result;
    const { l, w, h } = sp;
    updateBoundingBox(sp);
    addObj(buildShapeMesh(result));
    addObj(buildGridLines(result));
    addObj(buildDimensionLines(result.sp));
    // Cell geometry: long axis along Y, rotated per extrusionDir
    const cellGeo = makeCellGeo(cell, extrusionDir);
    // Rotation quaternion: pack3D returns world-space positions with cell long axis along:
    //   extDir=z → world Y  (no rotation needed)
    //   extDir=x → world X  (rotate 90° around Z)
    //   extDir=y → world Z  (rotate 90° around X)
    const instanceQuat = new THREE.Quaternion();
    if (extrusionDir === 'x') {
        instanceQuat.setFromEuler(new THREE.Euler(0, 0, Math.PI / 2));
    }
    else if (extrusionDir === 'y') {
        instanceQuat.setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));
    }
    // pack3D returns world coords: X ∈ [0..l], Y ∈ [0..h], Z ∈ [0..w]
    // Housing mesh is centred: X → X-l/2, Y stays, Z → -(Z-w/2)
    const totalCount = positions.length;
    // Assign a colour per "layer" — group cells by their stack-axis coordinate
    // so visually distinct layers get different colours.
    const stackCoords = new Map();
    for (const p of positions) {
        const key = extrusionDir === 'z' ? p.y
            : extrusionDir === 'x' ? p.x
                : p.z;
        const rounded = Math.round(key * 10) / 10;
        if (!stackCoords.has(rounded))
            stackCoords.set(rounded, stackCoords.size);
    }
    const cellColor = new THREE.Color();
    // Build one merged BufferGeometry with all cell vertices baked into world coordinates.
    const srcGeo = visMode === 'skeleton' ? new THREE.EdgesGeometry(cellGeo) : cellGeo;
    const srcPos = srcGeo.getAttribute('position');
    const srcIdx = srcGeo.index;
    const vertsPerCell = srcPos.count;
    const trisPerCell = srcIdx ? srcIdx.count : vertsPerCell;
    const allPos = new Float32Array(totalCount * vertsPerCell * 3);
    const allColors = new Float32Array(totalCount * vertsPerCell * 3);
    const allIdx = srcIdx ? new Uint32Array(totalCount * trisPerCell) : null;
    const tmpVec = new THREE.Vector3();
    let vOffset = 0;
    let iOffset = 0;
    for (const p of positions) {
        // Convert pack3D world coords → mesh-centred world coords
        const worldPos = new THREE.Vector3(p.x - l / 2, p.y, -(p.z - w / 2));
        const stackKey = extrusionDir === 'z' ? Math.round(p.y * 10) / 10
            : extrusionDir === 'x' ? Math.round(p.x * 10) / 10
                : Math.round(p.z * 10) / 10;
        const layerIdx = stackCoords.get(stackKey) ?? 0;
        cellColor.set(CELL_COLORS[layerIdx % CELL_COLORS.length]);
        const baseVert = vOffset / 3;
        for (let v = 0; v < vertsPerCell; v++) {
            tmpVec.set(srcPos.getX(v), srcPos.getY(v), srcPos.getZ(v));
            tmpVec.applyQuaternion(instanceQuat).add(worldPos);
            allPos[vOffset] = tmpVec.x;
            allPos[vOffset + 1] = tmpVec.y;
            allPos[vOffset + 2] = tmpVec.z;
            allColors[vOffset] = cellColor.r;
            allColors[vOffset + 1] = cellColor.g;
            allColors[vOffset + 2] = cellColor.b;
            vOffset += 3;
        }
        if (allIdx && srcIdx) {
            for (let i = 0; i < trisPerCell; i++) {
                allIdx[iOffset++] = baseVert + srcIdx.getX(i);
            }
        }
    }
    const mergedGeo = new THREE.BufferGeometry();
    mergedGeo.setAttribute('position', new THREE.BufferAttribute(allPos, 3));
    mergedGeo.setAttribute('color', new THREE.BufferAttribute(allColors, 3));
    if (allIdx)
        mergedGeo.setIndex(new THREE.BufferAttribute(allIdx, 1));
    let obj;
    if (visMode === 'skeleton') {
        obj = new THREE.LineSegments(mergedGeo, new THREE.LineBasicMaterial({ vertexColors: true }));
    }
    else if (visMode === 'wire') {
        obj = new THREE.Mesh(mergedGeo, new THREE.MeshStandardMaterial({ wireframe: true, vertexColors: true }));
    }
    else {
        obj = new THREE.Mesh(mergedGeo, new THREE.MeshStandardMaterial({
            metalness: cell.type === 'round' ? 0.7 : 0.5,
            roughness: cell.type === 'round' ? 0.3 : 0.4,
            vertexColors: true,
        }));
    }
    obj.frustumCulled = false;
    obj.renderOrder = 1;
    addObj(obj);
    updateCountUI(totalCount, stackCoords.size, result);
    show('overlay');
    show('visControls');
    // suppress unused
    void gridOffset;
    if (!keepCamera) {
        const size = Math.max(l, w, h);
        controls.target.set(0, h / 2, 0);
        // Isometric-style position: equal angle on all three axes
        camera.position.set(size * 1.2 + 0, h / 2 + size * 1.0, size * 1.2);
        // Fit the housing into view via orthographic frustum half-size
        const ortho = camera;
        const half = size * 1.4;
        const aspect = canvas.clientWidth / canvas.clientHeight;
        ortho.left = -half * aspect;
        ortho.right = half * aspect;
        ortho.top = half;
        ortho.bottom = -half;
        ortho.updateProjectionMatrix();
        controls.update();
    }
}
// Updates every count-related UI element from the same values.
function updateCountUI(total, layers, result) {
    const perLayer = layers > 0 ? Math.round(total / layers) : 0;
    // 3D overlay
    el('ov_total').textContent = String(total);
    el('ov_grid').textContent = String(perLayer);
    el('ov_layers').textContent = String(layers);
    el('ov_orient').textContent =
        `${DIR_LABELS[result.extrusionDir]} · ${GS_LABELS[result.gridStyle]}`;
    // Header above the result list (shows the active result, not necessarily the best)
    el('bestCount').textContent = `${total} Zellen`;
    el('bestDesc').textContent =
        `${perLayer} × ${layers} Ebenen · ${result.extrusionDir.toUpperCase()}-Richtung`;
    // Update the active row in the list in-place (no full re-render)
    const activeRow = el('resultList').querySelector('.result-row.active');
    if (activeRow) {
        const countEl = activeRow.querySelector('.count');
        const subEl = activeRow.querySelector('span[style]');
        if (countEl)
            countEl.textContent = String(total);
        if (subEl)
            subEl.textContent = `${perLayer}×${layers}`;
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// UI HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function el(id) {
    return document.getElementById(id);
}
function val(id) {
    return parseFloat(document.getElementById(id).value);
}
function selVal(id) {
    return document.getElementById(id).value;
}
function show(id) { el(id).style.display = ''; }
function hide(id) { el(id).style.display = 'none'; }
// ─────────────────────────────────────────────────────────────────────────────
// UI STATE
// ─────────────────────────────────────────────────────────────────────────────
function onShapeChange() {
    const t = selVal('shapeType');
    el('extra_cut').style.display = (t === 'l_shape' || t === 'u_shape') ? '' : 'none';
    el('extra_t').style.display = t === 't_shape' ? '' : 'none';
    el('extra_trap').style.display = t === 'trapeze' ? '' : 'none';
}
function onCellTypeChange() {
    const t = selVal('cellType');
    el('round_dims').style.display = t === 'round' ? '' : 'none';
    el('prism_dims').style.display = t === 'prismatic' ? '' : 'none';
    el('grid_opts_round').style.display = t === 'round' ? '' : 'none';
}
function setPreset(key) {
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.toggle('active', b.dataset.preset === key));
    if (key === 'custom')
        return;
    const p = CELL_PRESETS[key];
    if (!p)
        return;
    document.getElementById('cellType').value = p.type;
    onCellTypeChange();
    if (p.type === 'round') {
        ;
        document.getElementById('cell_diam').value = String(p.diam);
        document.getElementById('cell_h_round').value = String(p.height);
    }
    else {
        ;
        document.getElementById('cell_w').value = String(p.width);
        document.getElementById('cell_d').value = String(p.depth);
        document.getElementById('cell_h_prism').value = String(p.height);
    }
}
function getShapeParams() {
    return {
        type: selVal('shapeType'),
        l: val('dim_l'),
        w: val('dim_w'),
        h: val('dim_h'),
        cut_l: val('dim_cut_l'),
        cut_w: val('dim_cut_w'),
        stem_w: val('dim_stem_w'),
        bar_h: val('dim_bar_h'),
        top_mm: val('dim_top_mm'),
    };
}
function getCellParams() {
    const t = selVal('cellType');
    if (t === 'round') {
        return { type: 'round', diam: val('cell_diam'), height: val('cell_h_round') };
    }
    return { type: 'prismatic', width: val('cell_w'), depth: val('cell_d'), height: val('cell_h_prism') };
}
// ─────────────────────────────────────────────────────────────────────────────
// RESULTS UI
// ─────────────────────────────────────────────────────────────────────────────
let allResults = [];
let activeResultIdx = 0;
// Renders the result list and wires click handlers. Does NOT touch the 3D scene.
function renderResultList(results, activeIdx = 0) {
    if (results.length === 0) {
        el('bestCount').textContent = '0';
        el('bestDesc').textContent = 'Keine Zellen passen in den Bauraum.';
        el('resultList').innerHTML = '';
        return;
    }
    el('resultList').innerHTML = results.slice(0, 20).map((r, i) => `
    <div class="result-row${i === activeIdx ? ' active' : ''}" data-idx="${i}">
      <div>
        <span class="count">${r.total}</span>
      </div>
      <div class="desc">${DIR_LABELS_SHORT[r.extrusionDir]} · ${GS_LABELS[r.gridStyle]}</div>
    </div>
  `).join('');
    el('resultList').querySelectorAll('.result-row').forEach(row => {
        row.addEventListener('click', () => {
            const idx = parseInt(row.dataset.idx ?? '0');
            selectResult(idx);
        });
    });
}
function showResults(results) {
    show('resultsPanel');
    activeResultIdx = 0;
    renderResultList(results, 0);
    if (results.length > 0)
        selectResult(0);
}
function selectResult(idx) {
    activeResultIdx = idx;
    el('resultList').querySelectorAll('.result-row').forEach((r, i) => r.classList.toggle('active', i === idx));
    const r = allResults[idx];
    // Sync global offset + sliders to this result's stored optimal offset
    gridOffset = { ...r.gridOffset };
    syncOffsetSliders(r);
    visualizeResult(r);
}
function syncOffsetSliders(r) {
    const c = r.cell;
    const gap = c.type === 'round' ? CELL_GAP_ROUND : CELL_GAP_PRISM;
    const stepX = (c.type === 'round' ? c.diam : c.width) + gap;
    const stepY = (c.type === 'round' ? c.diam : c.depth) + gap;
    const stepZ = c.height + LAYER_GAP;
    el('gridOffX').max = String(stepX);
    el('gridOffY').max = String(stepY);
    el('gridOffZ').max = String(stepZ);
    el('gridOffX').value = String(r.gridOffset.ox);
    el('gridOffY').value = String(r.gridOffset.oy);
    el('gridOffZ').value = String(r.gridOffset.oz);
    el('gridOffXVal').textContent = r.gridOffset.ox.toFixed(1);
    el('gridOffYVal').textContent = r.gridOffset.oy.toFixed(1);
    el('gridOffZVal').textContent = r.gridOffset.oz.toFixed(1);
}
// Re-packs only the active result with the current offset/params and re-renders it.
// All other results in allResults stay untouched.
function liveRefresh() {
    if (allResults.length === 0)
        return;
    getPackingParams();
    const ref = allResults[activeResultIdx];
    const newPositions = pack3D(ref.sp, ref.cell, ref.extrusionDir, ref.gridStyle, gridOffset);
    // Update only the active entry in-place
    allResults[activeResultIdx] = {
        ...ref,
        positions: newPositions,
        total: newPositions.length,
        gridOffset: { ...gridOffset },
    };
    // Re-render list row count for the active result only
    const activeRow = el('resultList').querySelector(`.result-row[data-idx="${activeResultIdx}"]`);
    if (activeRow) {
        const countEl = activeRow.querySelector('.count');
        if (countEl)
            countEl.textContent = String(newPositions.length);
    }
    visualizeResult(allResults[activeResultIdx], true);
}
// ─────────────────────────────────────────────────────────────────────────────
// OPTIMIZER RUNNER
// ─────────────────────────────────────────────────────────────────────────────
function runOptimizer() {
    const sp = getShapeParams();
    const cell = getCellParams();
    const gridStyle = selVal('gridType');
    el('runBtn').disabled = true;
    show('progress');
    el('prog_text').textContent = 'Berechnung läuft…';
    el('prog_sub').textContent = 'Prüfe alle Kombinationen…';
    hide('resultsPanel');
    // Defer to next tick so the browser can repaint first
    setTimeout(() => {
        try {
            getPackingParams();
            gridOffset = { ox: 0, oy: 0, oz: 0 };
            allResults = runAllCombinations(sp, cell, gridStyle, gridOffset);
            showResults(allResults);
            if (allResults.length > 0)
                resetOffsetSliders(allResults[0]);
        }
        catch (e) {
            el('prog_text').textContent = 'Fehler: ' + e.message;
        }
        ;
        el('runBtn').disabled = false;
        hide('progress');
    }, 20);
}
// ─────────────────────────────────────────────────────────────────────────────
// VIS MODE
// ─────────────────────────────────────────────────────────────────────────────
function setVis(mode) {
    visMode = mode;
    ['Solid', 'Wire', 'Skeleton'].forEach(m => el('btn' + m).classList.toggle('active', m.toLowerCase() === mode));
    if (currentResult)
        visualizeResult(currentResult, true);
}
// ─────────────────────────────────────────────────────────────────────────────
// GRID OFFSET
// ─────────────────────────────────────────────────────────────────────────────
function resetOffsetSliders(result) {
    syncOffsetSliders(result);
    show('offsetCard');
}
function onOffsetChange() {
    if (!currentResult)
        return;
    gridOffset = {
        ox: parseFloat(el('gridOffX').value),
        oy: parseFloat(el('gridOffY').value),
        oz: parseFloat(el('gridOffZ').value),
    };
    el('gridOffXVal').textContent = gridOffset.ox.toFixed(1);
    el('gridOffYVal').textContent = gridOffset.oy.toFixed(1);
    el('gridOffZVal').textContent = gridOffset.oz.toFixed(1);
    liveRefresh();
}
// ─────────────────────────────────────────────────────────────────────────────
// WIRE UP EVENT LISTENERS
// ─────────────────────────────────────────────────────────────────────────────
document.getElementById('shapeType').addEventListener('change', onShapeChange);
document.getElementById('cellType').addEventListener('change', onCellTypeChange);
document.getElementById('runBtn').addEventListener('click', runOptimizer);
document.getElementById('btnSolid').addEventListener('click', () => setVis('solid'));
document.getElementById('btnWire').addEventListener('click', () => setVis('wire'));
document.getElementById('btnSkeleton').addEventListener('click', () => setVis('skeleton'));
document.getElementById('gridOffX').addEventListener('input', onOffsetChange);
document.getElementById('gridOffY').addEventListener('input', onOffsetChange);
document.getElementById('gridOffZ').addEventListener('input', onOffsetChange);
['paramMargin', 'paramGapRound', 'paramGapPrism', 'paramLayerGap'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => { if (allResults.length)
        liveRefresh(); });
});
document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => setPreset(btn.dataset.preset ?? ''));
});
// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────
onShapeChange();
setPreset('18650');
