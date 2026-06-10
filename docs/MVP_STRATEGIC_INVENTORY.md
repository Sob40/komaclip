# MVP Strategic Inventory

This document captures what should be preserved, rewritten, or discarded from the
Panel2Reels MVP when building KomaClip as a production SaaS.

The MVP is a reference product and research lab. It is not a codebase to copy
directly into production.

## Executive Summary

KomaClip should migrate the product knowledge from the MVP, not the MVP's
runtime shape.

The strongest assets are the Pixi visual system, the scene/payload schemas, the
curated visual catalog, the motion design research, and the editor workflow
knowledge embedded in the prototype. The riskiest parts are the oversized
browser bundle, the local Python server, local file-based rendering, open render
endpoints, API key handling, and the dual Pixi/Remotion rendering paths.

Production KomaClip should be Rails-owned for identity, billing, authorization,
storage, and jobs. Pixi should remain the single visual source of truth for both
interactive preview and final export.

## MVP Footprint

| Area | Current MVP Shape | Production Decision |
| --- | --- | --- |
| Frontend app | `app.js`, about 16.5k lines, mixes editor state, uploads, AI, catalogs, preview, export, and lab tools | Rebuild as domain modules. Do not copy wholesale. |
| Pixi renderer | `renderers/pixi/pixi-preview-renderer.js`, about 14.8k lines | Preserve concepts and re-module into a clean Pixi engine. |
| Backend | `server.py`, about 2.3k lines, local HTTP server | Replace with Rails controllers, services, policies, and Sidekiq jobs. |
| Schemas | `schema/*.json` for montage, render payload, and visual presets | Migrate early, review, then enforce server-side. |
| Visual catalog | `data/visual-catalog-v2.json`, about 10.4k lines | Migrate curated v2 as the base product catalog. |
| Effects/music data | `data/effects*.json`, `data/music-tracks.json` | Migrate only after licensing and product review. |
| Assets | Examples, fonts, music, speech bubbles, case studies | Migrate a small licensed seed set. Do not migrate generated outputs. |
| Remotion | Preview/export experiment and render worker | Do not migrate into core. Keep only as historical reference. |
| Generated files | `renders/`, `tmp/`, local outputs | Never migrate. Use object storage in production. |
| Vendor files | Local Pixi and ffmpeg-related vendor files | Do not migrate. Use package/deploy dependencies. |

## What To Preserve

### 1. Product Workflow

The MVP proves the core loop:

1. Import comic or webtoon panels.
2. Analyze panels and create a short campaign or montage plan.
3. Choose a visual direction.
4. Preview the result quickly in the browser.
5. Export a social-ready video.

This workflow is valuable, but KomaClip should express it with clear product
models: users, projects, assets, panels, clips, scenes, renders, and billing
entitlements.

### 2. Pixi As Visual Source Of Truth

The MVP documentation already points in the right direction: Pixi is the source
of truth for visual behavior. KomaClip should keep that decision.

The Pixi engine should be rebuilt in slices:

1. Scene contract normalization.
2. Texture loading and cover/focus camera.
3. Text rendering and layout.
4. One production active-panel effect.
5. One production transition.
6. Export frame capture.
7. Mobile and desktop preview QA.

This avoids importing a 14.8k-line renderer as a permanent black box.

### 3. Scene And Render Contracts

The schema files are one of the most production-ready ideas in the MVP.

KomaClip should migrate them as formal contracts and use them in three places:

1. Server-side validation before saving generated montage plans.
2. Worker-side validation before rendering.
3. Frontend type generation or runtime validation before preview.

Any AI output must be treated as untrusted and validated against these contracts.

### 4. Curated Visual Catalog

The `p2r.visual.v2` catalog is valuable because it is constrained. A small,
polished set is better for launch than a large experimental catalog.

KomaClip should migrate only product-ready catalog entries first:

1. Active-panel effects.
2. Text styles.
3. Text animations.
4. Transitions.
5. Motion presets.

Every visual entry should eventually have:

1. Stable id.
2. Display names per locale.
3. Renderer support status.
4. Performance budget.
5. Export QA status.
6. Allowed plan or entitlement.

### 5. Motion Design Research

The MVP docs around Pixi motion graphics, visual source of truth, and catalog
skeleton should be preserved as reference material. They contain important
creative direction: readability, panel focus recovery, text legibility, and
genre-specific packs.

These should become KomaClip production rules, not just prototype notes.

## What To Rewrite

### 1. Frontend Application

The MVP frontend is useful as a map of product behavior, but not as production
structure. KomaClip should split it into clear modules:

| Domain | New KomaClip Shape |
| --- | --- |
| Editor state | Project/clip state store with explicit save points |
| Uploads | Direct uploads to private object storage through Rails |
| Catalogs | Rails-served versioned catalogs with locale fields |
| AI campaign | Server job with validated structured output |
| Pixi preview | Modular renderer mounted in editor views |
| Export | Server-side render job for paid/final exports |
| Local preview export | Optional browser-only draft path, not entitlement-critical |

### 2. Backend

The Python server should not be migrated as a service. It has useful logic, but
its production responsibilities belong in Rails and Sidekiq.

Replace MVP endpoints as follows:

| MVP Endpoint | Production Replacement |
| --- | --- |
| `/api/analyze-panels` | Authenticated AI analysis job with user/project ownership |
| `/api/ai-campaign` | Authenticated campaign generation job with quotas |
| `/api/render` | Render creation endpoint that enqueues Sidekiq |
| `/api/encode-webm` | Optional draft utility or removed from production |
| `/api/settings/api-key` | Remove completely. Provider keys stay server-side. |

### 3. Rendering

Final exports should be generated by workers, not trusted browser state.

