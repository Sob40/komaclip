# Panel2Reels MVP Integration Guide

This guide turns the local `panel2reels-mvp` prototype into an implementation
plan for KomaClip. The goal is visual and workflow parity with the MVP while
keeping KomaClip's Rails SaaS architecture as the production source of truth.

Reference code reviewed:

- `/Users/asargues/panel2reels-mvp/index.html`
- `/Users/asargues/panel2reels-mvp/styles.css`
- `/Users/asargues/panel2reels-mvp/app.js`
- `/Users/asargues/panel2reels-mvp/server.py`
- `/Users/asargues/panel2reels-mvp/data/visual-catalog-v2.json`
- `/Users/asargues/panel2reels-mvp/schema/montage.schema.json`
- `/Users/asargues/panel2reels-mvp/schema/render-payload.schema.json`
- `/Users/asargues/panel2reels-mvp/renderers/pixi/pixi-preview-renderer.js`

## Product Truth From The MVP

The MVP is not just an upload form plus Pixi preview. Its strongest product
logic is a guided director pipeline:

1. Ordered material becomes usable scenes.
2. Each scene can carry user text, no-text intent, duration weight, motion,
   bubble style, text position, text size, and transition intent.
3. Direction chooses a goal and a visual style.
4. Proposal generation builds one clip from all selected panels.
5. A local director assigns shot phases, timings, screen text, motion defaults,
   transition defaults, music, and Pixi visual presets.
6. The editor exposes quick global controls plus per-shot text review.
7. Pixi preview renders the actual sequence in a fixed phone frame.

The production migration must preserve that loop. KomaClip can rewrite the
runtime, but it should not redesign the creative model from scratch.

## Current KomaClip State

KomaClip already has the right production skeleton:

- Rails owns users, sessions, projects, assets, panels, clips, templates, and
  render records.
- `ProjectAsset` validates real image uploads and stores metadata.
- `Panel` stores ordered scene references and scene text.
- `ProjectDirection` stores a safe goal/style/format choice.
- `SceneContracts::InitialClipBuilder` creates a backend-owned Pixi contract.
- The clip show page has a Pixi controller and phone frame.
- Templates store reusable settings rather than heavy media.

The remaining gap is no longer the basic user flow. KomaClip now stores MVP-like
scene controls, lets users confirm material, choose direction, create a
proposal, and open an editable clip with a sticky Pixi phone preview. The next
gap is fidelity: the generated contract still needs the full director model,
sequence playback, richer Pixi effects, and export/render behavior.

## MVP Visual Style Contract

The MVP visual target is a dark compact creative studio. It is dense, tool-like,
and high-contrast, with a fixed phone preview. It should not become a marketing
landing page or a loose dashboard.

### Global Layout

The main shell uses a two-column editor:

- left workspace: `minmax(0, 1fr)`;
- right preview rail: `410px`;
- desktop gap: `18px` to `24px`;
- page padding: `18px` in the final compact state, `10px` to `14px` on mobile;
- nav is sticky at `top: 8px`;
- phone preview is sticky at `top: 78px`;
- everything uses `border-radius: 8px` except the phone, which uses a large
  device radius.

KomaClip already matches this broadly with `.kc-editor-shell`, but Group 1
should keep the MVP proportions exactly: the editor rail should stay dense, and
the phone column should remain `410px` on desktop.

### Color Tokens

The final MVP cascade overrides the early light theme with this dark studio
skin:

```css
--bg: #07070d;
--ink: #f8f6ff;
--muted: #aaa6bd;
--line: rgba(255, 255, 255, 0.12);
--panel: rgba(17, 18, 30, 0.86);
--accent: #ff3d7f;
--accent-dark: #ff7bd3;
--mint: #55f0c8;
--blue: #7aa7ff;
--yellow: #ffd95a;
--shadow: 0 24px 70px rgba(0, 0, 0, 0.42);
```

The body background is:

- radial pink glow near `22% 10%`;
- deep `#07070d -> #10101d -> #090914` gradient;
- subtle fixed dot and diagonal-line texture.

KomaClip's current variables already mirror these. Keep them as the source for
new components.

### Typography

Use Inter for body text and Space Grotesk for control-heavy headings, buttons,
and card titles.

MVP sizes:

