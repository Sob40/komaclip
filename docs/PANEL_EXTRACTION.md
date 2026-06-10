# Panel Extraction

KomaClip's first extraction step creates a full-page panel from an uploaded image
asset.

## Current Scope

The current flow is intentionally conservative:

1. User uploads a private image asset.
2. User opens the asset detail.
3. User creates one panel from the asset.
4. KomaClip stores a normalized full-page crop.

The stored crop shape is:

```json
{
  "unit": "normalized",
  "x": 0.0,
  "y": 0.0,
  "width": 1.0,
  "height": 1.0
}
```

This creates the durable contract needed by the editor and Pixi renderer without
pretending automatic panel detection is ready.

## Security

Panel creation resolves both project and source asset through `Current.user`, so
a user cannot create, view, or delete panels for another user's project.

## Next Steps

Future extraction can add:

1. Manual crop editing.
2. Multiple panels from one page.
3. AI or computer vision assisted panel detection.
4. Focus metadata for camera movement.
5. QA warnings for tiny, invalid, or overlapping crops.

