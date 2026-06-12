import VisualLabPreviewController from "./controllers/visual_lab_preview_controller"

const registerVisualLabPreview = () => {
  window.Stimulus.register("visual-lab-preview", VisualLabPreviewController)
}

if (window.Stimulus) {
  registerVisualLabPreview()
} else {
  window.addEventListener("komaclip:stimulus-ready", registerVisualLabPreview, { once: true })
}