- body: `15px`;
- H1: compact final `40px`, `1.02` line-height;
- step H2: `20px`, `1.08` line-height;
- step body: `13px`;
- eyebrow: `11px`, uppercase, heavy;
- buttons: `13px`, heavy;
- choice card title: `16px` in final goal/style cards;
- field captions: `12px`, heavy;
- helper text: `11px`;
- shot/card metadata: `10px` to `12px`.

Letter spacing should stay `0`. The MVP relies on weight and contrast, not
wide tracking.

### Surfaces

Main panels use:

- `border-radius: 8px`;
- `border: 1px solid rgba(255, 255, 255, 0.12)`;
- dark glass background with a subtle pink-to-mint diagonal overlay;
- `box-shadow: 0 24px 70px rgba(0, 0, 0, 0.42)`;
- `backdrop-filter: blur(18px)` for nav and KomaClip panels where possible.

Representative panel background:

```css
background:
  linear-gradient(105deg, rgba(255, 61, 127, 0.08), transparent 34%, rgba(85, 240, 200, 0.06)),
  linear-gradient(180deg, rgba(28, 29, 46, 0.88), rgba(14, 15, 26, 0.9)),
  var(--panel);
```

Collapsed completed steps become compact rows:

- padding: `10px 12px`;
- step number: `30px`;
- heading: `16px`;
- body text hidden.

### Navigation

The MVP nav is compact and sticky:

- height driven by `8px 12px` padding;
- brand icon: about `34px`;
- nav buttons: `34px` high;
- mode segmented control: `34px` high, inner buttons `28px`;
- button font: `12px`, heavy;
- CTA gradient: `#ff3d7f -> #ff7a3d -> #7a5cff`;
- icons inside nav: `14px` to `15px`.

KomaClip should keep SVG stroke icons with `stroke-width: 2`, not emoji or text
symbols, for all primary controls.

### Choice Cards

Goal and style cards are compact, icon-led cards:

- grid: icon column `28px`, copy column `1fr`;
- card radius: `8px`;
- gap: `8px` to `10px`;
- default min-height after final cascade: `62px`;
- direction goal cards: `78px`;
- direction style cards inside montage panel: around `86px` on mobile and
  taller on desktop when descriptions are visible;
- padding: `11px`, with direction goal cards at `14px 16px`;
- icon: `22px`, mint by default, yellow when active.

Default text descriptions are hidden for dense goal/style cards, but the
direction goal stage shows a short description. Style cards in the montage
panel show descriptions.

States:

- hover border: mint `rgba(85, 240, 200, 0.55)`;
- active border: yellow `rgba(255, 217, 90, 0.72)`;
- active background: pink/blue/mint gradient over `#151625`;
- active outline: subtle yellow, `2px`.

### Buttons And Controls

Primary buttons:

- height: `38px` final compact state;
- radius: `8px`;
- padding: `0 14px`;
- font-size: `13px`;
- gap with icon: `8px`;
- background: `linear-gradient(96deg, #ff3d7f 0%, #ff7a3d 45%, #7a5cff 100%)`;
- hover translates up by `-1px`.

Ghost buttons:

- same size and radius;
- background: `rgba(255, 255, 255, 0.06)`;
- border: `rgba(255, 255, 255, 0.14)`;
- hover uses mint border/background.

Inputs and selects:

- height: `38px` globally, `36px` in dense editor groups, `32px` in shot grids;
- radius: `8px`;
- font-size: `13px`;
- font-weight: `700`;
- background: `rgba(6, 7, 14, 0.78)`;
- focus: mint ring with `3px rgba(85, 240, 200, 0.14)`;
- selects use a custom chevron background, not native styling.

### Icon System

The MVP uses an inline SVG sprite in `index.html` with these icons:

- target, book, rocket, user, megaphone, spark, film, zap, brush, cpu, wand,
  upload, scan, type, save, copy, trash, eye-off, play, music, download.

Sizing rules:

- default `.icon`: `18px`;
- choice card icon: `22px`;
- button icons: `17px`;
- field caption icons: `15px`;
- nav/mode icons: `14px` to `15px`;
- scene action icons: `14px`;
- mobile choice card icons: `18px`.

In KomaClip, use `kc_icon`/inline SVG equivalents, but preserve the same visual
roles and sizes.

