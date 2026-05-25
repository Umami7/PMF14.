# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Start Vite dev server with hot reload
npm run build     # TypeScript compile + production bundle (tsc && vite build)
npm run preview   # Preview production build locally
```

No test runner or linter is configured.

## Architecture

**Battery Pack Optimizer** — a browser-only, single-page app (German UI) that calculates how many battery cells fit inside a user-defined housing shape, then renders the result in 3D.

### Tech stack
- **TypeScript** (strict) + **Vite** — no backend, all computation runs in the browser
- **Three.js** — 3D visualization of the housing and cells

### Almost all logic lives in [src/main.ts](src/main.ts)

The file is structured in three logical layers:

1. **Geometry** — functions that produce a 2D polygon (`Point[]`) for each housing shape (`rectangle`, `l_shape`, `u_shape`, `t_shape`, `triangle`, `trapeze`). Shapes are defined in millimeters.

2. **Packing algorithm** — exhaustively tries every combination of:
   - Extrusion direction (`z` / `x` / `y`) — which axis the cells stand along
   - Grid angle (0° / 90°)
   - Grid style (`grid` rectangular | `honeycomb` offset)
   
   Each candidate grid is tested via point-in-polygon ray casting against the 2D housing polygon. Results (`PackingResult[]`) are ranked by total cell count.

3. **Three.js visualization** — extrudes the 2D polygon into a 3D housing with `THREE.ExtrudeGeometry`, then places instanced cell meshes. Supports Solid / Wireframe / Skeleton view modes and orbit controls.

### Key constants (all in mm)
| Constant | Value | Meaning |
|---|---|---|
| `BOUNDARY_MARGIN` | 5 | Clearance from housing edge |
| `CELL_GAP_ROUND` | 5 | Gap between round cells |
| `CELL_GAP_PRISM` | 1 | Gap between prismatic cells |

### Cell types
- **Round**: 18650 (Ø18.6 mm, H65 mm) or 21700 (Ø21.6 mm, H70 mm)
- **Prismatic**: BYD50 (71.5×27×96 mm) or EVE50 (71.5×27×96 mm)

### Entry point
[index.html](index.html) wires up the sidebar controls (shape params, cell type, extrusion axis) and the canvas. [src/main.ts](src/main.ts) attaches all event listeners and owns the Three.js scene.

[src/counter.ts](src/counter.ts) is unused Vite scaffolding.
