import { Controller } from "@hotwired/stimulus"
import * as PIXI from "pixi.js"
import { AdvancedBloomFilter } from "pixi-filters/advanced-bloom"
import { GlowFilter } from "pixi-filters/glow"
import { GodrayFilter } from "pixi-filters/godray"
import { MotionBlurFilter } from "pixi-filters/motion-blur"
import { RGBSplitFilter } from "pixi-filters/rgb-split"
import { ShockwaveFilter } from "pixi-filters/shockwave"
import { PixiPreviewRenderer } from "../lib/panel2reels_pixi_preview_renderer"

const SAMPLE_TEXT = {
  effect: "IMPACT",
  text: "BAM!",
  transition: "NEXT",
  cameraMotion: "HOLD"
}

const PREVIEW_STYLES = [
  "manga-bw",
  "manga-color",
  "webtoon-clean",
  "western-vintage",
  "pulp-halftone",
  "noir-high-contrast",
  "romance-soft",
  "horror-ink",
  "scifi-neon",
  "fantasy-painterly",
  "cartoon-chibi",
  "realistic-painted",
  "sketch-rough",
  "ligne-claire"
]
const PIXI_FILTERS = Object.freeze({
  AdvancedBloomFilter,
  GlowFilter,
  GodrayFilter,
  MotionBlurFilter,
  RGBSplitFilter,
  ShockwaveFilter
})
const STYLE_SAMPLE_VERSION = "20260612ai1"
const STYLE_SAMPLE_IMAGES = Object.fromEntries(
  PREVIEW_STYLES.map((style) => [style, `/visual-lab/style-samples/${style}.webp?v=${STYLE_SAMPLE_VERSION}`])
)

export default class extends Controller {
  static targets = [
    "payload",
    "renderer",
    "card",
    "thumbnail",
    "status",
    "modal",
    "stage",
    "modalTitle",
    "modalMeta",
    "modalTags",
    "modalDescription",
    "backgroundButton",
    "curationForm",
    "generalCheckbox",
    "genreCheckbox",
    "curationNote",
    "saveStatus"
  ]

  static values = {
    curationUrlTemplate: String
  }

  connect() {
    this.presets = JSON.parse(this.payloadTarget.textContent)
    this.queue = []
    this.rendered = new Set()
    this.failed = new Set()
    this.isRendering = false
    this.renderer = null
    this.liveRenderer = null
    this.currentPreset = null
    this.currentPreviewStyle = "manga-bw"
    this.handleKeydown = this.handleKeydown.bind(this)
    this.observer = new IntersectionObserver((entries) => this.handleIntersections(entries), {
      rootMargin: "420px 0px"
    })
    this.cardTargets.forEach((card) => this.observer.observe(card))
    this.cardTargets.slice(0, 6).forEach((card) => this.enqueue(card))
    this.paintSampleButtons()
    this.processQueue()
    document.addEventListener("keydown", this.handleKeydown)
  }

  disconnect() {
    this.observer?.disconnect()
    document.removeEventListener("keydown", this.handleKeydown)
    this.renderer?.destroy()
    this.liveRenderer?.destroy()
    this.renderer = null
    this.liveRenderer = null
  }

  async openMotion(event) {
    const card = event.currentTarget.closest("[data-preset-id]")
    const preset = this.presets[card?.dataset.presetId]
    if (!preset) return

    event.preventDefault()
    this.currentPreset = preset
    this.currentPreviewStyle = this.preferredPreviewStyle(preset)
    this.modalTarget.hidden = false
    this.element.classList.add("is-previewing-motion")
    this.modalTitleTarget.textContent = preset.name
    this.modalMetaTarget.textContent = [preset.type, preset.visual_category, preset.mechanic].filter(Boolean).join(" · ")
    this.modalTagsTarget.textContent = (preset.tags || []).slice(0, 12).join(", ")
    this.modalDescriptionTarget.textContent = preset.ai_description || preset.english_description || ""
    this.populateCurationForm(preset)
    this.updateBackgroundButtons()

    const renderer = await this.motionRenderer()
    await renderer.loadScene(this.sceneForPreset(preset, { previewStyle: this.currentPreviewStyle }), { autoplay: true, loop: true })
    this.applyMotionPerformanceReport(renderer)
  }

  async selectBackground(event) {
    event.preventDefault()
    const style = event.currentTarget.dataset.previewStyle
    if (!this.currentPreset || !PREVIEW_STYLES.includes(style)) return

    this.currentPreviewStyle = style
    this.updateBackgroundButtons()
    const renderer = await this.motionRenderer()
    await renderer.loadScene(this.sceneForPreset(this.currentPreset, { previewStyle: style }), { autoplay: true, loop: true })
    this.applyMotionPerformanceReport(renderer)
  }

