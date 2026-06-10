# Scene Contract

KomaClip stores the first Pixi-ready scene contract on `clips.scene_contract`.

## Current Contract

The initial contract version is:

```text
komaclip.scene.v1
```

It is generated from the project's ordered panels and stored as JSONB.

```json
{
  "contractVersion": "komaclip.scene.v1",
  "renderer": "pixi",
  "format": {
    "width": 1080,
    "height": 1920,
    "fps": 30
  },
  "durationMs": 8000,
  "contentLocale": "en",
  "visual": {
    "presetId": "baseline-panel-sequence",
    "catalogContractVersion": "p2r.visual.v2"
  },
  "shots": []
}
```

Each shot stores stable references to the source panel and asset plus the
normalized crop. It does not expose public object storage URLs.

## Product Rule

A ready clip must have:

1. `contractVersion` equal to `komaclip.scene.v1`.
2. `renderer` equal to `pixi`.
3. At least one shot.
4. Contract duration matching `clips.duration_ms`.

This gives the future Pixi preview and render worker a durable backend-owned
source of truth.

## Next Steps

Future versions can add:

1. Signed preview URLs for browser Pixi.
2. Camera motion and text layers.
3. Visual preset ids from the imported catalog.
4. Render job creation from the saved contract.
5. Server-side JSON schema validation against `schemas/render-payload.schema.json`
   or a KomaClip-specific scene schema.

