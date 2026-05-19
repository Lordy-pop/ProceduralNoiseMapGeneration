# Nebula Forge — Technical Documentation

A single-file WebGL2 tool that procedurally generates seamless 360° equirectangular star/nebula/galaxy skyboxes and exports them as Radiance RGBE `.hdr` files for direct drag-in to Unity as HDR cubemaps.

**File:** `index.html` (~2300 lines, no dependencies). Tailwind via CDN, vanilla JS, WebGL2 only.

---

## 1. Constraints and external requirements

- **WebGL2 context** with `EXT_color_buffer_float` extension. Hard-fails visibly if either is missing — required for float-precision HDR rendering.
- **No bundler, no Node, no Three.js.** Single HTML file is the entire app.
- **Tailwind** loaded via CDN, configured inline.
- **Fonts:** Inter (UI) + JetBrains Mono (numeric / mono) from Google Fonts.

---

## 2. High-level data flow

```
┌──────────────────────┐      ┌─────────────────────────┐      ┌─────────────────────┐
│  state.layers[]      │─────▶│  buildFragmentShader()  │─────▶│  rebuildProgram()   │
│  (JS source of truth)│      │  (string concatenation) │      │  compile + link     │
└──────────────────────┘      └─────────────────────────┘      └─────────────────────┘
         ▲                                                              │
         │ slider/text events                                           ▼
         │                                                  ┌─────────────────────┐
         └──────────────────────── setUniforms()  ◀─────────│  uniformLocs map    │
                                       │                   └─────────────────────┘
                                       ▼
                              ┌────────────────────┐         ┌────────────────────┐
                              │  renderPreview()   │         │  exportHDR()       │
                              │  → canvas (tonemap)│         │  → float FBO       │
                              └────────────────────┘         │  → readPixels      │
                                                             │  → RGBE encode     │
                                                             │  → blob download   │
                                                             └────────────────────┘
```

The fragment shader is **rebuilt on every structural change** (add/remove/reorder layer, change `type`/`blendMode`/`warpType`/`contentMode`, change detail sub-layer count or type). Slider changes only update uniforms — no recompile.

---

## 3. State model

```js
state = {
  uSeed: int,
  viewMode: 'equirect' | 'perspective',
  yaw, pitch, fovDeg: number,
  layers: Layer[],
  hiResPreview: boolean,
}
```

### 3.1 Layer kinds — three flavors share the array

```js
Layer = NebulaLayer | StarsLayer | GalaxyLayer
```

**Common fields (every layer):**
- `id, kind, name, enabled, collapsed, blendMode, opacity, layerSeed`
- `kind` ∈ `'nebula' | 'stars' | 'galaxy'`
- `blendMode` ∈ `'add' | 'multiply' | 'overlay' | 'mix' | 'darken' | 'lighten'`

### 3.2 NebulaLayer

```js
{
  kind: 'nebula',
  // Base noise
  type: 'simplex' | 'fbm' | 'voronoi' | 'ridged',
  scale, octaves, falloff, density: number,
  // Single domain warp (sweeping flow on base sample)
  warpType, warpScale, warpOctaves, warpStrength,
  // Detail sub-layers — masked detail, absolute scale (NOT relative to base)
  detailLayers: [{ id, type, scale, octaves, strength }, ...],   // up to 4
  // Palette / harmony
  baseHue, harmony, saturation, lightness,
  palette: [hex, hex, hex, hex],   // 4 stops, can be individually edited
  paletteCount: 1..4,
}
```

### 3.3 StarsLayer

```js
{
  kind: 'stars',
  starDensity, starBrightness,
  dustSize, heroSize,    // radii for the two star layers
  starColor: hex,
}
```

### 3.4 GalaxyLayer

