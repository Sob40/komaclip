import { Controller } from "@hotwired/stimulus"
import * as PIXI from "pixi.js"
import { Application, Assets, Container, Graphics, Sprite, Text, TextStyle } from "pixi.js"
import { PixiPreviewRenderer } from "../lib/panel2reels_pixi_preview_renderer"

const TRANSITION_MS = 520
const EDITOR_FIELD_MAP = {
  scene_motion: "sceneMotion",
  scene_bubble: "sceneBubble",
  scene_position: "scenePosition",
  scene_size: "sceneSize",
  effect_intensity: "effectIntensity",
  scene_mode: "sceneMode"
}
const MIN_SHOT_DURATION_MS = 700
const MAX_SHOT_DURATION_MS = 8000
const DEFAULT_MUSIC_VOLUME = 42
const MUSIC_FADE_OUT_MS = 2000

export default class extends Controller {
  static targets = ["stage", "payload", "status", "playButton", "playLabel", "progress", "time", "currentTitle", "platformFrame"]

  async connect() {
    this.payload = JSON.parse(this.payloadTarget.textContent)
    this.frame = { width: 360, height: 640 }
    this.currentShotIndex = 0
    this.playheadMs = 0
    this.isPlaying = false
    this.hasCompleted = false
    this.audio = null
    this.audioUnlocked = false
    this.textures = new Map()
    this.fxTextures = new Map()
    this.referenceRenderer = null
    this.tick = this.tick.bind(this)
    this.handleEditorChange = this.handleEditorChange.bind(this)
    this.element.dataset.previewFxProfile = this.genreProfile()

    this.shots = this.normalizedShots()
    this.durationMs = this.clipDurationMs()
    await this.loadPreviewFonts()
    await this.setupReferenceRenderer()
    if (!this.referenceRenderer) await this.setupLocalRenderer()
    await this.loadTextures()
    this.setupAudio()
    this.app.ticker.add(this.tick)
    if (!this.isPlaying) this.app.ticker.stop()
    this.element.addEventListener("input", this.handleEditorChange)
    this.element.addEventListener("change", this.handleEditorChange)
    this.startedAt = performance.now()
    this.element.komaclipPreview = this
    this.renderAt(0)
    this.updatePlaybackControls()
  }

  disconnect() {
    this.stopAudio()
    this.app?.ticker?.remove(this.tick)
    if (this.referenceRenderer) this.app?.ticker?.remove(this.referenceRenderer.renderTick)
    this.element.removeEventListener("input", this.handleEditorChange)
    this.element.removeEventListener("change", this.handleEditorChange)
    this.referenceRenderer?.destroy()
    if (!this.referenceRenderer) this.app?.destroy(true)
    this.textures?.clear()
    this.fxTextures?.clear()
  }

  async setupReferenceRenderer() {
    try {
      this.referenceRenderer = new PixiPreviewRenderer({ mount: this.stageTarget, pixi: PIXI })
      await this.referenceRenderer.init()
      this.referenceRenderer.pause()
      this.app = this.referenceRenderer.app
      this.app?.ticker?.remove(this.referenceRenderer.renderTick)
      const canvas = this.stageTarget.querySelector("canvas")
      if (canvas) {
        canvas.className = "h-full w-full"
        canvas.style.display = "block"
        canvas.style.maxWidth = "100%"
      }
      await this.referenceRenderer.loadScene(this.referenceScene(), { autoplay: false, loop: false })
      this.referenceRenderer.pause()
      this.element.dataset.previewRenderer = "panel2reels-mvp"
    } catch (error) {
      console.error("Panel2Reels MVP renderer failed, falling back to KomaClip renderer", error)
      this.referenceRenderer?.destroy()
      this.referenceRenderer = null
      this.element.dataset.previewRenderer = "komaclip-fallback"
    }
  }

  async setupLocalRenderer() {
    this.app = new Application()
    await this.app.init({
      width: this.frame.width,
      height: this.frame.height,
      background: "#09090b",
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true
    })

    this.stageTarget.replaceChildren(this.app.canvas)
    this.app.canvas.className = "h-full w-full"
    this.app.canvas.style.display = "block"
    this.app.canvas.style.maxWidth = "100%"
  }

  async loadPreviewFonts() {
    if (!document.fonts?.load) return

    await Promise.all([
      document.fonts.load("400 96px Bangers"),
      document.fonts.load("400 96px Luckiest Guy"),
      document.fonts.load("400 64px Bungee"),
      document.fonts.load("700 34px Comic Neue")
    ])
  }

  togglePlayback() {
    if (this.isPlaying) {
      this.pause()
    } else {
      this.play()
    }
  }

  restart() {
    this.seekTo(0)
    this.play()
  }

  setPreviewPlatform(event) {
    if (!this.hasPlatformFrameTarget) return

    this.platformFrameTarget.dataset.platform = event.target.value || "instagram_reels"
  }

  selectEditorShot(event) {
    if (!event.target.checked) return

    this.openEditorShot(event.target.value, event.target)
  }

  toggleEditorShot(event) {
    const selectorId = event.currentTarget.dataset.shotSelectorId
    if (!selectorId) return

    const selector = this.element.querySelector(`#${CSS.escape(selectorId)}`)
    if (!selector) return

    if (selector.checked) {
      selector.checked = false
      return
    }

    this.openEditorShot(selector.value, selector)
  }

  toggleEditorShotFromKeyboard(event) {
    if (!["Enter", " "].includes(event.key)) return

    event.preventDefault()
    this.toggleEditorShot(event)
  }

  openEditorShot(panelId, selector = null) {
    this.element.querySelectorAll(".kc-clip-shot-selector").forEach((input) => {
      input.checked = selector ? input === selector : String(input.value) === String(panelId)
    })

    const index = this.shots.findIndex((shot) => String(shot.panelId) === String(panelId))
    if (index >= 0) this.seekToShot(index)
  }

  stopPanelToggle(event) {
    event.stopPropagation()
  }

  pauseForDurationEdit(event) {
    event.stopPropagation()
    if (this.isPlaying) this.pause()
  }

  selectDurationValue(event) {
    this.pauseForDurationEdit(event)
    const input = event.currentTarget
    const selectValue = () => {
      input.select?.()
      input.setSelectionRange?.(0, String(input.value || "").length)
    }

    window.requestAnimationFrame(() => {
      selectValue()
      window.setTimeout(selectValue, 0)
    })
  }

  adjustDuration(event) {
    event.preventDefault()
    event.stopPropagation()
    if (this.isPlaying) this.pause()

    const editor = event.currentTarget.closest("[data-duration-editor]")
    const input = editor?.querySelector("[data-duration-input-for]")
    if (!input) return

    const deltaMs = (Number(event.currentTarget.dataset.durationDelta) || 0) * 1000
    const nextMs = this.clampedDurationMs(this.durationInputMs(input.value) + deltaMs)
    input.value = this.durationInputValue(nextMs)
    input.focus?.({ preventScroll: true })
    input.select?.()
    input.dispatchEvent(new Event("input", { bubbles: true }))
    input.dispatchEvent(new Event("change", { bubbles: true }))
  }

  play() {
    if (this.isPlaying) return

    if (this.hasCompleted || this.playheadMs >= this.durationMs) this.seekTo(0)
    this.isPlaying = true
    this.startedAt = performance.now() - this.playheadMs
    this.app?.ticker?.start()
    this.playAudio()
    this.updatePlaybackControls()
  }

  pause() {
    if (!this.isPlaying) return

    this.playheadMs = this.currentPlayheadMs()
    this.isPlaying = false
    this.pauseAudio()
    this.updatePlaybackControls()
  }

  seekToShot(index) {
    const shot = this.shots[index]
    if (!shot) return

    this.currentShotIndex = index
    this.seekTo(shot.startMs)
  }

  seekTo(ms) {
    this.playheadMs = this.normalizedPlayhead(ms)
    this.startedAt = performance.now() - this.playheadMs
    this.syncAudioTime()
    this.renderAt(this.playheadMs)
  }

  tick() {
    if (!this.isPlaying) return

    const playhead = this.currentPlayheadMs()
    this.playheadMs = playhead
    this.renderAt(playhead)
    if (playhead >= this.durationMs) this.completePlayback()
  }

  currentPlayheadMs() {
    if (!this.durationMs) return 0

    return Math.min(this.durationMs, Math.max(0, performance.now() - this.startedAt))
  }

  normalizedPlayhead(ms) {
    if (!this.durationMs) return 0
    const value = Math.max(0, ms)

    return Math.min(value, this.durationMs)
  }

  completePlayback() {
    this.playheadMs = this.durationMs
    this.hasCompleted = true
    this.isPlaying = false
    this.pauseAudio()
    this.app?.ticker?.stop()
    this.renderAt(this.playheadMs)
    this.updatePlaybackControls()
  }

  normalizedShots() {
    const shots = this.payload.contract.shots || []
    let cursor = 0

    return shots.map((shot, index) => {
      const durationMs = Math.max(700, Number(shot.durationMs) || Number(shot.endMs) - Number(shot.startMs) || 1800)
      const startMs = Number.isFinite(Number(shot.startMs)) ? Number(shot.startMs) : cursor
      const endMs = Number.isFinite(Number(shot.endMs)) ? Number(shot.endMs) : startMs + durationMs
      cursor = endMs

      return {
        ...shot,
        startMs,
        endMs,
        durationMs: Math.max(700, endMs - startMs),
        asset: this.payload.assets[String(shot.assetId)]
      }
    })
  }

  clipDurationMs() {
    const contractDuration = Number(this.payload.contract.durationMs)
    if (contractDuration > 0) return contractDuration

    return Math.max(...this.shots.map((shot) => shot.endMs), 0)
  }

  referenceScene() {
    const duration = Math.max((this.durationMs || this.clipDurationMs()) / 1000, 0.1)

    return {
      version: 1,
      size: { width: 720, height: 1280, fps: this.payload.contract.format?.fps || 30 },
      duration,
      shots: this.shots.map((shot, index) => {
        const nextShot = this.shots[index + 1] || null
        const textStyle = this.referenceTextStyle(shot)

        return {
          index,
          start: shot.startMs / 1000,
          end: shot.endMs / 1000,
          duration: shot.durationMs / 1000,
          panel: { src: shot.asset?.url, crop: shot.crop },
          nextPanel: nextShot ? { src: nextShot.asset?.url, crop: nextShot.crop } : null,
          zoomStart: 1.04,
          zoomEnd: 1.11,
          panX: 0,
          panY: 0,
          textStyle,
          activeEffects: this.referenceActiveEffects(shot),
          transitionOut: nextShot ? this.referenceTransition(shot) : null
        }
      })
    }
  }

  syncReferenceScene() {
    if (!this.referenceRenderer) return

    this.referenceRenderer.scene = this.referenceScene()
  }

  referenceActiveEffects(shot) {
    return [
      this.referencePreset(shot.pixiCameraMotion, "cameraMotion"),
      this.referencePreset(shot.pixiActiveEffect, "activeEffect")
    ].filter(Boolean)
  }

  referenceTransition(shot) {
    const transition = this.transitionFor(shot)
    if (transition === "none") return null

    return this.referencePreset(shot.pixiTransitionOut || this.transitionContractFor(transition), "transitionOut")
  }

  referenceTextStyle(shot) {
    const overlay = this.captionOverlay(shot)
    if (!overlay) return null

    const contract = shot.pixiTextStyle || {}
    const parameters = contract.parameters || {}
    const layout = contract.catalogLayout || contract.layout || overlay.style || "lower-third"

    return {
      ...this.referencePreset(contract, "textStyle"),
      id: contract.id || this.textPresetIdForLayout(overlay.style),
      kind: "textStyle",
      type: "textStyle",
      layout,
      text: overlay.text,
      title: overlay.text,
      accent: parameters.accent || this.textAccentForLayout(layout),
      fill: parameters.fill || this.textFillForLayout(layout),
      ink: parameters.ink || this.textInkForLayout(layout),
      font: parameters.font || (layout.includes("sfx") || layout.includes("star") ? "impact" : "clean"),
      position: overlay.position,
      size: overlay.size
    }
  }

  referencePreset(contract, kind) {
    if (!contract) return null

    const parameters = contract.parameters || {}
    return {
      ...contract,
      ...parameters,
      kind: contract.kind || kind,
      type: contract.type || kind,
      id: contract.id || contract.visualPresetId,
      visualPresetId: contract.visualPresetId || contract.id,
      layout: contract.catalogLayout || contract.layout || parameters.layout,
      effectType: contract.effectType || parameters.effectType || parameters.mechanic,
      transitionType: contract.transitionType || parameters.transitionType,
      accent: contract.accent || parameters.accent || "#ffd84d",
      tags: contract.tags || []
    }
  }

  textAccentForLayout(layout) {
    if (layout.includes("horror") || layout.includes("blood")) return "#d9163a"
    if (layout.includes("holo") || layout.includes("glitch") || layout.includes("terminal")) return "#42f5ff"
    if (layout.includes("love") || layout.includes("shojo")) return "#ff8ed6"
    if (layout.includes("lower")) return "#55f0c8"

    return "#ffd95a"
  }

  textFillForLayout(layout) {
    if (layout.includes("holo") || layout.includes("terminal")) return "rgba(0,17,24,0.86)"
    if (layout.includes("horror") || layout.includes("blood")) return "#050505"
    if (layout.includes("lower")) return "rgba(6,7,14,0.84)"

    return "#fff7df"
  }

  textInkForLayout(layout) {
    if (layout.includes("holo") || layout.includes("terminal")) return "#d9fbff"
    if (layout.includes("horror") || layout.includes("blood")) return "#f2f0ea"
    if (layout.includes("lower")) return "#f8f6ff"

    return "#111111"
  }

  async loadTextures() {
    const shotTexturePromises = this.shots.map(async (shot) => {
      if (!shot.asset?.url || this.textures.has(shot.asset.url)) return

      try {
        const texture = await Assets.load(shot.asset.url)
        this.textures.set(shot.asset.url, texture)
      } catch {
        this.textures.set(shot.asset.url, null)
      }
    })
    const fxTexturePromises = this.shots.flatMap((shot) => this.allMangaAssetSlotsForShot(shot)).map(async (slot) => {
      if (!slot.url || this.fxTextures.has(slot.url)) return

      try {
        const texture = await Assets.load(slot.url)
        this.fxTextures.set(slot.url, texture)
      } catch {
        this.fxTextures.set(slot.url, null)
      }
    })

    await Promise.all([...shotTexturePromises, ...fxTexturePromises])
  }

  setupAudio() {
    const music = this.selectedMusicPayload() || this.payload.contract.music
    this.element.dataset.previewMusicId = music?.id || "none"
    this.element.dataset.previewAudioReady = "false"
    if (!music?.url) return

    this.audio = new Audio(music.url)
    this.audio.dataset.url = music.url
    this.audio.loop = false
    this.audio.preload = "metadata"
    this.updateAudioVolume(0, music)
    this.element.dataset.previewAudioReady = "true"
  }

  playAudio() {
    this.refreshAudioFromControls({ force: true })
    if (!this.audio) return

    this.audioUnlocked = true
    this.syncAudioTime()
    this.element.dataset.previewAudioState = "playing"
    const playPromise = this.audio.play()
    if (playPromise?.catch) playPromise.catch(() => {
      this.element.dataset.previewAudioState = "blocked"
    })
  }