The browser may render fast previews using Pixi, but the final paid artifact
must be rendered from a saved, validated scene contract owned by the server.

The production pipeline should be:

1. Rails stores project assets and scene contract.
2. Rails validates ownership, plan, credits, and quotas.
3. Sidekiq render job loads private assets.
4. Headless Pixi renders frames or a stream.
5. FFmpeg creates MP4.
6. Output is stored privately in R2/S3.
7. Rails serves signed download URLs.

### 4. AI Integration

The MVP correctly experiments with structured AI output, but production must add
guardrails:

1. No client-provided provider keys.
2. No unvalidated AI JSON saved directly.
3. Strict schema validation.
4. Per-user and per-plan quotas.
5. Input size limits.
6. Moderation/safety checks where needed.
7. Audit trail for generated plans and render requests.

## What To Discard

### 1. Local API Key Storage

The MVP can save API keys through a local settings endpoint. KomaClip must not
ship this pattern.

Production provider keys belong in server environment variables, Rails
credentials, or managed secret storage. User-provided keys are out of scope for
the MVP unless the product intentionally becomes a bring-your-own-key tool.

### 2. Open Local Render Endpoints

The MVP render endpoints have no production-grade identity, ownership, quota, or
billing checks. KomaClip must render only after:

1. User authentication.
2. Project ownership verification.
3. Entitlement or credit verification.
4. Payload validation.
5. Rate-limit checks.
6. Idempotency key or duplicate-job protection.

### 3. Generated Render Outputs

Do not migrate `renders/`, `tmp/`, or any generated local media into the new
repository. They belong in object storage or local development output ignored by
Git.

### 4. Dual Renderer Product Path

The MVP contains both Pixi and Remotion paths. For KomaClip, dual renderers would
create parity bugs, QA cost, and user-visible inconsistencies.

Pixi remains the product renderer. Remotion can stay as archived research only.

## Security Findings

| Risk | MVP Behavior | KomaClip Requirement |
| --- | --- | --- |
| Authentication | Prototype server endpoints are local and open | Every project/render/admin action requires auth |
| Authorization | No durable ownership model | Every asset, clip, render, and project must be scoped to user/team |
| Billing trust | No paid entitlement model | Polar webhooks update Rails entitlements; redirects never grant access |
| Secrets | Local key-writing flow exists | Secrets stay server-side |
| File storage | Local filesystem renders/assets | Private R2/S3 with signed URLs |
| Payload trust | Large client payloads/base64 | Validate schema, enforce limits, reject unknown fields |
| Render abuse | No production quota/rate limit | Rack::Attack plus DB quotas and plan limits |
| Job safety | Local synchronous-ish flows | Idempotent Sidekiq jobs and retry-safe state transitions |

## Performance Findings

The MVP performance issues are mostly structural, not because Pixi is the wrong
choice.

Key risks:

1. `app.js` and the Pixi renderer are too large and mixed for long-term bundle
   health.
2. Base64 image payloads increase memory pressure and request size.
3. Local file rendering cannot scale across workers.
4. Browser MediaRecorder export is convenient, but not reliable enough as the
   only final export path.
5. Remotion/Pixi parity would double QA cost.

Production responses:

1. Split editor, catalog, upload, Pixi, AI, and render code.
2. Use direct uploads to object storage.
3. Lazy-load the editor and Pixi engine outside the public home page.
4. Keep catalogs versioned and cacheable.
5. Use workers for expensive AI and render tasks.
6. Track render duration, memory, queue latency, and failure reasons.

## Internationalization Impact

KomaClip is English-first with Spanish selectable.

The MVP catalog and UI strings should not be migrated as hardcoded English text.
When catalog data moves into KomaClip, each user-facing label should support at
least:

```json
{
  "name": {
    "en": "Manga Action Hook",
    "es": "Gancho de accion manga"
  }
}
```

Rails should own UI locale preference (`users.locale`). Project content language
should be separate from UI language because a Spanish-speaking creator may build
English campaign assets, or the reverse.

## Migration Order

### Phase 1: Preserve Knowledge

1. Document this inventory.
2. Copy or rewrite only the core schema/catalog knowledge.
3. Do not migrate executable MVP code yet.

### Phase 2: Contracts And Catalogs

1. Add schema files to KomaClip under `schemas/`.
2. Add curated catalog seed files under `data/catalogs/`.
3. Validate JSON in CI.
4. Add locale-ready labels.

### Phase 3: Product Models

1. Add projects.
2. Add assets and panels.
3. Add clips/scenes.
4. Add render jobs and render outputs.
5. Add plan/entitlement fields connected to Polar later.

### Phase 4: Editor Shell

1. Build authenticated editor route.
2. Add project creation and upload flow.
3. Load catalogs from Rails.
4. Mount Pixi preview lazily.

### Phase 5: Pixi Engine MVP

1. Rebuild renderer shell.
2. Support one simple scene contract.
3. Support one effect, one text style, one transition.
4. Verify preview parity across desktop and mobile.

### Phase 6: Server Export

1. Add render creation endpoint.
2. Enqueue Sidekiq render job.
3. Load private assets.
4. Render through Pixi.
5. Encode MP4.
6. Store output in R2/S3.

## Non-Negotiables

1. No entitlement logic in the frontend.
2. No final paid render based only on browser state.
3. No user-owned asset access without ownership checks.
4. No production provider keys in the browser.
5. No Remotion/Pixi dual product path for MVP.
6. No generated media committed to Git.
7. No new visual effect marked production-ready without preview and export QA.

## Acceptance Criteria For This Step

This inventory step is complete when:

1. The MVP has been classified into preserve, rewrite, and discard categories.
2. KomaClip has a committed migration inventory document.
3. No production code has been migrated prematurely.
4. The KomaClip CI remains green.