  async saveCuration(event) {
    event.preventDefault()
    if (!this.currentPreset || !this.hasCurationFormTarget) return

    this.saveStatusTarget.textContent = this.saveStatusTarget.dataset.savingLabel || "Saving..."

    const formData = new FormData(this.curationFormTarget)
    if (!this.generalCheckboxTarget.checked) formData.set("visual_preset_curation[general]", "0")
    if (!formData.has("visual_preset_curation[genres][]")) formData.append("visual_preset_curation[genres][]", "")

    try {
      const response = await fetch(this.curationUrlFor(this.currentPreset), {
        method: "PATCH",
        headers: {
          "Accept": "application/json",
          "X-CSRF-Token": document.querySelector("meta[name='csrf-token']")?.content || ""
        },
        body: formData
      })
      const payload = await response.json()
      if (!response.ok) throw new Error((payload.errors || ["Unable to save curation"]).join(", "))

      this.currentPreset.curation_general = payload.general
      this.currentPreset.curated_genres = payload.genres || []
      this.currentPreset.curation_notes = payload.notes || ""
      this.presets[this.currentPreset.id] = this.currentPreset
      this.saveStatusTarget.textContent = this.saveStatusTarget.dataset.savedLabel || "Saved"
    } catch (error) {
      console.error("Visual Lab curation failed", this.currentPreset.id, error)
      this.saveStatusTarget.textContent = this.saveStatusTarget.dataset.errorLabel || "Save failed"
    }
  }

  closeMotion(event) {
    event?.preventDefault()
    this.liveRenderer?.pause()
    if (this.hasModalTarget) this.modalTarget.hidden = true
    this.element.classList.remove("is-previewing-motion")
  }

  handleKeydown(event) {
    if (event.key === "Escape" && this.hasModalTarget && !this.modalTarget.hidden) {
      this.closeMotion(event)
    }
  }

