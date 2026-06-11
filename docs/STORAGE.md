# Storage

KomaClip uses Active Storage for uploaded project assets.

## Current Scope

The first upload flow supports private image assets only:

1. JPG
2. PNG
3. WebP

Maximum file size is 25 MB. Audio, music, generated renders, and direct browser
uploads are intentionally out of scope for this first storage step.

Uploads are validated by content, not by filename alone:

1. Marcel detects the MIME type from file bytes with no filename hint.
2. MiniMagick decodes the image and extracts width/height.
3. `ProjectAsset.metadata["image"]` stores the decoded dimensions.
4. Active Storage variants use `:mini_magick` to avoid depending on libvips.

This rejects files that spoof an image extension or browser-provided
`Content-Type`. Production hosts must provide ImageMagick's `magick` binary; if
it is missing, uploads fail closed instead of accepting unverified media.

## Ownership

Uploads are nested under a project:

```text
POST /projects/:project_id/assets
```

Controllers always resolve the project through `Current.user.projects`, so a user
cannot upload to, view, download, or delete another user's assets.

## Environments

Development and test use local disk storage.

Production chooses the service through:

```text
ACTIVE_STORAGE_SERVICE=r2
```

The `r2` service expects:

```text
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_BUCKET
R2_ENDPOINT
```

Leaving `ACTIVE_STORAGE_SERVICE` unset keeps production on local storage, which
is useful for boot smoke tests but not acceptable for a real deployment.

## Security Rules

1. Keep uploaded originals private.
2. Resolve every asset through the owning project.
3. Serve downloads through authenticated Rails routes.
4. Use short-lived Active Storage signed blob URLs after authorization.
5. Do not expose bucket URLs directly in product views.
6. Validate uploaded media by byte signature and image decode before marking it
   ready.