### Material Review

The MVP material review should feel like a storyboard board, not a generic file
table.

Final scene card grid:

- `.scene-briefs`: `repeat(auto-fill, minmax(176px, 1fr))`;
- gap: `14px`;
- mobile: two columns with `10px` gap.

Scene cards:

- one-column card;
- radius: `8px`;
- padding: `10px`;
- background: dark vertical gradient;
- hover border mint and elevated shadow;
- drag handle: absolute top-right, `30px` square;
- media aspect: `3 / 4`, full card width;
- scene order badge: `28px`, top-left, pink/blue/mint gradient;
- title: `15px`, metadata `11px`;
- footer actions: icon buttons `30px` square.

KomaClip currently uses similar cards but at `minmax(210px, 1fr)`. For MVP
parity, reduce toward `176px` when the richer scene controls are added, so the
workspace feels compact like the prototype.

### Scene Controls

The MVP scene metadata controls include:

- text / no text;
- exclude scene;
- motion;
- bubble style;
- position;
- size;
- duration;
- transition after scene.

When presented in a dense grid, use:

- `scene-style-grid`: six columns of `minmax(112px, 1fr)`;
- gap: `8px`;
- advanced panel radius: `7px` to `8px`;
- labels: `10px` to `12px`, uppercase/heavy for technical controls;
- chips: pill radius, `10px` to `11px`, heavy.

### Proposal Settings

The proposal area stays compact:

- panel radius `8px`;
- inner padding around `10px`;
- settings grid should collapse to one column on mobile;
- primary "Crear propuesta" button remains the visual anchor with wand icon;
- secondary actions use ghost buttons with scan/type/save icons.

Do not add large explanatory cards here. The MVP keeps this area operational.

### Editor Layout

The MVP editor section is the most important visual match.

Quick adjustment:

- group panels use radius `8px`;
- text/effects/audio groups use different accent variables:
  `#55f0c8`, `#ffd34d`, `#7a5cff`;
- global edit group padding: `10px`;
- global edit grid: `repeat(auto-fit, minmax(112px, 1fr))`;
- dense controls: `36px` high.

Shot review rows:

- row card padding: `8px`;
- grid: `58px minmax(0, 1fr)`;
- row gap: `10px`;
- preview: `58px` wide, `3 / 4`, min-height `78px`;
- shot number badge: `22px`;
- title phase: `12px`, uppercase;
- filename/meta: `11px`;
- text + animation editor: `minmax(220px, 1fr) minmax(130px, 0.42fr)`;
- textarea min-height: `34px`;
- animation select min-height: `34px`;
- Pixi summary chips: inline flex, min-height `24px`, padding `4px 7px`,
  font-size `10px`, label `8px`.

Phase accents:

- hook: `#ff3d7f`;
- body: `#55f0c8`;
- climax: `#ffd34d`;
- close: `#7a5cff`.

KomaClip's current clip show page is too sparse. The MVP target is a compact
editor where quick controls, shot rows, warnings, metadata chips, and phone
preview are visible together.

### Phone Preview

The phone is a product-defining element:

- preview pane width comes from the `410px` right column;
- pane is sticky at `top: 78px`;
- pane padding: `12px`;
- phone aspect: `9 / 16`;
- max-height: `calc(100vh - 250px)`;
- phone radius: `32px`;
- inner canvas/video/Pixi mount inset: `12px`;
- inner radius: `22px`;
- black base: `#050509`;
- shadow: `0 22px 58px rgba(0, 0, 0, 0.52)`;
- loader overlay uses blur, `13px` text, `18px` spinner.

Preview controls:

- output select margin-top: `12px`;
- action grid: `repeat(auto-fit, minmax(116px, 1fr))`;
- gap: `8px`;
- buttons: `40px` high, `13px`;
- first action is gradient play;
- second action can be mint-highlighted preview visual;
- selected action gets yellow/mint highlight.

### Responsive Rules

At `max-width: 980px`:

- main shell becomes one column;
- nav links hide;
- preview pane becomes static;
- grids commonly become two columns.

At `max-width: 620px`:

- app padding: `10px` to `14px`;
- H1: `28px`;
- step H2: `18px`;
- step number: `30px`;
- choice cards remain two columns for goal/style/director when possible;
- dense grids collapse to one column;
- preview action buttons stack;
- scene cards use two columns in material review;
- icon placement moves to top-right in choice cards.