```js
{
  kind: 'galaxy',
  // Orientation (degrees in UI, deg→rad in setUniforms)
  yawDeg, pitchDeg, tiltDeg, rollDeg,
  // Disk
  diskRadius, diskFalloff, edgeNoise, diskBrightness,
  // Two-tone bulge
  bulgeCoreColor, bulgeCoronaColor,
  bulgeCoreSize, bulgeSize, bulgeFalloff, bulgeBrightness,
  // Spiral arms
  armCount: 1..6, armPitch, armContrast, armStrength, armTwist,
  // Content mode
  contentMode: 'bundled' | 'mask',
  // Bundled-only (only used when contentMode === 'bundled')
  nebulaScale, nebulaOctaves, nebulaStrength,
  baseHue, harmony, saturation, lightness, palette, paletteCount,
  starDensity, starBrightness, dustSize, heroSize, starColor,
}
```

### 3.5 Constants

```js
MAX_LAYERS = 8
MAX_PALETTE = 4    // palette stops per layer
MAX_DETAIL = 4     // detail sub-layers per nebula
```

---

## 4. Dynamic shader compilation

`buildFragmentShader(layers)` returns a complete `#version 300 es` GLSL source. Structure:

```glsl
1. precision + uniforms (globals: uSeed, uTonemap, uViewMode, uYaw, uPitch, uFovTan, uAspect)
2. GLSL_LIBRARY constant string (noise + palette + blend helpers)
3. Per-layer uniforms (uScale_0, uOctaves_0, ..., uScale_1, ...)
4. main():
   a. dir computation (equirect or perspective branch)
   b. vec3 finalColor = vec3(0.0);
   c. float galaxyMask = 1.0;    // running mask from mask-mode galaxies
   d. Per-layer code blocks (emit{Nebula,Stars,Galaxy}Layer)
   e. tonemap branch (ACES + gamma if uTonemap)
   f. outColor = vec4(finalColor, 1.0);
```

### 4.1 Per-layer emit functions

Each takes `(layer, i, isFirstContrib)` and returns a GLSL `{...}` scoped block. `i` is the position in the layer array (becomes the uniform suffix).

- **`emitNebulaLayer`** — base noise sample → falloff/density → mask-gated detail accumulation → palette lookup → blend.
- **`emitStarsLayer`** — two `starLayer()` calls (dust + hero) with per-cell brightness variance → blend.
- **`emitGalaxyLayer`** — disk basis from angles → tangent-plane projection → spiral arm mask → two-tone bulge → (if bundled) internal nebula + stars → blend. Mask-mode emits `galaxyMask = densityMask;` at end of block.

### 4.2 Mask plumbing

`galaxyMask` is hoisted at the top of `main()`. Every layer's color is multiplied by it before blending (variable suffix `M`: `lyrColM`, `sColM`, `galaxyColorM`). Mask-mode galaxies replace `galaxyMask` with their `densityMask` at end of their block. Bundled-mode galaxies don't touch it.

This means stacking `[Stars][Galaxy mask][Nebula]` → nebula appears only inside the galaxy's spiral. Stars stay outside it (they came first).

### 4.3 First-contributing layer

To avoid Multiply/Overlay against `vec3(0)` locking output black, the first enabled layer is **always** emitted with `=` (Add semantics) regardless of its `blendMode`. Tracked via `isFirstContrib` flag while iterating layers.

### 4.4 Structural triggers (rebuild required)

