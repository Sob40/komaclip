import { Controller } from "@hotwired/stimulus"

export default class extends Controller {
  static targets = ["form", "status"]
  static values = { delay: { type: Number, default: 700 } }

  connect() {
    this.save = this.save.bind(this)
    this.schedule = this.schedule.bind(this)
    this.element.addEventListener("input", this.schedule)
    this.element.addEventListener("change", this.schedule)
  }

  disconnect() {
    this.element.removeEventListener("input", this.schedule)
    this.element.removeEventListener("change", this.schedule)
    clearTimeout(this.timer)
  }

  schedule(event) {
    const target = event.target
    if (!target?.name?.startsWith("clip[")) return
    if (target.type === "hidden") return

    clearTimeout(this.timer)
    this.setStatus("saving")
    this.timer = setTimeout(this.save, this.delayValue)
  }

  async save() {
    if (!this.hasFormTarget) return

    try {
      const response = await fetch(this.formTarget.action, {
        method: "PATCH",
        body: new FormData(this.formTarget),
        headers: {
          "Accept": "application/json",
          "X-CSRF-Token": document.querySelector("meta[name='csrf-token']")?.content || ""
        },
        credentials: "same-origin"
      })

      if (!response.ok) throw new Error(`Autosave failed with ${response.status}`)
      this.setStatus("saved")
    } catch (error) {
      console.error(error)
      this.setStatus("error")
    }
  }

  setStatus(state) {
    if (!this.hasStatusTarget) return

    this.statusTarget.dataset.state = state
    this.statusTarget.textContent = this.statusTarget.dataset[`${state}Label`] || ""
  }
}