## KomaClip Style Alignment Notes

KomaClip already has many matching tokens in `application.tailwind.css`:

- same dark background family;
- same 8px radius rule;
- same 410px preview rail;
- same primary gradient;
- same mint/blue/yellow accent system;
- similar scene cards and phone frame.

The main visual gaps to close during Group 1 are:

1. Make material review denser and closer to the MVP storyboard card rhythm.
2. Add real SVG icons to all scene action buttons; avoid text symbols such as
   `×` and `⧉` in final UI.
3. Replace the clip show page's sparse stat cards with the MVP editor: quick
   controls, shot rows, Pixi summary chips, warnings, and metadata chips.
4. Keep the phone visible in a sticky right rail while editing.
5. Use exact compact control heights: `38px` normal, `36px` dense global edit,
   `34px` shot edit, `30px` icon actions.
6. Preserve the MVP's active/hover colors: mint for hover, yellow for active,
   gradient for primary and numbered badges.

## Do Not Migrate These MVP Shapes

Do not copy these parts as production patterns:

- The monolithic `app.js` runtime.
- The local `server.py` API server.
- Client-provided OpenAI API key saving.
- Open render endpoints.
- Browser-owned final export as the trusted artifact.
- Remotion as a second product renderer.
- Generated local `renders/` or `tmp/` output.
- Vendor Pixi and ffmpeg files checked into the app.

Use them as reference only. Rails should own authorization, persistence,
validation, jobs, secrets, storage, and billing.

## MVP Logic To Port

### Direction IDs

KomaClip already uses stable ids, but they need a direct mapping to the MVP:

| MVP id | KomaClip id |
| --- | --- |
| `trailer-tense` | `trailer_tense` |
| `battle-impact` | `impact_fast` |
| `chapter-clean` | `chapter_clean` |
| `webtoon-scroll` | `webtoon_scroll` |
| `character-spotlight` | `character_spotlight` |
| `kickstarter-pitch` | `sales_pitch` |
| `making-of` | `making_of` |

Keep KomaClip ids in URLs/forms. Convert to MVP/catalog ids only inside
proposal and visual-director services.

### Scene Metadata

`Panel.metadata` should grow from `sceneText` to the MVP scene model:

- `sceneText`
- `sceneTextSource`
- `noText`
- `noTextSource`
- `sceneMotion`
- `sceneMotionSource`
- `sceneBubble`
- `sceneBubbleSource`
- `scenePosition`
- `scenePositionSource`
- `sceneSize`
- `sceneSizeSource`
- `sceneDuration`
- `sceneDurationSource`
- `sceneTransition`
- `sceneTransitionSource`
- `analysis`

This lets material review behave like the MVP: reorder, duplicate, delete,
exclude/no-text, edit scene text, and optionally tune the scene before proposal.

### Proposal Builder

`InitialClipBuilder` now preserves proposal controls and direction-compatible
defaults. It still needs to evolve into a real proposal service that ports the
MVP's local generation flow:

- usable panels only;
- local panel analysis fallback;
- direction-compatible defaults; implemented in `ProjectDirection.proposal_defaults_for`;
- one proposal clip for MVP launch; implemented in `ClipsController#create`;
- phase assignment: `HOOK`, `BODY`, `CLIMAX`, `CLOSE`;
- weighted scene timing;
- intro/end text;
- per-shot overlay;
- motion defaults;
- transition defaults;
- pace and intensity; basic proposal duration/intensity now stored in contract;
- music and volume;
- Pixi visual plan.

Recommended Rails shape:

- `SceneContracts::ProposalBuilder`
- `SceneContracts::PanelAnalysis`
- `SceneContracts::ShotTiming`
- `SceneContracts::VisualDirector`
- `SceneContracts::ContractNormalizer`

`InitialClipBuilder` can remain as the compatibility layer, but the next larger
step should extract director behavior into the recommended services instead of
growing the builder forever.

### Scene Contract

The current `komaclip.scene.v1` contract must become expressive enough for the
MVP editor and preview. A shot should include at least:

