# Product Models

This document describes the first durable product tables for KomaClip.

## Ownership Chain

```text
User
  -> Project
    -> ProjectAsset
    -> Panel
    -> Clip
      -> ClipRender
```

Rails owns identity, authorization, quotas, billing state, project state, and
render state. The frontend can preview quickly, but it does not own final render
entitlements or output state.

## Models

| Model | Purpose |
| --- | --- |
| `Project` | Creator workspace for a comic/webtoon promo job. Owns content language and lifecycle. |
| `ProjectAsset` | Uploaded or generated media reference. Will point to private object storage. |
| `Panel` | Ordered panel derived from a project asset. Stores crop/focus metadata. |
| `Clip` | Ordered social clip scene plan. Stores the scene contract used by Pixi. |
| `ClipRender` | Server-owned render request/output state for a clip. |

## Locale Separation

`users.locale` controls interface language.

`projects.content_locale` controls the language of a project's generated content.
These must remain separate: a Spanish-speaking creator may create English promo
clips, and an English-speaking creator may create Spanish promo clips.

## Security Rules

Rows that include `user_id` must match the owner of the associated project. This
is intentionally redundant for `ProjectAsset` and `ClipRender` because those rows
are security-sensitive and will be queried by owner, quota, storage, and billing
flows.

Every future controller or job should verify ownership at the project boundary
before accessing assets, clips, or renders.

## Render Boundary

`ClipRender` is a request/output record, not the renderer implementation. Render
execution belongs in Sidekiq jobs. The only renderer accepted for the MVP is
`pixi`, matching the decision that Pixi is the visual source of truth.

