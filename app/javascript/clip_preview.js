import ClipPreviewController from "./controllers/clip_preview_controller"

const registerClipPreview = () => {
  window.Stimulus.register("clip-preview", ClipPreviewController)
}

if (window.Stimulus) {
  registerClipPreview()
} else {
  window.addEventListener("komaclip:stimulus-ready", registerClipPreview, { once: true })
}