- stable `panelId` and `assetId`;
- `phase`;
- `startMs`, `endMs`, `durationMs`;
- normalized `crop`;
- overlay object: `text`, `source`, `style`, `position`, `size`,
  `animation`, `font`, `color`, `spacing`;
- motion object: `zoomStart`, `zoomEnd`, `panX`, `panY`, `motionStyle`;
- `pace`;
- `effectIntensity`;
- `transition`;
- Pixi contracts: `pixiTextStyle`, `pixiCameraMotion`, `pixiActiveEffect`,
  `pixiTransitionOut`, `pixiVisualPresetIds`, `pixiTags`.

The clip-level contract should include:

- `direction`;
- `format`;
- `durationMs`;
- `music`;
- `musicVolume`;
- `caption`;
- `hook`;
- `cta`;
- `visual.catalogContractVersion`;
- `visual.montage` with director profile metadata.

Do not store public asset URLs in `scene_contract`. The controller can provide
signed preview URLs in a separate payload, as it already does.

### Visual Director

The MVP's `assignPixiMontagePlanToClip` is the heart of visual parity. Port its
behavior as a Ruby service or a small frontend/shared module with server
normalization, but keep the same concepts:

- director profile from goal/style/genre/tone;
- role tags for text, camera motion, effects, and transitions;
- shot context tags from phase, pace, motion, intensity, format, and panel
  analysis;
- scoring against `data/visual-catalog-v2.json`;
- stable deterministic selection;
- visual load balancing so quiet shots are readable;
- automatic recommended camera motion for some strong effects;
- production-ready and needs-QA preset tracking.

For Group 1, start with the same small set of presets already visible in the MVP
flow, then expand.

### Editor

The clip editor should match the MVP's editing surface, not just show static
metadata:

- quick global controls: visual style, reading pace, intensity, music, volume;
- Pixi controls: text style, camera motion, active effect, transition;
- text controls: animation, font, color, spacing, position, size;
- shot list with thumbnail, phase, text textarea, animation select, and Pixi
  summary;
- warnings when text may collide with social UI;
- metadata chips for duration, platform, music, visual system, panel count.

All updates should go through Rails endpoints that whitelist fields and rebuild
or normalize the contract. Do not accept arbitrary JSON replacement from the
browser.

Recommended routes:

- `PATCH /projects/:project_id/clips/:id`
- `PATCH /projects/:project_id/clips/:clip_id/shots/:index`
- optional `POST /projects/:project_id/clips/:id/regenerate`

### Preview

The Stimulus Pixi preview now mounts in the editor phone frame, reads
`sceneMotion` and `visual.intensity`, and applies a first motion slice for
cinematic, impact/beat, scroll, parallax/swipe, float, glitch/rgb, and manga
shots. Group 2 should upgrade it toward the full MVP:

- sequence playback, not only previous/next shot;
- cover/focus camera;
- per-shot text rendering;
- transitions between shots;
- at least the first production active effect and camera motion;
- fixed 9:16 phone frame on the right in desktop;
- stable fallback when an asset fails to load;
- no public URLs in the saved contract.

Port `renderers/pixi/pixi-preview-renderer.js` in slices. Do not paste the whole
14k-line renderer into one controller.

Recommended frontend shape:

- `app/javascript/pixi/preview_renderer.js`
- `app/javascript/pixi/scene_normalizer.js`
- `app/javascript/pixi/effects/*`
- `app/javascript/controllers/clip_preview_controller.js` as the thin mount.

## Revised Roadmap

### Group 1: Main User Flow

Goal: make Material -> Direction -> Proposal -> Clip editor/preview feel like
the MVP.

Implemented in KomaClip:

1. Material review stores scene text, no-text, skip/exclude, motion, bubble,
   position, size, duration, and transition metadata.
2. Material review visually matches the MVP density: compact full-width grid
   before confirmation, collapsed material row after confirmation.
3. Direction stores goal/style/format and uses MVP-compatible proposal defaults.
4. Proposal controls include expanded genre, scene-time, and intensity options.
5. `ClipsController#create` creates one editable proposal clip and redirects to
   the clip editor.
6. Workspace preview links to the existing clip when one exists and clearly
   shows the pending-proposal state when one does not.
7. Clip editor uses compact MVP-like rows with advanced scene settings folded
   behind details, plus a sticky Pixi phone preview.

Still pending before calling Group 1 complete:

