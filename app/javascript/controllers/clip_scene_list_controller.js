import { Controller } from "@hotwired/stimulus"

export default class extends Controller {
  static targets = ["item"]
  static values = { reorderUrl: String }

  connect() {
    this.draggedPanelId = null
    this.pointerMove = this.pointerMove.bind(this)
    this.pointerEnd = this.pointerEnd.bind(this)
  }

  dragStart(event) {
    const item = event.target.closest("[data-panel-id]")
    if (!item || !event.target.closest("[data-clip-drag-handle]")) {
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
    this.previewController()?.reorderEditorShots(this.panelIds(), this.sceneLabels())
    await this.persistOrder()
  }

  dragEnd() {
    this.clearDragState()
  }

  pointerStart(event) {
    if (event.button && event.button !== 0) return

    const item = event.target.closest("[data-panel-id]")
    if (!item) return

    event.preventDefault()
    event.stopPropagation()
    this.draggedPanelId = item.dataset.panelId
    this.startOrder = this.panelIds().join(",")
    item.classList.add("is-dragging")
    event.currentTarget.setPointerCapture?.(event.pointerId)
    document.addEventListener("pointermove", this.pointerMove)
    document.addEventListener("pointerup", this.pointerEnd, { once: true })
    document.addEventListener("pointercancel", this.pointerEnd, { once: true })
  }

  pointerMove(event) {
    if (!this.draggedPanelId) return

    event.preventDefault()
    const dragged = this.itemTargets.find((item) => item.dataset.panelId === this.draggedPanelId)
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-panel-id]")
    if (!dragged || !target || !this.element.contains(target) || dragged === target) return

    const targetRect = target.getBoundingClientRect()
    const placeAfter = event.clientY > targetRect.top + targetRect.height / 2
    placeAfter ? target.after(dragged) : target.before(dragged)

    this.itemTargets.forEach((item) => item.classList.toggle("is-drop-target", item === target))
    this.refreshSceneNumbers()
  }

  async pointerEnd() {
    document.removeEventListener("pointermove", this.pointerMove)
    const changed = this.startOrder && this.startOrder !== this.panelIds().join(",")

    this.clearDragState()
    this.refreshSceneNumbers()
    if (!changed) return

    this.previewController()?.reorderEditorShots(this.panelIds(), this.sceneLabels())
    await this.persistOrder()
  }

  clearDragState() {
    this.draggedPanelId = null
    this.itemTargets.forEach((item) => item.classList.remove("is-dragging", "is-drop-target"))
  }

  refreshSceneNumbers() {
    this.itemTargets.forEach((item, index) => {
      const position = index + 1
      item.dataset.clipPosition = String(position)
      item.querySelector(".kc-scene-order").textContent = position
      const label = item.dataset.sceneTitleTemplate?.replace("%{position}", position) || `Escena ${position}`
      item.querySelector("[data-clip-scene-label]").textContent = label
      item.querySelector("[data-clip-scene-order-meta]").textContent = item.dataset.sceneOrderTemplate?.replace("%{position}", position) || `Orden ${position}`
      const handle = item.querySelector("[data-clip-drag-handle]")
      if (handle?.getAttribute("aria-label")) handle.setAttribute("aria-label", handle.getAttribute("aria-label").replace(/\d+$/, position))
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
      body: JSON.stringify({ panel_ids: this.panelIds() })
    })

    if (!response.ok) window.location.reload()
  }

  panelIds() {
    return this.itemTargets.map((item) => item.dataset.panelId)
  }

  sceneLabels() {
    return this.itemTargets.map((item) => item.querySelector("[data-clip-scene-label]")?.textContent?.trim()).filter(Boolean)
  }

  previewController() {
    return this.element.closest("[data-controller~='clip-preview']")?.komaclipPreview
  }
}