- Add / remove / reorder layer
- Toggle layer `enabled` (omitted layers don't emit code)
- Change `type` (nebula base or detail sub-layer)
- Change `blendMode`
- Change `warpType`
- Change galaxy `contentMode`
- Add / remove detail sub-layer

Slider changes never trigger rebuild.

### 4.5 Uniform location cache

`rebuildProgram()` resolves every uniform location into `uniformLocs[name]` after `linkProgram`. Names follow `${baseName}_${layerIdx}_${subIdx?}` convention. Unused uniforms (e.g. bundled palette uniforms when a galaxy is in mask mode) resolve to `null` — `gl.uniform*(null, ...)` is a silent no-op.

---

## 5. Shader math reference

### 5.1 Equirect projection (default view)

```glsl
float theta = (vUV.x - 0.5) * TAU;     // longitude  −π..π
float phi   = (vUV.y - 0.5) * PI;      // latitude   −π/2..π/2
vec3 dir = vec3(cos(phi) * cos(theta), sin(phi), cos(phi) * sin(theta));
```

`u=0` and `u=1` produce the same `dir` → guarantees seamless horizontal wrap.

### 5.2 Perspective view

Forward = `+X`, up = `+Y`, right = `+Z`. NDC → ray → pitch (Z-rotation) → yaw (Y-rotation). Drag-right maps to `yaw += dx * sens` (look-right). FOV sensitivity scales drag for consistent feel at all zooms.

### 5.3 Noise library (all in `GLSL_LIBRARY`)

| Function | Purpose |
|---|---|
| `snoise(vec3)` | Ashima / Gustavson 3D simplex, returns ~[−1, 1] |
| `voronoi3(vec3)` | F1 distance to nearest jittered cell point |
| `hash13(vec3)`, `hash33(vec3)` | Cheap deterministic pseudo-random |
| `fbm_simplex(p, oct)` | Multi-octave simplex (8 octaves max) |
| `fbm_voronoi(p, oct)` | Multi-octave (0.5 − voronoi) — cellular |
| `fbm_ridged(p, oct)` | Multi-octave (1 − \|snoise\|) − offset — ridged multifractal |
| `starLayer(dir, cellScale, density, radius, sharpness, seed)` | Voronoi-style point features (3×3×3 neighborhood lookup) |
| `palette4(t, c0..c3, count)` | 1–4 stop palette interpolation |
| `blendOverlay(base, top)` | Photoshop-style overlay blend |
| `acesFilm(x)` | Narkowicz ACES tonemap (preview only) |

`octaves` is always passed as a runtime `int` uniform — the loop has `if (i >= oct) break;` so changing octaves doesn't require recompile.

### 5.4 Nebula layer pipeline

```glsl
// 1. Base sample point
vec3 baseP = dir * uScale + sOfs;

// 2. Single domain warp (samples at ABSOLUTE warpScale, not relative to baseScale)
vec3 wp = dir * uWarpScale + sOfs;
vec3 warp = vec3(
  warpFn(wp,                       uWarpOct),
  warpFn(wp + vec3(5.2, 1.3, 2.1), uWarpOct),
  warpFn(wp + vec3(3.7, 4.4, 6.8), uWarpOct)
) * uWarpStrength;

// 3. Base noise → "big patches" mask source
float n = base_fn(baseP + warp, uOctaves);
float shaped = pow(max(n * 0.5 + 0.5, 0.0), uFalloff) * uDensity;

// 4. Detail sub-layers — absolute scale, mask-gated, mask updates after each
//    This is the key: detail only appears where the base nebula already exists.
for each detail j:
  vec3 dp = dir * uDetailScale_j + sOfs;
  float d = detail_fn(dp, uDetailOct_j);
  float mask = clamp(shaped, 0.0, 1.0);
  shaped = max(shaped + d * uDetailStrength_j * mask, 0.0);

// 5. Palette + galaxy mask + blend
float t = clamp(shaped, 0.0, 1.0);
vec3 lyrCol = palette4(t, ...) * shaped;
vec3 lyrColM = lyrCol * galaxyMask;
${blendExpr};
```

The detail sub-layers' absolute scale + mask gating is the critical design. Earlier versions had detail relative to base scale (broken) — see Section 11 for the bug history.

### 5.5 Galaxy disk projection

The galaxy is positioned by 4 angles: `yawDeg`, `pitchDeg`, `tiltDeg`, `rollDeg`. Tilt = 0 face-on, 89° edge-on.

**Basis construction:**

```glsl
vec3 gC = vec3(cos(pitch)*cos(yaw), sin(pitch), cos(pitch)*sin(yaw));   // center
vec3 wUp = abs(gC.y) > 0.9 ? vec3(1,0,0) : vec3(0,1,0);                 // pole-safe
vec3 dE = normalize(cross(wUp, gC));
vec3 dN = cross(gC, dE);

// Roll rotates (dE, dN) in the tangent plane at gC
vec3 dU  =  dE * cos(roll) + dN * sin(roll);
vec3 dV0 = -dE * sin(roll) + dN * cos(roll);

float ct = cos(tilt);
float ctSafe = max(abs(ct), 0.02);    // edge-on guard
```

**Tangent-plane projection with foreshortening:**

```glsl
float u_loc = dot(dir, dU);
float v_loc = dot(dir, dV0) / ctSafe;
float r_loc = sqrt(u_loc*u_loc + v_loc*v_loc);
float theta = atan(v_loc, u_loc);
```

Both `dU` and `dV0` are perpendicular to `gC` by construction, so `(u_loc, v_loc)` is well-defined at every tilt. The `/ ctSafe` foreshortens the V axis — face-on gives a circle, edge-on a thin great-circle strip.

**Noise-modulated disk edge:**

```glsl
float edgeN = fbm_simplex(vec3(u_loc*4.0, v_loc*4.0, layerSeed*0.3), 3);
float effRadius = diskRadius * (1.0 + edgeN * uEdgeNoise);
float diskMask = pow(1.0 - smoothstep(effRadius*0.55, effRadius, r_loc), diskFalloff);
diskMask *= smoothstep(0.0, 0.05, dot(dir, gC));   // fade out back side
```

**Spiral arms (logarithmic):**

```glsl
float twist = snoise(vec3(u*2, v*2, seed*0.1)) * uArmTwist;
float armPhase = theta * uArmCount - uArmPitch * log(max(r_loc, 0.001) * 8.0) + twist;
float armSignal = sin(armPhase) * 0.5 + 0.5;
float armMask = pow(armSignal, uArmContrast);
armMask = mix(0.15, 1.0, armMask);          // interarm baseline
armMask = mix(1.0, armMask, uArmStrength);  // 0 → uniform disk (sun mode)

float densityMask = diskMask * armMask;
```

**Two-tone bulge:**

```glsl
float bR = r_loc / diskRadius;
float coreT = smoothstep(0.0, bulgeCoreSize, bR);
vec3 tone = mix(bulgeCoreColor, bulgeCoronaColor, coreT);
float falloff = 1.0 / (1.0 + pow(bR / bulgeSize, bulgeFalloff));
vec3 bulge = tone * bulgeBrightness * falloff;
```

Setting `armStrength = 0`, `diskBrightness = 0`, and increasing `bulgeBrightness` collapses the galaxy into a "sun" — same layer kind, different parameters. The `+ Sun` button just spawns this preset.

### 5.6 Color harmony (JS)

`derivePaletteRGB(layer)` generates 1–4 RGB stops from `(baseHue, saturation, lightness, harmony)`. Modes: `single`, `mono` (3 brightness steps), `analogous` (±30°), `complementary` (+180°), `splitcomp` (+150°/+210°), `triadic` (+120°/+240°), `tetradic` (+90°/+180°/+270°).

The stops are written into `layer.palette` as hex strings. After regeneration the user can click any swatch to override that stop individually — the swatch picker writes directly to `layer.palette[stopIdx]`. The `⟲ From Harmony` button regenerates fresh.

---

## 6. HDR export pipeline

**Critical: do not modify without understanding the precision implications.**

### 6.1 Float FBO

```js
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
```

`RGBA32F` is renderable thanks to `EXT_color_buffer_float`. The galaxy render forces `uViewMode = 0` (equirect) and `uTonemap = false` — output is **linear HDR**, channel values can exceed 1.0 (star brightness pushes to 25–80+).

### 6.2 readPixels

```js
const pixels = new Float32Array(w * h * 4);
gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, pixels);
```

WebGL pixels are bottom-up. Radiance `.hdr` uses top-down (`-Y H +X W`). We **flip during encoding**, not in a separate pass.

### 6.3 RGBE encoding — frexp polyfill

JS lacks native `frexp`. A naive `Math.ceil(Math.log2(m))` drifts at exact powers of 2 (e.g., `m == 1.0`), producing off-by-one exponents → black pixels in the brightest stars/bloom cores.

**The correct implementation:**

```js
function frexp(value) {
  if (value === 0 || !isFinite(value) || isNaN(value)) return [0, 0];
  let mantissa = value, exponent = 0, guard = 0;
  while (mantissa >= 1.0) { mantissa *= 0.5; exponent++; if (++guard > 2048) break; }
  while (mantissa <  0.5) { mantissa *= 2.0; exponent--; if (++guard > 2048) break; }
  // Epsilon guard for floating drift at boundary
  if (mantissa >= 1.0) { mantissa *= 0.5; exponent++; }
  if (mantissa <  0.5 && mantissa > 0.0) { mantissa *= 2.0; exponent--; }
  return [mantissa, exponent];
}
```

The while loops guarantee `mantissa ∈ [0.5, 1.0)`. Bounded iteration count prevents NaN/denormal hangs.

### 6.4 Encoding loop

For each pixel: `m = max(r, g, b)`. If `m < 1e-32`, emit `(0,0,0,0)`. Else `[mantissa, exponent] = frexp(m)`, `scale = mantissa * 256 / m`, emit `(r*scale, g*scale, b*scale, exponent + 128)` clamped to byte. **Uncompressed scanlines** — Unity reads both RLE and non-RLE.

Header:
```
#?RADIANCE
# Generated by Nebula Forge (WebGL2)
FORMAT=32-bit_rle_rgbe
EXPOSURE=1.0

-Y <H> +X <W>
```

### 6.5 Unity import

1. Drag `nebula_skybox_*.hdr` into `Assets/`.
2. Importer: **Texture Shape = Cube**, **Mapping = Latitude-Longitude Layout (Cylindrical)**, **sRGB = off**.
3. Assign to a Skybox material (Skybox/Cubemap shader). Window → Rendering → Lighting → Environment → Skybox Material.
4. Confirm bloom: stars should bloom when a Bloom post-process volume is active on an HDR camera. If they don't, the RGBE encoding clamped > 1.0 — bug.

---

## 7. UI architecture

### 7.1 Layer cards

Generated by `renderLayerCards()`. Each card has a `data-layer-id` attribute. Body comes from `buildNebulaBody / buildStarsBody / buildGalaxyBody` depending on `kind`. Re-rendering recreates the DOM — slider state lives in `state.layers`, never in the DOM.

### 7.2 Paired slider + number input

`sliderRow(key, label, val, min, max, step, fixed, extraClass?)` emits both a `<input type="range">` and a `<input type="number" class="value-readout">`. Both share the same `data-act` / `data-num` keys.

`wireLayerCard` → `bindRangePair(slider, numEl, target, key, fixed, isInt, sideEffect)`:

- Slider input → updates target, formats number-input value, recomputes `--val` fill.
- Number input → updates target (may exceed slider range — slider clamps thumb position, target stores typed value).
- Number input blur (`change`) → normalizes display to stored target value formatted to `fixed` decimals.

### 7.3 Slider fill via `--val`

```css
input[type="range"]::-webkit-slider-runnable-track {
  background: linear-gradient(to right,
    #94a3b8 0%, #94a3b8 var(--val),
    #1e293b var(--val), #1e293b 100%);
}
```

JS sets `slider.style.setProperty('--val', pct + '%')` whenever value changes. Hue slider (`.hue-slider` class) overrides the track background with a rainbow gradient — `--val` doesn't apply there.

### 7.4 Color theme (post-desaturation)

- Primary text: `#cbd5e1` (slate-300)
- Labels: `#94a3b8` (slate-400)
- Sub: `#64748b` (slate-500)
- Filled slider track: `#94a3b8` left, `#1e293b` right
- Slider thumb: `#e2e8f0` (no border, no glow)
- Layer-kind badges (only colored accents): subtle blue / amber / lime tints
- Hue slider track: 65% saturation rainbow

### 7.5 View mode + camera

`viewMode = 'equirect' | 'perspective'`. Perspective mode adds mouse drag (yaw/pitch), wheel (FOV 15°–120°), `R` to reset, `V` to toggle modes. Drag sensitivity scales with FOV. `T` toggles the sidebar.

Export always forces `forceEquirect: true` regardless of preview mode — what you see in perspective is informational, what you export is always 360°.

### 7.6 Hi-Res Preview toggle

When on, the preview canvas uses the full export resolution (1024 / 2048 / 4096) for equirect, or up to 3200×2000 for perspective. Costs GPU; useful for inspection before export.

---

## 8. Performance notes

- Preview is debounced at 40ms and coalesced via `requestAnimationFrame`.
- A typical preview render at 1024×512 with two layers takes < 5 ms on modern GPUs.
- 4096×2048 export with 5 layers takes 5–15 s. The RGBE encoding loop is JS single-threaded and is usually the bottleneck at high resolution — not the GPU render.
- Each detail sub-layer adds one `fbm` call per pixel (~8 simplex evaluations). Galaxy bundled mode adds a base `fbm` + 2 `starLayer` (54 cell lookups each).
- WebGL2 guarantees ≥ 256 vec4 uniforms. Eight galaxy layers use ~270 uniform slots — within spec but close. If we hit a hardware limit, pack into vec4s.

---

## 9. File structure / function index

`index.html` sections in order:

| Lines (approx) | Section |
|---|---|
| 1–500     | `<head>` + Tailwind config + inline CSS |
| 500–600   | DOM (sidebar, viewport, fatal overlay) |
| 600–615   | Vertex shader (fullscreen triangle) |
| 615–660   | State + constants |
| 660–730   | Color helpers (hsl2rgb, derivePaletteRGB, regenerateLayerPalette) |
| 730–830   | Layer factories (defaultNebulaLayer, defaultStarsLayer, defaultGalaxyLayer) |
| 830–1040  | `GLSL_LIBRARY` constant string |
| 1040–1180 | Shader builder (`buildFragmentShader`, `emitBlend`, `emitNebulaLayer`, `emitStarsLayer`, `emitGalaxyLayer`) |
| 1180–1230 | WebGL bootstrap (initGL, compile, buildProgram) |
| 1230–1320 | `rebuildProgram`, `setUniforms` |
| 1320–1380 | Preview render + sizing |
| 1380–1530 | HDR export (`renderToFloatFBO`, `frexp`, `encodeHDR`, `downloadBlob`, `exportHDR`) |
| 1530–1620 | UI building (`sliderRow`, `detailSliderRow`, `buildSwatchesEdit`, `buildDetailSubLayer`, etc.) |
| 1620–1860 | `buildNebulaBody`, `buildStarsBody`, `buildGalaxyBody` |
| 1860–1900 | `buildLayerCardHTML`, `renderLayerCards` |
| 1900–2080 | `wireLayerCard` (paired slider + number-input wiring) |
| 2080–2180 | `onLayerAction`, `addNebulaLayer`, `addStarsLayer`, `addGalaxyLayer`, `addSunLayer` |
| 2180–2280 | Sidebar toggle + view-mode + camera controls + hi-res toggle |
| 2280–2350 | `boot()` |

---

## 10. Known limitations

- **Tilt singularity** is mitigated via `ctSafe = max(abs(ct), 0.02)` but tilts > 89.5° will produce nearly-invisible disks (intended — true edge-on of a zero-thickness disk).
- **Multiple stacked galaxy masks** only keep the most recent one (mask-mode galaxies replace `galaxyMask` rather than multiply). Multiply-stacking would require a different emit strategy.
- **Color harmony regeneration overwrites user-edited stops.** "From Harmony" button is the documented escape; we could add per-stop "lock" flags if needed.
- **Star generator runs 27 cell lookups per pixel per star layer**, regardless of density. Cost is constant per call.

---

## 11. Architecture history / why-it-is-this-way

These are decisions worth knowing about, in case the new session wants to revisit:

- **Mask-detail accumulation (not domain warp) for nebula sub-layers** — earlier versions had sub-layers as warp sub-layers, but their sampling space inherited base scale, so high-frequency detail was impossible. The current design: each detail samples at `dir * uDetailScale + sOfs` (absolute), and contributes via `shaped += d * strength * clamp(shaped,0,1)`. Detail only appears where base nebula exists.
- **Tangent-plane projection for galaxy (not gnomonic)** — gnomonic (`/dot(dir, gN)`) blows up at edge-on. Tangent-plane with V-axis foreshortening (`/ ctSafe`) is well-defined for all tilts in [0°, 90°).
- **Two-tone bulge** — chosen over single radial falloff for realistic warm-core/orange-corona look.
- **First-contributing layer forced to Add** — without this, putting a Multiply blend at layer 0 against `finalColor = vec3(0)` locks output black.
- **Typeable number inputs** — pair with sliders to allow exceeding slider max. Stored layer value keeps the typed value; slider clamps for thumb position only.
- **Strict frexp polyfill** — naive Math.log2 has off-by-one at powers of 2, breaks brightest pixels.

---

## 12. Roadmap

### 12.1 Save / Load (shipped)

**Format:** JSON serialization of the full `state` object plus a version tag.

```json
{
  "_version": 1,
  "_format": "nebula-forge-preset",
  "uSeed": 1337,
  "layers": [ /* fully serialized layer objects, including detailLayers */ ]
}
```

Implementation sketch:
- `+ Save` button → `JSON.stringify(state)` → download as `.nebula.json`
- `+ Load` button → file picker → `JSON.parse` → validate version → replace `state.layers` → `rebuildProgram()` + `renderLayerCards()`
- Validate per-layer: missing fields filled from `defaultXxxLayer` defaults
- Strip the runtime `id` and reassign via `nextId()` to keep counter monotonic

**Things to think about:**
- Future-proofing: if we add a new field to a layer kind, old saves should still load. Solution: spread defaults under the loaded object during parse.
- Embedded preview thumbnail? Probably nice — encode the current preview canvas as a base64 PNG and stash in the JSON.
- LocalStorage auto-save of last state on every structural change? Reasonable. Use a different key per tab to avoid conflicts.

### 12.2 Unity port (planned)

Goal: a runtime-procedural skybox in Unity that produces visually identical results to the WebGL preview, parameterized the same way.

**Approach options:**
1. **Static**: just import the `.hdr` as cubemap. Already works today, no port needed.
2. **Static + tweakable**: import HDR, allow Unity material to slightly modify exposure / tint. Trivial.
3. **Procedural runtime**: port the entire fragment shader to HLSL, expose layer params as material properties. **This is the project**.

For option 3:

**Shader port checklist:**
- `snoise(vec3)` → HLSL version (same math, GLSL `vec3` → `float3`).
- `voronoi3`, `fbm_simplex`, `fbm_voronoi`, `fbm_ridged` — direct port.
- `palette4` — direct port.
- `starLayer` — direct port; HLSL supports the same loop structure.
- `acesFilm`, `blendOverlay` — direct port.
- Equirect → dir mapping → render in a Skybox/Procedural shader. In Unity, the skybox shader receives a world-space view direction per fragment; no need to do equirect projection — sample directly using the direction.

**Layer system port:**
- HLSL doesn't have JS-style dynamic shader composition. Two options:
  - (a) **Pre-bake**: in editor, generate the HLSL source by transpiling from the JS emitter. Ship the resulting `.shader` file.
  - (b) **Fixed-size uber-shader**: allocate slots for N layers (e.g. 4 nebula + 2 stars + 1 galaxy). Each layer has an "enabled" toggle. More flexible, more uniforms.
- ScriptableObject per layer kind, mirroring the JS layer data model.
- Custom inspector with the same controls.

**Save/load reuse:**
- Unity reads the `.nebula.json` saved from the web tool and reconstructs the ScriptableObjects. Means both sides use the same canonical format.

**Performance considerations in Unity:**
- Full fragment shader at 1080p with multiple layers may be heavy at runtime. Options: render to a static cubemap at scene load (one-time cost), or keep static `.hdr` for shipping and use procedural only in editor.

---

## 13. Quick reference — adding a new layer kind

If we ever need a fourth layer kind (e.g., "planets"):

1. Add `defaultPlanetLayer(opts)` factory near other factories.
2. Add `emitPlanetLayer(layer, i, isFirst)` after `emitGalaxyLayer`.
3. In `buildFragmentShader`: emit per-layer uniforms case for `kind === 'planet'`.
4. In the layer walker: branch to `emitPlanetLayer` on `'planet'`.
5. In `rebuildProgram`: add uniform location fetch case.
6. In `setUniforms`: add uniform write case.
7. Add `buildPlanetBody(layer)` in the UI builders.
8. Update `buildLayerCardHTML` to route `'planet'` to the right body.
9. Add a `+ Planet` button in the add-row.
10. Wire the button in `boot()`.

The pattern is consistent across all three existing kinds — follow that.
