# KomaClip Manga FX Asset Pack Spec

This document defines how owned or app-redistribution-safe manga FX assets should be delivered and wired into KomaClip.

## Principle

KomaClip may use procedural Pixi fallbacks for MVP preview. Real asset URLs must only be added when the asset is:

- owned by KomaClip,
- commissioned exclusively for KomaClip, or
- licensed for redistribution/use inside a SaaS app asset library.

Commercial stock that only permits final rendered output must not be exposed as an in-app editable asset.

## Storage Layout

Recommended production path:

```text
manga-fx/
  shonen-action/
  shojo-romance/
  seinen-noir/
  horror-manga/
  comedy-chibi/
```

The manifest lives at `data/catalogs/manga-fx-packs.json`.

## Asset Requirements

- Transparent PNG/WebP for static overlays.
- WebM/MP4 or image sequence/spritesheet for animated overlays.
- Vertical-safe composition for 9:16 preview.
- Prefer 2160x3840 or 1080x1920 for full-frame overlays.
- Safe-frame accents should work inside the central phone frame, not only full bleed.
- No copyrighted manga panels, logos, real kanji from protected works, or recognizable third-party SFX styles.

## Manifest Rules

Each slot must include:

- `id`
- `kind`
- `assetType`
- `role`
- `url`
- `blendMode`
- `anchor`
- `animation`
- `fallback`
- `licenseStatus`

Allowed production `licenseStatus` values:

- `owned`
- `commissioned-exclusive`
- `app-redistribution-license`

Draft slots can keep:

- `url: null`
- `licenseStatus: owned_required`

The app will not expose URLs unless `licenseStatus` is production-safe.

## Adding A Real Asset

1. Upload the file to CDN/object storage under `manga-fx/...`.
2. Update the matching slot URL in `data/catalogs/manga-fx-packs.json`.
3. Change `licenseStatus` to `owned`, `commissioned-exclusive`, or `app-redistribution-license`.
4. Run:

```bash
bin/rails test test/services/manga_fx_catalog_test.rb test/lib/schema_and_catalog_contracts_test.rb
```

5. Verify the preview reports `data-preview-fx-assets-loaded` greater than `0`.
   Transition and text slots are reported separately through `data-preview-transition-assets-loaded` and `data-preview-text-assets-loaded`.

## Current Packs

- `shonen-action`: speed lines, impact frames, ink flashes, transition overlays, title banners, impact SFX frames.
- `shojo-romance`: sparkles, flower frames, soft overlays, thought/speech text frames.
- `seinen-noir`: grain, smoke, vignette texture.
- `horror-manga`: scratch lines, dirty fog, signal horror.
- `comedy-chibi`: stamps, reaction symbols.
