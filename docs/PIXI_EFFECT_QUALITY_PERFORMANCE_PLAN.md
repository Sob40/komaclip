# Pixi Effect Quality And Performance Plan

Goal: make KomaClip effects match or exceed the Panel2Reels MVP visual quality while keeping preview playback stable on ordinary creator laptops.

## Source Notes

- PixiJS performance docs recommend batching sprites, avoiding hundreds of complex `Graphics`, limiting filters and masks, and keeping blend-mode ordering in mind.
- PixiJS `cacheAsTexture` is recommended for static or rarely updated containers, especially expensive filtered groups, with a GPU memory tradeoff.
- PixiJS `GraphicsContext` lets repeated shape geometry be reused instead of rebuilding graphics every frame.
- PixiJS `ParticleContainer` is designed for very high particle counts by removing non-essential `Container` overhead.
- PixiJS `Assets` is Promise-based and cache-aware, and supports manifests, bundles, fonts, video textures, and compressed textures.

References:

- https://pixijs.com/8.x/guides/concepts/performance-tips
- https://pixijs.com/8.x/guides/components/scene-objects/container/cache-as-texture
- https://pixijs.com/8.x/guides/components/scene-objects/graphics
- https://pixijs.com/8.x/guides/components/scene-objects/particle-container
- https://pixijs.com/8.x/guides/components/filters
- https://pixijs.com/8.x/guides/components/assets

## Current Renderer Findings

- The full Panel2Reels MVP renderer is now used as the primary preview renderer.
- Most premium visuals are procedural: manga speed lines, halftone bursts, impact frames, glitch tears, panel smash, power aura, romance sparkles, horror scratches, and text styles.
- The renderer currently clears the root and rebuilds many `Graphics`, `Text`, `Container`, and `Sprite` objects every frame. This preserves MVP behavior but creates avoidable CPU and GC work.
- Several procedural textures are already cached through `createCanvasTexture`; this is a good direction.
- The first safe quality improvement is to generate cached noise and halftone textures at full preview resolution instead of half resolution.

## Improvement Blocks

### 1. Safe Visual Fidelity Pass

- Keep the MVP renderer as the source of truth.
- Raise cached procedural texture resolution where it improves visible quality without per-frame cost.
- Ensure all MVP fonts are loaded before first render.
- Add frame timing telemetry so changes can be measured.

### 2. Static Texture Cache Pass

- Convert reusable manga overlays into cached textures:
  - radial speed-line fields
  - halftone fields
  - paper grain/noise
  - ink scratch plates
  - action burst silhouettes
- Prefer `Sprite`/`TilingSprite` transforms over rebuilding identical `Graphics`.
- Keep full-resolution master textures and derive lower-quality variants only for future mobile/low-power mode.

### 3. GraphicsContext Pass

- Move repeated geometry families to reusable `GraphicsContext` objects:
  - starbursts
  - speed slashes
  - frame borders
  - panel fracture shards
  - manga pressure lines
- Animate transform, alpha, tint, scale, and rotation instead of rebuilding paths.

### 4. Particle Pass

- Move sparkles, embers, shards, petals, dust, and small hit particles to `ParticleContainer`.
- Use custom transparent sprite textures for particle shapes.
- Mark only the changing properties as dynamic.

### 5. Filter And Shader Pass

- Keep custom shader filters for glitch, heat, RGB split, signal corruption, and scan effects.
- Add explicit filter areas for full-frame filters to avoid unnecessary bounds measurement.
- Avoid stacking multiple expensive filters unless the effect visually needs it.
- Import advanced blend modes only when a specific effect uses them.

### 6. Asset Pack Pass

- Treat future owned manga FX as texture atlases/spritesheets, not loose individual files.
- Use Pixi asset manifests/bundles for packs:
  - shonen action
  - shojo romance
  - seinen noir
  - horror manga
  - comedy/chibi
- Keep runtime paths CDN-ready from the start.

## Acceptance Criteria

- Preview still reports `data-preview-renderer="panel2reels-mvp"`.
- No relevant console errors or Pixi warnings.
- Average frame render time is visible through `data-preview-average-frame-ms`.
- Visual QA covers at least:
  - action impact
  - speed wipe
  - glitch tear
  - text/SFX style
  - romance or horror non-action style
- If a quality change increases average frame time, it must have an obvious visual payoff.