  handleIntersections(entries) {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return

      const card = entry.target
      this.observer.unobserve(card)
      this.enqueue(card)
    })
    this.processQueue()
  }

  enqueue(card) {
    const presetId = card.dataset.presetId
    if (!presetId || this.rendered.has(presetId) || this.failed.has(presetId)) return
    if (this.queue.some((queued) => queued.dataset.presetId === presetId)) return

    this.queue.push(card)
  }

  async processQueue() {
    if (this.isRendering) return

    this.isRendering = true
    try {
      while (this.queue.length) {
        const card = this.queue.shift()
        await this.renderCard(card)
        await this.nextPreviewFrame()
      }
    } finally {
      this.isRendering = false
    }
  }

  async renderCard(card) {
    const preset = this.presets[card.dataset.presetId]
    if (!preset) return

    const preview = card.querySelector(".kc-visual-preset-preview")
    const image = card.querySelector("[data-visual-lab-preview-target='thumbnail']")
    const status = card.querySelector("[data-visual-lab-preview-target='status']")
    preview?.classList.add("is-rendering")
    status.textContent = status.dataset.renderingLabel || status.textContent

    try {
      const renderer = await this.previewRenderer()
      const scene = this.sceneForPreset(preset)
      const captureAt = this.captureTimeFor(preset)

      await renderer.loadScene(scene, { autoplay: false, loop: false })
      renderer.renderFrame(captureAt)
      const dataUrl = await this.captureRenderer(renderer)

      image.src = dataUrl
      preview?.classList.add("has-real-preview")
      status.textContent = ""
      this.rendered.add(preset.id)
      this.applyCardPerformanceReport(card, renderer)
    } catch (error) {
      console.error("Visual Lab preview failed", preset.id, error)
      status.textContent = "Preview unavailable"
      preview?.classList.add("has-preview-error")
      this.failed.add(preset.id)
    } finally {
      preview?.classList.remove("is-rendering")
    }
  }

  nextPreviewFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()))
  }

  async previewRenderer() {
    if (this.renderer) return this.renderer

    this.renderer = new PixiPreviewRenderer({ mount: this.rendererTarget, pixi: PIXI, pixiFilters: PIXI_FILTERS, qualityProfile: "thumbnail" })
    await this.renderer.init()
    this.renderer.pause()
    return this.renderer
  }

  async motionRenderer() {
    if (this.liveRenderer) return this.liveRenderer

    this.liveRenderer = new PixiPreviewRenderer({ mount: this.stageTarget, pixi: PIXI, pixiFilters: PIXI_FILTERS, qualityProfile: "preview" })
    await this.liveRenderer.init()
    return this.liveRenderer
  }

  async captureRenderer(renderer) {
    const canvas = renderer.app?.canvas
    if (canvas?.toDataURL) {
      const dataUrl = canvas.toDataURL("image/webp", 0.76)
      if (dataUrl && dataUrl !== "data:,") return dataUrl
    }

    const extract = renderer.app?.renderer?.extract
    if (extract?.base64) {
      try {
        return await extract.base64({ target: renderer.app.stage, format: "webp", quality: 0.76 })
      } catch {
        return await extract.base64(renderer.app.stage)
      }
    }

    return canvas?.toDataURL("image/webp", 0.76)
  }

  applyCardPerformanceReport(card, renderer) {
    const report = renderer?.performanceReport?.()
    if (!card || !report) return

    const stats = renderer.frameStats || {}
    const objects = stats.objectStats || {}
    const textureBytes = renderer.textureMemoryStats?.().totalBytes || 0

    card.dataset.performanceKind = "thumbnail"
    card.dataset.performanceProfile = report.profile || "thumbnail"
    card.dataset.performanceStatus = report.status || "unknown"
    card.dataset.performancePressure = Number(report.pressure || 0).toFixed(2)
    card.dataset.performanceBottlenecks = (report.bottlenecks || []).join(",")
    card.dataset.qualityGovernorLevel = String(report.governor?.level || 0)
    card.dataset.qualityGovernorActive = String(report.governor?.active === true)
    card.dataset.performanceAverageFrameMs = Number(stats.averageMs || 0).toFixed(2)
    card.dataset.performanceLastFrameMs = Number(stats.lastMs || 0).toFixed(2)
    card.dataset.performanceDisplayObjects = String(objects.displayObjects || 0)
    card.dataset.performanceGraphics = String(objects.graphics || 0)
    card.dataset.performanceFilters = String(objects.filters || 0)
    card.dataset.performanceTextureMb = (textureBytes / 1024 / 1024).toFixed(1)
    card.classList.toggle("is-performance-warn", report.status === "warn")
    card.classList.toggle("is-performance-hot", report.status === "hot")
  }

  applyMotionPerformanceReport(renderer) {
    const report = renderer?.performanceReport?.()
    if (!report) return

    this.element.dataset.motionPerformanceProfile = report.profile || "preview"
    this.element.dataset.motionPerformanceStatus = report.status || "unknown"
    this.element.dataset.motionPerformancePressure = Number(report.pressure || 0).toFixed(2)
    this.element.dataset.motionPerformanceBottlenecks = (report.bottlenecks || []).join(",")
    this.element.dataset.motionQualityGovernorLevel = String(report.governor?.level || 0)
    this.element.dataset.motionQualityGovernorActive = String(report.governor?.active === true)
  }

  sceneForPreset(preset, options = {}) {
    const previewStyle = options.previewStyle || this.preferredPreviewStyle(preset)
    const panel = this.panelForPreset(preset, 0, previewStyle)
    const nextPanel = this.panelForPreset(preset, 1, previewStyle)
    const contract = this.contractForPreset(preset)
    const base = {
      version: 1,
      size: { width: 720, height: 1280, fps: 30 },
      duration: Number(preset.preview_scene?.duration) || 3.2,
      panel: { src: panel },
      nextPanel: { src: nextPanel },
      textStyle: null,
      activeEffects: [],
      transitionOut: null,
      tags: preset.tags || []
    }

    if (preset.type === "text") {
      base.textStyle = contract
    } else if (preset.type === "transition") {
      base.transitionOut = contract
    } else {
      base.activeEffects = [contract]
    }

    return base
  }

  contractForPreset(preset) {
    const parameters = preset.parameters || {}
    const layout = parameters.layout || preset.mechanic || preset.visual_category
    const sampleText = preset.preview_scene?.sampleText || SAMPLE_TEXT[preset.type] || "PREVIEW"
    const common = {
      id: preset.id,
      visualPresetId: preset.id,
      title: preset.name,
      layout,
      catalogLayout: layout,
      accent: parameters.accent || this.accentForPreset(preset),
      tags: preset.tags || [],
      englishDescription: preset.english_description,
      parameters
    }

    if (preset.type === "text") {
      return {
        ...common,
        kind: "textStyle",
        type: "textStyle",
        text: sampleText,
        fill: parameters.fill,
        ink: parameters.ink,
        font: parameters.font,
        position: "center_safe",
        size: "large"
      }
    }

    if (preset.type === "transition") {
      return {
        ...common,
        kind: "transitionOut",
        type: "transition",
        transitionType: parameters.transitionType || parameters.structure || preset.mechanic,
        effectType: parameters.mechanic || preset.mechanic
      }
    }

    return {
      ...common,
      kind: preset.type === "cameraMotion" ? "cameraMotion" : "activeEffect",
      type: preset.type,
      effectType: parameters.effectType || parameters.structure || parameters.mechanic || preset.mechanic
    }
  }

  captureTimeFor(preset) {
    const duration = Number(preset.preview_scene?.duration) || 3.2
    if (preset.type === "transition") return duration * 0.78
    if (preset.type === "text") return duration * 0.42

    return duration * 0.55
  }

  panelForPreset(preset, variant, previewStyle = null) {
    const style = previewStyle || this.styleForTone(preset.preview_tone) || "manga-bw"
    const sampleImage = STYLE_SAMPLE_IMAGES[style]
    if (sampleImage) return sampleImage

    const scene = this.sampleSceneForGenre(preset.preview_tone || "general", variant)
    const { palette, shapes } = scene
    const [, mid, dark] = variant ? [palette[2], palette[1], palette[0]] : palette
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280" viewBox="0 0 720 1280">
        <defs>
          <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="${dark}"/>
            <stop offset="0.58" stop-color="${mid}"/>
            <stop offset="1" stop-color="#050509"/>
          </linearGradient>
          <pattern id="dots" width="34" height="34" patternUnits="userSpaceOnUse">
            <circle cx="4" cy="4" r="1.7" fill="#fff" opacity="0.16"/>
          </pattern>
        </defs>
        <rect width="720" height="1280" fill="url(#bg)"/>
        <rect width="720" height="1280" fill="url(#dots)"/>
        <rect x="54" y="96" width="612" height="1048" rx="10" fill="#fff" opacity="0.055" stroke="#fff" stroke-opacity="0.2" stroke-width="3"/>
        ${shapes}
        <rect x="104" y="190" width="512" height="696" rx="8" fill="#050509" opacity="0.18" stroke="#fff" stroke-opacity="0.1"/>
      </svg>
    `

    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  }

  sampleSceneForGenre(genre, variant = 0) {
    const scenes = {
      general: {
        palette: ["#d8d4c8", "#181923", "#07070d"],
        shapes: '<path d="M96 314 H624 M96 444 H624 M96 574 H624 M96 704 H624 M96 834 H624" stroke="#fff" stroke-width="2" opacity="0.08"/>'
      },
      action: {
        palette: ["#f2c84d", "#35120f", "#07070d"],
        shapes: '<path d="M76 314 L642 236 M88 492 L626 392 M104 766 L612 656" stroke="#fff" stroke-width="5" opacity="0.16"/><path d="M118 980 L612 850" stroke="#f2c84d" stroke-width="7" opacity="0.18"/>'
      },
      romance: {
        palette: ["#ff9ed1", "#301a34", "#080711"],
        shapes: '<path d="M128 344 C236 250 484 250 594 344" fill="none" stroke="#fff" stroke-width="4" opacity="0.13"/><circle cx="214" cy="658" r="92" fill="#ff9ed1" opacity="0.12"/><circle cx="510" cy="496" r="128" fill="#fff" opacity="0.06"/>'
      },
      horror: {
        palette: ["#e73762", "#111015", "#030305"],
        shapes: '<path d="M112 250 L198 1104 M358 190 L300 1110 M586 250 L500 1098" stroke="#e73762" stroke-width="4" opacity="0.12"/><path d="M100 822 C220 770 318 912 430 842 C512 792 580 816 630 874" fill="none" stroke="#fff" stroke-width="3" opacity="0.1"/>'
      },
      thriller: {
        palette: ["#b9bcc9", "#151923", "#050509"],
        shapes: '<path d="M96 338 H624 M96 762 H624" stroke="#fff" stroke-width="3" opacity="0.12"/><path d="M188 214 L532 1012" stroke="#b9bcc9" stroke-width="5" opacity="0.11"/><rect x="176" y="388" width="368" height="264" fill="#000" opacity="0.16"/>'
      },
      scifi: {
        palette: ["#55f0c8", "#092633", "#05070d"],
        shapes: '<path d="M128 312 H590 M128 444 H532 M128 576 H612" stroke="#55f0c8" stroke-width="3" opacity="0.16"/><circle cx="470" cy="474" r="126" fill="none" stroke="#fff" stroke-width="4" opacity="0.1"/><path d="M168 918 H552" stroke="#fff" stroke-width="5" opacity="0.11"/>'
      },
      fantasy: {
        palette: ["#c8a7ff", "#231d38", "#080711"],
        shapes: '<path d="M124 812 C210 612 326 670 364 466 C400 270 526 288 594 190" fill="none" stroke="#c8a7ff" stroke-width="5" opacity="0.14"/><circle cx="264" cy="394" r="112" fill="#fff" opacity="0.06"/><circle cx="486" cy="730" r="150" fill="#c8a7ff" opacity="0.08"/>'
      },
      comedy: {
        palette: ["#ffbd4a", "#352006", "#14081b"],
        shapes: '<circle cx="212" cy="412" r="112" fill="#ffbd4a" opacity="0.12"/><circle cx="520" cy="520" r="148" fill="#fff" opacity="0.06"/><path d="M130 910 C250 984 454 984 590 900" fill="none" stroke="#ffbd4a" stroke-width="7" opacity="0.16"/>'
      },
      drama: {
        palette: ["#d8d4c8", "#20202a", "#08080e"],
        shapes: '<path d="M126 288 H594 M126 418 H594 M126 548 H594 M126 858 H594" stroke="#fff" stroke-width="3" opacity="0.1"/><rect x="126" y="634" width="468" height="140" fill="#fff" opacity="0.055"/>'
      },
      webtoon: {
        palette: ["#7aa7ff", "#101a35", "#07070d"],
        shapes: '<rect x="116" y="180" width="488" height="280" fill="#fff" opacity="0.055"/><rect x="116" y="500" width="488" height="280" fill="#fff" opacity="0.045"/><rect x="116" y="820" width="488" height="260" fill="#fff" opacity="0.04"/>'
      },
      promo: {
        palette: ["#ff7bd3", "#171e35", "#07070d"],
        shapes: '<rect x="126" y="254" width="468" height="194" fill="#ff7bd3" opacity="0.09"/><rect x="126" y="512" width="468" height="92" fill="#fff" opacity="0.07"/><rect x="126" y="664" width="310" height="92" fill="#55f0c8" opacity="0.08"/>'
      }
    }
    const scene = scenes[genre] || scenes.general

    if (!variant) return scene

    return {
      ...scene,
      palette: [scene.palette[2], scene.palette[1], scene.palette[0]]
    }
  }

  paintSampleButtons() {
    this.backgroundButtonTargets.forEach((button) => {
      const thumb = button.querySelector("[data-style-sample]")
      const style = button.dataset.previewStyle
      if (thumb) thumb.style.backgroundImage = `url("${STYLE_SAMPLE_IMAGES[style] || this.panelForPreset({}, 0, style)}")`
    })
  }

  preferredPreviewStyle(preset) {
    if (preset.type === "text") return "webtoon-clean"
    if (preset.type === "transition") return "western-vintage"
    return this.styleForTone(preset.preview_tone) || "manga-bw"
  }

  styleForTone(tone) {
    return {
      action: "manga-bw",
      horror: "horror-ink",
      romance: "romance-soft",
      scifi: "scifi-neon",
      webtoon: "webtoon-clean",
      comedy: "cartoon-chibi",
      promo: "pulp-halftone",
      editorial: "western-vintage"
    }[tone]
  }

  updateBackgroundButtons() {
    this.backgroundButtonTargets.forEach((button) => {
      button.classList.toggle("is-active", button.dataset.previewStyle === this.currentPreviewStyle)
    })
  }

  populateCurationForm(preset) {
    if (!this.hasCurationFormTarget) return

    this.curationFormTarget.action = this.curationUrlFor(preset)
    this.generalCheckboxTarget.checked = preset.curation_general === true
    const curatedGenres = new Set(preset.curated_genres || [])
    this.genreCheckboxTargets.forEach((checkbox) => {
      checkbox.checked = curatedGenres.has(checkbox.value)
    })
    this.curationNoteTarget.value = preset.curation_notes || ""
    this.saveStatusTarget.dataset.savingLabel ||= "Guardando..."
    this.saveStatusTarget.dataset.savedLabel ||= "Guardado"
    this.saveStatusTarget.dataset.errorLabel ||= "Error al guardar"
    this.saveStatusTarget.textContent = this.saveStatusTarget.dataset.defaultLabel || this.saveStatusTarget.textContent
  }

  curationUrlFor(preset) {
    return this.curationUrlTemplateValue.replace("__PRESET_ID__", encodeURIComponent(preset.id))
  }

  accentForPreset(preset) {
    return {
      action: "#ffd95a",
      horror: "#ff3d7f",
      romance: "#ff9ed1",
      scifi: "#55f0c8",
      webtoon: "#7aa7ff",
      comedy: "#ffbd4a",
      promo: "#ff7bd3",
      editorial: "#f8f6ff"
    }[preset.preview_tone] || "#ffd95a"
  }

  escapeSvg(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
  }
}
