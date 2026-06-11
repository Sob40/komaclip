import { Controller } from "@hotwired/stimulus"

export default class extends Controller {
  static targets = ["fallback", "image", "overlay"]

  fallback() {
    this.imageTarget.hidden = true
    if (this.hasOverlayTarget) this.overlayTarget.hidden = true
    this.fallbackTarget.hidden = false
  }
}
