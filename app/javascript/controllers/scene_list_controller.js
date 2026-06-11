import { Controller } from "@hotwired/stimulus"

export default class extends Controller {
  static targets = ["item"]
  static values = { reorderUrl: String }

  connect() {
    this.draggedPanelId = null
  }

  dragStart(event) {
    const item = event.target.closest("[data-panel-id]")
    if (!item || event.target.closest("input, select, textarea, form")) {
      event.preventDefault()
      return
    }

    this.draggedPanelId = item.dataset.panelId
    item.classList.add("is-dragging")
    event.dataTransfer.effectAllowed = "move"
    event.dataTransfer.setData("text/plain", this.draggedPanelId)
  }

  dragOver(event) {
    const item = event.target.closest("[data-panel-id]")
    if (!item || !this.draggedPanelId || item.dataset.panelId === this.draggedPanelId) return

    event.preventDefault()
    event.dataTransfer.dropEffect = "move"
    this.itemTargets.forEach((target) => {
      if (target !== item) target.classList.remove("is-drop-target")
    })
    item.classList.add("is-drop-target")
  }

  async drop(event) {
    const target = event.target.closest("[data-panel-id]")
    const dragged = this.itemTargets.find((item) => item.dataset.panelId === this.draggedPanelId)
    if (!target || !dragged || dragged === target) return

    event.preventDefault()
    const targetIndex = this.itemTargets.indexOf(target)
    const draggedIndex = this.itemTargets.indexOf(dragged)

    if (draggedIndex < targetIndex) {
      target.after(dragged)
    } else {
      target.before(dragged)
    }

    this.clearDragState()
    this.refreshSceneNumbers()
    await this.persistOrder()
  }

  dragEnd() {
    this.clearDragState()
  }

  clearDragState() {
    this.draggedPanelId = null
    this.itemTargets.forEach((item) => item.classList.remove("is-dragging", "is-drop-target"))
  }

  refreshSceneNumbers() {
    this.itemTargets.forEach((item, index) => {
      const position = index + 1
      item.querySelector(".kc-scene-order").textContent = position
      item.querySelector(".kc-scene-copy strong").textContent = item.dataset.sceneTitleTemplate?.replace("%{position}", position) || `Escena ${position}`
    })
  }

  async persistOrder() {
    const response = await fetch(this.reorderUrlValue, {
      method: "PATCH",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-CSRF-Token": document.querySelector("meta[name='csrf-token']").content
      },
      body: JSON.stringify({ panel_ids: this.itemTargets.map((item) => item.dataset.panelId) })
    })

    if (!response.ok) window.location.reload()
  }
}
