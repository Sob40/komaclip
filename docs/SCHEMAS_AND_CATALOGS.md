# Schemas And Catalogs

KomaClip imports the strongest contract assets from the Panel2Reels MVP while
keeping them separate from production exposure.

## Imported Files

| File | Purpose | Current Status |
| --- | --- | --- |
| `schemas/montage.schema.json` | Validates campaign/montage plans | Imported from MVP |
| `schemas/render-payload.schema.json` | Validates renderer payloads | Imported from MVP |
| `schemas/visual-preset.schema.json` | Validates visual preset shape | Imported from MVP |
| `data/catalogs/visual-catalog-v2.json` | Pixi visual catalog reference | Internal, not public-selectable |
| `data/catalogs/catalog-manifest.json` | KomaClip metadata around imported catalogs | Product-owned |

## Product Rules

The imported visual catalog is not automatically production-ready. It is a
strategic base for KomaClip's Pixi renderer and visual selector.

Before a catalog entry can be exposed to users, it needs:

1. KomaClip QA status.
2. Pixi preview support.
3. Server export support.
4. Performance budget review.
5. English and Spanish user-facing labels.
6. Plan or entitlement rules, if the entry is paid.

## Internationalization

KomaClip is English-first with Spanish selectable. The imported MVP catalog uses
English strings as source text. Spanish labels should be added through a
KomaClip-owned localization pass instead of ad hoc translation inside renderer
code.

The catalog manifest records:

1. `defaultLocale`: source language for imported labels.
2. `supportedLocales`: locales the product plans to expose.
3. `localizationStatus`: whether labels are ready for product UI.

## Validation

CI parses all files in `schemas/` and `data/catalogs/` and checks the base visual
catalog contract. This protects the repo from broken JSON, duplicate preset ids,
and accidental contract drift while the renderer is being rebuilt.