  pauseAudio() {
    this.audio?.pause()
    if (this.audio) this.element.dataset.previewAudioState = "paused"
  }

  stopAudio() {
    if (!this.audio) return

    this.audio.pause()
    this.audio.src = ""
    this.audio = null
    this.element.dataset.previewAudioReady = "false"
  }

  refreshAudioFromControls({ force = false } = {}) {
    const music = this.selectedMusicPayload()
    if (!music) {
      this.stopAudio()
      this.element.dataset.previewMusicId = "none"
      return
    }

    const currentUrl = this.audio?.dataset?.url
    if (force || currentUrl !== music.url) {
      const shouldResume = this.isPlaying && this.audioUnlocked
      this.stopAudio()
      this.audio = new Audio(music.url)
      this.audio.dataset.url = music.url
      this.audio.loop = false
      this.audio.preload = "metadata"
      this.element.dataset.previewAudioReady = "true"
      this.element.dataset.previewMusicId = music.id
      if (shouldResume) {
        this.syncAudioTime()
        this.updateAudioVolume(this.playheadMs, music)
        this.audio.play()?.catch?.(() => {
          this.element.dataset.previewAudioState = "blocked"
        })
        return
      }
    }

    this.updateAudioVolume(this.playheadMs, music)
    this.element.dataset.previewMusicId = music.id
  }

  selectedMusicPayload() {
    const select = this.element.querySelector("select[name='clip[music_id]']")
    const volume = this.element.querySelector("input[name='clip[music_volume]']")?.value || DEFAULT_MUSIC_VOLUME
    const option = select?.selectedOptions?.[0]
    if (!option || option.value === "none" || !option.dataset.url) return null

    return {
      id: option.value,
      title: option.dataset.title,
      artist: option.dataset.artist,
      mood: option.dataset.mood,
      url: option.dataset.url,
      source: option.dataset.source,
      license: option.dataset.license,
      licenseUrl: option.dataset.licenseUrl,
      volume
    }
  }

  syncAudioTime() {
    if (!this.audio) return

    this.updateAudioVolume(this.playheadMs)
    if (!Number.isFinite(this.audio.duration) || this.audio.duration <= 0) return

    this.audio.currentTime = Math.min(this.playheadMs / 1000, Math.max(this.audio.duration - 0.05, 0))
  }

  audioVolume(value) {
    return Math.max(0, Math.min(Number(value) || 0, 100)) / 100
  }

  updateAudioVolume(playheadMs = this.playheadMs, music = null) {
    if (!this.audio) return

    const payload = music || this.selectedMusicPayload() || this.payload.contract.music || {}
    const baseVolume = this.audioVolume(payload.volume ?? DEFAULT_MUSIC_VOLUME)
    const fadeMultiplier = this.audioFadeMultiplier(playheadMs)
    this.audio.volume = Math.max(0, Math.min(baseVolume * fadeMultiplier, 1))
    this.element.dataset.previewAudioFade = fadeMultiplier.toFixed(3)
  }

  audioFadeMultiplier(playheadMs = this.playheadMs) {
    if (!this.durationMs) return 1

    const fadeDuration = Math.max(500, Math.min(MUSIC_FADE_OUT_MS, this.durationMs * 0.22))
    const remainingMs = Math.max(0, this.durationMs - this.normalizedPlayhead(playheadMs))
    if (remainingMs >= fadeDuration) return 1

    const progress = remainingMs / fadeDuration
    return Math.sin(progress * Math.PI * 0.5)
  }

