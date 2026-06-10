# Storage

KomaClip uses Active Storage for uploaded project assets.

## Current Scope

The first upload flow supports private image assets only:

1. JPG
2. PNG
3. WebP

Maximum file size is 25 MB. Audio, music, generated renders, and direct browser
uploads are intentionally out of scope for this first storage step.

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