1. Replace the baseline clip builder with a proposal builder based on the MVP
   local generation flow.
2. Expand `komaclip.scene.v1` or introduce `komaclip.scene.v2`.
3. Generate one real proposal clip with shot phases, weighted timings, overlays,
   music, motion, transition, and Pixi preset contracts.
4. Add global clip controls for pace/intensity/music once the director contract
   exists.
5. Add warnings and richer metadata chips for text safety, music, visual system,
   and panel count.

Exit criteria:

- a user can upload several images, order them, mark text/no-text/skip, choose
  goal and style, create one proposal, and open the editable clip;
- the project workspace clearly represents the four states: material review,
  direction, proposal pending, and proposal ready;
- the clip editor receives a contract with phases, weighted timings, overlays,
  motion, intensity, and transition intent;
- the resulting workspace visually resembles the MVP studio shell;
- continuous playback, full transition rendering, music sync, and export are
  explicitly left to Group 2 and later production groups.

### Group 2: Pixi Preview And Montage

Goal: make the result visually close to the MVP.

1. Port the Pixi sequence renderer in small modules.
2. Implement cover camera, camera motion, one active-panel effect family, one
   text style family, and all MVP transition ids used by Group 1.
3. Add playback controls and a canvas lifecycle that works across Turbo visits.
4. Add browser visual checks with screenshots for desktop and mobile.

### Group 3: Templates And Reuse

Goal: save reusable creative settings, not heavy material.

1. Store direction, format, timing defaults, text defaults, music, and visual
   preset choices.
2. Apply template settings before proposal generation.
3. Keep assets/panels project-specific.

### Group 4: Files And Storage

Goal: production-grade media handling.

1. Keep multi-upload.
2. Add explicit limits per plan.
3. Add temporary cleanup policy.
4. Move Active Storage to R2/S3 for production.
5. Use signed URLs for preview and render workers.

### Group 5: Authentication And Account

Goal: product-ready accounts.

1. Harden registration/login/recovery.
2. Add Google OAuth if it shortens onboarding.
3. Add profile and user language preferences.

### Group 6: Payments With Polar

Goal: subscription/licensing as server truth.

1. Add plans and checkout.
2. Verify webhooks.
3. Store subscription/license state.
4. Enforce limits by plan for upload, AI, templates, and render.

### Group 7: Internationalization

Goal: English default, Spanish selectable.

1. Keep UI copy in locales.
2. Separate interface locale from generated clip language.
3. Review creator-facing terms so they are clear for non-technical users.

### Group 8: Admin

Goal: internal visibility.

1. Users, projects, assets, clips, renders, subscriptions, incidents, limits,
   and basic metrics.

### Group 9: Security And Abuse Prevention

Goal: safe SaaS boundaries.

1. Ownership checks everywhere.
2. Rate limits for auth, upload, AI, render, checkout.
3. Strict file validation.
4. Private storage and signed URLs.
5. Contract schema validation before save/render.

### Group 10: Performance And Production

Goal: deployable product.

1. Lazy-load Pixi only in editor/preview pages.
2. Split Pixi modules from general Rails JS.
3. Move render and AI to background jobs.
4. Add cache, logs, monitoring, and Render deployment setup.

### Group 11: MVP Quality

Goal: beta confidence.

1. Unit tests for proposal builder and contract normalization.
2. Controller tests for edit/update authorization.
3. Visual screenshots for workspace and clip preview.
4. End-to-end flow: upload -> direction -> proposal -> edit -> preview.
5. Pre-beta checklist.

## Immediate Implementation Order

Group 1 is now mostly implemented. The remaining Group 1 work is QA and small
workspace polish, not new architecture:

1. Recheck material review, direction, proposal pending, and proposal ready on
   desktop and mobile.
2. Recheck edge states: many scenes, excluded scenes, no-text scenes, and empty
   projects.
3. Keep project-level preview actions honest until Group 2 exists: open editor
   is available, music/video export stay disabled.
4. Keep the contract stable for Group 2 so the Pixi renderer can consume
   `phase`, `startMs`, `endMs`, `overlay`, `motion`, `effectIntensity`, and
   `transition`.

Next practical work after this polish is Group 2: continuous Pixi playback,
real transitions, richer visual effects, text animation, music, and eventually
render/export.