  handleEditorChange(event) {
    const target = event.target
    if (target.name === "clip[music_id]" || target.name === "clip[music_volume]") {
      this.refreshAudioFromControls()
      return
    }

    const match = target.name?.match(/^clip\[shots\]\[([^\]]+)\]\[([^\]]+)\]$/)
    if (!match) return
    if (target.type === "hidden") return

    const [, panelId, field] = match
    const shot = this.contractShotFor(panelId)
    if (!shot) return

    if (field === "text") {
      shot.text = target.value
    } else if (field === "no_text") {
      shot.noText = target.checked
    } else if (field === "duration_seconds") {
      if (this.isPlaying) this.pause()
      if (event.type === "input" && this.isPartialDurationValue(target.value)) return

      shot.customDurationMs = this.durationInputMs(target.value)
      if (event.type === "change") target.value = this.durationInputValue(shot.customDurationMs)
      shot.durationMs = shot.customDurationMs
      shot.sceneDuration = "custom"
    } else if (field === "transition") {
      shot.transition = target.value || shot.transition || "cut"
      shot.pixiTransitionOut = this.transitionContractFor(shot.transition)
    } else if (field === "scene_mode") {
      shot.sceneMode = target.value || "auto"
      this.applySceneModeDefaults(shot)
      this.syncModeControls(panelId, shot)
    } else if (EDITOR_FIELD_MAP[field]) {
      shot[EDITOR_FIELD_MAP[field]] = target.value || "auto"
      if (field === "scene_motion") shot.effectIntensity = this.effectIntensityForMotion(shot.sceneMotion)
    } else {
      return
    }

    this.syncEditedShot(shot)
    if (field === "duration_seconds") {
      this.syncShotTimings()
      this.updateDurationBadges()
    }
    this.refreshFromEditor(panelId)
  }

  applySceneModeDefaults(shot) {
    const firstShot = (this.payload.contract.shots || [])[0] === shot
    const transition = (value) => firstShot ? "none" : value

    const defaults = {
      soft: { sceneMotion: "float", sceneBubble: "caption", sceneDuration: "long", effectIntensity: "subtle", transition: transition("cut") },
      impact: { sceneMotion: "impact", sceneBubble: "burst", sceneDuration: "short", effectIntensity: "intense", transition: transition("panel_slam") },
      dramatic: { sceneMotion: "cinematic", sceneBubble: "caption", sceneDuration: "long", effectIntensity: "balanced", transition: transition("ink_flash") },
      clear: { sceneMotion: "scroll", sceneBubble: "caption", sceneDuration: "normal", effectIntensity: "subtle", transition: transition("cut") },
      auto: { sceneMotion: "auto", sceneBubble: "auto", sceneDuration: "auto", effectIntensity: "auto", transition: transition("cut") }
    }[shot.sceneMode || "auto"]

    Object.assign(shot, defaults)
    shot.pixiTransitionOut = this.transitionContractFor(shot.transition)
  }

  syncModeControls(panelId, shot) {
    const fieldMap = {
      scene_motion: shot.sceneMotion,
      scene_bubble: shot.sceneBubble,
      scene_duration: shot.sceneDuration,
      effect_intensity: shot.effectIntensity,
      transition: shot.transition
    }

    Object.entries(fieldMap).forEach(([field, value]) => {
      const input = this.element.querySelector(`[name="clip[shots][${CSS.escape(String(panelId))}][${field}]"]`)
      if (input && !input.disabled) input.value = value || "auto"
    })
  }

  contractShotFor(panelId) {
    return (this.payload.contract.shots || []).find((shot) => String(shot.panelId) === String(panelId))
  }

  syncEditedShot(shot) {
    const text = String(shot.text || "").trim()

    if (shot.noText === true || text.length === 0 || shot.scenePosition === "none") {
      if (text.length === 0) delete shot.text
      delete shot.overlay
      delete shot.pixiTextStyle
    } else {
      shot.text = text
      shot.overlay = {
        text,
        source: "live_edit",
        style: this.resolvedShotChoice(shot, "sceneBubble", "resolvedBubble", "caption"),
        position: this.resolvedShotChoice(shot, "scenePosition", "resolvedPosition", "bottom_safe"),
        size: this.resolvedShotChoice(shot, "sceneSize", "resolvedSize", "medium")
      }
      shot.pixiTextStyle = {
        id: this.textPresetIdForLayout(shot.overlay.style),
        kind: "textStyle",
        layout: shot.overlay.style,
        catalogLayout: this.textCatalogLayoutFor(shot.overlay.style),
        textAnimation: this.textAnimationForLayout(shot.overlay.style),
        parameters: {
          position: shot.overlay.position,
          size: shot.overlay.size,
          assetSlots: this.assetSlotsForPreset(this.textPresetIdForLayout(shot.overlay.style), this.textVisualCategoryForLayout(shot.overlay.style))
        }
      }
    }

    const motion = shot.sceneMotion || "auto"
    const motionStyle = motion === "auto" ? (shot.motion?.style || this.defaultMotionForPhase(shot.phase)) : motion
    shot.motion = {
      style: motionStyle,
      source: motion === "auto" ? "direction" : "live_edit",
      intensity: shot.effectIntensity || this.payload.contract.visual?.intensity || "auto"
    }
    shot.pixiCameraMotion = this.cameraMotionContractFor(motionStyle)
    shot.pixiActiveEffect = this.activeEffectContractFor(shot, motionStyle)
    shot.pixiRhythm = this.rhythmContractFor(shot, motionStyle)
  }

  syncShotTimings() {
    const shots = this.payload.contract.shots || []
    let cursor = 0

    shots.forEach((shot) => {
      const duration = this.clampedDurationMs(shot.customDurationMs || shot.durationMs || MIN_SHOT_DURATION_MS)

      shot.startMs = cursor
      shot.endMs = cursor + duration
      shot.durationMs = duration
      if (shot.pixiRhythm?.parameters) shot.pixiRhythm.parameters.durationMs = duration
      cursor += duration
    })

    this.payload.contract.durationMs = cursor
    this.durationMs = cursor
  }

  updateDurationBadges() {
    ;(this.payload.contract.shots || []).forEach((shot) => {
      const badge = this.element.querySelector(`[data-duration-badge-for="${CSS.escape(String(shot.panelId))}"]`)
      const input = this.element.querySelector(`[data-duration-input-for="${CSS.escape(String(shot.panelId))}"]`)
      const value = this.durationInputValue(shot.durationMs)

      if (input && document.activeElement !== input) input.value = value
      if (badge) badge.setAttribute("aria-label", this.durationLabel(shot.durationMs))
    })

    const totalBadge = this.element.querySelector("[data-total-duration-badge]")
    if (totalBadge) totalBadge.textContent = this.durationLabel(this.payload.contract.durationMs)
  }

  durationInputMs(value) {
    const parsed = Number.parseFloat(String(value || "").replace(",", "."))
    return this.clampedDurationMs(Number.isFinite(parsed) ? parsed * 1000 : MIN_SHOT_DURATION_MS)
  }

  isPartialDurationValue(value) {
    const normalized = String(value || "").trim()
    return normalized === "" || /[.,]$/.test(normalized)
  }

  clampedDurationMs(value) {
    return Math.min(MAX_SHOT_DURATION_MS, Math.max(MIN_SHOT_DURATION_MS, Math.round(Number(value) || MIN_SHOT_DURATION_MS)))
  }

  effectIntensityForMotion(motion) {
    if (motion === "float") return "subtle"
    if (motion === "impact") return "intense"

    return "balanced"
  }

  durationLabel(ms) {
    const seconds = Math.max(MIN_SHOT_DURATION_MS / 1000, (Number(ms) || 0) / 1000)
    const rounded = Math.round(seconds * 10) / 10
    return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}s`
  }

  durationInputValue(ms) {
    const seconds = Math.round((Number(ms) || MIN_SHOT_DURATION_MS) / 100) / 10
    return Number.isInteger(seconds) ? seconds.toFixed(0) : seconds.toFixed(1)
  }

  refreshFromEditor(panelId) {
    this.shots = this.normalizedShots()
    this.durationMs = this.clipDurationMs()
    this.syncReferenceScene()

    const editedShot = this.shots.find((shot) => String(shot.panelId) === String(panelId))
    if (editedShot) this.seekTo(editedShot.startMs + 120)
    this.renderAt(this.playheadMs)
  }

  reorderEditorShots(panelIds, labels = []) {
    const order = panelIds.map(String)
    const shotsByPanelId = new Map((this.payload.contract.shots || []).map((shot) => [String(shot.panelId), shot]))
    const orderedShots = order.map((panelId, index) => {
      const shot = shotsByPanelId.get(panelId)
      if (!shot) return null

      shot.position = index + 1
      shot.label = labels[index] || shot.label
      shot.phase = this.shotPhaseForIndex(index, order.length)
      if (index === 0) shot.transition = "none"
      return shot
    }).filter(Boolean)

    if (orderedShots.length !== (this.payload.contract.shots || []).length) return

    this.payload.contract.shots = orderedShots
    this.syncShotTimings()
    this.shots = this.normalizedShots()
    this.durationMs = this.clipDurationMs()
    this.syncReferenceScene()
    this.seekToShot(Math.min(this.currentShotIndex, this.shots.length - 1))
    this.updateDurationBadges()
  }

  shotPhaseForIndex(index, total) {
    if (index === 0) return "HOOK"
    if (index === total - 1) return "CLOSE"
    if (index === total - 2) return "CLIMAX"

    return "BODY"
  }

  renderAt(playheadMs) {
    this.updateAudioVolume(playheadMs)

    if (this.referenceRenderer) {
      if (this.shots.length === 0) {
        this.referenceRenderer.clearRoot()
        this.updateStatus(null, 0)
        return
      }

      const active = this.activeShotFor(playheadMs)
      const shot = active.shot
      const localElapsed = Math.max(0, playheadMs - shot.startMs)
      const localProgress = Math.min(localElapsed / shot.durationMs, 1)
      const rhythm = this.rhythmStateFor(shot, localProgress)
      const fxAssetSlots = this.fxAssetSlotsForShot(shot)
      const transitionAssetSlots = this.transitionAssetSlotsForShot(shot)
      const textAssetSlots = this.textAssetSlotsForShot(shot)

      this.element.dataset.previewFxProfile = this.activeEffectProfileFor(shot)
      this.element.dataset.previewCameraPreset = shot.pixiCameraMotion?.id || "mvp-camera"
      this.element.dataset.previewEffectPreset = shot.pixiActiveEffect?.id || "mvp-effect"
      this.element.dataset.previewTextPreset = shot.pixiTextStyle?.id || "none"
      this.element.dataset.previewTextAnimation = shot.pixiTextStyle?.textAnimation || "none"
      this.element.dataset.previewTransitionPreset = shot.pixiTransitionOut?.id || this.transitionFor(shot)
      this.element.dataset.previewRhythmPreset = shot.pixiRhythm?.id || "mvp-rhythm"
      this.element.dataset.previewRhythmCue = rhythm.kind
      this.element.dataset.previewFxAssetSlots = String(fxAssetSlots.length)
      this.element.dataset.previewTransitionAssetSlots = String(transitionAssetSlots.length)
      this.element.dataset.previewTextAssetSlots = String(textAssetSlots.length)
      this.element.dataset.previewFxAssetsLoaded = String(this.loadedAssetCountForSlots(fxAssetSlots))
      this.element.dataset.previewTransitionAssetsLoaded = String(this.loadedAssetCountForSlots(transitionAssetSlots))
      this.element.dataset.previewTextAssetsLoaded = String(this.loadedAssetCountForSlots(textAssetSlots))

      this.referenceRenderer.renderFrame(playheadMs / 1000)
      if (this.referenceRenderer.frameStats) {
        this.element.dataset.previewFrameMs = this.referenceRenderer.frameStats.lastMs.toFixed(2)
        this.element.dataset.previewAverageFrameMs = this.referenceRenderer.frameStats.averageMs.toFixed(2)
      }
      this.updateStatus(shot, playheadMs)
      return
    }

    this.app.stage.removeChildren()
    this.drawBackground()

    if (this.shots.length === 0) {
      this.drawEmpty()
      this.updateStatus(null, 0)
      return
    }

    const active = this.activeShotFor(playheadMs)
    const shot = active.shot
    const texture = this.textureFor(shot)
    const nextShot = this.shots[active.index + 1] || this.shots[0]
    const nextTexture = this.textureFor(nextShot) || texture
    const localElapsed = Math.max(0, playheadMs - shot.startMs)
    const localProgress = Math.min(localElapsed / shot.durationMs, 1)
    const transitionMs = this.transitionDurationFor(shot)
    const transitionStart = Math.max(shot.durationMs - transitionMs, shot.durationMs * 0.55)
    const transition = this.transitionFor(shot)
    const rhythm = this.rhythmStateFor(shot, localProgress)
    const fxAssetSlots = this.fxAssetSlotsForShot(shot)
    const transitionAssetSlots = this.transitionAssetSlotsForShot(shot)
    const textAssetSlots = this.textAssetSlotsForShot(shot)
    let overlay = null
    this.element.dataset.previewFxProfile = this.activeEffectProfileFor(shot)
    this.element.dataset.previewCameraPreset = shot.pixiCameraMotion?.id || "legacy-camera"
    this.element.dataset.previewEffectPreset = shot.pixiActiveEffect?.id || "legacy-effect"
    this.element.dataset.previewTextPreset = shot.pixiTextStyle?.id || "none"
    this.element.dataset.previewTextAnimation = shot.pixiTextStyle?.textAnimation || "none"
    this.element.dataset.previewTransitionPreset = shot.pixiTransitionOut?.id || transition
    this.element.dataset.previewRhythmPreset = shot.pixiRhythm?.id || "legacy-rhythm"
    this.element.dataset.previewRhythmCue = rhythm.kind
    this.element.dataset.previewFxAssetSlots = String(fxAssetSlots.length)
    this.element.dataset.previewTransitionAssetSlots = String(transitionAssetSlots.length)
    this.element.dataset.previewTextAssetSlots = String(textAssetSlots.length)
    this.element.dataset.previewFxAssetsLoaded = String(this.loadedAssetCountForSlots(fxAssetSlots))
    this.element.dataset.previewTransitionAssetsLoaded = String(this.loadedAssetCountForSlots(transitionAssetSlots))
    this.element.dataset.previewTextAssetsLoaded = String(this.loadedAssetCountForSlots(textAssetSlots))

    if (texture && nextTexture && transition !== "none" && localElapsed >= transitionStart) {
      const transitionProgress = Math.min((localElapsed - transitionStart) / Math.max(transitionMs, 1), 1)
      this.drawTransition(texture, nextTexture, transition, transitionProgress, playheadMs / 1000, shot, nextShot)
    } else {
      this.drawShot(shot, texture, localProgress, playheadMs / 1000)
      this.drawMotionEffect(shot, localProgress, playheadMs / 1000, rhythm)
      overlay = this.captionOverlay(shot)
    }

    this.drawGenreEffect(shot, localProgress, playheadMs / 1000, rhythm)
    this.drawMangaPrintOverlay(shot, localProgress, playheadMs / 1000, rhythm)
    if (overlay) this.drawCaption(shot, overlay, localProgress, playheadMs / 1000)
    this.drawRhythmAccent(rhythm, playheadMs / 1000)
    this.drawFinish()
    this.updateStatus(shot, playheadMs)
  }

  activeShotFor(playheadMs) {
    const index = this.shots.findIndex((shot) => playheadMs >= shot.startMs && playheadMs < shot.endMs)
    const safeIndex = index >= 0 ? index : Math.max(0, this.shots.length - 1)

    return { index: safeIndex, shot: this.shots[safeIndex] }
  }

  textureFor(shot) {
    if (!shot?.asset?.url) return null

    return this.textures.get(shot.asset.url)
  }

  drawBackground() {
    const background = new Graphics()
    background.rect(0, 0, this.frame.width, this.frame.height)
    background.fill("#08080d")
    this.app.stage.addChild(background)
  }

  drawEmpty() {
    const label = new Text({
      text: "KomaClip",
      style: new TextStyle({
        fill: "#ffffff",
        fontFamily: "Inter, Arial",
        fontSize: 30,
        fontWeight: "900"
      })
    })
    label.anchor.set(0.5)
    label.x = this.frame.width / 2
    label.y = this.frame.height / 2
    this.app.stage.addChild(label)
  }

  drawShot(shot, texture, progress, timeSeconds, options = {}) {
    const layer = new Container()
    layer.alpha = options.alpha ?? 1
    this.app.stage.addChild(layer)

    if (texture) {
      const sprite = new Sprite(texture)
      this.fitSprite(sprite, shot.crop, this.cameraFor(shot, progress, timeSeconds, options))
      layer.addChild(sprite)
    } else {
      this.drawPlaceholder(layer, shot)
    }

    return layer
  }

  fitSprite(sprite, crop = {}, camera = {}) {
    const safeCrop = {
      x: Number(crop.x) || 0,
      y: Number(crop.y) || 0,
      width: Math.max(Number(crop.width) || 1, 0.01),
      height: Math.max(Number(crop.height) || 1, 0.01)
    }
    const croppedTextureWidth = sprite.texture.width * safeCrop.width
    const croppedTextureHeight = sprite.texture.height * safeCrop.height
    const scale = Math.max(this.frame.width / croppedTextureWidth, this.frame.height / croppedTextureHeight) * (camera.zoom || 1)

    sprite.scale.set(scale)
    sprite.x = (this.frame.width - sprite.texture.width * scale) / 2 - sprite.texture.width * scale * safeCrop.x + (camera.panX || 0) * this.frame.width
    sprite.y = (this.frame.height - sprite.texture.height * scale) / 2 - sprite.texture.height * scale * safeCrop.y + (camera.panY || 0) * this.frame.height
    sprite.alpha = camera.alpha ?? 1
  }

  cameraFor(shot, progress, timeSeconds, options = {}) {
    const motion = shot.motion?.style || (shot.sceneMotion === "auto" ? "cinematic" : shot.sceneMotion)
    const intensity = this.intensityMultiplier(shot)
    const eased = this.easeInOut(progress)
    const pulse = Math.sin(timeSeconds * 2.2)
    const beat = Math.max(0, Math.sin(timeSeconds * 7.2))
    const contractCamera = this.contractCameraFor(shot, progress, timeSeconds, intensity)

    const camera = {
      zoom: 1.045 + eased * 0.055,
      panX: Math.sin(timeSeconds * 0.48) * 0.012 * intensity,
      panY: Math.cos(timeSeconds * 0.42) * 0.01 * intensity
    }

    if (motion === "impact" || motion === "beat") {
      camera.zoom = 1.07 + beat * 0.07 * intensity
      camera.panX = Math.sin(timeSeconds * 22) * 0.006 * beat * intensity
      camera.panY = Math.cos(timeSeconds * 19) * 0.006 * beat * intensity
    } else if (motion === "scroll") {
      camera.zoom = 1.12
      camera.panY = this.lerp(-0.16, 0.16, eased)
      camera.panX = Math.sin(timeSeconds * 0.28) * 0.006
    } else if (motion === "parallax" || motion === "swipe") {
      camera.zoom = 1.08
      camera.panX = this.lerp(-0.04, 0.04, eased) + Math.sin(timeSeconds * 0.9) * 0.012 * intensity
      camera.panY = this.lerp(0.025, -0.025, eased)
    } else if (motion === "float") {
      camera.zoom = 1.06
      camera.panY = Math.sin(timeSeconds * 1.2) * 0.02 * intensity
    } else if (motion === "glitch" || motion === "rgb") {
      const step = Math.floor(timeSeconds * 14) % 4
      camera.zoom = 1.06 + (step % 2) * 0.018 * intensity
      camera.panX = (step - 1.5) * 0.006 * intensity
      camera.alpha = 0.94 + (step % 2) * 0.06
    } else if (motion === "manga") {
      camera.zoom = 1.08 + pulse * 0.018 * intensity
      camera.panX = Math.sin(timeSeconds * 1.8) * 0.012 * intensity
      camera.panY = Math.cos(timeSeconds * 1.4) * 0.01 * intensity
    }

    if (contractCamera) Object.assign(camera, contractCamera)

    return {
      ...camera,
      zoom: (options.zoom || 1) * (camera.zoom || 1),
      panX: (camera.panX || 0) + (options.panX || 0),
      panY: (camera.panY || 0) + (options.panY || 0),
      alpha: options.alpha ?? camera.alpha
    }
  }

  contractCameraFor(shot, progress, timeSeconds, intensity) {
    const parameters = shot.pixiCameraMotion?.parameters
    if (!parameters) return null

    const eased = this.easeInOut(progress)
    const zoomStart = Number(parameters.zoomStart) || 1.04
    const zoomEnd = Number(parameters.zoomEnd) || zoomStart
    const panX = Number(parameters.panX) || 0
    const panY = Number(parameters.panY) || 0
    const tempo = Number(parameters.tempo) || 1
    const motionStyle = shot.pixiCameraMotion?.motionStyle || shot.motion?.style || shot.sceneMotion
    const shake = ["impact", "beat", "rgb"].includes(motionStyle) ? Math.max(0, Math.sin(timeSeconds * 8 * tempo)) : 0

    return {
      zoom: this.lerp(zoomStart, zoomEnd, eased) + shake * 0.018 * intensity,
      panX: this.lerp(-panX, panX, eased) + Math.sin(timeSeconds * 1.3 * tempo) * 0.006 * intensity,
      panY: this.lerp(-panY, panY, eased) + Math.cos(timeSeconds * 1.1 * tempo) * 0.005 * intensity,
      alpha: motionStyle === "rgb" ? 0.94 + (Math.floor(timeSeconds * 12) % 2) * 0.06 : undefined
    }
  }

  drawTransition(texture, nextTexture, transition, progress, timeSeconds, shot, nextShot) {
    const p = this.easeOut(progress)
    const tempo = Number(shot.pixiTransitionOut?.parameters?.tempo) || 1
    const timed = timeSeconds * tempo
    const direction = this.transitionDirection(shot, transition)

    if (transition === "speed_wipe") {
      this.drawShot(shot, texture, 1, timeSeconds, { panX: -0.08 * p * direction, alpha: 1 - p * 0.28 })
      this.drawOutgoingEcho(shot, texture, p, timeSeconds, direction, "speed")
      const nextLayer = this.drawShot(nextShot, nextTexture, 0.1, timeSeconds, { panX: 0.1 * (1 - p) * direction, zoom: 1.04 })
      const mask = new Graphics()
      if (direction > 0) {
        mask.rect(0, 0, this.frame.width * p, this.frame.height)
      } else {
        mask.rect(this.frame.width * (1 - p), 0, this.frame.width * p, this.frame.height)
      }
      mask.fill("#ffffff")
      nextLayer.mask = mask
      this.app.stage.addChild(mask)
      this.drawWipeLine(direction > 0 ? this.frame.width * p : this.frame.width * (1 - p))
      this.drawLateralSpeedLines(p, timed)
      this.drawTransitionFlash(p, 0.12)
    } else if (transition === "panel_slam") {
      this.drawShot(shot, texture, 1, timeSeconds, { alpha: 1 - p * 0.62, zoom: 1 + p * 0.08, panX: direction * p * 0.018 })
      this.drawOutgoingEcho(shot, texture, p, timeSeconds, direction, "slam")
      const zoom = 1.22 - p * 0.22
      this.drawShot(nextShot, nextTexture, 0.1, timeSeconds, { alpha: p, zoom })
      this.drawImpactFrame(p)
      this.drawShockBurst(p, timed)
      this.drawTransitionFlash(p, 0.22)
    } else if (transition === "page_slice") {
      this.drawShot(shot, texture, 1, timeSeconds, { panX: -0.04 * p * direction, alpha: 1 - p * 0.36 })
      this.drawOutgoingEcho(shot, texture, p, timeSeconds, direction, "slice")
      const nextLayer = this.drawShot(nextShot, nextTexture, 0.1, timeSeconds, { panX: 0.05 * (1 - p) * direction })
      const mask = new Graphics()
      const x = direction > 0 ? this.frame.width * p : this.frame.width * (1 - p)
      if (direction > 0) {
        mask.poly([0, 0, x + 80, 0, x - 40, this.frame.height, 0, this.frame.height])
      } else {
        mask.poly([this.frame.width, 0, x - 80, 0, x + 40, this.frame.height, this.frame.width, this.frame.height])
      }
      mask.fill("#ffffff")
      nextLayer.mask = mask
      this.app.stage.addChild(mask)
      this.drawSliceLines(x)
      this.drawPaperShards(x, p, timed)
      this.drawTransitionFlash(p, 0.1)
    } else if (transition === "ink_flash") {
      this.drawShot(shot, texture, 1, timeSeconds, { alpha: 1 - p * 0.68, panX: -0.02 * p * direction })
      this.drawOutgoingEcho(shot, texture, p, timeSeconds, direction, "ink")
      this.drawShot(nextShot, nextTexture, 0.1, timeSeconds, { alpha: p, zoom: 1.08 - p * 0.04 })
      this.drawInkFlash(p, timed)
    } else if (transition === "glitch_tear") {
      this.drawShot(shot, texture, 1, timeSeconds, { alpha: 1 - p * 0.55, panX: -0.035 * p * direction, zoom: 1 + p * 0.035 })
      this.drawOutgoingEcho(shot, texture, p, timeSeconds, direction, "glitch")
      this.drawShot(nextShot, nextTexture, 0.1, timeSeconds, { alpha: p, panX: 0.04 * (1 - p) * direction, zoom: 1.1 - p * 0.05 })
      this.drawGlitchTear(p, timed, direction)
      this.drawTransitionFlash(p, 0.16)
    } else if (transition === "vertical_scroll") {
      this.drawShot(shot, texture, 1, timeSeconds, { alpha: 1 - p * 0.44, panY: -0.18 * p, zoom: 1.03 })
      this.drawOutgoingEcho(shot, texture, p, timeSeconds, direction, "scroll")
      const nextLayer = this.drawShot(nextShot, nextTexture, 0.1, timeSeconds, { alpha: 0.92, panY: 0.2 * (1 - p), zoom: 1.02 })
      const mask = new Graphics()
      mask.rect(0, this.frame.height * (1 - p), this.frame.width, this.frame.height * p)
      mask.fill("#ffffff")
      nextLayer.mask = mask
      this.app.stage.addChild(mask)
      this.drawVerticalScrollCut(p, timed)
    } else {
      this.drawShot(shot, texture, 1, timeSeconds, { alpha: 1 - p })
      this.drawShot(nextShot, nextTexture, 0.1, timeSeconds, { alpha: p })
    }

    this.drawAssetSlotOverlays(this.transitionAssetSlotsForShot(shot), progress, timeSeconds, { kind: "transition", power: p })
  }

  transitionDirection(shot, transition) {
    const position = Number(shot.position) || this.currentShotIndex + 1
    if (transition === "page_slice" || transition === "glitch_tear") return position % 2 === 0 ? 1 : -1

    return position % 2 === 0 ? -1 : 1
  }

  drawOutgoingEcho(shot, texture, progress, timeSeconds, direction, family) {
    const hit = Math.sin(progress * Math.PI)
    if (hit <= 0.02) return

    const distance = family === "slam" ? 0.024 : family === "slice" ? 0.05 : 0.075
    const copies = family === "ink" ? 2 : 3

    for (let i = 1; i <= copies; i += 1) {
      const alpha = hit * (family === "slam" ? 0.12 : 0.09) / i
      const panX = -direction * distance * i * progress + Math.sin(timeSeconds * 3 + i) * 0.004
      const zoom = 1 + hit * 0.015 * i
      this.drawShot(shot, texture, 1, timeSeconds, { alpha, panX, zoom })
    }
  }

  drawMotionEffect(shot, progress, timeSeconds, rhythm = {}) {
    const motion = shot.motion?.style || shot.sceneMotion
    const intensity = this.intensityMultiplier(shot)
    const rhythmBoost = 1 + (rhythm.power || 0) * 0.35

    if (motion === "impact" || motion === "beat") {
      this.drawSpeedLines(Math.max(0.15, Math.sin(progress * Math.PI)) * rhythmBoost, intensity)
      if (motion === "beat") this.drawImpactFrame(Math.max(0, Math.sin(timeSeconds * 6)) + (rhythm.power || 0) * 0.25)
    } else if (motion === "manga") {
      this.drawSpeedLines((0.28 + Math.sin(timeSeconds * 2) * 0.08) * rhythmBoost, intensity)
      this.drawHalftone(0.18)
    } else if (motion === "glitch" || motion === "rgb") {
      this.drawGlitchBands(timeSeconds)
    } else if (motion === "scroll") {
      this.drawReadingGradient(progress)
    }
  }

  drawGenreEffect(shot, progress, timeSeconds, rhythm = {}) {
    const intensity = this.intensityMultiplier(shot)
    const profile = this.activeEffectProfileFor(shot)
    const phaseBoost = this.phaseEffectBoost(shot, progress) + (rhythm.power || 0) * 0.22
    this.drawFxAssetOverlays(shot, progress, timeSeconds, rhythm)

    if (profile === "manga-action") {
      this.drawActionSlashes(progress, timeSeconds, intensity * phaseBoost)
      this.drawMangaImpactGlyphs(progress, timeSeconds, intensity * phaseBoost)
    } else if (profile === "manga-speed-impact") {
      this.drawMangaSpeedImpact(progress, timeSeconds, intensity * phaseBoost)
    } else if (profile === "manga-burst-focus") {
      this.drawMangaBurstFocusFrame(progress, timeSeconds, intensity * phaseBoost)
    } else if (profile === "manga-halftone-burst") {
      this.drawMangaHalftoneBurst(progress, timeSeconds, intensity * phaseBoost)
    } else if (profile === "impact-freeze-punch") {
      this.drawImpactFreezePunch(progress, timeSeconds, intensity * phaseBoost)
    } else if (profile === "slash-energy-cut") {
      this.drawSlashEnergyCut(progress, timeSeconds, intensity * phaseBoost)
    } else if (profile === "manga-sfx-slam" || profile === "panel-smash-burst") {
      this.drawPanelSmashBurst(progress, timeSeconds, intensity * phaseBoost)
    } else if (profile === "ink-flash-impact") {
      this.drawInkFlashImpact(progress, timeSeconds, intensity * phaseBoost)
    } else if (profile === "scifi-hud") {
      this.drawScifiHud(progress, timeSeconds, intensity * phaseBoost)
      this.drawHologramBlocks(progress, timeSeconds, intensity * phaseBoost)
    } else if (profile === "horror-signal") {
      this.drawHorrorSignal(progress, timeSeconds, intensity * phaseBoost)
    } else if (profile === "romance-petals") {
      this.drawRomancePetals(progress, timeSeconds, intensity)
    } else if (profile === "fantasy-spark") {
      this.drawFantasySpark(progress, timeSeconds, intensity)
    } else if (profile === "comedy-pop") {
      this.drawComedyPop(progress, timeSeconds, intensity)
    } else {
      this.drawEditorialGrain(timeSeconds)
    }
  }

  drawFxAssetOverlays(shot, progress, timeSeconds, rhythm = {}) {
    return this.drawAssetSlotOverlays(this.fxAssetSlotsForShot(shot), progress, timeSeconds, rhythm)
  }

  drawAssetSlotOverlays(assetSlots, progress, timeSeconds, rhythm = {}) {
    const slots = assetSlots.filter((slot) => slot.url && this.fxTextures.get(slot.url))
    if (!slots.length) return 0

    slots.forEach((slot, index) => {
      const texture = this.fxTextures.get(slot.url)
      const sprite = new Sprite(texture)
      const role = slot.role || "overlay"
      const kind = slot.kind || ""
      const pulse = Math.max(0, Math.sin(progress * Math.PI))
      const rhythmPower = rhythm.power || 0
      const coverScale = Math.max(this.frame.width / texture.width, this.frame.height / texture.height)
      const safeScale = Math.min((this.frame.width - 52) / texture.width, (this.frame.height - 96) / texture.height)
      const baseScale = ["safe-frame", "right-safe"].includes(slot.anchor) ? safeScale : coverScale
      const isImpactFrame = kind === "impact-frame"
      const animationScale = slot.animation?.includes("pop") || slot.animation?.includes("slam")
        ? 1 + pulse * (isImpactFrame ? 0.14 : 0.08) + rhythmPower * (isImpactFrame ? 0.12 : 0.08)
        : 1 + Math.sin(timeSeconds * 0.7 + index) * 0.015

      if (isImpactFrame) this.drawImpactAssetBackdrop(progress, timeSeconds, rhythmPower)
      sprite.anchor.set(0.5)
      sprite.x = slot.anchor === "right-safe" ? this.frame.width - 62 : this.frame.width / 2 + (slot.animation?.includes("drift") ? Math.sin(timeSeconds * 0.5 + index) * 12 : 0)
      sprite.y = this.frame.height / 2 + (slot.animation?.includes("drift") ? Math.cos(timeSeconds * 0.4 + index) * 10 : 0)
      sprite.scale.set(baseScale * animationScale)
      sprite.alpha = role === "texture" ? 0.28 : role === "atmosphere" ? 0.34 : role === "text-frame" ? 0.72 : isImpactFrame ? 0.68 + rhythmPower * 0.22 : 0.46 + rhythmPower * 0.18
      if (slot.blendMode) sprite.blendMode = slot.blendMode
      this.app.stage.addChild(sprite)
    })

    return slots.length
  }

  drawImpactAssetBackdrop(progress, timeSeconds, rhythmPower = 0) {
    const pulse = Math.max(0, Math.sin(progress * Math.PI))
    const flashAlpha = 0.08 + pulse * 0.1 + rhythmPower * 0.06
    const backdrop = new Graphics()

    backdrop.rect(0, 0, this.frame.width, this.frame.height)
    backdrop.fill({ color: "#ffffff", alpha: Math.min(0.2, flashAlpha) })

    const cx = this.frame.width / 2
    const cy = this.frame.height * 0.48
    for (let i = 0; i < 28; i += 1) {
      const angle = (i / 28) * Math.PI * 2 + Math.sin(timeSeconds * 1.8 + i) * 0.03
      const inner = 72 + (i % 4) * 9
      const outer = 360 + pulse * 46 + (i % 6) * 18
      backdrop.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner)
      backdrop.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer)
      backdrop.stroke({ color: i % 3 === 0 ? "#ffd95a" : "#ffffff", alpha: 0.16 + pulse * 0.14, width: i % 3 === 0 ? 3 : 1 })
    }

    this.app.stage.addChild(backdrop)
  }

  drawMangaPrintOverlay(shot, progress, timeSeconds, rhythm = {}) {
    const profile = this.activeEffectProfileFor(shot)
    const active = Math.max(0, Math.sin(progress * Math.PI))
    const rhythmPower = rhythm.power || 0
    const texture = new Graphics()
    const baseAlpha = profile === "editorial-grain" ? 0.045 : 0.028

    for (let y = 5; y < this.frame.height; y += 16) {
      for (let x = 5 + ((Math.floor(y / 16) % 2) * 8); x < this.frame.width; x += 16) {
        const distance = Math.abs(x - this.frame.width / 2) + Math.abs(y - this.frame.height / 2)
        const radius = 0.8 + Math.min(distance / 420, 1) * 1.6
        texture.circle(x, y, radius)
        texture.fill({ color: "#000000", alpha: baseAlpha + active * 0.01 })
      }
    }

    if (["manga-action", "impact-freeze-punch", "panel-smash-burst", "manga-speed-impact"].includes(profile)) {
      const edgeAlpha = 0.1 + active * 0.08 + rhythmPower * 0.06
      texture.rect(0, 0, this.frame.width, 18)
      texture.fill({ color: "#000000", alpha: edgeAlpha })
      texture.rect(0, this.frame.height - 24, this.frame.width, 24)
      texture.fill({ color: "#000000", alpha: edgeAlpha })
      texture.rect(0, 0, 16, this.frame.height)
      texture.fill({ color: "#000000", alpha: edgeAlpha * 0.78 })
      texture.rect(this.frame.width - 16, 0, 16, this.frame.height)
      texture.fill({ color: "#000000", alpha: edgeAlpha * 0.78 })
    }

    this.app.stage.addChild(texture)
  }

  drawActionSlashes(progress, timeSeconds, intensity) {
    const slashes = new Graphics()
    const pulse = 0.18 + Math.max(0, Math.sin(progress * Math.PI)) * 0.22

    for (let i = 0; i < 5; i += 1) {
      const x = ((timeSeconds * 150 + i * 92) % (this.frame.width + 170)) - 100
      const y = this.frame.height * (0.14 + i * 0.16)
      slashes.moveTo(x, y + 34)
      slashes.lineTo(x + 138, y - 22)
      slashes.stroke({ color: i % 2 ? "#ffd95a" : "#ffffff", alpha: pulse * (i % 2 ? 0.64 : 0.45), width: (2 + (i % 3)) * intensity })
    }

    for (let i = 0; i < 12; i += 1) {
      const x = (i * 47 + timeSeconds * 78) % this.frame.width
      const y = (i * 83 + timeSeconds * 34) % this.frame.height
      slashes.circle(x, y, 1.6 + (i % 3))
      slashes.fill({ color: "#ffd95a", alpha: 0.18 })
    }

    this.app.stage.addChild(slashes)
  }

  drawMangaImpactGlyphs(progress, timeSeconds, intensity) {
    const glyphs = new Graphics()
    const beat = Math.max(0, Math.sin(timeSeconds * 7.4))
    const alpha = (0.1 + beat * 0.18) * intensity

    for (let i = 0; i < 4; i += 1) {
      const x = i % 2 === 0 ? 28 + i * 22 : this.frame.width - 52 - i * 18
      const y = 92 + ((i * 137 + timeSeconds * 44) % (this.frame.height - 220))
      glyphs.moveTo(x, y)
      glyphs.lineTo(x + 24, y + 32)
      glyphs.lineTo(x - 5, y + 58)
      glyphs.stroke({ color: i % 2 ? "#ffd95a" : "#ffffff", alpha, width: 3 })
    }

    const ring = 26 + beat * 14 + Math.sin(progress * Math.PI) * 8
    glyphs.circle(this.frame.width * 0.5, this.frame.height * 0.48, ring)
    glyphs.stroke({ color: "#ffd95a", alpha: alpha * 0.8, width: 2 })
    this.app.stage.addChild(glyphs)
  }

  drawMangaSpeedImpact(progress, timeSeconds, intensity) {
    const p = this.easeOut(Math.min(progress / 0.62, 1))
    const hit = Math.max(0, 1 - Math.min(progress / 0.2, 1)) ** 1.45
    const surge = Math.sin(Math.min(progress / 0.7, 1) * Math.PI)
    const aftershock = Math.max(0, Math.sin(progress * Math.PI * 3.2)) * (1 - Math.min(progress, 1))
    const jitter = hit + aftershock * 0.55
    const cx = this.frame.width * (0.53 + Math.sin(timeSeconds * 0.8) * 0.014 + jitter * 0.012)
    const cy = this.frame.height * (0.47 + Math.cos(timeSeconds * 0.7) * 0.012 - jitter * 0.006)
    const accent = this.pixiColor("#ffd95a")

    this.drawMangaSpeedTunnel(cx, cy, p, hit, surge, timeSeconds, accent, intensity)
    this.drawMangaVelocityBands(p, hit, surge, timeSeconds, accent, intensity)
    this.drawSpeedImpactFocus(cx, cy, surge, hit)
  }

  drawMangaBurstFocusFrame(progress, timeSeconds, intensity) {
    const p = this.easeOut(progress)
    const cx = this.frame.width * (0.5 + Math.sin(timeSeconds * 0.26) * 0.015)
    const cy = this.frame.height * (0.48 + Math.cos(timeSeconds * 0.22) * 0.012)
    const ink = new Graphics()
    const paper = new Graphics()

    ink.rect(0, 0, this.frame.width, this.frame.height)
    ink.fill({ color: "#ffffff", alpha: 0.045 })
    for (let i = 0; i < 92; i += 1) {
      const angle = (i / 92) * Math.PI * 2 + Math.sin(i * 1.7) * 0.055
      const outer = Math.max(this.frame.width, this.frame.height) * (0.64 + (i % 6) * 0.05)
      const inner = 72 + (i % 8) * 18 - p * 18
      const wide = 12 + (i % 5) * 8
      const alpha = (0.055 + p * 0.052 + (i % 7 === 0 ? 0.065 : 0)) * intensity
      this.drawTaperedQuad(
        ink,
        cx + Math.cos(angle) * outer,
        cy + Math.sin(angle) * outer * 1.18,
        cx + Math.cos(angle) * inner,
        cy + Math.sin(angle) * inner * 0.82,
        wide,
        0.8,
        "#010101",
        alpha
      )
      if (i % 3 === 0) {
        this.drawTaperedQuad(
          paper,
          cx + Math.cos(angle + 0.015) * outer * 0.92,
          cy + Math.sin(angle + 0.015) * outer,
          cx + Math.cos(angle + 0.015) * (inner + 58),
          cy + Math.sin(angle + 0.015) * (inner + 58) * 0.82,
          3 + (i % 4) * 2,
          0.6,
          "#ffffff",
          (0.06 + p * 0.05) * intensity
        )
      }
    }

    ink.circle(cx, cy, 118 + p * 22)
    ink.fill({ color: "#ffffff", alpha: 0.24 })
    paper.circle(cx, cy, 126 + p * 20)
    paper.stroke({ color: "#ffffff", width: 5, alpha: 0.22 + p * 0.13 })
    this.app.stage.addChild(ink)
    this.app.stage.addChild(paper)
  }

  drawMangaHalftoneBurst(progress, timeSeconds, intensity) {
    const dots = new Graphics()
    const centerX = this.frame.width * 0.5
    const centerY = this.frame.height * 0.46
    const p = this.easeInOut(progress)

    for (let ray = 0; ray < 42; ray += 1) {
      const angle = (ray / 42) * Math.PI * 2 + Math.sin(ray * 1.37) * 0.045 + timeSeconds * 0.01
      for (let step = 4; step < 18; step += 1) {
        const radius = step * 34 + ((ray % 3) - 1) * 5
        const x = centerX + Math.cos(angle) * radius
        const y = centerY + Math.sin(angle) * radius * 1.04
        if (x < -20 || x > this.frame.width + 20 || y < -20 || y > this.frame.height + 20) continue
        const centerFade = Math.min(1, Math.max(0, (radius - 112) / 360))
        const size = (1.4 + centerFade * (5 + (ray % 4) * 1.2)) * intensity
        dots.circle(x, y, size)
        dots.fill({ color: ray % 5 === 0 ? "#ffd95a" : "#050505", alpha: (0.035 + centerFade * 0.075) * (0.7 + p * 0.3) })
      }
    }

    this.app.stage.addChild(dots)
    this.drawRadialBurst(centerX, centerY, (0.07 + p * 0.05) * intensity, timeSeconds, "#ffffff")
  }

  drawImpactFreezePunch(progress, timeSeconds, intensity) {
    const p = Math.min(Math.max(progress, 0), 1)
    const strike = Math.max(0, 1 - Math.min(p / 0.18, 1))
    const freezeHold = p > 0.08 && p < 0.42 ? 1 : Math.max(0, 1 - Math.abs(p - 0.25) * 5.2)
    const release = Math.sin(Math.min(Math.max((p - 0.28) / 0.54, 0), 1) * Math.PI)
    const aftershock = Math.max(0, Math.sin(p * Math.PI * 5.2)) * Math.max(0, 1 - p * 0.95)
    const pressure = Math.max(strike, freezeHold * 0.72, aftershock * 0.55)
    const cx = this.frame.width * (0.5 + Math.sin(timeSeconds * 0.9) * 0.01 + Math.sin(timeSeconds * 34) * strike * 0.018)
    const cy = this.frame.height * (0.455 + Math.cos(timeSeconds * 0.8) * 0.008 + Math.cos(timeSeconds * 29) * strike * 0.012)
    const flash = new Graphics()

    flash.rect(0, 0, this.frame.width, this.frame.height)
    flash.fill({ color: "#ffffff", alpha: Math.max(0, 0.18 - p * 0.55) + Math.max(0, 1 - Math.abs(p - 0.11) * 13) * 0.08 })
    flash.rect(0, 0, this.frame.width, 96 + pressure * 22)
    flash.fill({ color: "#020205", alpha: 0.08 + pressure * 0.055 })
    flash.rect(0, this.frame.height - 112 - pressure * 28, this.frame.width, 112 + pressure * 28)
    flash.fill({ color: "#020205", alpha: 0.09 + pressure * 0.065 })
    flash.poly([
      cx - this.frame.width * (0.27 + release * 0.08),
      cy - this.frame.height * 0.12,
      cx + this.frame.width * (0.28 + release * 0.08),
      cy - this.frame.height * 0.16,
      cx + this.frame.width * 0.22,
      cy + this.frame.height * 0.14,
      cx - this.frame.width * 0.31,
      cy + this.frame.height * 0.16
    ])
    flash.fill({ color: "#ffe95c", alpha: 0.035 + pressure * 0.04 })
    this.app.stage.addChild(flash)
    this.drawShockBurst(Math.min(1, pressure), timeSeconds)
    this.drawFreezePunchBands(pressure, timeSeconds, intensity)
    this.drawImpactPressureRings(cx, cy, p, pressure)
    this.drawImpactFrame(Math.min(1, 0.35 + pressure * 0.65))
  }

  drawSlashEnergyCut(progress, timeSeconds, intensity) {
    const slashes = new Graphics()
    const hit = Math.sin(progress * Math.PI)

    for (let i = 0; i < 5; i += 1) {
      const y = 88 + i * 112 + Math.sin(timeSeconds * 5 + i) * 16
      const skew = 94 + i * 8
      slashes.moveTo(-40, y + skew)
      slashes.lineTo(this.frame.width + 44, y - skew)
      slashes.stroke({ color: i % 2 ? "#83fff2" : "#ffffff", alpha: hit * (i % 2 ? 0.42 : 0.3) * intensity, width: i % 2 ? 7 : 3 })
    }

    this.app.stage.addChild(slashes)
    this.drawLateralSpeedLines(Math.min(1, progress + 0.1), timeSeconds)
  }

  drawPanelSmashBurst(progress, timeSeconds, intensity) {
    const hit = Math.max(0, Math.sin(progress * Math.PI))
    this.drawImpactFrame(hit)
    this.drawShockBurst(hit, timeSeconds)
    this.drawRadialBurst(this.frame.width * 0.5, this.frame.height * 0.5, hit * 0.28 * intensity, timeSeconds, "#ffef6a")
    this.drawMangaImpactGlyphs(progress, timeSeconds, intensity * 0.9)
  }

  drawMangaSpeedTunnel(cx, cy, progress, hit, surge, timeSeconds, accent, intensity) {
    const tunnel = new Graphics()
    const velocity = new Graphics()
    const w = this.frame.width
    const h = this.frame.height

    tunnel.rect(0, 0, w, h)
    tunnel.fill({ color: "#09080c", alpha: 0.025 + hit * 0.035 })
    tunnel.rect(0, 0, w, h)
    tunnel.stroke({ color: "#020205", width: 120, alpha: 0.13 + hit * 0.06 })
    tunnel.rect(0, 0, w, 96)
    tunnel.fill({ color: "#020205", alpha: 0.06 + hit * 0.05 })
    tunnel.rect(0, h - 150, w, 150)
    tunnel.fill({ color: "#020205", alpha: 0.08 + hit * 0.06 })

    for (let i = 0; i < 18; i += 1) {
      const lane = i / 17
      const leftY = this.lerp(-80, h + 80, lane)
      const rightY = h - leftY + Math.sin(timeSeconds * 4 + i) * 22
      this.drawTaperedQuad(tunnel, -130, leftY, cx - w * 0.26, cy + (leftY - h * 0.5) * 0.16, 38, 3, "#000000", (0.04 + hit * 0.03) * intensity)
      this.drawTaperedQuad(tunnel, w + 130, rightY, cx + w * 0.28, cy + (rightY - h * 0.5) * 0.14, 38, 3, "#000000", (0.04 + hit * 0.03) * intensity)
    }

    for (let i = 0; i < 24; i += 1) {
      const angle = -Math.PI * 0.82 + (i / 23) * Math.PI * 1.64 + Math.sin(timeSeconds * 1.8 + i) * 0.012
      if (Math.abs(Math.cos(angle)) < 0.18 && i % 5 !== 0) continue
      const inner = 142 + (i % 6) * 18
      const outer = 470 + ((i * 37) % 180)
      const width = 2 + (i % 4) * 1.35
      const color = i % 5 === 0 ? "#ffffff" : i % 3 === 0 ? "#ff335f" : accent
      const alpha = (i % 5 === 0 ? 0.15 : 0.095) * progress * intensity
      this.drawTaperedQuad(
        velocity,
        cx + Math.cos(angle) * inner,
        cy + Math.sin(angle) * inner,
        cx + Math.cos(angle) * outer,
        cy + Math.sin(angle) * outer,
        Math.max(1.5, width * 0.2),
        width,
        color,
        alpha
      )
    }

    this.app.stage.addChild(tunnel)
    this.app.stage.addChild(velocity)
  }

  drawMangaVelocityBands(progress, hit, surge, timeSeconds, accent, intensity) {
    const bands = new Graphics()
    const w = this.frame.width
    const h = this.frame.height

    for (let i = 0; i < 22; i += 1) {
      const y = -100 + ((i * 83 + timeSeconds * (520 + hit * 320)) % (h + 220))
      const length = 220 + (i % 6) * 56 + hit * 90
      const width = 5 + (i % 4) * 2.4 + hit * 4
      const fromLeft = i % 2 === 0
      const x1 = fromLeft ? -120 : w + 120
      const x2 = fromLeft ? x1 + length : x1 - length
      const y2 = y - 120 - (i % 5) * 22
      this.drawTaperedQuad(bands, x1, y, x2, y2, width, 1.2, i % 5 === 0 ? "#ffffff" : accent, (0.075 + surge * 0.045 + hit * 0.055) * intensity)
    }

    bands.poly([0, h * 0.14, w * 0.33, h * 0.06, w * 0.29, h * 0.11, 0, h * 0.2])
    bands.fill({ color: "#ffffff", alpha: 0.05 + hit * 0.06 })
    bands.poly([w, h * 0.82, w * 0.64, h * 0.93, w * 0.68, h * 0.86, w, h * 0.74])
    bands.fill({ color: "#ffffff", alpha: 0.045 + hit * 0.06 })
    this.app.stage.addChild(bands)
  }

  drawSpeedImpactFocus(cx, cy, surge, hit) {
    const focus = new Graphics()

    focus.ellipse(cx, cy, this.frame.width * (0.31 + surge * 0.018), this.frame.height * (0.255 + surge * 0.014))
    focus.stroke({ color: "#ffffff", width: 3, alpha: 0.11 + hit * 0.08 })
    focus.ellipse(cx, cy, this.frame.width * (0.44 + surge * 0.025), this.frame.height * (0.34 + surge * 0.018))
    focus.stroke({ color: "#ffd95a", width: 2, alpha: 0.09 + hit * 0.06 })
    focus.rect(0, 0, this.frame.width, this.frame.height)
    focus.stroke({ color: "#020205", width: 24 + hit * 10, alpha: 0.08 + hit * 0.04 })
    this.app.stage.addChild(focus)
  }

  drawImpactPressureRings(cx, cy, progress, pressure) {
    const rings = new Graphics()
    const wave = this.easeOut(Math.min(progress / 0.64, 1))

    for (let i = 0; i < 6; i += 1) {
      const ring = 0.46 + i * 0.22 + wave * 0.74
      const alpha = Math.max(0, 0.09 - i * 0.012) + pressure * 0.035
      rings.ellipse(cx, cy, this.frame.width * 0.3 * ring, this.frame.height * 0.24 * ring)
      rings.stroke({ color: i % 2 ? "#ffe95c" : "#ffffff", width: 2 + (i % 3), alpha })
    }

    this.app.stage.addChild(rings)
  }

  drawInkFlashImpact(progress, timeSeconds, intensity) {
    const hit = Math.max(0, Math.sin(progress * Math.PI))
    this.drawInkFlash(Math.min(1, 0.18 + hit * 0.72), timeSeconds)
    this.drawRadialBurst(this.frame.width * 0.5, this.frame.height * 0.47, hit * 0.12 * intensity, timeSeconds, "#ffffff")
  }

  drawRadialBurst(cx, cy, alpha, timeSeconds, color) {
    const burst = new Graphics()

    for (let i = 0; i < 56; i += 1) {
      const angle = (i / 56) * Math.PI * 2 + Math.sin(timeSeconds * 0.6 + i) * 0.025
      const inner = 68 + (i % 6) * 8
      const outer = 420 + (i % 8) * 18
      burst.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner)
      burst.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer)
      burst.stroke({ color, alpha: alpha * (i % 4 === 0 ? 1 : 0.58), width: i % 4 === 0 ? 3 : 1 })
    }

    this.app.stage.addChild(burst)
  }

  drawFreezePunchBands(hit, timeSeconds, intensity) {
    const bands = new Graphics()

    for (let i = 0; i < 7; i += 1) {
      const y = (i * 91 + timeSeconds * 18) % this.frame.height
      const offset = Math.sin(timeSeconds * 12 + i) * 26
      bands.rect(offset, y, this.frame.width, 4 + (i % 3) * 3)
      bands.fill({ color: i % 2 ? "#ffd95a" : "#ffffff", alpha: hit * 0.16 * intensity })
    }

    this.app.stage.addChild(bands)
  }

  drawScifiHud(progress, timeSeconds, intensity) {
    const hud = new Graphics()
    const cyan = "#55f0c8"
    const magenta = "#ff3d7f"
    const alpha = 0.24 + Math.sin(timeSeconds * 3) * 0.05
    const scanY = (timeSeconds * 86) % this.frame.height

    hud.rect(0, scanY, this.frame.width, 3)
    hud.fill({ color: cyan, alpha: 0.22 * intensity })
    hud.rect(0, scanY + 8, this.frame.width, 1)
    hud.fill({ color: magenta, alpha: 0.18 * intensity })

    for (let i = 0; i < 6; i += 1) {
      const x = 24 + i * 58
      hud.moveTo(x, 54)
      hud.lineTo(x + 18, 54)
      hud.stroke({ color: cyan, alpha: 0.16, width: 1 })
      hud.moveTo(x, this.frame.height - 54)
      hud.lineTo(x + 24, this.frame.height - 54)
      hud.stroke({ color: cyan, alpha: 0.14, width: 1 })
    }

    const inset = 30 + Math.sin(progress * Math.PI) * 6
    hud.moveTo(inset, 72)
    hud.lineTo(inset + 46, 72)
    hud.moveTo(inset, 72)
    hud.lineTo(inset, 118)
    hud.moveTo(this.frame.width - inset, 72)
    hud.lineTo(this.frame.width - inset - 46, 72)
    hud.moveTo(this.frame.width - inset, 72)
    hud.lineTo(this.frame.width - inset, 118)
    hud.moveTo(inset, this.frame.height - 72)
    hud.lineTo(inset + 46, this.frame.height - 72)
    hud.moveTo(inset, this.frame.height - 72)
    hud.lineTo(inset, this.frame.height - 118)
    hud.moveTo(this.frame.width - inset, this.frame.height - 72)
    hud.lineTo(this.frame.width - inset - 46, this.frame.height - 72)
    hud.moveTo(this.frame.width - inset, this.frame.height - 72)
    hud.lineTo(this.frame.width - inset, this.frame.height - 118)
    hud.stroke({ color: cyan, alpha, width: 2 })

    this.app.stage.addChild(hud)
  }

  drawHologramBlocks(progress, timeSeconds, intensity) {
    const blocks = new Graphics()
    const alpha = (0.08 + Math.sin(progress * Math.PI) * 0.1) * intensity

    for (let i = 0; i < 7; i += 1) {
      const width = 22 + (i % 3) * 16
      const x = (i * 61 + timeSeconds * 34) % this.frame.width
      const y = 70 + ((i * 83 + timeSeconds * 19) % (this.frame.height - 170))
      blocks.rect(x, y, width, 7)
      blocks.fill({ color: i % 2 ? "#55f0c8" : "#ff3d7f", alpha })
      blocks.rect(x + width + 6, y, 6, 7)
      blocks.fill({ color: "#ffffff", alpha: alpha * 0.65 })
    }

    this.app.stage.addChild(blocks)
  }

  drawHorrorSignal(progress, timeSeconds, intensity) {
    const signal = new Graphics()
    const pulse = 0.1 + Math.max(0, Math.sin(timeSeconds * 5)) * 0.06

    signal.rect(0, 0, this.frame.width, this.frame.height)
    signal.fill({ color: "#14050c", alpha: 0.16 * intensity })

    for (let y = 0; y < this.frame.height; y += 9) {
      signal.rect(0, y, this.frame.width, 1)
      signal.fill({ color: "#ffffff", alpha: 0.035 })
    }

    for (let i = 0; i < 4; i += 1) {
      const y = ((timeSeconds * 54 + i * 133) % this.frame.height)
      const x = Math.sin(timeSeconds * 10 + i) * 18
      signal.rect(x, y, this.frame.width, 7 + i * 2)
      signal.fill({ color: i % 2 ? "#ff3d7f" : "#ffffff", alpha: pulse })
    }

    const edge = Math.max(0, Math.sin(progress * Math.PI))
    signal.roundRect(18, 36, this.frame.width - 36, this.frame.height - 72, 18)
    signal.stroke({ color: "#ff3d7f", alpha: 0.14 + edge * 0.12, width: 2 })
    this.app.stage.addChild(signal)
  }

  drawRomancePetals(progress, timeSeconds, intensity) {
    const petals = new Graphics()

    for (let i = 0; i < 18; i += 1) {
      const drift = (timeSeconds * (18 + i % 5) + i * 37) % (this.frame.height + 70)
      const x = (i * 43 + Math.sin(timeSeconds * 0.8 + i) * 28) % this.frame.width
      const y = drift - 46
      petals.ellipse(x, y, 3 + (i % 3), 7 + (i % 4), Math.sin(timeSeconds + i) * 0.7)
      petals.fill({ color: i % 3 ? "#ff8ab8" : "#ffd6e7", alpha: 0.12 * intensity })
    }

    this.drawSparkles(petals, progress, timeSeconds, "#ffd6e7", 0.17)
    this.app.stage.addChild(petals)
  }

  drawFantasySpark(progress, timeSeconds, intensity) {
    const aura = new Graphics()
    const glow = 0.1 + Math.sin(progress * Math.PI) * 0.09

    for (let i = 0; i < 4; i += 1) {
      const radius = 72 + i * 44 + Math.sin(timeSeconds * 1.1 + i) * 8
      aura.circle(this.frame.width / 2, this.frame.height * 0.48, radius)
      aura.stroke({ color: i % 2 ? "#9b7cff" : "#55f0c8", alpha: glow * intensity, width: 1 })
    }

    this.drawSparkles(aura, progress, timeSeconds, "#f8ff91", 0.2)
    this.app.stage.addChild(aura)
  }

  drawComedyPop(progress, timeSeconds, intensity) {
    const pop = new Graphics()
    const beat = Math.max(0, Math.sin(timeSeconds * 5.4))

    for (let i = 0; i < 9; i += 1) {
      const x = (32 + i * 49 + Math.sin(timeSeconds + i) * 9) % this.frame.width
      const y = 74 + ((i * 71 + timeSeconds * 26) % (this.frame.height - 148))
      const radius = 5 + beat * 4 + (i % 3)
      pop.circle(x, y, radius)
      pop.stroke({ color: i % 2 ? "#ffd95a" : "#ff3d7f", alpha: 0.18 * intensity, width: 2 })
    }

    this.drawSparkles(pop, progress, timeSeconds, "#ffffff", 0.13)
    this.app.stage.addChild(pop)
  }

  drawEditorialGrain(timeSeconds) {
    const grain = new Graphics()

    for (let i = 0; i < 22; i += 1) {
      const x = (i * 53 + Math.floor(timeSeconds * 4) * 17) % this.frame.width
      const y = (i * 97 + Math.floor(timeSeconds * 3) * 23) % this.frame.height
      grain.rect(x, y, 1 + (i % 3), 1)
      grain.fill({ color: i % 2 ? "#ffffff" : "#000000", alpha: 0.045 })
    }

    this.app.stage.addChild(grain)
  }

  drawSparkles(graphics, progress, timeSeconds, color, alpha) {
    const phase = Math.sin(progress * Math.PI)

    for (let i = 0; i < 14; i += 1) {
      const x = (i * 61 + timeSeconds * (12 + i % 4)) % this.frame.width
      const y = (i * 89 + timeSeconds * (9 + i % 5)) % this.frame.height
      const radius = 2 + Math.max(0, Math.sin(timeSeconds * 2.2 + i)) * 2

      graphics.moveTo(x - radius, y)
      graphics.lineTo(x + radius, y)
      graphics.moveTo(x, y - radius)
      graphics.lineTo(x, y + radius)
      graphics.stroke({ color, alpha: alpha * (0.45 + phase * 0.55), width: 1 })
    }
  }

  drawSpeedLines(alpha, intensity) {
    const lines = new Graphics()
    const cx = this.frame.width * 0.52
    const cy = this.frame.height * 0.48
    for (let i = 0; i < 42; i += 1) {
      const angle = -Math.PI * 0.82 + (i / 41) * Math.PI * 1.64
      const inner = 72 + (i % 7) * 5
      const outer = 330 + (i % 9) * 10
      lines.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner)
      lines.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer)
      lines.stroke({ color: i % 5 === 0 ? "#ffffff" : "#000000", alpha: alpha * (i % 5 === 0 ? 0.42 : 0.28), width: (i % 5 === 0 ? 2 : 1) * intensity })
    }
    this.app.stage.addChild(lines)
  }

  drawHalftone(alpha) {
    const dots = new Graphics()
    for (let y = 0; y < this.frame.height; y += 18) {
      for (let x = 0; x < this.frame.width; x += 18) {
        const radius = 1.2 + Math.sin(x * 0.06 + y * 0.04) * 0.8
        dots.circle(x, y, Math.max(0.8, radius))
        dots.fill({ color: "#ffffff", alpha })
      }
    }
    this.app.stage.addChild(dots)
  }

  drawGlitchBands(timeSeconds) {
    const bands = new Graphics()
    for (let i = 0; i < 5; i += 1) {
      const y = ((timeSeconds * 90 + i * 89) % this.frame.height)
      const height = 5 + (i % 3) * 4
      const x = Math.sin(timeSeconds * 12 + i) * 14
      bands.rect(x, y, this.frame.width, height)
      bands.fill({ color: i % 2 ? "#55f0c8" : "#ff3d7f", alpha: 0.14 })
    }
    this.app.stage.addChild(bands)
  }

  drawReadingGradient(progress) {
    const scan = new Graphics()
    const y = this.lerp(34, this.frame.height - 120, progress)
    scan.rect(0, y - 46, this.frame.width, 92)
    scan.fill({ color: "#ffffff", alpha: 0.055 })
    this.app.stage.addChild(scan)
  }

  drawWipeLine(x) {
    const line = new Graphics()
    line.rect(x - 4, 0, 8, this.frame.height)
    line.fill({ color: "#ffffff", alpha: 0.7 })
    line.rect(x - 16, 0, 5, this.frame.height)
    line.fill({ color: "#55f0c8", alpha: 0.34 })
    this.app.stage.addChild(line)
  }

  drawLateralSpeedLines(progress, timeSeconds) {
    const lines = new Graphics()
    const alpha = Math.sin(progress * Math.PI) * 0.36

    for (let i = 0; i < 22; i += 1) {
      const y = (i * 31 + timeSeconds * 130) % this.frame.height
      const length = 44 + (i % 4) * 26
      const x = ((timeSeconds * 120 + i * 47) % this.frame.width) - 70
      lines.moveTo(x, y)
      lines.lineTo(x + length, y - 8)
      lines.stroke({ color: i % 3 ? "#ffffff" : "#55f0c8", alpha, width: i % 3 ? 2 : 3 })
    }

    this.app.stage.addChild(lines)
  }

  drawShockBurst(progress, timeSeconds) {
    const burst = new Graphics()
    const alpha = Math.sin(progress * Math.PI) * 0.38
    const cx = this.frame.width / 2 + Math.sin(timeSeconds * 10) * 8
    const cy = this.frame.height / 2

    for (let i = 0; i < 18; i += 1) {
      const angle = (i / 18) * Math.PI * 2
      const inner = 38 + (i % 3) * 8
      const outer = 150 + (i % 5) * 18
      burst.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner)
      burst.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer)
      burst.stroke({ color: i % 2 ? "#ffd95a" : "#ffffff", alpha, width: i % 2 ? 3 : 2 })
    }

    this.app.stage.addChild(burst)
  }

  drawPaperShards(x, progress, timeSeconds) {
    const shards = new Graphics()
    const alpha = Math.sin(progress * Math.PI) * 0.26

    for (let i = 0; i < 9; i += 1) {
      const y = (i * 79 + timeSeconds * 41) % this.frame.height
      const sx = x + Math.sin(timeSeconds * 2 + i) * 30
      shards.poly([sx, y, sx + 18, y + 6, sx + 4, y + 28])
      shards.fill({ color: i % 2 ? "#ffffff" : "#55f0c8", alpha })
    }

    this.app.stage.addChild(shards)
  }

  drawTransitionFlash(progress, strength) {
    const alpha = Math.sin(progress * Math.PI) * strength
    if (alpha <= 0.01) return

    const flash = new Graphics()
    flash.rect(0, 0, this.frame.width, this.frame.height)
    flash.fill({ color: "#ffffff", alpha })
    flash.roundRect(24, 40, this.frame.width - 48, this.frame.height - 80, 16)
    flash.stroke({ color: "#ffd95a", alpha: alpha * 1.8, width: 4 })
    this.app.stage.addChild(flash)
  }

  drawRhythmAccent(rhythm, timeSeconds) {
    if (!rhythm || rhythm.power <= 0.02) return

    const power = rhythm.power * (Number(rhythm.strength) || 0.5)
    if (rhythm.kind === "impact") {
      this.drawImpactFrame(Math.min(1, power * 1.2))
      this.drawShockBurst(Math.min(1, power), timeSeconds)
      this.drawRhythmFlash(power, "#ffffff")
    } else if (rhythm.kind === "entry") {
      this.drawRhythmFlash(power * 0.38, "#55f0c8")
    } else if (rhythm.kind === "exit") {
      this.drawRhythmFlash(power * 0.46, "#ffd95a")
    } else if (rhythm.kind === "story") {
      this.drawRhythmFocus(power)
    }
  }

  drawRhythmFlash(power, color) {
    const alpha = Math.min(power * 0.16, 0.2)
    if (alpha <= 0.01) return

    const flash = new Graphics()
    flash.rect(0, 0, this.frame.width, this.frame.height)
    flash.fill({ color, alpha })
    this.app.stage.addChild(flash)
  }

  drawRhythmFocus(power) {
    const focus = new Graphics()
    const inset = 34 - power * 8

    focus.roundRect(inset, 58, this.frame.width - inset * 2, this.frame.height - 116, 18)
    focus.stroke({ color: "#55f0c8", alpha: Math.min(0.22, power * 0.24), width: 2 })
    this.app.stage.addChild(focus)
  }

  drawSliceLines(x) {
    const lines = new Graphics()
    for (let i = -1; i < 3; i += 1) {
      lines.moveTo(x + i * 42, 0)
      lines.lineTo(x - 92 + i * 42, this.frame.height)
      lines.stroke({ color: i === 0 ? "#ffffff" : "#55f0c8", alpha: i === 0 ? 0.72 : 0.28, width: i === 0 ? 3 : 1 })
    }
    this.app.stage.addChild(lines)
  }

  drawImpactFrame(progress) {
    const frame = new Graphics()
    const inset = 26 - progress * 10
    frame.roundRect(inset, inset + 18, this.frame.width - inset * 2, this.frame.height - inset * 2 - 36, 12)
    frame.stroke({ color: "#ffd95a", alpha: 0.24 + progress * 0.42, width: 2 + progress * 3 })
    this.app.stage.addChild(frame)
  }

  drawInkFlash(progress, timeSeconds) {
    const ink = new Graphics()
    ink.rect(0, 0, this.frame.width, this.frame.height)
    ink.fill({ color: "#ffffff", alpha: Math.max(0, Math.sin(progress * Math.PI)) * 0.25 })
    for (let i = 0; i < 7; i += 1) {
      const y = this.frame.height * (0.08 + i * 0.15) + Math.sin(timeSeconds * 9 + i) * 10
      const reach = this.frame.width * (0.1 + progress * (1.1 - i * 0.025)) - i * 8
      ink.poly([-20, y - 24, reach + 54, y - 16, reach + 28, y + 28, -20, y + 28])
      ink.fill({ color: i % 2 ? "#020206" : "#ffffff", alpha: i % 2 ? 0.13 * (1 - progress) : 0.08 * Math.sin(progress * Math.PI) })
    }
    for (let i = 0; i < 9; i += 1) {
      const x = this.frame.width * (0.1 + ((i * 0.23 + timeSeconds * 0.02) % 0.82))
      const y = this.frame.height * (0.12 + ((i * 0.19 + timeSeconds * 0.03) % 0.76))
      ink.circle(x, y, (18 + i * 4) * progress)
      ink.fill({ color: "#020206", alpha: 0.18 * (1 - progress) })
    }
    this.app.stage.addChild(ink)
  }

  drawGlitchTear(progress, timeSeconds, direction) {
    const tear = new Graphics()
    const hit = Math.sin(progress * Math.PI)
    const center = this.frame.width * (0.48 + direction * 0.08 * (progress - 0.5))

    for (let i = 0; i < 8; i += 1) {
      const y = this.frame.height * (0.08 + i * 0.12) + Math.sin(timeSeconds * 18 + i) * 16
      const offset = Math.sin(timeSeconds * 22 + i * 1.7) * 34
      const width = 18 + hit * (32 + i * 4)
      tear.poly([
        center + offset - width * direction,
        y - 24,
        center + offset + width * direction,
        y - 12,
        center + offset + (width * 0.4) * direction,
        y + 26,
        center + offset - (width * 1.4) * direction,
        y + 16
      ])
      tear.fill({ color: i % 2 ? "#020206" : "#ffffff", alpha: hit * (i % 2 ? 0.36 : 0.18) })
      tear.rect(direction > 0 ? 0 : center + offset, y - 5, Math.abs(center + offset), 7 + (i % 3) * 5)
      tear.fill({ color: i % 2 ? "#55f0c8" : "#ff3d7f", alpha: hit * 0.12 })
    }

    this.app.stage.addChild(tear)
    this.drawGlitchBands(timeSeconds * 1.35)
  }

  drawVerticalScrollCut(progress, timeSeconds) {
    const lines = new Graphics()
    const y = this.frame.height * (1 - progress)
    lines.rect(0, y - 5, this.frame.width, 10)
    lines.fill({ color: "#ffffff", alpha: 0.65 })
    lines.rect(0, y - 17, this.frame.width, 3)
    lines.fill({ color: "#55f0c8", alpha: 0.34 })

    for (let i = 0; i < 12; i += 1) {
      const lineY = y + i * 30 - ((timeSeconds * 90) % 30)
      lines.moveTo(0, lineY)
      lines.lineTo(this.frame.width, lineY)
      lines.stroke({ color: i % 3 ? "#ffffff" : "#ffd95a", alpha: 0.12 * Math.sin(progress * Math.PI), width: i % 3 ? 1 : 2 })
    }

    this.app.stage.addChild(lines)
  }

  drawFinish() {
    const vignette = new Graphics()
    vignette.rect(0, 0, this.frame.width, 54)
    vignette.fill({ color: "#000000", alpha: 0.16 })
    vignette.rect(0, this.frame.height - 82, this.frame.width, 82)
    vignette.fill({ color: "#000000", alpha: 0.22 })
    this.app.stage.addChild(vignette)

    const safeFrame = new Graphics()
    safeFrame.roundRect(24, 40, this.frame.width - 48, this.frame.height - 80, 16)
    safeFrame.stroke({ color: "#ffffff", alpha: 0.16, width: 1 })
    this.app.stage.addChild(safeFrame)
  }

  transitionFor(shot) {
    const transition = shot.pixiTransitionOut?.transitionType || shot.transition || "cut"
    return ["none", "cut"].includes(transition) ? "none" : transition
  }

  transitionDurationFor(shot) {
    const authoredDuration = Number(shot.pixiTransitionOut?.parameters?.durationMs)
    if (authoredDuration > 0) return Math.min(authoredDuration, Math.max(260, shot.durationMs * 0.42))

    return Math.min(TRANSITION_MS, Math.max(260, shot.durationMs * 0.34))
  }

  captionOverlay(shot) {
    if (shot.overlay?.text) return shot.overlay
    if (shot.noText === true || !shot.text || shot.scenePosition === "none") return null

    return {
      text: shot.text,
      style: shot.sceneBubble,
      position: shot.scenePosition,
      size: shot.sceneSize
    }
  }

  drawCaption(shot, overlay, progress, timeSeconds) {
    const textContract = shot.pixiTextStyle || {}
    const textParameters = textContract.parameters || {}
    const style = textContract.layout || overlay.style || "caption"
    const animation = textContract.textAnimation || "rise_lock"
    const size = textParameters.size || overlay.size
    const position = textParameters.position || overlay.position
    const fontSize = this.captionFontSize(size)
    const captionHeight = Math.max(68, fontSize * 3.55)
    const y = this.captionY(position, captionHeight)
    const enter = this.captionEnter(animation, progress)
    const textProgress = this.captionTextProgress(animation, progress)
    const panelScale = this.captionScale(animation, progress)
    const panel = new Graphics()
    const x = 28
    const width = this.frame.width - 56
    const lift = this.captionLift(animation, enter, timeSeconds)
    const panelY = y + lift
    const scaledWidth = width * panelScale
    const scaledHeight = captionHeight * panelScale
    const panelX = x + (width - scaledWidth) / 2
    const panelDrawY = panelY + (captionHeight - scaledHeight) / 2
    const loadedTextFrames = this.drawAssetSlotOverlays(this.textAssetSlotsForShot(shot), progress, timeSeconds, { kind: "text", power: enter })
    const useAssetFrame = loadedTextFrames > 0 && ["burst", "speech", "thought", "manga_vertical"].includes(style)

    if (style === "burst") {
      this.drawCaptionRays(panelX + scaledWidth / 2, panelDrawY + scaledHeight / 2, enter, timeSeconds)
      if (!useAssetFrame) this.drawCaptionBurstPanel(panelX, panelDrawY, scaledWidth, scaledHeight, enter, timeSeconds)
    } else if (style === "speech" || style === "thought") {
      if (!useAssetFrame) {
        panel.roundRect(panelX, panelDrawY, scaledWidth, scaledHeight, 18)
        panel.fill({ color: "#fffaf0", alpha: 0.94 })
        panel.stroke({ color: "#15151d", alpha: 0.72, width: 2 })
        panel.poly([panelX + scaledWidth * 0.72, panelDrawY + scaledHeight - 2, panelX + scaledWidth * 0.84, panelDrawY + scaledHeight + 18 * enter, panelX + scaledWidth * 0.62, panelDrawY + scaledHeight - 2])
        panel.fill({ color: "#fffaf0", alpha: 0.94 })
      }
      if (style === "thought") this.drawThoughtDots(panelX + scaledWidth * 0.74, panelDrawY + scaledHeight + 16, enter)
    } else if (style === "manga_vertical") {
      const verticalHeight = this.frame.height - 124
      const verticalY = 62 + lift
      if (!useAssetFrame) {
        panel.roundRect(this.frame.width - 96, verticalY, 62, verticalHeight, 10)
        panel.fill({ color: "#fffaf0", alpha: 0.93 })
        panel.stroke({ color: "#111111", alpha: 0.84, width: 2 })
      }
      this.drawMangaTextGuide(this.frame.width - 96, verticalY, 62, verticalHeight, enter)
    } else {
      panel.roundRect(panelX, panelDrawY, scaledWidth, scaledHeight, 12)
      panel.fill({ color: "#09090f", alpha: 0.84 })
      panel.stroke({ color: "#ffffff", alpha: 0.2 + enter * 0.12, width: 1 })
    }
    if (style !== "burst" && !useAssetFrame) {
      panel.alpha = enter
      this.app.stage.addChild(panel)
    }

    const darkText = style === "speech" || style === "thought" || style === "manga_vertical"
    const visibleText = this.visibleCaptionText(overlay.text.toUpperCase(), textProgress)
    const label = new Text({
      text: visibleText,
      style: new TextStyle({
        fill: darkText ? "#15151d" : "#ffffff",
        fontFamily: "Inter, Arial",
        fontSize,
        fontWeight: "900",
        align: "center",
        wordWrap: true,
        wordWrapWidth: style === "manga_vertical" ? 44 : this.frame.width - 88
      })
    })

    if (style === "manga_vertical") {
      label.x = this.frame.width - 86
      label.y = 82 + lift
    } else {
      label.x = 44 + (1 - panelScale) * 12
      label.y = y + 14 + lift + (1 - panelScale) * 8
    }
    label.alpha = enter
    this.app.stage.addChild(label)
  }

  captionEnter(animation, progress) {
    const speed = animation === "pop_lock" ? 0.16 : animation === "manga_reveal" ? 0.32 : 0.22

    return this.easeOut(Math.min(progress / speed, 1))
  }

  captionTextProgress(animation, progress) {
    if (!["manga_reveal", "type_lock"].includes(animation)) return 1

    return Math.min(progress / 0.46, 1)
  }

  captionScale(animation, progress) {
    if (animation !== "pop_lock") return 1

    const hit = Math.sin(Math.min(progress / 0.2, 1) * Math.PI)
    return 0.96 + hit * 0.07
  }

  captionLift(animation, enter, timeSeconds) {
    if (animation === "bubble_rise") return (1 - enter) * 22 + Math.sin(timeSeconds * 2.2) * 1.5
    if (animation === "pop_lock") return (1 - enter) * 8

    return (1 - enter) * 18
  }

  visibleCaptionText(text, progress) {
    const count = Math.max(1, Math.ceil(text.length * progress))

    return text.slice(0, count)
  }

  drawCaptionRays(cx, cy, enter, timeSeconds) {
    const rays = new Graphics()
    const alpha = enter * 0.28

    for (let i = 0; i < 12; i += 1) {
      const angle = (i / 12) * Math.PI * 2 + Math.sin(timeSeconds + i) * 0.04
      const inner = 54
      const outer = 84 + (i % 3) * 8
      rays.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner)
      rays.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer)
      rays.stroke({ color: i % 2 ? "#ffd95a" : "#ffffff", alpha, width: i % 2 ? 3 : 2 })
    }

    this.app.stage.addChild(rays)
  }

  drawCaptionBurstPanel(x, y, width, height, enter, timeSeconds) {
    const cx = x + width / 2
    const cy = y + height / 2
    const burst = new Graphics()
    const points = []
    const count = 18
    const wobble = Math.sin(timeSeconds * 9) * 1.5

    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2
      const isSpike = i % 2 === 0
      const rx = width * (isSpike ? 0.56 : 0.49) + ((i % 3) - 1) * 3 + wobble
      const ry = height * (isSpike ? 0.68 : 0.48) + ((i % 4) - 1.5) * 2
      points.push(cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry)
    }

    burst.poly(points)
    burst.fill({ color: "#fff7d6", alpha: 0.96 * enter })
    burst.stroke({ color: "#111111", alpha: 0.92 * enter, width: 4 })

    const innerPoints = []
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2
      const isSpike = i % 2 === 0
      const rx = width * (isSpike ? 0.48 : 0.42)
      const ry = height * (isSpike ? 0.56 : 0.4)
      innerPoints.push(cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry)
    }

    burst.poly(innerPoints)
    burst.fill({ color: "#101018", alpha: 0.92 * enter })
    burst.stroke({ color: "#ffd95a", alpha: (0.6 + enter * 0.22), width: 2 })

    this.app.stage.addChild(burst)
  }

  drawThoughtDots(x, y, enter) {
    const dots = new Graphics()

    for (let i = 0; i < 3; i += 1) {
      dots.circle(x + i * 12, y + i * 8, 3 + i)
      dots.fill({ color: "#fffaf0", alpha: enter * 0.88 })
      dots.stroke({ color: "#15151d", alpha: enter * 0.42, width: 1 })
    }

    this.app.stage.addChild(dots)
  }

  drawMangaTextGuide(x, y, width, height, enter) {
    const guide = new Graphics()

    for (let i = 1; i < 4; i += 1) {
      const gx = x + (width / 4) * i
      guide.moveTo(gx, y + 14)
      guide.lineTo(gx, y + height - 14)
      guide.stroke({ color: "#111111", alpha: 0.08 * enter, width: 1 })
    }

    this.app.stage.addChild(guide)
  }

  captionFontSize(size) {
    return {
      small: 15,
      medium: 18,
      large: 22
    }[size] || 18
  }

  captionY(position, captionHeight) {
    if (position === "top_safe") return 54
    if (position === "center_safe") return (this.frame.height - captionHeight) / 2
    if (position === "bottom_real") return this.frame.height - captionHeight - 18

    return this.frame.height - captionHeight - 42
  }

  drawPlaceholder(layer, shot) {
    const card = new Graphics()
    card.roundRect(34, 72, this.frame.width - 68, this.frame.height - 144, 18)
    card.fill("#27272a")
    card.stroke({ color: "#71717a", alpha: 0.7, width: 1 })
    layer.addChild(card)

    const label = new Text({
      text: shot.filename || shot.label,
      style: new TextStyle({
        fill: "#e4e4e7",
        fontFamily: "Arial",
        fontSize: 16,
        fontWeight: "700",
        wordWrap: true,
        wordWrapWidth: this.frame.width - 100
      })
    })

    label.x = 52
    label.y = 96
    layer.addChild(label)
  }

  updateStatus(shot, playheadMs) {
    if (shot) this.currentShotIndex = this.shots.indexOf(shot)

    const current = this.shots.length ? this.currentShotIndex + 1 : 0
    const sceneCount = `${current} / ${this.shots.length}`

    if (this.hasStatusTarget) this.statusTarget.textContent = sceneCount
    if (this.hasCurrentTitleTarget) this.currentTitleTarget.textContent = shot?.label ? `${shot.label} / ${this.shots.length}` : sceneCount
    if (this.hasTimeTarget) this.timeTarget.textContent = `${this.formatTime(playheadMs)} / ${this.formatTime(this.durationMs)}`
    if (this.hasProgressTarget) this.progressTarget.style.width = `${this.durationMs ? (playheadMs / this.durationMs) * 100 : 0}%`
  }

  updatePlaybackControls() {
    if (!this.hasPlayButtonTarget) return

    this.playButtonTarget.setAttribute("aria-pressed", String(this.isPlaying))
    if (this.hasPlayLabelTarget) {
      this.playLabelTarget.textContent = this.isPlaying ? this.playButtonTarget.dataset.pauseLabel : this.playButtonTarget.dataset.playLabel
    }
  }

  formatTime(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000))
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = String(totalSeconds % 60).padStart(2, "0")

    return `${minutes}:${seconds}`
  }

  intensityMultiplier(shot = {}) {
    const intensity = shot.effectIntensity || shot.motion?.intensity || this.payload.contract.visual?.intensity || "auto"

    return {
      subtle: 0.55,
      balanced: 1,
      intense: 1.45
    }[intensity] || 1
  }

  genreProfile() {
    const genre = String(this.payload.contract.proposal?.genre || "").toLowerCase()

    if (["action", "battle", "shonen"].includes(genre)) return "manga-action"
    if (["sci_fi", "scifi", "science_fiction", "cyberpunk"].includes(genre)) return "scifi-hud"
    if (["horror", "thriller", "suspense"].includes(genre)) return "horror-signal"
    if (["romance", "romantic"].includes(genre)) return "romance-petals"
    if (["fantasy", "magic", "adventure"].includes(genre)) return "fantasy-spark"
    if (["comedy", "humor"].includes(genre)) return "comedy-pop"

    return "editorial-grain"
  }

  activeEffectProfileFor(shot = {}) {
    const layout = shot.pixiActiveEffect?.layout || shot.pixiActiveEffect?.parameters?.profile
    if (!layout) return this.genreProfile()

    if (layout.includes("speed-impact")) return "manga-speed-impact"
    if (layout.includes("burst-focus")) return "manga-burst-focus"
    if (layout.includes("halftone-burst")) return "manga-halftone-burst"
    if (layout.includes("impact-freeze")) return "impact-freeze-punch"
    if (layout.includes("slash-energy")) return "slash-energy-cut"
    if (layout.includes("sfx-slam")) return "manga-sfx-slam"
    if (layout.includes("panel-smash")) return "panel-smash-burst"
    if (layout.includes("ink-flash-impact")) return "ink-flash-impact"
    if (layout.includes("panel-zoom")) return "editorial-grain"
    if (layout.includes("power-aura") || layout.includes("clash-spark") || layout.includes("ground-break")) return "manga-burst-focus"
    if (layout.includes("afterimage") || layout.includes("projectile") || layout.includes("combo-hit") || layout.includes("shadow-clone")) return "manga-speed-impact"
    if (layout.includes("energy-beam") || layout.includes("finisher") || layout.includes("final-attack")) return "panel-smash-burst"
    if (layout.includes("weapon") || layout.includes("battle-dust") || layout.includes("rage-pressure")) return "slash-energy-cut"
    if (layout.includes("glitch") || layout.includes("horror") || layout.includes("thriller") || layout.includes("suspense")) return "horror-signal"
    if (layout.includes("scifi") || layout.includes("holo") || layout.includes("hud")) return "scifi-hud"
    if (layout.includes("romance") || layout.includes("petal") || layout.includes("blush")) return "romance-petals"
    if (layout.includes("fantasy") || layout.includes("magic") || layout.includes("rune") || layout.includes("starlight")) return "fantasy-spark"
    if (layout.includes("comedy") || layout.includes("chibi")) return "comedy-pop"
    if (layout.includes("webtoon") || layout.includes("manhwa") || layout.includes("vertical-scroll")) return "editorial-grain"

    return layout
  }

  phaseEffectBoost(shot = {}, progress = 0) {
    const phase = shot.pixiActiveEffect?.parameters?.phase || String(shot.phase || "").toLowerCase()
    const pulse = 1 + Math.sin(progress * Math.PI) * 0.18

    if (phase === "climax") return 1.2 * pulse
    if (phase === "hook") return 1.08 * pulse

    return pulse
  }

  rhythmStateFor(shot = {}, progress = 0) {
    const beats = shot.pixiRhythm?.parameters?.beats || []
    if (!beats.length) return { kind: "none", power: 0, strength: 0 }

    let active = { kind: "none", power: 0, strength: 0 }
    beats.forEach((beat) => {
      const at = Number(beat.at)
      if (!Number.isFinite(at)) return

      const distance = Math.abs(progress - at)
      const windowSize = beat.kind === "impact" ? 0.085 : 0.065
      if (distance > windowSize) return

      const power = this.easeOut(1 - distance / windowSize)
      if (power > active.power) {
        active = {
          kind: beat.kind || "story",
          power,
          strength: Number(beat.strength) || 0.5
        }
      }
    })

    return active
  }

  defaultMotionForPhase(phase) {
    if (phase === "HOOK") return "cinematic"
    if (phase === "CLIMAX") return "impact"
    if (phase === "CLOSE") return "scroll"

    return "parallax"
  }

  cameraMotionContractFor(motionStyle) {
    return {
      id: `cam-${motionStyle}`,
      kind: "cameraMotion",
      motionStyle,
      parameters: {
        zoomStart: motionStyle === "rgb" ? 1.22 : motionStyle === "impact" ? 1.16 : motionStyle === "parallax" ? 1.12 : 1.04,
        zoomEnd: motionStyle === "rgb" ? 1.02 : motionStyle === "impact" ? 1.02 : motionStyle === "beat" ? 1.08 : 1.1,
        panX: motionStyle === "rgb" ? 0.08 : motionStyle === "float" ? 0.02 : motionStyle === "parallax" ? 0.06 : 0.04,
        panY: motionStyle === "scroll" ? 0 : motionStyle === "float" ? 0.04 : 0.03,
        tempo: ["impact", "beat", "rgb", "manga"].includes(motionStyle) ? 1.28 : 1
      }
    }
  }

  activeEffectContractFor(shot, motionStyle) {
    const genreProfile = this.genreProfile()
    const contract = this.activeEffectContractForMotion(motionStyle, shot.phase, genreProfile)

    return {
      id: contract.id,
      kind: "activeEffect",
      layout: contract.layout,
      parameters: {
        intensity: shot.effectIntensity || this.payload.contract.visual?.intensity || "auto",
        phase: String(shot.phase || "").toLowerCase(),
        profile: contract.profile,
        assetSlots: this.assetSlotsForEffect(contract.id, contract.profile)
      }
    }
  }

  fxAssetSlotsForShot(shot = {}) {
    return shot.pixiActiveEffect?.parameters?.assetSlots || []
  }

  transitionAssetSlotsForShot(shot = {}) {
    return shot.pixiTransitionOut?.parameters?.assetSlots || []
  }

  textAssetSlotsForShot(shot = {}) {
    return shot.pixiTextStyle?.parameters?.assetSlots || []
  }

  allMangaAssetSlotsForShot(shot = {}) {
    return [
      ...this.fxAssetSlotsForShot(shot),
      ...this.transitionAssetSlotsForShot(shot),
      ...this.textAssetSlotsForShot(shot)
    ]
  }

  loadedFxAssetCountFor(shot = {}) {
    return this.loadedAssetCountForSlots(this.fxAssetSlotsForShot(shot))
  }

  loadedAssetCountForSlots(assetSlots = []) {
    return assetSlots.filter((slot) => slot.url && this.fxTextures.get(slot.url)).length
  }

  assetSlotsForEffect(effectId, profile) {
    return this.assetSlotsForPreset(effectId, profile)
  }

  assetSlotsForPreset(presetId, profile) {
    const slotIdsByPreset = {
      "fx-manga-speed-impact": ["shonen-speed-lines-radial"],
      "fx-manga-burst-focus-frame": ["shonen-impact-frame", "shonen-speed-lines-radial"],
      "fx-manga-halftone-burst": ["shonen-impact-frame", "shonen-speed-lines-radial"],
      "fx-impact-freeze-punch": ["shonen-impact-frame", "shonen-speed-lines-radial"],
      "fx-panel-smash-burst": ["shonen-impact-frame"],
      "fx-final-attack-trailer-card": ["shonen-impact-frame", "shonen-speed-lines-radial"],
      "fx-slash-energy-cut": ["shonen-speed-lines-radial"],
      "fx-ink-flash-impact": ["shonen-ink-flash"],
      "fx-panel-zoom-editorial": ["noir-ink-grain"],
      "fx-glitch-horror-signal": ["horror-scratch-lines", "horror-dirty-fog"],
      "fx-webtoon-vertical-scroll": ["shonen-transition-page-slice"],
      "fx-romance-petals": ["shojo-soft-sparkles", "shojo-flower-frame"],
      "fx-petal-bloom-depth": ["shojo-soft-sparkles", "shojo-flower-frame"],
      "fx-fantasy-spark": ["shojo-soft-sparkles"],
      "fx-horror-signal": ["horror-scratch-lines", "horror-dirty-fog"],
      "fx-editorial-grain": ["noir-ink-grain"],
      "fx-comedy-pop": ["comedy-pop-stamps", "comedy-sweat-symbols"],
      "tr-speed-wipe-pro": ["shonen-transition-speed-wipe"],
      "tr-impact-smash-cut": ["shonen-transition-panel-slam", "shonen-impact-frame"],
      "tr-page-flip-pro": ["shonen-transition-page-slice"],
      "tr-glitch-tear": ["horror-scratch-lines", "horror-dirty-fog"],
      "tr-vertical-scroll-cut": ["shonen-transition-page-slice"],
      "tr-ink-flash-impact": ["shonen-ink-flash"],
      "tx-hook-clean-caption": ["shonen-title-banner"],
      "tx-editorial-safe-lower-caption": ["noir-ink-grain"],
      "tx-manga-impact-sfx": ["shonen-sfx-burst-bubble"],
      "tx-manga-dokan-explosion-sfx": ["shonen-sfx-burst-bubble"],
      "tx-manga-speedline-shout-banner": ["shonen-title-banner", "shonen-speed-lines-radial"],
      "tx-manga-dododo-pressure": ["shonen-vertical-sfx-column"],
      "tx-webtoon-floating-thought-card": ["shojo-floating-thought-card"]
    }
    const ids = slotIdsByPreset[presetId] || this.defaultAssetSlotIdsForProfile(profile)
    return ids.map((id) => this.assetSlotPayload(id)).filter(Boolean)
  }

  defaultAssetSlotIdsForProfile(profile) {
    if (profile === "manga-action") return ["shonen-speed-lines-radial"]
    if (profile === "horror-signal") return ["horror-scratch-lines"]
    if (profile === "romance-petals" || profile === "fantasy-spark") return ["shojo-soft-sparkles"]
    if (profile === "comedy-pop") return ["comedy-pop-stamps"]

    return ["noir-ink-grain"]
  }

  assetSlotPayload(id) {
    const slots = {
      "shonen-speed-lines-radial": ["shonen-action", "Shonen Action", "speed-lines", "overlay", "screen", "cover", "radial-pulse", "drawSpeedLines"],
      "shonen-impact-frame": ["shonen-action", "Shonen Action", "impact-frame", "accent", "normal", "cover", "slam-pop", "drawImpactFrame"],
      "shonen-ink-flash": ["shonen-action", "Shonen Action", "ink-flash", "transition-accent", "multiply", "cover", "wipe-flash", "drawInkFlash"],
      "shonen-transition-speed-wipe": ["shonen-action", "Shonen Action", "speed-wipe-streaks", "transition-overlay", "screen", "cover", "lateral-wipe", "drawLateralSpeedLines"],
      "shonen-transition-panel-slam": ["shonen-action", "Shonen Action", "panel-slam-impact-card", "transition-accent", "screen", "safe-frame", "slam-pop", "drawShockBurst"],
      "shonen-transition-page-slice": ["shonen-action", "Shonen Action", "paper-slice-shards", "transition-overlay", "screen", "cover", "diagonal-slice", "drawPaperShards"],
      "shonen-title-banner": ["shonen-action", "Shonen Action", "caption-title-banner", "text-frame", "normal", "safe-frame", "rise-lock", "drawCaption", "/manga-fx/bubbles/speech-rect-tail.svg"],
      "shonen-sfx-burst-bubble": ["shonen-action", "Shonen Action", "impact-sfx-bubble", "text-frame", "normal", "safe-frame", "pop-lock", "drawCaptionRays", "/manga-fx/bubbles/burst-impact-white.svg"],
      "shonen-vertical-sfx-column": ["shonen-action", "Shonen Action", "vertical-sfx-column", "text-frame", "normal", "right-safe", "manga-reveal", "drawMangaTextGuide", "/manga-fx/bubbles/manga-vertical-soft.svg"],
      "shojo-soft-sparkles": ["shojo-romance", "Shojo Romance", "sparkles", "overlay", "screen", "cover", "float-loop", "drawRomancePetals"],
      "shojo-flower-frame": ["shojo-romance", "Shojo Romance", "flower-frame", "frame", "normal", "safe-frame", "soft-breathe", "drawFantasySpark"],
      "shojo-floating-thought-card": ["shojo-romance", "Shojo Romance", "floating-thought-card", "text-frame", "normal", "safe-frame", "bubble-rise", "drawThoughtDots", "/manga-fx/bubbles/thought-cloud-soft.svg"],
      "noir-ink-grain": ["seinen-noir", "Seinen Noir", "ink-grain", "texture", "multiply", "cover", "slow-drift", "drawEditorialGrain"],
      "horror-scratch-lines": ["horror-manga", "Horror Manga", "scratch-lines", "overlay", "screen", "cover", "jitter-flicker", "drawHorrorSignal"],
      "horror-dirty-fog": ["horror-manga", "Horror Manga", "dirty-fog", "atmosphere", "screen", "cover", "slow-drift", "drawHorrorSignal"],
      "comedy-pop-stamps": ["comedy-chibi", "Comedy / Chibi", "pop-stamps", "accent", "normal", "safe-frame", "bounce-pop", "drawComedyPop"],
      "comedy-sweat-symbols": ["comedy-chibi", "Comedy / Chibi", "reaction-symbols", "accent", "screen", "cover", "tiny-pop", "drawComedyPop"]
    }
    const slot = slots[id]
    if (!slot) return null

    return {
      id,
      packId: slot[0],
      packLabel: slot[1],
      kind: slot[2],
      assetType: "transparent-image",
      role: slot[3],
      url: slot[8] || (id === "shonen-impact-frame" ? "/manga-fx/shonen-action/impact-frame-owned-v1.png" : null),
      blendMode: slot[4],
      anchor: slot[5],
      animation: slot[6],
      fallback: slot[7],
      licenseStatus: (slot[8] || id === "shonen-impact-frame") ? "owned" : "owned_required"
    }
  }

  activeEffectContractForMotion(motionStyle, phase, genreProfile) {
    if (motionStyle === "impact" || (phase === "CLIMAX" && genreProfile === "manga-action")) return { id: "fx-impact-freeze-punch", layout: "impact-freeze-punch-pro-vfx", profile: "manga-action" }
    if (motionStyle === "beat") return { id: "fx-panel-smash-burst", layout: "panel-smash-burst-pro-vfx", profile: "manga-action" }
    if (motionStyle === "swipe") return { id: "fx-slash-energy-cut", layout: "slash-energy-cut-pro-vfx", profile: "manga-action" }
    if (motionStyle === "manga" || genreProfile === "manga-action") return { id: "fx-manga-speed-impact", layout: "speed-impact-pro-vfx", profile: "manga-action" }
    if (["rgb", "glitch"].includes(motionStyle)) return { id: "fx-scifi-hud", layout: "scifi-hud", profile: "scifi-hud" }

    return { id: `fx-${genreProfile}`, layout: genreProfile, profile: genreProfile }
  }

  rhythmContractFor(shot, motionStyle) {
    const phase = shot.phase || "BODY"
    const intensity = phase === "CLIMAX" || ["impact", "beat", "manga"].includes(motionStyle)
      ? "hit"
      : phase === "HOOK"
        ? "hook"
        : phase === "CLOSE" || ["scroll", "float"].includes(motionStyle)
          ? "hold"
          : "pulse"

    return {
      id: `rhythm-${String(phase).toLowerCase()}-${motionStyle}`,
      kind: "rhythm",
      tempo: ["impact", "beat", "rgb", "manga", "swipe"].includes(motionStyle) ? 1.35 : ["scroll", "float"].includes(motionStyle) ? 0.82 : 1,
      parameters: {
        durationMs: shot.durationMs,
        intensity,
        beats: this.rhythmBeatsFor(phase, motionStyle, shot.transition, intensity)
      }
    }
  }

  rhythmBeatsFor(phase, motionStyle, transition, intensity) {
    const beats = [
      { at: 0.08, kind: "entry", strength: intensity === "hold" ? 0.34 : 0.48 },
      { at: phase === "HOOK" ? 0.32 : 0.5, kind: intensity === "hit" ? "impact" : "story", strength: intensity === "hit" ? 0.88 : 0.54 }
    ]

    if (["impact", "beat", "manga", "swipe"].includes(motionStyle)) beats.push({ at: 0.68, kind: "impact", strength: 0.72 })
    beats.push({ at: 0.9, kind: transition && !["none", "cut"].includes(transition) ? "exit" : "hold", strength: transition && !["none", "cut"].includes(transition) ? 0.62 : 0.26 })

    return beats
  }

  transitionContractFor(transition) {
    if (!transition || ["none", "cut"].includes(transition)) return null
    const contract = this.transitionPresetFor(transition)

    return {
      id: contract.id,
      kind: "transitionOut",
      transitionType: transition,
      parameters: {
        durationMs: transition === "panel_slam" ? 430 : transition === "page_slice" ? 560 : transition === "ink_flash" ? 500 : 460,
        tempo: ["speed_wipe", "panel_slam"].includes(transition) ? 1.18 : 1,
        layout: contract.layout,
        assetSlots: this.assetSlotsForPreset(contract.id, "manga-action")
      }
    }
  }

  transitionPresetFor(transition) {
    if (transition === "speed_wipe") return { id: "tr-speed-wipe-pro", layout: "speed-wipe" }
    if (transition === "panel_slam") return { id: "tr-impact-smash-cut", layout: "impact-smash" }
    if (transition === "page_slice") return { id: "tr-page-flip-pro", layout: "page-flip-pro-vfx" }
    if (transition === "ink_flash") return { id: "tr-ink-flash-impact", layout: "ink-flash-impact-pro-vfx" }

    return { id: `tr-${transition.replaceAll("_", "-")}`, layout: transition.replaceAll("_", "-") }
  }

  textPresetIdForLayout(layout) {
    if (layout === "burst") return "tx-manga-impact-sfx"
    if (layout === "manga_vertical") return "tx-manga-dododo-pressure"
    if (layout === "speech" || layout === "thought") return "tx-webtoon-floating-thought-card"

    return "tx-hook-clean-caption"
  }

  textCatalogLayoutFor(layout) {
    if (layout === "burst") return "black-star"
    if (layout === "manga_vertical") return "sfx-vertical"
    if (layout === "speech" || layout === "thought") return "love-letter"

    return "lower-third"
  }

  textAnimationForLayout(layout) {
    if (layout === "burst") return "pop_lock"
    if (layout === "manga_vertical") return "manga_reveal"
    if (layout === "speech" || layout === "thought") return "bubble_rise"

    return "rise_lock"
  }

  textVisualCategoryForLayout(layout) {
    if (layout === "speech" || layout === "thought") return "romance-fantasy"

    return "manga-action"
  }

  resolvedShotChoice(shot, authoredKey, resolvedKey, fallback) {
    const authored = shot[authoredKey]

    if (authored && authored !== "auto") return authored

    return shot[resolvedKey] || fallback
  }

  drawTaperedQuad(graphics, x1, y1, x2, y2, startWidth, endWidth, color, alpha) {
    const dx = x2 - x1
    const dy = y2 - y1
    const length = Math.hypot(dx, dy) || 1
    const nx = -dy / length
    const ny = dx / length
    const sw = startWidth / 2
    const ew = endWidth / 2

    graphics.poly([
      x1 + nx * sw,
      y1 + ny * sw,
      x1 - nx * sw,
      y1 - ny * sw,
      x2 - nx * ew,
      y2 - ny * ew,
      x2 + nx * ew,
      y2 + ny * ew
    ])
    graphics.fill({ color, alpha })
  }

  pixiColor(value) {
    if (typeof value === "number") return value
    if (typeof value === "string" && value.startsWith("#")) return Number.parseInt(value.slice(1), 16)

    return value
  }

  easeInOut(value) {
    const t = Math.min(Math.max(value, 0), 1)

    return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2
  }

  easeOut(value) {
    const t = Math.min(Math.max(value, 0), 1)

    return 1 - (1 - t) ** 3
  }

  lerp(start, end, value) {
    return start + (end - start) * value
  }
}
