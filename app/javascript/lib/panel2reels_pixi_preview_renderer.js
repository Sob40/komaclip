/**
 * Pixi preview renderer scaffold.
 *
 * This file defines the scene contract we will feed into PixiJS when we replace
 * the current Canvas preview. It is intentionally dependency-free for now, so the
 * main app can keep running while we migrate effects in small batches.
 */

export const PIXI_PREVIEW_SIZE = Object.freeze({
  width: 720,
  height: 1280,
  fps: 30,
});

export const PIXI_RENDER_QUALITY_PROFILES = Object.freeze({
  thumbnail: Object.freeze({
    name: "thumbnail",
    maxRendererResolution: 1,
    shaderResolution: 0.65,
    filterResolution: 0.65,
    blurStrengthScale: 0.82,
    maxBlurQuality: 2,
    maxExternalQuality: 2,
    maxMotionKernelSize: 7,
    rgbSplitScale: 0.75,
    shockwaveScale: 0.75,
    godrayGainScale: 0.8,
    maxPanelFilters: 4,
    allowNoise: false,
  }),
  preview: Object.freeze({
    name: "preview",
    maxRendererResolution: 1.5,
    shaderResolution: 0.85,
    filterResolution: 0.85,
    blurStrengthScale: 0.92,
    maxBlurQuality: 3,
    maxExternalQuality: 3,
    maxMotionKernelSize: 9,
    rgbSplitScale: 0.9,
    shockwaveScale: 0.9,
    godrayGainScale: 0.92,
    maxPanelFilters: 5,
    allowNoise: true,
  }),
  high: Object.freeze({
    name: "high",
    maxRendererResolution: 2,
    shaderResolution: 1,
    filterResolution: 1,
    blurStrengthScale: 1,
    maxBlurQuality: 4,
    maxExternalQuality: 4,
    maxMotionKernelSize: 11,
    rgbSplitScale: 1,
    shockwaveScale: 1,
    godrayGainScale: 1,
    maxPanelFilters: 6,
    allowNoise: true,
  }),
});

export const PIXI_RENDER_PERFORMANCE_BUDGETS = Object.freeze({
  thumbnail: Object.freeze({
    averageFrameMs: 14,
    lastFrameMs: 18,
    displayObjects: 120,
    graphics: 45,
    filters: 4,
    textureBytes: 96 * 1024 * 1024,
  }),
  preview: Object.freeze({
    averageFrameMs: 22,
    lastFrameMs: 28,
    displayObjects: 240,
    graphics: 80,
    filters: 8,
    textureBytes: 160 * 1024 * 1024,
  }),
  high: Object.freeze({
    averageFrameMs: 33,
    lastFrameMs: 42,
    displayObjects: 360,
    graphics: 120,
    filters: 12,
    textureBytes: 256 * 1024 * 1024,
  }),
});

export const SUPPORTED_PIXI_LAB_IDS = Object.freeze(["all-comic-lab-styles"]);

export function createPixiSceneContract({
  panel,
  nextPanel = null,
  textStyle = null,
  activeEffects = [],
  transitionOut = null,
  duration = 3.2,
  tags = [],
}) {
  return {
    version: 1,
    size: PIXI_PREVIEW_SIZE,
    duration,
    panel,
    nextPanel,
    textStyle,
    activeEffects,
    transitionOut,
    tags,
  };
}

export function normalizeComicLabDemoForPixi(demo) {
  const base = {
    id: demo.key,
    title: demo.title,
    layout: demo.layout,
    tags: demo.autoTags || [],
    englishDescription: demo.englishDescription || "",
    accent: demo.accent || "#ffffff",
  };

  if (demo.type === "text" || demo.key?.startsWith("txt-") || demo.key?.startsWith("text-style-")) {
    return {
      ...base,
      kind: "textStyle",
      text: demo.sample,
      fill: demo.fill,
      ink: demo.ink,
      font: demo.font,
    };
  }

  if (demo.type === "transition" || demo.key?.startsWith("tr-") || demo.key?.startsWith("transition-style-")) {
    return {
      ...base,
      kind: "transitionOut",
      transitionType: demo.structure,
    };
  }

  return {
    ...base,
    kind: "activeEffect",
    effectType: demo.structure,
  };
}

export class PixiPreviewRenderer {
  constructor({ mount, pixi, pixiFilters = null, qualityProfile = "preview" } = {}) {
    this.mount = mount || null;
    this.pixi = pixi || null;
    this.pixiFilters = pixiFilters || null;
    this.qualityProfile = this.normalizeQualityProfile(qualityProfile);
    this.qualitySettings = PIXI_RENDER_QUALITY_PROFILES[this.qualityProfile];
    this.app = null;
    this.scene = null;
    this.root = null;
    this.textures = new Map();
    this.startedAt = 0;
    this.isRunning = false;
    this.currentShotIndex = 0;
    this.playbackOptions = { loop: true, onComplete: null, completed: false };
    this.fxTextures = new Map();
    this.generatedFrameTextures = [];
    this.fullFrameFilterArea = null;
    this.qualityGovernor = {
      enabled: this.qualityProfile !== "high",
      level: 0,
      maxLevel: this.qualityProfile === "thumbnail" ? 2 : 1,
      hotFrames: 0,
      coolFrames: 0,
      lastPressure: 0,
      lastStatus: "warming",
    };
    this.frameStats = {
      averageMs: 0,
      lastMs: 0,
      maxMs: 0,
      samples: 0,
      maxDisplayObjects: 0,
      maxFilters: 0,
      maxGraphics: 0,
      objectStats: this.emptyFrameObjectStats(),
    };
    this.renderTick = this.renderTick.bind(this);
  }

  normalizeQualityProfile(profile) {
    return PIXI_RENDER_QUALITY_PROFILES[profile] ? profile : "preview";
  }

  qualitySetting(name) {
    return this.qualitySettings?.[name] ?? PIXI_RENDER_QUALITY_PROFILES.preview[name];
  }

  performanceBudget() {
    return PIXI_RENDER_PERFORMANCE_BUDGETS[this.qualityProfile] || PIXI_RENDER_PERFORMANCE_BUDGETS.preview;
  }

  qualityGovernorState() {
    return {
      ...this.qualityGovernor,
      active: Boolean(this.qualityGovernor.enabled && this.qualityGovernor.level > 0),
    };
  }

  qualityGovernorScale(kind = "resolution") {
    if (!this.qualityGovernor.enabled) return 1;
    const level = Math.max(0, Math.min(this.qualityGovernor.level || 0, this.qualityGovernor.maxLevel || 0));
    const scales = {
      resolution: [1, 0.82, 0.68],
      blurStrength: [1, 0.86, 0.72],
      externalQuality: [1, 0.85, 0.72],
      rgbSplit: [1, 0.82, 0.7],
      shockwave: [1, 0.84, 0.72],
      godray: [1, 0.84, 0.72],
    }[kind] || [1, 0.85, 0.72];
    return scales[level] || scales.at(-1) || 1;
  }

  rendererResolution() {
    const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
    return Math.min(pixelRatio, this.qualitySetting("maxRendererResolution") || 1.5);
  }

  qualityAdjustedShaderResolution(resolution) {
    const profileResolution = this.qualitySetting("shaderResolution") || 1;
    const adjusted = profileResolution * this.qualityGovernorScale("resolution");
    return Number.isFinite(resolution) ? Math.min(resolution, adjusted) : adjusted;
  }

  qualityAdjustedFilterResolution(resolution) {
    const profileResolution = this.qualitySetting("filterResolution") || 1;
    const adjusted = profileResolution * this.qualityGovernorScale("resolution");
    return Number.isFinite(resolution) ? Math.min(resolution, adjusted) : adjusted;
  }

  qualityAdjustedBlurStrength(strength) {
    if (!Number.isFinite(strength)) return strength;
    return Math.max(0, strength * (this.qualitySetting("blurStrengthScale") || 1) * this.qualityGovernorScale("blurStrength"));
  }

  qualityAdjustedBlurQuality(quality) {
    if (!Number.isFinite(quality)) return quality;
    const maxQuality = Math.max(1, (this.qualitySetting("maxBlurQuality") || 3) - (this.qualityGovernor.level || 0));
    return Math.max(1, Math.min(Math.round(quality), maxQuality));
  }

  qualityAdjustedExternalQuality(quality) {
    if (!Number.isFinite(quality)) return quality;
    return Math.min(quality, (this.qualitySetting("maxExternalQuality") || 3) * this.qualityGovernorScale("externalQuality"));
  }

  qualityAdjustedMotionKernelSize(kernelSize) {
    if (!Number.isFinite(kernelSize)) return kernelSize;
    const maxKernelSize = (this.qualitySetting("maxMotionKernelSize") || 9) - (this.qualityGovernor.level || 0) * 2;
    let adjusted = Math.max(3, Math.min(Math.round(kernelSize), maxKernelSize));
    if (adjusted % 2 === 0) adjusted -= 1;
    return Math.max(3, adjusted);
  }

  async init() {
    if (!this.pixi) {
      throw new Error("PixiJS is not loaded yet. Pass the PIXI module before enabling this renderer.");
    }
    if (!this.mount) {
      throw new Error("PixiPreviewRenderer needs a mount element.");
    }
    if (!this.app) {
      this.app = new this.pixi.Application();
      await this.app.init({
        width: PIXI_PREVIEW_SIZE.width,
        height: PIXI_PREVIEW_SIZE.height,
        backgroundColor: 0x050509,
        antialias: true,
        autoDensity: true,
        resolution: this.rendererResolution(),
      });
      this.app.canvas.className = "pixi-preview-canvas";
      this.app.canvas.style.width = "100%";
      this.app.canvas.style.height = "100%";
      this.mount.replaceChildren(this.app.canvas);
      this.root = new this.pixi.Container();
      this.app.stage.addChild(this.root);
      this.app.ticker.add(this.renderTick);
      this.pause();
    }
    return this;
  }

  async loadScene(scene, options = {}) {
    this.scene = scene;
    this.playbackOptions = {
      loop: options.loop !== false,
      onComplete: typeof options.onComplete === "function" ? options.onComplete : null,
      completed: false,
    };
    await this.loadSceneTextures(scene);
    this.renderFrame(0);
    if (options.autoplay === false) {
      this.pause();
    } else {
      this.startPlayback(options);
    }
    return this;
  }

  startPlayback(options = {}) {
    if (!this.scene) return;
    this.startedAt = performance.now();
    this.playbackOptions = {
      loop: options.loop !== false,
      onComplete: typeof options.onComplete === "function" ? options.onComplete : this.playbackOptions.onComplete,
      completed: false,
    };
    this.play();
  }

  play() {
    if (!this.app || this.isRunning) return;
    this.app.ticker.start();
    this.isRunning = true;
  }

  pause() {
    if (!this.app) return;
    this.app.ticker.stop();
    this.isRunning = false;
  }

  renderTick() {
    if (!this.scene) return;
    const elapsed = (performance.now() - this.startedAt) / 1000;
    const duration = Math.max(this.scene.duration || 3.2, 0.1);
    if (!this.playbackOptions.loop && elapsed >= duration) {
      this.renderFrame(duration);
      this.pause();
      if (!this.playbackOptions.completed) {
        this.playbackOptions.completed = true;
        this.playbackOptions.onComplete?.();
      }
      return;
    }
    this.renderFrame(elapsed);
  }

  async loadSceneTextures(scene) {
    const sources = this.sceneTextureSources(scene);
    this.releaseUnusedSceneTextures(sources);
    await Promise.all(sources.map(async (src) => {
      if (this.textures.has(src)) return;
      const texture = await this.pixi.Assets.load(src);
      this.textures.set(src, texture);
    }));
  }

  sceneTextureSources(scene) {
    const sequenceSources = (scene?.shots || [])
      .flatMap((shot) => [shot?.panel?.src, shot?.nextPanel?.src])
      .filter(Boolean);

    return [...new Set([
      ...[scene?.panel?.src, scene?.nextPanel?.src].filter(Boolean),
      ...sequenceSources,
    ])];
  }

  releaseUnusedSceneTextures(activeSources = []) {
    const active = new Set(activeSources);
    [...this.textures.keys()].forEach((src) => {
      if (!active.has(src)) this.textures.delete(src);
    });
  }

  renderFrame(timeSeconds = 0) {
    if (!this.scene) return;
    const frameStartedAt = performance.now();
    this.clearRoot();
    if (this.scene.shots?.length) {
      this.renderSequenceFrame(timeSeconds);
      this.recordFrameStats(performance.now() - frameStartedAt);
      return;
    }
    const duration = Math.max(this.scene.duration || 3.2, 0.1);
    const sceneTime = this.playbackOptions.loop ? (timeSeconds % duration) : Math.min(timeSeconds, duration);
    const progress = this.playbackOptions.loop ? sceneTime / duration : Math.min(sceneTime / duration, 1);
    const panelTexture = this.textures.get(this.scene.panel?.src);
    const nextTexture = this.textures.get(this.scene.nextPanel?.src) || panelTexture;
    if (!panelTexture) return;

    if (this.scene.transitionOut) {
      this.drawTransition(panelTexture, nextTexture, this.scene.transitionOut, progress, timeSeconds * this.transitionTempoForTransition(this.scene.transitionOut));
    } else {
      const speedImpact = this.findSpeedImpactEffect(this.scene.activeEffects);
      const impactZoom = this.findImpactZoomEffect(this.scene.activeEffects);
      const softBloom = this.findSoftBloomEffect(this.scene.activeEffects);
      const shadowCreep = this.findShadowCreepEffect(this.scene.activeEffects);
      const proMotion = this.findProVfxMotionEffect(this.scene.activeEffects);
      const cameraMotion = this.findCameraMotionEffect(this.scene.activeEffects);
      const horrorThriller = (this.scene.activeEffects || []).find((effect) => this.isHorrorThrillerEffect(effect));
      const camera = cameraMotion ? this.proVfxCamera(progress, timeSeconds, cameraMotion) : {};
      this.drawCoverSprite(panelTexture, this.root, {
        zoom: (1.08 + Math.sin(timeSeconds * 0.7) * 0.012) * (camera.zoom || 1),
        panX: (this.scene.textStyle ? -0.02 : 0) + (camera.panX || 0),
        panY: camera.panY || 0,
        rotation: camera.rotation || 0,
        filters: this.createPanelFiltersForEffects({ speedImpact, impactZoom, softBloom, shadowCreep, proMotion, cameraMotion, horrorThriller }, timeSeconds),
      });
      const hasLayeredVisualEffect = (this.scene.activeEffects || []).some((effect) => !this.isCameraMotionOnlyEffect(effect));
      this.scene.activeEffects.forEach((effect) => this.drawActiveEffect(effect, progress, timeSeconds, {
        hasTextStyle: Boolean(this.scene.textStyle),
        hasLayeredVisualEffect,
        panelTexture,
        camera,
      }));
      if (this.scene.textStyle) this.drawTextStyle(this.scene.textStyle, progress, timeSeconds);
    }
    this.drawSafeFocusVignette();
    this.drawSafeFrame();
    this.app?.renderer?.render?.(this.app.stage);
    this.recordFrameStats(performance.now() - frameStartedAt);
  }

  renderSequenceFrame(timeSeconds = 0) {
    const duration = Math.max(this.scene.duration || 3.2, 0.1);
    const elapsed = this.playbackOptions.loop
      ? ((timeSeconds % duration) + duration) % duration
      : Math.min(Math.max(timeSeconds, 0), duration);
    const shots = this.scene.shots || [];
    const activeShot = shots.find((shot) => elapsed >= shot.start && elapsed < shot.end) || shots.at(-1);
    if (!activeShot) return;
    const activeShotPosition = Math.max(0, shots.indexOf(activeShot));
    this.currentShotIndex = activeShot.index || 0;
    const shotDuration = Math.max(activeShot.duration || activeShot.end - activeShot.start || 3, 0.1);
    const localElapsed = Math.max(0, elapsed - activeShot.start);
    const localProgress = Math.min(localElapsed / shotDuration, 1);
    const panelTexture = this.textures.get(activeShot.panel?.src);
    const nextTexture = this.textures.get(activeShot.nextPanel?.src) || panelTexture;
    if (!panelTexture) return;

    const transitionSeconds = this.transitionDurationForShot(activeShot, shotDuration);
    const transitionTempo = this.transitionTempoForShot(activeShot);
    const transitionStart = Math.max(0, shotDuration - transitionSeconds);
    const shouldTransition = Boolean(activeShot.transitionOut && nextTexture && localElapsed >= transitionStart);

    if (shouldTransition) {
      const transitionProgress = Math.min((localElapsed - transitionStart) / transitionSeconds, 1);
      const incomingShot = shots[activeShotPosition + 1];
      const incomingFrameOptions = this.incomingTransitionFrameOptions(incomingShot, timeSeconds);
      // Keep transitions focused on the image only; text and FX enter once the next shot is active.
      this.drawTransition(panelTexture, nextTexture, activeShot.transitionOut, transitionProgress, timeSeconds * transitionTempo, {
        incomingFrameOptions,
        incomingTextureFrameOptions: incomingFrameOptions,
        incomingIsComposite: false,
      });
    } else {
      const eased = easeInOutCubic(localProgress);
      const effectProgress = this.effectProgressForShotEntry(activeShot, shots[activeShotPosition - 1], localProgress, localElapsed, shotDuration);
      const zoomStart = Number.isFinite(activeShot.zoomStart) ? activeShot.zoomStart : 1.06;
      const zoomEnd = Number.isFinite(activeShot.zoomEnd) ? activeShot.zoomEnd : 1.12;
      const speedImpact = this.findSpeedImpactEffect(activeShot.activeEffects);
      const impactZoom = this.findImpactZoomEffect(activeShot.activeEffects);
      const softBloom = this.findSoftBloomEffect(activeShot.activeEffects);
      const shadowCreep = this.findShadowCreepEffect(activeShot.activeEffects);
      const proMotion = this.findProVfxMotionEffect(activeShot.activeEffects);
      const cameraMotion = this.findCameraMotionEffect(activeShot.activeEffects);
      const horrorThriller = (activeShot.activeEffects || []).find((effect) => this.isHorrorThrillerEffect(effect));
      const camera = cameraMotion ? this.proVfxCamera(localProgress, timeSeconds, cameraMotion) : {};
      this.drawCoverSprite(panelTexture, this.root, {
        zoom: (lerp(zoomStart, zoomEnd, eased) + Math.sin(timeSeconds * 0.75) * 0.006) * (camera.zoom || 1),
        panX: (activeShot.panX || 0) * eased + (camera.panX || 0),
        panY: (activeShot.panY || 0) * eased + (camera.panY || 0),
        rotation: camera.rotation || 0,
        filters: this.createPanelFiltersForEffects({ speedImpact, impactZoom, softBloom, shadowCreep, proMotion, cameraMotion, horrorThriller }, timeSeconds),
      });
      const hasLayeredVisualEffect = (activeShot.activeEffects || []).some((effect) => !this.isCameraMotionOnlyEffect(effect));
      activeShot.activeEffects?.forEach((effect) => this.drawActiveEffect(effect, effectProgress, timeSeconds, {
        hasTextStyle: Boolean(activeShot.textStyle),
        hasLayeredVisualEffect,
        panelTexture,
        camera,
      }));
      if (activeShot.textStyle) {
        this.drawTextStyle(activeShot.textStyle, Math.min(localProgress / 0.32, 1), timeSeconds);
      }
    }
    this.drawSafeFocusVignette();
    this.drawSafeFrame();
    this.drawSequenceProgress(elapsed / duration);
    this.app?.renderer?.render?.(this.app.stage);
  }

  transitionDurationForShot(shot = {}, shotDuration = 3) {
    const requested = Number(shot.transitionOut?.parameters?.transitionDurationSeconds);
    const fallback = Math.min(0.58, Math.max(0.22, shotDuration * 0.26));
    const maxForShot = Math.max(0.2, Math.min(0.92, shotDuration * 0.44));
    const value = Number.isFinite(requested) ? requested : fallback;
    return Math.min(maxForShot, Math.max(0.2, value));
  }

  transitionTempoForShot(shot = {}) {
    return this.transitionTempoForTransition(shot.transitionOut);
  }

  transitionTempoForTransition(transition = {}) {
    const value = Number(transition?.parameters?.transitionTempo);
    if (!Number.isFinite(value)) return 1;
    return Math.min(1.6, Math.max(0.65, value));
  }

  debugState() {
    return {
      hasApp: Boolean(this.app),
      hasScene: Boolean(this.scene),
      isRunning: this.isRunning,
      qualityProfile: this.qualityProfile,
      qualitySettings: this.qualitySettings,
      qualityGovernor: this.qualityGovernorState(),
      currentShotIndex: this.currentShotIndex,
      rootChildren: this.root?.children?.length || 0,
      activeEffects: (this.scene?.activeEffects || []).map((effect) => ({
        id: effect?.id || "",
        title: effect?.title || "",
        type: effect?.type || "",
        layout: effect?.layout || "",
      })),
      activeShotEffects: (this.scene?.shots?.[this.currentShotIndex]?.activeEffects || []).map((effect) => ({
        id: effect?.id || "",
        title: effect?.title || "",
        type: effect?.type || "",
        layout: effect?.layout || "",
      })),
      textureKeys: [...this.textures.keys()],
      textureSizes: [...this.textures.entries()].map(([key, texture]) => ({
        key,
        width: texture.width,
        height: texture.height,
      })),
      frameStats: this.frameStats,
      frameObjectStats: this.frameStats.objectStats,
      performance: this.performanceReport(),
      fxTextureCount: this.fxTextures.size,
      textureMemory: this.textureMemoryStats(),
      externalFilters: this.availableExternalFilterNames(),
    };
  }

  recordFrameStats(frameMs) {
    const objectStats = this.collectFrameObjectStats();
    const samples = Math.min(this.frameStats.samples + 1, 120);
    const previousWeight = this.frameStats.samples === 0 ? 0 : samples - 1;
    const averageMs = ((this.frameStats.averageMs * previousWeight) + frameMs) / samples;
    this.frameStats = {
      lastMs: frameMs,
      averageMs,
      maxMs: Math.max(this.frameStats.maxMs, frameMs),
      samples,
      maxDisplayObjects: Math.max(this.frameStats.maxDisplayObjects || 0, objectStats.displayObjects),
      maxFilters: Math.max(this.frameStats.maxFilters || 0, objectStats.filters),
      maxGraphics: Math.max(this.frameStats.maxGraphics || 0, objectStats.graphics),
      objectStats,
    };
    this.updateQualityGovernor();
  }

  updateQualityGovernor() {
    if (!this.qualityGovernor.enabled) return;

    const report = this.performanceReport();
    const pressure = Number(report.pressure || 0);
    this.qualityGovernor.lastPressure = pressure;
    this.qualityGovernor.lastStatus = report.status;

    if (pressure >= 1.04) {
      this.qualityGovernor.hotFrames += 1;
      this.qualityGovernor.coolFrames = 0;
    } else if (pressure < 0.58) {
      this.qualityGovernor.coolFrames += 1;
      this.qualityGovernor.hotFrames = 0;
    } else {
      this.qualityGovernor.hotFrames = 0;
      this.qualityGovernor.coolFrames = 0;
    }

    const hotFrameThreshold = this.qualityProfile === "thumbnail" ? 1 : 3;
    if (this.qualityGovernor.hotFrames >= hotFrameThreshold && this.qualityGovernor.level < this.qualityGovernor.maxLevel) {
      this.qualityGovernor.level += 1;
      this.qualityGovernor.hotFrames = 0;
      this.qualityGovernor.coolFrames = 0;
      return;
    }

    if (this.qualityGovernor.coolFrames >= 90 && this.qualityGovernor.level > 0) {
      this.qualityGovernor.level -= 1;
      this.qualityGovernor.hotFrames = 0;
      this.qualityGovernor.coolFrames = 0;
    }
  }

  performanceReport() {
    const budget = this.performanceBudget();
    const stats = this.frameStats || {};
    const objects = stats.objectStats || this.emptyFrameObjectStats();
    const textureMemory = this.textureMemoryStats();
    const checks = [
      { key: "averageFrameMs", value: stats.averageMs || 0, budget: budget.averageFrameMs },
      { key: "lastFrameMs", value: stats.lastMs || 0, budget: budget.lastFrameMs },
      { key: "displayObjects", value: objects.displayObjects || 0, budget: budget.displayObjects },
      { key: "graphics", value: objects.graphics || 0, budget: budget.graphics },
      { key: "filters", value: objects.filters || 0, budget: budget.filters },
      { key: "textureBytes", value: textureMemory.totalBytes || 0, budget: budget.textureBytes },
    ].map((check) => ({
      ...check,
      ratio: check.budget > 0 ? check.value / check.budget : 0,
    }));
    const pressure = checks.reduce((max, check) => Math.max(max, check.ratio), 0);
    const status = (stats.samples || 0) <= 0 ? "warming" : pressure >= 1 ? "hot" : pressure >= 0.82 ? "warn" : "ok";
    return {
      profile: this.qualityProfile,
      status,
      pressure,
      governor: this.qualityGovernorState(),
      budget,
      bottlenecks: checks.filter((check) => check.ratio >= 0.82).map((check) => check.key),
      checks,
    };
  }

  emptyFrameObjectStats() {
    return {
      displayObjects: 0,
      containers: 0,
      graphics: 0,
      sprites: 0,
      texts: 0,
      bitmapTexts: 0,
      particleContainers: 0,
      filters: 0,
      filterAreas: 0,
      masks: 0,
      rootChildren: 0,
      cachedFxTextures: this.fxTextures?.size || 0,
      panelTextures: this.textures?.size || 0,
      generatedFrameTextures: this.generatedFrameTextures?.length || 0,
    };
  }

  previewFrameRectangle(padding = 0) {
    if (!this.pixi?.Rectangle) return null;
    if (padding <= 0 && this.fullFrameFilterArea) return this.fullFrameFilterArea;

    const rect = new this.pixi.Rectangle(
      -padding,
      -padding,
      PIXI_PREVIEW_SIZE.width + padding * 2,
      PIXI_PREVIEW_SIZE.height + padding * 2,
    );
    if (padding <= 0) this.fullFrameFilterArea = rect;
    return rect;
  }

  applyFilters(target, filters, options = {}) {
    if (!target) return [];

    const resolved = (Array.isArray(filters) ? filters : [filters]).filter(Boolean);
    if (!resolved.length) {
      target.filters = null;
      target.filterArea = null;
      return resolved;
    }

    target.filters = resolved;
    if (options.fullFrame) {
      target.filterArea = this.previewFrameRectangle(options.padding || 0);
    }
    return resolved;
  }

  finalizePanelFilters(filters) {
    const resolved = (Array.isArray(filters) ? filters : [filters]).filter(Boolean);
    const maxFilters = Math.max(1, (this.qualitySetting("maxPanelFilters") || 5) - (this.qualityGovernor.level || 0));
    if (resolved.length <= maxFilters) return resolved.length ? resolved : null;

    const withoutNoise = resolved.filter((filter) => !this.isFilterNamed(filter, "NoiseFilter"));
    const limited = (withoutNoise.length ? withoutNoise : resolved).slice(0, maxFilters);
    return limited.length ? limited : null;
  }

  isFilterNamed(filter, name) {
    return filter?.constructor?.name === name;
  }

  collectFrameObjectStats() {
    const stats = this.emptyFrameObjectStats();
    stats.rootChildren = this.root?.children?.length || 0;
    if (!this.root) return stats;

    const visit = (node) => {
      if (!node) return;

      stats.displayObjects += 1;
      this.countFrameObjectType(stats, node);

      const filters = node.filters;
      const filterCount = Array.isArray(filters) ? filters.filter(Boolean).length : filters ? 1 : 0;
      stats.filters += filterCount;
      if (filterCount > 0 && node.filterArea) stats.filterAreas += 1;
      if (node.mask) stats.masks += 1;

      node.children?.forEach?.(visit);
    };

    this.root.children?.forEach?.(visit);
    return stats;
  }

  countFrameObjectType(stats, node) {
    const name = node.constructor?.name || "";
    if (this.isPixiInstance(node, "Graphics") || name === "Graphics") stats.graphics += 1;
    if (this.isPixiInstance(node, "Sprite") || name === "Sprite") stats.sprites += 1;
    if (this.isPixiInstance(node, "Text") || name === "Text") stats.texts += 1;
    if (this.isPixiInstance(node, "BitmapText") || name === "BitmapText") stats.bitmapTexts += 1;
    if (this.isPixiInstance(node, "ParticleContainer") || name === "ParticleContainer") stats.particleContainers += 1;
    if (node.children || this.isPixiInstance(node, "Container") || name === "Container") stats.containers += 1;
  }

  isPixiInstance(node, className) {
    const Klass = this.pixi?.[className];
    return Boolean(Klass && node instanceof Klass);
  }

  availableExternalFilterNames() {
    if (!this.pixiFilters) return [];

    return [
      "AdvancedBloomFilter",
      "GlowFilter",
      "GodrayFilter",
      "MotionBlurFilter",
      "RGBSplitFilter",
      "ShockwaveFilter",
    ].filter((name) => Boolean(this.pixiFilters[name]));
  }

  destroy() {
    this.scene = null;
    this.clearRoot();
    this.destroyFxTextureCache();
    this.releaseUnusedSceneTextures([]);
    this.app?.ticker?.remove(this.renderTick);
    this.app?.destroy?.(true);
    this.app = null;
    this.root = null;
    this.fullFrameFilterArea = null;
  }

  clearRoot() {
    if (this.root) {
      this.root.removeChildren().forEach((child) => {
        child.destroy?.({ children: true, texture: false, textureSource: false });
      });
    }
    this.destroyGeneratedFrameTextures();
  }

  destroyGeneratedFrameTextures() {
    this.generatedFrameTextures.splice(0).forEach((texture) => {
      texture?.destroy?.(true);
    });
  }

  destroyFxTextureCache() {
    this.fxTextures.forEach((texture) => {
      texture?.destroy?.(true);
    });
    this.fxTextures.clear();
  }

  textureMemoryStats() {
    const fxTextureBytes = this.estimatedTextureMapBytes(this.fxTextures);
    const panelTextureBytes = this.estimatedTextureMapBytes(this.textures);
    const generatedFrameTextureBytes = this.estimatedTextureListBytes(this.generatedFrameTextures);
    return {
      fxTextureBytes,
      panelTextureBytes,
      generatedFrameTextureBytes,
      totalBytes: fxTextureBytes + panelTextureBytes + generatedFrameTextureBytes,
    };
  }

  estimatedTextureMapBytes(textures) {
    if (!textures?.values) return 0;
    return this.estimatedTextureListBytes([...textures.values()]);
  }

  estimatedTextureListBytes(textures = []) {
    return textures.reduce((total, texture) => total + this.estimatedTextureBytes(texture), 0);
  }

  estimatedTextureBytes(texture) {
    const width = Number(texture?.width || texture?.source?.width || texture?.baseTexture?.width);
    const height = Number(texture?.height || texture?.source?.height || texture?.baseTexture?.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return 0;
    return Math.max(0, Math.round(width * height * 4));
  }

  createCanvasTexture(key, width, height, painter) {
    if (this.fxTextures.has(key)) return this.fxTextures.get(key);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    painter(ctx, width, height);
    const texture = this.pixi.Texture.from(canvas);
    this.fxTextures.set(key, texture);
    return texture;
  }

  textureNoise(key = "noise-720x1280") {
    return this.createCanvasTexture(key, PIXI_PREVIEW_SIZE.width, PIXI_PREVIEW_SIZE.height, (ctx, width, height) => {
      const image = ctx.createImageData(width, height);
      for (let i = 0; i < image.data.length; i += 4) {
        const value = (Math.sin(i * 12.9898) * 43758.5453) % 1;
        const grain = Math.floor((value - Math.floor(value)) * 255);
        image.data[i] = grain;
        image.data[i + 1] = grain;
        image.data[i + 2] = grain;
        image.data[i + 3] = 255;
      }
      ctx.putImageData(image, 0, 0);
    });
  }

  textureHalftone(key = "halftone-720x1280", accent = "#ffffff") {
    return this.createCanvasTexture(key, PIXI_PREVIEW_SIZE.width, PIXI_PREVIEW_SIZE.height, (ctx, width, height) => {
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = accent;
      for (let y = 0; y < height; y += 14) {
        for (let x = 0; x < width; x += 14) {
          const dx = x - width * 0.5;
          const dy = y - height * 0.45;
          const distance = Math.hypot(dx / width, dy / height);
          const r = Math.max(1.2, 6.5 - distance * 13 + Math.sin(x * 0.07 + y * 0.05) * 1.4);
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    });
  }

  textureSpeedLines(key = "speed-lines-720x1280") {
    return this.createCanvasTexture(key, 720, 1280, (ctx, width, height) => {
      ctx.clearRect(0, 0, width, height);
      ctx.lineCap = "round";
      for (let i = 0; i < 90; i += 1) {
        const angle = -Math.PI * 0.8 + (i / 89) * Math.PI * 1.6;
        if (Math.abs(Math.cos(angle)) < 0.16 && i % 5 !== 0) continue;
        const cx = width * 0.52;
        const cy = height * 0.48;
        const inner = 260 + (i % 9) * 22;
        const outer = 950 + (i % 13) * 34;
        ctx.strokeStyle = i % 6 === 0 ? "rgba(255,255,255,0.62)" : "rgba(0,0,0,0.50)";
        ctx.lineWidth = i % 6 === 0 ? 4 : 2 + (i % 4);
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
        ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
        ctx.stroke();
      }
    });
  }

  textureHalftoneDots(key = "halftone-dots-720x1280") {
    return this.createCanvasTexture(key, PIXI_PREVIEW_SIZE.width, PIXI_PREVIEW_SIZE.height, (ctx, width, height) => {
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "#ffffff";
      for (let y = 70; y < height; y += 52) {
        for (let x = 42; x < width; x += 52) {
          const pulse = 0.65 + Math.sin(x * 0.02 + y * 0.01) * 0.35;
          ctx.globalAlpha = 0.74 + Math.sin(x * 0.017 + y * 0.013) * 0.18;
          ctx.beginPath();
          ctx.arc(x, y, 5 + pulse * 8, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    });
  }

  texturePaperGrain(key = "paper-grain-720x1280") {
    return this.createCanvasTexture(key, PIXI_PREVIEW_SIZE.width, PIXI_PREVIEW_SIZE.height, (ctx, width, height) => {
      ctx.clearRect(0, 0, width, height);
      for (let i = 0; i < 128; i += 1) {
        const x = (i * 83) % width;
        const y = (i * 137) % height;
        const lineWidth = 18 + (i % 7) * 12;
        ctx.fillStyle = i % 2 ? `rgba(0,0,0,${0.12 + (i % 5) * 0.025})` : `rgba(255,255,255,${0.1 + (i % 4) * 0.02})`;
        ctx.fillRect(x, y, lineWidth, 2);
      }
      for (let i = 0; i < 64; i += 1) {
        const x = (i * 59) % width;
        const y = (i * 97) % height;
        const radius = 1 + (i % 3);
        ctx.fillStyle = i % 4 === 0 ? "rgba(255,255,255,0.16)" : "rgba(0,0,0,0.2)";
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }

  textureRain(key = "rain-720x1280") {
    return this.createCanvasTexture(key, PIXI_PREVIEW_SIZE.width, PIXI_PREVIEW_SIZE.height, (ctx, width, height) => {
      ctx.clearRect(0, 0, width, height);
      ctx.lineCap = "round";
      for (let i = 0; i < 58; i += 1) {
        const x = ((i * 47) % (width + 120)) - 60;
        const y = ((i * 91) % (height + 160)) - 80;
        ctx.strokeStyle = i % 5 === 0 ? "rgba(255,255,255,0.44)" : "rgba(255,255,255,0.28)";
        ctx.lineWidth = i % 7 === 0 ? 3 : 2;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - 26, y + 88);
        ctx.stroke();
      }
    });
  }

  textureSpeedStreaks(key = "speed-streaks-720x1280-14", count = 14) {
    return this.createCanvasTexture(key, PIXI_PREVIEW_SIZE.width, PIXI_PREVIEW_SIZE.height, (ctx, width, height) => {
      ctx.clearRect(0, 0, width, height);
      ctx.lineCap = "round";
      for (let i = 0; i < count; i += 1) {
        const y = 90 + ((i * 79) % (height - 180));
        const x = -80 + (i % 5) * 32;
        ctx.strokeStyle = i % 3 === 0 ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.64)";
        ctx.lineWidth = 3 + (i % 3);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(width + 80, y - 230 - (i % 4) * 22);
        ctx.stroke();
      }
    });
  }

  textureImpactBurst(key = "impact-burst-720x1280") {
    return this.createCanvasTexture(key, PIXI_PREVIEW_SIZE.width, PIXI_PREVIEW_SIZE.height, (ctx, width, height) => {
      ctx.clearRect(0, 0, width, height);
      const cx = width * 0.5;
      const cy = height * 0.45;
      const count = 28;
      ctx.fillStyle = "rgba(255,255,255,0.82)";
      for (let i = 0; i < count; i += 1) {
        const angle = (Math.PI * 2 * i) / count;
        const inner = 80;
        const outer = 840 + (i % 5) * 18;
        ctx.globalAlpha = 0.16 + (i % 4) * 0.012;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(angle - 0.035) * inner, cy + Math.sin(angle - 0.035) * inner);
        ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
        ctx.lineTo(cx + Math.cos(angle + 0.035) * inner, cy + Math.sin(angle + 0.035) * inner);
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    });
  }

  textureFloatingParticles(key = "floating-particles-720x1280", petals = false) {
    return this.createCanvasTexture(key, PIXI_PREVIEW_SIZE.width, PIXI_PREVIEW_SIZE.height, (ctx, width, height) => {
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "#ffffff";
      for (let i = 0; i < 42; i += 1) {
        const x = 46 + ((i * 83) % (width - 92));
        const y = 80 + ((i * 137) % (height - 160));
        ctx.globalAlpha = 0.32 + (i % 4) * 0.1;
        ctx.beginPath();
        if (petals) ctx.ellipse(x, y, 7 + (i % 3), 15, Math.sin(i) * 0.7, 0, Math.PI * 2);
        else ctx.arc(x, y, 3 + (i % 5), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    });
  }

  textureSparkParticle(key = "spark-particle-32") {
    return this.createCanvasTexture(key, 32, 32, (ctx, width, height) => {
      ctx.clearRect(0, 0, width, height);
      const gradient = ctx.createRadialGradient(width / 2, height / 2, 1, width / 2, height / 2, width / 2);
      gradient.addColorStop(0, "rgba(255,255,255,1)");
      gradient.addColorStop(0.38, "rgba(255,255,255,0.82)");
      gradient.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.moveTo(width / 2, 1);
      ctx.lineTo(width * 0.64, height * 0.38);
      ctx.lineTo(width - 1, height / 2);
      ctx.lineTo(width * 0.64, height * 0.64);
      ctx.lineTo(width / 2, height - 1);
      ctx.lineTo(width * 0.36, height * 0.64);
      ctx.lineTo(1, height / 2);
      ctx.lineTo(width * 0.36, height * 0.38);
      ctx.closePath();
      ctx.fill();
    });
  }

  textureSmokeParticle(key = "smoke-particle-96") {
    return this.createCanvasTexture(key, 96, 96, (ctx, width, height) => {
      ctx.clearRect(0, 0, width, height);
      const cx = width / 2;
      const cy = height / 2;
      const gradient = ctx.createRadialGradient(cx, cy, 3, cx, cy, width * 0.48);
      gradient.addColorStop(0, "rgba(255,255,255,0.78)");
      gradient.addColorStop(0.28, "rgba(255,255,255,0.36)");
      gradient.addColorStop(0.62, "rgba(255,255,255,0.12)");
      gradient.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(cx, cy, width * 0.48, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = "destination-out";
      for (let i = 0; i < 9; i += 1) {
        const x = cx + Math.sin(i * 2.31) * width * 0.22;
        const y = cy + Math.cos(i * 1.77) * height * 0.22;
        const r = width * (0.08 + (i % 3) * 0.025);
        const cut = ctx.createRadialGradient(x, y, 1, x, y, r);
        cut.addColorStop(0, "rgba(0,0,0,0.22)");
        cut.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = cut;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";
    });
  }

  textureShardParticle(key = "shard-particle-48") {
    return this.createCanvasTexture(key, 48, 48, (ctx, width, height) => {
      ctx.clearRect(0, 0, width, height);
      const gradient = ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, "rgba(255,255,255,0)");
      gradient.addColorStop(0.35, "rgba(255,255,255,0.84)");
      gradient.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.moveTo(width * 0.12, height * 0.48);
      ctx.lineTo(width * 0.78, height * 0.08);
      ctx.lineTo(width * 0.56, height * 0.88);
      ctx.closePath();
      ctx.fill();
    });
  }

  textureComicBloodDrop(key = "comic-blood-drop-160") {
    return this.createCanvasTexture(key, 160, 220, (ctx, width, height) => {
      ctx.clearRect(0, 0, width, height);
      const cx = width * 0.5;
      const cy = height * 0.45;
      const gradient = ctx.createRadialGradient(cx - 18, cy - 36, 4, cx, cy, width * 0.58);
      gradient.addColorStop(0, "rgba(255,84,84,0.98)");
      gradient.addColorStop(0.24, "rgba(170,0,26,0.96)");
      gradient.addColorStop(0.72, "rgba(72,0,10,0.98)");
      gradient.addColorStop(1, "rgba(26,0,4,0.72)");
      ctx.fillStyle = gradient;
      ctx.strokeStyle = "rgba(18,0,3,0.88)";
      ctx.lineWidth = 7;
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(cx - 4, height * 0.06);
      ctx.bezierCurveTo(cx - 42, height * 0.22, cx - 62, height * 0.43, cx - 43, height * 0.61);
      ctx.bezierCurveTo(cx - 23, height * 0.82, cx + 24, height * 0.84, cx + 43, height * 0.6);
      ctx.bezierCurveTo(cx + 60, height * 0.37, cx + 34, height * 0.19, cx - 4, height * 0.06);
      ctx.closePath();
      ctx.stroke();
      ctx.fill();
      ctx.fillStyle = "rgba(255,225,210,0.72)";
      ctx.beginPath();
      ctx.ellipse(cx - 20, cy - 34, 12, 24, -0.35, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.38)";
      ctx.beginPath();
      ctx.ellipse(cx + 17, cy - 4, 7, 13, 0.4, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  textureComicBloodSplatter(key = "comic-blood-splatter-256") {
    return this.createCanvasTexture(key, 256, 256, (ctx, width, height) => {
      ctx.clearRect(0, 0, width, height);
      const cx = width * 0.5;
      const cy = height * 0.5;
      const gradient = ctx.createRadialGradient(cx - 18, cy - 12, 8, cx, cy, width * 0.42);
      gradient.addColorStop(0, "rgba(215,16,34,0.96)");
      gradient.addColorStop(0.58, "rgba(122,0,17,0.92)");
      gradient.addColorStop(1, "rgba(34,0,6,0.42)");
      ctx.fillStyle = gradient;
      ctx.strokeStyle = "rgba(20,0,4,0.72)";
      ctx.lineWidth = 5;
      ctx.lineJoin = "round";
      ctx.beginPath();
      const points = 18;
      for (let i = 0; i <= points; i += 1) {
        const a = (i / points) * Math.PI * 2;
        const wobble = 0.74 + Math.sin(i * 2.13) * 0.18 + Math.cos(i * 5.17) * 0.11;
        const r = width * (0.22 + (i % 4) * 0.018) * wobble;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r * (0.78 + Math.sin(i) * 0.08);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.fill();
      for (let i = 0; i < 22; i += 1) {
        const a = i * 2.399;
        const dist = width * (0.23 + (i % 7) * 0.035);
        const x = cx + Math.cos(a) * dist;
        const y = cy + Math.sin(a) * dist * 0.82;
        const r = 2.5 + (i % 5) * 1.9;
        ctx.fillStyle = i % 3 ? "rgba(111,0,17,0.72)" : "rgba(198,10,30,0.78)";
        ctx.beginPath();
        ctx.ellipse(x, y, r * (1 + (i % 3) * 0.35), r, Math.sin(i) * 1.2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = "rgba(255,220,205,0.54)";
      ctx.beginPath();
      ctx.ellipse(cx - 20, cy - 28, 14, 8, -0.5, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  textureToxicOozeDrop(key = "toxic-ooze-drop-180") {
    return this.createCanvasTexture(key, 220, 280, (ctx, width, height) => {
      ctx.clearRect(0, 0, width, height);
      const cx = width * 0.5;
      const cy = height * 0.48;
      const gradient = ctx.createRadialGradient(cx - 18, cy - 42, 8, cx, cy, width * 0.58);
      gradient.addColorStop(0, "rgba(244,255,165,1)");
      gradient.addColorStop(0.2, "rgba(162,255,76,0.98)");
      gradient.addColorStop(0.54, "rgba(47,177,45,0.94)");
      gradient.addColorStop(0.82, "rgba(8,87,39,0.88)");
      gradient.addColorStop(1, "rgba(1,21,13,0.66)");
      ctx.fillStyle = gradient;
      ctx.strokeStyle = "rgba(1,34,16,0.76)";
      ctx.lineWidth = 8;
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(cx - 2, height * 0.06);
      ctx.bezierCurveTo(cx - 64, height * 0.16, cx - 82, height * 0.38, cx - 52, height * 0.62);
      ctx.bezierCurveTo(cx - 20, height * 0.88, cx + 30, height * 0.88, cx + 54, height * 0.62);
      ctx.bezierCurveTo(cx + 78, height * 0.34, cx + 48, height * 0.16, cx - 2, height * 0.06);
      ctx.closePath();
      ctx.stroke();
      ctx.fill();
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      const sheen = ctx.createLinearGradient(cx - 42, cy - 82, cx + 26, cy + 48);
      sheen.addColorStop(0, "rgba(255,255,220,0.68)");
      sheen.addColorStop(0.35, "rgba(200,255,92,0.24)");
      sheen.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = sheen;
      ctx.beginPath();
      ctx.ellipse(cx - 22, cy - 28, 26, 72, -0.42, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      for (let i = 0; i < 8; i += 1) {
        const x = cx - 28 + (i % 4) * 18 + Math.sin(i) * 5;
        const y = cy - 34 + Math.floor(i / 4) * 42 + Math.cos(i) * 8;
        const r = 5 + (i % 3) * 3;
        ctx.strokeStyle = "rgba(236,255,150,0.62)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(x, y, r * 1.15, r, 0.2, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = "rgba(255,255,214,0.58)";
      ctx.beginPath();
      ctx.ellipse(cx - 22, cy - 36, 13, 24, -0.45, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  textureToxicBubble(key = "toxic-bubble-96") {
    return this.createCanvasTexture(key, 96, 96, (ctx, width, height) => {
      ctx.clearRect(0, 0, width, height);
      const cx = width * 0.5;
      const cy = height * 0.5;
      const gradient = ctx.createRadialGradient(cx - 16, cy - 18, 4, cx, cy, width * 0.46);
      gradient.addColorStop(0, "rgba(255,255,220,0.72)");
      gradient.addColorStop(0.24, "rgba(173,255,82,0.28)");
      gradient.addColorStop(0.72, "rgba(67,230,64,0.12)");
      gradient.addColorStop(1, "rgba(10,90,34,0)");
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.ellipse(cx, cy, width * 0.36, height * 0.34, -0.16, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(218,255,138,0.72)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(cx, cy, width * 0.31, height * 0.3, -0.16, 0.22, Math.PI * 1.82);
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,230,0.8)";
      ctx.beginPath();
      ctx.ellipse(cx - 14, cy - 17, 8, 5, -0.5, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  textureInkSplatter(key = "black-ink-splatter-260") {
    return this.createCanvasTexture(key, 260, 260, (ctx, width, height) => {
      ctx.clearRect(0, 0, width, height);
      const cx = width * 0.5;
      const cy = height * 0.5;
      ctx.fillStyle = "rgba(2,2,3,0.92)";
      ctx.strokeStyle = "rgba(245,242,225,0.22)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (let i = 0; i <= 28; i += 1) {
        const a = (i / 28) * Math.PI * 2;
        const wobble = 0.72 + Math.sin(i * 1.91) * 0.22 + Math.cos(i * 4.73) * 0.14;
        const r = width * (0.2 + (i % 5) * 0.012) * wobble;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r * (0.82 + Math.sin(i * 0.5) * 0.08);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      for (let i = 0; i < 30; i += 1) {
        const a = i * 2.17;
        const dist = width * (0.22 + (i % 8) * 0.038);
        const x = cx + Math.cos(a) * dist;
        const y = cy + Math.sin(a) * dist * 0.86;
        const r = 2 + (i % 5) * 2.2;
        ctx.fillStyle = i % 4 ? "rgba(0,0,0,0.8)" : "rgba(30,30,34,0.65)";
        ctx.beginPath();
        ctx.ellipse(x, y, r * (1.1 + (i % 3) * 0.6), r, Math.sin(i) * 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }

  drawParticleBurst({ x, y, accent = "#ffffff", count = 42, progress = 1, timeSeconds = 0, radius = 300, verticalScale = 0.78 } = {}) {
    const accentColor = parsePixiColor(accent);
    const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.78 });
    const particles = new this.pixi.Graphics();
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2 + Math.sin(i * 13.17) * 0.2;
      const speed = radius * (0.26 + (i % 9) / 10) * (0.45 + progress * 0.72);
      const drift = timeSeconds * (20 + (i % 5) * 14);
      const px = x + Math.cos(angle) * speed + Math.sin(i + timeSeconds * 6) * 12 + (i % 2 ? drift * 0.16 : -drift * 0.08);
      const py = y + Math.sin(angle) * speed * verticalScale + Math.cos(i * 2 + timeSeconds * 5) * 10 - drift * 0.18;
      const color = i % 5 === 0 ? 0xffffff : accentColor;
      const alpha = Math.max(0, 0.26 - progress * 0.045) * (i % 4 === 0 ? 1 : 0.7);
      const size = 2 + (i % 5) * 1.2 + progress * 2.2;

      if (i % 3 === 0) {
        const rotation = angle + timeSeconds * (0.5 + (i % 4) * 0.12);
        const dx = Math.cos(rotation);
        const dy = Math.sin(rotation);
        const len = size * (3.5 + (i % 4) * 0.7);
        this.drawTaperedQuad(particles, px - dx * len, py - dy * len, px + dx * len, py + dy * len, size * 0.35, size * 0.75, color, alpha * 0.82);
        this.drawTaperedQuad(particles, px - dy * len * 0.42, py + dx * len * 0.42, px + dy * len * 0.42, py - dx * len * 0.42, size * 0.25, size * 0.42, color, alpha * 0.55);
      } else {
        particles.circle(px, py, size).fill({ color, alpha: alpha * 0.62 });
      }
    }
    layer.addChild(particles);
  }

  createShaderFilter(name, fragment, uniforms = {}, options = {}) {
    if (!this.pixi.Filter?.from) return null;
    try {
      const filter = this.pixi.Filter.from({
        gl: { fragment, name },
        resources: {
          localUniforms: {
            uTime: { value: uniforms.uTime ?? 0, type: "f32" },
            uStrength: { value: uniforms.uStrength ?? 0, type: "f32" },
            uProgress: { value: uniforms.uProgress ?? 0, type: "f32" },
            uAspect: { value: uniforms.uAspect ?? PIXI_PREVIEW_SIZE.width / PIXI_PREVIEW_SIZE.height, type: "f32" },
          },
        },
        padding: options.padding || 0,
      });
      const resolution = this.qualityAdjustedShaderResolution(options.resolution);
      if (Number.isFinite(resolution)) filter.resolution = resolution;
      return filter;
    } catch {
      return null;
    }
  }

  updateShaderFilter(filter, uniforms = {}) {
    const local = filter?.resources?.localUniforms?.uniforms || filter?.resources?.localUniforms;
    if (!local) return;
    Object.entries(uniforms).forEach(([key, value]) => {
      if (local[key]?.value !== undefined) local[key].value = value;
      else if (key in local) local[key] = value;
    });
  }

  createChromaticPulseFilter(timeSeconds, strength = 0.006) {
    const filter = this.createShaderFilter("p2r-chromatic-pulse", `
      in vec2 vTextureCoord;
      out vec4 finalColor;
      uniform sampler2D uTexture;
      uniform float uTime;
      uniform float uStrength;
      uniform float uAspect;
      void main(void) {
        vec2 uv = vTextureCoord;
        vec2 center = vec2(0.5, 0.48);
        vec2 delta = uv - center;
        float distance = length(vec2(delta.x * uAspect, delta.y));
        float pulse = sin((distance * 14.0) - uTime * 5.8) * uStrength;
        vec2 offset = normalize(delta + vec2(0.0001)) * pulse;
        float r = texture(uTexture, uv + offset).r;
        float g = texture(uTexture, uv).g;
        float b = texture(uTexture, uv - offset).b;
        vec4 base = texture(uTexture, uv);
        finalColor = vec4(r, g, b, base.a);
      }
    `, { uTime: timeSeconds, uStrength: strength });
    if (filter) this.updateShaderFilter(filter, { uTime: timeSeconds, uStrength: strength });
    return filter;
  }

  createHeatWaveFilter(timeSeconds, strength = 0.01) {
    const filter = this.createShaderFilter("p2r-heat-wave", `
      in vec2 vTextureCoord;
      out vec4 finalColor;
      uniform sampler2D uTexture;
      uniform float uTime;
      uniform float uStrength;
      uniform float uAspect;
      void main(void) {
        vec2 uv = vTextureCoord;
        float wave = sin(uv.y * 42.0 + uTime * 4.0) * cos(uv.x * 18.0 - uTime * 2.2);
        vec2 warped = uv + vec2(wave * uStrength, sin(uv.x * 20.0 + uTime) * uStrength * 0.36);
        finalColor = texture(uTexture, warped);
      }
    `, { uTime: timeSeconds, uStrength: strength }, { padding: 8 });
    if (filter) this.updateShaderFilter(filter, { uTime: timeSeconds, uStrength: strength });
    return filter;
  }

  createToxicLiquidWarpFilter(timeSeconds, strength = 0.012, progress = 1) {
    const filter = this.createShaderFilter("p2r-toxic-liquid-warp", `
      in vec2 vTextureCoord;
      out vec4 finalColor;
      uniform sampler2D uTexture;
      uniform float uTime;
      uniform float uStrength;
      uniform float uProgress;
      uniform float uAspect;
      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }
      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        float a = hash(i);
        float b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0));
        float d = hash(i + vec2(1.0, 1.0));
        return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
      }
      void main(void) {
        vec2 uv = vTextureCoord;
        float topMask = smoothstep(0.7, 0.04, uv.y);
        float edgeMask = max(smoothstep(0.18, 0.0, uv.x), smoothstep(0.82, 1.0, uv.x));
        float organic = noise(vec2(uv.x * 8.5 + uTime * 0.24, uv.y * 12.0 - uTime * 0.34));
        float vein = sin((uv.y * 32.0 + organic * 4.0) - uTime * 2.4) * cos(uv.x * 17.0 + uTime);
        float mask = clamp(topMask * (0.34 + organic * 0.66) + edgeMask * 0.45, 0.0, 1.0) * uProgress;
        vec2 offset = vec2(
          (vein + organic - 0.55) * uStrength * mask,
          sin(uv.x * 21.0 + organic * 5.0 + uTime * 1.3) * uStrength * 0.44 * mask
        );
        vec4 warped = texture(uTexture, uv + offset);
        vec4 base = texture(uTexture, uv);
        vec3 tint = vec3(0.12, 0.46, 0.08) * mask * 0.18;
        finalColor = vec4(mix(base.rgb, warped.rgb + tint, mask * 0.82), base.a);
      }
    `, { uTime: timeSeconds, uStrength: strength, uProgress: progress }, { padding: 16 });
    if (filter) this.updateShaderFilter(filter, { uTime: timeSeconds, uStrength: strength, uProgress: progress });
    return filter;
  }

  createVhsTearFilter(timeSeconds, strength = 0.012) {
    const filter = this.createShaderFilter("p2r-vhs-tear", `
      in vec2 vTextureCoord;
      out vec4 finalColor;
      uniform sampler2D uTexture;
      uniform float uTime;
      uniform float uStrength;
      uniform float uAspect;
      float hash(float n) { return fract(sin(n) * 43758.5453123); }
      void main(void) {
        vec2 uv = vTextureCoord;
        float row = floor(uv.y * 90.0);
        float tear = (hash(row + floor(uTime * 10.0)) - 0.5) * uStrength;
        float gate = smoothstep(0.82, 1.0, hash(row * 4.7 + floor(uTime * 4.0)));
        uv.x += tear * gate;
        vec4 color = texture(uTexture, uv);
        float scan = sin((vTextureCoord.y + uTime * 0.12) * 900.0) * 0.035;
        finalColor = vec4(color.rgb - scan, color.a);
      }
    `, { uTime: timeSeconds, uStrength: strength }, { padding: 12 });
    if (filter) this.updateShaderFilter(filter, { uTime: timeSeconds, uStrength: strength });
    return filter;
  }

  createHorrorSignalCorruptionFilter(timeSeconds, strength = 0.02, progress = 0) {
    const filter = this.createShaderFilter("p2r-horror-signal-corruption", `
      in vec2 vTextureCoord;
      out vec4 finalColor;
      uniform sampler2D uTexture;
      uniform float uTime;
      uniform float uStrength;
      uniform float uProgress;
      uniform float uAspect;
      float hash(float n) { return fract(sin(n) * 43758.5453123); }
      float softBand(float y, float center, float width) {
        return smoothstep(width, 0.0, abs(y - center));
      }
      void main(void) {
        vec2 uv = vTextureCoord;
        float clock = floor(uTime * 12.0);
        float rowFine = floor(uv.y * 150.0);
        float rowChunk = floor(uv.y * 20.0);
        float burst = step(0.74, hash(clock * 1.73 + rowChunk * 7.11));
        float micro = step(0.88, hash(clock * 4.31 + rowFine * 2.03));
        float tear = (hash(rowChunk * 9.7 + clock) - 0.5) * uStrength * (0.52 + burst * 4.2);
        float wobble = sin(uv.y * 32.0 + uTime * 6.0) * uStrength * 0.42;
        float drift = sin(uv.y * 9.0 - uTime * 2.1) * uStrength * 0.44;
        uv.x += tear + wobble + drift;

        float crawl = fract(uTime * 0.34);
        float scanGate = softBand(vTextureCoord.y, crawl, 0.08);
        vec2 rgbVector = vec2(uStrength * (1.1 + burst * 4.8 + scanGate * 2.6), 0.0);
        vec4 base = texture(uTexture, uv);
        float r = texture(uTexture, uv + rgbVector).r;
        float g = texture(uTexture, uv + vec2(wobble * 0.28, 0.0)).g;
        float b = texture(uTexture, uv - rgbVector * 0.88).b;

        float scan = sin((vTextureCoord.y + uTime * 0.06) * 1250.0) * 0.035;
        float dropout = micro * (0.04 + burst * 0.08);
        float vignette = smoothstep(0.88, 0.25, length(vec2((vTextureCoord.x - 0.5) * uAspect, vTextureCoord.y - 0.48)));
        vec3 color = vec3(r, g, b);
        color = color * (0.82 + vignette * 0.24) - scan - dropout;
        color += vec3(0.0, 0.22, 0.28) * (burst * 0.08 + scanGate * 0.12);
        finalColor = vec4(color, base.a);
      }
    `, { uTime: timeSeconds, uStrength: strength, uProgress: progress }, { padding: 18 });
    if (filter) this.updateShaderFilter(filter, { uTime: timeSeconds, uStrength: strength, uProgress: progress });
    return filter;
  }

  drawCoverSprite(texture, parent, options = {}) {
    const sprite = new this.pixi.Sprite(texture);
    sprite.anchor.set(0.5);
    sprite.x = PIXI_PREVIEW_SIZE.width / 2 + (options.panX || 0) * PIXI_PREVIEW_SIZE.width;
    sprite.y = PIXI_PREVIEW_SIZE.height / 2 + (options.panY || 0) * PIXI_PREVIEW_SIZE.height;
    const scale = Math.max(PIXI_PREVIEW_SIZE.width / texture.width, PIXI_PREVIEW_SIZE.height / texture.height) * (options.zoom || 1);
    sprite.scale.set(scale);
    sprite.rotation = options.rotation || 0;
    sprite.alpha = options.alpha ?? 1;
    if (options.filters) this.applyFilters(sprite, options.filters, { fullFrame: true, padding: options.filterPadding || 0 });
    parent.addChild(sprite);
    return sprite;
  }

  drawCachedFullFrameTexture(texture, options = {}) {
    const parent = options.parent || this.root;
    const sprite = new this.pixi.Sprite(texture);
    sprite.x = options.x || 0;
    sprite.y = options.y || 0;
    sprite.width = options.width || PIXI_PREVIEW_SIZE.width;
    sprite.height = options.height || PIXI_PREVIEW_SIZE.height;
    sprite.alpha = options.alpha ?? 1;
    sprite.tint = options.tint ?? 0xffffff;
    sprite.blendMode = options.blendMode || "normal";
    parent.addChild(sprite);
    return sprite;
  }

  createFxLayer({ blendMode = "normal", alpha = 1, fullFrameFilterArea = true } = {}) {
    const layer = new this.pixi.Container();
    layer.blendMode = blendMode;
    layer.alpha = alpha;
    if (fullFrameFilterArea) layer.filterArea = this.previewFrameRectangle();
    this.root.addChild(layer);
    return layer;
  }

  createIncomingCompositeTexture(shot = null, panelTexture = null, timeSeconds = 0, transitionSeconds = 0.32) {
    if (!shot || !panelTexture || !this.app?.renderer?.generateTexture) return null;
    const activeEffects = shot.activeEffects || [];
    if (!activeEffects.length && !shot.textStyle) return null;
    const previousRoot = this.root;
    const compositeRoot = new this.pixi.Container();
    this.root = compositeRoot;
    try {
      const shotDuration = Math.max(shot.duration || shot.end - shot.start || 3, 0.2);
      const effectProgress = this.transitionEffectPrewarmProgress(transitionSeconds, shotDuration);
      const cameraMotion = this.findCameraMotionEffect(activeEffects);
      const camera = cameraMotion ? this.proVfxCamera(effectProgress, timeSeconds, cameraMotion) : {};
      const speedImpact = this.findSpeedImpactEffect(activeEffects);
      const impactZoom = this.findImpactZoomEffect(activeEffects);
      const softBloom = this.findSoftBloomEffect(activeEffects);
      const shadowCreep = this.findShadowCreepEffect(activeEffects);
      const proMotion = this.findProVfxMotionEffect(activeEffects);
      const horrorThriller = activeEffects.find((effect) => this.isHorrorThrillerEffect(effect));
      const frameOptions = this.incomingTransitionFrameOptions(shot, timeSeconds) || { zoom: 1.06 };
      this.drawCoverSprite(panelTexture, compositeRoot, {
        ...frameOptions,
        filters: this.createPanelFiltersForEffects({ speedImpact, impactZoom, softBloom, shadowCreep, proMotion, cameraMotion, horrorThriller }, timeSeconds),
      });
      const hasLayeredVisualEffect = activeEffects.some((effect) => !this.isCameraMotionOnlyEffect(effect));
      activeEffects.forEach((effect) => this.drawActiveEffect(effect, effectProgress, timeSeconds, {
        hasTextStyle: Boolean(shot.textStyle),
        hasLayeredVisualEffect,
        panelTexture,
        camera,
        transitionComposite: true,
        previewSafe: true,
      }));
      if (shot.textStyle) {
        this.drawTextStyle(shot.textStyle, Math.max(effectProgress, 0.18), timeSeconds);
      }
      let texture = null;
      const frame = new this.pixi.Rectangle(0, 0, PIXI_PREVIEW_SIZE.width, PIXI_PREVIEW_SIZE.height);
      try {
        texture = this.app.renderer.generateTexture({ target: compositeRoot, frame });
      } catch {
        texture = this.app.renderer.generateTexture(compositeRoot);
      }
      if (texture) this.generatedFrameTextures.push(texture);
      return texture;
    } catch (error) {
      console.warn("[panel2reels] Incoming composite texture failed", error);
      return null;
    } finally {
      this.root = previousRoot;
      compositeRoot.destroy?.({ children: true, texture: false, textureSource: false });
    }
  }

  incomingTransitionFrameOptions(shot = null, timeSeconds = 0) {
    if (!shot) return null;
    const activeEffects = shot.activeEffects || [];
    const zoomStart = Number.isFinite(shot.zoomStart) ? shot.zoomStart : 1.06;
    const cameraMotion = this.findCameraMotionEffect(activeEffects);
    const camera = cameraMotion ? this.proVfxCamera(0, timeSeconds, cameraMotion) : {};
    return {
      zoom: (zoomStart + Math.sin(timeSeconds * 0.75) * 0.006) * (camera.zoom || 1),
      panX: camera.panX || 0,
      panY: camera.panY || 0,
      rotation: camera.rotation || 0,
      alpha: 1,
    };
  }

  transitionIncomingOptions(authoredOptions = {}, progress = 1, context = {}, blendStart = 0.58) {
    const target = context?.incomingTextureFrameOptions || context?.incomingFrameOptions;
    if (!target) return authoredOptions;
    const safeProgress = Math.max(0, Math.min(progress, 1));
    const t = easeInOutCubic(Math.max(0, Math.min((safeProgress - blendStart) / Math.max(0.001, 1 - blendStart), 1)));
    if (t <= 0) return authoredOptions;
    const numericDefault = { zoom: 1.08, panX: 0, panY: 0, rotation: 0, alpha: 1 };
    const nextOptions = { ...authoredOptions };
    ["zoom", "panX", "panY", "rotation", "alpha"].forEach((key) => {
      if (!Number.isFinite(target[key])) return;
      const from = Number.isFinite(authoredOptions[key]) ? authoredOptions[key] : numericDefault[key];
      nextOptions[key] = lerp(from, target[key], t);
    });
    return nextOptions;
  }

  drawIncomingSettleFrame(texture, progress = 1, context = {}, start = 0.82) {
    const frameOptions = context?.incomingTextureFrameOptions || context?.incomingFrameOptions;
    if (!texture || !frameOptions) return;
    const safeProgress = Math.max(0, Math.min(progress, 1));
    const alpha = easeInOutCubic(Math.max(0, Math.min((safeProgress - start) / Math.max(0.001, 1 - start), 1)));
    if (alpha <= 0) return;
    this.drawCoverSprite(texture, this.root, {
      ...frameOptions,
      alpha,
    });
  }

  transitionEffectPrewarmProgress(transitionSeconds = 0.32, shotDuration = 3) {
    const durationRatio = Math.max(0, transitionSeconds) / Math.max(shotDuration, 0.2);
    return Math.max(0.1, Math.min(durationRatio * 0.85, 0.26));
  }

  effectProgressForShotEntry(shot = {}, previousShot = null, localProgress = 0, localElapsed = 0, shotDuration = 3) {
    if (!previousShot?.transitionOut) return localProgress;
    const previousDuration = Math.max(previousShot.duration || previousShot.end - previousShot.start || 3, 0.1);
    const previousTransitionSeconds = this.transitionDurationForShot(previousShot, previousDuration);
    const seededProgress = this.transitionEffectPrewarmProgress(previousTransitionSeconds, shotDuration);
    const blendOut = Math.max(0, 1 - localElapsed / Math.min(0.72, Math.max(0.28, previousTransitionSeconds)));
    return Math.min(1, Math.max(localProgress, localProgress + seededProgress * blendOut));
  }

  createBlurFilter(strength = 2, quality = 2) {
    if (!this.pixi.BlurFilter) return null;
    const adjustedStrength = this.qualityAdjustedBlurStrength(strength);
    const adjustedQuality = this.qualityAdjustedBlurQuality(quality);
    try {
      return new this.pixi.BlurFilter({ strength: adjustedStrength, quality: adjustedQuality });
    } catch {
      try {
        return new this.pixi.BlurFilter(adjustedStrength);
      } catch {
        return null;
      }
    }
  }

  createPixiFiltersInstance(name, options = {}) {
    const FilterClass = this.pixiFilters?.[name];
    if (!FilterClass) return null;
    try {
      const { filterPadding, filterResolution, ...filterOptions } = options;
      if (Number.isFinite(filterOptions.quality)) filterOptions.quality = this.qualityAdjustedExternalQuality(filterOptions.quality);
      if (Number.isFinite(filterOptions.blur)) filterOptions.blur = this.qualityAdjustedBlurStrength(filterOptions.blur);
      if (Number.isFinite(filterOptions.kernelSize)) filterOptions.kernelSize = this.qualityAdjustedMotionKernelSize(filterOptions.kernelSize);
      const filter = new FilterClass(filterOptions);
      if (Number.isFinite(filterPadding)) filter.padding = filterPadding;
      const resolution = this.qualityAdjustedFilterResolution(filterResolution);
      if (Number.isFinite(resolution)) filter.resolution = resolution;
      return filter;
    } catch {
      return null;
    }
  }

  createNoiseFilter(noise = 0.035, seed = 0) {
    if ((this.qualityGovernor.level || 0) > 0) return null;
    if (!this.qualitySetting("allowNoise") || !this.pixi.NoiseFilter) return null;
    try {
      return new this.pixi.NoiseFilter({ noise, seed });
    } catch {
      return null;
    }
  }

  createExternalGlowFilter(options = {}) {
    return this.createPixiFiltersInstance("GlowFilter", {
      distance: options.distance ?? 22,
      outerStrength: options.outerStrength ?? 1.3,
      innerStrength: options.innerStrength ?? 0.25,
      color: options.color ?? 0xffffff,
      quality: options.quality ?? 0.24,
      knockout: false,
    });
  }

  createExternalBloomFilter(options = {}) {
    return this.createPixiFiltersInstance("AdvancedBloomFilter", {
      threshold: options.threshold ?? 0.18,
      bloomScale: options.bloomScale ?? 0.62,
      brightness: options.brightness ?? 1.08,
      blur: options.blur ?? 5,
      quality: options.quality ?? 3,
    });
  }

  createExternalRgbSplitFilter(timeSeconds = 0, strength = 5) {
    const adjustedStrength = strength * (this.qualitySetting("rgbSplitScale") || 1) * this.qualityGovernorScale("rgbSplit");
    const wobble = Math.sin(timeSeconds * 2.2) * adjustedStrength;
    return this.createPixiFiltersInstance("RGBSplitFilter", {
      red: { x: -adjustedStrength - wobble * 0.35, y: wobble * 0.18 },
      green: { x: wobble * 0.12, y: adjustedStrength * 0.28 },
      blue: { x: adjustedStrength + wobble * 0.26, y: -wobble * 0.2 },
    });
  }

  createExternalMotionBlurFilter(x = 0, y = 0, kernelSize = 7) {
    return this.createPixiFiltersInstance("MotionBlurFilter", {
      velocity: { x, y },
      kernelSize,
      offset: 0,
    });
  }

  createExternalGodrayFilter(timeSeconds = 0, options = {}) {
    return this.createPixiFiltersInstance("GodrayFilter", {
      angle: options.angle ?? 32,
      gain: (options.gain ?? 0.42) * (this.qualitySetting("godrayGainScale") || 1) * this.qualityGovernorScale("godray"),
      lacunarity: options.lacunarity ?? 2.6,
      parallel: options.parallel ?? true,
      time: timeSeconds * (options.speed ?? 0.22),
    });
  }

  createExternalShockwaveFilter(timeSeconds = 0, options = {}) {
    return this.createPixiFiltersInstance("ShockwaveFilter", {
      center: options.center ?? { x: PIXI_PREVIEW_SIZE.width * 0.5, y: PIXI_PREVIEW_SIZE.height * 0.48 },
      radius: options.radius ?? 520,
      amplitude: (options.amplitude ?? 18) * (this.qualitySetting("shockwaveScale") || 1) * this.qualityGovernorScale("shockwave"),
      wavelength: options.wavelength ?? 170,
      brightness: options.brightness ?? 1.08,
      speed: options.speed ?? 240,
      time: timeSeconds * (options.timeScale ?? 0.55),
    });
  }

  drawPanelEcho(texture, camera = {}, options = {}) {
    if (!texture) return null;
    const layer = this.createFxLayer({
      blendMode: options.blendMode || "screen",
      alpha: options.alpha ?? 0.22,
    });
    const filters = [];
    if (options.blur) {
      const blur = this.createBlurFilter(options.blur, options.blurQuality || 2);
      if (blur) filters.push(blur);
    }
    const sprite = this.drawCoverSprite(texture, layer, {
      zoom: (1.08 + (camera.zoom || 1) - 1) + (options.zoomBoost || 0),
      panX: (camera.panX || 0) + (options.panX || 0),
      panY: (camera.panY || 0) + (options.panY || 0),
      rotation: (camera.rotation || 0) + (options.rotation || 0),
      alpha: options.spriteAlpha ?? 1,
      filters: filters.length ? filters : null,
    });
    return sprite;
  }

  createSpeedImpactPanelFilters(timeSeconds) {
    const filters = [];
    if (this.pixi.ColorMatrixFilter) {
      try {
        const color = new this.pixi.ColorMatrixFilter();
        color.contrast?.(1.16, false);
        color.saturate?.(1.12, true);
        filters.push(color);
      } catch {
        // Filters are an enhancement; the effect must still render without them.
      }
    }
    const noise = this.createNoiseFilter(0.035, (timeSeconds * 0.17) % 1);
    if (noise) filters.push(noise);
    return filters.length ? filters : null;
  }

  createSoftBloomPanelFilters(timeSeconds) {
    const filters = [];
    if (this.pixi.ColorMatrixFilter) {
      try {
        const color = new this.pixi.ColorMatrixFilter();
        color.saturate?.(1.1, false);
        color.brightness?.(1.04 + Math.sin(timeSeconds * 1.2) * 0.01, true);
        filters.push(color);
      } catch {
        // Optional enhancement.
      }
    }
    return filters.length ? filters : null;
  }

  createShadowCreepPanelFilters(timeSeconds) {
    const filters = [];
    if (this.pixi.ColorMatrixFilter) {
      try {
        const color = new this.pixi.ColorMatrixFilter();
        color.contrast?.(1.12, false);
        color.saturate?.(0.72, true);
        color.brightness?.(0.86 + Math.sin(timeSeconds * 1.7) * 0.025, true);
        filters.push(color);
      } catch {
        // Optional enhancement.
      }
    }
    const noise = this.createNoiseFilter(0.045, (timeSeconds * 0.11) % 1);
    if (noise) filters.push(noise);
    return filters.length ? filters : null;
  }

  createGlitchHorrorPanelFilters(timeSeconds) {
    const filters = [];
    if (this.pixi.ColorMatrixFilter) {
      try {
        const color = new this.pixi.ColorMatrixFilter();
        color.contrast?.(1.22, false);
        color.saturate?.(0.62, true);
        color.brightness?.(0.82 + Math.sin(timeSeconds * 5.1) * 0.035, true);
        filters.push(color);
      } catch {
        // Optional enhancement.
      }
    }
    const signal = this.createHorrorSignalCorruptionFilter(timeSeconds, 0.0045 + Math.max(0, Math.sin(timeSeconds * 8.4)) * 0.004, 0.5);
    if (signal) filters.push(signal);
    const noise = this.createNoiseFilter(0.055, (timeSeconds * 0.23) % 1);
    if (noise) filters.push(noise);
    return filters.length ? filters : null;
  }

  createPetalBloomPanelFilters(timeSeconds) {
    const filters = [];
    if (this.pixi.ColorMatrixFilter) {
      try {
        const color = new this.pixi.ColorMatrixFilter();
        color.contrast?.(1.04, false);
        color.saturate?.(0.92, true);
        color.brightness?.(1.02 + Math.sin(timeSeconds * 0.7) * 0.01, true);
        filters.push(color);
      } catch {
        // Optional enhancement.
      }
    }
    return filters.length ? filters : null;
  }

  createVerticalScrollPanelFilters(timeSeconds) {
    const filters = [];
    if (this.pixi.ColorMatrixFilter) {
      try {
        const color = new this.pixi.ColorMatrixFilter();
        color.contrast?.(1.03, false);
        color.saturate?.(1.02, true);
        color.brightness?.(1.04 + Math.sin(timeSeconds * 0.46) * 0.008, true);
        filters.push(color);
      } catch {
        // Optional enhancement.
      }
    }
    const noise = this.createNoiseFilter(0.012, (timeSeconds * 0.07) % 1);
    if (noise) filters.push(noise);
    return filters.length ? filters : null;
  }

  createThrillerSuspensePanelFilters(effect = {}, timeSeconds = 0) {
    const layout = effect.layout || "";
    const filters = [];
    if (this.pixi.ColorMatrixFilter) {
      try {
        const color = new this.pixi.ColorMatrixFilter();
        const isSuspense = layout.startsWith("suspense-");
        const isCold = layout.includes("surveillance") || layout.includes("phone") || layout.includes("identity") || layout.includes("curtain") || layout.includes("silence") || layout.includes("toxic") || layout.includes("bullet");
        color.contrast?.(isSuspense ? 1.2 : 1.28, false);
        color.saturate?.(isCold ? 0.58 : 0.78, true);
        color.brightness?.((isSuspense ? 0.9 : 0.86) + Math.sin(timeSeconds * 1.2) * 0.018, true);
        filters.push(color);
      } catch {
        // Optional enhancement.
      }
    }
    const needsChroma = layout.includes("surveillance") || layout.includes("phone") || layout.includes("identity") || layout.includes("countdown") || layout.includes("clock") || layout.includes("police-siren") || layout.includes("bullet-impact");
    if (needsChroma) {
      const rgbSplit = this.createExternalRgbSplitFilter(timeSeconds, layout.includes("identity") ? 7 : 4);
      if (rgbSplit) filters.push(rgbSplit);
      const chroma = this.createChromaticPulseFilter(timeSeconds, layout.includes("identity") ? 0.0055 : 0.0028);
      if (chroma) filters.push(chroma);
    }
    const needsDistortion = layout.includes("knife") || layout.includes("peek") || layout.includes("door") || layout.includes("chase") || layout.includes("interrogation") || layout.includes("toxic") || layout.includes("hellfire") || layout.includes("black-ink");
    if (needsDistortion) {
      const heat = this.createHeatWaveFilter(timeSeconds, layout.includes("knife") ? 0.006 : 0.0035);
      if (heat) filters.push(heat);
    }
    if (layout.includes("chase") || layout.includes("city-noir") || layout.includes("police-siren")) {
      const motion = this.createExternalMotionBlurFilter(layout.includes("city-noir") ? -5 : 18, layout.includes("city-noir") ? 16 : -10, 9);
      if (motion) filters.push(motion);
    }
    if (layout.includes("knife") || layout.includes("interrogation") || layout.includes("door") || layout.includes("dust-in-light") || layout.includes("fog-bank") || layout.includes("crime-scene") || layout.includes("toxic") || layout.includes("hellfire") || layout.includes("bullet-impact")) {
      const bloom = this.createExternalBloomFilter({
        threshold: 0.12,
        bloomScale: layout.includes("dust") ? 0.82 : 0.66,
        brightness: layout.includes("knife") ? 1.16 : 1.08,
        blur: layout.includes("dust") ? 8 : 5,
        quality: 3,
      });
      if (bloom) filters.push(bloom);
    }
    if (layout.includes("countdown") || layout.includes("clock") || layout.includes("hidden-clue") || layout.includes("bullet-impact")) {
      const shock = this.createExternalShockwaveFilter(timeSeconds, {
        amplitude: layout.includes("hidden-clue") ? 8 : 14,
        wavelength: layout.includes("clock") ? 210 : 170,
        radius: 620,
        timeScale: layout.includes("clock") ? 0.28 : 0.5,
      });
      if (shock) filters.push(shock);
    }
    if (layout.includes("curtain") || layout.includes("dust-in-light") || layout.includes("interrogation") || layout.includes("fog-bank") || layout.includes("crime-scene") || layout.includes("toxic") || layout.includes("hellfire")) {
      const godray = this.createExternalGodrayFilter(timeSeconds, {
        angle: layout.includes("curtain") ? 82 : 38,
        gain: layout.includes("dust") ? 0.52 : 0.36,
        speed: 0.2,
      });
      if (godray) filters.push(godray);
    }
    const noise = this.createNoiseFilter(layout.startsWith("suspense-") ? 0.055 : 0.045, (timeSeconds * 0.19) % 1);
    if (noise) filters.push(noise);
    return filters.length ? filters : null;
  }

  mangaActionSpecializedLayouts() {
    return new Set([
      "clash-spark-lock-pro-vfx",
      "ground-break-impact-pro-vfx",
      "projectile-barrage-rush-pro-vfx",
      "energy-beam-sweep-pro-vfx",
      "weapon-draw-glint-pro-vfx",
      "combo-hit-rhythm-pro-vfx",
      "shadow-clone-rush-pro-vfx",
      "battle-dust-wake-pro-vfx",
      "rage-pressure-lines-pro-vfx",
      "finisher-impact-frame-pro-vfx",
    ]);
  }

  isMangaActionSpecializedEffect(effect = {}) {
    return this.mangaActionSpecializedLayouts().has(effect?.layout);
  }

  createMangaActionPanelFilters(effect = {}, timeSeconds = 0) {
    const layout = effect.layout || "";
    const filters = [];
    if (this.pixi.ColorMatrixFilter) {
      try {
        const color = new this.pixi.ColorMatrixFilter();
        const isWarm = layout.includes("ground") || layout.includes("dust") || layout.includes("combo");
        const isHard = layout.includes("finisher") || layout.includes("rage");
        color.contrast?.(isHard ? 1.24 : 1.12, false);
        color.saturate?.(isWarm ? 0.92 : layout.includes("glint") ? 0.72 : 1.04, true);
        color.brightness?.((layout.includes("glint") ? 0.9 : 0.98) + Math.sin(timeSeconds * 1.4) * 0.012, true);
        filters.push(color);
      } catch {
        // Optional enhancement.
      }
    }
    if (layout.includes("projectile") || layout.includes("clone")) {
      const motion = this.createExternalMotionBlurFilter(layout.includes("clone") ? 12 : 10, layout.includes("projectile") ? -6 : -5, 7);
      if (motion) filters.push(motion);
    }
    if (layout.includes("beam") || layout.includes("clash") || layout.includes("glint")) {
      const bloom = this.createExternalBloomFilter({
        threshold: layout.includes("glint") ? 0.22 : 0.1,
        bloomScale: layout.includes("beam") ? 0.62 : 0.68,
        brightness: layout.includes("beam") ? 1.08 : 1.08,
        blur: layout.includes("beam") ? 5 : 5,
        quality: 3,
      });
      if (bloom) filters.push(bloom);
    }
    if (layout.includes("beam") || layout.includes("rage") || layout.includes("ground")) {
      const heat = this.createHeatWaveFilter(timeSeconds, layout.includes("beam") ? 0.0035 : 0.0035);
      if (heat) filters.push(heat);
    }
    if (layout.includes("finisher") || layout.includes("combo") || layout.includes("clash")) {
      const shock = this.createExternalShockwaveFilter(timeSeconds, {
        amplitude: layout.includes("finisher") ? 16 : 9,
        wavelength: layout.includes("clash") ? 145 : 190,
        radius: 620,
        timeScale: 0.38,
      });
      if (shock) filters.push(shock);
    }
    if (layout.includes("projectile") || layout.includes("beam") || layout.includes("finisher")) {
      const rgb = this.createExternalRgbSplitFilter(timeSeconds, layout.includes("finisher") ? 3.5 : 1.4);
      if (rgb) filters.push(rgb);
    }
    const noise = this.createNoiseFilter(layout.includes("finisher") ? 0.045 : 0.026, (timeSeconds * 0.21) % 1);
    if (noise) filters.push(noise);
    return filters.length ? filters : null;
  }

  createPanelFiltersForEffects(effects, timeSeconds) {
    if (effects.cameraMotion) return this.finalizePanelFilters(this.createCameraMotionPanelFilters(effects.cameraMotion, timeSeconds));
    if (effects.horrorThriller?.layout?.startsWith("thriller-") || effects.horrorThriller?.layout?.startsWith("suspense-")) {
      return this.finalizePanelFilters(this.createThrillerSuspensePanelFilters(effects.horrorThriller, timeSeconds));
    }
    if (effects.proMotion && this.isMangaActionSpecializedEffect(effects.proMotion)) {
      return this.finalizePanelFilters(this.createMangaActionPanelFilters(effects.proMotion, timeSeconds));
    }
    if (effects.speedImpact || effects.impactZoom) return this.finalizePanelFilters(this.createSpeedImpactPanelFilters(timeSeconds));
    if (effects.softBloom) return this.finalizePanelFilters(this.createSoftBloomPanelFilters(timeSeconds));
    if (effects.shadowCreep) return this.finalizePanelFilters(this.createShadowCreepPanelFilters(timeSeconds));
    if (effects.proMotion?.layout === "glitch-horror-pro-vfx") return this.finalizePanelFilters(this.createGlitchHorrorPanelFilters(timeSeconds));
    if (effects.proMotion?.layout === "petal-fall-pro-vfx") return this.finalizePanelFilters(this.createPetalBloomPanelFilters(timeSeconds));
    if (effects.proMotion?.layout === "vertical-scroll-pro-vfx") return this.finalizePanelFilters(this.createVerticalScrollPanelFilters(timeSeconds));
    return null;
  }

  findSpeedImpactEffect(effects = []) {
    return (effects || []).find((effect) => effect?.layout === "speed-impact" || effect?.id === "effect-style-01" || effect?.id === "fx-pro-manga-speed-impact") || null;
  }

  findImpactZoomEffect(effects = []) {
    return (effects || []).find((effect) => effect?.layout === "impact-zoom" || effect?.id === "effect-style-02" || effect?.id === "fx-manga-impact-zoom" || effect?.id === "fx-pro-impact-zoom") || null;
  }

  findSoftBloomEffect(effects = []) {
    return (effects || []).find((effect) => effect?.layout === "soft-glow-pro-vfx" || effect?.layout === "soft-bloom" || effect?.id === "fx-soft-bloom-push" || effect?.id === "fx-pro-soft-glow") || null;
  }

  findShadowCreepEffect(effects = []) {
    return (effects || []).find((effect) => effect?.layout === "dark-pulse-pro-vfx" || effect?.layout === "shadow-creep" || effect?.id === "fx-shadow-creep" || effect?.id === "fx-pro-dark-pulse") || null;
  }

  findProVfxMotionEffect(effects = []) {
    const layouts = new Set([
      "glitch-horror-pro-vfx",
      "petal-fall-pro-vfx",
      "vertical-scroll-pro-vfx",
      "webtoon-long-page-glide",
      "webtoon-blur-to-clarity",
      "manhwa-soft-glow-hold",
      "manhwa-depth-layer-drift",
      "webtoon-cliffhanger-drop-hold",
      "webtoon-panel-stitch-reveal",
      "webtoon-scroll-fold-hook",
      "manhwa-dialogue-ladder-focus",
      "manhwa-character-reveal-scan",
      "manhwa-reaction-beat-stack",
      "webtoon-social-panel-tease",
      "webtoon-cover-drop-tease",
      "manhwa-rain-window-drama",
      "manhwa-neon-city-scroll",
      "manhwa-royal-entrance-glow",
      "clash-spark-lock-pro-vfx",
      "ground-break-impact-pro-vfx",
      "projectile-barrage-rush-pro-vfx",
      "energy-beam-sweep-pro-vfx",
      "weapon-draw-glint-pro-vfx",
      "combo-hit-rhythm-pro-vfx",
      "shadow-clone-rush-pro-vfx",
      "battle-dust-wake-pro-vfx",
      "rage-pressure-lines-pro-vfx",
      "finisher-impact-frame-pro-vfx",
    ]);
    return (effects || []).find((effect) => layouts.has(effect?.layout) || ["fx-pro-vertical-scroll", "fx-pro-glitch-horror", "fx-pro-petal-fall"].includes(effect?.id)) || null;
  }

  isWebtoonManhwaEffect(effect = {}) {
    return [
      "webtoon-long-page-glide",
      "webtoon-floating-panel-stack",
      "manhwa-drama-eye-push",
      "webtoon-blur-to-clarity",
      "manhwa-soft-glow-hold",
      "webtoon-gutter-pause-focus",
      "webtoon-scroll-snap-beat",
      "manhwa-depth-layer-drift",
      "webtoon-cliffhanger-drop-hold",
      "webtoon-panel-stitch-reveal",
      "webtoon-scroll-fold-hook",
      "manhwa-dialogue-ladder-focus",
      "manhwa-character-reveal-scan",
      "manhwa-reaction-beat-stack",
      "webtoon-social-panel-tease",
      "webtoon-cover-drop-tease",
      "manhwa-rain-window-drama",
      "manhwa-neon-city-scroll",
      "manhwa-royal-entrance-glow",
    ].includes(effect?.layout);
  }

  isRomanceFantasyEffect(effect = {}) {
    return [
      "romance-moonlit-confession-glow",
      "romance-heartbeat-aura-pulse",
      "romance-dream-light-bloom",
      "fantasy-enchanted-dust-drift",
      "fantasy-rune-halo-reveal",
      "romance-blush-sparkle-focus",
      "fantasy-floating-ribbon-veil",
      "romance-memory-mist-dissolve",
      "fantasy-starlight-wish",
      "fantasy-crystal-prism-glow",
      "romance-golden-fate-threads",
      "fantasy-aurora-veil-drift",
      "romance-tear-drop-shimmer",
      "fantasy-butterfly-dream-swarm",
      "romance-royal-ballroom-light",
      "fantasy-healing-light-aura",
      "romance-perfume-scent-trail",
      "romance-snow-kiss-silence",
      "fantasy-magic-book-glow",
    ].includes(effect?.layout);
  }

  isHorrorThrillerEffect(effect = {}) {
    return [
      "horror-shadow-crawl",
      "horror-red-strobe-dread",
      "horror-ink-bleed-omen",
      "horror-jumpscare-snap",
      "horror-vhs-possession",
      "horror-eye-panic-push",
      "horror-blackout-breath",
      "horror-cursed-symbol-reveal",
      "horror-monster-silhouette",
      "thriller-chase-pulse",
      "thriller-surveillance-scan",
      "thriller-evidence-pinboard",
      "thriller-crosshair-lock",
      "thriller-knife-edge-light",
      "thriller-phone-signal-trace",
      "thriller-countdown-pressure",
      "thriller-interrogation-lamp",
      "thriller-city-noir-pursuit",
      "thriller-identity-fracture",
      "suspense-slow-door-creak",
      "suspense-held-breath-vignette",
      "suspense-hidden-clue-glint",
      "suspense-footstep-ripple",
      "suspense-curtain-shadow",
      "suspense-silence-drop",
      "suspense-peek-through-crack",
      "suspense-clock-tension",
      "suspense-dust-in-light",
      "suspense-unseen-watcher",
      "suspense-fog-bank",
      "horror-blood-drop-omen",
      "toxic-ooze-omen",
      "hellfire-ash-omen",
      "bullet-impact-glass",
      "black-ink-curse",
      "thriller-crime-scene-light-sweep",
      "thriller-police-siren-wash",
    ].includes(effect?.layout);
  }

  findCameraMotionEffect(effects = []) {
    return (effects || []).find((effect) => this.isCameraMotionOnlyEffect(effect)) || null;
  }

  cameraMotionOnlyLayouts() {
    return [
      "camera-slow-push-in-pro-vfx",
      "camera-snap-zoom-pro-vfx",
      "camera-whip-pan-pro-vfx",
      "camera-cut-panel-rhythm-pro-vfx",
      "camera-manga-panel-board-pro-vfx",
      "camera-dutch-drift-pro-vfx",
      "camera-vertical-scan-pro-vfx",
      "camera-crash-punch-in-pro-vfx",
      "camera-hero-rise-pro-vfx",
      "camera-cliffhanger-drop-pro-vfx",
      "camera-floating-parallax-pro-vfx",
      "camera-noir-creep-pro-vfx",
      "camera-orbit-reveal-pro-vfx",
      "camera-page-glide-pro-vfx",
      "camera-micro-shake-pro-vfx",
      "camera-romance-drift-pro-vfx",
      "camera-horror-creep-zoom-pro-vfx",
    ];
  }

  isCameraMotionOnlyEffect(effect = {}) {
    return this.cameraMotionOnlyLayouts().includes(effect?.layout);
  }

  createCameraMotionPanelFilters(effect = {}, timeSeconds = 0) {
    const layout = effect.layout || "";
    const intensity = this.cameraMotionIntensity(effect);
    const tempo = this.cameraMotionTempo(effect);
    const filters = [];
    if (layout === "camera-whip-pan-pro-vfx") {
      const blur = this.createBlurFilter((1.1 + Math.max(0, Math.sin(timeSeconds * 2.4 * tempo)) * 0.55) * intensity, 2);
      if (blur) filters.push(blur);
    }
    if (layout === "camera-snap-zoom-pro-vfx") {
      const chroma = this.createChromaticPulseFilter(timeSeconds * tempo, 0.0025 * intensity);
      if (chroma) filters.push(chroma);
    }
    return filters.length ? filters : null;
  }

  cameraMotionIntensity(effect = {}) {
    const value = Number(effect.parameters?.motionIntensity ?? effect.motionIntensity ?? 1);
    if (!Number.isFinite(value)) return 1;
    return Math.min(1.65, Math.max(0.45, value));
  }

  cameraMotionTempo(effect = {}) {
    const value = Number(effect.parameters?.motionTempo ?? effect.motionTempo ?? 1);
    if (!Number.isFinite(value)) return 1;
    return Math.min(1.5, Math.max(0.65, value));
  }

  scaleCameraMotion(camera = {}, intensity = 1) {
    return {
      zoom: 1 + ((camera.zoom || 1) - 1) * intensity,
      panX: (camera.panX || 0) * intensity,
      panY: (camera.panY || 0) * intensity,
      rotation: (camera.rotation || 0) * intensity,
    };
  }

  speedImpactCamera(progress, timeSeconds) {
    const hit = Math.pow(Math.max(0, 1 - Math.min(progress / 0.2, 1)), 1.35);
    const push = easeInOutCubic(Math.min(progress / 0.92, 1));
    const drift = Math.sin(progress * Math.PI);
    const beat = Math.sin(timeSeconds * 26);
    const aftershock = Math.max(0, Math.sin(progress * Math.PI * 3)) * 0.012;
    return {
      zoom: 1.045 + push * 0.11 + hit * 0.145 + drift * 0.026 + aftershock,
      panX: lerp(-0.052, 0.034, push) + Math.sin(timeSeconds * 12.2) * 0.012 * (0.35 + hit),
      panY: lerp(0.034, -0.026, push) + Math.cos(timeSeconds * 11.4) * 0.01 * (0.35 + hit),
      rotation: beat * 0.009 * (0.35 + hit) + Math.sin(progress * Math.PI * 2) * 0.004,
    };
  }

  impactZoomCamera(progress, timeSeconds) {
    const hit = Math.max(0, 1 - Math.min(progress / 0.28, 1));
    const rebound = Math.sin(Math.min(progress, 1) * Math.PI);
    const shake = hit * 0.018 + rebound * 0.004;
    return {
      zoom: 1.04 + hit * 0.16 + rebound * 0.035,
      panX: Math.sin(timeSeconds * 24) * shake,
      panY: Math.cos(timeSeconds * 21) * shake * 0.82,
      rotation: Math.sin(timeSeconds * 28) * hit * 0.007,
    };
  }

  softBloomCamera(progress, timeSeconds) {
    const eased = easeInOutCubic(Math.min(progress, 1));
    const breath = 0.5 + Math.sin(timeSeconds * 0.72) * 0.5;
    return {
      zoom: 1.022 + eased * 0.072 + breath * 0.012,
      panX: lerp(-0.026, 0.022, eased) + Math.sin(timeSeconds * 0.38) * 0.014,
      panY: lerp(0.02, -0.032, eased) + Math.cos(timeSeconds * 0.34) * 0.012,
      rotation: Math.sin(timeSeconds * 0.28) * 0.0035,
    };
  }

  shadowCreepCamera(progress, timeSeconds) {
    const pulse = 0.5 + Math.sin(timeSeconds * 1.7) * 0.5;
    const eased = easeInOutCubic(Math.min(progress, 1));
    return {
      zoom: 1.03 + eased * 0.055 + pulse * 0.018,
      panX: lerp(0.018, -0.024, eased) + Math.sin(timeSeconds * 0.45) * 0.01,
      panY: lerp(-0.018, 0.022, eased) + Math.cos(timeSeconds * 0.4) * 0.01,
      rotation: Math.sin(timeSeconds * 0.32) * 0.004,
    };
  }

  proVfxCamera(progress, timeSeconds, effect = {}) {
    const layout = effect.layout || "";
    const intensity = this.cameraMotionIntensity(effect);
    const tempo = this.cameraMotionTempo(effect);
    const t = timeSeconds * tempo;
    const apply = (camera) => this.scaleCameraMotion(camera, intensity);
    const eased = easeInOutCubic(Math.min(progress, 1));
    const hit = Math.max(0, 1 - Math.min(progress / 0.22, 1));
    if (layout === "camera-slow-push-in-pro-vfx") {
      const breath = 0.5 + Math.sin(t * 0.48) * 0.5;
      return apply({
        zoom: 1.015 + eased * 0.15 + breath * 0.008,
        panX: lerp(-0.018, 0.018, eased) + Math.sin(t * 0.34) * 0.006,
        panY: lerp(0.028, -0.034, eased) + Math.cos(t * 0.3) * 0.005,
        rotation: Math.sin(t * 0.22) * 0.002,
      });
    }
    if (layout === "camera-snap-zoom-pro-vfx") {
      const snap = Math.max(0, 1 - Math.min(progress / 0.16, 1));
      const settle = Math.sin(Math.min(Math.max((progress - 0.1) / 0.62, 0), 1) * Math.PI);
      return apply({
        zoom: 1.05 + snap * 0.18 + settle * 0.08 + eased * 0.035,
        panX: lerp(0.042, -0.012, eased) + Math.sin(t * 34) * snap * 0.012,
        panY: lerp(-0.028, 0.018, eased) + Math.cos(t * 31) * snap * 0.009,
        rotation: Math.sin(t * 38) * snap * 0.006,
      });
    }
    if (layout === "camera-whip-pan-pro-vfx") {
      const whip = Math.sin(Math.min(progress, 1) * Math.PI);
      const settle = Math.max(0, Math.sin(progress * Math.PI * 2.4)) * Math.max(0, 1 - progress * 0.7);
      return apply({
        zoom: 1.08 + whip * 0.065,
        panX: lerp(-0.13, 0.14, eased) + Math.sin(t * 20) * whip * 0.014 + settle * 0.018,
        panY: lerp(0.02, -0.02, eased) + Math.cos(t * 16) * whip * 0.008,
        rotation: lerp(-0.016, 0.012, eased) + Math.sin(t * 18) * settle * 0.004,
      });
    }
    if (layout === "camera-cut-panel-rhythm-pro-vfx") {
      const cutBeat = Math.sin(Math.min(progress / 0.82, 1) * Math.PI);
      return apply({
        zoom: 1.035 + eased * 0.075 + cutBeat * 0.025,
        panX: lerp(-0.04, 0.035, eased) + Math.sin(t * 0.7) * 0.008,
        panY: lerp(0.022, -0.026, eased) + Math.cos(t * 0.62) * 0.007,
        rotation: lerp(-0.006, 0.006, eased) + Math.sin(t * 0.48) * 0.002,
      });
    }
    if (layout === "camera-manga-panel-board-pro-vfx") {
      const boardBeat = Math.sin(Math.min(progress / 0.9, 1) * Math.PI);
      return apply({
        zoom: 1.06 + eased * 0.055 + boardBeat * 0.018,
        panX: lerp(-0.032, 0.032, eased) + Math.sin(t * 0.42) * 0.006,
        panY: lerp(-0.028, 0.03, eased) + Math.cos(t * 0.36) * 0.006,
        rotation: Math.sin(t * 0.3) * 0.002,
      });
    }
    if (layout === "camera-dutch-drift-pro-vfx") {
      const unease = 0.5 + Math.sin(t * 0.86) * 0.5;
      return apply({
        zoom: 1.035 + eased * 0.065 + unease * 0.012,
        panX: lerp(0.026, -0.022, eased) + Math.sin(t * 0.42) * 0.014,
        panY: lerp(-0.02, 0.026, eased) + Math.cos(t * 0.38) * 0.012,
        rotation: lerp(-0.018, 0.018, eased) + Math.sin(t * 0.5) * 0.006,
      });
    }
    if (layout === "camera-vertical-scan-pro-vfx") {
      return apply({
        zoom: 1.11 + Math.sin(t * 0.34) * 0.006,
        panX: Math.sin(t * 0.24) * 0.008,
        panY: lerp(-0.16, 0.18, eased),
        rotation: 0,
      });
    }
    if (layout === "camera-crash-punch-in-pro-vfx") {
      const crash = Math.max(0, 1 - Math.min(progress / 0.14, 1));
      const recoil = Math.sin(Math.min(Math.max((progress - 0.08) / 0.42, 0), 1) * Math.PI);
      return apply({
        zoom: 1.06 + crash * 0.24 + recoil * 0.1,
        panX: Math.sin(t * 46) * crash * 0.02 + Math.sin(t * 16) * recoil * 0.01,
        panY: Math.cos(t * 43) * crash * 0.016 - recoil * 0.018,
        rotation: Math.sin(t * 48) * crash * 0.009,
      });
    }
    if (layout === "camera-hero-rise-pro-vfx") {
      const rise = easeInOutCubic(Math.min(progress, 1));
      return apply({
        zoom: 1.045 + rise * 0.12,
        panX: Math.sin(t * 0.32) * 0.008,
        panY: lerp(0.12, -0.055, rise) + Math.cos(t * 0.5) * 0.006,
        rotation: lerp(-0.008, 0.006, rise) + Math.sin(t * 0.4) * 0.002,
      });
    }
    if (layout === "camera-cliffhanger-drop-pro-vfx") {
      const drop = easeInOutCubic(Math.min(progress, 1));
      const hold = Math.max(0, Math.min((progress - 0.72) / 0.28, 1));
      return apply({
        zoom: 1.04 + drop * 0.095 + hold * 0.035,
        panX: Math.sin(t * 0.38) * 0.009 + Math.sin(t * 18) * hold * 0.006,
        panY: lerp(-0.12, 0.12, drop) + Math.cos(t * 14) * hold * 0.007,
        rotation: Math.sin(t * 0.45) * 0.004 + Math.sin(t * 12) * hold * 0.004,
      });
    }
    if (layout === "camera-floating-parallax-pro-vfx") {
      const float = 0.5 + Math.sin(t * 0.62) * 0.5;
      return apply({
        zoom: 1.025 + eased * 0.075 + float * 0.012,
        panX: lerp(-0.025, 0.025, eased) + Math.sin(t * 0.44) * 0.014,
        panY: lerp(0.018, -0.026, eased) + Math.cos(t * 0.4) * 0.014,
        rotation: Math.sin(t * 0.32) * 0.003,
      });
    }
    if (layout === "camera-noir-creep-pro-vfx") {
      return apply({
        zoom: 1.035 + eased * 0.08,
        panX: lerp(-0.055, 0.035, eased) + Math.sin(t * 0.26) * 0.006,
        panY: lerp(0.018, -0.018, eased) + Math.cos(t * 0.24) * 0.006,
        rotation: lerp(-0.006, 0.012, eased) + Math.sin(t * 0.2) * 0.002,
      });
    }
    if (layout === "camera-orbit-reveal-pro-vfx") {
      const orbit = Math.sin(Math.min(progress, 1) * Math.PI);
      return apply({
        zoom: 1.04 + eased * 0.085 + orbit * 0.025,
        panX: Math.cos(lerp(-1.4, 1.1, eased)) * 0.045,
        panY: Math.sin(lerp(-1.1, 1.2, eased)) * 0.035,
        rotation: lerp(-0.026, 0.026, eased),
      });
    }
    if (layout === "camera-page-glide-pro-vfx") {
      return apply({
        zoom: 1.14 + Math.sin(t * 0.28) * 0.004,
        panX: lerp(-0.1, 0.1, eased),
        panY: lerp(-0.08, 0.08, easeInOutCubic(Math.min(Math.max((progress - 0.08) / 0.84, 0), 1))),
        rotation: 0,
      });
    }
    if (layout === "camera-micro-shake-pro-vfx") {
      const nerve = 0.55 + Math.sin(t * 3.2) * 0.45;
      return apply({
        zoom: 1.05 + eased * 0.045 + nerve * 0.008,
        panX: Math.sin(t * 21) * 0.01 * nerve + Math.sin(t * 0.8) * 0.008,
        panY: Math.cos(t * 19) * 0.008 * nerve + Math.cos(t * 0.72) * 0.007,
        rotation: Math.sin(t * 17) * 0.004 * nerve,
      });
    }
    if (layout === "camera-romance-drift-pro-vfx") {
      const breath = 0.5 + Math.sin(t * 0.5) * 0.5;
      return apply({
        zoom: 1.02 + eased * 0.06 + breath * 0.008,
        panX: lerp(0.018, -0.018, eased) + Math.sin(t * 0.26) * 0.01,
        panY: lerp(0.02, -0.012, eased) + Math.cos(t * 0.24) * 0.01,
        rotation: Math.sin(t * 0.22) * 0.002,
      });
    }
    if (layout === "camera-horror-creep-zoom-pro-vfx") {
      const dread = 0.5 + Math.sin(t * 1.1) * 0.5;
      return apply({
        zoom: 1.035 + eased * 0.11 + dread * 0.012,
        panX: lerp(0.032, -0.026, eased) + Math.sin(t * 0.52) * 0.011,
        panY: lerp(-0.024, 0.026, eased) + Math.cos(t * 0.48) * 0.01,
        rotation: Math.sin(t * 0.45) * 0.005 + Math.sin(t * 8) * 0.0015,
      });
    }
    if (layout === "final-attack-trailer-card-pro-vfx") {
      const build = Math.sin(Math.min(progress / 0.86, 1) * Math.PI);
      const release = Math.max(0, 1 - Math.abs(progress - 0.78) * 8);
      return {
        zoom: 1.025 + eased * 0.11 + build * 0.035 + release * 0.09,
        panX: Math.sin(timeSeconds * 0.7) * 0.012 + Math.sin(timeSeconds * 22) * release * 0.014,
        panY: lerp(0.025, -0.045, eased) + Math.cos(timeSeconds * 20) * release * 0.012,
        rotation: Math.sin(timeSeconds * 0.55) * 0.004 + Math.sin(timeSeconds * 26) * release * 0.006,
      };
    }
    if (layout === "panel-smash-burst-pro-vfx") {
      const smash = Math.max(hit, Math.sin(Math.min(progress / 0.72, 1) * Math.PI) * 0.55);
      return {
        zoom: 1.045 + hit * 0.12 + smash * 0.05,
        panX: Math.sin(timeSeconds * 33) * hit * 0.018 + Math.sin(timeSeconds * 6) * smash * 0.006,
        panY: Math.cos(timeSeconds * 31) * hit * 0.014 + Math.cos(timeSeconds * 5.4) * smash * 0.007,
        rotation: Math.sin(timeSeconds * 36) * hit * 0.008 + Math.sin(progress * Math.PI * 2) * 0.006,
      };
    }
    if (layout === "ink-flash-impact-pro-vfx") {
      const snap = Math.max(0, 1 - Math.min(progress / 0.16, 1));
      const recoil = Math.max(0, Math.sin(Math.min(progress / 0.46, 1) * Math.PI));
      return {
        zoom: 1.045 + snap * 0.11 + recoil * 0.035,
        panX: Math.sin(timeSeconds * 34) * snap * 0.015 + Math.sin(timeSeconds * 5.2) * recoil * 0.006,
        panY: Math.cos(timeSeconds * 31) * snap * 0.012 - recoil * 0.012,
        rotation: Math.sin(timeSeconds * 38) * snap * 0.006 + Math.sin(timeSeconds * 4) * recoil * 0.003,
      };
    }
    if (layout === "afterimage-dash-pro-vfx") {
      const dash = Math.sin(Math.min(progress / 0.88, 1) * Math.PI);
      const whip = Math.sin(progress * Math.PI * 3.5) * Math.max(0, 1 - progress * 0.68);
      return {
        zoom: 1.035 + eased * 0.09 + dash * 0.035 + hit * 0.035,
        panX: lerp(-0.075, 0.085, eased) + Math.sin(timeSeconds * 18) * (0.006 + dash * 0.012) + whip * 0.018,
        panY: lerp(0.028, -0.02, eased) + Math.cos(timeSeconds * 14) * dash * 0.008,
        rotation: -0.006 + dash * 0.01 + Math.sin(timeSeconds * 20) * hit * 0.005,
      };
    }
    if (layout === "slash-energy-cut-pro-vfx" || layout === "slash-energy-pro-vfx") {
      return {
        zoom: 1.045 + eased * 0.08 + hit * 0.075,
        panX: lerp(-0.044, 0.034, eased) + Math.sin(timeSeconds * 15.5) * hit * 0.012,
        panY: lerp(0.03, -0.03, eased) + Math.cos(timeSeconds * 13.5) * hit * 0.009,
        rotation: -0.014 + Math.sin(timeSeconds * 18) * hit * 0.008,
      };
    }
    if (layout === "power-aura-burst-pro-vfx" || layout === "power-aura-pro-vfx") {
      const pulse = 0.5 + Math.sin(timeSeconds * 2.2) * 0.5;
      const charge = Math.sin(Math.min(progress / 0.82, 1) * Math.PI);
      return {
        zoom: 1.028 + eased * 0.066 + pulse * 0.018 + charge * 0.026,
        panX: Math.sin(timeSeconds * 0.72) * 0.016 + Math.sin(timeSeconds * 8.2) * charge * 0.006,
        panY: Math.cos(timeSeconds * 0.64) * 0.014 - charge * 0.016 + Math.cos(timeSeconds * 7.6) * charge * 0.005,
        rotation: Math.sin(timeSeconds * 0.5) * 0.004 + Math.sin(timeSeconds * 6.2) * charge * 0.0025,
      };
    }
    if (layout === "panel-zoom-pro-vfx") {
      return {
        zoom: 1.02 + eased * 0.14,
        panX: lerp(-0.018, 0.018, eased) + Math.sin(timeSeconds * 0.38) * 0.006,
        panY: lerp(0.026, -0.03, eased) + Math.cos(timeSeconds * 0.34) * 0.006,
        rotation: Math.sin(timeSeconds * 0.22) * 0.002,
      };
    }
    if (layout === "vertical-scroll-pro-vfx") {
      return {
        zoom: 1.08 + Math.sin(timeSeconds * 0.42) * 0.006,
        panX: Math.sin(timeSeconds * 0.28) * 0.008,
        panY: lerp(-0.18, 0.18, eased),
        rotation: 0,
      };
    }
    if (layout === "glitch-horror-pro-vfx") {
      const pulse = 0.5 + Math.sin(timeSeconds * 2.6) * 0.5;
      const snap = Math.max(0, Math.sin(timeSeconds * 8.4));
      return {
        zoom: 1.055 + eased * 0.055 + pulse * 0.012 + snap * 0.018,
        panX: Math.sin(timeSeconds * 2.8) * 0.012 * pulse + Math.sin(timeSeconds * 31) * 0.008 * snap,
        panY: Math.cos(timeSeconds * 2.4) * 0.01 * pulse + Math.cos(timeSeconds * 29) * 0.007 * snap,
        rotation: Math.sin(timeSeconds * 6.5) * 0.004 * pulse + Math.sin(timeSeconds * 23) * 0.004 * snap,
      };
    }
    if (layout === "petal-fall-pro-vfx") {
      return {
        zoom: 1.025 + eased * 0.055,
        panX: lerp(-0.018, 0.018, eased) + Math.sin(timeSeconds * 0.36) * 0.01,
        panY: lerp(-0.012, 0.022, eased) + Math.cos(timeSeconds * 0.32) * 0.008,
        rotation: Math.sin(timeSeconds * 0.28) * 0.0025,
      };
    }
    return {
      zoom: 1.025 + eased * 0.04 + Math.sin(timeSeconds * 1.2) * 0.01,
      panX: Math.sin(timeSeconds * 0.8) * 0.018,
      panY: Math.cos(timeSeconds * 0.72) * 0.014,
      rotation: Math.sin(timeSeconds * 0.6) * 0.004,
    };
  }

  speedImpactFocus(progress, timeSeconds) {
    return {
      x: PIXI_PREVIEW_SIZE.width * (0.53 + Math.sin(timeSeconds * 0.7) * 0.01),
      y: PIXI_PREVIEW_SIZE.height * (0.52 + Math.cos(timeSeconds * 0.5) * 0.008),
      rx: PIXI_PREVIEW_SIZE.width * (0.31 + Math.sin(progress * Math.PI) * 0.018),
      ry: PIXI_PREVIEW_SIZE.height * (0.28 + Math.sin(progress * Math.PI) * 0.016),
    };
  }

  drawTransition(textureA, textureB, transition, progress, timeSeconds, context = {}) {
    const layout = transition.layout || "";
    const type = transition.transitionType || "";
    if (layout === "page-flip-pro-vfx") {
      this.drawPageFlipProTransition(textureA, textureB, transition, progress, timeSeconds, context);
      return;
    }
    if (transition.id === "tr-glitch-tear" || layout === "glitch-tear") {
      this.drawGlitchTearProTransition(textureA, textureB, transition, progress, timeSeconds, context);
      return;
    }
    if (transition.id === "tr-vertical-scroll-cut" || layout === "vertical-scroll-cut") {
      this.drawVerticalScrollCutTransition(textureA, textureB, transition, progress, timeSeconds, context);
      return;
    }
    if (transition.id === "tr-speed-wipe" || layout === "speed-wipe") {
      this.drawSpeedWipeTransition(textureA, textureB, transition, progress, timeSeconds, context);
      return;
    }
    if (transition.id === "tr-impact-smash-cut" || layout === "impact-smash") {
      this.drawImpactSmashTransition(textureA, textureB, transition, progress, timeSeconds, context);
      return;
    }
    if (transition.id === "tr-slash-diagonal" || layout === "slash-diagonal") {
      this.drawSlashDiagonalTransition(textureA, textureB, transition, progress, timeSeconds, context);
      return;
    }
    if (transition.id === "tr-panel-slam" || layout === "sfx-card") {
      this.drawPanelSlamTransition(textureA, textureB, transition, progress, timeSeconds, context);
      return;
    }
    if (transition.id === "tr-hologram-scan-cut" || layout === "holo-scan-cut") {
      this.drawHologramScanTransition(textureA, textureB, transition, progress, timeSeconds, context);
      return;
    }
    if (transition.id === "tr-arcane-gate" || layout === "arcane-iris") {
      this.drawArcaneGateTransition(textureA, textureB, transition, progress, timeSeconds, context);
      return;
    }
    if (transition.id === "tr-dragon-fire-cut" || layout === "dragon-fire-cut") {
      this.drawDragonFireTransition(textureA, textureB, transition, progress, timeSeconds, context);
      return;
    }
    if (transition.id === "transition-style-24" || transition.layout === "neon-portal-wipe") {
      this.drawNeonPortalTransition(textureA, textureB, transition, progress, timeSeconds, context);
      return;
    }
    if (transition.id === "transition-style-47" || transition.layout === "trailer-split-cut") {
      this.drawTrailerSplitTransition(textureA, textureB, transition, progress, timeSeconds, context);
      return;
    }
    if (layout.includes("timelapse") || layout.includes("before-after") || layout.includes("cover-reveal") || type === "promo" || type === "cta") {
      this.drawPromoTransition(textureA, textureB, transition, progress, timeSeconds, context);
      return;
    }
    if (["ink", "dark", "blackout", "glitch"].includes(type) || ["ink", "shadow", "vhs", "blackout"].some((word) => layout.includes(word))) {
      this.drawDarkTransition(textureA, textureB, transition, progress, timeSeconds, context);
      return;
    }
    if (["sparkle", "petal", "dissolve", "fade"].includes(type) || ["sparkle", "petal", "dream", "bloom", "heart"].some((word) => layout.includes(word))) {
      this.drawSoftTransition(textureA, textureB, transition, progress, timeSeconds, context);
      return;
    }
    if (["page", "paper", "file", "shutter", "rain", "scroll"].includes(type) || ["page", "paper", "file", "rain", "scroll", "newspaper"].some((word) => layout.includes(word))) {
      this.drawPaperTransition(textureA, textureB, transition, progress, timeSeconds, context);
      return;
    }
    if (["bounce", "freeze", "shake", "sticker", "squash"].includes(type)) {
      this.drawPopTransition(textureA, textureB, transition, progress, timeSeconds, context);
      return;
    }
    const p = easeOutCubic(Math.min(progress / 0.72, 1));
    this.drawCoverSprite(textureA, this.root, { zoom: 1.08, panX: -p * 0.16 });

    const nextLayer = new this.pixi.Container();
    this.root.addChild(nextLayer);
    this.drawCoverSprite(textureB, nextLayer, this.transitionIncomingOptions({ zoom: 1.1, panX: 0.1 - p * 0.1 }, p, context));
    const mask = new this.pixi.Graphics();
    if (layout.includes("portal") || layout.includes("iris") || layout.includes("gate")) {
      mask.ellipse(PIXI_PREVIEW_SIZE.width / 2, PIXI_PREVIEW_SIZE.height * 0.48, 80 + p * 360, 120 + p * 420).fill(0xffffff);
      this.drawPortal(transition.accent, p, timeSeconds);
    } else if (layout.includes("slash")) {
      mask.moveTo(PIXI_PREVIEW_SIZE.width * (0.2 + p * 0.4), 0)
        .lineTo(PIXI_PREVIEW_SIZE.width, 0)
        .lineTo(PIXI_PREVIEW_SIZE.width, PIXI_PREVIEW_SIZE.height)
        .lineTo(PIXI_PREVIEW_SIZE.width * (p * 0.55), PIXI_PREVIEW_SIZE.height)
        .closePath()
        .fill(0xffffff);
      this.drawSlash(transition.accent, p);
    } else {
      mask.rect(0, 0, PIXI_PREVIEW_SIZE.width * p, PIXI_PREVIEW_SIZE.height).fill(0xffffff);
      this.drawWipeLine(PIXI_PREVIEW_SIZE.width * p, transition.accent);
    }
    nextLayer.mask = mask;
    this.root.addChild(mask);
    this.drawIncomingSettleFrame(textureB, p, context);
  }

  drawActiveEffect(effect, progress, timeSeconds, options = {}) {
    if ((options.transitionComposite || options.previewSafe) && !options.__compositeWrapped) {
      const previousRoot = this.root;
      const safeLayer = new this.pixi.Container();
      safeLayer.alpha = this.transitionCompositeEffectAlpha(effect);
      previousRoot.addChild(safeLayer);
      this.root = safeLayer;
      try {
        this.drawActiveEffect(effect, progress, timeSeconds, {
          ...options,
          __compositeWrapped: true,
        });
      } finally {
        this.root = previousRoot;
      }
      return;
    }

    const layout = effect.layout || "";
    const type = effect.effectType || "";
    const accent = effect.accent || "#ffffff";
    if (layout === "speed-impact-pro-vfx") this.drawMangaSpeedImpactProVfx(effect, progress, timeSeconds, options);
    else if (this.isCameraMotionOnlyEffect(effect)) {
      if (options.hasLayeredVisualEffect) return;
      this.drawCameraMotionOnlyProVfx(effect, progress, timeSeconds, options);
    }
    else if (this.isWebtoonManhwaEffect(effect)) this.drawWebtoonManhwaProVfx(effect, progress, timeSeconds, options);
    else if (this.isRomanceFantasyEffect(effect)) this.drawRomanceFantasyProVfx(effect, progress, timeSeconds, options);
    else if (this.isHorrorThrillerEffect(effect)) this.drawHorrorThrillerProVfx(effect, progress, timeSeconds, options);
    else if (layout === "panel-zoom-pro-vfx") this.drawPanelZoomProVfx(effect, progress, timeSeconds, options);
    else if (layout === "vertical-scroll-pro-vfx") this.drawVerticalScrollProVfx(effect, progress, timeSeconds, options);
    else if (layout === "glitch-horror-pro-vfx") this.drawGlitchHorrorProVfx(effect, progress, timeSeconds, options);
    else if (layout === "petal-fall-pro-vfx") this.drawPetalFallProVfx(effect, progress, timeSeconds, options);
    else if (layout === "manga-sfx-slam-pro-vfx") this.drawMangaSfxSlamProVfx(effect, progress, timeSeconds, options);
    else if (layout === "manga-burst-focus-frame-pro-vfx") this.drawMangaBurstFocusFrameProVfx(effect, progress, timeSeconds, options);
    else if (layout === "manga-halftone-burst-pro-vfx") this.drawMangaHalftoneBurstProVfx(effect, progress, timeSeconds, options);
    else if (layout === "eye-shock-zoom-pro-vfx") this.drawEyeShockZoomProVfx(effect, progress, timeSeconds, options);
    else if (layout === "afterimage-dash-pro-vfx") this.drawAfterimageDashProVfx(effect, progress, timeSeconds, options);
    else if (layout === "ink-flash-impact-pro-vfx") this.drawInkFlashImpactProVfx(effect, progress, timeSeconds, options);
    else if (layout === "panel-smash-burst-pro-vfx") this.drawPanelSmashBurstProVfx(effect, progress, timeSeconds, options);
    else if (layout === "final-attack-trailer-card-pro-vfx") this.drawFinalAttackTrailerCardProVfx(effect, progress, timeSeconds, options);
    else if (layout === "clash-spark-lock-pro-vfx") this.drawMangaActionSpecializedProVfx(effect, progress, timeSeconds, options, "clash");
    else if (layout === "ground-break-impact-pro-vfx") this.drawMangaActionSpecializedProVfx(effect, progress, timeSeconds, options, "ground");
    else if (layout === "projectile-barrage-rush-pro-vfx") this.drawMangaActionSpecializedProVfx(effect, progress, timeSeconds, options, "projectiles");
    else if (layout === "energy-beam-sweep-pro-vfx") this.drawMangaActionSpecializedProVfx(effect, progress, timeSeconds, options, "beam");
    else if (layout === "weapon-draw-glint-pro-vfx") this.drawMangaActionSpecializedProVfx(effect, progress, timeSeconds, options, "glint");
    else if (layout === "combo-hit-rhythm-pro-vfx") this.drawMangaActionSpecializedProVfx(effect, progress, timeSeconds, options, "combo");
    else if (layout === "shadow-clone-rush-pro-vfx") this.drawMangaActionSpecializedProVfx(effect, progress, timeSeconds, options, "clones");
    else if (layout === "battle-dust-wake-pro-vfx") this.drawMangaActionSpecializedProVfx(effect, progress, timeSeconds, options, "dust");
    else if (layout === "rage-pressure-lines-pro-vfx") this.drawMangaActionSpecializedProVfx(effect, progress, timeSeconds, options, "rage");
    else if (layout === "finisher-impact-frame-pro-vfx") this.drawMangaActionSpecializedProVfx(effect, progress, timeSeconds, options, "finisher");
    else if (layout === "impact-freeze-punch-pro-vfx") this.drawImpactFreezePunchProVfx(effect, progress, timeSeconds, options);
    else if (layout === "impact-zoom-pro-vfx") this.drawImpactZoomProVfx(effect, progress, timeSeconds, options);
    else if (layout === "slash-energy-cut-pro-vfx") this.drawSlashEnergyCutProVfx(effect, progress, timeSeconds, options);
    else if (layout === "slash-energy-pro-vfx") this.drawSlashEnergyProVfx(effect, progress, timeSeconds, options);
    else if (layout === "power-aura-burst-pro-vfx") this.drawPowerAuraBurstProVfx(effect, progress, timeSeconds, options);
    else if (layout === "power-aura-pro-vfx") this.drawPowerAuraProVfx(effect, progress, timeSeconds, options);
    else if (layout === "hero-halftone-pro-vfx") this.drawHeroHalftoneProVfx(effect, progress, timeSeconds, options);
    else if (layout === "soft-glow-pro-vfx") this.drawRomanceSoftGlowProVfx(effect, progress, timeSeconds, options);
    else if (layout === "dark-pulse-pro-vfx") this.drawHorrorDarkPulseProVfx(effect, progress, timeSeconds, options);
    else if (effect.id === "effect-style-03" || layout === "slash-aura") this.drawSlashEnergyOverlay(effect, progress, timeSeconds, options);
    else if (effect.id === "effect-style-23" || layout === "data-hud") this.drawProfessionalHud(effect, progress, timeSeconds, options);
    else if (effect.id === "fx-jumpscare-snap" || layout === "jumpscare-zoom") this.drawJumpscareSnapEffect(effect, progress, timeSeconds, options);
    else if (["speed-impact", "impact-zoom", "power-burst", "sfx-slam", "page-impact"].includes(layout) || ["impact", "sfx"].includes(type)) this.drawMangaImpactEffect(effect, progress, timeSeconds, options);
    else if (layout.includes("slash")) this.drawSlash(accent, progress);
    else if (["kirby-burst", "halftone-pop", "comic-flash", "hero-slam"].includes(layout) || ["texture", "flash", "panel"].includes(type)) this.drawComicTextureEffect(effect, progress, timeSeconds);
    else if (["ink-bleed", "vhs-horror", "shadow-creep", "jumpscare-zoom"].includes(layout) || ["glitch", "mood"].includes(type)) this.drawHorrorEffect(effect, progress, timeSeconds, options);
    else if (layout.includes("portal") || layout.includes("rune") || layout.includes("arcane") || ["magic", "scan", "hud"].includes(type)) this.drawSciMagicEffect(effect, progress, timeSeconds, options);
    else if (layout.includes("hud") || layout.includes("holo") || layout.includes("data")) this.drawHud(accent, timeSeconds);
    else if (["petal-drift", "sparkle-drift", "soft-bloom", "heart-pulse", "dream-blur"].includes(layout) || ["particles", "pulse"].includes(type)) this.drawRomanceEffect(effect, progress, timeSeconds, options);
    else if (["fire-overlay", "magic-dust", "scroll-unfold"].includes(layout)) this.drawFantasyEffect(effect, progress, timeSeconds, options);
    else if (["rain-glass", "case-file", "newspaper-texture", "noir-grain", "flashbulb"].includes(layout)) this.drawNoirEffect(effect, progress, timeSeconds);
    else if (["vertical-scroll", "panel-breath", "emotional-hold", "silence-hold", "cliffhanger-drop"].includes(layout) || ["scroll", "freeze"].includes(type)) this.drawReadingEffect(effect, progress, timeSeconds);
    else if (["bounce-pop", "freeze-reaction", "tiny-shake", "sticker-pop", "squash-bounce"].includes(layout) || ["bounce", "shake", "pop"].includes(type)) this.drawComedyEffect(effect, progress, timeSeconds, options);
    else if (["cover-reveal", "chapter-teaser", "before-after", "creator-timelapse", "final-cta-slam"].includes(layout) || ["promo", "cta"].includes(type)) this.drawPromoEffect(effect, progress, timeSeconds, options);
    else this.drawImpactBurst(accent, progress, timeSeconds);
  }

  transitionCompositeEffectAlpha(effect = {}) {
    const layout = effect.layout || "";
    const type = effect.effectType || "";
    const requested = Number(effect.parameters?.transitionCompositeAlpha ?? effect.transitionCompositeAlpha);
    if (Number.isFinite(requested)) return Math.min(0.82, Math.max(0.18, requested));
    if (this.isCameraMotionOnlyEffect(effect)) return 0.54;
    if (["dark", "blackout", "glitch", "mood"].includes(type) || ["shadow", "blackout", "dark", "vhs", "horror", "jumpscare", "ink"].some((word) => layout.includes(word))) return 0.42;
    if (["impact", "sfx", "flash"].includes(type) || ["impact", "slam", "burst", "smash", "slash"].some((word) => layout.includes(word))) return 0.58;
    return 0.68;
  }

  drawTextStyle(textStyle, progress, timeSeconds) {
    const accent = textStyle.accent || "#55f0c8";
    const layout = textStyle.layout || "";
    if (textStyle.id === "tx-hook-clean-caption") {
      this.drawShowcaseCleanHookCaption(textStyle, progress, timeSeconds);
      return;
    }
    if (textStyle.id === "tx-manga-impact-sfx") {
      this.drawShowcaseMangaImpactSfx(textStyle, progress, timeSeconds);
      return;
    }
    if (textStyle.id === "tx-manga-dokan-explosion-sfx") {
      this.drawShowcaseDokanExplosionSfx(textStyle, progress, timeSeconds);
      return;
    }
    const mangaActionTextVariant = {
      "tx-manga-slash-katakana-cut": "slash",
      "tx-manga-speedline-shout-banner": "speed-banner",
      "tx-manga-combo-rush-type": "combo",
      "tx-manga-power-up-aura-title": "power",
      "tx-manga-rage-burst-word": "rage",
      "tx-manga-rival-nameplate": "nameplate",
      "tx-manga-final-attack-intertitle": "intertitle",
      "tx-manga-dododo-pressure": "pressure",
    }[textStyle.id];
    if (mangaActionTextVariant) {
      this.drawShowcaseMangaActionText(textStyle, progress, timeSeconds, mangaActionTextVariant);
      return;
    }
    const webtoonTextVariant = {
      "tx-webtoon-vertical-scroll-caption": "scroll-caption",
      "tx-webtoon-episode-drop-card": "episode-card",
      "tx-webtoon-cliffhanger-line": "cliffhanger",
      "tx-webtoon-floating-thought-card": "thought",
      "tx-webtoon-drama-eye-caption": "drama-eye",
      "tx-webtoon-tap-read-cta": "read-cta",
      "tx-webtoon-soft-reveal-label": "soft-reveal",
      "tx-webtoon-floating-panel-title": "floating-title",
      "tx-webtoon-phone-first-hook": "phone-hook",
      "tx-webtoon-long-page-narration-strip": "narration-strip",
    }[textStyle.id];
    if (webtoonTextVariant) {
      this.drawShowcaseWebtoonText(textStyle, progress, timeSeconds, webtoonTextVariant);
      return;
    }
    const romanceFantasyTextVariant = {
      "tx-romance-confession-whisper": "confession",
      "tx-romance-heart-glow-nameplate": "nameplate",
      "tx-romance-moonlit-letter-card": "moon-card",
      "tx-romance-sparkle-reveal-title": "sparkle-title",
      "tx-romance-butterfly-dream-caption": "butterfly-dream",
      "tx-romance-rose-drama-stamp": "rose-stamp",
      "tx-romance-soft-magic-lore": "magic-lore",
      "tx-romance-wedding-promise-card": "promise-card",
      "tx-romance-blush-pop-label": "blush-pop",
      "tx-romance-letter-card": "classic-letter",
    }[textStyle.id];
    if (romanceFantasyTextVariant) {
      this.drawShowcaseRomanceFantasyText(textStyle, progress, timeSeconds, romanceFantasyTextVariant);
      return;
    }
    const horrorThrillerTextVariant = {
      "tx-horror-cursed-page-warning": "cursed-warning",
      "tx-horror-blood-red-stamp": "blood-stamp",
      "tx-horror-crime-scene-caption": "crime-caption",
      "tx-horror-flicker-threat-text": "flicker-threat",
      "tx-horror-jumpscare-word": "jumpscare",
      "tx-horror-redacted-secret-note": "redacted-note",
      "tx-horror-shadow-door-title": "shadow-title",
      "tx-horror-typewriter-dread-caption": "typewriter",
      "tx-horror-siren-alert-label": "siren-alert",
      "tx-horror-ink-warning": "ink-warning",
    }[textStyle.id];
    if (horrorThrillerTextVariant) {
      this.drawShowcaseHorrorThrillerText(textStyle, progress, timeSeconds, horrorThrillerTextVariant);
      return;
    }
    const scifiTechTextVariant = {
      "tx-scifi-tactical-scan-caption": "tactical-scan",
      "tx-scifi-hologram-nameplate": "hologram-nameplate",
      "tx-scifi-system-breach-title": "system-breach",
      "tx-scifi-data-fragment-card": "data-fragment",
      "tx-scifi-mecha-launch-banner": "mecha-launch",
      "tx-scifi-neon-city-hook": "neon-hook",
      "tx-scifi-ai-diagnosis-note": "ai-diagnosis",
      "tx-scifi-chrome-episode-card": "chrome-card",
      "tx-scifi-signal-lost-caption": "signal-lost",
      "tx-scifi-hud-caption": "classic-hud",
    }[textStyle.id];
    if (scifiTechTextVariant) {
      this.drawShowcaseScifiTechText(textStyle, progress, timeSeconds, scifiTechTextVariant);
      return;
    }
    const comicSuperheroTextVariant = {
      "tx-superhero-hero-pop-sfx": "hero-pop",
      "tx-superhero-halftone-title-card": "halftone-title",
      "tx-superhero-villain-nameplate": "villain-nameplate",
      "tx-superhero-lightning-callout": "lightning-callout",
      "tx-superhero-cover-blurb-caption": "cover-blurb",
      "tx-superhero-team-up-banner": "team-up",
      "tx-superhero-power-stat-label": "power-stat",
      "tx-superhero-retro-print-stamp": "retro-stamp",
      "tx-superhero-action-narration-box": "action-narration",
      "tx-superhero-final-panel-promise": "final-promise",
    }[textStyle.id];
    if (comicSuperheroTextVariant) {
      this.drawShowcaseComicSuperheroText(textStyle, progress, timeSeconds, comicSuperheroTextVariant);
      return;
    }
    const noirMysteryTextVariant = {
      "tx-noir-case-file-caption": "case-file",
      "tx-noir-newspaper-headline": "newspaper",
      "tx-noir-suspect-nameplate": "suspect",
      "tx-noir-rainy-monologue-box": "monologue",
      "tx-noir-clue-circle-label": "clue",
      "tx-noir-flashbulb-stamp": "flashbulb",
      "tx-noir-pulp-chapter-card": "pulp-card",
      "tx-noir-classified-note": "classified",
      "tx-noir-detective-cta": "detective-cta",
      "tx-noir-shadow-location-title": "location-title",
    }[textStyle.id];
    if (noirMysteryTextVariant) {
      this.drawShowcaseNoirMysteryText(textStyle, progress, timeSeconds, noirMysteryTextVariant);
      return;
    }
    const promoSocialTextVariant = {
      "tx-promo-release-banner": "release-banner",
      "tx-promo-cover-reveal-title": "cover-reveal",
      "tx-promo-limited-stamp": "limited-stamp",
      "tx-promo-creator-hook-caption": "creator-hook",
      "tx-promo-shop-cta-card": "shop-cta",
      "tx-promo-countdown-card": "countdown",
      "tx-promo-review-quote-card": "review-quote",
      "tx-promo-series-label": "series-label",
      "tx-promo-social-comment-card": "comment-card",
    }[textStyle.id];
    if (promoSocialTextVariant) {
      this.drawShowcasePromoSocialText(textStyle, progress, timeSeconds, promoSocialTextVariant);
      return;
    }
    if (textStyle.id === "tx-horror-ink-warning") {
      this.drawShowcaseHorrorInkWarning(textStyle, progress, timeSeconds);
      return;
    }
    if (textStyle.id === "tx-scifi-hud-caption") {
      this.drawShowcaseScifiHudCaption(textStyle, progress, timeSeconds);
      return;
    }
    if (textStyle.id === "txt-clean-hook-caption") {
      this.drawCleanHookCaption(textStyle, progress, timeSeconds);
      return;
    }
    if (textStyle.id === "txt-final-cta") {
      this.drawFinalCtaText(textStyle, progress, timeSeconds);
      return;
    }
    if (textStyle.id === "text-style-15" || textStyle.layout === "red-side") {
      this.drawRedSideText(textStyle, progress, timeSeconds);
      return;
    }
    if (["black-star", "white-star", "speed-title", "sfx-vertical"].includes(layout)) this.drawSfxText(textStyle, progress, timeSeconds);
    else if (["fantasy-scroll", "spell-circle", "relic-seal", "cosmic-ring", "occult-seal"].includes(layout)) this.drawMagicText(textStyle, progress, timeSeconds);
    else if (["terminal", "holo-panel", "mecha-hud", "data-chip", "glitch", "neon-grid", "chrome-title", "synthwave"].includes(layout)) this.drawFutureText(textStyle, progress, timeSeconds);
    else if (["horror-ink", "blood-scratch", "cursed-note", "black-star"].includes(layout)) this.drawHorrorText(textStyle, progress, timeSeconds);
    else if (["shojo", "love-letter", "heart-pop", "rose-drama", "soft-whisper"].includes(layout)) this.drawRomanceText(textStyle, progress, timeSeconds);
    else if (["file", "newspaper", "wanted", "paper", "seinen-caption"].includes(layout)) this.drawDossierText(textStyle, progress, timeSeconds);
    else if (["lower-third", "chat-card", "pixel", "cute-pop"].includes(layout)) this.drawSocialText(textStyle, progress, timeSeconds);
    else if (["dragon-card", "enchanted-card"].includes(layout)) this.drawFantasyCardText(textStyle, progress, timeSeconds);
    else this.drawCaption(textStyle.text || textStyle.title || "NEW CHAPTER", textStyle);
  }

  textSizeScale(textStyle = {}) {
    return {
      small: 0.82,
      medium: 1,
      large: 1.18,
    }[textStyle.size] || 1;
  }

  textAnchorY(textStyle = {}, fallbackRatio = 0.5) {
    const position = textStyle.position || "";
    if (position.includes("top")) return PIXI_PREVIEW_SIZE.height * 0.24;
    if (position.includes("center")) return PIXI_PREVIEW_SIZE.height * 0.5;
    if (position.includes("bottom")) return PIXI_PREVIEW_SIZE.height * 0.76;

    return PIXI_PREVIEW_SIZE.height * fallbackRatio;
  }

  textBlockY(textStyle = {}, blockHeight = 160, fallbackY = PIXI_PREVIEW_SIZE.height * 0.36) {
    const position = textStyle.position || "";
    if (position.includes("top")) return 148;
    if (position.includes("center")) return PIXI_PREVIEW_SIZE.height * 0.5 - blockHeight / 2;
    if (position.includes("bottom")) return PIXI_PREVIEW_SIZE.height - blockHeight - 166;

    return fallbackY;
  }

  drawCaption(text, textStyle = {}) {
    const graphics = new this.pixi.Graphics();
    const x = 76;
    const scale = this.textSizeScale(textStyle);
    const width = PIXI_PREVIEW_SIZE.width - 152;
    const height = textStyle.height ?? Math.round(132 * scale);
    const y = textStyle.y ?? this.textBlockY(textStyle, height, PIXI_PREVIEW_SIZE.height * 0.36);
    graphics.roundRect(x, y, width, height, 10)
      .fill({ color: parsePixiColor(textStyle.fill || "#fff7df"), alpha: 0.92 })
      .stroke({ color: 0xffffff, width: 2, alpha: 0.16 });
    graphics.rect(x + 34, y + height - 18, width - 68, 3)
      .fill({ color: parsePixiColor(textStyle.accent || "#e44d35"), alpha: 0.24 });
    this.root.addChild(graphics);

    const label = new this.pixi.Text({
      text: String(text).toUpperCase().slice(0, 42),
      style: {
        fontFamily: textStyle.font === "clean" ? "Inter, system-ui" : "Space Grotesk, Impact, system-ui",
        fontSize: Math.round(34 * scale),
        fontWeight: "900",
        fill: textStyle.ink || "#111111",
        align: "center",
        wordWrap: true,
        wordWrapWidth: width - 70,
        lineHeight: Math.round(38 * scale),
      },
    });
    label.anchor.set(0.5);
    label.x = PIXI_PREVIEW_SIZE.width / 2;
    label.y = y + height / 2 - 2;
    this.root.addChild(label);
  }

  drawRibbonText(text, y, accent, progress = 1) {
    const p = easeOutCubic(progress);
    const accentColor = parsePixiColor(accent || "#e44d35");
    const graphics = new this.pixi.Graphics();
    graphics.moveTo(44, y + 14)
      .lineTo(PIXI_PREVIEW_SIZE.width - 36, y - 4)
      .lineTo(PIXI_PREVIEW_SIZE.width - 54, y + 86)
      .lineTo(36, y + 104)
      .closePath()
      .fill({ color: 0x05070d, alpha: 0.76 + p * 0.08 })
      .stroke({ color: 0xffffff, width: 2, alpha: 0.16 });
    graphics.moveTo(84, y + 88)
      .lineTo(PIXI_PREVIEW_SIZE.width - 88, y + 74)
      .stroke({ color: accentColor, width: 3, alpha: 0.2 });
    graphics.scale.x = 0.94 + p * 0.06;
    graphics.pivot.x = PIXI_PREVIEW_SIZE.width / 2;
    graphics.x = PIXI_PREVIEW_SIZE.width / 2;
    this.root.addChild(graphics);
    const label = new this.pixi.Text({
      text: String(text).toUpperCase(),
      style: {
        fontFamily: "Space Grotesk, Impact, system-ui",
        fontSize: 42,
        fontWeight: "900",
        fill: "#ffffff",
        stroke: { color: "#050509", width: 5 },
        align: "center",
        wordWrap: true,
        wordWrapWidth: PIXI_PREVIEW_SIZE.width - 168,
      },
    });
    label.anchor.set(0.5);
    label.x = PIXI_PREVIEW_SIZE.width / 2;
    label.y = y + 48;
    this.root.addChild(label);
  }

  drawSfxWord(text, x, y, accent, progress = 1, scale = 1) {
    const p = easeOutCubic(Math.min(progress / 0.35, 1));
    const label = new this.pixi.Text({
      text: String(text).toUpperCase(),
      style: {
        fontFamily: "Space Grotesk, Impact, system-ui",
        fontSize: 78 * scale,
        fontWeight: "900",
        fill: "#ffffff",
        stroke: { color: parsePixiColor(accent || "#e44d35"), width: 10 },
        align: "center",
        wordWrap: true,
        wordWrapWidth: 500,
      },
    });
    label.anchor.set(0.5);
    label.x = x;
    label.y = y;
    label.rotation = -0.08 + Math.sin(progress * Math.PI) * 0.04;
    label.scale.set(0.7 + p * 0.3);
    this.root.addChild(label);
  }

  drawCleanHookCaption(textStyle, progress, timeSeconds) {
    const p = easeOutCubic(Math.min(progress / 0.28, 1));
    const accent = textStyle.accent || "#55f0c8";
    const x = 58;
    const y = PIXI_PREVIEW_SIZE.height - 350;
    const width = PIXI_PREVIEW_SIZE.width - 116;
    const height = 132;
    const slide = (1 - p) * 46;

    const panel = new this.pixi.Graphics();
    panel.roundRect(x, y + slide, width, height, 12)
      .fill({ color: 0x05070d, alpha: 0.78 })
      .stroke({ color: 0xffffff, width: 2, alpha: 0.18 });
    panel.rect(x, y + slide + 18, 4, height - 36).fill({ color: parsePixiColor(accent), alpha: 0.28 });
    panel.rect(x + 24, y + slide + height - 18, width - 48, 2).fill({ color: parsePixiColor(accent), alpha: 0.18 });
    this.root.addChild(panel);

    const kicker = new this.pixi.Text({
      text: "HOOK",
      style: {
        fontFamily: "Inter, system-ui",
        fontSize: 15,
        fontWeight: "900",
        fill: accent,
        letterSpacing: 0,
      },
    });
    kicker.x = x + 32;
    kicker.y = y + slide + 18;
    this.root.addChild(kicker);

    const label = new this.pixi.Text({
      text: String(textStyle.text || textStyle.title || "READ THE NEXT PANEL").toUpperCase().slice(0, 46),
      style: {
        fontFamily: "Inter, system-ui",
        fontSize: 32,
        fontWeight: "900",
        fill: textStyle.ink || "#f8f6ff",
        wordWrap: true,
        wordWrapWidth: width - 64,
        lineHeight: 36,
      },
    });
    label.x = x + 32;
    label.y = y + slide + 44;
    label.alpha = 0.78 + p * 0.22;
    this.root.addChild(label);

    const pulse = 0.5 + Math.sin(timeSeconds * 4.4) * 0.5;
    const marker = new this.pixi.Graphics();
    marker.circle(x + width - 34, y + slide + 34, 6 + pulse * 2).fill({ color: parsePixiColor(accent), alpha: 0.2 });
    this.root.addChild(marker);
  }

  drawShowcaseCleanHookCaption(textStyle, progress, timeSeconds) {
    const intro = easeOutCubic(Math.min(progress / 0.24, 1));
    const hold = Math.sin(timeSeconds * 2.2) * 0.5 + 0.5;
    const accent = textStyle.accent || "#55f0c8";
    const accentColor = parsePixiColor(accent);
    const text = String(textStyle.text || textStyle.title || "READ THIS PANEL FIRST").toUpperCase().slice(0, 74);
    const scale = this.textSizeScale(textStyle);
    const x = 52;
    const height = Math.round(170 * scale);
    const y = this.textBlockY(textStyle, height, PIXI_PREVIEW_SIZE.height - 336) + (1 - intro) * 56;
    const width = PIXI_PREVIEW_SIZE.width - 104;

    const shade = new this.pixi.Graphics();
    shade.rect(0, Math.max(0, y - 94), PIXI_PREVIEW_SIZE.width, Math.min(PIXI_PREVIEW_SIZE.height, height + 260))
      .fill({ color: 0x02040a, alpha: 0.34 });
    this.root.addChild(shade);

    const glow = new this.pixi.Graphics();
    glow.roundRect(x - 10, y - 10, width + 20, height + 20, 18)
      .fill({ color: accentColor, alpha: 0.08 + hold * 0.035 });
    this.root.addChild(glow);

    const card = new this.pixi.Graphics();
    card.roundRect(x, y, width, height, 14)
      .fill({ color: 0x05070d, alpha: 0.86 })
      .stroke({ color: 0xffffff, width: 2, alpha: 0.16 });
    card.rect(x, y, 12, height).fill({ color: accentColor, alpha: 0.96 });
    card.rect(x + 34, y + height - 24, (width - 68) * (0.66 + hold * 0.2), 4)
      .fill({ color: accentColor, alpha: 0.46 });
    this.root.addChild(card);

    const kicker = new this.pixi.Text({
      text: "CREATOR HOOK",
      style: {
        fontFamily: "Inter, system-ui",
        fontSize: Math.round(15 * scale),
        fontWeight: "900",
        fill: accent,
        letterSpacing: 0,
      },
    });
    kicker.x = x + 34;
    kicker.y = y + 22;
    kicker.alpha = intro;
    this.root.addChild(kicker);

    const label = new this.pixi.Text({
      text,
      style: {
        fontFamily: "Inter, system-ui",
        fontSize: Math.round(36 * scale),
        fontWeight: "950",
        fill: textStyle.ink || "#f8f6ff",
        wordWrap: true,
        wordWrapWidth: width - 74,
        lineHeight: Math.round(40 * scale),
        align: "left",
      },
    });
    label.x = x + 34;
    label.y = y + 58;
    label.alpha = 0.86 + intro * 0.14;
    this.root.addChild(label);

    const pin = new this.pixi.Graphics();
    pin.circle(x + width - 38, y + 36, 11 + hold * 2).fill({ color: accentColor, alpha: 0.72 });
    pin.circle(x + width - 38, y + 36, 24 + hold * 12).stroke({ color: accentColor, width: 2, alpha: 0.22 * (1 - hold) });
    this.root.addChild(pin);
  }

  drawShowcaseMangaImpactSfx(textStyle, progress, timeSeconds) {
    const intro = easeOutBack(Math.min(progress / 0.26, 1));
    const hit = Math.max(0, 1 - progress / 0.42);
    const accent = textStyle.accent || "#ffd84d";
    const accentColor = parsePixiColor(accent);
    const text = String(textStyle.text || textStyle.title || "BAM!").toUpperCase().slice(0, 10);
    const sizeScale = this.textSizeScale(textStyle);
    const cx = PIXI_PREVIEW_SIZE.width * 0.5 + Math.sin(timeSeconds * 28) * hit * 8;
    const cy = this.textAnchorY(textStyle, 0.39) + Math.cos(timeSeconds * 24) * hit * 7;

    const speed = new this.pixi.Graphics();
    for (let i = 0; i < 22; i += 1) {
      const y = 120 + i * 34 + Math.sin(timeSeconds * 3 + i) * 10;
      const x = -80 + (i % 5) * 35;
      speed.moveTo(x, y)
        .lineTo(PIXI_PREVIEW_SIZE.width + 90, y - 108 - (i % 4) * 22)
        .stroke({ color: i % 4 === 0 ? 0xffffff : 0x050509, width: i % 4 === 0 ? 2 : 4, alpha: 0.1 + hit * 0.08 });
    }
    this.root.addChild(speed);

    const rotation = -0.14 + Math.sin(timeSeconds * 2.8) * 0.008;
    const burstPoints = (ox = 0, oy = 0, outer = 232, inner = 142) => {
      const points = [];
      const spikes = 16;
      for (let i = 0; i < spikes * 2; i += 1) {
        const angle = rotation - Math.PI / 2 + (i / (spikes * 2)) * Math.PI * 2;
        const radius = (i % 2 === 0 ? outer : inner) * intro * sizeScale;
        points.push([cx + ox + Math.cos(angle) * radius, cy + oy + Math.sin(angle) * radius]);
      }
      return points;
    };
    const drawBurst = (graphics, points, fill, alpha, strokeColor, strokeWidth, strokeAlpha = 0.9) => {
      points.forEach(([x, y], index) => {
        if (index === 0) graphics.moveTo(x, y);
        else graphics.lineTo(x, y);
      });
      graphics.closePath()
        .fill({ color: fill, alpha })
        .stroke({ color: strokeColor, width: strokeWidth, alpha: strokeAlpha });
    };

    const burstShadow = new this.pixi.Graphics();
    drawBurst(burstShadow, burstPoints(14, 16, 236, 145), 0x050509, 0.66, 0x050509, 8, 0.82);
    this.root.addChild(burstShadow);

    const burstWhiteStroke = new this.pixi.Graphics();
    drawBurst(burstWhiteStroke, burstPoints(0, 0, 235, 144), 0xffffff, 0.9, 0x050509, 5, 0.72);
    this.root.addChild(burstWhiteStroke);

    const burst = new this.pixi.Graphics();
    drawBurst(burst, burstPoints(0, 0, 215, 132), accentColor, 0.92, 0x050509, 8, 0.9);
    this.root.addChild(burst);

    const highlight = new this.pixi.Graphics();
    highlight.ellipse(cx - 28, cy - 26, 94 * intro, 56 * intro)
      .fill({ color: 0xfff7bd, alpha: 0.16 });
    highlight.rotation = rotation;
    this.root.addChild(highlight);

    const shadow = new this.pixi.Text({
      text,
      style: {
        fontFamily: "Luckiest Guy, Bangers, Impact, system-ui",
        fontSize: Math.round((text.length <= 4 ? 128 : 94) * sizeScale),
        fontWeight: "900",
        fill: "#050509",
        stroke: { color: "#050509", width: 18 },
        align: "center",
      },
    });
    shadow.anchor.set(0.5);
    shadow.x = cx + 16;
    shadow.y = cy + 18;
    shadow.rotation = -0.12;
    shadow.scale.set(0.64 + intro * 0.36);
    this.root.addChild(shadow);

    const label = new this.pixi.Text({
      text,
      style: {
        fontFamily: "Luckiest Guy, Bangers, Impact, system-ui",
        fontSize: Math.round((text.length <= 4 ? 128 : 94) * sizeScale),
        fontWeight: "900",
        fill: "#ffffff",
        stroke: { color: "#050509", width: 13 },
        align: "center",
      },
    });
    label.anchor.set(0.5);
    label.x = cx;
    label.y = cy;
    label.rotation = -0.12 + Math.sin(timeSeconds * 18) * hit * 0.02;
    label.scale.set(0.62 + intro * 0.38 + hit * 0.08);
    this.root.addChild(label);
  }

  drawShowcaseDokanExplosionSfx(textStyle, progress, timeSeconds) {
    const intro = easeOutBack(Math.min(progress / 0.34, 1));
    const settle = easeOutCubic(Math.min(progress / 0.72, 1));
    const hit = Math.max(0, 1 - progress / 0.26);
    const pulse = Math.sin(timeSeconds * 7.4) * 0.5 + 0.5;
    const accent = textStyle.accent || "#ffd84d";
    const accentColor = parsePixiColor(accent);
    const text = String(textStyle.text || textStyle.title || "DOKAN!").toUpperCase().slice(0, 12);
    const sizeScale = this.textSizeScale(textStyle);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const cx = w * 0.54 + Math.sin(timeSeconds * 31) * hit * 9;
    const cy = this.textAnchorY(textStyle, 0.55) + Math.cos(timeSeconds * 29) * hit * 7;
    const blastX = w * 0.3;
    const blastY = h * 0.72;

    const shade = new this.pixi.Graphics();
    shade.rect(0, 0, w, h).fill({ color: 0x050509, alpha: 0.12 + hit * 0.04 });
    shade.rect(0, 0, w, h).stroke({ color: 0x050509, width: 46, alpha: 0.09 });
    this.root.addChild(shade);

    const rayLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.44 });
    const rays = new this.pixi.Graphics();
    for (let i = 0; i < 20; i += 1) {
      const angle = -Math.PI * 0.98 + (i / 19) * Math.PI * 1.34 + Math.sin(timeSeconds * 0.8 + i) * 0.012;
      const inner = 34 + (i % 3) * 18;
      const outer = 300 + (i % 5) * 24 + hit * 28;
      const width = i % 4 === 0 ? 5 : i % 3 === 0 ? 3.5 : 2;
      const color = i % 5 === 0 ? 0xffffff : accentColor;
      rays.moveTo(blastX + Math.cos(angle) * inner, blastY + Math.sin(angle) * inner)
        .lineTo(blastX + Math.cos(angle) * outer, blastY + Math.sin(angle) * outer)
        .stroke({ color, width, alpha: 0.04 + intro * 0.075 });
    }
    const bloom = this.createExternalBloomFilter({ threshold: 0.18, bloomScale: 0.24, brightness: 1.03, blur: 6, quality: 2 });
    const rayBlur = this.createBlurFilter(0.7, 2);
    rayLayer.filters = [bloom, rayBlur].filter(Boolean);
    rayLayer.addChild(rays);

    const plume = new this.pixi.Graphics();
    for (let i = 0; i < 16; i += 1) {
      const t = i / 15;
      const spread = Math.sin(t * Math.PI);
      const x = blastX - 120 + t * 430 + Math.sin(i * 2.3 + timeSeconds) * 10;
      const y = blastY - 18 - spread * (118 + hit * 28) + Math.cos(i * 1.7) * 18;
      const rx = (28 + (i % 5) * 13 + spread * 24) * intro;
      const ry = (16 + (i % 4) * 8 + spread * 12) * intro;
      const color = i % 4 === 0 ? 0xffffff : i % 3 === 0 ? accentColor : 0x1d1405;
      const alpha = i % 4 === 0 ? 0.11 : i % 3 === 0 ? 0.15 : 0.22;
      plume.ellipse(x, y, rx, ry).fill({ color, alpha: alpha * (0.58 + settle * 0.28) });
    }
    plume.ellipse(blastX, blastY, 118 * intro, 56 * intro).fill({ color: accentColor, alpha: 0.17 });
    plume.ellipse(blastX - 22, blastY - 10, 58 * intro, 28 * intro).fill({ color: 0xffffff, alpha: 0.15 });
    plume.filters = [this.createBlurFilter(1.9, 3)].filter(Boolean);
    this.root.addChild(plume);

    const ink = new this.pixi.Graphics();
    const splatters = 16;
    for (let i = 0; i < splatters; i += 1) {
      const angle = -Math.PI * 0.92 + (i / splatters) * Math.PI * 1.55;
      const dist = 95 + (i % 7) * 34 + Math.sin(i * 4.1) * 18;
      const x = blastX + Math.cos(angle) * dist;
      const y = blastY + Math.sin(angle) * dist;
      const size = 4 + (i % 5) * 3;
      ink.circle(x, y, size * intro).fill({ color: 0x050509, alpha: 0.08 + (i % 3) * 0.025 });
      if (i % 4 === 0) {
        ink.moveTo(x, y)
          .lineTo(x + Math.cos(angle) * (38 + i), y + Math.sin(angle) * (38 + i))
          .stroke({ color: 0x050509, width: 1.4 + (i % 3) * 0.8, alpha: 0.12 });
      }
    }
    this.root.addChild(ink);

    const shard = new this.pixi.Graphics();
    for (let i = 0; i < 10; i += 1) {
      const angle = -Math.PI * 0.85 + (i / 9) * Math.PI * 1.45;
      const dist = 168 + (i % 4) * 42 + hit * 20;
      const x = blastX + Math.cos(angle) * dist;
      const y = blastY + Math.sin(angle) * dist;
      const rot = angle + Math.PI * 0.5;
      const s = 9 + (i % 4) * 4;
      shard.moveTo(x + Math.cos(rot) * s, y + Math.sin(rot) * s)
        .lineTo(x + Math.cos(rot + 2.3) * s * 0.9, y + Math.sin(rot + 2.3) * s * 0.9)
        .lineTo(x + Math.cos(rot - 2.1) * s * 0.8, y + Math.sin(rot - 2.1) * s * 0.8)
        .closePath()
        .fill({ color: i % 3 === 0 ? 0xffffff : accentColor, alpha: 0.14 + intro * 0.08 })
        .stroke({ color: 0x050509, width: 1.4, alpha: 0.22 });
    }
    this.root.addChild(shard);

    const textContainer = new this.pixi.Container();
    textContainer.x = cx;
    textContainer.y = cy;
    textContainer.rotation = -0.16 + Math.sin(timeSeconds * 14) * hit * 0.02;
    textContainer.skew.x = -0.08;
    textContainer.scale.set((0.66 + intro * 0.26 + hit * 0.035) * sizeScale);
    this.root.addChild(textContainer);

    const back = new this.pixi.Text({
      text,
      style: {
        fontFamily: "Luckiest Guy, Bangers, Impact, system-ui",
        fontSize: 106,
        fontWeight: "900",
        fill: "#050509",
        stroke: { color: "#050509", width: 16 },
        align: "center",
      },
    });
    back.anchor.set(0.5);
    back.x = 16;
    back.y = 18;
    textContainer.addChild(back);

    const colorPlate = new this.pixi.Text({
      text,
      style: {
        fontFamily: "Luckiest Guy, Bangers, Impact, system-ui",
        fontSize: 106,
        fontWeight: "900",
        fill: accent,
        stroke: { color: "#050509", width: 12 },
        align: "center",
      },
    });
    colorPlate.anchor.set(0.5);
    colorPlate.x = 6;
    colorPlate.y = 8;
    textContainer.addChild(colorPlate);

    const label = new this.pixi.Text({
      text,
      style: {
        fontFamily: "Luckiest Guy, Bangers, Impact, system-ui",
        fontSize: 106,
        fontWeight: "900",
        fill: "#fffef4",
        stroke: { color: "#050509", width: 9 },
        align: "center",
      },
    });
    label.anchor.set(0.5);
    label.x = 0;
    label.y = 0;
    textContainer.addChild(label);

    const slice = new this.pixi.Graphics();
    slice.moveTo(cx - 214, cy - 28)
      .lineTo(cx + 206, cy - 78)
      .stroke({ color: 0xffffff, width: 2.6, alpha: 0.15 + pulse * 0.08 });
    slice.moveTo(cx - 188, cy + 44)
      .lineTo(cx + 220, cy + 6)
      .stroke({ color: accentColor, width: 3, alpha: 0.11 + pulse * 0.055 });
    this.root.addChild(slice);

    const glow = this.createExternalGlowFilter({ color: accentColor, distance: 22, outerStrength: 0.42 + hit * 0.22, innerStrength: 0.08, quality: 0.22 });
    const rgb = hit > 0.02 ? this.createExternalRgbSplitFilter(timeSeconds, 1.1 + hit * 1.0) : null;
    textContainer.filters = [glow, rgb].filter(Boolean);
  }

  drawShowcaseMangaActionText(textStyle, progress, timeSeconds, variant = "speed-banner") {
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = Math.min(Math.max(progress, 0), 1);
    const intro = easeOutCubic(Math.min(p / 0.34, 1));
    const pop = easeOutBack(Math.min(p / 0.36, 1));
    const hit = Math.max(0, 1 - p / 0.28);
    const pulse = Math.sin(timeSeconds * 5.5) * 0.5 + 0.5;
    const accent = textStyle.accent || "#ffd84d";
    const accentColor = parsePixiColor(accent);
    const text = String(textStyle.text || textStyle.title || "ACTION").toUpperCase().slice(0, 30);

    const addSpeedField = (angle = -0.42, count = 26, alpha = 0.15, color = 0xffffff) => {
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.86 });
      const g = new this.pixi.Graphics();
      const slope = Math.tan(angle);
      for (let i = 0; i < count; i += 1) {
        const y = -90 + i * (h + 180) / Math.max(1, count - 1) + Math.sin(timeSeconds * 2 + i) * 8;
        const x = -130 + (i % 7) * 28;
        const len = w + 260 + (i % 4) * 80;
        const width = i % 5 === 0 ? 5 : i % 3 === 0 ? 3 : 1.5;
        g.moveTo(x, y)
          .lineTo(x + len, y + slope * len)
          .stroke({ color: i % 4 === 0 ? accentColor : color, width, alpha: alpha * (0.72 + (i % 5) * 0.08) });
      }
      layer.addChild(g);
      return layer;
    };

    const addTextStack = ({
      x = w * 0.5,
      y = h * 0.5,
      rotation = 0,
      fontSize = 92,
      fill = "#fffef4",
      stroke = "#050509",
      strokeWidth = 11,
      shadowOffset = 13,
      scale = 1,
      align = "center",
      maxWidth = 520,
      skewX = 0,
      letterSpacing = 0,
    } = {}) => {
      const container = new this.pixi.Container();
      container.x = x;
      container.y = y;
      container.rotation = rotation;
      container.skew.x = skewX;
      container.scale.set((0.72 + pop * 0.28 + hit * 0.035) * scale);
      this.root.addChild(container);

      const makeText = (fillColor, strokeColor, width, dx, dy) => {
        const label = new this.pixi.Text({
          text,
          style: {
            fontFamily: "Luckiest Guy, Bangers, Impact, system-ui",
            fontSize,
            fontWeight: "900",
            fill: fillColor,
            stroke: { color: strokeColor, width },
            align,
            letterSpacing,
            wordWrap: true,
            wordWrapWidth: maxWidth,
            lineHeight: fontSize * 0.92,
          },
        });
        label.anchor.set(0.5);
        label.x = dx;
        label.y = dy;
        container.addChild(label);
        return label;
      };
      makeText("#050509", "#050509", strokeWidth + 10, shadowOffset, shadowOffset + 2);
      makeText(accent, "#050509", strokeWidth + 5, shadowOffset * 0.36, shadowOffset * 0.36);
      const label = makeText(fill, stroke, strokeWidth, 0, 0);
      const glow = this.createExternalGlowFilter({ color: accentColor, distance: 24, outerStrength: 0.6 + pulse * 0.28, innerStrength: 0.14, quality: 0.24 });
      const rgb = hit > 0.04 ? this.createExternalRgbSplitFilter(timeSeconds, 1.2 + hit * 2.2) : null;
      container.filters = [glow, rgb].filter(Boolean);
      return { container, label };
    };

    if (variant === "slash") {
      const shade = new this.pixi.Graphics();
      shade.rect(0, 0, w, h).fill({ color: 0x050509, alpha: 0.22 });
      this.root.addChild(shade);
      addSpeedField(-0.55, 22, 0.13);

      const slash = this.createFxLayer({ blendMode: "screen", alpha: 0.96 });
      const g = new this.pixi.Graphics();
      for (let i = 0; i < 6; i += 1) {
        const y = h * (0.34 + i * 0.045) + Math.sin(timeSeconds * 2 + i) * 4;
        const x1 = -70 - i * 8;
        const y1 = y + i * 6;
        const x2 = w + 88 + i * 10;
        const y2 = y - h * 0.36 - i * 10;
        this.drawTaperedQuad(g, x1, y1, x2, y2, 10 + i * 4, 3 + i, i % 2 ? accentColor : 0xffffff, 0.28 + intro * 0.2);
      }
      g.moveTo(-30, h * 0.61)
        .lineTo(w + 42, h * 0.22)
        .stroke({ color: 0xffffff, width: 5, alpha: 0.68 });
      slash.addChild(g);
      slash.filters = [this.createExternalBloomFilter({ threshold: 0.1, bloomScale: 0.34, brightness: 1.08, blur: 4, quality: 2 })].filter(Boolean);

      addTextStack({ x: w * 0.55, y: h * 0.46, rotation: -0.38, fontSize: 118, fill: "#fffaf0", strokeWidth: 12, scale: 0.96, skewX: -0.06 });
      const kana = new this.pixi.Text({
        text: "ザシュッ",
        style: {
          fontFamily: "Hiragino Sans, Yu Gothic, Noto Sans JP, system-ui, sans-serif",
          fontSize: 54,
          fontWeight: "900",
          fill: "#ffffff",
          stroke: { color: "#050509", width: 8 },
        },
      });
      kana.anchor.set(0.5);
      kana.x = w * 0.22;
      kana.y = h * 0.68;
      kana.rotation = -0.42;
      kana.alpha = 0.72 + intro * 0.28;
      this.root.addChild(kana);
      return;
    }

    if (variant === "speed-banner") {
      addSpeedField(-0.28, 34, 0.17);
      const g = new this.pixi.Graphics();
      const y = h * 0.5 + Math.sin(timeSeconds * 2) * 3;
      g.moveTo(-48, y - 118)
        .lineTo(w + 48, y - 168)
        .lineTo(w + 60, y + 66)
        .lineTo(-60, y + 118)
        .closePath()
        .fill({ color: 0x050509, alpha: 0.78 })
        .stroke({ color: 0xffffff, width: 5, alpha: 0.28 })
        .stroke({ color: accentColor, width: 3, alpha: 0.88 });
      g.moveTo(-20, y + 82)
        .lineTo(w + 38, y + 34)
        .stroke({ color: accentColor, width: 8, alpha: 0.48 });
      this.root.addChild(g);
      addTextStack({ x: w * 0.5, y: y - 18, rotation: -0.075, fontSize: 54, fill: "#fffef7", strokeWidth: 9, scale: 1, maxWidth: 540, letterSpacing: 0 });
      return;
    }

    if (variant === "combo") {
      addSpeedField(-0.7, 28, 0.12);
      const shade = new this.pixi.Graphics();
      shade.rect(0, 0, w, h).fill({ color: 0x050509, alpha: 0.18 });
      this.root.addChild(shade);
      const baseWord = String(textStyle.text || "DADADA").toUpperCase().slice(0, 10);
      for (let col = 0; col < 2; col += 1) {
        for (let i = 0; i < 4; i += 1) {
          const label = new this.pixi.Text({
            text: baseWord,
            style: {
              fontFamily: "Luckiest Guy, Bangers, Impact, system-ui",
              fontSize: 48 + col * 8,
              fontWeight: "900",
              fill: col === 1 ? accent : "#fffef4",
              stroke: { color: "#050509", width: 8 },
            },
          });
          label.anchor.set(0.5);
          label.x = w * (0.24 + col * 0.32) + Math.sin(timeSeconds * 4 + i) * 9;
          label.y = h * (0.24 + i * 0.16) - col * 24 + (1 - intro) * 46;
          label.rotation = -0.18 + col * 0.08;
          label.alpha = 0.22 + intro * (0.36 + col * 0.1);
          label.scale.set(0.82 + intro * 0.18);
          this.root.addChild(label);
        }
      }
      const front = addTextStack({ x: w * 0.53, y: h * 0.58, rotation: -0.11, fontSize: 106, fill: "#fffef4", strokeWidth: 12, scale: 0.92 });
      front.container.filters = [
        this.createExternalMotionBlurFilter(10 + hit * 14, -5, 7),
        this.createExternalGlowFilter({ color: accentColor, distance: 22, outerStrength: 0.62, innerStrength: 0.12, quality: 0.22 }),
      ].filter(Boolean);
      return;
    }

    if (variant === "power") {
      const aura = this.createFxLayer({ blendMode: "screen", alpha: 0.98 });
      const g = new this.pixi.Graphics();
      const cx = w * 0.5;
      const cy = h * 0.5;
      for (let i = 0; i < 30; i += 1) {
        const angle = -Math.PI / 2 + (i / 30) * Math.PI * 2;
        const len = 210 + (i % 6) * 32 + pulse * 24;
        const inner = 56 + (i % 4) * 7;
        this.drawTaperedQuad(
          g,
          cx + Math.cos(angle) * inner,
          cy + Math.sin(angle) * inner,
          cx + Math.cos(angle) * len,
          cy + Math.sin(angle) * len,
          5 + (i % 4) * 2,
          1,
          i % 3 === 0 ? 0xffffff : accentColor,
          0.08 + intro * 0.13,
        );
      }
      g.ellipse(cx, cy, 220 * intro, 118 * intro).stroke({ color: accentColor, width: 4, alpha: 0.22 + pulse * 0.12 });
      g.ellipse(cx, cy, 145 * intro, 82 * intro).fill({ color: accentColor, alpha: 0.08 + pulse * 0.04 });
      aura.addChild(g);
      aura.filters = [this.createExternalBloomFilter({ threshold: 0.08, bloomScale: 0.68, brightness: 1.18, blur: 6, quality: 3 }), this.createBlurFilter(0.2, 2)].filter(Boolean);
      addTextStack({ x: w * 0.5, y: h * 0.49, rotation: -0.04, fontSize: 100, fill: "#fffef0", strokeWidth: 11, scale: 0.92, maxWidth: 540 });
      const subtitle = new this.pixi.Text({
        text: "LIMIT BREAK",
        style: {
          fontFamily: "Inter, system-ui",
          fontSize: 16,
          fontWeight: "950",
          fill: accent,
          letterSpacing: 0,
        },
      });
      subtitle.anchor.set(0.5);
      subtitle.x = w * 0.5;
      subtitle.y = h * 0.64;
      subtitle.alpha = 0.66 + pulse * 0.22;
      this.root.addChild(subtitle);
      return;
    }

    if (variant === "rage") {
      const shade = new this.pixi.Graphics();
      shade.rect(0, 0, w, h).fill({ color: 0x070000, alpha: 0.33 });
      this.root.addChild(shade);
      const scratch = this.createFxLayer({ blendMode: "screen", alpha: 0.92 });
      const g = new this.pixi.Graphics();
      for (let i = 0; i < 24; i += 1) {
        const startX = -80 + (i % 8) * 78 + Math.sin(i * 2.1) * 18;
        const startY = h * 0.23 + (i % 6) * 74 + Math.cos(i * 1.6) * 16;
        const endX = startX + 180 + (i % 5) * 28;
        const endY = startY - 82 + (i % 4) * 36;
        this.drawTaperedQuad(g, startX, startY, endX, endY, 9 + (i % 5) * 3, 1.5, i % 3 ? 0xffffff : 0xff2d34, 0.13 + intro * 0.16);
      }
      scratch.addChild(g);
      scratch.filters = [this.createExternalBloomFilter({ threshold: 0.14, bloomScale: 0.36, brightness: 1.08, blur: 4, quality: 2 })].filter(Boolean);
      const burst = new this.pixi.Graphics();
      burst.moveTo(w * 0.08, h * 0.43)
        .lineTo(w * 0.25, h * 0.35)
        .lineTo(w * 0.48, h * 0.4)
        .lineTo(w * 0.74, h * 0.32)
        .lineTo(w * 0.94, h * 0.48)
        .lineTo(w * 0.77, h * 0.62)
        .lineTo(w * 0.52, h * 0.56)
        .lineTo(w * 0.21, h * 0.68)
        .closePath()
        .fill({ color: 0x050509, alpha: 0.78 })
        .stroke({ color: 0xffffff, width: 3, alpha: 0.24 })
        .stroke({ color: 0xff2d34, width: 5, alpha: 0.74 });
      burst.moveTo(w * 0.1, h * 0.5)
        .lineTo(w * 0.9, h * 0.43)
        .stroke({ color: 0xff2d34, width: 14, alpha: 0.32 });
      burst.moveTo(w * 0.2, h * 0.6)
        .lineTo(w * 0.78, h * 0.38)
        .stroke({ color: 0xffffff, width: 4, alpha: 0.22 });
      this.root.addChild(burst);
      addTextStack({ x: w * 0.5 + Math.sin(timeSeconds * 19) * hit * 7, y: h * 0.51, rotation: -0.08 + Math.sin(timeSeconds * 16) * hit * 0.035, fontSize: 120, fill: "#fff7f0", stroke: "#050509", strokeWidth: 12, scale: 0.88 });
      return;
    }

    if (variant === "nameplate") {
      const y = h * 0.66 + (1 - intro) * 44;
      const panel = new this.pixi.Graphics();
      panel.rect(0, y - 18, w, 176).fill({ color: 0x050509, alpha: 0.62 });
      panel.moveTo(34, y)
        .lineTo(w - 54, y - 32)
        .lineTo(w - 24, y + 94)
        .lineTo(58, y + 126)
        .closePath()
        .fill({ color: 0x050509, alpha: 0.82 })
        .stroke({ color: 0xffffff, width: 2, alpha: 0.22 })
        .stroke({ color: accentColor, width: 3, alpha: 0.88 });
      panel.moveTo(58, y + 102)
        .lineTo(w - 68, y + 70)
        .stroke({ color: accentColor, width: 7, alpha: 0.44 });
      this.root.addChild(panel);
      const kicker = new this.pixi.Text({
        text: "CHARACTER FILE",
        style: { fontFamily: "Inter, system-ui", fontSize: 14, fontWeight: "950", fill: accent, letterSpacing: 0 },
      });
      kicker.x = 82;
      kicker.y = y + 8;
      this.root.addChild(kicker);
      addTextStack({ x: w * 0.5, y: y + 62, rotation: -0.055, fontSize: 58, fill: "#fffef4", strokeWidth: 7, scale: 0.92, maxWidth: 500, shadowOffset: 8 });
      return;
    }

    if (variant === "intertitle") {
      const bars = new this.pixi.Graphics();
      bars.rect(0, 0, w, 104).fill({ color: 0x020205, alpha: 0.86 });
      bars.rect(0, h - 122, w, 122).fill({ color: 0x020205, alpha: 0.9 });
      bars.rect(0, h * 0.38, w, 206).fill({ color: 0x020205, alpha: 0.55 });
      this.root.addChild(bars);
      addSpeedField(-0.18, 20, 0.08, 0xffffff);
      const line = new this.pixi.Graphics();
      line.rect(54, h * 0.38, w - 108, 4).fill({ color: accentColor, alpha: 0.75 });
      line.rect(54, h * 0.62, w - 108, 4).fill({ color: accentColor, alpha: 0.55 });
      for (let i = 0; i < 24; i += 1) {
        line.circle(52 + i * 22, h * 0.64 + Math.sin(timeSeconds * 2 + i) * 18, 2 + (i % 3)).fill({ color: i % 4 ? accentColor : 0xffffff, alpha: 0.18 + intro * 0.16 });
      }
      this.root.addChild(line);
      addTextStack({ x: w * 0.5, y: h * 0.51, rotation: 0, fontSize: 64, fill: "#fffdf2", strokeWidth: 8, scale: 1, maxWidth: 540, shadowOffset: 10 });
      const kicker = new this.pixi.Text({
        text: "NEXT PANEL",
        style: { fontFamily: "Inter, system-ui", fontSize: 14, fontWeight: "950", fill: accent, letterSpacing: 0 },
      });
      kicker.anchor.set(0.5);
      kicker.x = w * 0.5;
      kicker.y = h * 0.39 - 20;
      this.root.addChild(kicker);
      return;
    }

    if (variant === "pressure") {
      const shade = new this.pixi.Graphics();
      shade.rect(0, 0, w, h).fill({ color: 0x050509, alpha: 0.28 });
      shade.rect(0, 0, 76, h).fill({ color: 0x050509, alpha: 0.42 });
      shade.rect(w - 86, 0, 86, h).fill({ color: 0x050509, alpha: 0.42 });
      this.root.addChild(shade);
      const glyph = String(textStyle.text || "ドドド").slice(0, 8);
      const columns = [
        { x: 76, y: h * 0.39, scale: 1.22, alpha: 0.9 },
        { x: w - 72, y: h * 0.46, scale: 1.36, alpha: 0.98 },
        { x: w - 142, y: h * 0.3, scale: 0.98, alpha: 0.6 },
      ];
      columns.forEach((col, index) => {
        const label = new this.pixi.Text({
          text: glyph.split("").join("\n"),
          style: {
            fontFamily: "Hiragino Sans, Yu Gothic, Noto Sans JP, Impact, system-ui",
            fontSize: 54 * col.scale,
            fontWeight: "900",
            fill: index === 1 ? "#ffffff" : "#d8d8d8",
            stroke: { color: "#050509", width: 8 },
            lineHeight: 46 * col.scale,
            align: "center",
          },
        });
        label.anchor.set(0.5);
        label.x = col.x + Math.sin(timeSeconds * 2.2 + index) * 4;
        label.y = col.y + (1 - intro) * 48;
        label.alpha = col.alpha;
        label.rotation = index === 1 ? 0.035 : -0.025;
        this.root.addChild(label);
      });
      const pressure = new this.pixi.Graphics();
      for (let i = 0; i < 18; i += 1) {
        pressure.ellipse(w * 0.5, h * 0.46, 90 + i * 19 + pulse * 6, 54 + i * 12)
          .stroke({ color: i % 3 ? 0x050509 : accentColor, width: 1.5, alpha: 0.025 + intro * 0.018 });
      }
      this.root.addChild(pressure);
      return;
    }
  }

  drawShowcaseWebtoonText(textStyle, progress, timeSeconds, variant = "scroll-caption") {
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = Math.min(Math.max(progress, 0), 1);
    const intro = easeOutCubic(Math.min(p / 0.42, 1));
    const soft = Math.sin(timeSeconds * 2.1) * 0.5 + 0.5;
    const accent = textStyle.accent || "#8fffe4";
    const accentColor = parsePixiColor(accent);
    const text = String(textStyle.text || textStyle.title || "Nuevo episodio").slice(0, 96);

    const makePanel = ({
      x,
      y,
      width,
      height,
      radius = 16,
      fill = 0x041018,
      alpha = 0.78,
      stroke = 0xffffff,
      strokeAlpha = 0.13,
      accentSide = "left",
    }) => {
      const panel = new this.pixi.Graphics();
      panel.roundRect(x, y, width, height, radius)
        .fill({ color: fill, alpha })
        .stroke({ color: stroke, width: 2, alpha: strokeAlpha });
      const accentAlpha = 0.55 + soft * 0.18;
      if (accentSide === "left") panel.rect(x, y + 10, 7, height - 20).fill({ color: accentColor, alpha: accentAlpha });
      if (accentSide === "bottom") panel.rect(x + 18, y + height - 10, width - 36, 4).fill({ color: accentColor, alpha: accentAlpha });
      if (accentSide === "top") panel.rect(x + 18, y + 10, width - 36, 4).fill({ color: accentColor, alpha: accentAlpha });
      this.root.addChild(panel);
      return panel;
    };

    const addReadableText = ({
      value = text,
      x,
      y,
      width,
      fontSize = 34,
      minFontSize = 24,
      lineHeight,
      fill = textStyle.ink || "#fffdf8",
      align = "left",
      weight = "900",
      family = "Inter, system-ui",
      anchorX = 0,
      anchorY = 0,
      strokeColor = null,
      strokeWidth = 0,
      alpha = 1,
    }) => {
      const lengthPenalty = Math.max(0, String(value).length - 34) * 0.34;
      const resolvedSize = Math.max(minFontSize, fontSize - lengthPenalty);
      const label = new this.pixi.Text({
        text: String(value),
        style: {
          fontFamily: family,
          fontSize: resolvedSize,
          fontWeight: weight,
          fill,
          align,
          wordWrap: true,
          wordWrapWidth: width,
          lineHeight: lineHeight || resolvedSize * 1.14,
          stroke: strokeColor && strokeWidth ? { color: strokeColor, width: strokeWidth } : undefined,
        },
      });
      label.anchor.set(anchorX, anchorY);
      label.x = x;
      label.y = y;
      label.alpha = alpha;
      this.root.addChild(label);
      return label;
    };

    const addVerticalGuide = (x, alpha = 0.28) => {
      const guide = new this.pixi.Graphics();
      for (let i = 0; i < 7; i += 1) {
        const y = 90 + i * 118 + ((timeSeconds * 16) % 34);
        guide.roundRect(x - 2, y, 4, 74, 2).fill({ color: accentColor, alpha: alpha * (0.5 + (i % 3) * 0.16) });
      }
      this.root.addChild(guide);
      return guide;
    };

    const shade = new this.pixi.Graphics();
    shade.rect(0, 0, w, h).fill({ color: 0x02060b, alpha: variant === "episode-card" ? 0.34 : 0.16 });
    this.root.addChild(shade);

    if (variant === "scroll-caption") {
      addVerticalGuide(w - 42, 0.22);
      const x = 44;
      const y = h * 0.64 + (1 - intro) * 42;
      const width = w - 88;
      const height = 142;
      makePanel({ x, y, width, height, radius: 16, alpha: 0.82, accentSide: "left" });
      addReadableText({ value: text, x: x + 28, y: y + 28, width: width - 58, fontSize: 33, minFontSize: 25 });
      return;
    }

    if (variant === "episode-card") {
      const x = 42;
      const y = h * 0.24 + (1 - intro) * -40;
      const width = w - 84;
      const height = 178;
      makePanel({ x, y, width, height, radius: 20, fill: 0x061320, alpha: 0.86, stroke: accentColor, strokeAlpha: 0.34, accentSide: "top" });
      addReadableText({ value: "WEBTOON", x: x + 30, y: y + 26, width: width - 60, fontSize: 14, minFontSize: 14, fill: accent, weight: "950" });
      addReadableText({ value: text.toUpperCase(), x: x + 30, y: y + 58, width: width - 60, fontSize: 46, minFontSize: 31, family: "Space Grotesk, Inter, system-ui", weight: "950", lineHeight: 48 });
      const glow = new this.pixi.Graphics();
      glow.roundRect(x - 10, y - 10, width + 20, height + 20, 24).stroke({ color: accentColor, width: 3, alpha: 0.1 + soft * 0.08 });
      this.root.addChild(glow);
      return;
    }

    if (variant === "cliffhanger") {
      addVerticalGuide(w * 0.5, 0.16);
      const dark = new this.pixi.Graphics();
      dark.rect(0, h * 0.52, w, h * 0.48).fill({ color: 0x02040a, alpha: 0.54 });
      dark.moveTo(w * 0.5, h * 0.34)
        .lineTo(w * 0.5, h * 0.82)
        .stroke({ color: accentColor, width: 3, alpha: 0.28 + soft * 0.14 });
      dark.moveTo(w * 0.5 - 14, h * 0.8)
        .lineTo(w * 0.5, h * 0.84)
        .lineTo(w * 0.5 + 14, h * 0.8)
        .stroke({ color: accentColor, width: 3, alpha: 0.4 });
      this.root.addChild(dark);
      makePanel({ x: 48, y: h * 0.61 + (1 - intro) * 28, width: w - 96, height: 156, radius: 14, fill: 0x03070d, alpha: 0.78, accentSide: "bottom" });
      addReadableText({ value: text, x: w * 0.5, y: h * 0.685, width: w - 138, fontSize: 35, minFontSize: 25, align: "center", anchorX: 0.5, anchorY: 0.5, strokeColor: "#02040a", strokeWidth: 4 });
      return;
    }

    if (variant === "thought") {
      const x = 52 + Math.sin(timeSeconds * 1.2) * 4;
      const y = h * 0.52 + (1 - intro) * 34;
      const width = w - 104;
      const height = 166;
      makePanel({ x, y, width, height, radius: 26, fill: 0xf8fbff, alpha: 0.88, stroke: accentColor, strokeAlpha: 0.24, accentSide: "bottom" });
      for (let i = 0; i < 3; i += 1) {
        const dot = new this.pixi.Graphics();
        dot.circle(x + width - 78 + i * 24, y + height + 18 + i * 12, 9 - i * 1.8).fill({ color: 0xf8fbff, alpha: 0.74 - i * 0.14 }).stroke({ color: accentColor, width: 1, alpha: 0.16 });
        this.root.addChild(dot);
      }
      addReadableText({ value: text, x: x + 30, y: y + 36, width: width - 60, fontSize: 34, minFontSize: 25, fill: "#17212b", weight: "850" });
      return;
    }

    if (variant === "drama-eye") {
      const focus = new this.pixi.Graphics();
      focus.rect(0, h * 0.27, w, 178).fill({ color: 0x02040a, alpha: 0.42 });
      focus.moveTo(0, h * 0.27).lineTo(w, h * 0.2).stroke({ color: accentColor, width: 3, alpha: 0.38 });
      focus.moveTo(0, h * 0.47).lineTo(w, h * 0.55).stroke({ color: accentColor, width: 3, alpha: 0.28 });
      this.root.addChild(focus);
      addReadableText({ value: text.toUpperCase(), x: w * 0.5, y: h * 0.38, width: w - 120, fontSize: 42, minFontSize: 28, align: "center", anchorX: 0.5, anchorY: 0.5, family: "Space Grotesk, Inter, system-ui", weight: "950", strokeColor: "#02040a", strokeWidth: 5 });
      return;
    }

    if (variant === "read-cta") {
      const y = h - 192 + (1 - intro) * 44;
      makePanel({ x: 58, y, width: w - 116, height: 116, radius: 18, fill: 0x071018, alpha: 0.88, stroke: accentColor, strokeAlpha: 0.28, accentSide: "left" });
      addReadableText({ value: text.toUpperCase(), x: 96, y: y + 32, width: w - 210, fontSize: 32, minFontSize: 24, family: "Space Grotesk, Inter, system-ui", weight: "950" });
      const arrow = new this.pixi.Graphics();
      arrow.roundRect(w - 116, y + 34, 48, 48, 12).fill({ color: accentColor, alpha: 0.72 + soft * 0.14 });
      arrow.moveTo(w - 98, y + 58).lineTo(w - 78, y + 58).lineTo(w - 88, y + 48).moveTo(w - 78, y + 58).lineTo(w - 88, y + 68).stroke({ color: 0x031015, width: 4, alpha: 0.86 });
      this.root.addChild(arrow);
      return;
    }

    if (variant === "soft-reveal") {
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.8 });
      const glow = new this.pixi.Graphics();
      glow.ellipse(w * 0.5, h * 0.5, 220 + soft * 22, 122 + soft * 12).fill({ color: accentColor, alpha: 0.08 + soft * 0.025 });
      layer.addChild(glow);
      layer.filters = [this.createExternalBloomFilter({ threshold: 0.1, bloomScale: 0.42, brightness: 1.08, blur: 6, quality: 2 }), this.createBlurFilter(0.6, 2)].filter(Boolean);
      makePanel({ x: 74, y: h * 0.46 + (1 - intro) * 28, width: w - 148, height: 116, radius: 22, fill: 0xf5fff9, alpha: 0.78, stroke: accentColor, strokeAlpha: 0.22, accentSide: "bottom" });
      addReadableText({ value: text, x: w * 0.5, y: h * 0.515, width: w - 190, fontSize: 34, minFontSize: 25, fill: "#10211e", align: "center", anchorX: 0.5, anchorY: 0.5, weight: "850" });
      return;
    }

    if (variant === "floating-title") {
      addVerticalGuide(44, 0.2);
      const x = 58;
      const y = 132 + (1 - intro) * -36;
      const width = w - 116;
      const height = 154;
      makePanel({ x, y, width, height, radius: 16, fill: 0x06121d, alpha: 0.84, stroke: accentColor, strokeAlpha: 0.24, accentSide: "left" });
      addReadableText({ value: "SCENE", x: x + 30, y: y + 24, width: width - 60, fontSize: 14, minFontSize: 14, fill: accent, weight: "950" });
      addReadableText({ value: text.toUpperCase(), x: x + 30, y: y + 54, width: width - 60, fontSize: 40, minFontSize: 28, family: "Space Grotesk, Inter, system-ui", weight: "950", lineHeight: 42 });
      return;
    }

    if (variant === "phone-hook") {
      const x = 42;
      const y = h * 0.57 + (1 - intro) * 40;
      const width = w - 84;
      const height = 172;
      makePanel({ x, y, width, height, radius: 18, fill: 0x061018, alpha: 0.86, stroke: accentColor, strokeAlpha: 0.22, accentSide: "left" });
      addReadableText({ value: "HOOK", x: x + 30, y: y + 24, width: width - 60, fontSize: 14, minFontSize: 14, fill: accent, weight: "950" });
      addReadableText({ value: text, x: x + 30, y: y + 56, width: width - 60, fontSize: 36, minFontSize: 25, lineHeight: 40 });
      return;
    }

    if (variant === "narration-strip") {
      const x = 48;
      const y = 118 + (1 - intro) * 32;
      const width = w - 96;
      const height = Math.min(232, Math.max(126, 86 + Math.ceil(text.length / 26) * 42));
      const paper = this.createFillGradient({
        type: "linear",
        start: { x: 0, y: 0 },
        end: { x: 1, y: 1 },
        colorStops: [
          { offset: 0, color: "rgba(255,252,232,0.91)" },
          { offset: 1, color: "rgba(232,244,240,0.84)" },
        ],
      });
      const panel = new this.pixi.Graphics();
      panel.roundRect(x, y, width, height, 10)
        .fill(paper || { color: 0xf7f2df, alpha: 0.88 })
        .stroke({ color: accentColor, width: 2, alpha: 0.22 });
      panel.rect(x, y, width, 7).fill({ color: accentColor, alpha: 0.36 });
      this.root.addChild(panel);
      addReadableText({ value: text, x: x + 28, y: y + 26, width: width - 56, fontSize: 31, minFontSize: 23, fill: "#18201e", weight: "800", lineHeight: 36 });
      return;
    }
  }

  drawShowcaseRomanceFantasyText(textStyle, progress, timeSeconds, variant = "confession") {
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = Math.min(Math.max(progress, 0), 1);
    const intro = easeOutCubic(Math.min(p / 0.46, 1));
    const breath = 0.5 + Math.sin(timeSeconds * 1.05) * 0.5;
    const accent = textStyle.accent || "#ff8ed6";
    const accentColor = parsePixiColor(accent);
    const ink = textStyle.ink || "#2d1421";
    const fullText = String(textStyle.text || textStyle.title || "Queria decirtelo").slice(0, 104);
    const upperText = fullText.toUpperCase();

    const addAtmosphere = (mode = "soft") => {
      const grade = this.createFxLayer({ blendMode: "multiply", alpha: 0.64 });
      const shadow = new this.pixi.Graphics();
      shadow.rect(0, 0, w, h).fill({ color: mode === "gold" ? 0x130a05 : 0x090514, alpha: 0.22 });
      shadow.rect(0, 0, w, h * 0.18).fill({ color: 0x030207, alpha: 0.22 });
      shadow.rect(0, h * 0.78, w, h * 0.22).fill({ color: 0x030207, alpha: 0.26 });
      grade.addChild(shadow);

      const light = this.createFxLayer({ blendMode: "screen", alpha: 0.92 });
      const wash = new this.pixi.Graphics();
      const fill = this.createFillGradient({
        type: "radial",
        center: { x: mode === "moon" ? 0.22 : 0.58, y: mode === "lore" ? 0.78 : 0.24 },
        innerRadius: 0.02,
        outerCenter: { x: 0.5, y: 0.48 },
        outerRadius: 0.88,
        colorStops: [
          { offset: 0, color: mode === "gold" ? "rgba(255,236,178,0.24)" : "rgba(255,255,255,0.22)" },
          { offset: 0.42, color: `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},0.13)` },
          { offset: 1, color: "rgba(255,255,255,0)" },
        ],
      });
      wash.rect(0, 0, w, h).fill(fill || { color: accentColor, alpha: 0.045 });
      light.addChild(wash);
      if (mode !== "quiet") {
        this.drawSoftBeam(light, -80, h * 0.22, w * 0.78, h * 0.05, 150, 0xffffff, 0.1 + breath * 0.04, { blur: 1.8 });
        this.drawSoftBeam(light, w * 0.14, h * 1.04, w * 1.04, h * 0.6, 128, accentColor, 0.06 + breath * 0.035, { blur: 2.1 });
      }
    };

    const addReadableText = ({
      value = fullText,
      x,
      y,
      width,
      fontSize = 36,
      minFontSize = 22,
      lineHeight,
      fill = ink,
      family = "Inter, system-ui",
      weight = "850",
      align = "center",
      anchorX = 0.5,
      anchorY = 0.5,
      strokeColor = null,
      strokeWidth = 0,
      alpha = 1,
    }) => {
      const text = String(value);
      const resolved = Math.max(minFontSize, fontSize - Math.max(0, text.length - 30) * 0.35);
      const label = new this.pixi.Text({
        text,
        style: {
          fontFamily: family,
          fontSize: resolved,
          fontWeight: weight,
          fill,
          align,
          wordWrap: true,
          wordWrapWidth: width,
          lineHeight: lineHeight || resolved * 1.18,
          stroke: strokeColor && strokeWidth ? { color: strokeColor, width: strokeWidth } : undefined,
        },
      });
      label.anchor.set(anchorX, anchorY);
      label.x = x;
      label.y = y;
      label.alpha = alpha;
      this.root.addChild(label);
      return label;
    };

    const addSoftPanel = ({
      x,
      y,
      width,
      height,
      radius = 18,
      fill = "paper",
      alpha = 0.9,
      strokeAlpha = 0.28,
      ribbon = "bottom",
    }) => {
      const panel = new this.pixi.Graphics();
      const paperFill = this.createFillGradient({
        type: "linear",
        start: { x: 0, y: 0 },
        end: { x: 1, y: 1 },
        colorStops: fill === "dark"
          ? [
              { offset: 0, color: "rgba(28,13,33,0.86)" },
              { offset: 1, color: "rgba(7,5,16,0.82)" },
            ]
          : [
              { offset: 0, color: "rgba(255,252,246,0.94)" },
              { offset: 0.58, color: "rgba(255,241,249,0.92)" },
              { offset: 1, color: "rgba(240,247,255,0.86)" },
            ],
      });
      panel.roundRect(x, y, width, height, radius)
        .fill(paperFill || { color: fill === "dark" ? 0x120a1a : 0xfff7fb, alpha })
        .stroke({ color: fill === "dark" ? accentColor : 0xffffff, width: 2, alpha: strokeAlpha });
      if (ribbon === "bottom") panel.rect(x + 24, y + height - 12, width - 48, 4).fill({ color: accentColor, alpha: 0.35 + breath * 0.12 });
      if (ribbon === "top") panel.rect(x + 24, y + 12, width - 48, 4).fill({ color: accentColor, alpha: 0.35 + breath * 0.12 });
      if (ribbon === "left") panel.rect(x + 12, y + 20, 5, height - 40).fill({ color: accentColor, alpha: 0.42 + breath * 0.1 });
      panel.alpha = alpha;
      this.root.addChild(panel);
      return panel;
    };

    const addPetals = (count = 20, opacity = 0.2, spread = 0.72) => {
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.86 });
      const petals = new this.pixi.Graphics();
      for (let i = 0; i < count; i += 1) {
        const depth = (i % 7) / 6;
        const x = 28 + ((i * 97 + timeSeconds * (10 + depth * 28)) % (w - 56));
        const y = h * (0.5 - spread * 0.5) + ((i * 131 + timeSeconds * (14 + depth * 32)) % (h * spread));
        const size = 5 + depth * 8;
        petals.ellipse(x, y, size * 1.2, size * 0.48, Math.sin(i + timeSeconds) * 0.6)
          .fill({ color: i % 3 ? accentColor : 0xffffff, alpha: opacity + depth * 0.035 });
      }
      layer.addChild(petals);
    };

    const addButterflies = (count = 12, opacity = 0.18) => {
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.9 });
      const g = new this.pixi.Graphics();
      for (let i = 0; i < count; i += 1) {
        const depth = (i % 5) / 4;
        const x = 60 + ((i * 79 + timeSeconds * (8 + depth * 24)) % (w - 120));
        const y = h * (0.18 + Math.abs(Math.sin(i * 1.41 + timeSeconds * 0.22)) * 0.62);
        const s = 6 + depth * 9;
        const flap = 0.72 + Math.sin(timeSeconds * (2.2 + depth) + i) * 0.22;
        g.ellipse(x - s * 0.38, y, s * 0.62, s * flap, -0.35).fill({ color: i % 3 ? accentColor : 0xffffff, alpha: opacity + depth * 0.07 });
        g.ellipse(x + s * 0.38, y, s * 0.62, s * flap, 0.35).fill({ color: i % 3 ? accentColor : 0xffffff, alpha: opacity + depth * 0.07 });
        g.rect(x - 0.9, y - s * 0.42, 1.8, s * 0.84).fill({ color: 0xffffff, alpha: opacity * 0.72 });
      }
      layer.addChild(g);
    };

    const addRuneLines = (cx, cy, radius = 145, alpha = 0.2) => {
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.86 });
      const g = new this.pixi.Graphics();
      for (let i = 0; i < 3; i += 1) {
        g.ellipse(cx, cy, radius + i * 34, (radius + i * 34) * 0.78)
          .stroke({ color: i % 2 ? accentColor : 0xffffff, width: 2, alpha: alpha - i * 0.035 + breath * 0.04 });
      }
      for (let i = 0; i < 18; i += 1) {
        const angle = (i / 18) * Math.PI * 2 + timeSeconds * 0.08;
        const x = cx + Math.cos(angle) * (radius + 48);
        const y = cy + Math.sin(angle) * (radius + 48) * 0.78;
        g.roundRect(x - 11, y - 2, 22, 4, 2).fill({ color: i % 3 ? accentColor : 0xffffff, alpha: alpha * 0.88 });
      }
      layer.addChild(g);
    };

    addAtmosphere(variant.includes("moon") || variant === "classic-letter" ? "moon" : variant.includes("lore") ? "lore" : variant.includes("promise") ? "gold" : "soft");

    if (variant === "confession") {
      const x = 54;
      const y = h * 0.6 + (1 - intro) * 38;
      const width = w - 108;
      const height = 168;
      addPetals(18, 0.16, 0.46);
      addSoftPanel({ x, y, width, height, radius: 24, fill: "paper", alpha: 0.88, ribbon: "left" });
      addReadableText({ value: fullText, x: x + width * 0.5, y: y + height * 0.53, width: width - 74, fontSize: 36, minFontSize: 24, family: "Georgia, Times New Roman, serif", weight: "700" });
      addReadableText({ value: "confession", x: x + 34, y: y + 30, width: width - 68, fontSize: 14, minFontSize: 14, fill: accent, family: "Inter, system-ui", weight: "950", align: "left", anchorX: 0, anchorY: 0.5 });
      return;
    }

    if (variant === "nameplate") {
      const x = 48;
      const y = h * 0.64 + (1 - intro) * 34;
      const width = w - 96;
      addPetals(16, 0.18, 0.48);
      const plate = new this.pixi.Graphics();
      plate.moveTo(x + 20, y)
        .lineTo(x + width - 8, y + 18)
        .lineTo(x + width - 42, y + 132)
        .lineTo(x, y + 112)
        .closePath()
        .fill({ color: 0xfff7fb, alpha: 0.88 })
        .stroke({ color: 0xffffff, width: 2, alpha: 0.46 })
        .stroke({ color: accentColor, width: 2.4, alpha: 0.34 });
      plate.rect(x + 34, y + 23, width - 96, 4).fill({ color: accentColor, alpha: 0.34 + breath * 0.12 });
      this.root.addChild(plate);
      addReadableText({ value: "CHARACTER", x: x + 44, y: y + 42, width: width - 88, fontSize: 13, minFontSize: 13, fill: accent, weight: "950", align: "left", anchorX: 0, anchorY: 0.5 });
      addReadableText({ value: fullText, x: x + width * 0.5, y: y + 82, width: width - 92, fontSize: 40, minFontSize: 27, family: "Space Grotesk, Inter, system-ui", weight: "900" });
      return;
    }

    if (variant === "moon-card" || variant === "classic-letter") {
      const x = 58;
      const y = h * 0.49 + (1 - intro) * 38 + Math.sin(timeSeconds * 0.7) * 3;
      const width = w - 116;
      const height = 198;
      addPetals(14, 0.14, 0.5);
      addSoftPanel({ x, y, width, height, radius: 18, fill: "paper", alpha: 0.9, ribbon: "top" });
      addReadableText({ value: variant === "classic-letter" ? "Dear reader," : "moonlit note", x: x + 34, y: y + 34, width: width - 68, fontSize: 18, minFontSize: 16, fill: accent, family: "Georgia, Times New Roman, serif", weight: "700", align: "left", anchorX: 0, anchorY: 0.5 });
      addReadableText({ value: fullText, x: x + width * 0.5, y: y + 116, width: width - 78, fontSize: 38, minFontSize: 25, family: "Georgia, Times New Roman, serif", weight: "700", lineHeight: 42 });
      return;
    }

    if (variant === "sparkle-title") {
      this.drawRomanceSparkles(accent, timeSeconds, 74, 0.09, 0.76);
      addRuneLines(w * 0.5, h * 0.44, 132, 0.13);
      addReadableText({ value: upperText, x: w * 0.5, y: h * 0.44 + (1 - intro) * 24, width: w - 112, fontSize: 49, minFontSize: 30, fill: "#fffdf8", family: "Space Grotesk, Inter, system-ui", weight: "950", strokeColor: "#291327", strokeWidth: 5, lineHeight: 52 });
      return;
    }

    if (variant === "butterfly-dream") {
      addButterflies(18, 0.13);
      const x = 64;
      const y = h * 0.56 + (1 - intro) * 36;
      const width = w - 128;
      const height = 142;
      addSoftPanel({ x, y, width, height, radius: 28, fill: "paper", alpha: 0.82, ribbon: "bottom" });
      addReadableText({ value: fullText, x: x + width * 0.5, y: y + height * 0.5, width: width - 62, fontSize: 34, minFontSize: 24, family: "Georgia, Times New Roman, serif", weight: "700" });
      return;
    }

    if (variant === "rose-stamp") {
      addPetals(28, 0.2, 0.64);
      const cx = w * 0.5;
      const cy = h * 0.53 + (1 - intro) * 20;
      const badge = new this.pixi.Graphics();
      badge.roundRect(cx - 226, cy - 80, 452, 160, 18)
        .fill({ color: 0x160816, alpha: 0.72 })
        .stroke({ color: 0xffffff, width: 2, alpha: 0.26 })
        .stroke({ color: accentColor, width: 3, alpha: 0.46 });
      badge.moveTo(cx - 184, cy - 58).lineTo(cx + 184, cy + 58).stroke({ color: accentColor, width: 2, alpha: 0.22 });
      badge.rotation = -0.055 + Math.sin(timeSeconds * 1.6) * 0.008;
      this.root.addChild(badge);
      addReadableText({ value: upperText, x: cx, y: cy, width: 390, fontSize: 42, minFontSize: 25, fill: "#fff6fb", family: "Space Grotesk, Inter, system-ui", weight: "950", strokeColor: "#160816", strokeWidth: 5, lineHeight: 45 });
      return;
    }

    if (variant === "magic-lore") {
      const x = 54;
      const y = h * 0.18 + (1 - intro) * -28;
      const width = w - 108;
      const height = 196;
      addRuneLines(w * 0.5, y + height + 72, 126, 0.12);
      addSoftPanel({ x, y, width, height, radius: 14, fill: "dark", alpha: 0.84, strokeAlpha: 0.24, ribbon: "left" });
      addReadableText({ value: "LORE", x: x + 34, y: y + 32, width: width - 68, fontSize: 14, minFontSize: 14, fill: accent, weight: "950", align: "left", anchorX: 0, anchorY: 0.5 });
      addReadableText({ value: fullText, x: x + 34, y: y + 74, width: width - 68, fontSize: 32, minFontSize: 22, fill: "#fffaf3", family: "Georgia, Times New Roman, serif", weight: "700", align: "left", anchorX: 0, anchorY: 0, lineHeight: 38 });
      return;
    }

    if (variant === "promise-card") {
      const x = 48;
      const y = h * 0.36 + (1 - intro) * 34;
      const width = w - 96;
      const height = 236;
      addPetals(20, 0.13, 0.68);
      addSoftPanel({ x, y, width, height, radius: 20, fill: "paper", alpha: 0.88, ribbon: "top" });
      addReadableText({ value: "PROMISE", x: x + width * 0.5, y: y + 44, width: width - 72, fontSize: 14, minFontSize: 14, fill: accent, weight: "950" });
      addReadableText({ value: fullText, x: x + width * 0.5, y: y + 128, width: width - 78, fontSize: 40, minFontSize: 26, family: "Georgia, Times New Roman, serif", weight: "700", lineHeight: 45 });
      const seal = new this.pixi.Graphics();
      seal.ellipse(x + width - 74, y + height - 42, 30, 22).stroke({ color: accentColor, width: 2, alpha: 0.36 });
      seal.moveTo(x + width - 96, y + height - 42).lineTo(x + width - 48, y + height - 42).stroke({ color: accentColor, width: 2, alpha: 0.24 });
      this.root.addChild(seal);
      return;
    }

    if (variant === "blush-pop") {
      this.drawRomanceSparkles(accent, timeSeconds, 46, 0.1, 0.5);
      const cx = w * 0.5;
      const cy = h * 0.44 + (1 - intro) * 28;
      const bubble = new this.pixi.Graphics();
      bubble.roundRect(cx - 138, cy - 64, 276, 128, 30)
        .fill({ color: 0xfff5fb, alpha: 0.9 })
        .stroke({ color: 0xffffff, width: 3, alpha: 0.5 })
        .stroke({ color: accentColor, width: 2.5, alpha: 0.42 });
      bubble.circle(cx - 114, cy + 78, 11).fill({ color: 0xfff5fb, alpha: 0.82 });
      bubble.circle(cx - 138, cy + 96, 6).fill({ color: 0xfff5fb, alpha: 0.7 });
      this.root.addChild(bubble);
      addReadableText({ value: upperText, x: cx, y: cy, width: 220, fontSize: 48, minFontSize: 32, fill: ink, family: "Space Grotesk, Inter, system-ui", weight: "950", strokeColor: "#fff5fb", strokeWidth: 3 });
      return;
    }
  }

  drawShowcaseHorrorThrillerText(textStyle, progress, timeSeconds, variant = "cursed-warning") {
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = Math.min(Math.max(progress, 0), 1);
    const intro = easeOutCubic(Math.min(p / 0.38, 1));
    const pulse = 0.5 + Math.sin(timeSeconds * 1.7) * 0.5;
    const flicker = Math.sin(timeSeconds * 19) > 0.72 ? 1 : 0;
    const accent = textStyle.accent || "#d9163a";
    const accentColor = parsePixiColor(accent);
    const ink = textStyle.ink || "#f2f0ea";
    const rawText = String(textStyle.text || textStyle.title || "No abras esa puerta").slice(0, 104);
    const upperText = rawText.toUpperCase();

    const addGrade = (mode = "horror") => {
      const dark = this.createFxLayer({ blendMode: "multiply", alpha: 0.96 });
      const g = new this.pixi.Graphics();
      g.rect(0, 0, w, h).fill({ color: mode === "siren" ? 0x020611 : 0x030306, alpha: 0.28 });
      g.rect(0, 0, w, h * 0.2).fill({ color: 0x000000, alpha: 0.34 });
      g.rect(0, h * 0.76, w, h * 0.24).fill({ color: 0x000000, alpha: 0.42 });
      g.rect(0, 0, 52, h).fill({ color: 0x000000, alpha: 0.22 });
      g.rect(w - 52, 0, 52, h).fill({ color: 0x000000, alpha: 0.22 });
      dark.addChild(g);

      const light = this.createFxLayer({ blendMode: "screen", alpha: 0.84 });
      const wash = new this.pixi.Graphics();
      const fill = this.createFillGradient({
        type: "radial",
        center: { x: mode === "siren" ? (pulse > 0.5 ? 0.16 : 0.84) : 0.52, y: mode === "door" ? 0.28 : 0.48 },
        innerRadius: 0.02,
        outerCenter: { x: 0.5, y: 0.52 },
        outerRadius: 0.86,
        colorStops: [
          { offset: 0, color: mode === "siren" ? "rgba(80,140,255,0.22)" : `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},0.16)` },
          { offset: 0.48, color: `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},0.07)` },
          { offset: 1, color: "rgba(0,0,0,0)" },
        ],
      });
      wash.rect(0, 0, w, h).fill(fill || { color: accentColor, alpha: 0.045 });
      light.addChild(wash);
    };

    const addStatic = (alpha = 0.08) => {
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 1 });
      const g = new this.pixi.Graphics();
      for (let i = 0; i < 64; i += 1) {
        const y = 52 + ((i * 47 + timeSeconds * 18) % (h - 104));
        const x = 36 + ((i * 97) % (w - 72));
        const width = 20 + (i % 7) * 18;
        g.rect(x, y, width, 1).fill({ color: i % 4 ? 0xffffff : accentColor, alpha: alpha * (0.45 + (i % 5) * 0.16) });
      }
      layer.addChild(g);
    };

    const addReadableText = ({
      value = rawText,
      x,
      y,
      width,
      fontSize = 36,
      minFontSize = 22,
      fill = ink,
      family = "Inter, system-ui",
      weight = "900",
      align = "center",
      anchorX = 0.5,
      anchorY = 0.5,
      strokeColor = "#050509",
      strokeWidth = 4,
      lineHeight,
      alpha = 1,
    }) => {
      const text = String(value);
      const resolved = Math.max(minFontSize, fontSize - Math.max(0, text.length - 32) * 0.36);
      const label = new this.pixi.Text({
        text,
        style: {
          fontFamily: family,
          fontSize: resolved,
          fontWeight: weight,
          fill,
          align,
          wordWrap: true,
          wordWrapWidth: width,
          lineHeight: lineHeight || resolved * 1.16,
          stroke: strokeColor && strokeWidth ? { color: strokeColor, width: strokeWidth } : undefined,
        },
      });
      label.anchor.set(anchorX, anchorY);
      label.x = x + flicker * Math.sin(timeSeconds * 31) * 2;
      label.y = y;
      label.alpha = alpha - flicker * 0.12;
      this.root.addChild(label);
      return label;
    };

    const addPanel = ({
      x,
      y,
      width,
      height,
      fill = 0x050509,
      alpha = 0.82,
      strokeAlpha = 0.34,
      radius = 10,
      redLine = true,
    }) => {
      const panel = new this.pixi.Graphics();
      panel.roundRect(x, y, width, height, radius)
        .fill({ color: fill, alpha })
        .stroke({ color: 0xffffff, width: 1.5, alpha: 0.14 })
        .stroke({ color: accentColor, width: 2, alpha: strokeAlpha + flicker * 0.12 });
      if (redLine) {
        panel.rect(x + 18, y + 14, width - 36, 3).fill({ color: accentColor, alpha: 0.42 + pulse * 0.12 });
      }
      this.root.addChild(panel);
      return panel;
    };

    const addScratchMarks = (count = 9, alpha = 0.18, area = { x: 50, y: 120, width: w - 100, height: h - 240 }) => {
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.9 });
      const g = new this.pixi.Graphics();
      for (let i = 0; i < count; i += 1) {
        const x = area.x + ((i * 83 + timeSeconds * 7) % area.width);
        const y = area.y + ((i * 137) % area.height);
        const len = 32 + (i % 5) * 24;
        this.drawTaperedQuad(g, x, y, x + len, y - 18 - (i % 3) * 10, 1.2, 5 + (i % 4), i % 3 ? 0xffffff : accentColor, alpha * (0.65 + (i % 4) * 0.18));
      }
      layer.addChild(g);
    };

    const addRedactedBars = (x, y, width) => {
      const bars = new this.pixi.Graphics();
      [0, 1, 2].forEach((index) => {
        bars.roundRect(x + index * 22, y + index * 42, width - index * 44, 16, 2)
          .fill({ color: 0x030305, alpha: 0.82 });
      });
      this.root.addChild(bars);
    };

    addGrade(variant === "siren-alert" ? "siren" : variant === "shadow-title" ? "door" : "horror");

    if (variant === "cursed-warning" || variant === "ink-warning") {
      addStatic(0.06);
      addScratchMarks(12, 0.13);
      const x = 44;
      const y = h * 0.58 + (1 - intro) * 32;
      const width = w - 88;
      const height = 178;
      const inkPanel = new this.pixi.Graphics();
      inkPanel.roundRect(x - 14, y - 18, width + 28, height + 34, 5)
        .fill({ color: 0x030305, alpha: 0.88 })
        .stroke({ color: accentColor, width: 2, alpha: 0.42 + flicker * 0.18 });
      for (let i = 0; i < 14; i += 1) {
        const px = x + i * (width / 13);
        inkPanel.circle(px, y - 12 + Math.sin(i * 1.7) * 6, 5 + (i % 4) * 2).fill({ color: 0x030305, alpha: 0.9 });
        if (i % 4 === 0) inkPanel.rect(px, y + height - 6, 3, 28 + (i % 3) * 14).fill({ color: 0x030305, alpha: 0.56 });
      }
      this.root.addChild(inkPanel);
      addReadableText({ value: variant === "ink-warning" ? upperText : rawText, x: x + 26, y: y + 44, width: width - 52, fontSize: variant === "ink-warning" ? 40 : 34, minFontSize: 24, align: "left", anchorX: 0, anchorY: 0, family: variant === "ink-warning" ? "Impact, Inter, system-ui" : "Georgia, Times New Roman, serif", weight: "900", lineHeight: 43 });
      addReadableText({ value: variant === "ink-warning" ? "WARNING" : "CURSED PAGE", x: x + 26, y: y + 24, width: width - 52, fontSize: 13, minFontSize: 13, fill: accent, family: "Inter, system-ui", weight: "950", align: "left", anchorX: 0, anchorY: 0.5, strokeWidth: 0 });
      return;
    }

    if (variant === "blood-stamp") {
      addScratchMarks(18, 0.2, { x: 40, y: 130, width: w - 80, height: h - 260 });
      const cx = w * 0.5;
      const cy = h * 0.5 + (1 - intro) * 22;
      const stamp = new this.pixi.Graphics();
      stamp.roundRect(cx - 180, cy - 62, 360, 124, 8)
        .fill({ color: 0x050509, alpha: 0.68 })
        .stroke({ color: accentColor, width: 5, alpha: 0.68 })
        .stroke({ color: 0xffffff, width: 1.5, alpha: 0.22 });
      stamp.moveTo(cx - 152, cy + 42).lineTo(cx + 148, cy - 44).stroke({ color: accentColor, width: 3, alpha: 0.28 });
      stamp.rotation = -0.08 + Math.sin(timeSeconds * 3) * 0.008;
      this.root.addChild(stamp);
      addReadableText({ value: upperText, x: cx, y: cy, width: 310, fontSize: 54, minFontSize: 32, fill: "#fff7f4", family: "Impact, Space Grotesk, Inter, system-ui", weight: "950", strokeColor: "#050509", strokeWidth: 6 });
      return;
    }

    if (variant === "crime-caption") {
      addStatic(0.045);
      const x = 50;
      const y = 134 + (1 - intro) * -28;
      const width = w - 100;
      const height = 190;
      addPanel({ x, y, width, height, fill: 0x071012, alpha: 0.82, strokeAlpha: 0.22, radius: 8 });
      const grid = new this.pixi.Graphics();
      for (let i = 0; i < 5; i += 1) grid.rect(x + 28, y + 72 + i * 22, width - 56 - i * 26, 2).fill({ color: 0xffffff, alpha: 0.08 });
      grid.rect(x + width - 92, y + 28, 48, 48).stroke({ color: accentColor, width: 2, alpha: 0.34 });
      grid.moveTo(x + width - 92, y + 52).lineTo(x + width - 44, y + 52).moveTo(x + width - 68, y + 28).lineTo(x + width - 68, y + 76).stroke({ color: accentColor, width: 1.5, alpha: 0.25 });
      this.root.addChild(grid);
      addReadableText({ value: "CASE FILE", x: x + 30, y: y + 34, width: width - 60, fontSize: 13, minFontSize: 13, fill: accent, weight: "950", align: "left", anchorX: 0, anchorY: 0.5, strokeWidth: 0 });
      addReadableText({ value: rawText, x: x + 30, y: y + 82, width: width - 128, fontSize: 32, minFontSize: 23, fill: "#edf3ef", family: "Georgia, Times New Roman, serif", weight: "700", align: "left", anchorX: 0, anchorY: 0, lineHeight: 38 });
      return;
    }

    if (variant === "flicker-threat") {
      addStatic(0.12);
      const bands = this.createFxLayer({ blendMode: "screen", alpha: 0.8 });
      const g = new this.pixi.Graphics();
      for (let i = 0; i < 8; i += 1) {
        const y = 120 + ((i * 97 + timeSeconds * 80) % (h - 240));
        g.rect(0, y, w, 4 + (i % 3) * 4).fill({ color: i % 3 ? 0xffffff : accentColor, alpha: 0.045 + flicker * 0.055 });
      }
      bands.addChild(g);
      addPanel({ x: 56, y: h * 0.44 + (1 - intro) * 24, width: w - 112, height: 134, fill: 0x020407, alpha: 0.7, strokeAlpha: 0.25, radius: 6, redLine: false });
      addReadableText({ value: rawText, x: w * 0.5, y: h * 0.5, width: w - 150, fontSize: 38, minFontSize: 26, fill: "#f4f1ea", family: "Space Grotesk, Inter, system-ui", weight: "950", strokeColor: "#020407", strokeWidth: 5 });
      addReadableText({ value: "SIGNAL LOST", x: w * 0.5, y: h * 0.43, width: w - 150, fontSize: 13, minFontSize: 13, fill: accent, weight: "950", strokeWidth: 0 });
      return;
    }

    if (variant === "jumpscare") {
      const flash = this.createFxLayer({ blendMode: "screen", alpha: 0.46 });
      flash.filters = [this.createBlurFilter(0.55, 2)].filter(Boolean);
      const f = new this.pixi.Graphics();
      f.rect(0, 0, w, h).fill({ color: 0xffffff, alpha: 0.035 + intro * 0.035 + flicker * 0.025 });
      for (let i = 0; i < 14; i += 1) {
        const angle = -Math.PI * 0.72 + (i / 13) * Math.PI * 1.44;
        this.drawTaperedQuad(
          f,
          w * 0.5 + Math.cos(angle) * 82,
          h * 0.42 + Math.sin(angle) * 48,
          w * 0.5 + Math.cos(angle) * 330,
          h * 0.42 + Math.sin(angle) * 260,
          1,
          4 + (i % 3) * 2.5,
          i % 3 ? 0xffffff : accentColor,
          0.026 + intro * 0.045,
        );
      }
      flash.addChild(f);
      addReadableText({ value: upperText, x: w * 0.5 + Math.sin(timeSeconds * 29) * 2, y: h * 0.42, width: w - 130, fontSize: 78, minFontSize: 46, fill: "#fffdf4", family: "Impact, Space Grotesk, Inter, system-ui", weight: "950", strokeColor: "#050509", strokeWidth: 8 });
      return;
    }

    if (variant === "redacted-note") {
      addStatic(0.045);
      const x = 54;
      const y = h * 0.55 + (1 - intro) * 34;
      const width = w - 108;
      const height = 178;
      const paper = this.createFillGradient({
        type: "linear",
        start: { x: 0, y: 0 },
        end: { x: 1, y: 1 },
        colorStops: [
          { offset: 0, color: "rgba(246,241,226,0.9)" },
          { offset: 1, color: "rgba(198,204,196,0.82)" },
        ],
      });
      const note = new this.pixi.Graphics();
      note.roundRect(x, y, width, height, 8).fill(paper || { color: 0xe8e1cf, alpha: 0.9 }).stroke({ color: 0x050509, width: 2, alpha: 0.24 });
      note.rect(x + 24, y + 22, 92, 4).fill({ color: accentColor, alpha: 0.44 });
      this.root.addChild(note);
      addReadableText({ value: rawText, x: x + 28, y: y + 72, width: width - 56, fontSize: 30, minFontSize: 21, fill: "#151315", family: "Georgia, Times New Roman, serif", weight: "800", align: "left", anchorX: 0, anchorY: 0, strokeWidth: 0, lineHeight: 36 });
      addRedactedBars(x + 28, y + 110, width - 80);
      return;
    }

    if (variant === "shadow-title") {
      addStatic(0.045);
      const door = new this.pixi.Graphics();
      door.rect(w * 0.31, h * 0.16, w * 0.38, h * 0.62).fill({ color: 0x020203, alpha: 0.42 }).stroke({ color: 0xffffff, width: 2, alpha: 0.08 });
      door.rect(w * 0.66, h * 0.18, 4, h * 0.58).fill({ color: accentColor, alpha: 0.18 + pulse * 0.1 });
      door.circle(w * 0.63, h * 0.49, 5).fill({ color: accentColor, alpha: 0.34 + pulse * 0.22 });
      this.root.addChild(door);
      addPanel({ x: 52, y: h * 0.68 + (1 - intro) * 32, width: w - 104, height: 132, fill: 0x040406, alpha: 0.78, strokeAlpha: 0.2, radius: 8 });
      addReadableText({ value: upperText, x: w * 0.5, y: h * 0.735, width: w - 144, fontSize: 42, minFontSize: 26, fill: "#f4f1ea", family: "Space Grotesk, Inter, system-ui", weight: "950", strokeColor: "#040406", strokeWidth: 5, lineHeight: 44 });
      return;
    }

    if (variant === "typewriter") {
      addStatic(0.035);
      const x = 52;
      const y = h * 0.62 + (1 - intro) * 32;
      const width = w - 104;
      const height = 150;
      addPanel({ x, y, width, height, fill: 0xf1ebdc, alpha: 0.86, strokeAlpha: 0.16, radius: 8, redLine: false });
      const reveal = rawText.slice(0, Math.max(1, Math.floor(rawText.length * Math.min(1, p / 0.18))));
      addReadableText({ value: reveal, x: x + 30, y: y + 38, width: width - 60, fontSize: 30, minFontSize: 22, fill: "#161110", family: "Georgia, Times New Roman, serif", weight: "800", align: "left", anchorX: 0, anchorY: 0, strokeWidth: 0, lineHeight: 36 });
      const cursor = new this.pixi.Graphics();
      cursor.rect(x + 32 + Math.min(width - 76, reveal.length * 14), y + 82, 10, 28).fill({ color: accentColor, alpha: 0.45 + flicker * 0.25 });
      this.root.addChild(cursor);
      return;
    }

    if (variant === "siren-alert") {
      const siren = this.createFxLayer({ blendMode: "screen", alpha: 0.92 });
      const g = new this.pixi.Graphics();
      const redAlpha = 0.1 + Math.max(0, Math.sin(timeSeconds * 5.5)) * 0.24;
      const blueAlpha = 0.1 + Math.max(0, Math.sin(timeSeconds * 5.5 + Math.PI)) * 0.22;
      this.drawTaperedQuad(g, -70, h * 0.28, w * 0.56, h * 0.5, 120, 22, accentColor, redAlpha);
      this.drawTaperedQuad(g, w + 70, h * 0.28, w * 0.44, h * 0.5, 120, 22, 0x4b8cff, blueAlpha);
      siren.addChild(g);
      addPanel({ x: 66, y: h * 0.41 + (1 - intro) * 22, width: w - 132, height: 150, fill: 0x050509, alpha: 0.86, strokeAlpha: 0.36, radius: 12 });
      addReadableText({ value: "EMERGENCY", x: w * 0.5, y: h * 0.455, width: w - 164, fontSize: 13, minFontSize: 13, fill: "#8fb7ff", weight: "950", strokeWidth: 0 });
      addReadableText({ value: upperText, x: w * 0.5, y: h * 0.515, width: w - 164, fontSize: 54, minFontSize: 34, fill: "#fffdf4", family: "Space Grotesk, Inter, system-ui", weight: "950", strokeColor: "#050509", strokeWidth: 6 });
      return;
    }
  }

  drawShowcaseHorrorInkWarning(textStyle, progress, timeSeconds) {
    const intro = easeOutCubic(Math.min(progress / 0.38, 1));
    const flicker = Math.sin(timeSeconds * 18) > 0.72 ? 0.18 : 0;
    const accent = textStyle.accent || "#d9163a";
    const accentColor = parsePixiColor(accent);
    const text = String(textStyle.text || textStyle.title || "DO NOT OPEN THE PAGE").toUpperCase().slice(0, 64);
    const x = 46;
    const y = PIXI_PREVIEW_SIZE.height * 0.58 + (1 - intro) * 28;
    const width = PIXI_PREVIEW_SIZE.width - 92;
    const height = 178;

    this.drawVignetteLayer(0.44 + flicker);

    const ink = new this.pixi.Graphics();
    ink.roundRect(x - 18, y - 22, width + 36, height + 44, 4)
      .fill({ color: 0x050509, alpha: 0.86 + flicker });
    for (let i = 0; i < 16; i += 1) {
      const px = x - 14 + i * (width / 14);
      const top = y - 18 + Math.sin(i * 2.1) * 9;
      const bottom = y + height + 12 + Math.cos(i * 1.7) * 11;
      ink.circle(px, top, 9 + (i % 4) * 3).fill({ color: 0x050509, alpha: 0.9 });
      ink.circle(px + 12, bottom, 7 + (i % 3) * 4).fill({ color: 0x050509, alpha: 0.78 });
      if (i % 3 === 0) {
        ink.rect(px, y + height - 4, 5 + (i % 4), 42 + (i % 5) * 13)
          .fill({ color: 0x050509, alpha: 0.62 });
      }
    }
    ink.stroke({ color: accentColor, width: 2, alpha: 0.58 + flicker });
    ink.alpha = 0.72 + intro * 0.28;
    this.root.addChild(ink);

    const warning = new this.pixi.Text({
      text: "WARNING",
      style: {
        fontFamily: "Inter, system-ui",
        fontSize: 14,
        fontWeight: "950",
        fill: accent,
        letterSpacing: 0,
      },
    });
    warning.x = x + 26 + Math.sin(timeSeconds * 22) * flicker * 6;
    warning.y = y + 24;
    this.root.addChild(warning);

    const label = new this.pixi.Text({
      text,
      style: {
        fontFamily: "Bangers, Luckiest Guy, Impact, system-ui",
        fontSize: 42,
        fontWeight: "900",
        fill: textStyle.ink || "#f2f0ea",
        stroke: { color: "#050509", width: 5 },
        wordWrap: true,
        wordWrapWidth: width - 64,
        lineHeight: 45,
      },
    });
    label.x = x + 26 + Math.sin(timeSeconds * 16) * flicker * 8;
    label.y = y + 58;
    label.alpha = 0.9 + intro * 0.1 - flicker * 0.24;
    this.root.addChild(label);

    const mark = new this.pixi.Graphics();
    const mx = x + width - 92;
    const my = y + 90;
    mark.ellipse(mx, my, 46, 58)
      .stroke({ color: accentColor, width: 3, alpha: 0.22 + flicker * 0.35 });
    mark.ellipse(mx + 4, my - 2, 31, 42)
      .stroke({ color: accentColor, width: 2, alpha: 0.16 + flicker * 0.28 });
    [
      [-42, -44, 24, 34, 9, 3],
      [-18, -54, 39, 44, 6, 2],
      [10, -40, 42, 26, 5, 1],
    ].forEach(([x1, y1, x2, y2, startWidth, endWidth], index) => {
      this.drawTaperedQuad(mark, mx + x1, my + y1, mx + x2, my + y2, startWidth, endWidth, accentColor, 0.2 + index * 0.045 + flicker * 0.24);
    });
    for (let i = 0; i < 5; i += 1) {
      const dripX = mx - 34 + i * 16;
      const dripY = my + 48 + Math.sin(i * 1.7) * 5;
      mark.circle(dripX, dripY, 3 + (i % 2)).fill({ color: accentColor, alpha: 0.18 + flicker * 0.2 });
      mark.rect(dripX - 1, dripY, 2, 18 + (i % 3) * 8).fill({ color: accentColor, alpha: 0.12 + flicker * 0.18 });
    }
    this.root.addChild(mark);
  }

  drawShowcaseScifiTechText(textStyle, progress, timeSeconds, variant = "tactical-scan") {
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = Math.min(Math.max(progress, 0), 1);
    const intro = easeOutCubic(Math.min(p / 0.42, 1));
    const pulse = 0.5 + Math.sin(timeSeconds * 1.6) * 0.5;
    const glitch = Math.sin(timeSeconds * 18) > 0.74 ? 1 : 0;
    const accent = textStyle.accent || "#42f5ff";
    const accentColor = parsePixiColor(accent);
    const magenta = 0xff4dde;
    const ink = textStyle.ink || "#d9fbff";
    const rawText = String(textStyle.text || textStyle.title || "SIGNAL FOUND").slice(0, 112);
    const upperText = rawText.toUpperCase();

    const addGrade = (mode = "hud") => {
      const shade = this.createFxLayer({ blendMode: "multiply", alpha: 0.88 });
      const g = new this.pixi.Graphics();
      g.rect(0, 0, w, h).fill({ color: 0x00101a, alpha: mode === "chrome" ? 0.18 : 0.24 });
      g.rect(0, 0, w, h * 0.18).fill({ color: 0x000208, alpha: 0.28 });
      g.rect(0, h * 0.78, w, h * 0.22).fill({ color: 0x000208, alpha: 0.32 });
      shade.addChild(g);

      const glow = this.createFxLayer({ blendMode: "screen", alpha: 0.86 });
      const fill = this.createFillGradient({
        type: "radial",
        center: { x: mode === "neon" ? 0.18 : 0.54, y: mode === "launch" ? 0.74 : 0.42 },
        innerRadius: 0.02,
        outerCenter: { x: 0.5, y: 0.52 },
        outerRadius: 0.92,
        colorStops: [
          { offset: 0, color: `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},0.18)` },
          { offset: 0.42, color: mode === "neon" ? "rgba(255,77,222,0.1)" : `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},0.06)` },
          { offset: 1, color: "rgba(0,0,0,0)" },
        ],
      });
      const wash = new this.pixi.Graphics();
      wash.rect(0, 0, w, h).fill(fill || { color: accentColor, alpha: 0.04 });
      glow.addChild(wash);
    };

    const addScanlines = (alpha = 0.07, step = 22) => {
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.9 });
      const g = new this.pixi.Graphics();
      for (let y = 72; y < h - 72; y += step) {
        g.rect(34, y + ((timeSeconds * 18) % step), w - 68, 1).fill({ color: 0xffffff, alpha });
      }
      layer.addChild(g);
    };

    const addGrid = (alpha = 0.12) => {
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.72 });
      const g = new this.pixi.Graphics();
      for (let i = 0; i < 8; i += 1) {
        const x = 58 + i * 78;
        g.moveTo(x, 94).lineTo(x - 36, h - 98).stroke({ color: accentColor, width: 1, alpha: alpha * 0.45 });
      }
      for (let i = 0; i < 9; i += 1) {
        const y = 120 + i * 72;
        g.moveTo(44, y).lineTo(w - 44, y + Math.sin(i) * 16).stroke({ color: i % 3 ? accentColor : magenta, width: 1, alpha: alpha * (0.45 + (i % 4) * 0.12) });
      }
      layer.addChild(g);
    };

    const addPanel = ({
      x,
      y,
      width,
      height,
      fill = 0x001722,
      alpha = 0.74,
      strokeAlpha = 0.5,
      radius = 8,
      brackets = true,
    }) => {
      const panel = new this.pixi.Graphics();
      panel.roundRect(x, y, width, height, radius)
        .fill({ color: fill, alpha })
        .stroke({ color: accentColor, width: 2, alpha: strokeAlpha + pulse * 0.08 });
      panel.rect(x + 18, y + 16, 84, 3).fill({ color: accentColor, alpha: 0.58 + pulse * 0.1 });
      panel.rect(x + width - 102, y + height - 19, 84, 3).fill({ color: variant.includes("breach") ? magenta : accentColor, alpha: 0.44 + pulse * 0.12 });
      if (brackets) {
        panel.moveTo(x + 16, y + 42).lineTo(x + 16, y + 16).lineTo(x + 42, y + 16)
          .moveTo(x + width - 16, y + height - 42).lineTo(x + width - 16, y + height - 16).lineTo(x + width - 42, y + height - 16)
          .stroke({ color: 0xffffff, width: 2, alpha: 0.18 });
      }
      this.root.addChild(panel);
      return panel;
    };

    const addReadableText = ({
      value = rawText,
      x,
      y,
      width,
      fontSize = 36,
      minFontSize = 22,
      fill = ink,
      family = "Space Grotesk, Inter, system-ui",
      weight = "850",
      align = "left",
      anchorX = 0,
      anchorY = 0,
      strokeColor = "#001018",
      strokeWidth = 3,
      lineHeight,
      alpha = 1,
    }) => {
      const text = String(value);
      const resolved = Math.max(minFontSize, fontSize - Math.max(0, text.length - 34) * 0.34);
      const label = new this.pixi.Text({
        text,
        style: {
          fontFamily: family,
          fontSize: resolved,
          fontWeight: weight,
          fill,
          align,
          wordWrap: true,
          wordWrapWidth: width,
          lineHeight: lineHeight || resolved * 1.14,
          stroke: strokeColor && strokeWidth ? { color: strokeColor, width: strokeWidth } : undefined,
        },
      });
      label.anchor.set(anchorX, anchorY);
      label.x = x + glitch * Math.sin(timeSeconds * 31) * 2.2;
      label.y = y + glitch * Math.cos(timeSeconds * 23) * 1.6;
      label.alpha = alpha - glitch * 0.08;
      this.root.addChild(label);
      return label;
    };

    const addDataBars = (x, y, width, rows = 6, alpha = 0.2) => {
      const bars = new this.pixi.Graphics();
      for (let i = 0; i < rows; i += 1) {
        const bw = width * (0.26 + ((i * 0.17 + pulse * 0.08) % 0.58));
        bars.rect(x, y + i * 18, bw, 4).fill({ color: i % 3 ? accentColor : magenta, alpha: alpha + (i % 3) * 0.035 });
      }
      this.root.addChild(bars);
    };

    const addReticle = (cx, cy, r = 44, alpha = 0.5) => {
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.86 });
      const g = new this.pixi.Graphics();
      g.circle(cx, cy, r + pulse * 4).stroke({ color: accentColor, width: 2, alpha });
      g.circle(cx, cy, r * 0.5).stroke({ color: 0xffffff, width: 1.5, alpha: alpha * 0.5 });
      g.moveTo(cx - r - 24, cy).lineTo(cx - r * 0.45, cy).moveTo(cx + r * 0.45, cy).lineTo(cx + r + 24, cy)
        .moveTo(cx, cy - r - 24).lineTo(cx, cy - r * 0.45).moveTo(cx, cy + r * 0.45).lineTo(cx, cy + r + 24)
        .stroke({ color: accentColor, width: 2, alpha: alpha * 0.72 });
      layer.addChild(g);
    };

    addGrade(variant.includes("neon") ? "neon" : variant.includes("launch") ? "launch" : variant.includes("chrome") ? "chrome" : "hud");
    addScanlines(variant.includes("signal") || variant.includes("breach") ? 0.1 : 0.055);

    if (variant === "tactical-scan" || variant === "classic-hud") {
      addGrid(0.1);
      const x = 50;
      const y = 150 + (1 - intro) * -34;
      const width = w - 100;
      const height = variant === "classic-hud" ? 198 : 220;
      addPanel({ x, y, width, height, alpha: 0.68, strokeAlpha: 0.56 });
      const scanY = y + 58 + ((timeSeconds * 70) % (height - 82));
      const scan = new this.pixi.Graphics();
      scan.rect(x + 20, scanY, width - 40, 6).fill({ color: 0xffffff, alpha: 0.12 });
      scan.rect(x + 20, scanY + 7, width - 40, 2).fill({ color: accentColor, alpha: 0.36 });
      this.root.addChild(scan);
      addReadableText({ value: variant === "classic-hud" ? "SCAN / P2R-04" : "TACTICAL SCAN", x: x + 28, y: y + 26, width: width - 56, fontSize: 14, minFontSize: 14, fill: accent, weight: "950", strokeWidth: 0 });
      addReadableText({ value: upperText, x: x + 28, y: y + 78, width: width - 166, fontSize: 35, minFontSize: 23, fill: ink, weight: "950", lineHeight: 40 });
      addDataBars(x + 28, y + height - 82, width - 178, 4, 0.16);
      addReticle(x + width - 78, y + 116, 34, 0.58);
      return;
    }

    if (variant === "hologram-nameplate") {
      addGrid(0.08);
      const x = 54;
      const y = h * 0.63 + (1 - intro) * 34;
      const width = w - 108;
      const height = 142;
      addPanel({ x, y, width, height, alpha: 0.62, strokeAlpha: 0.48, radius: 6 });
      const ghost = this.createFxLayer({ blendMode: "screen", alpha: 0.72 });
      const g = new this.pixi.Graphics();
      for (let i = 0; i < 7; i += 1) {
        g.rect(x + 28 + i * 52, y + 28 + Math.sin(timeSeconds * 2 + i) * 4, 34, 78 - i * 5)
          .fill({ color: i % 2 ? accentColor : 0xffffff, alpha: 0.055 + pulse * 0.03 });
      }
      ghost.addChild(g);
      addReadableText({ value: "IDENT VERIFIED", x: x + 32, y: y + 28, width: width - 64, fontSize: 13, minFontSize: 13, fill: accent, weight: "950", strokeWidth: 0 });
      addReadableText({ value: upperText, x: x + width * 0.5, y: y + 82, width: width - 78, fontSize: 46, minFontSize: 30, align: "center", anchorX: 0.5, anchorY: 0.5, fill: "#effdff", weight: "950", strokeWidth: 4 });
      return;
    }

    if (variant === "system-breach") {
      addGrid(0.12);
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.9 });
      const g = new this.pixi.Graphics();
      for (let i = 0; i < 12; i += 1) {
        const y = 140 + ((i * 79 + timeSeconds * 130) % (h - 280));
        g.rect(0, y, w, 4 + (i % 4) * 3).fill({ color: i % 2 ? accentColor : magenta, alpha: 0.05 + glitch * 0.08 });
      }
      layer.addChild(g);
      addReadableText({ value: upperText, x: w * 0.5, y: h * 0.45, width: w - 110, fontSize: 76, minFontSize: 44, align: "center", anchorX: 0.5, anchorY: 0.5, fill: "#ffffff", family: "Space Grotesk, Inter, system-ui", weight: "950", strokeColor: "#001018", strokeWidth: 8 });
      addReadableText({ value: "SYSTEM BREACH", x: w * 0.5, y: h * 0.55, width: w - 140, fontSize: 13, minFontSize: 13, align: "center", anchorX: 0.5, anchorY: 0.5, fill: "#ff4dde", weight: "950", strokeWidth: 0 });
      return;
    }

    if (variant === "data-fragment") {
      const x = 54;
      const y = h * 0.58 + (1 - intro) * 34;
      const width = w - 108;
      const height = 174;
      addPanel({ x, y, width, height, alpha: 0.75, strokeAlpha: 0.36, radius: 8 });
      addReadableText({ value: "DATA FRAGMENT", x: x + 30, y: y + 28, width: width - 60, fontSize: 13, minFontSize: 13, fill: accent, weight: "950", strokeWidth: 0 });
      addReadableText({ value: rawText, x: x + 30, y: y + 66, width: width - 60, fontSize: 32, minFontSize: 23, fill: "#e8fbff", family: "Inter, system-ui", weight: "850", lineHeight: 38 });
      addDataBars(x + 30, y + height - 54, width - 60, 3, 0.17);
      return;
    }

    if (variant === "mecha-launch") {
      addGrid(0.1);
      const y = h * 0.46 + (1 - intro) * 26;
      const band = new this.pixi.Graphics();
      band.rect(0, y - 68, w, 154).fill({ color: 0x001018, alpha: 0.74 }).stroke({ color: accentColor, width: 2, alpha: 0.34 });
      band.rect(44, y - 50, w - 88, 5).fill({ color: accentColor, alpha: 0.58 + pulse * 0.14 });
      band.rect(44, y + 56, w - 88, 3).fill({ color: magenta, alpha: 0.28 + pulse * 0.12 });
      this.root.addChild(band);
      addReadableText({ value: "LAUNCH SEQUENCE", x: w * 0.5, y: y - 30, width: w - 120, fontSize: 13, minFontSize: 13, fill: accent, align: "center", anchorX: 0.5, anchorY: 0.5, weight: "950", strokeWidth: 0 });
      addReadableText({ value: upperText, x: w * 0.5, y: y + 22, width: w - 116, fontSize: 40, minFontSize: 27, fill: "#effdff", align: "center", anchorX: 0.5, anchorY: 0.5, weight: "950", lineHeight: 43 });
      return;
    }

    if (variant === "neon-hook") {
      addGrid(0.18);
      const x = 48;
      const y = h * 0.62 + (1 - intro) * 38;
      const width = w - 96;
      const height = 152;
      addPanel({ x, y, width, height, fill: 0x020a14, alpha: 0.78, strokeAlpha: 0.42, radius: 10 });
      const neon = this.createFxLayer({ blendMode: "screen", alpha: 0.76 });
      const g = new this.pixi.Graphics();
      this.drawTaperedQuad(g, -70, y + 26, w + 70, y - 54, 2, 22, magenta, 0.08 + pulse * 0.04);
      this.drawTaperedQuad(g, -70, y + height + 42, w + 70, y + height - 36, 2, 18, accentColor, 0.08 + pulse * 0.04);
      neon.addChild(g);
      addReadableText({ value: rawText, x: x + 28, y: y + 52, width: width - 56, fontSize: 38, minFontSize: 25, fill: "#f4fdff", weight: "950", lineHeight: 42 });
      addReadableText({ value: "CITY FEED", x: x + 28, y: y + 28, width: width - 56, fontSize: 13, minFontSize: 13, fill: "#ff4dde", weight: "950", strokeWidth: 0 });
      return;
    }

    if (variant === "ai-diagnosis") {
      const x = 42;
      const y = 132 + (1 - intro) * -30;
      const width = w - 84;
      const height = 222;
      addPanel({ x, y, width, height, alpha: 0.76, strokeAlpha: 0.42, radius: 8 });
      addReadableText({ value: "AI DIAGNOSIS", x: x + 30, y: y + 28, width: width - 60, fontSize: 13, minFontSize: 13, fill: accent, weight: "950", strokeWidth: 0 });
      addReadableText({ value: rawText, x: x + 30, y: y + 70, width: width - 100, fontSize: 31, minFontSize: 21, fill: "#e8fbff", family: "Inter, system-ui", weight: "850", lineHeight: 37 });
      const gauge = new this.pixi.Graphics();
      gauge.roundRect(x + 30, y + height - 58, width - 60, 12, 6).fill({ color: 0xffffff, alpha: 0.08 });
      gauge.roundRect(x + 30, y + height - 58, (width - 60) * (0.18 + pulse * 0.05), 12, 6).fill({ color: magenta, alpha: 0.55 });
      gauge.rect(x + width - 78, y + 54, 42, 42).stroke({ color: accentColor, width: 2, alpha: 0.32 });
      this.root.addChild(gauge);
      return;
    }

    if (variant === "chrome-card") {
      addGrid(0.08);
      const x = 58;
      const y = h * 0.35 + (1 - intro) * 32;
      const width = w - 116;
      const height = 226;
      const chromeFill = this.createFillGradient({
        type: "linear",
        start: { x: 0, y: 0 },
        end: { x: 1, y: 1 },
        colorStops: [
          { offset: 0, color: "rgba(255,255,255,0.16)" },
          { offset: 0.28, color: "rgba(50,245,255,0.2)" },
          { offset: 0.52, color: "rgba(10,20,32,0.78)" },
          { offset: 0.78, color: "rgba(255,77,222,0.12)" },
          { offset: 1, color: "rgba(255,255,255,0.18)" },
        ],
      });
      const card = new this.pixi.Graphics();
      card.roundRect(x, y, width, height, 14).fill(chromeFill || { color: 0x071621, alpha: 0.82 }).stroke({ color: accentColor, width: 2, alpha: 0.44 });
      card.rect(x + 34, y + 34, width - 68, 4).fill({ color: 0xffffff, alpha: 0.2 });
      card.rect(x + 34, y + height - 42, width - 68, 3).fill({ color: magenta, alpha: 0.3 });
      this.root.addChild(card);
      addReadableText({ value: "EPISODE FILE", x: w * 0.5, y: y + 58, width: width - 90, fontSize: 13, minFontSize: 13, fill: accent, align: "center", anchorX: 0.5, anchorY: 0.5, weight: "950", strokeWidth: 0 });
      addReadableText({ value: upperText, x: w * 0.5, y: y + 124, width: width - 84, fontSize: 42, minFontSize: 27, fill: "#f4fdff", align: "center", anchorX: 0.5, anchorY: 0.5, weight: "950", lineHeight: 45 });
      return;
    }

    if (variant === "signal-lost") {
      addGrid(0.1);
      const bands = this.createFxLayer({ blendMode: "screen", alpha: 0.8 });
      const g = new this.pixi.Graphics();
      for (let i = 0; i < 9; i += 1) {
        const y = 120 + ((i * 91 + timeSeconds * 92) % (h - 240));
        g.rect(0, y, w, 3 + (i % 4) * 3).fill({ color: i % 2 ? accentColor : magenta, alpha: 0.04 + glitch * 0.07 });
      }
      bands.addChild(g);
      addPanel({ x: 68, y: h * 0.43 + (1 - intro) * 24, width: w - 136, height: 138, alpha: 0.72, strokeAlpha: 0.36, radius: 8 });
      addReadableText({ value: "COMMS OFFLINE", x: w * 0.5, y: h * 0.468, width: w - 160, fontSize: 13, minFontSize: 13, fill: "#ff4dde", align: "center", anchorX: 0.5, anchorY: 0.5, weight: "950", strokeWidth: 0 });
      addReadableText({ value: upperText, x: w * 0.5, y: h * 0.525, width: w - 160, fontSize: 42, minFontSize: 28, fill: "#f4fdff", align: "center", anchorX: 0.5, anchorY: 0.5, weight: "950", strokeWidth: 5 });
      return;
    }
  }

  drawShowcaseComicSuperheroText(textStyle, progress, timeSeconds, variant = "hero-pop") {
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = Math.min(Math.max(progress, 0), 1);
    const intro = easeOutBack(Math.min(p / 0.36, 1));
    const settle = easeOutCubic(Math.min(p / 0.5, 1));
    const pulse = 0.5 + Math.sin(timeSeconds * 2.2) * 0.5;
    const hit = Math.max(0, Math.sin(timeSeconds * 4.2)) * 0.5 + 0.5;
    const accent = textStyle.accent || "#ffdd45";
    const accentColor = parsePixiColor(accent);
    const red = 0xe43135;
    const blue = 0x1f63ff;
    const paper = 0xfff2c4;
    const inkColor = textStyle.ink || "#081018";
    const rawText = String(textStyle.text || textStyle.title || "POW!").slice(0, 112);
    const upperText = rawText.toUpperCase();

    const addPrintGrade = (mode = "primary") => {
      const shade = this.createFxLayer({ blendMode: "multiply", alpha: 0.66 });
      const g = new this.pixi.Graphics();
      g.rect(0, 0, w, h).fill({ color: 0x061018, alpha: 0.1 });
      g.rect(0, 0, w, h * 0.18).fill({ color: 0x0b1015, alpha: 0.18 });
      g.rect(0, h * 0.78, w, h * 0.22).fill({ color: 0x0b1015, alpha: 0.24 });
      shade.addChild(g);

      const wash = this.createFxLayer({ blendMode: "screen", alpha: 0.78 });
      const fill = this.createFillGradient({
        type: "radial",
        center: { x: mode === "villain" ? 0.18 : 0.55, y: mode === "retro" ? 0.26 : 0.42 },
        innerRadius: 0.02,
        outerCenter: { x: 0.5, y: 0.5 },
        outerRadius: 0.86,
        colorStops: [
          { offset: 0, color: `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},0.16)` },
          { offset: 0.48, color: mode === "villain" ? "rgba(228,49,53,0.1)" : "rgba(31,99,255,0.06)" },
          { offset: 1, color: "rgba(0,0,0,0)" },
        ],
      });
      const glow = new this.pixi.Graphics();
      glow.rect(0, 0, w, h).fill(fill || { color: accentColor, alpha: 0.04 });
      wash.addChild(glow);

      const dots = this.createFxLayer({ blendMode: "multiply", alpha: 0.34 });
      const d = new this.pixi.Graphics();
      for (let yy = 84; yy < h - 48; yy += 42) {
        for (let xx = 30; xx < w - 20; xx += 42) {
          const size = 3.5 + ((xx + yy) % 5) + pulse * 1.2;
          d.circle(xx, yy, size).fill({ color: mode === "villain" ? red : accentColor, alpha: 0.08 });
        }
      }
      dots.addChild(d);
    };

    const addReadableText = ({
      value = rawText,
      x,
      y,
      width,
      fontSize = 40,
      minFontSize = 22,
      fill = "#ffffff",
      family = "Space Grotesk, Impact, Inter, system-ui",
      weight = "950",
      align = "center",
      anchorX = 0.5,
      anchorY = 0.5,
      strokeColor = "#071017",
      strokeWidth = 5,
      lineHeight,
      rotation = 0,
      alpha = 1,
    }) => {
      const valueText = String(value);
      const resolved = Math.max(minFontSize, fontSize - Math.max(0, valueText.length - 28) * 0.36);
      const label = new this.pixi.Text({
        text: valueText,
        style: {
          fontFamily: family,
          fontSize: resolved,
          fontWeight: weight,
          fill,
          align,
          wordWrap: true,
          wordWrapWidth: width,
          lineHeight: lineHeight || resolved * 1.08,
          stroke: strokeWidth ? { color: strokeColor, width: strokeWidth } : undefined,
        },
      });
      label.anchor.set(anchorX, anchorY);
      label.x = x;
      label.y = y;
      label.rotation = rotation;
      label.alpha = alpha;
      this.root.addChild(label);
      return label;
    };

    const addComicPanel = ({ x, y, width, height, fill = paper, stroke = 0x071017, alpha = 0.92, radius = 8, shadow = true }) => {
      const panel = new this.pixi.Graphics();
      if (shadow) panel.roundRect(x + 10, y + 12, width, height, radius).fill({ color: 0x050509, alpha: 0.38 });
      panel.roundRect(x, y, width, height, radius)
        .fill({ color: fill, alpha })
        .stroke({ color: stroke, width: 4, alpha: 0.94 });
      this.root.addChild(panel);
      return panel;
    };

    const addOffsetBand = ({ y, height, fill = red, alpha = 0.9, slope = -42, stroke = true }) => {
      const band = new this.pixi.Graphics();
      band.moveTo(-36, y + slope)
        .lineTo(w + 36, y)
        .lineTo(w + 36, y + height)
        .lineTo(-36, y + height + slope)
        .closePath()
        .fill({ color: fill, alpha });
      if (stroke) {
        band.moveTo(-36, y + slope).lineTo(w + 36, y)
          .moveTo(-36, y + height + slope).lineTo(w + 36, y + height)
          .stroke({ color: 0x071017, width: 5, alpha: 0.82 });
      }
      this.root.addChild(band);
      return band;
    };

    const addBurstRibbons = (cx, cy, options = {}) => {
      const layer = this.createFxLayer({ blendMode: options.blend || "screen", alpha: options.alpha ?? 0.86 });
      const g = new this.pixi.Graphics();
      const count = options.count || 18;
      for (let i = 0; i < count; i += 1) {
        const angle = -Math.PI + (i / count) * Math.PI * 2 + (options.rotate || 0);
        const inner = options.inner || 86;
        const outer = options.outer || 520;
        const startW = options.startWidth || 4;
        const endW = options.endWidth || (10 + (i % 4) * 4);
        const color = i % 3 === 0 ? 0xffffff : i % 3 === 1 ? accentColor : red;
        this.drawTaperedQuad(
          g,
          cx + Math.cos(angle) * inner,
          cy + Math.sin(angle) * inner * 0.78,
          cx + Math.cos(angle) * outer,
          cy + Math.sin(angle) * outer * 0.78,
          startW,
          endW,
          color,
          (options.lineAlpha || 0.075) + settle * 0.06,
        );
      }
      layer.addChild(g);
    };

    const addLightning = (points, color = accentColor, alpha = 0.72) => {
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.96 });
      const g = new this.pixi.Graphics();
      for (let i = 0; i < points.length - 1; i += 1) {
        const a = points[i];
        const b = points[i + 1];
        this.drawTaperedQuad(g, a[0], a[1], b[0], b[1], 8 - i * 0.7, 7 - i * 0.55, 0xffffff, alpha * 0.7);
        this.drawTaperedQuad(g, a[0], a[1], b[0], b[1], 18 - i, 16 - i, color, alpha * 0.22);
      }
      layer.addChild(g);
    };

    addPrintGrade(variant.includes("villain") ? "villain" : variant.includes("retro") ? "retro" : "primary");

    if (variant === "hero-pop") {
      addBurstRibbons(w * 0.5, h * 0.42, { count: 22, inner: 54, outer: 620, lineAlpha: 0.09, endWidth: 18 });
      const group = new this.pixi.Container();
      group.x = w * 0.5;
      group.y = h * 0.43;
      group.rotation = -0.08 + Math.sin(timeSeconds * 2.5) * 0.01;
      group.scale.set(0.78 + intro * 0.22 + hit * 0.02);
      this.root.addChild(group);

      const plate = new this.pixi.Graphics();
      plate.roundRect(-182, -94, 364, 188, 10).fill({ color: 0x071017, alpha: 0.96 });
      plate.roundRect(-170, -82, 340, 164, 8).fill({ color: accentColor, alpha: 0.96 }).stroke({ color: 0xffffff, width: 5, alpha: 0.94 });
      plate.rect(-160, -72, 320, 24).fill({ color: red, alpha: 0.88 });
      group.addChild(plate);

      const label = new this.pixi.Text({
        text: upperText,
        style: {
          fontFamily: "Bangers, Impact, Space Grotesk, system-ui",
          fontSize: Math.max(48, 92 - Math.max(0, upperText.length - 5) * 8),
          fontWeight: "950",
          fill: "#ffffff",
          align: "center",
          stroke: { color: "#071017", width: 9 },
          dropShadow: { color: "#e43135", blur: 0, angle: Math.PI / 4, distance: 8, alpha: 0.9 },
        },
      });
      label.anchor.set(0.5);
      label.y = 6;
      group.addChild(label);
      return;
    }

    if (variant === "halftone-title") {
      addOffsetBand({ y: h * 0.28, height: 118, fill: blue, alpha: 0.82, slope: 36 });
      addOffsetBand({ y: h * 0.39, height: 144, fill: red, alpha: 0.9, slope: -46 });
      addComicPanel({ x: 48, y: h * 0.32 + (1 - intro) * -28, width: w - 96, height: 244, fill: paper, radius: 8 });
      addReadableText({ value: "SPECIAL ISSUE", x: w * 0.5, y: h * 0.365, width: w - 132, fontSize: 16, minFontSize: 16, fill: "#e43135", strokeWidth: 0, family: "Inter, system-ui", weight: "950" });
      addReadableText({ value: upperText, x: w * 0.5, y: h * 0.455, width: w - 138, fontSize: 52, minFontSize: 30, fill: "#071017", strokeColor: "#fff8d9", strokeWidth: 3, lineHeight: 55 });
      addReadableText({ value: "FULL COLOR ACTION", x: w * 0.5, y: h * 0.57, width: w - 150, fontSize: 14, minFontSize: 14, fill: "#1f63ff", strokeWidth: 0, family: "Inter, system-ui", weight: "950" });
      return;
    }

    if (variant === "villain-nameplate") {
      const y = h * 0.64 + (1 - intro) * 34;
      addOffsetBand({ y: y - 28, height: 122, fill: 0x071017, alpha: 0.9, slope: -28 });
      const slash = this.createFxLayer({ blendMode: "screen", alpha: 0.76 });
      const g = new this.pixi.Graphics();
      this.drawTaperedQuad(g, -60, y + 84, w * 0.64, y - 22, 3, 24, red, 0.24);
      this.drawTaperedQuad(g, w + 60, y - 26, w * 0.48, y + 98, 3, 20, accentColor, 0.18);
      slash.addChild(g);
      addReadableText({ value: "CHARACTER FILE", x: 76, y: y + 10, width: w - 140, fontSize: 13, minFontSize: 13, fill: accent, align: "left", anchorX: 0, anchorY: 0.5, strokeWidth: 0, family: "Inter, system-ui", weight: "950" });
      addReadableText({ value: upperText, x: 76, y: y + 66, width: w - 144, fontSize: 44, minFontSize: 27, fill: "#ffffff", align: "left", anchorX: 0, anchorY: 0.5, strokeColor: "#071017", strokeWidth: 6, lineHeight: 45 });
      return;
    }

    if (variant === "lightning-callout") {
      addLightning([[90, 165], [228, 310], [168, 364], [330, 524], [270, 574], [438, 754]], accentColor, 0.66 + pulse * 0.16);
      addLightning([[w - 70, 120], [360, 278], [430, 338], [280, 486], [350, 534], [168, 760]], blue, 0.42 + pulse * 0.14);
      const y = h * 0.43;
      addOffsetBand({ y: y - 70, height: 146, fill: paper, alpha: 0.96, slope: -28 });
      addReadableText({ value: upperText, x: w * 0.5, y, width: w - 92, fontSize: 82, minFontSize: 44, fill: "#071017", family: "Bangers, Impact, Space Grotesk, system-ui", strokeColor: "#ffffff", strokeWidth: 7, rotation: -0.05 + Math.sin(timeSeconds * 3.5) * 0.015 });
      return;
    }

    if (variant === "cover-blurb") {
      const x = 44;
      const y = 126 + (1 - intro) * -24;
      addComicPanel({ x, y, width: w - 88, height: 206, fill: paper, radius: 8 });
      const top = new this.pixi.Graphics();
      top.rect(x, y, w - 88, 44).fill({ color: red, alpha: 0.92 });
      top.rect(x + 24, y + 62, w - 136, 5).fill({ color: accentColor, alpha: 0.82 });
      this.root.addChild(top);
      addReadableText({ value: "EXCLUSIVE", x: w * 0.5, y: y + 23, width: w - 130, fontSize: 15, minFontSize: 15, fill: "#ffffff", strokeWidth: 0, family: "Inter, system-ui", weight: "950" });
      addReadableText({ value: rawText, x: x + 28, y: y + 92, width: w - 144, fontSize: 32, minFontSize: 22, fill: "#071017", align: "left", anchorX: 0, anchorY: 0.5, strokeWidth: 0, family: "Space Grotesk, Inter, system-ui", weight: "950", lineHeight: 36 });
      return;
    }

    if (variant === "team-up") {
      addOffsetBand({ y: h * 0.34, height: 132, fill: red, alpha: 0.92, slope: -42 });
      addOffsetBand({ y: h * 0.48, height: 98, fill: blue, alpha: 0.78, slope: 34, stroke: false });
      addReadableText({ value: "TEAM-UP", x: w * 0.5, y: h * 0.395, width: w - 96, fontSize: 19, minFontSize: 19, fill: accent, strokeColor: "#071017", strokeWidth: 4, family: "Inter, system-ui", weight: "950", rotation: -0.07 });
      addReadableText({ value: upperText, x: w * 0.5, y: h * 0.46, width: w - 92, fontSize: 51, minFontSize: 30, fill: "#ffffff", strokeColor: "#071017", strokeWidth: 7, rotation: -0.07, lineHeight: 52 });
      return;
    }

    if (variant === "power-stat") {
      const x = 48;
      const y = h * 0.58 + (1 - intro) * 34;
      addComicPanel({ x, y, width: w - 96, height: 184, fill: 0x071017, stroke: accentColor, alpha: 0.88, radius: 8 });
      addReadableText({ value: "POWER INDEX", x: x + 28, y: y + 32, width: w - 150, fontSize: 13, minFontSize: 13, fill: accent, align: "left", anchorX: 0, strokeWidth: 0, family: "Inter, system-ui", weight: "950" });
      addReadableText({ value: rawText, x: x + 28, y: y + 82, width: w - 150, fontSize: 30, minFontSize: 21, fill: "#ffffff", align: "left", anchorX: 0, strokeColor: "#071017", strokeWidth: 3, family: "Inter, Space Grotesk, system-ui", weight: "900", lineHeight: 35 });
      const meter = new this.pixi.Graphics();
      for (let i = 0; i < 8; i += 1) {
        meter.roundRect(x + 28 + i * 44, y + 136, 32, 20, 4).fill({ color: i < 6 ? (i % 2 ? accentColor : red) : 0xffffff, alpha: i < 6 ? 0.76 : 0.16 });
      }
      this.root.addChild(meter);
      return;
    }

    if (variant === "retro-stamp") {
      const x = w * 0.5;
      const y = h * 0.43;
      addBurstRibbons(x, y, { count: 14, inner: 120, outer: 520, lineAlpha: 0.045, endWidth: 9, blend: "multiply", alpha: 0.48 });
      const stamp = new this.pixi.Graphics();
      stamp.roundRect(72, y - 92 + (1 - intro) * 22, w - 144, 184, 18)
        .fill({ color: paper, alpha: 0.9 })
        .stroke({ color: red, width: 7, alpha: 0.78 });
      stamp.roundRect(92, y - 70 + (1 - intro) * 22, w - 184, 140, 14)
        .stroke({ color: 0x071017, width: 3, alpha: 0.76 });
      this.root.addChild(stamp);
      addReadableText({ value: upperText, x, y, width: w - 190, fontSize: 46, minFontSize: 27, fill: "#e43135", strokeColor: "#fff4c9", strokeWidth: 4, rotation: -0.055 });
      addReadableText({ value: "PRINT EDITION", x, y: y + 64, width: w - 190, fontSize: 13, minFontSize: 13, fill: "#071017", strokeWidth: 0, family: "Inter, system-ui", weight: "950", rotation: -0.055 });
      return;
    }

    if (variant === "action-narration") {
      const x = 42;
      const y = h * 0.14 + (1 - intro) * -24;
      addComicPanel({ x, y, width: w - 84, height: 176, fill: 0xffe36e, stroke: 0x071017, alpha: 0.94, radius: 4 });
      const stripe = new this.pixi.Graphics();
      stripe.rect(x + 18, y + 18, 76, 8).fill({ color: red, alpha: 0.86 });
      stripe.rect(x + 104, y + 18, 126, 8).fill({ color: blue, alpha: 0.66 });
      this.root.addChild(stripe);
      addReadableText({ value: rawText, x: x + 28, y: y + 78, width: w - 140, fontSize: 31, minFontSize: 22, fill: "#071017", align: "left", anchorX: 0, anchorY: 0.5, strokeWidth: 0, family: "Georgia, Times New Roman, serif", weight: "900", lineHeight: 36 });
      return;
    }

    if (variant === "final-promise") {
      const y = h * 0.66 + (1 - intro) * 36;
      addOffsetBand({ y: y - 50, height: 156, fill: 0x071017, alpha: 0.92, slope: 28 });
      const glow = this.createFxLayer({ blendMode: "screen", alpha: 0.86 });
      this.drawSoftBeam(glow, -80, y + 76, w + 80, y - 54, 94, accentColor, 0.13 + pulse * 0.05, { blur: 1.4 });
      addReadableText({ value: "NEXT PANEL", x: w * 0.5, y: y - 14, width: w - 126, fontSize: 14, minFontSize: 14, fill: accent, strokeWidth: 0, family: "Inter, system-ui", weight: "950" });
      addReadableText({ value: upperText, x: w * 0.5, y: y + 50, width: w - 120, fontSize: 37, minFontSize: 24, fill: "#ffffff", strokeColor: "#071017", strokeWidth: 6, lineHeight: 41 });
    }
  }

  drawShowcasePromoSocialText(textStyle, progress, timeSeconds, variant = "release-banner") {
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = Math.min(Math.max(progress, 0), 1);
    const intro = easeOutCubic(Math.min(p / 0.34, 1));
    const pop = easeOutBack(Math.min(p / 0.4, 1));
    const pulse = 0.5 + Math.sin(timeSeconds * 2.1) * 0.5;
    const accent = textStyle.accent || "#55f0c8";
    const accentColor = parsePixiColor(accent);
    const magenta = 0xff3d7f;
    const gold = 0xffd84d;
    const ink = textStyle.ink || "#f8f6ff";
    const rawText = String(textStyle.text || textStyle.title || "NEW CHAPTER").slice(0, 116);
    const upperText = rawText.toUpperCase();

    const addPromoGrade = (mode = "dark") => {
      const shade = this.createFxLayer({ blendMode: "multiply", alpha: 0.78 });
      const g = new this.pixi.Graphics();
      g.rect(0, 0, w, h).fill({ color: 0x02040a, alpha: mode === "paper" ? 0.18 : 0.26 });
      g.rect(0, 0, w, h * 0.2).fill({ color: 0x02040a, alpha: 0.24 });
      g.rect(0, h * 0.72, w, h * 0.28).fill({ color: 0x02040a, alpha: 0.34 });
      shade.addChild(g);

      const glow = this.createFxLayer({ blendMode: "screen", alpha: 0.82 });
      const fill = this.createFillGradient({
        type: "radial",
        center: { x: mode === "countdown" ? 0.5 : 0.18, y: mode === "cover" ? 0.32 : 0.72 },
        innerRadius: 0.04,
        outerCenter: { x: 0.5, y: 0.5 },
        outerRadius: 0.9,
        colorStops: [
          { offset: 0, color: `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},0.16)` },
          { offset: 0.5, color: mode === "cover" ? "rgba(255,61,127,0.08)" : "rgba(255,216,77,0.05)" },
          { offset: 1, color: "rgba(0,0,0,0)" },
        ],
      });
      const wash = new this.pixi.Graphics();
      wash.rect(0, 0, w, h).fill(fill || { color: accentColor, alpha: 0.04 });
      glow.addChild(wash);
    };

    const addReadableText = ({
      value = rawText,
      x,
      y,
      width,
      fontSize = 34,
      minFontSize = 21,
      fill = ink,
      family = "Inter, Space Grotesk, system-ui",
      weight = "900",
      align = "center",
      anchorX = 0.5,
      anchorY = 0.5,
      strokeColor = "#05070d",
      strokeWidth = 3,
      lineHeight,
      rotation = 0,
      alpha = 1,
    }) => {
      const valueText = String(value);
      const resolved = Math.max(minFontSize, fontSize - Math.max(0, valueText.length - 34) * 0.28);
      const label = new this.pixi.Text({
        text: valueText,
        style: {
          fontFamily: family,
          fontSize: resolved,
          fontWeight: weight,
          fill,
          align,
          wordWrap: true,
          wordWrapWidth: width,
          lineHeight: lineHeight || resolved * 1.14,
          stroke: strokeWidth ? { color: strokeColor, width: strokeWidth } : undefined,
        },
      });
      label.anchor.set(anchorX, anchorY);
      label.x = x;
      label.y = y;
      label.rotation = rotation;
      label.alpha = alpha;
      this.root.addChild(label);
      return label;
    };

    const addGlassPanel = ({ x, y, width, height, fill = 0x05070d, alpha = 0.82, stroke = accentColor, radius = 12 }) => {
      const panel = new this.pixi.Graphics();
      panel.roundRect(x + 8, y + 10, width, height, radius).fill({ color: 0x000000, alpha: 0.24 });
      panel.roundRect(x, y, width, height, radius)
        .fill({ color: fill, alpha })
        .stroke({ color: 0xffffff, width: 2, alpha: 0.14 + pulse * 0.04 });
      this.root.addChild(panel);
      return panel;
    };

    const addTopTicker = (label = "PANEL2REELS") => {
      const bar = new this.pixi.Graphics();
      bar.rect(36, 82, w - 72, 34).fill({ color: 0x05070d, alpha: 0.72 }).stroke({ color: 0xffffff, width: 1, alpha: 0.12 });
      bar.rect(36, 82, 86 + pulse * 20, 34).fill({ color: accentColor, alpha: 0.18 });
      this.root.addChild(bar);
      addReadableText({ value: label, x: 54, y: 99, width: w - 108, fontSize: 12, minFontSize: 12, fill: accent, align: "left", anchorX: 0, strokeWidth: 0, family: "Inter, system-ui", weight: "950" });
    };

    if (variant === "release-banner") {
      addPromoGrade("dark");
      const y = h * 0.64 + (1 - intro) * 54;
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.84 });
      this.drawSoftBeam(layer, -80, y + 42, w + 70, y - 46, 92, accentColor, 0.11 + pulse * 0.04, { blur: 1.3 });
      addGlassPanel({ x: 42, y, width: w - 84, height: 164, alpha: 0.88, radius: 14 });
      addReadableText({ value: "OUT NOW", x: 72, y: y + 36, width: w - 144, fontSize: 13, minFontSize: 13, fill: accent, align: "left", anchorX: 0, strokeWidth: 0, family: "Inter, system-ui", weight: "950" });
      addReadableText({ value: upperText, x: 72, y: y + 92, width: w - 144, fontSize: 38, minFontSize: 25, fill: "#ffffff", align: "left", anchorX: 0, strokeColor: "#05070d", strokeWidth: 4, lineHeight: 42 });
      const progressBar = new this.pixi.Graphics();
      progressBar.roundRect(72, y + 130, w - 144, 3, 2).fill({ color: 0xffffff, alpha: 0.13 });
      progressBar.roundRect(72, y + 130, (w - 144) * (0.46 + pulse * 0.12), 3, 2).fill({ color: accentColor, alpha: 0.22 });
      this.root.addChild(progressBar);
      return;
    }

    if (variant === "cover-reveal") {
      addPromoGrade("cover");
      addTopTicker("COVER DROP");
      const x = 56;
      const y = 210 + (1 - intro) * -34;
      const card = new this.pixi.Graphics();
      const fill = this.createFillGradient({
        type: "linear",
        start: { x: 0, y: 0 },
        end: { x: 1, y: 1 },
        colorStops: [
          { offset: 0, color: "rgba(255,255,255,0.18)" },
          { offset: 0.26, color: "rgba(85,240,200,0.2)" },
          { offset: 0.58, color: "rgba(8,10,18,0.9)" },
          { offset: 1, color: "rgba(255,61,127,0.16)" },
        ],
      });
      card.roundRect(x + 10, y + 12, w - 112, 272, 16).fill({ color: 0x000000, alpha: 0.3 });
      card.roundRect(x, y, w - 112, 272, 16).fill(fill || { color: 0x05070d, alpha: 0.88 }).stroke({ color: 0xffffff, width: 2, alpha: 0.22 });
      card.rect(x + 28, y + 34, w - 168, 5).fill({ color: accentColor, alpha: 0.64 });
      card.rect(x + 28, y + 232, w - 168, 3).fill({ color: magenta, alpha: 0.5 });
      this.root.addChild(card);
      addReadableText({ value: "REVEAL", x: w * 0.5, y: y + 72, width: w - 150, fontSize: 14, minFontSize: 14, fill: accent, strokeWidth: 0, family: "Inter, system-ui", weight: "950" });
      addReadableText({ value: upperText, x: w * 0.5, y: y + 146, width: w - 150, fontSize: 43, minFontSize: 27, fill: "#ffffff", strokeColor: "#05070d", strokeWidth: 5, lineHeight: 45 });
      addReadableText({ value: "FIRST LOOK", x: w * 0.5, y: y + 220, width: w - 160, fontSize: 13, minFontSize: 13, fill: "#ffd84d", strokeWidth: 0, family: "Inter, system-ui", weight: "950" });
      return;
    }

    if (variant === "limited-stamp") {
      addPromoGrade("paper");
      const cx = w * 0.5;
      const cy = h * 0.48;
      const stampGroup = new this.pixi.Container();
      stampGroup.x = cx;
      stampGroup.y = cy;
      stampGroup.rotation = -0.09 + Math.sin(timeSeconds * 2.2) * 0.008;
      stampGroup.scale.set(0.86 + pop * 0.14);
      this.root.addChild(stampGroup);
      const stamp = new this.pixi.Graphics();
      stamp.roundRect(-176, -70, 352, 140, 18).fill({ color: 0xfff4d4, alpha: 0.9 }).stroke({ color: magenta, width: 7, alpha: 0.86 });
      stamp.roundRect(-154, -48, 308, 96, 12).stroke({ color: 0x05070d, width: 2, alpha: 0.5 });
      for (let i = 0; i < 9; i += 1) {
        const tx = -142 + i * 36;
        stamp.rect(tx, -72, 18, 8).fill({ color: magenta, alpha: 0.34 });
        stamp.rect(tx, 64, 18, 8).fill({ color: magenta, alpha: 0.28 });
      }
      stampGroup.addChild(stamp);
      addReadableText({ value: upperText, x: cx, y: cy - 2, width: 290, fontSize: 47, minFontSize: 30, fill: "#e43135", family: "Space Grotesk, Impact, Inter, system-ui", weight: "950", strokeColor: "#fff4d4", strokeWidth: 4, rotation: -0.09 });
      addReadableText({ value: "UNTIL RELEASE WEEK", x: cx, y: cy + 44, width: 290, fontSize: 11, minFontSize: 11, fill: "#05070d", strokeWidth: 0, family: "Inter, system-ui", weight: "950", rotation: -0.09 });
      return;
    }

    if (variant === "creator-hook") {
      addPromoGrade("dark");
      const x = 44;
      const y = h * 0.58 + (1 - intro) * 40;
      addGlassPanel({ x, y, width: w - 88, height: 198, alpha: 0.9, radius: 14 });
      const avatar = new this.pixi.Graphics();
      avatar.circle(x + 48, y + 48, 20).fill({ color: accentColor, alpha: 0.86 });
      avatar.circle(x + 48, y + 48, 9).fill({ color: 0x05070d, alpha: 0.34 });
      this.root.addChild(avatar);
      addReadableText({ value: "CREATOR HOOK", x: x + 82, y: y + 32, width: w - 170, fontSize: 13, minFontSize: 13, fill: accent, align: "left", anchorX: 0, strokeWidth: 0, family: "Inter, system-ui", weight: "950" });
      addReadableText({ value: rawText, x: x + 32, y: y + 106, width: w - 152, fontSize: 31, minFontSize: 22, fill: "#ffffff", align: "left", anchorX: 0, strokeColor: "#05070d", strokeWidth: 3, lineHeight: 36 });
      return;
    }

    if (variant === "shop-cta") {
      addPromoGrade("dark");
      const y = h * 0.66 + (1 - intro) * 48;
      const panel = new this.pixi.Graphics();
      panel.roundRect(52, y, w - 104, 160, 18).fill({ color: 0x05070d, alpha: 0.86 }).stroke({ color: accentColor, width: 2, alpha: 0.5 });
      panel.roundRect(88, y + 84, w - 176, 48, 24).fill({ color: accentColor, alpha: 0.94 });
      this.root.addChild(panel);
      addReadableText({ value: "START READING", x: w * 0.5, y: y + 42, width: w - 150, fontSize: 13, minFontSize: 13, fill: "#ffffff", strokeWidth: 0, family: "Inter, system-ui", weight: "950" });
      addReadableText({ value: upperText, x: w * 0.5, y: y + 108, width: w - 188, fontSize: 29, minFontSize: 22, fill: "#061018", strokeWidth: 0, family: "Inter, Space Grotesk, system-ui", weight: "950" });
      return;
    }

    if (variant === "countdown") {
      addPromoGrade("countdown");
      const x = 64;
      const y = 202 + (1 - intro) * -36;
      addGlassPanel({ x, y, width: w - 128, height: 282, alpha: 0.88, radius: 16, stroke: gold });
      const digits = rawText.match(/\d+/)?.[0] || "3";
      addReadableText({ value: digits, x: w * 0.5, y: y + 112, width: w - 180, fontSize: 104, minFontSize: 76, fill: "#ffffff", family: "Space Grotesk, Impact, Inter, system-ui", weight: "950", strokeColor: "#05070d", strokeWidth: 8 });
      addReadableText({ value: upperText.replace(digits, "").trim() || "DIAS", x: w * 0.5, y: y + 190, width: w - 160, fontSize: 30, minFontSize: 21, fill: gold === 0xffd84d ? "#ffd84d" : accent, strokeWidth: 0, family: "Inter, system-ui", weight: "950" });
      addReadableText({ value: "LAUNCH COUNTDOWN", x: w * 0.5, y: y + 42, width: w - 160, fontSize: 13, minFontSize: 13, fill: accent, strokeWidth: 0, family: "Inter, system-ui", weight: "950" });
      return;
    }

    if (variant === "review-quote") {
      addPromoGrade("paper");
      const x = 54;
      const y = h * 0.54 + (1 - intro) * 38;
      const card = new this.pixi.Graphics();
      card.roundRect(x + 8, y + 12, w - 108, 202, 14).fill({ color: 0x000000, alpha: 0.25 });
      card.roundRect(x, y, w - 108, 202, 14).fill({ color: 0xfff4dc, alpha: 0.9 }).stroke({ color: 0x05070d, width: 2, alpha: 0.24 });
      card.rect(x + 24, y + 24, 78, 4).fill({ color: accentColor, alpha: 0.6 });
      this.root.addChild(card);
      addReadableText({ value: "QUOTE", x: x + 28, y: y + 46, width: w - 170, fontSize: 12, minFontSize: 12, fill: "#e43135", align: "left", anchorX: 0, strokeWidth: 0, family: "Inter, system-ui", weight: "950" });
      addReadableText({ value: `"${rawText}"`, x: x + 30, y: y + 112, width: w - 168, fontSize: 31, minFontSize: 22, fill: "#101018", align: "left", anchorX: 0, strokeWidth: 0, family: "Georgia, Times New Roman, serif", weight: "900", lineHeight: 36 });
      return;
    }

    if (variant === "series-label") {
      addPromoGrade("dark");
      const x = 42;
      const y = 136 + (1 - intro) * -28;
      const panel = new this.pixi.Graphics();
      panel.roundRect(x, y, w - 84, 104, 12).fill({ color: 0x05070d, alpha: 0.82 }).stroke({ color: accentColor, width: 2, alpha: 0.42 });
      panel.rect(x, y, w - 84, 8).fill({ color: accentColor, alpha: 0.74 });
      this.root.addChild(panel);
      addReadableText({ value: "SERIES", x: x + 28, y: y + 34, width: w - 140, fontSize: 11, minFontSize: 11, fill: accent, align: "left", anchorX: 0, strokeWidth: 0, family: "Inter, system-ui", weight: "950" });
      addReadableText({ value: rawText, x: x + 28, y: y + 70, width: w - 140, fontSize: 27, minFontSize: 20, fill: "#ffffff", align: "left", anchorX: 0, strokeColor: "#05070d", strokeWidth: 3, family: "Inter, Space Grotesk, system-ui", weight: "950" });
      return;
    }

    if (variant === "comment-card") {
      addPromoGrade("dark");
      const x = 50;
      const y = h * 0.18 + (1 - intro) * -30;
      const card = new this.pixi.Graphics();
      card.roundRect(x, y, w - 100, 168, 18).fill({ color: 0xf7f8ff, alpha: 0.92 }).stroke({ color: 0xffffff, width: 2, alpha: 0.28 });
      card.circle(x + 42, y + 42, 19).fill({ color: accentColor, alpha: 0.9 });
      card.roundRect(x + 76, y + 28, 126, 12, 6).fill({ color: 0x121522, alpha: 0.18 });
      card.roundRect(x + 76, y + 48, 82, 8, 4).fill({ color: 0x121522, alpha: 0.12 });
      this.root.addChild(card);
      addReadableText({ value: rawText, x: x + 34, y: y + 104, width: w - 168, fontSize: 28, minFontSize: 20, fill: "#101018", align: "left", anchorX: 0, strokeWidth: 0, family: "Inter, system-ui", weight: "850", lineHeight: 33 });
      return;
    }
  }

  drawShowcaseNoirMysteryText(textStyle, progress, timeSeconds, variant = "case-file") {
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = Math.min(Math.max(progress, 0), 1);
    const intro = easeOutCubic(Math.min(p / 0.36, 1));
    const stampIn = easeOutBack(Math.min(p / 0.34, 1));
    const pulse = 0.5 + Math.sin(timeSeconds * 1.45) * 0.5;
    const accent = textStyle.accent || "#f0d28a";
    const accentColor = parsePixiColor(accent);
    const paperColor = parsePixiColor(textStyle.fill || "#ede4ca");
    const ink = textStyle.ink || "#111111";
    const rawText = String(textStyle.text || textStyle.title || "CASE FILE").slice(0, 112);
    const upperText = rawText.toUpperCase();

    const addNoirAtmosphere = (mode = "paper") => {
      const shade = this.createFxLayer({ blendMode: "multiply", alpha: 0.86 });
      const g = new this.pixi.Graphics();
      g.rect(0, 0, w, h).fill({ color: 0x070705, alpha: mode === "flash" ? 0.16 : 0.22 });
      g.rect(0, 0, w, h * 0.18).fill({ color: 0x000000, alpha: 0.28 });
      g.rect(0, h * 0.74, w, h * 0.26).fill({ color: 0x000000, alpha: 0.34 });
      g.rect(0, 0, 44, h).fill({ color: 0x000000, alpha: 0.16 });
      g.rect(w - 44, 0, 44, h).fill({ color: 0x000000, alpha: 0.16 });
      shade.addChild(g);

      const light = this.createFxLayer({ blendMode: "screen", alpha: 0.72 });
      const beam = new this.pixi.Graphics();
      const fill = this.createFillGradient({
        type: "radial",
        center: { x: mode === "newspaper" ? 0.22 : 0.72, y: mode === "location" ? 0.2 : 0.58 },
        innerRadius: 0.04,
        outerCenter: { x: 0.5, y: 0.5 },
        outerRadius: 0.88,
        colorStops: [
          { offset: 0, color: `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},0.12)` },
          { offset: 0.44, color: "rgba(255,255,255,0.035)" },
          { offset: 1, color: "rgba(0,0,0,0)" },
        ],
      });
      beam.rect(0, 0, w, h).fill(fill || { color: accentColor, alpha: 0.04 });
      light.addChild(beam);

      const grain = new this.pixi.Sprite(this.textureNoise("noir-text-grain"));
      grain.width = w;
      grain.height = h;
      grain.alpha = 0.028 + pulse * 0.012;
      grain.blendMode = "screen";
      this.root.addChild(grain);
    };

    const addText = ({
      value = rawText,
      x,
      y,
      width,
      fontSize = 34,
      minFontSize = 21,
      fill = ink,
      family = "Georgia, Times New Roman, serif",
      weight = "800",
      align = "left",
      anchorX = 0,
      anchorY = 0,
      strokeColor = null,
      strokeWidth = 0,
      lineHeight,
      rotation = 0,
      alpha = 1,
    }) => {
      const valueText = String(value);
      const resolved = Math.max(minFontSize, fontSize - Math.max(0, valueText.length - 34) * 0.28);
      const label = new this.pixi.Text({
        text: valueText,
        style: {
          fontFamily: family,
          fontSize: resolved,
          fontWeight: weight,
          fill,
          align,
          wordWrap: true,
          wordWrapWidth: width,
          lineHeight: lineHeight || resolved * 1.16,
          stroke: strokeColor && strokeWidth ? { color: strokeColor, width: strokeWidth } : undefined,
        },
      });
      label.anchor.set(anchorX, anchorY);
      label.x = x;
      label.y = y;
      label.rotation = rotation;
      label.alpha = alpha;
      this.root.addChild(label);
      return label;
    };

    const addPaperCard = ({ x, y, width, height, radius = 8, alpha = 0.92, pin = true }) => {
      const card = new this.pixi.Graphics();
      card.roundRect(x + 10, y + 12, width, height, radius).fill({ color: 0x000000, alpha: 0.26 });
      card.roundRect(x, y, width, height, radius)
        .fill({ color: paperColor, alpha })
        .stroke({ color: 0x2b2418, width: 2, alpha: 0.3 });
      card.rect(x + 24, y + 24, width - 48, 2).fill({ color: 0x2b2418, alpha: 0.12 });
      card.rect(x + 24, y + height - 25, width - 48, 2).fill({ color: accentColor, alpha: 0.25 + pulse * 0.08 });
      if (pin) {
        card.circle(x + width - 32, y + 30, 7).fill({ color: accentColor, alpha: 0.54 });
        card.circle(x + width - 32, y + 30, 15).stroke({ color: 0x2b2418, width: 1, alpha: 0.16 });
      }
      this.root.addChild(card);
      return card;
    };

    const addEvidenceLines = (x, y, width, rows = 5, alpha = 0.14) => {
      const g = new this.pixi.Graphics();
      for (let i = 0; i < rows; i += 1) {
        g.rect(x, y + i * 24, width - (i % 3) * 54, 2).fill({ color: 0x19140d, alpha });
      }
      this.root.addChild(g);
    };

    const addRain = (alpha = 0.11) => {
      const rain = this.createFxLayer({ blendMode: "screen", alpha: 0.76 });
      const g = new this.pixi.Graphics();
      for (let i = 0; i < 54; i += 1) {
        const x = -80 + ((i * 47 + timeSeconds * 72) % (w + 160));
        const y = 50 + ((i * 91 + timeSeconds * 210) % (h - 100));
        g.moveTo(x, y).lineTo(x - 24, y + 78).stroke({ color: i % 4 ? 0xffffff : accentColor, width: i % 3 ? 1.5 : 2.5, alpha });
      }
      rain.addChild(g);
    };

    if (variant === "case-file") {
      addNoirAtmosphere("paper");
      const x = 48;
      const y = h * 0.58 + (1 - intro) * 42;
      const width = w - 96;
      const height = 184;
      addPaperCard({ x, y, width, height });
      addText({ value: "CASE FILE / ACTIVE", x: x + 30, y: y + 28, width: width - 84, fontSize: 13, minFontSize: 13, fill: "#5f4a22", family: "Inter, system-ui", weight: "950" });
      addText({ value: rawText, x: x + 30, y: y + 70, width: width - 74, fontSize: 35, minFontSize: 23, lineHeight: 40 });
      addEvidenceLines(x + 30, y + 132, width - 90, 3, 0.12);
      return;
    }

    if (variant === "newspaper") {
      addNoirAtmosphere("newspaper");
      const x = 42;
      const y = 138 + (1 - intro) * -32;
      const width = w - 84;
      const height = 244;
      addPaperCard({ x, y, width, height, radius: 6, alpha: 0.88, pin: false });
      addText({ value: "THE MIDNIGHT EDITION", x: w * 0.5, y: y + 28, width: width - 60, fontSize: 15, minFontSize: 15, fill: "#19140d", family: "Georgia, Times New Roman, serif", weight: "900", align: "center", anchorX: 0.5 });
      const rule = new this.pixi.Graphics();
      rule.rect(x + 26, y + 58, width - 52, 3).fill({ color: 0x19140d, alpha: 0.38 });
      rule.rect(x + 26, y + 204, width - 52, 2).fill({ color: 0x19140d, alpha: 0.2 });
      this.root.addChild(rule);
      addText({ value: upperText, x: w * 0.5, y: y + 82, width: width - 76, fontSize: 47, minFontSize: 28, fill: "#111111", family: "Georgia, Times New Roman, serif", weight: "950", align: "center", anchorX: 0.5, lineHeight: 48 });
      addEvidenceLines(x + 34, y + 216, width - 68, 2, 0.11);
      return;
    }

    if (variant === "suspect") {
      addNoirAtmosphere("paper");
      const x = 54;
      const y = h * 0.66 + (1 - intro) * 42;
      const width = w - 108;
      const height = 132;
      const plate = new this.pixi.Graphics();
      plate.roundRect(x + 9, y + 10, width, height, 8).fill({ color: 0x000000, alpha: 0.3 });
      plate.roundRect(x, y, width, height, 8).fill({ color: 0x0c0b08, alpha: 0.82 }).stroke({ color: accentColor, width: 2, alpha: 0.46 });
      plate.rect(x + 22, y + 22, 5, height - 44).fill({ color: accentColor, alpha: 0.54 });
      this.root.addChild(plate);
      addText({ value: "PERSON OF INTEREST", x: x + 42, y: y + 24, width: width - 84, fontSize: 12, minFontSize: 12, fill: accent, family: "Inter, system-ui", weight: "950" });
      addText({ value: upperText, x: x + 42, y: y + 56, width: width - 84, fontSize: 34, minFontSize: 23, fill: "#f6edd3", family: "Inter, system-ui", weight: "950", strokeColor: "#050509", strokeWidth: 3, lineHeight: 38 });
      return;
    }

    if (variant === "monologue") {
      addNoirAtmosphere("paper");
      addRain(0.1);
      const x = 50;
      const y = h * 0.62 + (1 - intro) * 36;
      const width = w - 100;
      const height = 168;
      const box = new this.pixi.Graphics();
      box.roundRect(x, y, width, height, 10).fill({ color: 0x080806, alpha: 0.7 }).stroke({ color: 0xffffff, width: 1.5, alpha: 0.13 });
      box.rect(x + 26, y + 26, 3, height - 52).fill({ color: accentColor, alpha: 0.34 });
      this.root.addChild(box);
      addText({ value: rawText, x: x + 46, y: y + 42, width: width - 88, fontSize: 32, minFontSize: 22, fill: "#f2ead8", family: "Georgia, Times New Roman, serif", weight: "700", lineHeight: 38 });
      return;
    }

    if (variant === "clue") {
      addNoirAtmosphere("paper");
      const cx = w * 0.66;
      const cy = h * 0.36 + (1 - intro) * -24;
      const g = new this.pixi.Graphics();
      g.circle(cx, cy, 104).stroke({ color: accentColor, width: 4, alpha: 0.62 });
      g.circle(cx, cy, 82).stroke({ color: 0xffffff, width: 2, alpha: 0.16 });
      g.moveTo(cx - 118, cy).lineTo(cx - 76, cy).moveTo(cx + 76, cy).lineTo(cx + 118, cy)
        .moveTo(cx, cy - 118).lineTo(cx, cy - 76).moveTo(cx, cy + 76).lineTo(cx, cy + 118)
        .stroke({ color: accentColor, width: 2, alpha: 0.45 });
      g.roundRect(58, h * 0.66, w - 116, 120, 8).fill({ color: 0x080806, alpha: 0.72 }).stroke({ color: accentColor, width: 2, alpha: 0.28 });
      this.root.addChild(g);
      addText({ value: "CLUE MATCH", x: 86, y: h * 0.675, width: w - 172, fontSize: 12, minFontSize: 12, fill: accent, family: "Inter, system-ui", weight: "950" });
      addText({ value: rawText, x: 86, y: h * 0.71, width: w - 172, fontSize: 29, minFontSize: 21, fill: "#f2ead8", family: "Inter, system-ui", weight: "900", lineHeight: 33 });
      return;
    }

    if (variant === "flashbulb") {
      addNoirAtmosphere("flash");
      const flash = this.createFxLayer({ blendMode: "screen", alpha: 0.82 });
      const f = new this.pixi.Graphics();
      f.rect(0, 0, w, h).fill({ color: 0xffffff, alpha: 0.08 + Math.max(0, Math.sin(timeSeconds * 4.2)) * 0.08 });
      for (let i = 0; i < 18; i += 1) {
        const a = -Math.PI * 0.85 + (i / 17) * Math.PI * 1.7;
        this.drawTaperedQuad(f, w * 0.5 + Math.cos(a) * 52, h * 0.43 + Math.sin(a) * 38, w * 0.5 + Math.cos(a) * 350, h * 0.43 + Math.sin(a) * 260, 1, 7 + (i % 3) * 4, i % 4 ? 0xffffff : accentColor, 0.08 + intro * 0.1);
      }
      flash.addChild(f);
      addText({ value: upperText, x: w * 0.5, y: h * 0.44, width: w - 140, fontSize: 76, minFontSize: 48, fill: "#fffdf4", family: "Impact, Space Grotesk, Inter, system-ui", weight: "950", align: "center", anchorX: 0.5, anchorY: 0.5, strokeColor: "#080806", strokeWidth: 8, rotation: -0.07, alpha: 0.86 + stampIn * 0.14 });
      return;
    }

    if (variant === "pulp-card") {
      addNoirAtmosphere("newspaper");
      const x = 58;
      const y = h * 0.28 + (1 - intro) * -34;
      const width = w - 116;
      const height = 276;
      addPaperCard({ x, y, width, height, radius: 12, alpha: 0.9, pin: false });
      const border = new this.pixi.Graphics();
      border.roundRect(x + 18, y + 18, width - 36, height - 36, 8).stroke({ color: 0x19140d, width: 2, alpha: 0.28 });
      border.rect(x + 34, y + 58, width - 68, 4).fill({ color: accentColor, alpha: 0.48 });
      this.root.addChild(border);
      addText({ value: "A NEW CASE", x: w * 0.5, y: y + 34, width: width - 70, fontSize: 13, minFontSize: 13, fill: "#5f4a22", family: "Inter, system-ui", weight: "950", align: "center", anchorX: 0.5 });
      addText({ value: upperText, x: w * 0.5, y: y + 94, width: width - 86, fontSize: 43, minFontSize: 27, fill: "#111111", family: "Georgia, Times New Roman, serif", weight: "950", align: "center", anchorX: 0.5, lineHeight: 46 });
      addText({ value: "NOIR SERIAL", x: w * 0.5, y: y + 222, width: width - 80, fontSize: 14, minFontSize: 14, fill: accent, family: "Inter, system-ui", weight: "950", align: "center", anchorX: 0.5 });
      return;
    }

    if (variant === "classified") {
      addNoirAtmosphere("paper");
      const x = 54;
      const y = h * 0.56 + (1 - intro) * 38;
      const width = w - 108;
      const height = 186;
      addPaperCard({ x, y, width, height, radius: 8, alpha: 0.88 });
      const bars = new this.pixi.Graphics();
      bars.rect(x + 28, y + 74, width - 90, 18).fill({ color: 0x050509, alpha: 0.82 });
      bars.rect(x + 86, y + 122, width - 156, 16).fill({ color: 0x050509, alpha: 0.78 });
      bars.roundRect(x + width - 154, y + 28, 126, 38, 4).stroke({ color: 0xa83224, width: 4, alpha: 0.72 });
      this.root.addChild(bars);
      addText({ value: "CLASSIFIED", x: x + width - 91, y: y + 38, width: 120, fontSize: 14, minFontSize: 14, fill: "#a83224", family: "Inter, system-ui", weight: "950", align: "center", anchorX: 0.5, anchorY: 0.5, rotation: -0.08 });
      addText({ value: rawText, x: x + 30, y: y + 100, width: width - 60, fontSize: 31, minFontSize: 22, fill: "#111111", family: "Georgia, Times New Roman, serif", weight: "900", lineHeight: 36 });
      return;
    }

    if (variant === "detective-cta") {
      addNoirAtmosphere("paper");
      addRain(0.075);
      const x = 58;
      const y = h * 0.68 + (1 - intro) * 38;
      const width = w - 116;
      const height = 146;
      const panel = new this.pixi.Graphics();
      panel.roundRect(x, y, width, height, 12).fill({ color: 0x080806, alpha: 0.82 }).stroke({ color: accentColor, width: 2, alpha: 0.42 });
      panel.roundRect(x + 34, y + 88, width - 68, 42, 21).fill({ color: accentColor, alpha: 0.86 });
      this.root.addChild(panel);
      addText({ value: "FOLLOW THE EVIDENCE", x: w * 0.5, y: y + 34, width: width - 70, fontSize: 13, minFontSize: 13, fill: "#f2ead8", family: "Inter, system-ui", weight: "950", align: "center", anchorX: 0.5 });
      addText({ value: upperText, x: w * 0.5, y: y + 110, width: width - 96, fontSize: 25, minFontSize: 19, fill: "#0b0905", family: "Inter, system-ui", weight: "950", align: "center", anchorX: 0.5, anchorY: 0.5 });
      return;
    }

    if (variant === "location-title") {
      addNoirAtmosphere("location");
      const y = h * 0.16 + (1 - intro) * -28;
      const panel = new this.pixi.Graphics();
      panel.rect(44, y, w - 88, 96).fill({ color: 0x080806, alpha: 0.68 }).stroke({ color: 0xffffff, width: 1.5, alpha: 0.12 });
      panel.rect(44, y + 92, w - 88, 4).fill({ color: accentColor, alpha: 0.4 + pulse * 0.12 });
      this.root.addChild(panel);
      addText({ value: "LOCATION", x: 74, y: y + 22, width: w - 148, fontSize: 12, minFontSize: 12, fill: accent, family: "Inter, system-ui", weight: "950" });
      addText({ value: upperText, x: 74, y: y + 48, width: w - 148, fontSize: 34, minFontSize: 23, fill: "#f2ead8", family: "Inter, system-ui", weight: "950", strokeColor: "#050509", strokeWidth: 3, lineHeight: 38 });
    }
  }

  drawShowcaseScifiHudCaption(textStyle, progress, timeSeconds) {
    const intro = easeOutCubic(Math.min(progress / 0.32, 1));
    const accent = textStyle.accent || "#42f5ff";
    const accentColor = parsePixiColor(accent);
    const fullText = String(textStyle.text || textStyle.title || "SIGNAL FOUND").toUpperCase().slice(0, 58);
    const reveal = Math.max(1, Math.floor(fullText.length * Math.min(1, progress / 0.58)));
    const text = fullText.slice(0, reveal);
    const x = 50;
    const y = 168 + (1 - intro) * -36;
    const width = PIXI_PREVIEW_SIZE.width - 100;
    const height = 196;
    const scanY = y + 34 + ((timeSeconds * 74) % (height - 44));

    const panel = new this.pixi.Graphics();
    panel.roundRect(x, y, width, height, 8)
      .fill({ color: 0x001621, alpha: 0.58 })
      .stroke({ color: accentColor, width: 2, alpha: 0.72 });
    panel.rect(x + 16, y + 16, 88, 3).fill({ color: accentColor, alpha: 0.72 });
    panel.rect(x + width - 104, y + height - 18, 88, 3).fill({ color: accentColor, alpha: 0.72 });
    panel.moveTo(x + 18, y + 54).lineTo(x + width - 18, y + 54).stroke({ color: accentColor, width: 1, alpha: 0.22 });
    panel.moveTo(x + 18, scanY).lineTo(x + width - 18, scanY).stroke({ color: 0xffffff, width: 5, alpha: 0.16 });
    panel.moveTo(x + 18, scanY + 8).lineTo(x + width - 18, scanY + 8).stroke({ color: accentColor, width: 2, alpha: 0.34 });
    this.root.addChild(panel);

    const grid = new this.pixi.Graphics();
    for (let i = 0; i < 7; i += 1) {
      const gy = y + 72 + i * 17;
      grid.moveTo(x + 22, gy).lineTo(x + width - 22 - (i % 3) * 42, gy)
        .stroke({ color: accentColor, width: 1, alpha: 0.12 });
    }
    for (let i = 0; i < 4; i += 1) {
      const bx = x + width - 144 + i * 28;
      grid.rect(bx, y + 72 + Math.sin(timeSeconds * 3 + i) * 4, 12, 62 - i * 8)
        .fill({ color: accentColor, alpha: 0.12 + i * 0.03 });
    }
    this.root.addChild(grid);

    const code = new this.pixi.Text({
      text: "SCAN / P2R-04",
      style: {
        fontFamily: "Inter, system-ui",
        fontSize: 14,
        fontWeight: "900",
        fill: accent,
        letterSpacing: 0,
      },
    });
    code.x = x + 24;
    code.y = y + 22;
    this.root.addChild(code);

    const label = new this.pixi.Text({
      text,
      style: {
        fontFamily: "Inter, system-ui",
        fontSize: 36,
        fontWeight: "950",
        fill: textStyle.ink || "#d9fbff",
        stroke: { color: "#001621", width: 4 },
        wordWrap: true,
        wordWrapWidth: width - 188,
        lineHeight: 39,
      },
    });
    label.x = x + 24 + Math.sin(timeSeconds * 15) * 0.8;
    label.y = y + 76;
    this.root.addChild(label);

    const reticle = new this.pixi.Graphics();
    const cx = x + width - 74;
    const cy = y + 112;
    reticle.circle(cx, cy, 30 + Math.sin(timeSeconds * 2.5) * 3)
      .stroke({ color: accentColor, width: 2, alpha: 0.58 });
    reticle.moveTo(cx - 46, cy).lineTo(cx - 18, cy).moveTo(cx + 18, cy).lineTo(cx + 46, cy)
      .moveTo(cx, cy - 46).lineTo(cx, cy - 18).moveTo(cx, cy + 18).lineTo(cx, cy + 46)
      .stroke({ color: accentColor, width: 2, alpha: 0.46 });
    this.root.addChild(reticle);
  }

  drawShowcaseRomanceLetterCard(textStyle, progress, timeSeconds) {
    const intro = easeOutCubic(Math.min(progress / 0.46, 1));
    const breathe = Math.sin(timeSeconds * 1.65) * 0.5 + 0.5;
    const accent = textStyle.accent || "#ff8ed6";
    const accentColor = parsePixiColor(accent);
    const text = String(textStyle.text || textStyle.title || "THEN I UNDERSTOOD").slice(0, 72);
    const width = PIXI_PREVIEW_SIZE.width - 118;
    const height = 198;
    const x = 59;
    const y = PIXI_PREVIEW_SIZE.height - 430 + (1 - intro) * 42 + Math.sin(timeSeconds * 1.2) * 4;

    const glow = new this.pixi.Graphics();
    glow.roundRect(x - 28, y - 28, width + 56, height + 56, 28)
      .fill({ color: accentColor, alpha: 0.08 + breathe * 0.04 });
    this.root.addChild(glow);

    const card = new this.pixi.Graphics();
    card.roundRect(x, y, width, height, 16)
      .fill({ color: parsePixiColor(textStyle.fill || "#fff3f6"), alpha: 0.93 })
      .stroke({ color: 0xffffff, width: 2, alpha: 0.52 });
    card.moveTo(x + 34, y + 60).lineTo(x + width - 34, y + 60)
      .stroke({ color: accentColor, width: 2, alpha: 0.32 });
    card.moveTo(x + 34, y + height - 38).lineTo(x + width - 34, y + height - 38)
      .stroke({ color: accentColor, width: 2, alpha: 0.24 });
    this.root.addChild(card);

    const label = new this.pixi.Text({
      text,
      style: {
        fontFamily: "Georgia, Times New Roman, serif",
        fontSize: 37,
        fontWeight: "700",
        fill: textStyle.ink || "#2d1421",
        wordWrap: true,
        wordWrapWidth: width - 72,
        lineHeight: 42,
        align: "center",
      },
    });
    label.anchor.set(0.5);
    label.x = x + width / 2;
    label.y = y + height / 2 + 10;
    label.alpha = 0.84 + intro * 0.16;
    label.scale.set(0.985 + breathe * 0.012);
    this.root.addChild(label);

    const note = new this.pixi.Text({
      text: "Dear reader,",
      style: {
        fontFamily: "Georgia, Times New Roman, serif",
        fontSize: 18,
        fontWeight: "700",
        fill: accent,
        align: "left",
      },
    });
    note.x = x + 38;
    note.y = y + 25;
    note.alpha = 0.82;
    this.root.addChild(note);

    const petals = new this.pixi.Graphics();
    for (let i = 0; i < 16; i += 1) {
      const phase = (timeSeconds * 0.11 + i * 0.073) % 1;
      const px = 46 + ((i * 71) % 620) + Math.sin(timeSeconds + i) * 12;
      const py = 80 + phase * 900;
      petals.ellipse(px, py, 8 + (i % 3) * 2, 4 + (i % 2) * 2)
        .fill({ color: accentColor, alpha: 0.22 + (i % 3) * 0.035 });
    }
    this.root.addChild(petals);
  }

  drawFinalCtaText(textStyle, progress, timeSeconds) {
    const p = easeOutCubic(Math.min(progress / 0.32, 1));
    const accent = textStyle.accent || "#ff3d7f";
    const accentColor = parsePixiColor(accent);
    const y = PIXI_PREVIEW_SIZE.height - 345;
    const scale = 0.9 + p * 0.1 + Math.sin(timeSeconds * 6) * 0.006;

    const glow = new this.pixi.Graphics();
    glow.roundRect(64, y + 22, PIXI_PREVIEW_SIZE.width - 128, 132, 14)
      .fill({ color: 0x05070d, alpha: 0.76 + p * 0.08 })
      .stroke({ color: 0xffffff, width: 2, alpha: 0.16 });
    glow.rect(94, y + 132, PIXI_PREVIEW_SIZE.width - 188, 3)
      .fill({ color: accentColor, alpha: 0.18 });
    this.root.addChild(glow);

    const sub = new this.pixi.Text({
      text: String(textStyle.text || "CONTINUA EN EL CAPITULO").toUpperCase().slice(0, 42),
      style: {
        fontFamily: "Inter, system-ui",
        fontSize: 24,
        fontWeight: "900",
        fill: "#f8f6ff",
        stroke: { color: "#050509", width: 5 },
        align: "center",
        wordWrap: true,
        wordWrapWidth: PIXI_PREVIEW_SIZE.width - 150,
      },
    });
    sub.anchor.set(0.5);
    sub.x = PIXI_PREVIEW_SIZE.width / 2;
    sub.y = y + 88;
    sub.scale.set(scale);
    this.root.addChild(sub);
  }

  drawDesignedSfxSlam(effect, progress, timeSeconds, options = {}) {
    const p = easeOutCubic(Math.min(progress / 0.38, 1));
    const accent = effect.accent || "#ffd84d";
    const accentColor = parsePixiColor(accent);
    const cx = PIXI_PREVIEW_SIZE.width * 0.53;
    const cy = PIXI_PREVIEW_SIZE.height * 0.38;

    this.drawImpactBurst(accent, progress, timeSeconds);

    const plate = new this.pixi.Graphics();
    const wobble = Math.sin(timeSeconds * 18) * 4;
    plate.moveTo(cx - 250, cy - 74 + wobble)
      .lineTo(cx + 225, cy - 112 - wobble)
      .lineTo(cx + 250, cy + 86 + wobble)
      .lineTo(cx - 220, cy + 120 - wobble)
      .closePath()
      .fill({ color: 0x050509, alpha: 0.62 })
      .stroke({ color: 0xffffff, width: 7, alpha: 0.72 })
      .stroke({ color: accentColor, width: 3, alpha: 0.9 });
    plate.scale.set(0.82 + p * 0.18);
    plate.x = cx * (1 - plate.scale.x);
    plate.y = cy * (1 - plate.scale.y);
    this.root.addChild(plate);

    if (!options.hasTextStyle) {
      const word = effect.text || effect.sfx || "BAM!";
      this.drawSfxWord(word, cx, cy + 6, accent, progress, String(word).length <= 4 ? 1.15 : 0.92);
    }

    const shards = new this.pixi.Graphics();
    for (let i = 0; i < 18; i += 1) {
      const angle = -Math.PI * 0.9 + (i / 17) * Math.PI * 1.8;
      const inner = 250 + (i % 3) * 18;
      const outer = inner + 70 + (i % 4) * 24;
      shards.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner)
        .lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer)
        .stroke({ color: i % 3 ? accentColor : 0xffffff, width: i % 3 ? 4 : 7, alpha: 0.25 + p * 0.18 });
    }
    this.root.addChild(shards);
  }

  drawMangaSfxSlamProVfx(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ffdf43";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = Math.min(Math.max(progress, 0), 1);
    const pop = easeOutBack(Math.min(p / 0.38, 1));
    const hit = Math.max(0, 1 - Math.min(p / 0.22, 1));
    const rebound = Math.sin(Math.min(Math.max((p - 0.08) / 0.62, 0), 1) * Math.PI);
    const shake = hit * 0.9 + rebound * 0.28;
    const word = String(effect.text || effect.sfx || "BAM!").toUpperCase().slice(0, 10);
    const cx = w * 0.52 + Math.sin(timeSeconds * 28) * shake * 7;
    const cy = h * 0.38 + Math.cos(timeSeconds * 25) * shake * 6;
    const angle = -0.11 + Math.sin(timeSeconds * 10) * hit * 0.018;

    this.drawPanelEcho(options.panelTexture, options.camera, {
      blendMode: "screen",
      alpha: 0.14 + hit * 0.18,
      zoomBoost: 0.048 + hit * 0.055,
      panX: 0.026 + Math.sin(timeSeconds * 32) * hit * 0.012,
      panY: -0.018 + Math.cos(timeSeconds * 29) * hit * 0.01,
      rotation: -0.006,
      blur: 1.4 + hit * 1.6,
      blurQuality: 3,
    });

    const shadeLayer = this.createFxLayer({ blendMode: "multiply", alpha: 0.86 });
    const shade = new this.pixi.Graphics();
    shade.rect(0, 0, w, h).fill({ color: 0x020205, alpha: 0.035 + hit * 0.035 });
    shade.rect(0, 0, w, h).stroke({ color: 0x020205, width: 70 + hit * 36, alpha: 0.13 + hit * 0.08 });
    shadeLayer.addChild(shade);

    const burstLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.95 });
    const burst = new this.pixi.Graphics();
    const points = 18;
    const innerBase = 132 + rebound * 22;
    const outerBase = 314 + rebound * 52;
    burst.moveTo(cx + Math.cos(angle) * outerBase, cy + Math.sin(angle) * outerBase * 0.72);
    for (let i = 0; i <= points; i += 1) {
      const theta = angle + (i / points) * Math.PI * 2;
      const radius = (i % 2 ? innerBase : outerBase) + (i % 5) * 13 + Math.sin(timeSeconds * 4 + i) * 7;
      burst.lineTo(cx + Math.cos(theta) * radius, cy + Math.sin(theta) * radius * 0.72);
    }
    burst.closePath()
      .fill({ color: 0xffffff, alpha: 0.72 })
      .stroke({ color: 0x050509, width: 14, alpha: 0.88 })
      .stroke({ color: accentColor, width: 5, alpha: 0.92 });
    burstLayer.addChild(burst);

    const inkLayer = this.createFxLayer({ blendMode: "multiply", alpha: 0.8 });
    const ink = new this.pixi.Graphics();
    for (let i = 0; i < 22; i += 1) {
      const theta = angle + (i / 22) * Math.PI * 2 + Math.sin(i) * 0.08;
      const inner = 260 + (i % 4) * 18;
      const outer = inner + 100 + (i % 5) * 28 + hit * 70;
      this.drawTaperedQuad(
        ink,
        cx + Math.cos(theta) * inner,
        cy + Math.sin(theta) * inner * 0.72,
        cx + Math.cos(theta) * outer,
        cy + Math.sin(theta) * outer * 0.72,
        1.4,
        14 + (i % 4) * 5,
        0x020205,
        0.08 + hit * 0.05,
      );
    }
    for (let i = 0; i < 10; i += 1) {
      const y = h * (0.18 + i * 0.075) + Math.sin(timeSeconds * 6 + i) * 16;
      ink.moveTo(-40, y).lineTo(w + 40, y - 150 - (i % 4) * 28)
        .stroke({ color: 0x020205, width: 2 + (i % 3), alpha: 0.035 + hit * 0.035 });
    }
    inkLayer.addChild(ink);

    this.drawParticleBurst({
      x: cx,
      y: cy,
      accent,
      count: 74,
      progress: p,
      timeSeconds,
      radius: 390,
      verticalScale: 0.7,
    });

    const wordShadow = new this.pixi.Text({
      text: word,
      style: {
        fontFamily: "Impact, Space Grotesk, system-ui",
        fontSize: word.length <= 4 ? 126 : 94,
        fontWeight: "900",
        fill: "#050509",
        stroke: { color: "#050509", width: 18 },
        align: "center",
        letterSpacing: 0,
      },
    });
    wordShadow.anchor.set(0.5);
    wordShadow.x = cx + 15;
    wordShadow.y = cy + 18;
    wordShadow.rotation = angle;
    wordShadow.scale.set(0.56 + pop * 0.44);
    wordShadow.alpha = 0.78;
    this.root.addChild(wordShadow);

    const wordInk = new this.pixi.Text({
      text: word,
      style: {
        fontFamily: "Impact, Space Grotesk, system-ui",
        fontSize: word.length <= 4 ? 126 : 94,
        fontWeight: "900",
        fill: "#ffffff",
        stroke: { color: "#050509", width: 13 },
        align: "center",
        letterSpacing: 0,
      },
    });
    wordInk.anchor.set(0.5);
    wordInk.x = cx;
    wordInk.y = cy;
    wordInk.rotation = angle;
    wordInk.scale.set(0.56 + pop * 0.44 + hit * 0.06);
    this.root.addChild(wordInk);

    const wordAccent = new this.pixi.Text({
      text: word,
      style: {
        fontFamily: "Impact, Space Grotesk, system-ui",
        fontSize: word.length <= 4 ? 126 : 94,
        fontWeight: "900",
        fill: accent,
        stroke: { color: "#050509", width: 4 },
        align: "center",
        letterSpacing: 0,
      },
    });
    wordAccent.anchor.set(0.5);
    wordAccent.x = cx - 6;
    wordAccent.y = cy - 7;
    wordAccent.rotation = angle;
    wordAccent.scale.set(0.54 + pop * 0.42);
    wordAccent.alpha = 0.62;
    wordAccent.blendMode = "multiply";
    this.root.addChild(wordAccent);

    const shineLayer = this.createFxLayer({ blendMode: "screen" });
    const shine = new this.pixi.Graphics();
    const flash = Math.max(0, 0.26 - p * 0.74);
    shine.rect(0, 0, w, h).fill({ color: 0xffffff, alpha: flash });
    this.drawTaperedQuad(shine, cx - 300, cy + 82, cx + 315, cy - 108, 5, 18, 0xffffff, 0.12 + hit * 0.12);
    this.drawTaperedQuad(shine, cx - 280, cy + 126, cx + 250, cy - 48, 3, 10, accentColor, 0.18 + hit * 0.08);
    shineLayer.addChild(shine);
  }

  drawGlitchBars(accent, timeSeconds, alpha = 0.28) {
    const graphics = new this.pixi.Graphics();
    const color = parsePixiColor(accent || "#00eaff");
    for (let i = 0; i < 14; i += 1) {
      const y = ((i * 97 + timeSeconds * 220) % PIXI_PREVIEW_SIZE.height);
      const h = 5 + (i % 4) * 8;
      graphics.rect((i % 2 ? -24 : 24), y, PIXI_PREVIEW_SIZE.width + 48, h)
        .fill({ color: i % 3 ? color : 0xffffff, alpha });
    }
    this.root.addChild(graphics);
  }

  drawHalftoneDots(accent, timeSeconds, alpha = 0.22) {
    const color = parsePixiColor(accent || "#ffd84d");
    const sprite = this.drawCachedFullFrameTexture(this.textureHalftoneDots(), {
      tint: color,
      alpha: alpha * (0.92 + Math.sin(timeSeconds * 2) * 0.08),
    });
    sprite.x = Math.sin(timeSeconds * 0.45) * 5;
    sprite.y = Math.cos(timeSeconds * 0.38) * 4;
  }

  drawFlash(accent, progress) {
    const graphics = new this.pixi.Graphics();
    graphics.rect(0, 0, PIXI_PREVIEW_SIZE.width, PIXI_PREVIEW_SIZE.height)
      .fill({ color: parsePixiColor(accent || "#ffffff"), alpha: Math.max(0, 0.32 - progress * 0.42) });
    this.root.addChild(graphics);
  }

  drawInkSplats(accent, progress, timeSeconds) {
    const graphics = new this.pixi.Graphics();
    const color = parsePixiColor(accent || "#050505");
    for (let i = 0; i < 18; i += 1) {
      const x = 40 + ((i * 149 + timeSeconds * 16) % (PIXI_PREVIEW_SIZE.width - 80));
      const y = 80 + ((i * 211) % (PIXI_PREVIEW_SIZE.height - 160));
      graphics.circle(x, y, 16 + (i % 5) * 10 + progress * 24).fill({ color, alpha: 0.18 + (i % 4) * 0.05 });
    }
    this.root.addChild(graphics);
  }

  drawVignetteLayer(alpha = 0.32) {
    const graphics = new this.pixi.Graphics();
    graphics.rect(0, 0, PIXI_PREVIEW_SIZE.width, PIXI_PREVIEW_SIZE.height)
      .stroke({ color: 0x000000, width: 90, alpha });
    graphics.rect(0, 0, PIXI_PREVIEW_SIZE.width, PIXI_PREVIEW_SIZE.height)
      .fill({ color: 0x000000, alpha: alpha * 0.18 });
    this.root.addChild(graphics);
  }

  drawSafeFocusVignette(alpha = 0.14) {
    const graphics = new this.pixi.Graphics();
    graphics.rect(0, 0, PIXI_PREVIEW_SIZE.width, PIXI_PREVIEW_SIZE.height)
      .stroke({ color: 0x000000, width: 72, alpha });
    graphics.rect(0, 0, PIXI_PREVIEW_SIZE.width, 118)
      .fill({ color: 0x000000, alpha: alpha * 0.22 });
    graphics.rect(0, PIXI_PREVIEW_SIZE.height - 190, PIXI_PREVIEW_SIZE.width, 190)
      .fill({ color: 0x000000, alpha: alpha * 0.28 });
    this.root.addChild(graphics);
  }

  drawPaperGrain(accent, alpha = 0.22) {
    const graphics = new this.pixi.Graphics();
    const color = parsePixiColor(accent || "#f3df9e");
    graphics.rect(0, 0, PIXI_PREVIEW_SIZE.width, PIXI_PREVIEW_SIZE.height)
      .fill({ color, alpha: alpha * 0.55 });
    this.root.addChild(graphics);
    this.drawCachedFullFrameTexture(this.texturePaperGrain(), {
      alpha,
    });
  }

  drawRuneMarks(accent, timeSeconds) {
    const color = parsePixiColor(accent || "#f5d46b");
    const chars = ["*", "+", "x", "I", "V", "O"];
    for (let i = 0; i < 16; i += 1) {
      const text = new this.pixi.Text({
        text: chars[i % chars.length],
        style: { fontFamily: "Georgia, serif", fontSize: 22 + (i % 3) * 9, fontWeight: "900", fill: accent || "#f5d46b" },
      });
      const angle = (i / 16) * Math.PI * 2 + timeSeconds * 0.18;
      text.anchor.set(0.5);
      text.x = PIXI_PREVIEW_SIZE.width / 2 + Math.cos(angle) * (180 + (i % 4) * 28);
      text.y = PIXI_PREVIEW_SIZE.height * 0.46 + Math.sin(angle) * (255 + (i % 3) * 26);
      text.alpha = 0.42;
      this.root.addChild(text);
    }
    const ring = new this.pixi.Graphics();
    ring.ellipse(PIXI_PREVIEW_SIZE.width / 2, PIXI_PREVIEW_SIZE.height * 0.46, 238, 330)
      .stroke({ color, width: 2, alpha: 0.32 });
    this.root.addChild(ring);
  }

  drawSoftBloom(accent, progress) {
    const graphics = new this.pixi.Graphics();
    const color = parsePixiColor(accent || "#ffd6f0");
    graphics.circle(PIXI_PREVIEW_SIZE.width * 0.5, PIXI_PREVIEW_SIZE.height * 0.42, 150 + Math.sin(progress * Math.PI) * 80)
      .fill({ color, alpha: 0.12 });
    graphics.circle(PIXI_PREVIEW_SIZE.width * 0.25, PIXI_PREVIEW_SIZE.height * 0.7, 120)
      .fill({ color, alpha: 0.08 });
    this.root.addChild(graphics);
  }

  drawHeartLayer(accent, progress, timeSeconds) {
    for (let i = 0; i < 9; i += 1) {
      const label = new this.pixi.Text({
        text: "♥",
        style: { fontFamily: "Georgia, serif", fontSize: 24 + (i % 4) * 10, fill: accent || "#ff5fa8" },
      });
      label.anchor.set(0.5);
      label.x = 90 + ((i * 71 + timeSeconds * 18) % (PIXI_PREVIEW_SIZE.width - 180));
      label.y = 180 + ((i * 127 - timeSeconds * 34) % (PIXI_PREVIEW_SIZE.height - 360));
      label.alpha = 0.28 + Math.sin(progress * Math.PI) * 0.22;
      this.root.addChild(label);
    }
  }

  drawFireOverlay(accent, timeSeconds) {
    const graphics = new this.pixi.Graphics();
    const color = parsePixiColor(accent || "#ff7a18");
    for (let i = 0; i < 24; i += 1) {
      const x = -30 + i * 34;
      const h = 130 + Math.sin(timeSeconds * 3 + i) * 70;
      graphics.moveTo(x, PIXI_PREVIEW_SIZE.height)
        .lineTo(x + 32, PIXI_PREVIEW_SIZE.height - h)
        .lineTo(x + 70, PIXI_PREVIEW_SIZE.height)
        .closePath()
        .fill({ color, alpha: 0.2 });
    }
    this.root.addChild(graphics);
  }

  drawRain(accent, timeSeconds) {
    const color = parsePixiColor(accent || "#9fb8ff");
    const offset = (timeSeconds * 320) % PIXI_PREVIEW_SIZE.height;
    const width = PIXI_PREVIEW_SIZE.width + 120;
    const height = PIXI_PREVIEW_SIZE.height;
    for (let i = -1; i <= 0; i += 1) {
      this.drawCachedFullFrameTexture(this.textureRain(), {
        x: -60 + ((timeSeconds * 120) % 120),
        y: offset + i * height,
        width,
        height,
        tint: color,
        alpha: 0.78,
        blendMode: "screen",
      });
    }
  }

  drawFileOverlay(accent, progress) {
    const graphics = new this.pixi.Graphics();
    const p = easeOutCubic(progress);
    graphics.roundRect(70, 180 - (1 - p) * 60, PIXI_PREVIEW_SIZE.width - 140, 190, 8)
      .fill({ color: 0xf3dfb4, alpha: 0.78 })
      .stroke({ color: parsePixiColor(accent || "#cfb46a"), width: 4, alpha: 0.68 });
    graphics.rect(104, 236, 260, 9).fill({ color: 0x151515, alpha: 0.32 });
    graphics.rect(104, 270, 420, 7).fill({ color: 0x151515, alpha: 0.22 });
    this.root.addChild(graphics);
  }

  drawScrollGuide(accent, progress) {
    const graphics = new this.pixi.Graphics();
    const y = 120 + progress * (PIXI_PREVIEW_SIZE.height - 240);
    graphics.rect(42, y, PIXI_PREVIEW_SIZE.width - 84, 5)
      .fill({ color: parsePixiColor(accent || "#ffffff"), alpha: 0.62 });
    graphics.rect(PIXI_PREVIEW_SIZE.width - 82, 120, 8, PIXI_PREVIEW_SIZE.height - 240)
      .fill({ color: 0xffffff, alpha: 0.14 });
    this.root.addChild(graphics);
  }

  drawBreathFrame(accent, progress) {
    const p = 0.5 + Math.sin(progress * Math.PI * 2) * 0.5;
    const graphics = new this.pixi.Graphics();
    graphics.roundRect(52 - p * 8, 92 - p * 8, PIXI_PREVIEW_SIZE.width - 104 + p * 16, PIXI_PREVIEW_SIZE.height - 184 + p * 16, 18)
      .stroke({ color: parsePixiColor(accent || "#ffffff"), width: 3, alpha: 0.18 + p * 0.24 });
    this.root.addChild(graphics);
  }

  drawPromoTiles(accent, progress, timeSeconds) {
    const color = parsePixiColor(accent || "#ffd84d");
    const graphics = new this.pixi.Graphics();
    for (let i = 0; i < 3; i += 1) {
      graphics.roundRect(52 + i * 208, PIXI_PREVIEW_SIZE.height - 322 + Math.sin(timeSeconds + i) * 6, 164, 210, 6)
        .stroke({ color, width: 4, alpha: 0.46 })
        .fill({ color: 0x050509, alpha: 0.18 });
    }
    this.root.addChild(graphics);
    this.drawRibbonText("PROCESS", PIXI_PREVIEW_SIZE.height - 120, accent, progress);
  }

  drawRedSideText(textStyle, progress, timeSeconds) {
    const p = easeOutCubic(Math.min(progress / 0.32, 1));
    const accent = parsePixiColor(textStyle.accent || "#111111");
    const red = parsePixiColor(textStyle.fill || "#d00022");
    const panel = new this.pixi.Graphics();
    const x = -42 + p * 42;
    panel.moveTo(x, 0)
      .lineTo(PIXI_PREVIEW_SIZE.width * 0.54, 0)
      .lineTo(PIXI_PREVIEW_SIZE.width * 0.38, PIXI_PREVIEW_SIZE.height)
      .lineTo(x, PIXI_PREVIEW_SIZE.height)
      .closePath()
      .fill({ color: red, alpha: 0.94 })
      .stroke({ color: 0xffffff, width: 5, alpha: 0.74 });
    panel.moveTo(PIXI_PREVIEW_SIZE.width * 0.52, 0)
      .lineTo(PIXI_PREVIEW_SIZE.width * 0.36, PIXI_PREVIEW_SIZE.height)
      .stroke({ color: accent, width: 18, alpha: 0.88 });
    this.root.addChild(panel);

    const label = new this.pixi.Text({
      text: String(textStyle.text || "AHORA O NUNCA").toUpperCase(),
      style: {
        fontFamily: "Space Grotesk, Impact, system-ui",
        fontSize: 58,
        fontWeight: "900",
        fill: textStyle.ink || "#ffffff",
        stroke: { color: "#111111", width: 8 },
        align: "left",
        wordWrap: true,
        wordWrapWidth: 310,
        lineHeight: 62,
      },
    });
    label.x = 54 - (1 - p) * 42;
    label.y = PIXI_PREVIEW_SIZE.height * 0.36 + Math.sin(timeSeconds * 2.4) * 3;
    this.root.addChild(label);

    const strip = new this.pixi.Graphics();
    strip.rect(48, label.y + 156, 250 * p, 8).fill(0xffffff);
    strip.rect(48, label.y + 174, 180 * p, 6).fill({ color: accent, alpha: 0.85 });
    this.root.addChild(strip);
  }

  drawSlashEnergyOverlay(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ffffff";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeOutCubic(Math.min(progress / 0.56, 1));
    const pulse = 0.5 + Math.sin(timeSeconds * 10) * 0.5;
    const focus = {
      x: w * 0.54,
      y: h * 0.49,
      rx: w * 0.33,
      ry: h * 0.27,
    };

    const shadeLayer = this.createFxLayer({ blendMode: "multiply" });
    const shade = new this.pixi.Graphics();
    shade.rect(0, 0, w, h).stroke({ color: 0x020204, width: 94, alpha: 0.18 });
    shade.rect(0, 0, w, h).fill({ color: 0x050509, alpha: 0.035 });
    shadeLayer.addChild(shade);

    const lightLayer = this.createFxLayer({ blendMode: "screen" });
    const light = new this.pixi.Graphics();
    const glow = this.createFillGradient({
      type: "linear",
      start: { x: 0.12, y: 0.86 },
      end: { x: 0.86, y: 0.14 },
      colorStops: [
        { offset: 0, color: "rgba(255,255,255,0)" },
        { offset: 0.45, color: `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},0.18)` },
        { offset: 0.5, color: "rgba(255,255,255,0.34)" },
        { offset: 0.58, color: `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},0.12)` },
        { offset: 1, color: "rgba(255,255,255,0)" },
      ],
    });
    light.rect(0, 0, w, h).fill(glow || { color: accentColor, alpha: 0.08 + pulse * 0.04 });
    lightLayer.addChild(light);

    const cutLayer = this.createFxLayer({ blendMode: "screen" });
    const cuts = new this.pixi.Graphics();
    const mainStart = { x: w * 0.12 + p * 22, y: h * 0.78 };
    const mainEnd = { x: w * 0.9, y: h * 0.22 - p * 34 };
    for (let i = 0; i < 5; i += 1) {
      const offset = (i - 2) * 30 + Math.sin(timeSeconds * 8 + i) * 4;
      const width = i === 2 ? 12 : 4 + (i % 2) * 3;
      const alpha = i === 2 ? 0.58 : 0.28;
      this.drawTaperedQuad(
        cuts,
        mainStart.x - 60 + offset,
        mainStart.y + 40 + offset * 0.24,
        mainEnd.x + 30 + offset,
        mainEnd.y - 28 + offset * 0.18,
        width * 0.35,
        width,
        i === 2 ? 0xffffff : accentColor,
        alpha * p,
      );
    }
    cutLayer.addChild(cuts);

    const sparkLayer = this.createFxLayer({ blendMode: "screen" });
    const sparks = new this.pixi.Graphics();
    for (let i = 0; i < 24; i += 1) {
      const t = i / 23;
      const x = lerp(mainStart.x, mainEnd.x, t) + Math.sin(i * 11.7 + timeSeconds * 7) * 42;
      const y = lerp(mainStart.y, mainEnd.y, t) + Math.cos(i * 8.4 + timeSeconds * 6) * 34;
      const len = 16 + (i % 4) * 12;
      sparks.moveTo(x, y)
        .lineTo(x + len, y - len * 0.72)
        .stroke({ color: i % 4 === 0 ? 0xffffff : accentColor, width: 2 + (i % 3), alpha: 0.12 + p * 0.18 });
    }
    sparkLayer.addChild(sparks);

    this.restoreSpeedImpactFocus(options.panelTexture, options.camera, focus, 0.64);

    const flash = new this.pixi.Graphics();
    flash.blendMode = "screen";
    flash.rect(0, 0, w, h).fill({ color: 0xffffff, alpha: Math.max(0, 0.12 - progress * 0.18) });
    this.root.addChild(flash);
  }

  drawProfessionalHud(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#00eaff";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeOutCubic(Math.min(progress / 0.72, 1));
    const pulse = 0.5 + Math.sin(timeSeconds * 5.5) * 0.5;
    const focus = {
      x: w * (0.52 + Math.sin(timeSeconds * 0.7) * 0.012),
      y: h * (0.48 + Math.cos(timeSeconds * 0.6) * 0.01),
      rx: w * 0.3,
      ry: h * 0.25,
    };

    const grade = new this.pixi.Graphics();
    const gradeFill = this.createFillGradient({
      type: "radial",
      center: { x: focus.x / w, y: focus.y / h },
      innerRadius: 0.1,
      outerCenter: { x: 0.5, y: 0.5 },
      outerRadius: 0.86,
      colorStops: [
        { offset: 0, color: "rgba(255,255,255,0.03)" },
        { offset: 0.42, color: `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},0.08)` },
        { offset: 1, color: "rgba(0,0,0,0.24)" },
      ],
    });
    grade.rect(0, 0, w, h).fill(gradeFill || { color: accentColor, alpha: 0.06 });
    grade.blendMode = "screen";
    this.root.addChild(grade);

    const hudLayer = this.createFxLayer({ blendMode: "screen" });
    const hud = new this.pixi.Graphics();
    const left = 54;
    const top = 110;
    const right = w - 54;
    const bottom = h - 134;
    const corner = 72 + pulse * 8;
    [
      [left, top, left + corner, top],
      [left, top, left, top + corner],
      [right, top, right - corner, top],
      [right, top, right, top + corner],
      [left, bottom, left + corner, bottom],
      [left, bottom, left, bottom - corner],
      [right, bottom, right - corner, bottom],
      [right, bottom, right, bottom - corner],
    ].forEach(([x1, y1, x2, y2]) => {
      hud.moveTo(x1, y1).lineTo(x2, y2).stroke({ color: accentColor, width: 3, alpha: 0.42 + p * 0.18 });
    });
    hud.ellipse(focus.x, focus.y, focus.rx * (0.92 + pulse * 0.04), focus.ry * (0.92 + pulse * 0.04))
      .stroke({ color: accentColor, width: 2, alpha: 0.24 + pulse * 0.1 });
    hud.ellipse(focus.x, focus.y, focus.rx * 0.52, focus.ry * 0.52)
      .stroke({ color: 0xffffff, width: 2, alpha: 0.16 + pulse * 0.12 });
    for (let i = 0; i < 4; i += 1) {
      const angle = timeSeconds * 0.8 + i * Math.PI / 2;
      hud.moveTo(focus.x + Math.cos(angle) * (focus.rx * 0.65), focus.y + Math.sin(angle) * (focus.ry * 0.65))
        .lineTo(focus.x + Math.cos(angle) * (focus.rx * 1.06), focus.y + Math.sin(angle) * (focus.ry * 1.06))
        .stroke({ color: i % 2 ? 0xffffff : accentColor, width: 2, alpha: 0.28 });
    }
    hudLayer.addChild(hud);

    const dataLayer = this.createFxLayer({ blendMode: "screen" });
    const data = new this.pixi.Graphics();
    for (let i = 0; i < 9; i += 1) {
      const y = top + 74 + i * 54;
      const width = 48 + ((i * 37 + Math.floor(timeSeconds * 14)) % 130);
      const x = i % 2 ? right - 118 - width : left + 28;
      data.rect(x, y, width, 4 + (i % 3)).fill({ color: i % 4 === 0 ? 0xffffff : accentColor, alpha: 0.12 + (i % 3) * 0.035 });
    }
    dataLayer.addChild(data);

    this.restoreSpeedImpactFocus(options.panelTexture, options.camera, focus, 0.72);

    const scan = new this.pixi.Graphics();
    scan.blendMode = "screen";
    const scanY = top + ((timeSeconds * 170) % (bottom - top));
    scan.moveTo(left, scanY).lineTo(right, scanY).stroke({ color: 0xffffff, width: 5, alpha: 0.16 + pulse * 0.1 });
    scan.moveTo(left, scanY + 12).lineTo(right, scanY + 12).stroke({ color: accentColor, width: 2, alpha: 0.24 });
    this.root.addChild(scan);
  }

  drawNeonPortalTransition(textureA, textureB, transition, progress, timeSeconds, context = {}) {
    const p = easeOutCubic(Math.min(progress / 0.74, 1));
    const accent = transition.accent || "#8a7dff";
    this.drawCoverSprite(textureA, this.root, { zoom: 1.1, panX: -p * 0.05 });

    const portalLayer = new this.pixi.Container();
    this.root.addChild(portalLayer);
    this.drawCoverSprite(textureB, portalLayer, this.transitionIncomingOptions({ zoom: 1.16 - p * 0.04 }, p, context));
    const mask = new this.pixi.Graphics();
    mask.ellipse(PIXI_PREVIEW_SIZE.width / 2, PIXI_PREVIEW_SIZE.height * 0.47, 60 + p * 380, 90 + p * 540)
      .fill(0xffffff);
    portalLayer.mask = mask;
    this.root.addChild(mask);
    this.drawPortal(accent, p, timeSeconds);
    this.drawParticles(accent, timeSeconds, false);
    this.drawBadge("PIXI PORTAL PRO", accent);
  }

  drawTrailerSplitTransition(textureA, textureB, transition, progress, timeSeconds, context = {}) {
    const p = easeOutCubic(Math.min(progress / 0.7, 1));
    const accent = transition.accent || "#e44d35";
    const gutter = 16;
    const panelWidth = (PIXI_PREVIEW_SIZE.width - gutter * 4) / 3;
    const bg = new this.pixi.Graphics();
    bg.rect(0, 0, PIXI_PREVIEW_SIZE.width, PIXI_PREVIEW_SIZE.height).fill(0x050509);
    this.root.addChild(bg);
    [
      { texture: textureA, x: gutter - p * 90, y: 100, h: 820, pan: -0.08 },
      { texture: textureB, x: gutter * 2 + panelWidth, y: 220 - p * 80, h: 720, pan: 0.04 },
      { texture: textureA, x: gutter * 3 + panelWidth * 2 + p * 90, y: 140, h: 860, pan: 0.1 },
    ].forEach((panel, index) => {
      const layer = new this.pixi.Container();
      const mask = new this.pixi.Graphics();
      mask.roundRect(panel.x, panel.y, panelWidth, panel.h, 8).fill(0xffffff);
      layer.mask = mask;
      this.root.addChild(layer, mask);
      const sprite = this.drawCoverSprite(panel.texture, layer, { zoom: 1.42, panX: panel.pan + Math.sin(timeSeconds + index) * 0.015 });
      sprite.x = panel.x + panelWidth / 2;
      sprite.y = panel.y + panel.h / 2;
      const stroke = new this.pixi.Graphics();
      stroke.roundRect(panel.x, panel.y, panelWidth, panel.h, 8)
        .stroke({ color: 0xffffff, width: 4, alpha: 0.68 });
      this.root.addChild(stroke);
    });
    const title = new this.pixi.Text({
      text: "NEXT CHAPTER",
      style: {
        fontFamily: "Space Grotesk, Impact, system-ui",
        fontSize: 58,
        fontWeight: "900",
        fill: "#ffffff",
        stroke: { color: "#050509", width: 10 },
        align: "center",
      },
    });
    title.anchor.set(0.5);
    title.x = PIXI_PREVIEW_SIZE.width / 2;
    title.y = PIXI_PREVIEW_SIZE.height - 190 + Math.sin(timeSeconds * 2) * 4;
    this.root.addChild(title);
    this.drawSpeedStreaks(accent, timeSeconds, 14, 0.2);
    this.drawIncomingSettleFrame(textureB, p, context, 0.76);
  }

  drawPromoTransition(textureA, textureB, transition, progress, timeSeconds, context = {}) {
    const p = easeOutCubic(Math.min(progress / 0.72, 1));
    const accent = transition.accent || "#e44d35";
    const bg = new this.pixi.Graphics();
    bg.rect(0, 0, PIXI_PREVIEW_SIZE.width, PIXI_PREVIEW_SIZE.height).fill(0x050509);
    this.root.addChild(bg);
    const cells = [
      [28, 90, 300, 460, textureA],
      [392, 126, 300, 420, textureB],
      [76, 632, 568, 420, p > 0.5 ? textureB : textureA],
    ];
    cells.forEach(([x, y, w, h, texture], index) => {
      const layer = new this.pixi.Container();
      const mask = new this.pixi.Graphics();
      mask.roundRect(x + (index === 1 ? (1 - p) * 80 : 0), y - (index === 0 ? (1 - p) * 60 : 0), w, h, 8).fill(0xffffff);
      layer.mask = mask;
      this.root.addChild(layer, mask);
      const sprite = this.drawCoverSprite(texture, layer, { zoom: 1.35 + Math.sin(timeSeconds + index) * 0.015 });
      sprite.x = x + w / 2;
      sprite.y = y + h / 2;
      this.root.addChild(new this.pixi.Graphics().roundRect(x, y, w, h, 8).stroke({ color: 0xffffff, width: 4, alpha: 0.52 }));
    });
    this.drawRibbonText(transition.transitionType === "cta" ? "READ NOW" : "NEXT CHAPTER", PIXI_PREVIEW_SIZE.height - 140, accent, p);
    this.drawIncomingSettleFrame(textureB, p, context, 0.76);
  }

  drawSpeedWipeTransition(textureA, textureB, transition, progress, timeSeconds, context = {}) {
    const p = easeInOutCubic(Math.min(progress / 0.86, 1));
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const accent = transition.accent || "#ffffff";
    const accentColor = parsePixiColor(accent);
    const edge = -w * 0.32 + p * w * 1.64;
    const pressure = Math.max(0, 1 - Math.abs(p - 0.5) * 2);
    const shake = Math.sin(timeSeconds * 32) * pressure * 0.008;

    this.drawCoverSprite(textureA, this.root, {
      zoom: 1.08 + p * 0.055 + pressure * 0.02,
      panX: -p * 0.12 + shake,
      panY: Math.sin(timeSeconds * 5) * 0.004 - pressure * 0.01,
      rotation: -0.008 * p,
    });

    const nextLayer = new this.pixi.Container();
    this.root.addChild(nextLayer);
    this.drawCoverSprite(textureB, nextLayer, this.transitionIncomingOptions({
      zoom: 1.18 - p * 0.07 + pressure * 0.015,
      panX: 0.19 * (1 - p) + shake,
      panY: -Math.sin(timeSeconds * 4) * 0.004 + pressure * 0.006,
      rotation: 0.009 * (1 - p),
    }, p, context));

    const mask = new this.pixi.Graphics();
    mask.moveTo(edge - 120, -80)
      .lineTo(w + 120, -80)
      .lineTo(w + 120, h + 80)
      .lineTo(edge - 360, h + 80)
      .closePath()
      .fill(0xffffff);
    nextLayer.mask = mask;
    this.root.addChild(mask);

    const lineLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.88 });
    const lines = new this.pixi.Graphics();
    for (let i = 0; i < 42; i += 1) {
      const y = -80 + ((i * 71 + timeSeconds * 620) % (h + 180));
      const x = edge - 410 + (i % 8) * 42;
      const length = 240 + (i % 5) * 72 + pressure * 60;
      const width = i % 4 === 0 ? 10 : 3 + (i % 3);
      const alpha = i % 4 === 0 ? 0.36 + pressure * 0.12 : 0.15 + pressure * 0.08;
      lines.moveTo(x, y)
        .lineTo(x + length, y - 245 - (i % 4) * 20)
        .stroke({ color: i % 5 === 0 ? 0xffffff : accentColor, width, alpha });
    }
    lineLayer.addChild(lines);

    const edgeGlow = new this.pixi.Graphics();
    edgeGlow.moveTo(edge - 24, -70)
      .lineTo(edge + 92, -70)
      .lineTo(edge - 165, h + 70)
      .lineTo(edge - 282, h + 70)
      .closePath()
      .fill({ color: accentColor, alpha: 0.25 + pressure * 0.12 })
      .stroke({ color: 0xffffff, width: 6, alpha: 0.54 + pressure * 0.12 });
    this.root.addChild(edgeGlow);

    const flash = Math.max(0, 1 - Math.abs(p - 0.5) * 5.2);
    if (flash > 0) {
      const flashLayer = new this.pixi.Graphics();
      flashLayer.rect(0, 0, w, h).fill({ color: 0xffffff, alpha: flash * 0.16 });
      this.root.addChild(flashLayer);
    }
  }

  drawImpactSmashTransition(textureA, textureB, transition, progress, timeSeconds, context = {}) {
    const p = Math.max(0, Math.min(progress, 1));
    const cut = easeOutCubic(Math.max(0, Math.min((p - 0.18) / 0.48, 1)));
    const flash = Math.max(0, 1 - Math.abs(p - 0.28) * 5.4);
    const rebound = Math.sin(Math.min(cut, 1) * Math.PI);
    const accent = transition.accent || "#e44d35";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const shake = Math.max(0, 1 - p * 1.8);

    this.drawCoverSprite(textureA, this.root, {
      zoom: 1.07 + Math.sin(p * Math.PI) * 0.11,
      panX: Math.sin(timeSeconds * 31) * 0.014 * shake,
      panY: Math.cos(timeSeconds * 27) * 0.012 * shake,
      rotation: Math.sin(timeSeconds * 29) * 0.008 * shake,
      alpha: 1 - cut * 0.82,
    });

    if (cut > 0) {
      const nextLayer = new this.pixi.Container();
      this.root.addChild(nextLayer);
      this.drawCoverSprite(textureB, nextLayer, this.transitionIncomingOptions({
        zoom: 1.24 - cut * 0.15 + rebound * 0.025,
        panX: Math.sin(timeSeconds * 25) * 0.006 * (1 - cut),
        panY: Math.cos(timeSeconds * 23) * 0.006 * (1 - cut),
        rotation: -0.005 * (1 - cut),
        alpha: Math.min(1, cut * 1.25),
      }, cut, context));

      const mask = new this.pixi.Graphics();
      const radius = 90 + cut * 980;
      const cx = w * (0.5 + Math.sin(timeSeconds * 2) * 0.015);
      const cy = h * 0.45;
      const spikes = 18;
      for (let i = 0; i <= spikes * 2; i += 1) {
        const angle = (Math.PI * 2 * i) / (spikes * 2) - Math.PI / 2;
        const r = radius * (i % 2 ? 0.68 : 1.06);
        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;
        if (i === 0) mask.moveTo(x, y);
        else mask.lineTo(x, y);
      }
      mask.closePath().fill(0xffffff);
      nextLayer.mask = mask;
      this.root.addChild(mask);
    }

    const burst = new this.pixi.Graphics();
    const cx = w * 0.5;
    const cy = h * 0.44;
    for (let i = 0; i < 38; i += 1) {
      const angle = (Math.PI * 2 * i) / 38 + timeSeconds * 0.04;
      const inner = 92 + cut * 22;
      const outer = 430 + cut * 560 + (i % 5) * 30;
      const alpha = 0.08 + flash * 0.2 + cut * 0.05;
      burst.moveTo(cx + Math.cos(angle - 0.014) * inner, cy + Math.sin(angle - 0.014) * inner)
        .lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer)
        .lineTo(cx + Math.cos(angle + 0.014) * inner, cy + Math.sin(angle + 0.014) * inner)
        .closePath()
        .fill({ color: i % 3 === 0 ? 0xffffff : accentColor, alpha });
    }
    this.root.addChild(burst);

    const fracture = new this.pixi.Graphics();
    for (let i = 0; i < 11; i += 1) {
      const angle = -0.9 + i * 0.18 + Math.sin(i) * 0.04;
      const start = 58 + i * 12;
      const end = 250 + cut * 150 + (i % 4) * 24;
      fracture.moveTo(cx + Math.cos(angle) * start, cy + Math.sin(angle) * start)
        .lineTo(cx + Math.cos(angle) * end, cy + Math.sin(angle) * end)
        .stroke({ color: i % 2 ? 0xffffff : accentColor, width: i % 3 === 0 ? 5 : 3, alpha: 0.18 + flash * 0.24 });
    }
    this.root.addChild(fracture);

    if (flash > 0) {
      const flashLayer = new this.pixi.Graphics();
      flashLayer.rect(0, 0, w, h).fill({ color: 0xffffff, alpha: flash * 0.42 });
      flashLayer.circle(cx, cy, 120 + flash * 260).fill({ color: accentColor, alpha: flash * 0.18 });
      this.root.addChild(flashLayer);
    }

    if (p > 0.34) {
      this.drawHalftoneDots(accent, timeSeconds, 0.08 + cut * 0.08);
    }
  }

  drawGlitchTearProTransition(textureA, textureB, transition, progress, timeSeconds, context = {}) {
    const p = Math.max(0, Math.min(progress, 1));
    const reveal = easeInOutCubic(Math.max(0, Math.min((p - 0.16) / 0.58, 1)));
    const lock = easeOutCubic(Math.max(0, Math.min((p - 0.72) / 0.24, 1)));
    const burst = Math.sin(Math.min(Math.max((p - 0.12) / 0.68, 0), 1) * Math.PI);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const accent = transition.accent || "#42f5ff";
    const accentColor = parsePixiColor(accent);
    const tearFilterA = this.createHorrorSignalCorruptionFilter(timeSeconds, 0.006 + burst * 0.016, p);
    const tearFilterB = this.createHorrorSignalCorruptionFilter(timeSeconds + 0.27, 0.004 + burst * 0.012, p);
    const chroma = this.createChromaticPulseFilter(timeSeconds, 0.004 + burst * 0.01);

    this.drawCoverSprite(textureA, this.root, {
      zoom: 1.08 + p * 0.035 + burst * 0.025,
      panX: -reveal * 0.026 + Math.sin(timeSeconds * 24) * burst * 0.008,
      panY: Math.cos(timeSeconds * 21) * burst * 0.006,
      rotation: Math.sin(timeSeconds * 18) * burst * 0.004,
      alpha: 1 - reveal * 0.62,
      filters: [tearFilterA, chroma].filter(Boolean),
    });

    const nextLayer = new this.pixi.Container();
    nextLayer.alpha = Math.min(1, reveal * 1.28);
    this.root.addChild(nextLayer);
    this.drawCoverSprite(textureB, nextLayer, this.transitionIncomingOptions({
      zoom: 1.16 - reveal * 0.07 + burst * 0.018,
      panX: 0.044 * (1 - reveal) + Math.sin(timeSeconds * 19) * burst * 0.006,
      panY: -0.018 * (1 - reveal) + Math.cos(timeSeconds * 17) * burst * 0.005,
      rotation: -0.004 * (1 - reveal),
      filters: lock > 0.7 ? null : [tearFilterB].filter(Boolean),
    }, reveal, context));

    const mask = new this.pixi.Graphics();
    const strips = 12;
    for (let i = 0; i < strips; i += 1) {
      const row = i / strips;
      const y = row * h + Math.sin(timeSeconds * 7 + i) * (8 + burst * 12);
      const bandH = h * (0.055 + (i % 3) * 0.012 + burst * 0.008);
      const delay = (i % 5) * 0.045;
      const bandProgress = Math.max(0, Math.min((reveal - delay) / 0.72, 1));
      const width = w * (0.2 + bandProgress * 1.08);
      const x = i % 2 === 0 ? -w * 0.1 : w * (1.1 - bandProgress * 1.15);
      mask.rect(x, y, width, bandH).fill(0xffffff);
    }
    if (reveal > 0.62) {
      mask.rect(0, 0, w, h).fill({ color: 0xffffff, alpha: Math.min(1, (reveal - 0.62) / 0.24) });
    }
    nextLayer.mask = mask;
    this.root.addChild(mask);

    const shadeLayer = this.createFxLayer({ blendMode: "multiply", alpha: 0.94 });
    const shade = new this.pixi.Graphics();
    shade.rect(0, 0, w, h).fill({ color: 0x020307, alpha: 0.16 + burst * 0.22 - lock * 0.14 });
    shade.rect(0, 0, w, 152).fill({ color: 0x000000, alpha: 0.20 + burst * 0.1 });
    shade.rect(0, h - 190, w, 190).fill({ color: 0x000000, alpha: 0.24 + burst * 0.1 });
    shadeLayer.addChild(shade);

    const tearLayer = this.createFxLayer({ blendMode: "screen", alpha: 1 - lock * 0.28 });
    const tears = new this.pixi.Graphics();
    for (let i = 0; i < 18; i += 1) {
      const y = 64 + ((i * 109 + timeSeconds * (130 + burst * 310)) % (h - 128));
      const bandH = 8 + (i % 5) * 8 + burst * 9;
      const offset = Math.sin(timeSeconds * 8 + i) * (24 + burst * 74);
      const length = w * (0.22 + (i % 6) * 0.14);
      const x = i % 2 ? w - length - offset + 64 : offset - 96;
      const color = i % 5 === 0 ? 0xffffff : i % 3 === 0 ? 0xff254a : accentColor;
      tears.rect(x, y, length, bandH).fill({ color, alpha: 0.04 + burst * 0.12 + (i % 4) * 0.008 });
    }
    const scanY = -100 + ((timeSeconds * 280) % (h + 200));
    tears.rect(0, scanY, w, 30 + burst * 18).fill({ color: 0xffffff, alpha: 0.07 + burst * 0.14 });
    tears.rect(0, scanY + 37, w, 5).fill({ color: accentColor, alpha: 0.18 + burst * 0.18 });
    tearLayer.addChild(tears);

    const scanLayer = this.createFxLayer({ blendMode: "multiply", alpha: 0.62 * (1 - lock * 0.55) });
    const scan = new this.pixi.Graphics();
    for (let y = 0; y < h; y += 8) {
      scan.rect(0, y, w, 2).fill({ color: 0x000000, alpha: 0.08 + burst * 0.02 });
    }
    scanLayer.addChild(scan);

    const frameLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.82 * (1 - lock * 0.42) });
    const frame = new this.pixi.Graphics();
    frame.rect(46, 110, w - 92, h - 236).stroke({ color: accentColor, width: 2, alpha: 0.2 + burst * 0.16 });
    frame.rect(68, 134, w - 136, h - 286).stroke({ color: 0xffffff, width: 1, alpha: 0.07 + burst * 0.08 });
    for (let i = 0; i < 10; i += 1) {
      const y = 154 + ((i * 93 + timeSeconds * 90) % (h - 330));
      frame.rect(78 + (i % 3) * 28, y, 88 + (i % 5) * 36, 2).fill({ color: i % 4 ? accentColor : 0xffffff, alpha: 0.08 + burst * 0.09 });
    }
    frameLayer.addChild(frame);

    const flash = Math.max(0, 1 - Math.abs(p - 0.46) * 5.2);
    if (flash > 0) {
      const flashLayer = new this.pixi.Graphics();
      flashLayer.blendMode = "screen";
      flashLayer.rect(0, 0, w, h).fill({ color: 0xffffff, alpha: flash * 0.18 });
      flashLayer.rect(0, h * 0.44, w, 58).fill({ color: accentColor, alpha: flash * 0.16 });
      this.root.addChild(flashLayer);
    }
  }

  drawVerticalScrollCutTransition(textureA, textureB, transition, progress, timeSeconds, context = {}) {
    const p = easeInOutCubic(Math.min(progress, 1));
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const accent = transition.accent || "#7dd7ff";
    const accentColor = parsePixiColor(accent);
    const raw = Math.max(0, Math.min(progress, 1));
    const reveal = easeOutCubic(Math.max(0, Math.min((raw - 0.12) / 0.74, 1)));
    const breath = Math.sin(p * Math.PI);
    const gutterHeight = 112 + breath * 54;
    const scrollDistance = h * 0.86 + gutterHeight;
    const yA = -p * scrollDistance;
    const yB = scrollDistance * (1 - p);

    const bg = new this.pixi.Graphics();
    bg.rect(0, 0, w, h).fill({ color: 0x05070d, alpha: 1 });
    bg.rect(0, 0, w, h).fill({ color: accentColor, alpha: 0.035 + breath * 0.035 });
    this.root.addChild(bg);

    const oldLayer = new this.pixi.Container();
    this.root.addChild(oldLayer);
    this.drawCoverSprite(textureA, oldLayer, {
      zoom: 1.08 + p * 0.035,
      panY: yA / h,
      panX: Math.sin(timeSeconds * 0.6) * 0.008,
      alpha: 1 - reveal * 0.34,
    });

    const nextLayer = new this.pixi.Container();
    this.root.addChild(nextLayer);
    this.drawCoverSprite(textureB, nextLayer, this.transitionIncomingOptions({
      zoom: 1.13 - reveal * 0.04,
      panY: yB / h,
      panX: -Math.sin(timeSeconds * 0.52) * 0.006,
      alpha: Math.min(1, reveal * 1.28),
    }, reveal, context));

    const gutterY = h * 0.5 - gutterHeight / 2 + Math.sin(timeSeconds * 0.8) * 7;
    const paper = new this.pixi.Graphics();
    const glowFill = this.createFillGradient({
      type: "linear",
      start: { x: 0, y: gutterY - 92 },
      end: { x: 0, y: gutterY + gutterHeight + 92 },
      colorStops: [
        { offset: 0, color: "rgba(247,242,223,0)" },
        { offset: 0.24, color: "rgba(247,242,223,0.72)" },
        { offset: 0.5, color: "rgba(255,255,255,0.88)" },
        { offset: 0.76, color: "rgba(247,242,223,0.72)" },
        { offset: 1, color: "rgba(247,242,223,0)" },
      ],
    });
    paper.rect(0, gutterY - 88, w, gutterHeight + 176)
      .fill(glowFill || { color: 0xf7f2df, alpha: 0.74 });
    paper.rect(0, gutterY - 2, w, 2).fill({ color: 0xffffff, alpha: 0.36 });
    paper.rect(0, gutterY + gutterHeight, w, 2).fill({ color: 0x000000, alpha: 0.12 });
    this.root.addChild(paper);

    const texture = new this.pixi.Graphics();
    for (let i = 0; i < 28; i += 1) {
      const x = 38 + ((i * 73 + timeSeconds * 18) % (w - 76));
      const y = gutterY - 34 + ((i * 31 + timeSeconds * 25) % (gutterHeight + 68));
      const length = 20 + (i % 6) * 18;
      texture.moveTo(x, y)
        .lineTo(x + length, y + Math.sin(i) * 4)
        .stroke({ color: i % 2 ? 0x000000 : accentColor, width: 1, alpha: 0.035 + breath * 0.025 });
    }
    this.root.addChild(texture);

    const guide = new this.pixi.Graphics();
    guide.roundRect(w - 44, 122, 7, h - 244, 3).fill({ color: 0xffffff, alpha: 0.09 });
    guide.roundRect(w - 53, 122 + p * (h - 320), 25, 80, 12)
      .fill({ color: accentColor, alpha: 0.34 + breath * 0.1 })
      .stroke({ color: 0xffffff, width: 1.5, alpha: 0.22 });
    for (let i = 0; i < 3; i += 1) {
      const yy = gutterY + 24 + i * (gutterHeight - 48) / 2;
      guide.moveTo(52, yy).lineTo(w - 78, yy + Math.sin(i + timeSeconds) * 5)
        .stroke({ color: accentColor, width: i === 1 ? 3 : 1.5, alpha: i === 1 ? 0.22 : 0.12 });
    }
    this.root.addChild(guide);

    const shade = new this.pixi.Graphics();
    shade.rect(0, 0, w, 156).fill({ color: 0x000000, alpha: 0.26 });
    shade.rect(0, h - 206, w, 206).fill({ color: 0x000000, alpha: 0.3 });
    shade.rect(0, gutterY - 76, w, 58).fill({ color: 0x000000, alpha: 0.1 + breath * 0.05 });
    shade.rect(0, gutterY + gutterHeight + 18, w, 66).fill({ color: 0x000000, alpha: 0.12 + breath * 0.05 });
    this.root.addChild(shade);

    const sparkle = new this.pixi.Graphics();
    for (let i = 0; i < 34; i += 1) {
      const x = 62 + ((i * 53 + timeSeconds * 34) % (w - 124));
      const float = ((i * 29 + timeSeconds * 56) % Math.max(20, gutterHeight + 116));
      const y = gutterY - 42 + float;
      const size = 1.2 + (i % 4) * 0.9;
      sparkle.circle(x, y, size)
        .fill({ color: i % 5 === 0 ? 0xffffff : accentColor, alpha: 0.11 + breath * 0.13 });
      if (i % 6 === 0) {
        sparkle.ellipse(x + 8, y - 4, size * 3.2, size * 1.1)
          .fill({ color: accentColor, alpha: 0.08 + breath * 0.07 });
      }
    }
    this.root.addChild(sparkle);
  }

  drawDarkTransition(textureA, textureB, transition, progress, timeSeconds, context = {}) {
    const p = easeOutCubic(Math.min(progress / 0.62, 1));
    this.drawCoverSprite(p < 0.52 ? textureA : textureB, this.root, p < 0.52
      ? { zoom: 1.12 + Math.sin(timeSeconds * 2) * 0.01 }
      : this.transitionIncomingOptions({ zoom: 1.12 + Math.sin(timeSeconds * 2) * 0.01 }, p, context));
    const ink = new this.pixi.Graphics();
    const color = parsePixiColor(transition.accent || "#050505");
    for (let i = 0; i < 9; i += 1) {
      ink.circle(80 + i * 92 + Math.sin(timeSeconds + i) * 18, 140 + ((i * 173) % 920), 40 + p * 180 + (i % 3) * 28)
        .fill({ color, alpha: 0.15 + p * 0.35 });
    }
    ink.rect(0, 0, PIXI_PREVIEW_SIZE.width, PIXI_PREVIEW_SIZE.height)
      .fill({ color: 0x050509, alpha: Math.max(0, 0.7 - Math.abs(p - 0.5) * 1.4) });
    this.root.addChild(ink);
    if ((transition.layout || "").includes("vhs") || transition.transitionType === "glitch") this.drawGlitchBars(transition.accent, timeSeconds, 0.32);
  }

  drawSoftTransition(textureA, textureB, transition, progress, timeSeconds, context = {}) {
    const p = easeInOut(progress);
    this.drawCoverSprite(textureA, this.root, { zoom: 1.06, alpha: 1 - p });
    this.drawCoverSprite(textureB, this.root, this.transitionIncomingOptions({ zoom: 1.08, alpha: p }, p, context));
    this.drawParticles(transition.accent || "#ff8ed6", timeSeconds, (transition.layout || "").includes("petal"));
    if ((transition.layout || "").includes("heart")) this.drawHeartLayer(transition.accent || "#ff5fa8", p, timeSeconds);
  }

  drawPaperTransition(textureA, textureB, transition, progress, timeSeconds, context = {}) {
    const p = easeOutCubic(Math.min(progress / 0.76, 1));
    this.drawCoverSprite(textureB, this.root, this.transitionIncomingOptions({ zoom: 1.08 }, p, context));
    const oldLayer = new this.pixi.Container();
    this.root.addChild(oldLayer);
    this.drawCoverSprite(textureA, oldLayer, { zoom: 1.1, panX: -p * 0.12 });
    const mask = new this.pixi.Graphics();
    const edge = PIXI_PREVIEW_SIZE.width * (1 - p * 0.92);
    mask.moveTo(0, 0).lineTo(edge, 0).lineTo(edge - 150, PIXI_PREVIEW_SIZE.height).lineTo(0, PIXI_PREVIEW_SIZE.height).closePath().fill(0xffffff);
    oldLayer.mask = mask;
    this.root.addChild(mask);
    this.drawPaperGrain(transition.accent || "#f3df9e", 0.22);
    this.drawWipeLine(edge, transition.accent);
  }

  drawPopTransition(textureA, textureB, transition, progress, timeSeconds, context = {}) {
    const p = easeOutCubic(progress);
    this.drawCoverSprite(textureA, this.root, { zoom: 1.02 + Math.sin(p * Math.PI) * 0.06, alpha: 1 - p * 0.55 });
    this.drawCoverSprite(textureB, this.root, this.transitionIncomingOptions({ zoom: 1.18 - p * 0.1, alpha: p }, p, context));
    this.drawImpactBurst(transition.accent || "#ff9f1c", p, timeSeconds);
    this.drawSfxWord((transition.layout || "").includes("freeze") ? "!" : "POP", PIXI_PREVIEW_SIZE.width / 2, PIXI_PREVIEW_SIZE.height * 0.42, transition.accent || "#ff9f1c", p);
  }

  drawSlashDiagonalTransition(textureA, textureB, transition, progress, timeSeconds, context = {}) {
    const p = easeOutCubic(Math.min(progress / 0.78, 1));
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const accent = transition.accent || "#ffffff";
    const accentColor = parsePixiColor(accent);
    const cutX = lerp(-w * 0.22, w * 1.1, p);

    this.drawCoverSprite(textureA, this.root, { zoom: 1.1, panX: -0.035 * p, alpha: 1 - p * 0.22 });

    const nextLayer = new this.pixi.Container();
    this.root.addChild(nextLayer);
    this.drawCoverSprite(textureB, nextLayer, this.transitionIncomingOptions({ zoom: 1.15 - p * 0.04, panX: 0.07 * (1 - p), rotation: -0.01 * (1 - p) }, p, context));

    const mask = new this.pixi.Graphics();
    mask.moveTo(cutX - w * 0.34, 0)
      .lineTo(w, 0)
      .lineTo(w, h)
      .lineTo(cutX - w * 0.92, h)
      .closePath()
      .fill(0xffffff);
    nextLayer.mask = mask;
    this.root.addChild(mask);

    const slash = new this.pixi.Graphics();
    slash.blendMode = "screen";
    for (let i = 0; i < 5; i += 1) {
      const offset = (i - 2) * 34 + Math.sin(timeSeconds * 18 + i) * 6;
      const width = i === 2 ? 15 : 5 + (i % 2) * 3;
      slash.moveTo(cutX - 110 + offset, h + 80)
        .lineTo(cutX + 260 + offset, -90)
        .stroke({ color: i === 2 ? 0xffffff : accentColor, width, alpha: i === 2 ? 0.78 : 0.38 });
    }
    this.root.addChild(slash);

    const shards = new this.pixi.Graphics();
    shards.blendMode = "screen";
    for (let i = 0; i < 14; i += 1) {
      const y = 120 + i * 72 + Math.sin(timeSeconds * 5 + i) * 10;
      const x = cutX - 150 + (i % 4) * 42;
      shards.moveTo(x, y)
        .lineTo(x + 32 + (i % 3) * 18, y - 46)
        .lineTo(x + 74, y - 18)
        .closePath()
        .fill({ color: i % 3 === 0 ? 0xffffff : accentColor, alpha: 0.16 + (i % 3) * 0.05 });
    }
    this.root.addChild(shards);
    this.drawSpeedStreaks(accent, timeSeconds, 10, 0.1 + p * 0.08);
  }

  drawPanelSlamTransition(textureA, textureB, transition, progress, timeSeconds, context = {}) {
    const p = easeOutBack(Math.min(progress, 1));
    const settle = Math.max(0, 1 - Math.min(progress / 0.48, 1));
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const accent = transition.accent || "#ffffff";
    const accentColor = parsePixiColor(accent);

    this.drawCoverSprite(textureA, this.root, { zoom: 1.07, alpha: 0.72 - p * 0.36 });
    const shade = new this.pixi.Graphics();
    shade.rect(0, 0, w, h).fill({ color: 0x030307, alpha: 0.18 + p * 0.18 });
    this.root.addChild(shade);

    const card = new this.pixi.Container();
    card.x = Math.sin(timeSeconds * 30) * settle * 7;
    card.y = lerp(h * 0.72, 0, p) + Math.cos(timeSeconds * 28) * settle * 5;
    card.rotation = lerp(0.085, 0, p) + Math.sin(timeSeconds * 22) * settle * 0.01;
    card.scale.set(lerp(0.86, 1, p));
    this.root.addChild(card);

    const shadow = new this.pixi.Graphics();
    shadow.roundRect(38, 78, w - 76, h - 156, 28).fill({ color: 0x000000, alpha: 0.38 });
    shadow.y = 24 + settle * 18;
    card.addChild(shadow);

    const panelLayer = new this.pixi.Container();
    card.addChild(panelLayer);
    this.drawCoverSprite(textureB, panelLayer, this.transitionIncomingOptions({ zoom: 1.08 - p * 0.02 }, p, context));
    const mask = new this.pixi.Graphics();
    mask.roundRect(28, 58, w - 56, h - 116, 24).fill(0xffffff);
    panelLayer.mask = mask;
    card.addChild(mask);

    const frame = new this.pixi.Graphics();
    frame.roundRect(25, 55, w - 50, h - 110, 24).stroke({ color: 0x050505, width: 18, alpha: 0.94 });
    frame.roundRect(35, 65, w - 70, h - 130, 18).stroke({ color: accentColor, width: 4, alpha: 0.7 });
    card.addChild(frame);

    if (progress < 0.4) {
      const flash = new this.pixi.Graphics();
      flash.blendMode = "screen";
      flash.rect(0, 0, w, h).fill({ color: 0xffffff, alpha: (0.4 - progress) * 0.46 });
      this.root.addChild(flash);
      this.drawImpactBurst(accent, 1 - settle, timeSeconds);
    }
  }

  drawHologramScanTransition(textureA, textureB, transition, progress, timeSeconds, context = {}) {
    const p = easeInOut(progress);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const accent = transition.accent || "#00d4ff";
    const accentColor = parsePixiColor(accent);
    const scanY = lerp(-h * 0.08, h * 1.08, p);

    this.drawCoverSprite(textureA, this.root, { zoom: 1.08, alpha: 1 - p * 0.45 });

    const nextLayer = new this.pixi.Container();
    nextLayer.alpha = 0.82 + p * 0.18;
    nextLayer.blendMode = p < 0.86 ? "screen" : "normal";
    this.root.addChild(nextLayer);
    this.drawCoverSprite(textureB, nextLayer, this.transitionIncomingOptions({ zoom: 1.12 - p * 0.04, panX: Math.sin(timeSeconds * 18) * 0.008 * (1 - p) }, p, context));

    const mask = new this.pixi.Graphics();
    mask.rect(0, 0, w, Math.max(0, scanY)).fill(0xffffff);
    nextLayer.mask = mask;
    this.root.addChild(mask);

    const hud = new this.pixi.Graphics();
    hud.blendMode = "screen";
    hud.rect(52, 105, w - 104, h - 210).stroke({ color: accentColor, width: 2, alpha: 0.42 });
    hud.moveTo(52, scanY).lineTo(w - 52, scanY).stroke({ color: 0xffffff, width: 8, alpha: 0.5 });
    hud.moveTo(52, scanY + 18).lineTo(w - 52, scanY + 18).stroke({ color: accentColor, width: 3, alpha: 0.68 });
    for (let i = 0; i < 12; i += 1) {
      const y = (i * 83 + timeSeconds * 120) % h;
      hud.rect(70 + (i % 3) * 18, y, w - 140 - (i % 4) * 34, 2).fill({ color: accentColor, alpha: 0.12 + (i % 3) * 0.04 });
    }
    this.root.addChild(hud);
    this.drawGlitchBars(accent, timeSeconds, 0.12 + Math.sin(progress * Math.PI) * 0.12);
  }

  drawArcaneGateTransition(textureA, textureB, transition, progress, timeSeconds, context = {}) {
    const p = easeOutCubic(Math.min(progress / 0.86, 1));
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const accent = transition.accent || "#a875ff";
    const accentColor = parsePixiColor(accent);
    const cx = w / 2;
    const cy = h * 0.46;

    this.drawCoverSprite(textureA, this.root, { zoom: 1.08, alpha: 1 - p * 0.52 });
    this.drawPortal(accent, p, timeSeconds);
    this.drawRuneMarks(accent, timeSeconds);

    const nextLayer = new this.pixi.Container();
    this.root.addChild(nextLayer);
    this.drawCoverSprite(textureB, nextLayer, this.transitionIncomingOptions({ zoom: 1.2 - p * 0.1, rotation: Math.sin(timeSeconds * 0.9) * 0.01 * (1 - p) }, p, context));
    const mask = new this.pixi.Graphics();
    mask.ellipse(cx, cy, 45 + p * w * 0.7, 70 + p * h * 0.72).fill(0xffffff);
    nextLayer.mask = mask;
    this.root.addChild(mask);

    const glow = new this.pixi.Graphics();
    glow.blendMode = "screen";
    for (let i = 0; i < 4; i += 1) {
      glow.ellipse(cx, cy, 72 + p * w * 0.55 + i * 32, 120 + p * h * 0.54 + i * 42)
        .stroke({ color: i === 0 ? 0xffffff : accentColor, width: 3 + i, alpha: 0.34 - i * 0.05 });
    }
    this.root.addChild(glow);
    this.drawParticles(accent, timeSeconds, false);
  }

  drawDragonFireTransition(textureA, textureB, transition, progress, timeSeconds, context = {}) {
    const p = easeOutCubic(Math.min(progress / 0.82, 1));
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const accent = transition.accent || "#ff7a18";
    const accentColor = parsePixiColor(accent);
    const edge = lerp(-w * 0.28, w * 1.12, p);

    this.drawCoverSprite(textureA, this.root, { zoom: 1.1, alpha: 1 - p * 0.46 });
    const nextLayer = new this.pixi.Container();
    this.root.addChild(nextLayer);
    this.drawCoverSprite(textureB, nextLayer, this.transitionIncomingOptions({ zoom: 1.18 - p * 0.08, panX: 0.04 * (1 - p) }, p, context));

    const mask = new this.pixi.Graphics();
    mask.moveTo(0, 0).lineTo(Math.max(0, edge - 90), 0);
    for (let y = 0; y <= h + 80; y += 80) {
      const flame = Math.sin(y * 0.035 + timeSeconds * 6) * 42 + Math.sin(y * 0.011) * 34;
      mask.lineTo(edge + flame, y);
    }
    mask.lineTo(0, h).closePath().fill(0xffffff);
    nextLayer.mask = mask;
    this.root.addChild(mask);

    const fire = new this.pixi.Graphics();
    fire.blendMode = "screen";
    for (let i = 0; i < 18; i += 1) {
      const y = -60 + i * 74;
      const flame = Math.sin(timeSeconds * 7 + i) * 34;
      fire.moveTo(edge - 46 + flame, y + 70)
        .lineTo(edge + 44 + flame, y - 40)
        .lineTo(edge + 126 + flame, y + 70)
        .closePath()
        .fill({ color: i % 3 === 0 ? 0xffffff : accentColor, alpha: i % 3 === 0 ? 0.14 : 0.28 });
    }
    this.root.addChild(fire);
    this.drawFireOverlay(accent, timeSeconds);
  }

  drawJumpscareSnapEffect(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ffffff";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const hit = Math.pow(Math.max(0, 1 - Math.min(progress / 0.18, 1)), 1.6);
    const secondHit = Math.max(0, 1 - Math.abs(progress - 0.22) / 0.08);
    const pulse = Math.sin(Math.min(progress * 2.8, 1) * Math.PI);
    const cx = w * 0.5 + Math.sin(timeSeconds * 26) * 8 * hit;
    const cy = h * 0.46 + Math.cos(timeSeconds * 23) * 9 * hit;

    if (options.panelTexture) {
      const focusLayer = new this.pixi.Container();
      focusLayer.alpha = 0.46 + hit * 0.34 + secondHit * 0.1;
      const mask = new this.pixi.Graphics();
      mask.ellipse(cx, cy, w * 0.3 + pulse * 34, h * 0.22 + pulse * 46).fill(0xffffff);
      focusLayer.mask = mask;
      this.root.addChild(focusLayer, mask);
      this.drawCoverSprite(options.panelTexture, focusLayer, {
        zoom: 1.13 + hit * 0.16 + secondHit * 0.04,
        panX: (options.camera?.panX || 0) + Math.sin(timeSeconds * 34) * (hit + secondHit * 0.6) * 0.01,
        panY: (options.camera?.panY || 0) + Math.cos(timeSeconds * 31) * (hit + secondHit * 0.6) * 0.01,
        rotation: Math.sin(timeSeconds * 32) * hit * 0.007,
      });
    }

    const flash = new this.pixi.Graphics();
    flash.blendMode = "screen";
    flash.rect(0, 0, w, h).fill({ color: 0xffffff, alpha: hit * 0.5 + secondHit * 0.16 });
    flash.circle(cx, cy, 118 + pulse * 120).fill({ color: accentColor, alpha: hit * 0.16 + secondHit * 0.08 });
    this.root.addChild(flash);

    const dread = new this.pixi.Graphics();
    dread.blendMode = "multiply";
    dread.rect(0, 0, w, h).stroke({ color: 0x020202, width: 104, alpha: 0.18 + hit * 0.22 });
    dread.rect(0, 0, w, 170).fill({ color: 0x020202, alpha: 0.06 + hit * 0.16 });
    dread.rect(0, h - 200, w, 200).fill({ color: 0x020202, alpha: 0.08 + hit * 0.17 });
    this.root.addChild(dread);

    const scratches = new this.pixi.Graphics();
    scratches.blendMode = "screen";
    for (let i = 0; i < 16; i += 1) {
      const x = 30 + ((i * 97 + timeSeconds * 120) % (w - 60));
      const y = 90 + ((i * 131) % (h - 180));
      scratches.moveTo(x, y)
        .lineTo(x + 22 + (i % 4) * 14, y - 70 - (i % 3) * 24)
        .stroke({ color: i % 4 === 0 ? 0xff254a : 0xffffff, width: 2 + (i % 3), alpha: 0.05 + hit * 0.24 + secondHit * 0.1 });
    }
    this.root.addChild(scratches);
  }

  drawMangaImpactEffect(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ffffff";
    const layout = effect.layout || "";
    if (layout === "speed-impact") {
      this.drawSpeedLineImpactPro(effect, progress, timeSeconds, options);
      return;
    }
    if (layout === "impact-zoom") {
      this.drawImpactZoomPro(effect, progress, timeSeconds, options);
      return;
    }
    if (layout === "power-burst") {
      this.drawPowerAuraBurstPro(effect, progress, timeSeconds, options);
      return;
    }
    if (layout === "sfx-slam") {
      this.drawDesignedSfxSlam(effect, progress, timeSeconds, options);
      return;
    }
    if (layout === "page-impact") {
      this.drawPageImpactFrame(accent, progress, timeSeconds);
      return;
    }
    this.drawSpeedStreaks(accent, timeSeconds, 14, 0.16);
    this.drawImpactBurst(accent, progress, timeSeconds);
  }

  drawMangaSpeedImpactProVfx(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ffd84d";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeOutCubic(Math.min(progress / 0.62, 1));
    const hit = Math.pow(Math.max(0, 1 - Math.min(progress / 0.2, 1)), 1.45);
    const surge = Math.sin(Math.min(progress / 0.7, 1) * Math.PI);
    const aftershock = Math.max(0, Math.sin(progress * Math.PI * 3.2)) * (1 - Math.min(progress, 1));
    const jitter = hit + aftershock * 0.55;
    const focus = {
      x: w * (0.53 + Math.sin(timeSeconds * 0.8) * 0.014 + jitter * 0.012),
      y: h * (0.47 + Math.cos(timeSeconds * 0.7) * 0.012 - jitter * 0.006),
      rx: w * (0.31 + surge * 0.018),
      ry: h * (0.255 + surge * 0.014),
    };

    const chroma = this.createChromaticPulseFilter(timeSeconds, 0.005 + hit * 0.012 + aftershock * 0.004);
    const heat = this.createHeatWaveFilter(timeSeconds, 0.003 + hit * 0.006);
    const panelFx = [chroma, heat].filter(Boolean);
    this.drawPanelEcho(options.panelTexture, options.camera, {
      blendMode: "screen",
      alpha: 0.08 + hit * 0.1,
      zoomBoost: 0.062 + hit * 0.055,
      panX: 0.042 + Math.sin(timeSeconds * 18) * jitter * 0.014,
      panY: -0.026 + Math.cos(timeSeconds * 17) * jitter * 0.012,
      blur: 0.8 + hit * 1.2,
      blurQuality: 3,
    });
    this.drawPanelEcho(options.panelTexture, options.camera, {
      blendMode: "multiply",
      alpha: 0.07 + hit * 0.045,
      zoomBoost: -0.02,
      panX: -0.026 - Math.sin(timeSeconds * 16) * jitter * 0.012,
      panY: 0.018,
      rotation: -0.006,
      blur: 0.5,
    });
    if (options.panelTexture && panelFx.length) {
      const layer = this.createFxLayer({ blendMode: "normal", alpha: 0.12 + hit * 0.12 });
      this.drawCoverSprite(options.panelTexture, layer, {
        zoom: 1.15 + (options.camera?.zoom || 1) - 1 + hit * 0.06,
        panX: (options.camera?.panX || 0) - 0.022 + Math.sin(timeSeconds * 28) * hit * 0.01,
        panY: (options.camera?.panY || 0) + Math.cos(timeSeconds * 24) * hit * 0.008,
        rotation: (options.camera?.rotation || 0) + Math.sin(timeSeconds * 22) * hit * 0.004,
        filters: panelFx,
      });
    }

    const matte = this.createFxLayer({ blendMode: "multiply" });
    const matteG = new this.pixi.Graphics();
    matteG.rect(0, 0, w, h).fill({ color: 0x09080c, alpha: 0.025 + hit * 0.035 });
    matteG.rect(0, 0, w, h).stroke({ color: 0x020205, width: 150, alpha: 0.16 + hit * 0.07 });
    matteG.rect(0, 0, w, 126).fill({ color: 0x020205, alpha: 0.06 + hit * 0.05 });
    matteG.rect(0, h - 190, w, 190).fill({ color: 0x020205, alpha: 0.08 + hit * 0.06 });
    matteG.moveTo(0, h * 0.2)
      .lineTo(w, h * 0.08)
      .lineTo(w, h * 0.12)
      .lineTo(0, h * 0.26)
      .closePath()
      .fill({ color: 0x020205, alpha: 0.035 });
    matteG.moveTo(0, h * 0.76)
      .lineTo(w, h * 0.56)
      .lineTo(w, h * 0.62)
      .lineTo(0, h * 0.84)
      .closePath()
      .fill({ color: 0x020205, alpha: 0.03 });
    matte.addChild(matteG);

    const speedTexture = this.textureSpeedLines();
    const speedLayer = this.createFxLayer({ blendMode: "multiply", alpha: 0.12 + 0.14 * p });
    speedLayer.filters = [this.createBlurFilter(0.35 + surge * 0.28, 2)].filter(Boolean);
    const speedSprite = new this.pixi.Sprite(speedTexture);
    speedSprite.anchor.set(0.5);
    speedSprite.x = w * 0.5 + Math.sin(timeSeconds * 12) * (12 + jitter * 10);
    speedSprite.y = h * 0.5 + Math.cos(timeSeconds * 10) * (8 + jitter * 8);
    speedSprite.scale.set(1.14 + hit * 0.14 + surge * 0.04);
    speedSprite.rotation = -0.08 + Math.sin(timeSeconds * 2.2) * 0.018;
    speedLayer.addChild(speedSprite);

    const tunnelDark = this.createFxLayer({ blendMode: "multiply", alpha: 0.9 });
    const tunnelInk = new this.pixi.Graphics();
    for (let i = 0; i < 18; i += 1) {
      const lane = i / 17;
      const leftY = lerp(-80, h + 80, lane);
      const rightY = h - leftY + Math.sin(timeSeconds * 4 + i) * 22;
      this.drawTaperedQuad(tunnelInk, -130, leftY, focus.x - focus.rx * 0.86, focus.y + (leftY - h * 0.5) * 0.16, 42, 3, 0x000000, 0.045 + hit * 0.032);
      this.drawTaperedQuad(tunnelInk, w + 130, rightY, focus.x + focus.rx * 0.9, focus.y + (rightY - h * 0.5) * 0.14, 42, 3, 0x000000, 0.045 + hit * 0.032);
    }
    tunnelInk.rect(0, 0, 34 + hit * 18, h).fill({ color: 0x000000, alpha: 0.08 + hit * 0.05 });
    tunnelInk.rect(w - 34 - hit * 18, 0, 34 + hit * 18, h).fill({ color: 0x000000, alpha: 0.08 + hit * 0.05 });
    tunnelDark.addChild(tunnelInk);

    const velocityFrame = this.createFxLayer({ blendMode: "screen", alpha: 0.92 });
    const velocity = new this.pixi.Graphics();
    for (let i = 0; i < 22; i += 1) {
      const y = -100 + ((i * 83 + timeSeconds * (520 + hit * 320)) % (h + 220));
      const length = 260 + (i % 6) * 70 + hit * 120;
      const width = 6 + (i % 4) * 3 + hit * 5;
      const fromLeft = i % 2 === 0;
      const x1 = fromLeft ? -120 : w + 120;
      const x2 = fromLeft ? x1 + length : x1 - length;
      const y2 = y - 140 - (i % 5) * 24;
      this.drawTaperedQuad(velocity, x1, y, x2, y2, width * 1.15, 1.2, i % 5 === 0 ? 0xffffff : accentColor, 0.075 + surge * 0.045 + hit * 0.055);
    }
    velocity.moveTo(0, h * 0.14)
      .lineTo(w * 0.33, h * 0.06)
      .lineTo(w * 0.29, h * 0.11)
      .lineTo(0, h * 0.2)
      .closePath()
      .fill({ color: 0xffffff, alpha: 0.055 + hit * 0.07 });
    velocity.moveTo(w, h * 0.82)
      .lineTo(w * 0.64, h * 0.93)
      .lineTo(w * 0.68, h * 0.86)
      .lineTo(w, h * 0.74)
      .closePath()
      .fill({ color: 0xffffff, alpha: 0.05 + hit * 0.065 });
    velocityFrame.addChild(velocity);

    const signatureLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.95 });
    const signature = new this.pixi.Graphics();
    const sweep = Math.sin(timeSeconds * 3.8) * 18;
    [
      { y: h * 0.28, width: 38, alpha: 0.16, color: 0xffffff },
      { y: h * 0.34, width: 12, alpha: 0.24, color: accentColor },
      { y: h * 0.73, width: 30, alpha: 0.12, color: 0xffffff },
      { y: h * 0.79, width: 10, alpha: 0.22, color: accentColor },
    ].forEach((band, index) => {
      const offset = sweep + index * 18;
      this.drawTaperedQuad(
        signature,
        -w * 0.12 + offset,
        band.y + h * 0.18,
        w * 1.12 + offset,
        band.y - h * 0.26,
        band.width * 1.4,
        band.width * 0.36,
        band.color,
        band.alpha * 0.55 + hit * 0.04,
      );
    });
    signatureLayer.addChild(signature);

    const inkLayer = this.createFxLayer({ blendMode: "multiply", alpha: 0.82 });
    const ink = new this.pixi.Graphics();
    for (let i = 0; i < 26; i += 1) {
      const y = -80 + ((i * 71 + timeSeconds * (260 + hit * 240)) % (h + 180));
      const x = i % 2 ? -90 : w + 90;
      const endX = i % 2 ? w * (0.5 + (i % 5) * 0.08) : w * (0.5 - (i % 5) * 0.08);
      const endY = y + (i % 2 ? -210 : 210) + Math.sin(i + timeSeconds * 8) * 34;
      const width = 2 + (i % 5) * 1.2 + hit * 2;
      ink.moveTo(x, y)
        .lineTo(endX, endY)
        .stroke({ color: 0x030305, width, alpha: 0.055 + hit * 0.032 });
    }
    for (let i = 0; i < 18; i += 1) {
      const x = ((i * 127 + timeSeconds * 90) % (w + 100)) - 50;
      const y = 120 + ((i * 173) % (h - 240));
      ink.circle(x, y, 4 + (i % 4) * 4 + hit * 5).fill({ color: 0x010102, alpha: 0.035 + hit * 0.028 });
    }
    inkLayer.addChild(ink);

    const lightLayer = this.createFxLayer({ blendMode: "screen" });
    const light = new this.pixi.Graphics();
    const flash = Math.max(0, 0.34 - progress * 1.08);
    light.rect(0, 0, w, h).fill({ color: 0xffffff, alpha: flash });
    const wave = easeOutCubic(Math.min(progress / 0.58, 1));
    const waveFade = Math.max(0, 1 - progress / 0.76);
    const coreFlash = Math.max(hit, Math.sin(Math.min(progress / 0.42, 1) * Math.PI) * 0.42);
    for (let i = 0; i < 20; i += 1) {
      if (i % 5 === 2) continue;
      const angle = -Math.PI * 0.95 + (i / 19) * Math.PI * 1.9;
      const span = 0.035 + (i % 4) * 0.012 + wave * 0.018;
      const rx = focus.rx * (0.36 + wave * 1.78 + (i % 3) * 0.08);
      const ry = focus.ry * (0.26 + wave * 1.04 + (i % 4) * 0.05);
      const x1 = focus.x + Math.cos(angle) * rx;
      const y1 = focus.y + Math.sin(angle) * ry;
      const x2 = focus.x + Math.cos(angle + span) * (rx + 24 + coreFlash * 22);
      const y2 = focus.y + Math.sin(angle + span) * (ry + 16 + coreFlash * 16);
      light.moveTo(x1, y1)
        .lineTo(x2, y2)
        .stroke({
          color: i % 4 === 0 ? 0xffffff : accentColor,
          width: 2 + (i % 3) * 2 + coreFlash * 4,
          alpha: (0.055 + coreFlash * 0.075 + waveFade * 0.09) * (i % 4 === 0 ? 1.1 : 1),
        });
    }
    for (let i = 0; i < 14; i += 1) {
      const angle = -Math.PI * 0.9 + (i / 13) * Math.PI * 1.8;
      const inner = focus.rx * (0.18 + wave * 0.08);
      const outer = focus.rx * (0.54 + wave * 0.62 + (i % 4) * 0.06);
      this.drawTaperedQuad(
        light,
        focus.x + Math.cos(angle) * inner,
        focus.y + Math.sin(angle) * inner * 0.62,
        focus.x + Math.cos(angle) * outer,
        focus.y + Math.sin(angle) * outer * 0.62,
        1.2 + coreFlash * 2,
        8 + (i % 4) * 5 + coreFlash * 8,
        i % 3 ? accentColor : 0xffffff,
        0.035 + coreFlash * 0.075 + waveFade * 0.035,
      );
    }
    light.moveTo(focus.x - focus.rx * 0.24, focus.y + focus.ry * 0.08)
      .lineTo(focus.x + focus.rx * 0.16, focus.y - focus.ry * 0.14)
      .lineTo(focus.x + focus.rx * 0.42, focus.y + focus.ry * 0.06)
      .lineTo(focus.x - focus.rx * 0.08, focus.y + focus.ry * 0.22)
      .closePath()
      .fill({ color: 0xffffff, alpha: 0.025 + coreFlash * 0.05 });
    for (let i = 0; i < 34; i += 1) {
      const side = i % 2 ? -1 : 1;
      const lane = (i % 17) / 16;
      const y1 = lerp(h * 0.12, h * 0.86, lane) + Math.sin(timeSeconds * 9 + i) * (6 + jitter * 12);
      const x1 = side > 0 ? w + 70 : -70;
      const x2 = focus.x + side * lerp(focus.rx * 0.36, focus.rx * 1.1, (i % 5) / 4);
      const y2 = focus.y + (y1 - h * 0.5) * 0.42;
      const alpha = (i % 5 === 0 ? 0.12 : 0.052) + hit * (i % 4 === 0 ? 0.105 : 0.045);
      this.drawTaperedQuad(light, x1, y1, x2, y2, 20 + (i % 3) * 8, 1.1, i % 3 ? accentColor : 0xffffff, alpha);
    }
    for (let i = 0; i < 12; i += 1) {
      const y = h * (0.16 + i * 0.064) + Math.sin(timeSeconds * 14 + i) * 14;
      const offset = (timeSeconds * 780 + i * 63) % (w + 280);
      this.drawTaperedQuad(light, -190 + offset, y + 94, 40 + offset, y - 76, 2, 18 + (i % 3) * 8, i % 3 ? accentColor : 0xffffff, 0.055 + hit * 0.045);
    }
    lightLayer.addChild(light);

    const punchLayer = this.createFxLayer({ blendMode: "screen" });
    const punch = new this.pixi.Graphics();
    const slam = Math.max(hit, aftershock * 0.5);
    this.drawTaperedQuad(
      punch,
      -w * 0.05,
      focus.y + h * 0.22,
      w * 1.06,
      focus.y - h * 0.27,
      34 + slam * 38,
      16 + slam * 18,
      0xffffff,
      0.12 + slam * 0.18,
    );
    this.drawTaperedQuad(
      punch,
      -w * 0.04,
      focus.y + h * 0.18,
      w * 1.02,
      focus.y - h * 0.22,
      12 + slam * 18,
      5 + slam * 8,
      accentColor,
      0.18 + slam * 0.2,
    );
    punch.moveTo(focus.x - w * 0.34, focus.y - h * 0.06)
      .lineTo(focus.x + w * 0.34, focus.y - h * 0.13)
      .lineTo(focus.x + w * 0.26, focus.y + h * 0.11)
      .lineTo(focus.x - w * 0.38, focus.y + h * 0.18)
      .closePath()
      .stroke({ color: 0xffffff, width: 5 + slam * 5, alpha: 0.12 + slam * 0.14 })
      .stroke({ color: accentColor, width: 2 + slam * 3, alpha: 0.16 + slam * 0.16 });
    for (let i = 0; i < 16; i += 1) {
      const angle = -Math.PI * 0.9 + (i / 15) * Math.PI * 1.8;
      const inner = 150 + (i % 4) * 18;
      const outer = inner + 90 + (i % 5) * 38 + slam * 80;
      this.drawTaperedQuad(
        punch,
        focus.x + Math.cos(angle) * inner,
        focus.y + Math.sin(angle) * inner * 0.66,
        focus.x + Math.cos(angle) * outer,
        focus.y + Math.sin(angle) * outer * 0.66,
        1,
        10 + (i % 4) * 3,
        i % 3 ? accentColor : 0xffffff,
        0.08 + slam * 0.12,
      );
    }
    punchLayer.addChild(punch);

    const particleLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.82 });
    const particles = new this.pixi.Graphics();
    for (let i = 0; i < 42; i += 1) {
      const angle = (i / 42) * Math.PI * 2 + Math.sin(timeSeconds + i) * 0.08;
      const dist = 120 + ((i * 37 + timeSeconds * 170) % 420);
      const x = focus.x + Math.cos(angle) * dist;
      const y = focus.y + Math.sin(angle) * dist * 0.68;
      const size = 1.5 + (i % 5) * 1.2 + hit * 2.2;
      particles.circle(x, y, size).fill({ color: i % 4 === 0 ? 0xffffff : accentColor, alpha: 0.08 + surge * 0.09 + hit * 0.08 });
    }
    particleLayer.addChild(particles);

    const shutter = this.createFxLayer({ blendMode: "normal" });
    const shutterG = new this.pixi.Graphics();
    shutterG.rect(0, 0, w, 72 + hit * 38).fill({ color: 0x020205, alpha: 0.28 + hit * 0.15 });
    shutterG.rect(0, h - 92 - hit * 46, w, 92 + hit * 46).fill({ color: 0x020205, alpha: 0.32 + hit * 0.16 });
    shutter.addChild(shutterG);

    if (options.panelTexture) {
      const stripLayer = this.createFxLayer({ blendMode: "normal", alpha: 0.34 + hit * 0.18 + surge * 0.08 });
      this.drawCoverSprite(options.panelTexture, stripLayer, {
        zoom: 1.17 + (options.camera?.zoom || 1) - 1 + hit * 0.07,
        panX: (options.camera?.panX || 0) + Math.sin(timeSeconds * 26) * jitter * 0.009,
        panY: (options.camera?.panY || 0) + Math.cos(timeSeconds * 22) * jitter * 0.006,
        rotation: (options.camera?.rotation || 0) - 0.006 + Math.sin(timeSeconds * 18) * hit * 0.004,
        filters: [chroma, heat, this.createBlurFilter(0.18 + hit * 0.35, 2)].filter(Boolean),
      });
      const stripMask = new this.pixi.Graphics();
      stripMask.moveTo(-20, h * 0.18)
        .lineTo(w + 20, h * 0.03)
        .lineTo(w + 10, h * 0.56)
        .lineTo(-12, h * 0.78)
        .closePath()
        .fill(0xffffff);
      stripLayer.mask = stripMask;
      this.root.addChild(stripMask);
    }
  }

  drawCameraMotionOnlyProVfx(effect, progress, timeSeconds, options = {}) {
    const layout = effect.layout || "";
    if (layout === "camera-cut-panel-rhythm-pro-vfx") {
      this.drawCameraCutPanelRhythmProVfx(effect, progress, timeSeconds, options);
      return;
    }
    if (layout === "camera-manga-panel-board-pro-vfx") {
      this.drawMangaPanelBoardCameraProVfx(effect, progress, timeSeconds, options);
      return;
    }
    const accent = effect.accent || "#ffffff";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = Math.min(Math.max(progress, 0), 1);
    const energy = Math.sin(Math.min(p, 1) * Math.PI);
    const snap = Math.max(0, 1 - Math.min(p / 0.18, 1));

    const matteLayer = this.createFxLayer({ blendMode: "normal", alpha: 0.98 });
    const matte = new this.pixi.Graphics();
    const top = layout === "camera-vertical-scan-pro-vfx" ? 38 : 54 + energy * 10;
    const bottom = layout === "camera-vertical-scan-pro-vfx" ? 42 : 66 + energy * 12;
    matte.rect(0, 0, w, top).fill({ color: 0x020205, alpha: 0.12 + energy * 0.035 });
    matte.rect(0, h - bottom, w, bottom).fill({ color: 0x020205, alpha: 0.14 + energy * 0.04 });
    matte.rect(0, 0, w, h).stroke({ color: 0x020205, width: 24, alpha: 0.04 + energy * 0.025 });
    matteLayer.addChild(matte);

    if (layout === "camera-snap-zoom-pro-vfx") {
      const snapLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.7 });
      const g = new this.pixi.Graphics();
      g.rect(0, 0, w, h).fill({ color: 0xffffff, alpha: Math.max(0, 0.12 - p * 0.45) });
      g.moveTo(0, h * 0.24)
        .lineTo(w, h * 0.16)
        .stroke({ color: 0xffffff, width: 2.2, alpha: 0.08 + snap * 0.12 });
      g.moveTo(0, h * 0.74)
        .lineTo(w, h * 0.64)
        .stroke({ color: accentColor, width: 2, alpha: 0.08 + snap * 0.1 });
      snapLayer.addChild(g);
      return;
    }

    if (layout === "camera-crash-punch-in-pro-vfx") {
      const crashLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.72 });
      const g = new this.pixi.Graphics();
      g.rect(0, 0, w, h).fill({ color: 0xffffff, alpha: Math.max(0, 0.16 - p * 0.62) });
      g.moveTo(0, h * 0.2)
        .lineTo(w, h * 0.08)
        .stroke({ color: 0xffffff, width: 2.5, alpha: 0.08 + snap * 0.14 });
      g.moveTo(0, h * 0.82)
        .lineTo(w, h * 0.68)
        .stroke({ color: accentColor, width: 2.2, alpha: 0.08 + snap * 0.12 });
      crashLayer.addChild(g);
      return;
    }

    if (layout === "camera-whip-pan-pro-vfx") {
      const whipLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.62 });
      const g = new this.pixi.Graphics();
      for (let i = 0; i < 10; i += 1) {
        const y = h * (0.18 + i * 0.075) + Math.sin(timeSeconds * 3 + i) * 8;
        const offset = (timeSeconds * 160 + i * 41) % (w + 160);
        this.drawTaperedQuad(g, -120 + offset, y + 44, 90 + offset, y - 42, 2 + energy * 5, 10 + energy * 18, i % 2 ? accentColor : 0xffffff, 0.035 + energy * 0.045);
      }
      whipLayer.addChild(g);
      return;
    }

    if (layout === "camera-hero-rise-pro-vfx") {
      const riseLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.46 });
      const g = new this.pixi.Graphics();
      const y = lerp(h * 0.82, h * 0.18, easeInOutCubic(p));
      g.moveTo(0, y + 92)
        .lineTo(w, y + 28)
        .stroke({ color: accentColor, width: 2, alpha: 0.07 });
      riseLayer.addChild(g);
      return;
    }

    if (layout === "camera-dutch-drift-pro-vfx") {
      const driftLayer = this.createFxLayer({ blendMode: "multiply", alpha: 0.42 });
      const g = new this.pixi.Graphics();
      g.moveTo(0, h * 0.08)
        .lineTo(w, h * 0.0)
        .lineTo(w, h * 0.1)
        .lineTo(0, h * 0.18)
        .closePath()
        .fill({ color: 0x000000, alpha: 0.055 + energy * 0.025 });
      g.moveTo(0, h * 0.86)
        .lineTo(w, h * 0.76)
        .lineTo(w, h * 0.88)
        .lineTo(0, h * 0.98)
        .closePath()
        .fill({ color: 0x000000, alpha: 0.065 + energy * 0.025 });
      driftLayer.addChild(g);
      return;
    }

    if (["camera-noir-creep-pro-vfx", "camera-horror-creep-zoom-pro-vfx", "camera-cliffhanger-drop-pro-vfx"].includes(layout)) {
      const shadowLayer = this.createFxLayer({ blendMode: "multiply", alpha: 0.48 });
      const g = new this.pixi.Graphics();
      g.moveTo(0, h * 0.02)
        .lineTo(w, h * 0.0)
        .lineTo(w, h * 0.2)
        .lineTo(0, h * 0.34)
        .closePath()
        .fill({ color: 0x000000, alpha: layout === "camera-horror-creep-zoom-pro-vfx" ? 0.11 : 0.07 });
      g.moveTo(0, h * 0.72)
        .lineTo(w, h * 0.54)
        .lineTo(w, h)
        .lineTo(0, h)
        .closePath()
        .fill({ color: 0x000000, alpha: layout === "camera-horror-creep-zoom-pro-vfx" ? 0.13 : 0.08 });
      shadowLayer.addChild(g);
      return;
    }

    if (["camera-floating-parallax-pro-vfx", "camera-romance-drift-pro-vfx"].includes(layout)) {
      const softLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.32 });
      const g = new this.pixi.Graphics();
      g.moveTo(0, h * 0.18)
        .lineTo(w, h * 0.04)
        .stroke({ color: accentColor, width: 1.8, alpha: 0.045 });
      g.moveTo(0, h * 0.86)
        .lineTo(w, h * 0.72)
        .stroke({ color: 0xffffff, width: 1.6, alpha: 0.04 });
      softLayer.addChild(g);
      return;
    }

    if (layout === "camera-orbit-reveal-pro-vfx") {
      const orbitLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.34 });
      const g = new this.pixi.Graphics();
      g.moveTo(0, h * 0.3)
        .lineTo(w, h * 0.2)
        .stroke({ color: 0xffffff, width: 1.8, alpha: 0.045 });
      g.moveTo(0, h * 0.7)
        .lineTo(w, h * 0.58)
        .stroke({ color: accentColor, width: 1.8, alpha: 0.05 });
      orbitLayer.addChild(g);
      return;
    }

    if (layout === "camera-page-glide-pro-vfx") {
      const guideLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.28 });
      const g = new this.pixi.Graphics();
      const x = lerp(w * 0.18, w * 0.82, easeInOutCubic(p));
      g.rect(x - 18, 0, 36, h).fill({ color: 0xffffff, alpha: 0.018 });
      guideLayer.addChild(g);
      return;
    }

    if (layout === "camera-micro-shake-pro-vfx") {
      const nerveLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.4 });
      const g = new this.pixi.Graphics();
      g.rect(0, 0, w, h).fill({ color: 0xffffff, alpha: 0.012 + Math.max(0, Math.sin(timeSeconds * 18)) * 0.018 });
      nerveLayer.addChild(g);
      return;
    }

    if (layout === "camera-vertical-scan-pro-vfx") {
      const scanLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.42 });
      const g = new this.pixi.Graphics();
      const y = lerp(h * 0.16, h * 0.84, easeInOutCubic(p));
      g.rect(0, y - 18, w, 36).fill({ color: 0xffffff, alpha: 0.035 });
      g.moveTo(0, y)
        .lineTo(w, y - 10)
        .stroke({ color: accentColor, width: 1.6, alpha: 0.08 });
      scanLayer.addChild(g);
    }
  }

  drawPanelZoomProVfx(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ffffff";
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(progress, 1));
    const focus = {
      x: w * (0.5 + Math.sin(timeSeconds * 0.26) * 0.012),
      y: h * (0.46 + Math.cos(timeSeconds * 0.22) * 0.01),
      rx: w * (0.36 - p * 0.03),
      ry: h * (0.30 - p * 0.025),
    };

    const matte = new this.pixi.Graphics();
    matte.rect(0, 0, w, 118).fill({ color: 0x000000, alpha: 0.16 });
    matte.rect(0, h - 150, w, 150).fill({ color: 0x000000, alpha: 0.18 });
    matte.rect(0, 0, w, h).stroke({ color: 0x000000, width: 56, alpha: 0.12 + p * 0.06 });
    matte.blendMode = "multiply";
    this.root.addChild(matte);

    this.restoreSpeedImpactFocus(options.panelTexture, options.camera, focus, 0.92);
  }

  drawVerticalScrollProVfx(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#7dd7ff";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(progress, 1));
    const scrollY = lerp(150, h - 204, p);
    const drift = Math.sin(timeSeconds * 0.52) * 0.5 + 0.5;

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "screen",
        alpha: 0.055,
        zoomBoost: 0.026,
        panY: -0.075 + p * 0.045,
        blur: 1.6,
        blurQuality: 3,
      });
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "normal",
        alpha: 0.03,
        zoomBoost: -0.014,
        panY: 0.055 - p * 0.035,
        blur: 0.8,
      });
    }

    const shadeLayer = this.createFxLayer({ blendMode: "multiply", alpha: 0.55 });
    const shade = new this.pixi.Graphics();
    shade.rect(0, 0, w, h).stroke({ color: 0x03050b, width: 40, alpha: 0.36 });
    shade.rect(0, 0, 70, h).fill({ color: 0x03050b, alpha: 0.05 });
    shade.rect(w - 70, 0, 70, h).fill({ color: 0x03050b, alpha: 0.06 });
    shadeLayer.addChild(shade);

    const gutters = this.createFxLayer({ blendMode: "normal" });
    const g = new this.pixi.Graphics();
    for (let i = 0; i < 8; i += 1) {
      const y = -180 + ((timeSeconds * 66 + i * 226) % (h + 360));
      const tallBeat = i % 3 === 0;
      const rowAlpha = tallBeat ? 0.075 : 0.038;
      g.roundRect(52, y, w - 104, tallBeat ? 24 : 10, tallBeat ? 8 : 4).fill({ color: 0xffffff, alpha: rowAlpha });
      g.rect(78, y + (tallBeat ? 46 : 28), w - 156, 2).fill({ color: accentColor, alpha: 0.055 + drift * 0.025 });
    }

    g.roundRect(w - 29, 140, 5, h - 292, 3).fill({ color: 0xffffff, alpha: 0.12 });
    g.roundRect(w - 36, scrollY - 55, 19, 110, 9).fill({ color: accentColor, alpha: 0.40 });
    g.roundRect(w - 32, scrollY - 35, 11, 70, 5).fill({ color: 0xffffff, alpha: 0.18 });

    for (let i = 0; i < 5; i += 1) {
      const markerY = 172 + i * ((h - 352) / 4);
      const active = Math.max(0, 1 - Math.abs(scrollY - markerY) / 130);
      g.roundRect(30, markerY - 22, 5, 44, 3).fill({ color: active > 0.16 ? accentColor : 0xffffff, alpha: 0.12 + active * 0.28 });
      g.rect(42, markerY, 28 + active * 22, 1).fill({ color: accentColor, alpha: 0.07 + active * 0.18 });
    }
    gutters.addChild(g);

    const revealLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.92 });
    const reveal = new this.pixi.Graphics();
    const bandY = lerp(h * 0.18, h * 0.78, p);
    reveal.rect(48, bandY - 58, w - 96, 116).fill({ color: 0xffffff, alpha: 0.022 });
    reveal.rect(60, bandY - 7, w - 120, 4).fill({ color: accentColor, alpha: 0.24 });
    reveal.rect(92, bandY + 16, w - 184, 1).fill({ color: 0xffffff, alpha: 0.11 });
    for (let i = 0; i < 12; i += 1) {
      const x = 88 + ((i * 47 + timeSeconds * 28) % (w - 176));
      const y = bandY - 46 + Math.sin(i * 1.9 + timeSeconds * 1.8) * 42;
      reveal.rect(x, y, 18 + (i % 4) * 8, 2).fill({ color: i % 2 ? accentColor : 0xffffff, alpha: 0.08 });
    }
    revealLayer.addChild(reveal);

    const momentumLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.7 });
    const momentum = new this.pixi.Graphics();
    for (let i = 0; i < 18; i += 1) {
      const side = i % 2 === 0 ? 1 : -1;
      const x = side > 0 ? w - 86 - (i % 4) * 12 : 86 + (i % 4) * 12;
      const y = -80 + ((timeSeconds * (82 + (i % 5) * 9) + i * 92) % (h + 160));
      const len = 28 + (i % 5) * 14;
      momentum.rect(x, y, 2, len).fill({ color: i % 3 === 0 ? accentColor : 0xffffff, alpha: 0.08 + (i % 4) * 0.012 });
    }
    momentumLayer.addChild(momentum);

    const soft = new this.pixi.Graphics();
    const fadeTop = this.createFillGradient({
      type: "linear",
      start: { x: 0.5, y: 0 },
      end: { x: 0.5, y: 0.28 },
      colorStops: [
        { offset: 0, color: "rgba(5,6,12,0.44)" },
        { offset: 1, color: "rgba(5,6,12,0)" },
      ],
    });
    const fadeBottom = this.createFillGradient({
      type: "linear",
      start: { x: 0.5, y: 0.72 },
      end: { x: 0.5, y: 1 },
      colorStops: [
        { offset: 0, color: "rgba(5,6,12,0)" },
        { offset: 1, color: "rgba(5,6,12,0.44)" },
      ],
    });
    soft.rect(0, 0, w, h * 0.30).fill(fadeTop || { color: 0x05060c, alpha: 0.22 });
    soft.rect(0, h * 0.70, w, h * 0.30).fill(fadeBottom || { color: 0x05060c, alpha: 0.22 });
    this.root.addChild(soft);
  }

  drawWebtoonManhwaProVfx(effect, progress, timeSeconds, options = {}) {
    const layout = effect.layout || "";
    if (layout === "webtoon-long-page-glide") this.drawWebtoonLongPageGlide(effect, progress, timeSeconds, options);
    else if (layout === "webtoon-floating-panel-stack") this.drawWebtoonFloatingPanelStack(effect, progress, timeSeconds, options);
    else if (layout === "manhwa-drama-eye-push") this.drawManhwaDramaEyePush(effect, progress, timeSeconds, options);
    else if (layout === "webtoon-blur-to-clarity") this.drawWebtoonBlurToClarity(effect, progress, timeSeconds, options);
    else if (layout === "manhwa-soft-glow-hold") this.drawManhwaSoftGlowHold(effect, progress, timeSeconds, options);
    else if (layout === "webtoon-gutter-pause-focus") this.drawWebtoonGutterPauseFocus(effect, progress, timeSeconds, options);
    else if (layout === "webtoon-scroll-snap-beat") this.drawWebtoonScrollSnapBeat(effect, progress, timeSeconds, options);
    else if (layout === "manhwa-depth-layer-drift") this.drawManhwaDepthLayerDrift(effect, progress, timeSeconds, options);
    else if (layout === "webtoon-cliffhanger-drop-hold") this.drawWebtoonCliffhangerDropHold(effect, progress, timeSeconds, options);
    else if (layout === "webtoon-panel-stitch-reveal") this.drawWebtoonPanelStitchReveal(effect, progress, timeSeconds, options);
    else if (layout === "webtoon-scroll-fold-hook") this.drawWebtoonScrollFoldHook(effect, progress, timeSeconds, options);
    else if (layout === "manhwa-dialogue-ladder-focus") this.drawManhwaDialogueLadderFocus(effect, progress, timeSeconds, options);
    else if (layout === "camera-cut-panel-rhythm-pro-vfx") this.drawCameraCutPanelRhythmProVfx(effect, progress, timeSeconds, options);
    else if (layout === "manhwa-character-reveal-scan") this.drawManhwaCharacterRevealScan(effect, progress, timeSeconds, options);
    else if (layout === "manhwa-reaction-beat-stack") this.drawManhwaReactionBeatStack(effect, progress, timeSeconds, options);
    else if (layout === "webtoon-social-panel-tease") this.drawWebtoonSocialPanelTease(effect, progress, timeSeconds, options);
    else if (layout === "webtoon-cover-drop-tease") this.drawWebtoonCoverDropTease(effect, progress, timeSeconds, options);
    else if (layout === "manhwa-rain-window-drama") this.drawManhwaRainWindowDrama(effect, progress, timeSeconds, options);
    else if (layout === "manhwa-neon-city-scroll") this.drawManhwaNeonCityScroll(effect, progress, timeSeconds, options);
    else if (layout === "manhwa-royal-entrance-glow") this.drawManhwaRoyalEntranceGlow(effect, progress, timeSeconds, options);
  }

  drawWebtoonVerticalFades(strength = 0.38, color = 0x05060c) {
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const layer = new this.pixi.Graphics();
    const top = this.createFillGradient({
      type: "linear",
      start: { x: 0.5, y: 0 },
      end: { x: 0.5, y: 0.26 },
      colorStops: [
        { offset: 0, color: `rgba(5,6,12,${strength})` },
        { offset: 1, color: "rgba(5,6,12,0)" },
      ],
    });
    const bottom = this.createFillGradient({
      type: "linear",
      start: { x: 0.5, y: 0.72 },
      end: { x: 0.5, y: 1 },
      colorStops: [
        { offset: 0, color: "rgba(5,6,12,0)" },
        { offset: 1, color: `rgba(5,6,12,${strength})` },
      ],
    });
    layer.rect(0, 0, w, h * 0.3).fill(top || { color, alpha: strength * 0.5 });
    layer.rect(0, h * 0.68, w, h * 0.32).fill(bottom || { color, alpha: strength * 0.5 });
    this.root.addChild(layer);
  }

  drawWebtoonLongPageGlide(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#9edcff";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(progress, 1));
    const guideY = lerp(h * 0.18, h * 0.82, p);

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "screen",
        alpha: 0.07,
        zoomBoost: 0.018,
        panY: -0.09 + p * 0.16,
        blur: 1.4,
        blurQuality: 3,
      });
    }

    const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.88 });
    const g = new this.pixi.Graphics();
    g.roundRect(46, 100, w - 92, h - 214, 16)
      .stroke({ color: 0xffffff, width: 1.5, alpha: 0.1 })
      .stroke({ color: accentColor, width: 2, alpha: 0.08 });
    for (let i = 0; i < 7; i += 1) {
      const y = -120 + ((timeSeconds * 52 + i * 220) % (h + 240));
      g.roundRect(58, y, w - 116, i % 3 === 0 ? 22 : 8, 5).fill({ color: 0xffffff, alpha: i % 3 === 0 ? 0.055 : 0.028 });
      g.rect(84, y + 38, w - 168, 2).fill({ color: accentColor, alpha: 0.045 });
    }
    g.rect(70, guideY - 2, w - 140, 4).fill({ color: accentColor, alpha: 0.28 });
    g.rect(106, guideY + 14, w - 212, 1).fill({ color: 0xffffff, alpha: 0.14 });
    g.roundRect(w - 32, 136, 5, h - 276, 3).fill({ color: 0xffffff, alpha: 0.1 });
    g.roundRect(w - 40, guideY - 50, 21, 100, 11).fill({ color: accentColor, alpha: 0.34 });
    layer.addChild(g);
    this.drawWebtoonVerticalFades(0.42);
  }

  drawWebtoonFloatingPanelStack(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ffffff";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeOutBack(Math.min(progress / 0.82, 1));
    const float = Math.sin(timeSeconds * 0.8) * 8;

    const shade = this.createFxLayer({ blendMode: "multiply", alpha: 0.52 });
    const shadeG = new this.pixi.Graphics();
    shadeG.rect(0, 0, w, h).fill({ color: 0x05060c, alpha: 0.12 });
    shade.addChild(shadeG);

    const frames = [
      { x: 70, y: 155, width: 520, height: 250, delay: 0, rot: -0.025 },
      { x: 112, y: 458, width: 496, height: 300, delay: 0.12, rot: 0.018 },
      { x: 62, y: 812, width: 540, height: 270, delay: 0.24, rot: -0.012 },
    ];
    frames.forEach((frame, index) => {
      const t = easeOutBack(Math.min(Math.max((progress - frame.delay) / 0.42, 0), 1));
      const y = frame.y + (1 - t) * 90 + float * (index + 1) * 0.35;
      const card = this.createFxLayer({ blendMode: "normal", alpha: 0.72 + t * 0.2 });
      const g = new this.pixi.Graphics();
      g.roundRect(frame.x + 10, y + 14, frame.width, frame.height, 16).fill({ color: 0x000000, alpha: 0.26 * t });
      g.roundRect(frame.x, y, frame.width, frame.height, 16)
        .fill({ color: 0xffffff, alpha: 0.08 + t * 0.05 })
        .stroke({ color: index === 1 ? accentColor : 0xffffff, width: index === 1 ? 4 : 2, alpha: 0.18 + t * 0.34 });
      card.rotation = frame.rot * t;
      card.addChild(g);
      if (options.panelTexture) {
        const inner = new this.pixi.Container();
        inner.x = frame.x + 14;
        inner.y = y + 14;
        inner.rotation = frame.rot * t;
        this.root.addChild(inner);
        this.drawCoverSprite(options.panelTexture, inner, {
          zoom: 1.22 + index * 0.05,
          panX: (index - 1) * 0.04 + Math.sin(timeSeconds * 0.42 + index) * 0.01,
          panY: (index - 1) * -0.05,
          alpha: 0.18 + t * 0.22,
          filters: [this.createBlurFilter(index === 1 ? 0.4 : 1.6, 2)].filter(Boolean),
        });
        const mask = new this.pixi.Graphics();
        mask.roundRect(frame.x + 14, y + 14, frame.width - 28, frame.height - 28, 12).fill(0xffffff);
        this.root.addChild(mask);
        inner.mask = mask;
      }
    });

    const lineLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.45 });
    const line = new this.pixi.Graphics();
    line.moveTo(w * 0.5, 112).lineTo(w * 0.5, h - 112).stroke({ color: accentColor, width: 2, alpha: 0.10 });
    lineLayer.addChild(line);
    this.drawWebtoonVerticalFades(0.34);
  }

  drawManhwaDramaEyePush(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ffd6f2";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(progress, 1));
    const focus = { x: w * 0.5, y: h * 0.38, rx: w * (0.34 - p * 0.05), ry: h * (0.16 - p * 0.02) };

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "normal",
        alpha: 0.18 + p * 0.12,
        zoomBoost: 0.08 + p * 0.08,
        panY: -0.09,
        blur: 0.6,
      });
    }

    const grade = this.createFxLayer({ blendMode: "multiply", alpha: 0.76 });
    const g = new this.pixi.Graphics();
    g.rect(0, 0, w, h).fill({ color: 0x120912, alpha: 0.08 + p * 0.06 });
    g.rect(0, 0, w, 235).fill({ color: 0x050509, alpha: 0.2 });
    g.rect(0, h - 265, w, 265).fill({ color: 0x050509, alpha: 0.2 });
    grade.addChild(g);

    const focusLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.86 });
    const f = new this.pixi.Graphics();
    f.ellipse(focus.x, focus.y, focus.rx * (1.12 + p * 0.08), focus.ry * (1.1 + p * 0.08))
      .stroke({ color: 0xffffff, width: 2, alpha: 0.16 + p * 0.08 });
    f.rect(76, focus.y - 86, w - 152, 3).fill({ color: accentColor, alpha: 0.18 + p * 0.12 });
    f.rect(118, focus.y + 82, w - 236, 1).fill({ color: 0xffffff, alpha: 0.14 });
    for (let i = 0; i < 18; i += 1) {
      const side = i % 2 ? -1 : 1;
      const y = focus.y - 100 + i * 12;
      this.drawTaperedQuad(f, side > 0 ? w + 24 : -24, y, focus.x + side * focus.rx, focus.y + (y - focus.y) * 0.22, 18, 1, i % 3 ? accentColor : 0xffffff, 0.025 + p * 0.045);
    }
    focusLayer.addChild(f);
    this.restoreSpeedImpactFocus(options.panelTexture, options.camera, focus, 0.72);
  }

  drawWebtoonBlurToClarity(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#d7f4ff";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const clear = easeInOutCubic(Math.min(progress / 0.78, 1));

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "normal",
        alpha: 0.62 * (1 - clear),
        zoomBoost: 0.04,
        blur: 8 - clear * 6.5,
        blurQuality: 4,
      });
    }

    const veil = this.createFxLayer({ blendMode: "screen", alpha: 0.92 });
    const g = new this.pixi.Graphics();
    g.rect(0, 0, w, h).fill({ color: 0xffffff, alpha: Math.max(0, 0.18 - clear * 0.16) });
    const y = lerp(h * 0.24, h * 0.76, clear);
    g.rect(52, y - 44, w - 104, 88).fill({ color: 0xffffff, alpha: 0.028 });
    g.rect(76, y, w - 152, 3).fill({ color: accentColor, alpha: 0.25 });
    for (let i = 0; i < 20; i += 1) {
      const x = 50 + ((i * 59 + timeSeconds * 16) % (w - 100));
      const py = h * 0.16 + ((i * 97 - timeSeconds * 20) % (h * 0.72));
      g.circle(x, py, 2 + (i % 4)).fill({ color: i % 4 ? accentColor : 0xffffff, alpha: 0.035 + clear * 0.025 });
    }
    veil.addChild(g);
    this.drawWebtoonVerticalFades(0.3);
  }

  drawManhwaSoftGlowHold(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ffc8e8";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(progress, 1));
    const breath = 0.5 + Math.sin(timeSeconds * 0.86) * 0.5;

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "screen",
        alpha: 0.2 + breath * 0.08,
        zoomBoost: 0.034,
        blur: 5.5,
        blurQuality: 4,
      });
    }

    const glow = this.createFxLayer({ blendMode: "screen", alpha: 0.78 });
    const g = new this.pixi.Graphics();
    g.rect(0, 0, w, h).fill({ color: accentColor, alpha: 0.045 + breath * 0.025 });
    this.drawTaperedQuad(g, -80, h * 0.2, w * 0.82, h * 0.04, 95, 18, 0xffffff, 0.04 + breath * 0.035);
    this.drawTaperedQuad(g, w * 0.12, h * 1.04, w * 1.06, h * 0.62, 24, 120, accentColor, 0.035 + breath * 0.025);
    glow.addChild(g);

    const dust = this.createFxLayer({ blendMode: "screen", alpha: 0.9 });
    const d = new this.pixi.Graphics();
    for (let i = 0; i < 58; i += 1) {
      const depth = (i % 8) / 7;
      const x = 34 + ((i * 83 + Math.sin(timeSeconds * 0.3 + i) * 20) % (w - 68));
      const y = 80 + ((i * 127 - timeSeconds * (14 + depth * 26)) % (h - 160));
      d.circle(x, y, 1.5 + depth * 4.2).fill({ color: i % 6 === 0 ? 0xffffff : accentColor, alpha: 0.065 + depth * 0.04 + p * 0.02 });
    }
    dust.addChild(d);
    this.drawWebtoonVerticalFades(0.22);
  }

  drawWebtoonGutterPauseFocus(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#f7f4e8";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(progress, 1));

    const layer = this.createFxLayer({ blendMode: "normal", alpha: 0.92 });
    const g = new this.pixi.Graphics();
    g.rect(0, 0, w, 142).fill({ color: 0xf9f5ed, alpha: 0.15 });
    g.rect(0, h - 168, w, 168).fill({ color: 0xf9f5ed, alpha: 0.16 });
    g.roundRect(48, 166, w - 96, h - 364, 18)
      .stroke({ color: 0xffffff, width: 2, alpha: 0.15 })
      .stroke({ color: accentColor, width: 2, alpha: 0.08 + p * 0.08 });
    g.rect(82, h * 0.5 - 2, w - 164, 4).fill({ color: accentColor, alpha: 0.08 + p * 0.14 });
    for (let i = 0; i < 5; i += 1) {
      const y = 186 + i * ((h - 410) / 4);
      g.rect(58, y, 30, 1).fill({ color: accentColor, alpha: 0.08 });
      g.rect(w - 88, y, 30, 1).fill({ color: accentColor, alpha: 0.08 });
    }
    layer.addChild(g);
    this.restoreSpeedImpactFocus(options.panelTexture, options.camera, { x: w * 0.5, y: h * 0.5, rx: w * 0.39, ry: h * 0.33 }, 0.92);
    this.drawWebtoonVerticalFades(0.26);
  }

  drawWebtoonScrollSnapBeat(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ffd84d";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const snap = easeOutBack(Math.min(progress / 0.34, 1));
    const settle = Math.max(0, 1 - Math.min(Math.max((progress - 0.18) / 0.42, 0), 1));

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "screen",
        alpha: 0.16 + settle * 0.08,
        zoomBoost: 0.04 + settle * 0.05,
        panY: -0.12 + snap * 0.16,
        blur: 1.2 + settle * 1.1,
      });
    }

    const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.9 });
    const g = new this.pixi.Graphics();
    const hitY = h * (0.36 + snap * 0.18);
    g.rect(46, hitY - 42, w - 92, 84).fill({ color: 0xffffff, alpha: 0.035 + settle * 0.04 });
    g.rect(76, hitY, w - 152, 6).fill({ color: accentColor, alpha: 0.32 + settle * 0.12 });
    for (let i = 0; i < 24; i += 1) {
      const side = i % 2 ? -1 : 1;
      const y = -80 + ((timeSeconds * 110 + i * 70) % (h + 160));
      this.drawTaperedQuad(g, side > 0 ? w + 22 : -22, y, w * 0.5 + side * 90, hitY + (y - h * 0.5) * 0.18, 16 + settle * 16, 1, i % 3 ? accentColor : 0xffffff, 0.05 + settle * 0.08);
    }
    layer.addChild(g);
    this.drawWebtoonVerticalFades(0.34);
  }

  drawManhwaDepthLayerDrift(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#b8d7ff";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(progress, 1));

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "screen",
        alpha: 0.12,
        zoomBoost: 0.055,
        panX: Math.sin(timeSeconds * 0.32) * 0.02,
        panY: -0.025 + p * 0.035,
        blur: 3.4,
        blurQuality: 4,
      });
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "multiply",
        alpha: 0.12,
        zoomBoost: -0.018,
        panX: Math.sin(timeSeconds * 0.25) * -0.016,
        panY: 0.04 - p * 0.025,
        blur: 1.1,
      });
    }

    const haze = this.createFxLayer({ blendMode: "screen", alpha: 0.75 });
    const g = new this.pixi.Graphics();
    g.rect(0, 0, w, h).fill({ color: accentColor, alpha: 0.038 });
    for (let i = 0; i < 9; i += 1) {
      const y = h * (0.15 + i * 0.085) + Math.sin(timeSeconds * 0.5 + i) * 22;
      this.drawTaperedQuad(g, -60, y, w + 70, y - 80 - i * 5, 24 + i * 4, 80 + i * 8, i % 3 ? accentColor : 0xffffff, 0.025 + (i % 3) * 0.01);
    }
    haze.addChild(g);

    const particles = this.createFxLayer({ blendMode: "screen", alpha: 0.65 });
    const d = new this.pixi.Graphics();
    for (let i = 0; i < 42; i += 1) {
      const depth = (i % 6) / 5;
      const x = 20 + ((i * 73 + timeSeconds * (10 + depth * 40)) % (w - 40));
      const y = 70 + ((i * 139 - timeSeconds * (12 + depth * 34)) % (h - 140));
      d.ellipse(x, y, 2 + depth * 5, 7 + depth * 15).fill({ color: i % 4 ? accentColor : 0xffffff, alpha: 0.04 + depth * 0.045 });
    }
    particles.addChild(d);
    this.drawWebtoonVerticalFades(0.28);
  }

  drawWebtoonCliffhangerDropHold(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#d7e2ff";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(progress, 1));
    const hold = Math.max(0, Math.min((progress - 0.62) / 0.38, 1));

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "normal",
        alpha: 0.12 + hold * 0.14,
        zoomBoost: 0.035 + hold * 0.025,
        panY: -0.1 + p * 0.19,
        blur: 1.2 + hold * 1.6,
      });
    }

    const dark = this.createFxLayer({ blendMode: "multiply", alpha: 0.94 });
    const g = new this.pixi.Graphics();
    g.rect(0, 0, w, h).fill({ color: 0x04050a, alpha: 0.08 + hold * 0.18 });
    g.rect(0, h - 260, w, 260).fill({ color: 0x020205, alpha: 0.24 + hold * 0.2 });
    g.roundRect(52, lerp(122, h - 356, p), w - 104, 116 + hold * 28, 18)
      .fill({ color: 0x000000, alpha: 0.12 + hold * 0.12 })
      .stroke({ color: accentColor, width: 2, alpha: 0.16 + hold * 0.16 });
    dark.addChild(g);

    const suspense = this.createFxLayer({ blendMode: "screen", alpha: 0.78 });
    const s = new this.pixi.Graphics();
    const y = lerp(h * 0.26, h * 0.74, p);
    s.rect(72, y, w - 144, 3).fill({ color: accentColor, alpha: 0.12 + hold * 0.18 });
    for (let i = 0; i < 11; i += 1) {
      const x = 72 + i * ((w - 144) / 10);
      s.circle(x, h - 148 + Math.sin(timeSeconds * 1.4 + i) * 5, 2 + hold * 2).fill({ color: i % 2 ? accentColor : 0xffffff, alpha: 0.07 + hold * 0.08 });
    }
    suspense.addChild(s);
    this.drawWebtoonVerticalFades(0.52);
  }

  drawWebtoonPremiumShade(accentColor = 0xffffff, strength = 0.26, options = {}) {
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const shade = this.createFxLayer({ blendMode: "multiply", alpha: 0.92 });
    const g = new this.pixi.Graphics();
    const vignette = this.createFillGradient({
      type: "radial",
      center: { x: options.cx ?? 0.5, y: options.cy ?? 0.48 },
      innerRadius: options.inner ?? 0.12,
      outerCenter: { x: 0.5, y: 0.5 },
      outerRadius: options.outer ?? 0.84,
      colorStops: [
        { offset: 0, color: "rgba(0,0,0,0)" },
        { offset: 0.62, color: "rgba(0,0,0,0.08)" },
        { offset: 1, color: `rgba(0,0,0,${strength})` },
      ],
    });
    g.rect(0, 0, w, h).fill(vignette || { color: 0x05060c, alpha: strength * 0.45 });
    g.rect(0, 0, w, h * 0.14).fill({ color: 0x020308, alpha: strength * 0.55 });
    g.rect(0, h * 0.84, w, h * 0.16).fill({ color: 0x020308, alpha: strength * 0.62 });
    shade.addChild(g);

    const tint = this.createFxLayer({ blendMode: "screen", alpha: 0.62 });
    const t = new this.pixi.Graphics();
    t.rect(0, 0, w, h).fill({ color: accentColor, alpha: 0.026 });
    tint.addChild(t);
  }

  drawWebtoonPhoneRail(accentColor, progress, timeSeconds, options = {}) {
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const rail = this.createFxLayer({ blendMode: "screen", alpha: options.alpha ?? 0.62 });
    const g = new this.pixi.Graphics();
    const x = options.side === "left" ? 28 : w - 34;
    g.roundRect(x, 128, 5, h - 260, 3).fill({ color: 0xffffff, alpha: 0.06 });
    const thumbY = lerp(152, h - 232, easeInOutCubic(Math.min(progress, 1)));
    g.roundRect(x - 7, thumbY - 42, 19, 84, 10).fill({ color: accentColor, alpha: 0.2 });
    g.roundRect(x - 3, thumbY - 28, 11, 56, 7).fill({ color: 0xffffff, alpha: 0.08 });
    for (let i = 0; i < 4; i += 1) {
      const y = 180 + i * ((h - 360) / 3);
      const active = Math.max(0, 1 - Math.abs(y - thumbY) / 170);
      g.rect(options.side === "left" ? x + 18 : x - 48, y, 30 + active * 26, 1.5)
        .fill({ color: active > 0.12 ? accentColor : 0xffffff, alpha: 0.06 + active * 0.18 });
    }
    rail.addChild(g);
  }

  drawWebtoonPanelStitchReveal(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#8fe8ff";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(progress, 1));
    this.drawWebtoonPremiumShade(accentColor, 0.24, { cy: 0.48 });

    if (options.panelTexture) {
      const strips = [
        { y: 98, height: 248, panY: -0.18, delay: 0 },
        { y: 388, height: 286, panY: -0.02, delay: 0.12 },
        { y: 730, height: 270, panY: 0.16, delay: 0.24 },
      ];
      strips.forEach((strip, index) => {
        const t = easeOutCubic(Math.min(Math.max((progress - strip.delay) / 0.52, 0), 1));
        const layer = new this.pixi.Container();
        layer.alpha = 0.78 + t * 0.12;
        layer.y = (1 - t) * 80;
        const mask = new this.pixi.Graphics();
        mask.roundRect(54, strip.y, w - 108, strip.height, 14).fill(0xffffff);
        layer.mask = mask;
        this.root.addChild(layer, mask);
        this.drawCoverSprite(options.panelTexture, layer, {
          zoom: 1.2 + index * 0.06,
          panY: strip.panY + Math.sin(timeSeconds * 0.32 + index) * 0.012,
          panX: (index - 1) * 0.025,
        });
      });
    }

    const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.86 });
    const g = new this.pixi.Graphics();
    [360, 702].forEach((y, index) => {
      const wave = Math.sin(timeSeconds * 1.4 + index) * 6;
      g.rect(70, y + wave, w - 140, 2).fill({ color: accentColor, alpha: 0.22 });
      g.rect(102, y + 18 + wave, w - 204, 1).fill({ color: 0xffffff, alpha: 0.1 });
      for (let i = 0; i < 10; i += 1) {
        const x = 82 + i * ((w - 164) / 9);
        g.circle(x, y + wave, 2.5).fill({ color: i % 2 ? accentColor : 0xffffff, alpha: 0.1 });
      }
    });
    const scanY = lerp(118, h - 190, p);
    g.rect(58, scanY, w - 116, 4).fill({ color: 0xffffff, alpha: 0.12 });
    g.rect(88, scanY + 10, w - 176, 2).fill({ color: accentColor, alpha: 0.24 });
    layer.addChild(g);
    this.drawWebtoonPhoneRail(accentColor, progress, timeSeconds);
    this.drawWebtoonVerticalFades(0.34);
  }

  drawWebtoonScrollFoldHook(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ffe07d";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(progress, 1));
    const hold = Math.max(0, Math.min((progress - 0.58) / 0.32, 1));
    this.drawWebtoonPremiumShade(accentColor, 0.32, { cy: 0.66 });

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "normal",
        alpha: 0.2 + hold * 0.12,
        zoomBoost: 0.03 + hold * 0.04,
        panY: -0.16 + p * 0.22,
        blur: 0.8,
      });
    }

    const curtain = this.createFxLayer({ blendMode: "normal", alpha: 0.96 });
    const c = new this.pixi.Graphics();
    const foldY = lerp(h * 0.18, h * 0.72, p);
    c.rect(0, 0, w, foldY - 72).fill({ color: 0x020309, alpha: 0.18 });
    c.roundRect(48, foldY - 56, w - 96, 112 + hold * 56, 18)
      .fill({ color: 0x05060c, alpha: 0.18 + hold * 0.08 })
      .stroke({ color: accentColor, width: 2, alpha: 0.16 + hold * 0.2 });
    c.rect(70, foldY, w - 140, 3).fill({ color: accentColor, alpha: 0.24 + hold * 0.16 });
    curtain.addChild(c);

    const light = this.createFxLayer({ blendMode: "screen", alpha: 0.92 });
    const g = new this.pixi.Graphics();
    this.drawSoftBeam(light, 60, foldY + 14, w - 60, foldY - 18, 92 + hold * 80, accentColor, 0.16 + hold * 0.1);
    for (let i = 0; i < 14; i += 1) {
      const y = foldY + 24 + i * 15 + Math.sin(timeSeconds * 2 + i) * 4;
      g.rect(86 + (i % 3) * 18, y, w - 172 - (i % 4) * 36, 1.5)
        .fill({ color: i % 4 ? accentColor : 0xffffff, alpha: 0.055 + hold * 0.07 });
    }
    light.addChild(g);
    this.drawWebtoonPhoneRail(accentColor, progress, timeSeconds, { side: "left", alpha: 0.48 });
    this.drawWebtoonVerticalFades(0.48);
  }

  drawCameraCutPanelSystem(effect, progress, timeSeconds, options = {}, config = {}) {
    const accent = config.accent || effect.accent || "#f8d04a";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(Math.max(progress, 0), 1));
    const cuts = config.cuts || [
      { points: [[-0.08, 0.18], [1.08, 0.08], [1.02, 0.31], [-0.04, 0.42]], delay: 0, panX: -0.06, panY: -0.18, zoom: 1.28 },
      { points: [[0.05, 0.36], [1.05, 0.31], [0.96, 0.58], [-0.02, 0.66]], delay: 0.12, panX: 0.04, panY: -0.02, zoom: 1.38 },
      { points: [[-0.06, 0.62], [0.92, 0.55], [1.08, 0.82], [0.02, 0.91]], delay: 0.24, panX: 0.02, panY: 0.15, zoom: 1.46 },
    ];
    const contentAlpha = config.contentAlpha ?? 0.58;
    const outlineAlpha = config.outlineAlpha ?? 0.64;
    const revealDuration = config.revealDuration ?? 0.42;
    const group = new this.pixi.Container();
    this.root.addChild(group);
    const overlay = this.createFxLayer({ blendMode: "screen", alpha: outlineAlpha });
    const g = new this.pixi.Graphics();

    const toPoint = (point) => {
      const x = Math.abs(point[0]) <= 1.5 ? point[0] * w : point[0];
      const y = Math.abs(point[1]) <= 1.5 ? point[1] * h : point[1];
      return [x, y];
    };
    const drawPoly = (graphics, points) => {
      graphics.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i += 1) graphics.lineTo(points[i][0], points[i][1]);
      graphics.closePath();
    };
    const resolvePoints = (cut, reveal, index) => {
      const gate = easeOutCubic(reveal);
      const driftX = (1 - gate) * (cut.fromX ?? (index % 2 ? 72 : -72)) + Math.sin(timeSeconds * 0.42 + index) * (cut.floatX ?? 3);
      const driftY = (1 - gate) * (cut.fromY ?? (index % 2 ? 34 : -34)) + Math.cos(timeSeconds * 0.38 + index) * (cut.floatY ?? 4);
      if (cut.points) return cut.points.map((point) => {
        const [x, y] = toPoint(point);
        return [x + driftX, y + driftY];
      });
      const y = cut.y + driftY;
      const x = cut.x + driftX;
      const skew = cut.skew || 0;
      return [
        [x, y],
        [x + cut.width, y + skew * 0.22],
        [x + cut.width, y + cut.height + skew * 0.14],
        [x, y + cut.height],
      ];
    };

    cuts.forEach((cut, index) => {
      const reveal = Math.min(Math.max((progress - (cut.delay || 0)) / (cut.duration || revealDuration), 0), 1);
      const gate = easeOutCubic(reveal);
      const points = resolvePoints(cut, reveal, index);
      if (options.panelTexture) {
        const panel = new this.pixi.Container();
        panel.alpha = (cut.alpha ?? contentAlpha) * (0.48 + gate * 0.52);
        panel.rotation = (cut.rotation || 0) * gate + Math.sin(timeSeconds * 0.22 + index) * (cut.motionRotation ?? 0.002);
        group.addChild(panel);
        this.drawCoverSprite(options.panelTexture, panel, {
          zoom: (cut.zoom || 1.32) + p * (cut.zoomPush ?? 0.045),
          panX: (cut.panX || 0) + Math.sin(timeSeconds * 0.48 + index) * (cut.panFloatX ?? 0.006),
          panY: cut.panY || 0,
          rotation: (cut.imageRotation || 0) + Math.sin(timeSeconds * 0.31 + index) * (cut.imageMotionRotation ?? 0.004),
          filters: config.enableBlur ? [this.createBlurFilter(cut.blur ?? 0.35, 2)].filter(Boolean) : null,
        });
        const mask = new this.pixi.Graphics();
        drawPoly(mask, points);
        mask.fill(0xffffff);
        panel.mask = mask;
        group.addChild(mask);
      }
      drawPoly(g, points);
      g.fill({ color: index % 2 ? accentColor : 0xffffff, alpha: (cut.fillAlpha ?? 0.018) + gate * (cut.fillBoost ?? 0.02) });
      drawPoly(g, points);
      g.stroke({ color: index === 1 ? accentColor : 0xffffff, width: cut.edgeWidth ?? 1.6, alpha: (cut.edgeAlpha ?? 0.08) + gate * (cut.edgeBoost ?? 0.1) });
      const [a, b] = [points[0], points[1]];
      const [c, d] = [points[3], points[2]];
      const lineAlpha = (cut.lineAlpha ?? 0.08) + gate * (cut.lineBoost ?? 0.08);
      this.drawTaperedQuad(g, a[0] + 28, a[1] + 12, b[0] - 28, b[1] - 4, 1.2, 4.5, accentColor, lineAlpha);
      this.drawTaperedQuad(g, c[0] + 40, c[1] - 8, d[0] - 42, d[1] + 8, 1, 3.5, 0xffffff, lineAlpha * 0.72);
    });

    const slashCount = config.slashCount ?? 3;
    for (let i = 0; i < slashCount; i += 1) {
      const y = lerp(h * 0.22, h * 0.78, (i + 0.5) / slashCount) + Math.sin(timeSeconds * 0.7 + i) * 18;
      const alpha = 0.035 + p * 0.035 + (i % 2) * 0.015;
      this.drawTaperedQuad(g, -72, y + 72, w + 82, y - 58, 1.4 + i, 13 + i * 3, i % 2 ? accentColor : 0xffffff, alpha);
    }
    overlay.addChild(g);
    this.drawWebtoonVerticalFades(config.fadeStrength ?? 0.36);
  }

  drawCameraCutPanelRhythmProVfx(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ffffff";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(progress, 1));
    this.drawWebtoonPremiumShade(accentColor, 0.18, { cy: 0.48 });
    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "normal",
        alpha: 0.08,
        zoomBoost: 0.014,
      });
    }
    this.drawCameraCutPanelSystem(effect, progress, timeSeconds, options, {
      accent,
      contentAlpha: 0.72,
      outlineAlpha: 0.56,
      fadeStrength: 0.24,
      slashCount: 0,
      cuts: [
        { points: [[-0.08, 0.08], [1.08, 0.02], [0.98, 0.27], [-0.02, 0.36]], delay: 0, panX: -0.08, panY: -0.18, zoom: 1.28, edgeAlpha: 0.12, edgeWidth: 2.2, lineAlpha: 0.02 },
        { points: [[0.06, 0.31], [1.1, 0.23], [1.02, 0.53], [-0.08, 0.65]], delay: 0.12, panX: 0.04, panY: -0.02, zoom: 1.42, edgeAlpha: 0.15, fillAlpha: 0.014, edgeWidth: 2.4, lineAlpha: 0.018 },
        { points: [[-0.08, 0.57], [0.92, 0.49], [1.08, 0.8], [0.02, 0.91]], delay: 0.24, panX: 0.02, panY: 0.15, zoom: 1.5, edgeAlpha: 0.13, edgeWidth: 2.1, lineAlpha: 0.018 },
        { points: [[0.16, 0.74], [0.96, 0.69], [1.06, 0.93], [0.08, 0.99]], delay: 0.34, panX: 0.08, panY: 0.2, zoom: 1.62, alpha: 0.54, edgeAlpha: 0.1, edgeWidth: 1.8, lineAlpha: 0.014 },
      ],
    });

    const gutters = this.createFxLayer({ blendMode: "normal", alpha: 0.92 });
    const ink = new this.pixi.Graphics();
    const reveal = 0.45 + p * 0.55;
    this.drawTaperedQuad(ink, -70, h * 0.34, w + 70, h * 0.22, 18, 26, 0x050505, 0.78 * reveal);
    this.drawTaperedQuad(ink, -80, h * 0.61, w + 90, h * 0.49, 20, 28, 0x050505, 0.72 * reveal);
    this.drawTaperedQuad(ink, w * 0.08, -40, w * 0.78, h + 54, 16, 24, 0x050505, 0.66 * reveal);
    gutters.addChild(ink);

    const paper = this.createFxLayer({ blendMode: "screen", alpha: 0.52 });
    const edge = new this.pixi.Graphics();
    this.drawTaperedQuad(edge, -70, h * 0.335, w + 70, h * 0.215, 3, 5, 0xffffff, 0.58 * reveal);
    this.drawTaperedQuad(edge, -80, h * 0.605, w + 90, h * 0.485, 3, 5, 0xffffff, 0.5 * reveal);
    this.drawTaperedQuad(edge, w * 0.08, -40, w * 0.78, h + 54, 3, 5, 0xffffff, 0.48 * reveal);
    for (let i = 0; i < 22; i += 1) {
      const y = -30 + i * 56 + Math.sin(timeSeconds * 0.9 + i) * 4;
      const side = i % 2 ? -1 : 1;
      this.drawTaperedQuad(edge, side > 0 ? w + 30 : -30, y, w * 0.5 + side * 90, h * 0.5 + (y - h * 0.5) * 0.16, 1, 5 + (i % 4), 0xffffff, 0.04 + p * 0.025);
    }
    paper.addChild(edge);
  }

  drawMangaPanelBoardCameraProVfx(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ffffff";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeOutCubic(Math.min(progress, 1));
    this.drawWebtoonPremiumShade(accentColor, 0.16, { cy: 0.5 });
    this.drawCameraCutPanelSystem(effect, progress, timeSeconds, options, {
      accent,
      contentAlpha: 0.7,
      outlineAlpha: 0.48,
      fadeStrength: 0.2,
      slashCount: 0,
      revealDuration: 0.34,
      cuts: [
        { points: [[0.02, 0.03], [0.5, 0.02], [0.47, 0.28], [0.06, 0.34]], delay: 0, panX: -0.1, panY: -0.18, zoom: 1.52, edgeAlpha: 0.1, lineAlpha: 0.012 },
        { points: [[0.54, 0.02], [1.02, 0.04], [0.95, 0.31], [0.5, 0.27]], delay: 0.08, panX: 0.1, panY: -0.14, zoom: 1.5, edgeAlpha: 0.1, lineAlpha: 0.012 },
        { points: [[0.04, 0.38], [0.96, 0.33], [0.94, 0.58], [0.02, 0.63]], delay: 0.16, panX: 0, panY: -0.01, zoom: 1.38, edgeAlpha: 0.13, lineAlpha: 0.014 },
        { points: [[0.03, 0.68], [0.46, 0.61], [0.48, 0.95], [0.04, 0.98]], delay: 0.24, panX: -0.08, panY: 0.18, zoom: 1.56, edgeAlpha: 0.1, lineAlpha: 0.012 },
        { points: [[0.51, 0.62], [0.98, 0.58], [0.96, 0.96], [0.52, 0.95]], delay: 0.3, panX: 0.08, panY: 0.16, zoom: 1.58, edgeAlpha: 0.1, lineAlpha: 0.012 },
      ],
    });

    const gutterLayer = this.createFxLayer({ blendMode: "normal", alpha: 0.96 });
    const g = new this.pixi.Graphics();
    g.rect(0, 0, w, h).stroke({ color: 0x050505, width: 26, alpha: 0.72 });
    this.drawTaperedQuad(g, w * 0.5, -40, w * 0.49, h + 40, 18, 20, 0x050505, 0.82);
    this.drawTaperedQuad(g, -50, h * 0.35, w + 50, h * 0.29, 18, 20, 0x050505, 0.8);
    this.drawTaperedQuad(g, -40, h * 0.66, w + 46, h * 0.57, 18, 20, 0x050505, 0.78);
    gutterLayer.addChild(g);

    const rimLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.5 + p * 0.16 });
    const rim = new this.pixi.Graphics();
    rim.rect(22, 24, w - 44, h - 48).stroke({ color: 0xffffff, width: 2, alpha: 0.52 });
    this.drawTaperedQuad(rim, w * 0.5, -40, w * 0.49, h + 40, 2, 3, 0xffffff, 0.48);
    this.drawTaperedQuad(rim, -50, h * 0.35, w + 50, h * 0.29, 2, 3, 0xffffff, 0.45);
    this.drawTaperedQuad(rim, -40, h * 0.66, w + 46, h * 0.57, 2, 3, 0xffffff, 0.42);
    rimLayer.addChild(rim);
  }

  drawMangaBurstFocusFrameProVfx(effect, progress, timeSeconds, options = {}) {
    const accent = parsePixiColor(effect.accent || "#ffffff");
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeOutCubic(Math.min(progress, 1));
    const cx = w * (0.5 + Math.sin(timeSeconds * 0.26) * 0.015);
    const cy = h * (0.48 + Math.cos(timeSeconds * 0.22) * 0.012);
    const inkWash = this.createFxLayer({ blendMode: "multiply", alpha: 0.2 + p * 0.08 });
    const wash = new this.pixi.Graphics();
    wash.rect(0, 0, w, h).fill({ color: 0xffffff, alpha: 0.06 });
    wash.circle(cx, cy, 130 + p * 18).fill({ color: 0xffffff, alpha: 0.16 });
    inkWash.addChild(wash);

    const inkLayer = this.createFxLayer({ blendMode: "multiply", alpha: 0.72 + p * 0.16 });
    const ink = new this.pixi.Graphics();
    for (let i = 0; i < 92; i += 1) {
      const angle = (i / 92) * Math.PI * 2 + Math.sin(i * 1.7) * 0.055;
      const outer = Math.max(w, h) * (0.64 + (i % 6) * 0.05);
      const inner = 72 + (i % 8) * 18 - p * 18;
      const x1 = cx + Math.cos(angle) * outer;
      const y1 = cy + Math.sin(angle) * outer * 1.18;
      const x2 = cx + Math.cos(angle) * inner;
      const y2 = cy + Math.sin(angle) * inner * 0.82;
      const wide = 14 + (i % 5) * 9;
      const alpha = 0.065 + p * 0.055 + (i % 7 === 0 ? 0.07 : 0) + (i % 13 === 0 ? 0.05 : 0);
      this.drawTaperedQuad(ink, x1, y1, x2, y2, wide, 0.8, 0x010101, alpha);
      if (i % 3 === 0) {
        const midInner = inner + 44 + (i % 4) * 11;
        this.drawTaperedQuad(
          ink,
          cx + Math.cos(angle + 0.015) * outer * 0.92,
          cy + Math.sin(angle + 0.015) * outer,
          cx + Math.cos(angle + 0.015) * midInner,
          cy + Math.sin(angle + 0.015) * midInner * 0.84,
          4 + (i % 4) * 2,
          0.6,
          0x010101,
          0.055 + p * 0.04,
        );
      }
    }
    ink.circle(cx, cy, 118 + p * 22).fill({ color: 0xffffff, alpha: 0.32 });
    inkLayer.addChild(ink);

    const paperLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.86 });
    const paper = new this.pixi.Graphics();
    for (let i = 0; i < 48; i += 1) {
      const angle = (i / 48) * Math.PI * 2 + Math.cos(i * 2.1) * 0.08;
      const outer = Math.max(w, h) * 0.62;
      const inner = 78 + (i % 6) * 18;
      this.drawTaperedQuad(
        paper,
        cx + Math.cos(angle) * outer,
        cy + Math.sin(angle) * outer * 1.05,
        cx + Math.cos(angle) * inner,
        cy + Math.sin(angle) * inner * 0.78,
        6 + (i % 4) * 4,
        0.8,
        i % 4 ? 0xffffff : accent,
        0.07 + p * 0.07,
      );
    }
    paper.circle(cx, cy, 126 + p * 20).stroke({ color: 0xffffff, width: 5, alpha: 0.24 + p * 0.16 });
    paper.circle(cx, cy, 96 + p * 16).fill({ color: 0xffffff, alpha: 0.06 + p * 0.06 });
    paperLayer.addChild(paper);
  }

  drawMangaHalftoneBurstProVfx(effect, progress, timeSeconds) {
    const accent = parsePixiColor(effect.accent || "#111111");
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(progress, 1));
    const cx = w * 0.5;
    const cy = h * 0.46;
    const dotLayer = this.createFxLayer({ blendMode: "multiply", alpha: 0.34 + p * 0.16 });
    const dots = new this.pixi.Graphics();
    for (let ray = 0; ray < 42; ray += 1) {
      const angle = (ray / 42) * Math.PI * 2 + Math.sin(ray * 1.37) * 0.045;
      for (let step = 4; step < 18; step += 1) {
        const radius = step * 34 + ((ray % 3) - 1) * 5;
        const x = cx + Math.cos(angle) * radius;
        const y = cy + Math.sin(angle) * radius * 1.04;
        if (x < -20 || x > w + 20 || y < -20 || y > h + 20) continue;
        const centerFade = Math.min(1, Math.max(0, (radius - 112) / 360));
        const size = 1.4 + centerFade * (5 + (ray % 4) * 1.2);
        dots.circle(x, y, size).fill({ color: ray % 5 === 0 ? accent : 0x050505, alpha: (0.035 + centerFade * 0.075) * (0.7 + p * 0.3) });
      }
    }
    dotLayer.addChild(dots);

    const rayLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.36 });
    const rays = new this.pixi.Graphics();
    for (let i = 0; i < 18; i += 1) {
      const angle = (i / 18) * Math.PI * 2 + timeSeconds * 0.01;
      this.drawTaperedQuad(
        rays,
        cx + Math.cos(angle) * 130,
        cy + Math.sin(angle) * 92,
        cx + Math.cos(angle) * Math.max(w, h) * 0.56,
        cy + Math.sin(angle) * Math.max(w, h) * 0.52,
        1,
        7 + (i % 3) * 5,
        0xffffff,
        0.035 + p * 0.025,
      );
    }
    rayLayer.addChild(rays);
  }

  drawManhwaDialogueLadderFocus(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#f8f0da";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(progress, 1));
    this.drawWebtoonPremiumShade(accentColor, 0.34, { cy: 0.5 });

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "normal",
        alpha: 0.14,
        zoomBoost: 0.026,
        blur: 1.4,
      });
    }

    this.drawCameraCutPanelSystem(effect, progress, timeSeconds, options, {
      accent,
      contentAlpha: 0.42,
      outlineAlpha: 0.58,
      edgeBlur: 0.45,
      fadeStrength: 0.42,
      slashCount: 2,
      cuts: [
        { x: -50, y: 150, width: w + 110, height: 132, delay: 0, skew: -78, panX: -0.035, panY: -0.16, zoom: 1.22, blur: 1.1, fromY: -46 },
        { x: -70, y: 424, width: w + 140, height: 146, delay: 0.16, skew: 68, panX: 0.035, panY: -0.02, zoom: 1.3, blur: 0.55, fromY: 46, edgeAlpha: 0.1 },
        { x: -58, y: 720, width: w + 128, height: 138, delay: 0.32, skew: -54, panX: 0.012, panY: 0.14, zoom: 1.38, blur: 1.1, fromY: -46 },
      ],
    });
    const accentLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.36 });
    const g = new this.pixi.Graphics();
    const slashY = lerp(170, h - 260, p);
    this.drawTaperedQuad(g, -70, slashY + 54, w + 70, slashY - 40, 4, 22, 0xffd84d, 0.08);
    this.drawTaperedQuad(g, -40, slashY + 82, w + 40, slashY - 10, 2, 11, accentColor, 0.07);
    accentLayer.addChild(g);
  }

  drawManhwaCharacterRevealScan(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ffd2f0";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(progress, 1));
    const scanY = lerp(h * 0.82, h * 0.22, p);
    this.drawWebtoonPremiumShade(accentColor, 0.42, { cy: 0.38 });

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "normal",
        alpha: 0.18 + p * 0.08,
        zoomBoost: 0.05 + p * 0.04,
        panY: 0.12 - p * 0.2,
        blur: 0.9,
      });
    }

    const maskLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.9 });
    const g = new this.pixi.Graphics();
    g.rect(58, scanY - 5, w - 116, 6).fill({ color: 0xffffff, alpha: 0.2 });
    g.rect(84, scanY + 13, w - 168, 3).fill({ color: accentColor, alpha: 0.42 });
    this.drawSoftBeam(maskLayer, 60, scanY + 40, w - 60, scanY - 52, 170, accentColor, 0.2);
    for (let i = 0; i < 24; i += 1) {
      const y = scanY + (i - 12) * 18;
      const alpha = Math.max(0, 1 - Math.abs(i - 12) / 12) * 0.07;
      g.rect(80 + (i % 4) * 12, y, w - 160 - (i % 5) * 20, 1).fill({ color: i % 3 ? accentColor : 0xffffff, alpha });
    }
    maskLayer.addChild(g);

    const focusY = lerp(h * 0.7, h * 0.34, p);
    this.restoreSpeedImpactFocus(options.panelTexture, options.camera, { x: w * 0.5, y: focusY, rx: w * 0.34, ry: h * 0.22 }, 0.82);
    this.drawWebtoonVerticalFades(0.42);
  }

  drawManhwaReactionBeatStack(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ff8ed6";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeOutCubic(Math.min(progress, 1));
    this.drawWebtoonPremiumShade(accentColor, 0.3, { cy: 0.46 });

    const frames = [
      { x: 46, y: 116, width: 570, height: 245, panX: -0.04, panY: -0.16, delay: 0 },
      { x: 58, y: 416, width: 548, height: 258, panX: 0.02, panY: -0.02, delay: 0.14 },
      { x: 42, y: 738, width: 580, height: 270, panX: 0.05, panY: 0.13, delay: 0.28 },
    ];
    frames.forEach((frame, index) => {
      const t = easeOutBack(Math.min(Math.max((progress - frame.delay) / 0.44, 0), 1));
      const layer = new this.pixi.Container();
      layer.alpha = 0.66 + t * 0.22;
      layer.rotation = (index - 1) * 0.012 * t;
      layer.x = (1 - t) * (index % 2 ? 58 : -58);
      const mask = new this.pixi.Graphics();
      mask.roundRect(frame.x, frame.y, frame.width, frame.height, 14).fill(0xffffff);
      layer.mask = mask;
      this.root.addChild(layer, mask);
      if (options.panelTexture) {
        this.drawCoverSprite(options.panelTexture, layer, {
          zoom: 1.34 + index * 0.08,
          panX: frame.panX + Math.sin(timeSeconds * 0.46 + index) * 0.008,
          panY: frame.panY,
        });
      }
      const outline = this.createFxLayer({ blendMode: "screen", alpha: 0.62 });
      const g = new this.pixi.Graphics();
      g.roundRect(frame.x, frame.y, frame.width, frame.height, 14)
        .stroke({ color: index === 1 ? accentColor : 0xffffff, width: index === 1 ? 2.4 : 1.6, alpha: 0.12 + t * 0.14 });
      g.rect(frame.x + 34, frame.y + frame.height - 30, frame.width - 68, 2).fill({ color: accentColor, alpha: 0.06 + t * 0.1 });
      outline.addChild(g);
    });

    const beat = this.createFxLayer({ blendMode: "screen", alpha: 0.38 });
    const b = new this.pixi.Graphics();
    for (let i = 0; i < 13; i += 1) {
      const y = 120 + i * 78 + Math.sin(timeSeconds * 1.8 + i) * 6;
      b.rect(w * 0.5 - 16 - (i % 3) * 6, y, 32 + (i % 3) * 12, 2).fill({ color: i % 2 ? accentColor : 0xffffff, alpha: 0.026 + p * 0.026 });
    }
    beat.addChild(b);
    this.drawWebtoonVerticalFades(0.34);
  }

  drawWebtoonSocialPanelTease(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#55f0c8";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeOutCubic(Math.min(progress, 1));
    this.drawWebtoonPremiumShade(accentColor, 0.36, { cy: 0.45 });

    if (options.panelTexture) {
      const hero = new this.pixi.Container();
      hero.alpha = 0.9;
      const heroMask = new this.pixi.Graphics();
      heroMask.roundRect(50, 110, w - 100, 500, 20).fill(0xffffff);
      hero.mask = heroMask;
      this.root.addChild(hero, heroMask);
      this.drawCoverSprite(options.panelTexture, hero, {
        zoom: 1.14 + p * 0.04,
        panY: -0.04 + Math.sin(timeSeconds * 0.28) * 0.012,
      });
    }

    const ui = this.createFxLayer({ blendMode: "normal", alpha: 0.98 });
    const g = new this.pixi.Graphics();
    g.roundRect(44, 92, w - 88, 536, 24).stroke({ color: 0xffffff, width: 2, alpha: 0.12 });
    g.roundRect(54, h - 332, w - 108, 178, 22).fill({ color: 0x05060c, alpha: 0.48 });
    g.roundRect(76, h - 300, 148, 10, 6).fill({ color: accentColor, alpha: 0.36 });
    g.roundRect(76, h - 268, w - 184, 8, 5).fill({ color: 0xffffff, alpha: 0.14 });
    g.roundRect(76, h - 238, w - 244, 7, 5).fill({ color: 0xffffff, alpha: 0.1 });
    g.roundRect(w - 214, h - 194, 138, 38, 18).fill({ color: accentColor, alpha: 0.28 }).stroke({ color: 0xffffff, width: 1, alpha: 0.16 });
    for (let i = 0; i < 4; i += 1) {
      const t = easeOutBack(Math.min(Math.max((progress - i * 0.08) / 0.36, 0), 1));
      const tx = 74 + i * 122;
      const ty = 654 + (1 - t) * 34;
      if (options.panelTexture) {
        const thumb = new this.pixi.Container();
        thumb.alpha = 0.42 + t * 0.28;
        const mask = new this.pixi.Graphics();
        mask.roundRect(tx, ty, 96, 112, 12).fill(0xffffff);
        thumb.mask = mask;
        this.root.addChild(thumb, mask);
        this.drawCoverSprite(options.panelTexture, thumb, {
          zoom: 1.8 + i * 0.12,
          panX: (i - 1.5) * 0.045,
          panY: -0.16 + i * 0.1,
          alpha: 0.82,
        });
      }
      g.roundRect(tx, ty, 96, 112, 12)
        .fill({ color: 0xffffff, alpha: 0.06 + t * 0.05 })
        .stroke({ color: i === 2 ? accentColor : 0xffffff, width: 1.5, alpha: 0.08 + t * 0.18 });
    }
    ui.addChild(g);
    this.drawSoftBeam(ui, -40, 700 - p * 110, w + 40, 590 - p * 90, 90, accentColor, 0.12);
    this.drawWebtoonVerticalFades(0.28);
  }

  drawWebtoonCoverDropTease(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ffd84d";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeOutBack(Math.min(progress / 0.72, 1));
    this.drawWebtoonPremiumShade(accentColor, 0.38, { cy: 0.52 });

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "screen",
        alpha: 0.15,
        zoomBoost: 0.06,
        blur: 5.5,
        blurQuality: 4,
      });
      const cover = new this.pixi.Container();
      cover.y = (1 - p) * -360 + Math.sin(timeSeconds * 0.5) * 4;
      cover.rotation = -0.022 + p * 0.022;
      const mask = new this.pixi.Graphics();
      mask.roundRect(102, 168, w - 204, h - 344, 22).fill(0xffffff);
      cover.mask = mask;
      this.root.addChild(cover, mask);
      this.drawCoverSprite(options.panelTexture, cover, {
        zoom: 1.22,
        panY: -0.02,
      });
    }

    const badge = this.createFxLayer({ blendMode: "screen", alpha: 0.92 });
    const g = new this.pixi.Graphics();
    g.roundRect(96, 160, w - 192, h - 328, 24)
      .stroke({ color: 0xffffff, width: 3, alpha: 0.16 })
      .stroke({ color: accentColor, width: 2, alpha: 0.18 });
    g.rect(124, h - 238, w - 248, 3).fill({ color: accentColor, alpha: 0.35 });
    g.roundRect(148, h - 196, w - 296, 46, 22).fill({ color: 0x000000, alpha: 0.28 }).stroke({ color: accentColor, width: 1.5, alpha: 0.28 });
    for (let i = 0; i < 26; i += 1) {
      const x = 80 + ((i * 67 + timeSeconds * 18) % (w - 160));
      const y = 96 + ((i * 131 - timeSeconds * 24) % (h - 192));
      g.circle(x, y, 2 + (i % 4)).fill({ color: i % 5 ? accentColor : 0xffffff, alpha: 0.07 + p * 0.04 });
    }
    badge.addChild(g);
    this.drawWebtoonVerticalFades(0.38);
  }

  drawManhwaRainWindowDrama(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#9edcff";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(progress, 1));
    this.drawWebtoonPremiumShade(accentColor, 0.5, { cy: 0.36 });

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "normal",
        alpha: 0.18,
        zoomBoost: 0.035,
        blur: 1.6,
      });
    }

    const windowLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.9 });
    const g = new this.pixi.Graphics();
    const paneFill = this.createFillGradient({
      type: "linear",
      start: { x: 0.2, y: 0 },
      end: { x: 0.8, y: 1 },
      colorStops: [
        { offset: 0, color: "rgba(255,255,255,0.02)" },
        { offset: 0.45, color: `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},0.08)` },
        { offset: 1, color: "rgba(255,255,255,0.02)" },
      ],
    });
    g.roundRect(50, 80, w - 100, h - 160, 22).fill(paneFill || { color: accentColor, alpha: 0.05 }).stroke({ color: 0xffffff, width: 1.5, alpha: 0.15 });
    g.rect(w * 0.5 - 1, 96, 2, h - 192).fill({ color: 0xffffff, alpha: 0.1 });
    g.rect(74, 112, w - 148, 2).fill({ color: accentColor, alpha: 0.12 });
    g.rect(74, h - 116, w - 148, 2).fill({ color: accentColor, alpha: 0.1 });
    for (let i = 0; i < 92; i += 1) {
      const x = 38 + ((i * 71 + Math.sin(i) * 20) % (w - 76));
      const y = -120 + ((timeSeconds * (160 + (i % 7) * 16) + i * 53) % (h + 240));
      const len = 38 + (i % 5) * 24;
      const alpha = 0.075 + (i % 4) * 0.032;
      g.moveTo(x, y).lineTo(x - 16, y + len).stroke({ color: i % 5 ? accentColor : 0xffffff, width: i % 6 === 0 ? 3 : 1.8, alpha });
    }
    for (let i = 0; i < 18; i += 1) {
      const x = 74 + ((i * 97 + timeSeconds * 12) % (w - 148));
      const y = 150 + ((i * 151 + timeSeconds * 28) % (h - 300));
      g.ellipse(x, y, 10 + (i % 4) * 5, 28 + (i % 5) * 8, -0.16).stroke({ color: 0xffffff, width: 1.4, alpha: 0.04 + p * 0.03 });
    }
    windowLayer.addChild(g);
    this.drawSoftBeam(windowLayer, -80, h * 0.24, w * 0.76, h * 0.08, 140, accentColor, 0.14);
    this.drawWebtoonVerticalFades(0.48);
  }

  drawManhwaNeonCityScroll(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#42f5ff";
    const accentColor = parsePixiColor(accent);
    const magenta = 0xff4fc4;
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(progress, 1));
    this.drawWebtoonPremiumShade(accentColor, 0.38, { cy: 0.5 });

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "normal",
        alpha: 0.075,
        zoomBoost: 0.04,
        panY: -0.08 + p * 0.16,
        blur: 1.8,
      });
    }

    const neon = this.createFxLayer({ blendMode: "screen", alpha: 0.46 });
    neon.filters = [this.createBlurFilter(0.85, 3)].filter(Boolean);
    const g = new this.pixi.Graphics();
    for (let i = 0; i < 10; i += 1) {
      const depth = (i % 6) / 5;
      const x = 42 + ((i * 103 + timeSeconds * (18 + depth * 26)) % (w - 84));
      const y = 90 + ((i * 149 - timeSeconds * (30 + depth * 40)) % (h - 180));
      const color = i % 3 === 0 ? magenta : i % 3 === 1 ? accentColor : 0xffffff;
      g.roundRect(x - 18, y, 32 + depth * 36, 7 + depth * 7, 4)
        .fill({ color, alpha: 0.035 + depth * 0.026 })
        .stroke({ color, width: 1.1, alpha: 0.055 + depth * 0.04 });
      if (i % 2 === 0) g.rect(x - 24, y + 22, 46 + depth * 54, 1.5).fill({ color, alpha: 0.035 + depth * 0.025 });
    }
    for (let i = 0; i < 7; i += 1) {
      const y = 150 + i * 90 + Math.sin(timeSeconds * 0.8 + i) * 12;
      this.drawTaperedQuad(g, -80, y + 80, w + 90, y - 130, 2.5, 24 + (i % 4) * 10, i % 2 ? magenta : accentColor, 0.026 + (i % 4) * 0.007);
    }
    neon.addChild(g);
    this.drawSoftBeam(neon, 0, h * 0.82, w, h * 0.68, 130, magenta, 0.055, { blur: 2 });
    this.drawSoftBeam(neon, -60, h * 0.2, w * 0.72, h * 0.1, 90, accentColor, 0.04, { blur: 2 });
    this.drawWebtoonPhoneRail(accentColor, progress, timeSeconds, { alpha: 0.28 });
    this.drawWebtoonVerticalFades(0.34);
  }

  drawManhwaRoyalEntranceGlow(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ffd98a";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeOutCubic(Math.min(progress, 1));
    const breath = 0.5 + Math.sin(timeSeconds * 0.78) * 0.5;
    this.drawWebtoonPremiumShade(accentColor, 0.34, { cy: 0.38 });

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "screen",
        alpha: 0.17 + breath * 0.04,
        zoomBoost: 0.06,
        panY: 0.06 - p * 0.11,
        blur: 4.2,
        blurQuality: 4,
      });
    }

    const hall = this.createFxLayer({ blendMode: "screen", alpha: 0.96 });
    const g = new this.pixi.Graphics();
    const archY = h * 0.12;
    g.roundRect(104, 112, w - 208, h - 260, 30)
      .stroke({ color: accentColor, width: 3, alpha: 0.12 + p * 0.08 })
      .stroke({ color: 0xffffff, width: 1.5, alpha: 0.08 });
    g.moveTo(124, h - 112).quadraticCurveTo(w * 0.5, archY, w - 124, h - 112)
      .stroke({ color: accentColor, width: 2, alpha: 0.16 });
    this.drawSoftBeam(hall, -80, h * 0.28, w * 0.62, h * 0.04, 160, 0xffffff, 0.11 + breath * 0.04);
    this.drawSoftBeam(hall, w * 0.22, h * 1.02, w + 90, h * 0.42, 150, accentColor, 0.1 + breath * 0.03);
    for (let i = 0; i < 64; i += 1) {
      const depth = (i % 8) / 7;
      const x = 46 + ((i * 89 + Math.sin(timeSeconds * 0.5 + i) * 20) % (w - 92));
      const y = 70 + ((i * 137 - timeSeconds * (12 + depth * 18)) % (h - 140));
      const size = 1.5 + depth * 4.2;
      g.circle(x, y, size).fill({ color: i % 5 ? accentColor : 0xffffff, alpha: 0.06 + depth * 0.055 });
    }
    for (let i = 0; i < 7; i += 1) {
      const x = w * 0.5 + Math.sin(i * 1.7) * (86 + i * 14);
      const y = 138 + i * 86;
      g.ellipse(x, y, 26 + i * 8, 5 + i * 1.8).fill({ color: accentColor, alpha: 0.045 + p * 0.018 });
    }
    hall.addChild(g);
    this.restoreSpeedImpactFocus(options.panelTexture, options.camera, { x: w * 0.5, y: h * 0.44, rx: w * 0.35, ry: h * 0.34 }, 0.82);
    this.drawWebtoonVerticalFades(0.3);
  }

  drawRomanceFantasyProVfx(effect, progress, timeSeconds, options = {}) {
    const layout = effect.layout || "";
    const accent = effect.accent || "#ffffff";
    const accentColor = parsePixiColor(accent);
    const strength = layout.includes("starlight") || layout.includes("rune") ? 0.42 : 0.3;
    this.drawRomanceFantasySeparationGrade(accentColor, strength);
    if (layout === "romance-moonlit-confession-glow") this.drawRomanceMoonlitConfessionGlow(effect, progress, timeSeconds, options);
    else if (layout === "romance-heartbeat-aura-pulse") this.drawRomanceHeartbeatAuraPulse(effect, progress, timeSeconds, options);
    else if (layout === "romance-dream-light-bloom") this.drawRomanceDreamLightBloom(effect, progress, timeSeconds, options);
    else if (layout === "fantasy-enchanted-dust-drift") this.drawFantasyEnchantedDustDrift(effect, progress, timeSeconds, options);
    else if (layout === "fantasy-rune-halo-reveal") this.drawFantasyRuneHaloReveal(effect, progress, timeSeconds, options);
    else if (layout === "romance-blush-sparkle-focus") this.drawRomanceBlushSparkleFocus(effect, progress, timeSeconds, options);
    else if (layout === "fantasy-floating-ribbon-veil") this.drawFantasyFloatingRibbonVeil(effect, progress, timeSeconds, options);
    else if (layout === "romance-memory-mist-dissolve") this.drawRomanceMemoryMistDissolve(effect, progress, timeSeconds, options);
    else if (layout === "fantasy-starlight-wish") this.drawFantasyStarlightWish(effect, progress, timeSeconds, options);
    else if (layout === "fantasy-crystal-prism-glow") this.drawFantasyCrystalPrismGlow(effect, progress, timeSeconds, options);
    else if (layout === "romance-golden-fate-threads") this.drawRomanceGoldenFateThreads(effect, progress, timeSeconds, options);
    else if (layout === "fantasy-aurora-veil-drift") this.drawFantasyAuroraVeilDrift(effect, progress, timeSeconds, options);
    else if (layout === "romance-tear-drop-shimmer") this.drawRomanceTearDropShimmer(effect, progress, timeSeconds, options);
    else if (layout === "fantasy-butterfly-dream-swarm") this.drawFantasyButterflyDreamSwarm(effect, progress, timeSeconds, options);
    else if (layout === "romance-royal-ballroom-light") this.drawRomanceRoyalBallroomLight(effect, progress, timeSeconds, options);
    else if (layout === "fantasy-healing-light-aura") this.drawFantasyHealingLightAura(effect, progress, timeSeconds, options);
    else if (layout === "romance-perfume-scent-trail") this.drawRomancePerfumeScentTrail(effect, progress, timeSeconds, options);
    else if (layout === "romance-snow-kiss-silence") this.drawRomanceSnowKissSilence(effect, progress, timeSeconds, options);
    else if (layout === "fantasy-magic-book-glow") this.drawFantasyMagicBookGlow(effect, progress, timeSeconds, options);
  }

  drawRomanceFantasySeparationGrade(accentColor = 0xffffff, strength = 0.3) {
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const shade = this.createFxLayer({ blendMode: "multiply", alpha: 0.62 });
    const dark = new this.pixi.Graphics();
    dark.rect(0, 0, w, h).fill({ color: 0x070510, alpha: strength });
    dark.rect(0, 0, w, h * 0.18).fill({ color: 0x03020a, alpha: strength * 0.55 });
    dark.rect(0, h * 0.78, w, h * 0.22).fill({ color: 0x03020a, alpha: strength * 0.58 });
    shade.addChild(dark);

    const tint = this.createFxLayer({ blendMode: "screen", alpha: 0.62 });
    const glow = new this.pixi.Graphics();
    glow.rect(0, 0, w, h).fill({ color: accentColor, alpha: strength * 0.035 });
    glow.ellipse(w * 0.5, h * 0.44, w * 0.42, h * 0.36).fill({ color: accentColor, alpha: strength * 0.035 });
    tint.addChild(glow);
  }

  drawRomanceMoonlitConfessionGlow(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ffc8e8";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(progress, 1));
    const breath = 0.5 + Math.sin(timeSeconds * 0.72) * 0.5;
    const focus = { x: w * 0.52, y: h * 0.46, rx: w * 0.34, ry: h * 0.3 };

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "screen",
        alpha: 0.16 + breath * 0.07,
        zoomBoost: 0.035,
        panY: -0.012,
        blur: 5.2,
        blurQuality: 4,
      });
    }

    const wash = this.createFxLayer({ blendMode: "screen", alpha: 0.96 });
    const g = new this.pixi.Graphics();
    const moon = this.createFillGradient({
      type: "radial",
      center: { x: 0.28, y: 0.16 },
      innerRadius: 0.02,
      outerCenter: { x: 0.45, y: 0.42 },
      outerRadius: 0.92,
      colorStops: [
        { offset: 0, color: "rgba(255,255,255,0.3)" },
        { offset: 0.34, color: `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},0.15)` },
        { offset: 1, color: "rgba(255,255,255,0)" },
      ],
    });
    g.rect(0, 0, w, h).fill(moon || { color: accentColor, alpha: 0.06 });
    g.circle(w * 0.22, h * 0.14, 48 + breath * 6).fill({ color: 0xffffff, alpha: 0.2 + p * 0.06 });
    g.ellipse(focus.x, focus.y, focus.rx * (1.18 + breath * 0.06), focus.ry * (1.04 + breath * 0.04))
      .stroke({ color: 0xffffff, width: 2, alpha: 0.08 + p * 0.06 });
    wash.addChild(g);
    this.drawSoftBeam(wash, -80, h * 0.25, w * 0.82, h * 0.06, 150, 0xffffff, 0.18 + breath * 0.07, { blur: 1.2 });

    this.drawRomanceSparkles(accent, timeSeconds, 54, 0.09, 0.46);
    this.restoreSpeedImpactFocus(options.panelTexture, options.camera, focus, 0.9);
    this.drawWebtoonVerticalFades(0.22, 0x090614);
  }

  drawRomanceHeartbeatAuraPulse(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ff7eb8";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const pulse = Math.pow(0.5 + Math.sin(timeSeconds * 2.15) * 0.5, 1.7);
    const p = easeInOutCubic(Math.min(progress, 1));
    const focus = { x: w * 0.5, y: h * 0.48, rx: w * 0.35, ry: h * 0.28 };

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "screen",
        alpha: 0.12 + pulse * 0.1,
        zoomBoost: 0.02 + pulse * 0.025,
        blur: 3.4,
        blurQuality: 3,
      });
    }

    const aura = this.createFxLayer({ blendMode: "screen", alpha: 1 });
    const g = new this.pixi.Graphics();
    g.rect(0, 0, w, h).fill({ color: accentColor, alpha: 0.025 + pulse * 0.035 });
    for (let i = 0; i < 4; i += 1) {
      const t = ((timeSeconds * 0.58 + i * 0.22) % 1);
      g.ellipse(focus.x, focus.y, focus.rx * (0.72 + t * 1.05), focus.ry * (0.62 + t * 1.0))
        .stroke({ color: i % 2 ? accentColor : 0xffffff, width: 2.5 + pulse * 2.5, alpha: (1 - t) * (0.18 + pulse * 0.08) });
    }
    g.rect(92, focus.y - 3, w - 184, 6).fill({ color: accentColor, alpha: 0.1 + pulse * 0.14 });
    aura.addChild(g);
    this.drawRomanceSparkles(accent, timeSeconds, 42, 0.08 + pulse * 0.035, 0.42);
    this.restoreSpeedImpactFocus(options.panelTexture, options.camera, focus, 0.88 + p * 0.04);
  }

  drawRomanceDreamLightBloom(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ffe7b8";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const bloom = easeInOutCubic(Math.min(progress / 0.78, 1));

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "screen",
        alpha: 0.2 + bloom * 0.08,
        zoomBoost: 0.05,
        blur: 7.5 - bloom * 3.4,
        blurQuality: 4,
      });
    }

    const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.94 });
    const g = new this.pixi.Graphics();
    g.rect(0, 0, w, h).fill({ color: 0xffffff, alpha: Math.max(0, 0.15 - bloom * 0.1) });
    const y = lerp(h * 0.25, h * 0.64, bloom);
    g.rect(72, y, w - 144, 3).fill({ color: accentColor, alpha: 0.2 });
    layer.addChild(g);
    this.drawSoftBeam(layer, -90, h * 0.18, w * 0.88, h * 0.03, 170, 0xffffff, 0.18 + bloom * 0.07, { blur: 1.4 });
    this.drawSoftBeam(layer, w * 0.03, h * 1.03, w * 1.06, h * 0.58, 210, accentColor, 0.13 + bloom * 0.06, { blur: 1.8 });
    this.drawRomanceSparkles(accent, timeSeconds, 70, 0.09, 0.62);
    this.drawWebtoonVerticalFades(0.18, 0xfff4e5);
  }

  drawFantasyEnchantedDustDrift(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#d8ffb2";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(progress, 1));

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "screen",
        alpha: 0.11,
        zoomBoost: 0.04,
        panX: Math.sin(timeSeconds * 0.27) * 0.016,
        panY: -0.02 + p * 0.025,
        blur: 3.8,
        blurQuality: 4,
      });
    }

    const haze = this.createFxLayer({ blendMode: "screen", alpha: 0.96 });
    const g = new this.pixi.Graphics();
    g.rect(0, 0, w, h).fill({ color: accentColor, alpha: 0.025 });
    for (let i = 0; i < 10; i += 1) {
      const y = h * (0.12 + i * 0.08) + Math.sin(timeSeconds * 0.52 + i) * 24;
      this.drawSoftBeam(haze, -70, y, w + 80, y - 72 - i * 3, 96 + i * 8, i % 3 ? accentColor : 0xffffff, 0.055 + (i % 3) * 0.02, { blur: 1.8 });
    }
    haze.addChild(g);
    this.drawRomanceSparkles(accent, timeSeconds, 96, 0.105, 0.88);
    this.drawWebtoonVerticalFades(0.2, 0x06110b);
  }

  drawFantasyRuneHaloReveal(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#cfa8ff";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeOutCubic(Math.min(progress / 0.8, 1));
    const cx = w * 0.5;
    const cy = h * 0.46;

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "screen",
        alpha: 0.12 + p * 0.06,
        zoomBoost: 0.035,
        blur: 4.2,
        blurQuality: 4,
      });
    }

    const halo = this.createFxLayer({ blendMode: "screen", alpha: 1 });
    const g = new this.pixi.Graphics();
    for (let i = 0; i < 4; i += 1) {
      const radius = 128 + i * 42 + p * 30 + Math.sin(timeSeconds * 0.8 + i) * 4;
      g.ellipse(cx, cy, radius, radius * 1.34)
        .stroke({ color: i % 2 ? accentColor : 0xffffff, width: 2.5 + (i % 2), alpha: 0.12 + p * 0.12 - i * 0.012 });
    }
    for (let i = 0; i < 18; i += 1) {
      const angle = (i / 18) * Math.PI * 2 + timeSeconds * 0.12;
      const x = cx + Math.cos(angle) * 220;
      const y = cy + Math.sin(angle) * 295;
      g.roundRect(x - 12, y - 2.5, 24, 5, 2).fill({ color: i % 3 ? accentColor : 0xffffff, alpha: 0.16 + p * 0.16 });
    }
    halo.addChild(g);
    this.drawRomanceSparkles(accent, timeSeconds, 50, 0.085, 0.52);
    this.restoreSpeedImpactFocus(options.panelTexture, options.camera, { x: cx, y: cy, rx: w * 0.32, ry: h * 0.29 }, 0.86);
  }

  drawRomanceBlushSparkleFocus(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ff9bd2";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(progress, 1));
    const focus = { x: w * 0.5, y: h * 0.42, rx: w * 0.32, ry: h * 0.22 };

    const blush = this.createFxLayer({ blendMode: "screen", alpha: 0.96 });
    const g = new this.pixi.Graphics();
    g.rect(0, 0, w, h).fill({ color: accentColor, alpha: 0.035 + p * 0.02 });
    g.ellipse(focus.x - focus.rx * 0.55, focus.y + focus.ry * 0.25, focus.rx * 0.28, focus.ry * 0.18).fill({ color: accentColor, alpha: 0.12 });
    g.ellipse(focus.x + focus.rx * 0.55, focus.y + focus.ry * 0.25, focus.rx * 0.28, focus.ry * 0.18).fill({ color: accentColor, alpha: 0.12 });
    g.ellipse(focus.x, focus.y, focus.rx * 1.12, focus.ry * 1.12).stroke({ color: 0xffffff, width: 2.5, alpha: 0.14 + p * 0.08 });
    blush.addChild(g);
    this.drawRomanceSparkles(accent, timeSeconds, 58, 0.1, 0.42);
    this.restoreSpeedImpactFocus(options.panelTexture, options.camera, focus, 0.9);
    this.drawWebtoonVerticalFades(0.18, 0xffeff7);
  }

  drawFantasyFloatingRibbonVeil(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#f7d5ff";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(progress, 1));

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "screen",
        alpha: 0.09,
        zoomBoost: 0.028,
        blur: 4.5,
        blurQuality: 4,
      });
    }

    const veil = this.createFxLayer({ blendMode: "screen", alpha: 1 });
    const g = new this.pixi.Graphics();
    for (let i = 0; i < 7; i += 1) {
      const y = h * (0.18 + i * 0.105) + Math.sin(timeSeconds * 0.8 + i) * 28;
      const offset = Math.sin(timeSeconds * 0.45 + i * 1.7) * 60;
      this.drawSoftBeam(veil, -100 + offset, y + 80, w + 120 - offset * 0.3, y - 130, 128 + i * 12, i % 2 ? accentColor : 0xffffff, 0.08 + p * 0.045, { blur: 1.4 });
      this.drawSoftBeam(veil, w + 80 - offset, y + 150, -80 + offset * 0.4, y - 20, 92 + i * 10, accentColor, 0.062 + p * 0.036, { blur: 1.6 });
    }
    veil.addChild(g);
    this.drawRomanceSparkles(accent, timeSeconds, 48, 0.08, 0.54);
    this.drawWebtoonVerticalFades(0.2, 0x130819);
  }

  drawRomanceMemoryMistDissolve(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#dce9ff";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(progress, 1));

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "normal",
        alpha: 0.18 + (1 - p) * 0.2,
        zoomBoost: 0.04,
        panX: Math.sin(timeSeconds * 0.24) * 0.012,
        blur: 5.5 - p * 2.2,
        blurQuality: 4,
      });
    }

    const mist = this.createFxLayer({ blendMode: "screen", alpha: 1 });
    const g = new this.pixi.Graphics();
    g.rect(0, 0, w, h).fill({ color: accentColor, alpha: 0.035 });
    for (let i = 0; i < 9; i += 1) {
      const y = h * (0.12 + i * 0.1) + Math.sin(timeSeconds * 0.42 + i) * 32;
      this.drawSoftBeam(mist, -100, y, w + 120, y - 34 + Math.cos(i) * 28, 150 + i * 16, i % 2 ? accentColor : 0xffffff, 0.055 + (i % 3) * 0.018, { blur: 2.4 });
    }
    mist.addChild(g);
    this.drawRomanceSparkles(accent, timeSeconds, 42, 0.075, 0.62);
    this.drawWebtoonVerticalFades(0.32, 0x0d1018);
  }

  drawFantasyStarlightWish(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#b7c7ff";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(progress, 1));

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "screen",
        alpha: 0.12 + p * 0.08,
        zoomBoost: 0.03,
        panY: -0.012,
        blur: 3,
        blurQuality: 3,
      });
    }

    const night = this.createFxLayer({ blendMode: "screen", alpha: 1 });
    const g = new this.pixi.Graphics();
    g.rect(0, 0, w, h).fill({ color: accentColor, alpha: 0.065 + p * 0.035 });
    for (let i = 0; i < 86; i += 1) {
      const x = 44 + ((i * 97 + Math.sin(timeSeconds * 0.12 + i) * 18) % (w - 88));
      const y = 66 + ((i * 149 + Math.cos(timeSeconds * 0.16 + i) * 14) % (h - 132));
      const twinkle = Math.max(0, Math.sin(timeSeconds * (1.3 + (i % 5) * 0.18) + i));
      const size = 1.8 + (i % 4) + twinkle * 2.7;
      if (i % 10 === 0) {
        g.ellipse(x, y, size * 0.45, size * 2.8).fill({ color: 0xffffff, alpha: 0.12 + twinkle * 0.16 });
        g.ellipse(x, y, size * 2.8, size * 0.45).fill({ color: accentColor, alpha: 0.1 + twinkle * 0.12 });
      } else {
        g.circle(x, y, size).fill({ color: i % 5 ? accentColor : 0xffffff, alpha: 0.09 + twinkle * 0.18 });
      }
    }
    for (let i = 0; i < 7; i += 1) {
      const x1 = w * (0.16 + i * 0.11);
      const y1 = h * (0.2 + ((i * 0.17) % 0.52));
      const x2 = x1 + 42 + Math.sin(i) * 22;
      const y2 = y1 + 28 + Math.cos(i) * 18;
      g.moveTo(x1, y1).lineTo(x2, y2).stroke({ color: i % 2 ? accentColor : 0xffffff, width: 1.8, alpha: 0.14 + p * 0.08 });
    }
    night.addChild(g);
    this.drawSoftBeam(night, -80, h * 0.78, w * 0.72, h * 0.12, 46, 0xffffff, 0.2 + p * 0.11, { blur: 0.8 });
    this.drawRomanceSparkles(accent, timeSeconds + 0.7, 34, 0.08, 0.64);
    this.drawWebtoonVerticalFades(0.38, 0x050613);
  }

  drawFantasyCrystalPrismGlow(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#bff6ff";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(progress, 1));
    const shimmer = 0.5 + Math.sin(timeSeconds * 1.15) * 0.5;

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "screen",
        alpha: 0.09 + shimmer * 0.04,
        zoomBoost: 0.034,
        panX: Math.sin(timeSeconds * 0.22) * 0.006,
        blur: 2.4,
        blurQuality: 3,
      });
    }

    const prism = this.createFxLayer({ blendMode: "screen", alpha: 0.94 });
    const g = new this.pixi.Graphics();
    const shards = [
      [w * 0.04, h * 0.16, w * 0.25, h * 0.1, w * 0.16, h * 0.42],
      [w * 0.78, h * 0.06, w * 0.98, h * 0.18, w * 0.86, h * 0.46],
      [w * 0.08, h * 0.72, w * 0.32, h * 0.62, w * 0.22, h * 0.96],
      [w * 0.72, h * 0.68, w * 0.96, h * 0.58, w * 0.9, h * 0.94],
    ];
    shards.forEach((s, i) => {
      g.moveTo(s[0], s[1]).lineTo(s[2], s[3]).lineTo(s[4], s[5]).closePath()
        .stroke({ color: i % 2 ? accentColor : 0xffffff, width: 2.6, alpha: 0.22 + shimmer * 0.1 })
        .fill({ color: i % 2 ? accentColor : 0xffffff, alpha: 0.055 + p * 0.02 });
    });
    for (let i = 0; i < 6; i += 1) {
      const y = h * (0.17 + i * 0.12) + Math.sin(timeSeconds * 0.5 + i) * 18;
      this.drawSoftBeam(prism, -60, y, w + 70, y - 80, 44 + i * 10, i % 3 ? accentColor : 0xffffff, 0.1 + shimmer * 0.045, { blur: 1.0 });
    }
    prism.addChild(g);
    this.drawRomanceSparkles("#ffffff", timeSeconds, 46, 0.075, 0.72);
    this.drawWebtoonVerticalFades(0.2, 0x061018);
  }

  drawRomanceGoldenFateThreads(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ffd77a";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(progress, 1));

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "screen",
        alpha: 0.08,
        zoomBoost: 0.024,
        blur: 3.2,
        blurQuality: 3,
      });
    }

    const threads = this.createFxLayer({ blendMode: "screen", alpha: 0.96 });
    const g = new this.pixi.Graphics();
    for (let i = 0; i < 9; i += 1) {
      const side = i % 2 ? 1 : -1;
      const y = h * (0.16 + i * 0.085) + Math.sin(timeSeconds * 0.42 + i) * 22;
      const x1 = side > 0 ? w + 60 : -60;
      const x2 = side > 0 ? -40 : w + 40;
      const c1x = w * (0.34 + Math.sin(i) * 0.08);
      const c2x = w * (0.66 + Math.cos(i) * 0.08);
      g.moveTo(x1, y)
        .bezierCurveTo(c1x, y - 80, c2x, y + 95, x2, y + Math.sin(i) * 54)
        .stroke({ color: i % 3 ? accentColor : 0xffffff, width: 2.2 + (i % 3) * 0.8, alpha: 0.25 + p * 0.08 });
    }
    for (let i = 0; i < 12; i += 1) {
      const x = w * (0.12 + Math.abs(Math.sin(i * 1.7)) * 0.76);
      const y = h * (0.16 + Math.abs(Math.cos(i * 2.1)) * 0.68);
      g.circle(x, y, 3.2 + (i % 3)).fill({ color: i % 2 ? accentColor : 0xffffff, alpha: 0.26 });
    }
    threads.addChild(g);
    this.drawRomanceSparkles(accent, timeSeconds + 0.4, 38, 0.07, 0.64);
    this.drawWebtoonVerticalFades(0.18, 0x120c05);
  }

  drawFantasyAuroraVeilDrift(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#8fe8ff";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(progress, 1));

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "screen",
        alpha: 0.09 + p * 0.03,
        zoomBoost: 0.026,
        panY: -0.01,
        blur: 4.2,
        blurQuality: 4,
      });
    }

    const aurora = this.createFxLayer({ blendMode: "screen", alpha: 0.96 });
    const curtain = new this.pixi.Graphics();
    const curtainFill = this.createFillGradient({
      type: "linear",
      start: { x: 0, y: h * 0.08 },
      end: { x: w, y: h * 0.72 },
      colorStops: [
        { offset: 0, color: "rgba(143,232,255,0)" },
        { offset: 0.3, color: "rgba(143,232,255,0.16)" },
        { offset: 0.58, color: "rgba(184,255,202,0.17)" },
        { offset: 1, color: "rgba(240,198,255,0)" },
      ],
    });
    curtain.moveTo(-80, h * 0.18)
      .bezierCurveTo(w * 0.16, h * 0.03, w * 0.38, h * 0.3, w * 0.6, h * 0.14)
      .bezierCurveTo(w * 0.78, h * 0.02, w + 90, h * 0.22, w + 90, h * 0.42)
      .lineTo(w + 90, h * 0.74)
      .bezierCurveTo(w * 0.7, h * 0.54, w * 0.42, h * 0.7, w * 0.2, h * 0.54)
      .bezierCurveTo(w * 0.02, h * 0.42, -80, h * 0.58, -80, h * 0.18)
      .closePath()
      .fill(curtainFill || { color: accentColor, alpha: 0.12 });
    aurora.addChild(curtain);
    const colors = [accentColor, 0xb8ffca, 0xf0c6ff, 0xffffff];
    for (let i = 0; i < 7; i += 1) {
      const x1 = -120 + Math.sin(timeSeconds * 0.28 + i) * 70;
      const y1 = h * (0.16 + i * 0.09);
      const x2 = w + 120 + Math.cos(timeSeconds * 0.24 + i) * 70;
      const y2 = y1 + Math.sin(i * 1.3) * 140 + 40;
      this.drawSoftBeam(aurora, x1, y1, x2, y2, 150 + i * 24, colors[i % colors.length], 0.16 + p * 0.045, { blur: 3.2 });
    }
    this.drawRomanceSparkles("#ffffff", timeSeconds, 34, 0.055, 0.72);
    this.drawWebtoonVerticalFades(0.26, 0x061226);
  }

  drawRomanceTearDropShimmer(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#cfeaff";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(progress, 1));
    const fall = (timeSeconds * 46) % (h * 0.42);

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "screen",
        alpha: 0.09,
        zoomBoost: 0.03,
        blur: 3.8,
        blurQuality: 4,
      });
    }

    const tear = this.createFxLayer({ blendMode: "screen", alpha: 0.92 });
    const g = new this.pixi.Graphics();
    const x = w * (0.72 + Math.sin(timeSeconds * 0.3) * 0.025);
    const y = h * 0.18 + fall;
    g.ellipse(x, y, 14, 40, -0.12).fill({ color: accentColor, alpha: 0.46 });
    g.ellipse(x - 4, y - 10, 4, 12, -0.42).fill({ color: 0xffffff, alpha: 0.55 });
    g.moveTo(x, y - 110).lineTo(x - 24, y + 84).stroke({ color: accentColor, width: 3.8, alpha: 0.3 });
    g.moveTo(x + 22, y - 34).lineTo(x + 82, y - 66).stroke({ color: 0xffffff, width: 2, alpha: 0.2 });
    this.drawSoftBeam(tear, -70, h * 0.25, w * 0.8, h * 0.08, 140, 0xffffff, 0.13 + p * 0.05, { blur: 1.8 });
    tear.addChild(g);
    this.drawRomanceSparkles(accent, timeSeconds + 0.2, 30, 0.06, 0.46);
    this.drawWebtoonVerticalFades(0.28, 0x081018);
  }

  drawFantasyButterflyDreamSwarm(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#f7c8ff";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(progress, 1));

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "screen",
        alpha: 0.08,
        zoomBoost: 0.028,
        blur: 3.2,
        blurQuality: 3,
      });
    }

    const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.9 });
    const g = new this.pixi.Graphics();
    for (let i = 0; i < 26; i += 1) {
      const depth = (i % 6) / 5;
      const x = 70 + ((i * 83 + timeSeconds * (8 + depth * 36)) % (w - 140));
      const y = h * (0.18 + Math.abs(Math.sin(i * 1.31 + timeSeconds * 0.18)) * 0.65);
      const s = 5 + depth * 9;
      const flap = 0.7 + Math.sin(timeSeconds * (2.0 + depth) + i) * 0.24;
      g.ellipse(x - s * 0.42, y, s * 0.62, s * flap, -0.35).fill({ color: i % 4 ? accentColor : 0xffffff, alpha: 0.15 + depth * 0.08 + p * 0.04 });
      g.ellipse(x + s * 0.42, y, s * 0.62, s * flap, 0.35).fill({ color: i % 4 ? accentColor : 0xffffff, alpha: 0.15 + depth * 0.08 + p * 0.04 });
      g.rect(x - 0.8, y - s * 0.5, 1.6, s).fill({ color: 0xffffff, alpha: 0.14 });
    }
    layer.addChild(g);
    this.drawRomanceSparkles(accent, timeSeconds, 38, 0.065, 0.66);
    this.drawWebtoonVerticalFades(0.2, 0x130817);
  }

  drawRomanceRoyalBallroomLight(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ffd08a";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const breath = 0.5 + Math.sin(timeSeconds * 0.72) * 0.5;

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "screen",
        alpha: 0.1 + breath * 0.04,
        zoomBoost: 0.03,
        panY: -0.012,
        blur: 4.5,
        blurQuality: 4,
      });
    }

    const light = this.createFxLayer({ blendMode: "screen", alpha: 0.96 });
    const g = new this.pixi.Graphics();
    g.rect(0, 0, w, h).fill({ color: accentColor, alpha: 0.035 + breath * 0.015 });
    for (let i = 0; i < 5; i += 1) {
      const x = w * (0.14 + i * 0.18);
      this.drawSoftBeam(light, x, -60, x + Math.sin(i) * 140, h * 0.72, 190 + i * 20, i % 2 ? accentColor : 0xffffff, 0.13 + breath * 0.055, { blur: 2.5 });
      g.circle(x, h * 0.08, 13 + breath * 4).fill({ color: i % 2 ? accentColor : 0xffffff, alpha: 0.24 + breath * 0.08 });
    }
    light.addChild(g);
    this.drawRomanceSparkles(accent, timeSeconds, 96, 0.095, 0.86);
    this.drawWebtoonVerticalFades(0.2, 0x150b03);
  }

  drawFantasyHealingLightAura(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#e6ffc5";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const breath = 0.5 + Math.sin(timeSeconds * 1.05) * 0.5;
    const focus = { x: w * 0.5, y: h * 0.5, rx: w * 0.34, ry: h * 0.3 };

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "screen",
        alpha: 0.1 + breath * 0.04,
        zoomBoost: 0.025,
        blur: 3.4,
        blurQuality: 3,
      });
    }

    const aura = this.createFxLayer({ blendMode: "screen", alpha: 0.92 });
    const g = new this.pixi.Graphics();
    g.ellipse(focus.x, focus.y, focus.rx * (1 + breath * 0.08), focus.ry * (1 + breath * 0.06))
      .fill({ color: accentColor, alpha: 0.09 + breath * 0.04 });
    for (let i = 0; i < 5; i += 1) {
      const y = focus.y - focus.ry * 0.8 + i * focus.ry * 0.38 + Math.sin(timeSeconds * 0.7 + i) * 12;
      this.drawSoftBeam(aura, w * 0.08, y + 44, w * 0.92, y - 52, 82 + i * 14, i % 2 ? accentColor : 0xffffff, 0.07 + breath * 0.035, { blur: 2.1 });
    }
    for (let i = 0; i < 42; i += 1) {
      const x = w * (0.18 + Math.abs(Math.sin(i * 1.77)) * 0.64);
      const y = h - ((timeSeconds * (22 + (i % 5) * 8) + i * 41) % (h * 0.74));
      g.ellipse(x, y, 2.8 + (i % 4), 8 + (i % 5) * 2.4).fill({ color: i % 4 ? accentColor : 0xffffff, alpha: 0.11 + breath * 0.05 });
    }
    aura.addChild(g);
    this.drawWebtoonVerticalFades(0.18, 0x071209);
  }

  drawRomancePerfumeScentTrail(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ffd2ee";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(progress, 1));

    if (options.panelTexture) {
      const refract = this.createFxLayer({ blendMode: "screen", alpha: 0.12 });
      this.drawCoverSprite(options.panelTexture, refract, {
        zoom: 1.035 + (options.camera?.zoom || 1) - 1,
        panX: (options.camera?.panX || 0) + Math.sin(timeSeconds * 0.3) * 0.005,
        panY: options.camera?.panY || 0,
        filters: [this.createHeatWaveFilter(timeSeconds, 0.0024)].filter(Boolean),
      });
    }

    const scent = this.createFxLayer({ blendMode: "screen", alpha: 0.92 });
    const g = new this.pixi.Graphics();
    for (let i = 0; i < 7; i += 1) {
      const y = h * (0.2 + i * 0.095) + Math.sin(timeSeconds * 0.5 + i) * 24;
      const x1 = w * (0.15 + Math.sin(i) * 0.08);
      const x2 = w * (0.86 + Math.cos(i) * 0.06);
      g.moveTo(x1, y)
        .bezierCurveTo(w * 0.34, y - 90, w * 0.58, y + 100, x2, y + Math.sin(i) * 42)
        .stroke({ color: i % 2 ? accentColor : 0xffffff, width: 3.6 + (i % 3) * 1.2, alpha: 0.16 + p * 0.06 });
    }
    scent.addChild(g);
    this.drawRomanceSparkles(accent, timeSeconds + 0.1, 32, 0.055, 0.5);
    this.drawWebtoonVerticalFades(0.14, 0x140812);
  }

  drawRomanceSnowKissSilence(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#dcecff";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(progress, 1));

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "screen",
        alpha: 0.08 + p * 0.02,
        zoomBoost: 0.024,
        blur: 3.2,
        blurQuality: 3,
      });
    }

    const snow = this.createFxLayer({ blendMode: "screen", alpha: 0.84 });
    const g = new this.pixi.Graphics();
    g.rect(0, 0, w, h).fill({ color: accentColor, alpha: 0.025 });
    for (let i = 0; i < 132; i += 1) {
      const depth = (i % 8) / 7;
      const x = 20 + ((i * 71 + Math.sin(timeSeconds * 0.4 + i) * 32) % (w - 40));
      const y = -40 + ((i * 113 + timeSeconds * (18 + depth * 42)) % (h + 80));
      const size = 1.5 + depth * 4.8;
      g.circle(x, y, size).fill({ color: i % 6 ? accentColor : 0xffffff, alpha: 0.15 + depth * 0.1 });
    }
    snow.addChild(g);
    this.drawSoftBeam(snow, -80, h * 0.2, w + 80, h * 0.08, 145, 0xffffff, 0.1, { blur: 2.6 });
    this.drawWebtoonVerticalFades(0.34, 0x07101a);
  }

  drawFantasyMagicBookGlow(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ffe4a3";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeOutCubic(Math.min(progress / 0.82, 1));
    const breath = 0.5 + Math.sin(timeSeconds * 0.9) * 0.5;

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "screen",
        alpha: 0.12 + breath * 0.04,
        zoomBoost: 0.028,
        panY: -0.01,
        blur: 4,
        blurQuality: 4,
      });
    }

    const book = this.createFxLayer({ blendMode: "screen", alpha: 0.96 });
    const g = new this.pixi.Graphics();
    const glow = this.createFillGradient({
      type: "radial",
      center: { x: 0.5, y: 0.92 },
      innerRadius: 0.04,
      outerCenter: { x: 0.5, y: 0.7 },
      outerRadius: 0.72,
      colorStops: [
        { offset: 0, color: "rgba(255,245,190,0.54)" },
        { offset: 0.45, color: "rgba(255,216,120,0.2)" },
        { offset: 1, color: "rgba(255,216,120,0)" },
      ],
    });
    g.rect(0, 0, w, h).fill(glow || { color: accentColor, alpha: 0.06 });
    for (let i = 0; i < 34; i += 1) {
      const x = w * (0.26 + Math.abs(Math.sin(i * 1.9)) * 0.48);
      const y = h - ((timeSeconds * (18 + (i % 5) * 8) + i * 31) % (h * 0.68));
      if (i % 7 === 0) {
        g.rect(x - 10, y - 2.5, 20, 5).fill({ color: accentColor, alpha: 0.2 + p * 0.08 });
      } else {
        g.circle(x, y, 2.6 + (i % 4)).fill({ color: i % 4 ? accentColor : 0xffffff, alpha: 0.14 + breath * 0.06 });
      }
    }
    book.addChild(g);
    this.drawSoftBeam(book, w * 0.16, h + 40, w * 0.5, h * 0.26, 220, accentColor, 0.18 + breath * 0.06, { blur: 2.4 });
    this.drawWebtoonVerticalFades(0.22, 0x150d05);
  }

  drawRomanceSparkles(accent = "#ffffff", timeSeconds = 0, count = 36, alpha = 0.06, spread = 0.5) {
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.86 });
    const g = new this.pixi.Graphics();
    for (let i = 0; i < count; i += 1) {
      const depth = (i % 7) / 6;
      const x = 38 + ((i * 83 + timeSeconds * (8 + depth * 24)) % (w - 76));
      const baseY = h * (0.5 - spread * 0.5);
      const y = baseY + ((i * 137 - timeSeconds * (10 + depth * 30)) % (h * spread));
      const twinkle = Math.max(0, Math.sin(timeSeconds * (1.2 + depth * 1.6) + i));
      const size = 1.4 + depth * 4.4 + twinkle * 2;
      if (i % 9 === 0) {
        g.ellipse(x, y, size * 0.7, size * 2.5).fill({ color: 0xffffff, alpha: alpha + twinkle * 0.07 });
        g.ellipse(x, y, size * 2.5, size * 0.7).fill({ color: i % 2 ? accentColor : 0xffffff, alpha: alpha * 0.9 + twinkle * 0.05 });
      } else {
        g.circle(x, y, size).fill({ color: i % 5 === 0 ? 0xffffff : accentColor, alpha: alpha + depth * 0.04 + twinkle * 0.05 });
      }
    }
    layer.addChild(g);
  }

  drawGlitchHorrorProVfx(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#00eaff";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeOutCubic(Math.min(progress / 0.78, 1));
    const beat = Math.max(0, Math.sin(timeSeconds * 8.4));
    const burst = Math.pow(beat, 2.2);
    const crawl = 0.5 + Math.sin(timeSeconds * 1.34) * 0.5;
    const micro = 0.5 + Math.sin(timeSeconds * 31.0) * 0.5;
    const focus = {
      x: w * (0.5 + Math.sin(timeSeconds * 0.62) * 0.018 + burst * 0.018),
      y: h * (0.45 + Math.cos(timeSeconds * 0.55) * 0.016 - burst * 0.012),
      rx: w * (0.31 + Math.sin(progress * Math.PI) * 0.018),
      ry: h * (0.255 + Math.sin(progress * Math.PI) * 0.016),
    };
    const signal = this.createHorrorSignalCorruptionFilter(timeSeconds, 0.006 + burst * 0.009 + micro * 0.0015, progress);
    const tear = this.createVhsTearFilter(timeSeconds, 0.003 + burst * 0.009);
    const chroma = this.createChromaticPulseFilter(timeSeconds, 0.002 + burst * 0.005);

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "screen",
        alpha: 0.06 + burst * 0.08,
        zoomBoost: 0.038 + burst * 0.045,
        panX: 0.028 + Math.sin(timeSeconds * 19) * burst * 0.018,
        panY: -0.018 + Math.cos(timeSeconds * 17) * burst * 0.014,
        blur: 1.8 + burst * 2.0,
        blurQuality: 3,
      });
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "multiply",
        alpha: 0.11 + burst * 0.07,
        zoomBoost: -0.014,
        panX: -0.024 - Math.sin(timeSeconds * 13) * burst * 0.014,
        panY: 0.018,
        rotation: -0.004,
        blur: 0.8,
      });

      const layer = this.createFxLayer({ blendMode: "normal", alpha: 0.18 + burst * 0.12 });
      this.drawCoverSprite(options.panelTexture, layer, {
        zoom: 1.13 + (options.camera?.zoom || 1) - 1 + burst * 0.055,
        panX: (options.camera?.panX || 0) + Math.sin(timeSeconds * 21) * burst * 0.018,
        panY: (options.camera?.panY || 0) + Math.cos(timeSeconds * 18) * burst * 0.014,
        rotation: (options.camera?.rotation || 0) + Math.sin(timeSeconds * 24) * burst * 0.006,
        filters: [signal, tear, chroma].filter(Boolean),
      });

      const redLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.055 + burst * 0.055 });
      this.drawCoverSprite(options.panelTexture, redLayer, {
        zoom: 1.11 + (options.camera?.zoom || 1) - 1,
        panX: (options.camera?.panX || 0) - 0.012 - burst * 0.018,
        panY: (options.camera?.panY || 0) + Math.sin(timeSeconds * 11) * 0.004,
        rotation: (options.camera?.rotation || 0) - 0.003,
        alpha: 0.52,
        filters: [this.createChromaticPulseFilter(timeSeconds, 0.0025 + burst * 0.004)].filter(Boolean),
      });

      const blueLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.06 + burst * 0.065 });
      this.drawCoverSprite(options.panelTexture, blueLayer, {
        zoom: 1.115 + (options.camera?.zoom || 1) - 1,
        panX: (options.camera?.panX || 0) + 0.016 + burst * 0.024,
        panY: (options.camera?.panY || 0) - Math.cos(timeSeconds * 9) * 0.005,
        rotation: (options.camera?.rotation || 0) + 0.004,
        alpha: 0.5,
        filters: [this.createHorrorSignalCorruptionFilter(timeSeconds + 0.31, 0.003 + burst * 0.005, progress)].filter(Boolean),
      });
    }

    const darkLayer = this.createFxLayer({ blendMode: "multiply", alpha: 0.66 });
    const dark = new this.pixi.Graphics();
    const shade = this.createFillGradient({
      type: "radial",
      center: { x: focus.x / w, y: focus.y / h },
      innerRadius: 0.13,
      outerCenter: { x: 0.5, y: 0.5 },
      outerRadius: 0.86,
      colorStops: [
        { offset: 0, color: "rgba(0,0,0,0.02)" },
        { offset: 0.48, color: "rgba(0,0,0,0.12)" },
        { offset: 1, color: "rgba(0,0,0,0.48)" },
      ],
    });
    dark.rect(0, 0, w, h).fill(shade || { color: 0x020205, alpha: 0.34 });
    dark.rect(0, 0, w, 112 + burst * 18).fill({ color: 0x000000, alpha: 0.13 + burst * 0.05 });
    dark.rect(0, h - 138 - burst * 22, w, 158 + burst * 22).fill({ color: 0x000000, alpha: 0.15 + burst * 0.06 });
    for (let i = 0; i < 9; i += 1) {
      const y = 110 + i * 128 + Math.sin(timeSeconds * 1.6 + i) * 24;
      const width = 30 + (i % 4) * 14 + burst * 18;
      dark.rect(i % 2 ? -20 : w - width + 20, y, width, 42 + (i % 3) * 18).fill({ color: 0x000000, alpha: 0.035 + burst * 0.02 });
    }
    darkLayer.addChild(dark);

    const tearLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.42 });
    tearLayer.filters = [this.createBlurFilter(0.55, 2)].filter(Boolean);
    const tears = new this.pixi.Graphics();
    for (let i = 0; i < 10; i += 1) {
      const y = 84 + ((i * 137 + timeSeconds * (96 + burst * 250)) % (h - 168));
      const height = 5 + (i % 5) * 5 + burst * (i % 3 === 0 ? 6 : 2);
      const offset = Math.sin(timeSeconds * 7 + i * 1.7) * (12 + burst * 30);
      const length = w * (0.16 + (i % 6) * 0.08);
      const x = i % 2 === 0 ? offset - 80 : w - length - offset + 80;
      const color = i % 5 === 0 ? 0xffffff : i % 3 === 0 ? 0xff254a : accentColor;
      tears.rect(x, y, length, height).fill({ color, alpha: 0.014 + burst * 0.035 + (i % 4) * 0.004 });
      if (i % 4 === 0) {
        tears.rect(-offset, y + height + 10, w + 80, 1.2).fill({ color: 0xffffff, alpha: 0.012 + burst * 0.024 });
      }
    }
    const scanY = -120 + ((timeSeconds * 250) % (h + 240));
    tears.rect(0, scanY, w, 14 + burst * 8).fill({ color: 0xffffff, alpha: 0.032 + burst * 0.055 });
    tears.rect(0, scanY + 22, w, 2.5).fill({ color: accentColor, alpha: 0.075 + burst * 0.06 });
    tearLayer.addChild(tears);

    const scanLayer = this.createFxLayer({ blendMode: "multiply", alpha: 0.38 });
    const scan = new this.pixi.Graphics();
    for (let y = 0; y < h; y += 7) {
      const band = (y / 7) % 3;
      scan.rect(0, y, w, 1.5).fill({ color: 0x000000, alpha: 0.038 + band * 0.009 + burst * 0.012 });
    }
    scanLayer.addChild(scan);

    const graphicsLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.46 });
    const g = new this.pixi.Graphics();
    g.rect(42, 108, w - 84, h - 226).stroke({ color: accentColor, width: 1.4, alpha: 0.07 + burst * 0.05 });
    g.rect(58, 128, w - 116, h - 266).stroke({ color: 0xffffff, width: 1, alpha: 0.03 + burst * 0.025 });
    [
      { x: 62, y: 142, sx: 82, sy: 0 },
      { x: 62, y: 142, sx: 0, sy: 82 },
      { x: w - 62, y: 142, sx: -82, sy: 0 },
      { x: w - 62, y: 142, sx: 0, sy: 82 },
      { x: 62, y: h - 232, sx: 82, sy: 0 },
      { x: 62, y: h - 232, sx: 0, sy: -82 },
      { x: w - 62, y: h - 232, sx: -82, sy: 0 },
      { x: w - 62, y: h - 232, sx: 0, sy: -82 },
    ].forEach((line) => {
      g.moveTo(line.x, line.y).lineTo(line.x + line.sx, line.y + line.sy)
        .stroke({ color: line.sx || line.sy ? accentColor : 0xffffff, width: 2, alpha: 0.09 + burst * 0.07 });
    });
    for (let i = 0; i < 10; i += 1) {
      const y = 160 + ((i * 71 + timeSeconds * 68) % (h - 340));
      const x = 74 + (i % 4) * 36;
      const length = 90 + (i % 6) * 34;
      g.rect(x, y, length, 1.4).fill({ color: i % 4 === 0 ? 0xffffff : accentColor, alpha: 0.035 + burst * 0.032 });
    }
    for (let i = 0; i < 7; i += 1) {
      const side = i % 2 ? -1 : 1;
      const y = h * (0.16 + i * 0.074) + Math.sin(timeSeconds * 5 + i) * 16;
      const x1 = side > 0 ? w + 72 : -72;
      const x2 = focus.x + side * (focus.rx * (0.72 + (i % 3) * 0.22));
      this.drawTaperedQuad(g, x1, y, x2, focus.y + (y - h * 0.5) * 0.38, 10 + (i % 3) * 5, 1.2, i % 3 ? accentColor : 0xffffff, 0.028 + burst * 0.04);
    }
    graphicsLayer.addChild(g);

    const grainTexture = this.textureNoise();
    const grainLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.04 + burst * 0.025 });
    const grain = new this.pixi.Sprite(grainTexture);
    grain.width = w * 1.12;
    grain.height = h * 1.12;
    grain.x = -w * 0.06 + Math.sin(timeSeconds * 41) * 24;
    grain.y = -h * 0.06 + Math.cos(timeSeconds * 37) * 28;
    grainLayer.addChild(grain);

    const hotLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.42 });
    hotLayer.filters = [this.createBlurFilter(0.45, 2)].filter(Boolean);
    const hot = new this.pixi.Graphics();
    hot.rect(0, 0, w, h).fill({ color: 0xffffff, alpha: Math.max(0, 0.055 - progress * 0.12) + burst * 0.008 });
    const redPulse = 0.04 + burst * 0.085 + p * 0.018;
    for (let i = 0; i < 5; i += 1) {
      const side = i % 2 ? -1 : 1;
      const y = focus.y - focus.ry * 0.92 + i * focus.ry * 0.32 + Math.sin(timeSeconds * 9 + i) * 14;
      const x1 = focus.x + side * (focus.rx * (0.78 + (i % 3) * 0.14));
      const x2 = focus.x - side * (focus.rx * (0.22 + (i % 4) * 0.12));
      this.drawTaperedQuad(
        hot,
        x1,
        y,
        x2 + Math.sin(timeSeconds * 16 + i) * 18,
        y - 58 - (i % 3) * 28,
        2 + burst * 3,
        7 + (i % 3) * 4 + burst * 5,
        i % 3 === 0 ? 0xffffff : 0xff254a,
        redPulse - i * 0.008,
      );
    }
    for (let i = 0; i < 7; i += 1) {
      const x = 54 + ((i * 131 + timeSeconds * (90 + burst * 220)) % (w - 108));
      const y = 160 + ((i * 97 + timeSeconds * (34 + burst * 120)) % (h - 360));
      const width = 12 + (i % 5) * 18 + burst * 18;
      const height = 7 + (i % 3) * 10;
      const color = i % 4 === 0 ? 0xffffff : i % 2 === 0 ? accentColor : 0xff254a;
      hot.rect(x, y, width, height).fill({ color, alpha: 0.022 + burst * 0.045 });
    }
    hot.moveTo(focus.x - focus.rx * 0.6, focus.y + focus.ry * 0.44)
      .lineTo(focus.x - focus.rx * 0.18, focus.y + focus.ry * 0.34 + burst * 32)
      .lineTo(focus.x + focus.rx * 0.42, focus.y + focus.ry * 0.68)
      .lineTo(focus.x + focus.rx * 0.58, focus.y + focus.ry * 0.76)
      .lineTo(focus.x - focus.rx * 0.54, focus.y + focus.ry * 0.56)
      .closePath()
      .stroke({ color: accentColor, width: 2 + burst * 1.5, alpha: 0.05 + burst * 0.065 });
    hot.rect(0, scanY + 48, w, 1.4).fill({ color: 0xff254a, alpha: 0.08 + burst * 0.07 });
    for (let i = 0; i < 5; i += 1) {
      const y = focus.y - focus.ry * 0.46 + i * focus.ry * 0.22 + Math.sin(timeSeconds * 12 + i) * 4;
      hot.rect(focus.x - focus.rx * (0.52 + i * 0.03), y, focus.rx * (0.92 + (i % 2) * 0.2), 7 + burst * 8)
        .fill({ color: 0xffffff, alpha: 0.008 + burst * 0.012 });
    }
    hotLayer.addChild(hot);

    this.restoreGlitchSignalFocus(options.panelTexture, options.camera, focus, timeSeconds, 0.42);
  }

  drawHorrorThrillerProVfx(effect, progress, timeSeconds, options = {}) {
    const layout = effect.layout || "";
    if (layout === "horror-shadow-crawl") {
      this.drawHorrorShadowCrawl(effect, progress, timeSeconds, options);
    } else if (layout === "horror-red-strobe-dread") {
      this.drawHorrorRedStrobeDread(effect, progress, timeSeconds, options);
    } else if (layout === "horror-ink-bleed-omen") {
      this.drawInkBleedRevealPro({ ...effect, layout: "ink-bleed", accent: effect.accent || "#050505" }, progress, timeSeconds, options);
    } else if (layout === "horror-jumpscare-snap") {
      this.drawJumpscareSnapEffect({ ...effect, layout: "jumpscare-zoom", accent: effect.accent || "#f6f0e8" }, progress, timeSeconds, options);
    } else if (layout === "horror-vhs-possession") {
      this.drawVhsPossessionPro({ ...effect, layout: "vhs-horror", accent: effect.accent || "#42f5ff" }, progress, timeSeconds, options);
    } else if (layout === "horror-eye-panic-push") {
      this.drawHorrorEyePanicPush(effect, progress, timeSeconds, options);
    } else if (layout === "horror-blackout-breath") {
      this.drawHorrorBlackoutBreath(effect, progress, timeSeconds, options);
    } else if (layout === "horror-cursed-symbol-reveal") {
      this.drawHorrorCursedSymbolReveal(effect, progress, timeSeconds, options);
    } else if (layout === "horror-monster-silhouette") {
      this.drawHorrorMonsterSilhouette(effect, progress, timeSeconds, options);
    } else if (layout === "horror-blood-drop-omen") {
      this.drawHorrorBloodDropOmen(effect, progress, timeSeconds, options);
    } else if (layout === "toxic-ooze-omen") {
      this.drawToxicOozeOmen(effect, progress, timeSeconds, options);
    } else if (layout === "hellfire-ash-omen") {
      this.drawHellfireAshOmen(effect, progress, timeSeconds, options);
    } else if (layout === "bullet-impact-glass") {
      this.drawBulletImpactGlass(effect, progress, timeSeconds, options);
    } else if (layout === "black-ink-curse") {
      this.drawBlackInkCurse(effect, progress, timeSeconds, options);
    } else if (layout.startsWith("thriller-")) {
      this.drawThrillerProVfx(effect, progress, timeSeconds, options);
    } else if (layout.startsWith("suspense-")) {
      this.drawSuspenseProVfx(effect, progress, timeSeconds, options);
    }
  }

  drawHorrorShadowCrawl(effect, progress, timeSeconds, options = {}) {
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(progress, 1));
    const crawl = 0.5 + Math.sin(timeSeconds * 1.15) * 0.5;

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "multiply",
        alpha: 0.22 + crawl * 0.1,
        zoomBoost: 0.026 + p * 0.014,
        panX: Math.sin(timeSeconds * 0.52) * 0.01,
        panY: Math.cos(timeSeconds * 0.48) * 0.01,
        blur: 1.8,
        blurQuality: 2,
      });
    }

    const shade = this.createFxLayer({ blendMode: "multiply", alpha: 0.98 });
    const g = new this.pixi.Graphics();
    g.rect(0, 0, w, h).fill({ color: 0x050506, alpha: 0.14 + p * 0.05 });
    for (let i = 0; i < 12; i += 1) {
      const side = i % 2 ? -1 : 1;
      const startX = side > 0 ? -90 : w + 90;
      const baseY = h * (0.08 + i * 0.078) + Math.sin(timeSeconds * 0.9 + i) * 18;
      const reach = w * (0.22 + p * 0.18 + (i % 4) * 0.035 + crawl * 0.06);
      const endX = side > 0 ? reach : w - reach;
      g.moveTo(startX, baseY - 42)
        .lineTo(endX + side * Math.sin(i) * 44, baseY - 12)
        .lineTo(endX + side * (60 + crawl * 48), baseY + 46 + (i % 3) * 18)
        .lineTo(startX, baseY + 100)
        .closePath()
        .fill({ color: 0x000000, alpha: 0.11 + (i % 3) * 0.025 + crawl * 0.025 });
    }
    for (let i = 0; i < 7; i += 1) {
      const x = w * (0.18 + i * 0.12) + Math.sin(timeSeconds * 0.6 + i) * 18;
      g.rect(x, 0, 20 + (i % 3) * 16, h).fill({ color: 0x000000, alpha: 0.035 + crawl * 0.025 });
    }
    shade.addChild(g);

    const edge = this.createFxLayer({ blendMode: "screen", alpha: 0.52 });
    const e = new this.pixi.Graphics();
    e.moveTo(w * 0.08, h * 0.2).lineTo(w * 0.92, h * 0.09)
      .stroke({ color: 0x9aa7b8, width: 1.5, alpha: 0.045 + crawl * 0.035 });
    e.moveTo(w * 0.18, h * 0.82).lineTo(w * 0.82, h * 0.68)
      .stroke({ color: 0x7b0b1d, width: 1.7, alpha: 0.04 + crawl * 0.035 });
    edge.addChild(e);

    this.restoreHorrorVerticalTear(options.panelTexture, options.camera, timeSeconds, {
      alpha: 0.56 + (1 - crawl) * 0.12,
      x: w * (0.54 + Math.sin(timeSeconds * 0.4) * 0.03),
      width: w * 0.24,
      zoomBoost: 0.02,
    });
  }

  drawHorrorRedStrobeDread(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#d8162f";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeOutCubic(Math.min(progress / 0.72, 1));
    const strobe = Math.pow(Math.max(0, Math.sin(timeSeconds * 8.8)), 3.2);
    const panic = Math.pow(Math.max(0, Math.sin(timeSeconds * 15.5 + 0.7)), 4.0);
    const hit = Math.max(strobe, panic * 0.85);
    const focus = {
      x: w * (0.5 + Math.sin(timeSeconds * 0.7) * 0.018),
      y: h * (0.47 + Math.cos(timeSeconds * 0.62) * 0.014),
      rx: w * 0.34,
      ry: h * 0.28,
    };

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "screen",
        alpha: 0.08 + hit * 0.18,
        zoomBoost: 0.04 + hit * 0.05,
        panX: Math.sin(timeSeconds * 18) * hit * 0.016,
        panY: Math.cos(timeSeconds * 15) * hit * 0.012,
        blur: 0.4 + hit * 1.4,
        blurQuality: 2,
      });
    }

    const darkLayer = this.createFxLayer({ blendMode: "multiply", alpha: 0.95 });
    const dark = new this.pixi.Graphics();
    dark.rect(0, 0, w, h).fill({ color: 0x060006, alpha: 0.22 + p * 0.08 });
    dark.rect(0, 0, w, h).stroke({ color: 0x000000, width: 120, alpha: 0.24 + hit * 0.12 });
    darkLayer.addChild(dark);

    const redLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.98 });
    const red = new this.pixi.Graphics();
    red.rect(0, 0, w, h).fill({ color: accentColor, alpha: 0.04 + hit * 0.22 });
    red.rect(0, 0, w, h).fill({ color: 0xffffff, alpha: hit * 0.09 });
    for (let i = 0; i < 7; i += 1) {
      const y = 100 + i * 145 + Math.sin(timeSeconds * 3 + i) * 28;
      this.drawSoftBeam(redLayer, -80, y, w + 80, y - 46, 54 + i * 8, i % 2 ? accentColor : 0xffffff, 0.06 + hit * 0.11, { blur: 0.7 });
    }
    for (let i = 0; i < 5; i += 1) {
      const x = 54 + i * 112 + Math.sin(timeSeconds * 3.4 + i) * 10;
      red.rect(x, 0, 22 + hit * 22, h).fill({ color: i % 2 ? accentColor : 0xffffff, alpha: 0.024 + hit * 0.052 });
    }
    red.moveTo(0, h * 0.25 + hit * 26)
      .lineTo(w, h * 0.18 - hit * 18)
      .stroke({ color: accentColor, width: 5 + hit * 7, alpha: 0.08 + hit * 0.12 });
    red.moveTo(0, h * 0.74 - hit * 18)
      .lineTo(w, h * 0.86 + hit * 24)
      .stroke({ color: 0xffffff, width: 3 + hit * 5, alpha: 0.055 + hit * 0.1 });
    redLayer.addChild(red);
    this.restoreHorrorSlitFocus(options.panelTexture, options.camera, {
      alpha: 0.68 + hit * 0.16,
      y: h * 0.46 + Math.sin(timeSeconds * 4) * hit * 18,
      width: w * (0.76 + hit * 0.12),
      height: h * (0.18 + hit * 0.08),
      skew: -72 + hit * 32,
      zoomBoost: 0.035 + hit * 0.03,
    });
  }

  drawHorrorEyePanicPush(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#f8efe6";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeOutCubic(Math.min(progress / 0.86, 1));
    const nerve = 0.5 + Math.sin(timeSeconds * 18.0) * 0.5;
    const focus = {
      x: w * (0.52 + Math.sin(timeSeconds * 0.9) * 0.018),
      y: h * (0.43 + Math.cos(timeSeconds * 0.72) * 0.012),
      rx: w * (0.24 + p * 0.04),
      ry: h * (0.18 + p * 0.03),
    };

    if (options.panelTexture) {
      const chroma = this.createChromaticPulseFilter(timeSeconds, 0.002 + nerve * 0.004);
      const detail = this.createFxLayer({ blendMode: "normal", alpha: 0.26 + p * 0.16 });
      this.drawCoverSprite(options.panelTexture, detail, {
        zoom: 1.17 + (options.camera?.zoom || 1) - 1 + p * 0.08,
        panX: (options.camera?.panX || 0) + Math.sin(timeSeconds * 20) * nerve * 0.005,
        panY: (options.camera?.panY || 0) + Math.cos(timeSeconds * 19) * nerve * 0.005,
        rotation: Math.sin(timeSeconds * 14) * nerve * 0.0025,
        filters: [chroma].filter(Boolean),
      });
    }

    const shade = this.createFxLayer({ blendMode: "multiply", alpha: 0.98 });
    const g = new this.pixi.Graphics();
    const vignette = this.createFillGradient({
      type: "radial",
      center: { x: focus.x / w, y: focus.y / h },
      innerRadius: 0.12,
      outerCenter: { x: 0.5, y: 0.5 },
      outerRadius: 0.74,
      colorStops: [
        { offset: 0, color: "rgba(0,0,0,0)" },
        { offset: 0.44, color: "rgba(0,0,0,0.16)" },
        { offset: 1, color: "rgba(0,0,0,0.76)" },
      ],
    });
    g.rect(0, 0, w, h).fill(vignette || { color: 0x000000, alpha: 0.35 });
    shade.addChild(g);

    const marks = this.createFxLayer({ blendMode: "screen", alpha: 0.86 });
    const m = new this.pixi.Graphics();
    m.ellipse(focus.x, focus.y, focus.rx, focus.ry)
      .stroke({ color: accentColor, width: 2.5, alpha: 0.14 + nerve * 0.08 });
    for (let i = 0; i < 11; i += 1) {
      const angle = -0.65 + i * 0.13 + Math.sin(timeSeconds * 2 + i) * 0.02;
      const x1 = focus.x + Math.cos(angle) * focus.rx * 0.9;
      const y1 = focus.y + Math.sin(angle) * focus.ry * 1.35;
      const x2 = focus.x + Math.cos(angle) * focus.rx * (1.32 + nerve * 0.12);
      const y2 = focus.y + Math.sin(angle) * focus.ry * (1.78 + nerve * 0.18);
      m.moveTo(x1, y1).lineTo(x2, y2).stroke({ color: i % 3 ? accentColor : 0xb50018, width: 1.5 + (i % 2), alpha: 0.08 + nerve * 0.06 });
    }
    marks.addChild(m);
    this.restoreSpeedImpactFocus(options.panelTexture, options.camera, focus, 0.72);
  }

  drawHorrorBlackoutBreath(effect, progress, timeSeconds, options = {}) {
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(progress, 1));
    const breath = 0.5 + Math.sin(timeSeconds * 1.35) * 0.5;
    const lock = Math.pow(breath, 1.8);

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "multiply",
        alpha: 0.22 + lock * 0.14,
        zoomBoost: 0.03 + lock * 0.02,
        panX: Math.sin(timeSeconds * 0.42) * 0.008,
        panY: Math.cos(timeSeconds * 0.38) * 0.01,
        blur: 2.6 + lock * 1.4,
      });
    }

    const blackout = this.createFxLayer({ blendMode: "multiply", alpha: 0.98 });
    const g = new this.pixi.Graphics();
    g.rect(0, 0, w, h).fill({ color: 0x000000, alpha: 0.18 + lock * 0.22 + p * 0.05 });
    const top = h * (0.1 + lock * 0.18);
    const bottom = h * (0.9 - lock * 0.2);
    g.rect(0, 0, w, top).fill({ color: 0x000000, alpha: 0.48 + lock * 0.28 });
    g.rect(0, bottom, w, h - bottom).fill({ color: 0x000000, alpha: 0.5 + lock * 0.3 });
    for (let i = 0; i < 8; i += 1) {
      const y = h * (0.18 + i * 0.095) + Math.sin(timeSeconds * 0.8 + i) * 18;
      const height = 30 + (i % 4) * 18 + lock * 28;
      const x = i % 2 ? w * 0.68 : -w * 0.08;
      g.rect(x, y, w * (0.42 + (i % 3) * 0.1), height)
        .fill({ color: 0x000000, alpha: 0.13 + lock * 0.09 });
    }
    blackout.addChild(g);

    const slits = this.createFxLayer({ blendMode: "screen", alpha: 0.58 });
    const s = new this.pixi.Graphics();
    for (let i = 0; i < 4; i += 1) {
      const y = h * (0.32 + i * 0.12) + Math.sin(timeSeconds * 1.1 + i) * 9;
      s.moveTo(w * 0.12, y)
        .lineTo(w * 0.88, y - 28 + i * 10)
        .stroke({ color: i % 2 ? 0x7b0b1d : 0xffffff, width: 1.8 + lock * 2.2, alpha: 0.035 + lock * 0.06 });
    }
    slits.addChild(s);

    this.restoreHorrorSlitFocus(options.panelTexture, options.camera, {
      alpha: 0.48 + (1 - lock) * 0.22,
      y: h * 0.48,
      width: w * (0.6 + (1 - lock) * 0.28),
      height: h * (0.08 + (1 - lock) * 0.08),
      skew: -34,
      zoomBoost: 0.025,
    });
  }

  drawHorrorCursedSymbolReveal(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#b50018";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeOutCubic(Math.min(progress / 0.9, 1));
    const flicker = Math.max(0, Math.sin(timeSeconds * 11.0));
    const cx = w * 0.5;
    const cy = h * 0.47;
    const radius = 130 + p * 34 + Math.sin(timeSeconds * 0.9) * 6;

    const shade = this.createFxLayer({ blendMode: "multiply", alpha: 0.9 });
    const s = new this.pixi.Graphics();
    s.rect(0, 0, w, h).fill({ color: 0x050006, alpha: 0.2 + p * 0.08 });
    s.rect(0, 0, w, h).stroke({ color: 0x000000, width: 110, alpha: 0.24 + p * 0.08 });
    shade.addChild(s);

    const ritual = this.createFxLayer({ blendMode: "screen", alpha: 0.96 });
    const g = new this.pixi.Graphics();
    g.circle(cx, cy, radius).stroke({ color: accentColor, width: 3, alpha: 0.14 + p * 0.22 + flicker * 0.06 });
    g.circle(cx, cy, radius * 0.64).stroke({ color: 0xffffff, width: 1.5, alpha: 0.08 + p * 0.12 });
    for (let i = 0; i < 5; i += 1) {
      const a1 = -Math.PI / 2 + i * (Math.PI * 2 / 5) + timeSeconds * 0.05;
      const a2 = -Math.PI / 2 + ((i + 2) % 5) * (Math.PI * 2 / 5) + timeSeconds * 0.05;
      g.moveTo(cx + Math.cos(a1) * radius * 0.8, cy + Math.sin(a1) * radius * 0.8)
        .lineTo(cx + Math.cos(a2) * radius * 0.8, cy + Math.sin(a2) * radius * 0.8)
        .stroke({ color: accentColor, width: 2, alpha: 0.12 + p * 0.2 + flicker * 0.06 });
    }
    for (let i = 0; i < 18; i += 1) {
      const angle = (i / 18) * Math.PI * 2 - timeSeconds * 0.08;
      const x = cx + Math.cos(angle) * radius * 1.16;
      const y = cy + Math.sin(angle) * radius * 1.16;
      g.rect(x - 9, y - 2, 18, 4).fill({ color: i % 3 ? accentColor : 0xffffff, alpha: 0.08 + p * 0.14 });
    }
    ritual.addChild(g);
    this.drawSoftBeam(ritual, cx - 210, cy + 170, cx + 190, cy - 190, 58, accentColor, 0.08 + p * 0.08, { blur: 0.9 });
    this.restoreSpeedImpactFocus(options.panelTexture, options.camera, { x: cx, y: cy, rx: w * 0.28, ry: h * 0.24 }, 0.72);
  }

  drawHorrorMonsterSilhouette(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#140006";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(progress, 1));
    const breath = 0.5 + Math.sin(timeSeconds * 1.1) * 0.5;
    const cx = w * (0.5 + Math.sin(timeSeconds * 0.34) * 0.012);
    const cy = h * 0.48;

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "multiply",
        alpha: 0.24 + breath * 0.08,
        zoomBoost: 0.04 + p * 0.03,
        panY: -0.012,
        blur: 2.2,
      });
    }

    const shade = this.createFxLayer({ blendMode: "multiply", alpha: 0.98 });
    const s = new this.pixi.Graphics();
    s.rect(0, 0, w, h).fill({ color: 0x070006, alpha: 0.18 + p * 0.12 });
    s.rect(0, 0, w, h).stroke({ color: 0x000000, width: 124, alpha: 0.22 + p * 0.14 });
    shade.addChild(s);

    const silhouette = this.createFxLayer({ blendMode: "multiply", alpha: 0.9 });
    const body = new this.pixi.Graphics();
    body.moveTo(cx - 74 - breath * 10, cy - 118)
      .lineTo(cx + 68 + breath * 8, cy - 96)
      .lineTo(cx + 122 + p * 18, cy + 68)
      .lineTo(cx + 172 + breath * 10, cy + 284)
      .lineTo(cx - 156 - p * 20, cy + 298)
      .lineTo(cx - 118 - breath * 12, cy + 72)
      .closePath()
      .fill({ color: 0x000000, alpha: 0.36 + p * 0.2 });
    body.moveTo(cx - 118, cy - 28)
      .lineTo(cx - 192 - breath * 14, cy + 92)
      .lineTo(cx - 132, cy + 226)
      .lineTo(cx - 76, cy + 58)
      .closePath()
      .fill({ color: 0x000000, alpha: 0.2 + p * 0.13 });
    body.moveTo(cx + 112, cy - 18)
      .lineTo(cx + 196 + breath * 12, cy + 104)
      .lineTo(cx + 128, cy + 238)
      .lineTo(cx + 74, cy + 68)
      .closePath()
      .fill({ color: 0x000000, alpha: 0.2 + p * 0.13 });
    silhouette.addChild(body);

    const rim = this.createFxLayer({ blendMode: "screen", alpha: 0.7 });
    const r = new this.pixi.Graphics();
    r.ellipse(cx, cy - 20, 92 + breath * 8, 126 + breath * 10)
      .stroke({ color: accentColor, width: 4, alpha: 0.11 + p * 0.07 });
    r.circle(cx - 30, cy - 42, 4 + breath * 2).fill({ color: 0xff254a, alpha: 0.14 + p * 0.18 });
    r.circle(cx + 30, cy - 42, 4 + breath * 2).fill({ color: 0xff254a, alpha: 0.14 + p * 0.18 });
    rim.addChild(r);
    this.restoreHorrorSlitFocus(options.panelTexture, options.camera, {
      alpha: 0.44,
      y: h * 0.54,
      width: w * 0.55,
      height: h * 0.18,
      skew: 64,
      zoomBoost: 0.028,
      panY: -0.01,
    });
  }

  drawHorrorBloodDropOmen(effect, progress, timeSeconds, options = {}) {
    const accentColor = parsePixiColor(effect.accent || "#b50018");
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeOutCubic(Math.min(progress / 0.9, 1));
    const pulse = 0.5 + Math.sin(timeSeconds * 1.7) * 0.5;

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "multiply",
        alpha: 0.24 + pulse * 0.08,
        zoomBoost: 0.024 + p * 0.018,
        panY: Math.sin(timeSeconds * 0.42) * 0.006,
        blur: 1.2,
        blurQuality: 2,
      });
    }

    this.drawThrillerSuspenseGrade(accentColor, { alpha: 0.88, cold: false, quiet: true });

    const stain = this.createFxLayer({ blendMode: "multiply", alpha: 0.92 });
    const s = new this.pixi.Graphics();
    s.rect(0, 0, w, h).fill({ color: 0x120004, alpha: 0.14 + pulse * 0.08 });
    s.rect(0, 0, w, h).stroke({ color: 0x000000, width: 110, alpha: 0.28 });
    stain.addChild(s);

    const drops = this.createFxLayer({ blendMode: "normal", alpha: 0.98 });
    const dropTexture = this.textureComicBloodDrop();
    const splatterTexture = this.textureComicBloodSplatter();
    const coords = [
      [w * 0.14, h * -0.02, 1.45], [w * 0.78, h * -0.04, 1.6], [w * 0.48, h * 0.02, 1.12],
      [w * 0.9, h * 0.13, 0.92], [w * 0.25, h * 0.12, 0.82], [w * 0.08, h * 0.28, 1.0],
      [w * 0.68, h * 0.2, 0.72],
    ];
    coords.forEach(([x, baseY, scale], i) => {
      const drip = ((timeSeconds * (36 + i * 7) + i * 79) % (h * 0.58)) * (0.16 + scale * 0.14);
      const y = baseY + drip;
      const sprite = new this.pixi.Sprite(dropTexture);
      sprite.anchor.set(0.5, 0.1);
      sprite.x = x + Math.sin(timeSeconds * 0.8 + i) * 7;
      sprite.y = y;
      sprite.scale.set(0.44 * scale * (i % 2 ? 0.86 : 1), 0.5 * scale * (1 + pulse * 0.04));
      sprite.rotation = Math.sin(i * 1.4) * 0.28 + Math.sin(timeSeconds * 0.32 + i) * 0.035;
      sprite.tint = 0xffffff;
      sprite.alpha = Math.min(1, 0.84 + scale * 0.08);
      drops.addChild(sprite);
    });

    const splatter = new this.pixi.Sprite(splatterTexture);
    splatter.anchor.set(0.5);
    splatter.x = w * (0.23 + Math.sin(timeSeconds * 0.35) * 0.018);
    splatter.y = h * 0.62;
    splatter.scale.set(1.35 + pulse * 0.05, 1.02 + pulse * 0.03);
    splatter.rotation = -0.22 + Math.sin(timeSeconds * 0.28) * 0.04;
    splatter.tint = 0xffffff;
    splatter.alpha = 0.84;
    drops.addChild(splatter);

    const g = new this.pixi.Graphics();
    g.rect(0, 0, w, 22).fill({ color: 0x6d0012, alpha: 0.64 });
    for (let i = 0; i < 8; i += 1) {
      const x = w * (0.08 + i * 0.13) + Math.sin(i * 2.2) * 18;
      const len = 52 + (i % 4) * 34 + pulse * 18;
      g.moveTo(x, 0)
        .quadraticCurveTo(x + Math.sin(i) * 14, len * 0.55, x + Math.cos(i) * 10, len)
        .stroke({ color: 0x8f0018, width: 9 + (i % 3) * 3, alpha: 0.58 });
      g.moveTo(x - 3, 8)
        .quadraticCurveTo(x + Math.sin(i) * 10 - 2, len * 0.5, x + Math.cos(i) * 8 - 2, len - 6)
        .stroke({ color: 0x210004, width: 3, alpha: 0.52 });
    }
    g.moveTo(w * 0.04, h * 0.82)
      .quadraticCurveTo(w * 0.32, h * 0.76 + pulse * 28, w * 0.56, h * 0.84)
      .quadraticCurveTo(w * 0.78, h * 0.92, w * 0.98, h * 0.86)
      .stroke({ color: 0x8f0018, width: 30, alpha: 0.34 + pulse * 0.08 });
    g.moveTo(w * 0.04, h * 0.82)
      .quadraticCurveTo(w * 0.32, h * 0.76 + pulse * 28, w * 0.56, h * 0.84)
      .quadraticCurveTo(w * 0.78, h * 0.92, w * 0.98, h * 0.86)
      .stroke({ color: 0xff4b4b, width: 6, alpha: 0.22 });
    for (let i = 0; i < 20; i += 1) {
      const x = w * (0.1 + Math.abs(Math.sin(i * 1.73)) * 0.8);
      const y = h * (0.18 + Math.abs(Math.cos(i * 2.11)) * 0.62);
      const r = 4 + (i % 5) * 2.8;
      g.ellipse(x, y, r * (1.2 + (i % 3) * 0.3), r, Math.sin(i) * 0.8)
        .fill({ color: i % 4 === 0 ? 0x2a0006 : 0xb50018, alpha: 0.38 + (i % 4) * 0.055 });
    }
    drops.addChild(g);

    const light = this.createFxLayer({ blendMode: "screen", alpha: 0.9 });
    this.drawCinematicGlowPlate(light, w * 0.46, h * 0.42, 300, 0xd60026, 0.12 + pulse * 0.05, { blur: 9, outerStrength: 1.2 });
    this.drawSoftBeam(light, -80, h * 0.72, w + 80, h * 0.18, 150, 0xffffff, 0.11 + pulse * 0.04, { blur: 1.8 });
  }

  drawToxicOozeOmen(effect, progress, timeSeconds, options = {}) {
    const accentColor = parsePixiColor(effect.accent || "#7dff4f");
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeOutCubic(Math.min(progress / 0.9, 1));
    const pulse = 0.5 + Math.sin(timeSeconds * 1.45) * 0.5;

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "screen",
        alpha: 0.08 + pulse * 0.05,
        zoomBoost: 0.022 + p * 0.012,
        panX: Math.sin(timeSeconds * 0.52) * 0.006,
        panY: Math.cos(timeSeconds * 0.44) * 0.006,
        blur: 1.2 + pulse * 0.7,
        blurQuality: 2,
      });
      const refract = this.createFxLayer({ blendMode: "normal", alpha: 0.32 + pulse * 0.08 });
      this.drawCoverSprite(options.panelTexture, refract, {
        zoom: 1.045 + (options.camera?.zoom || 1) - 1 + p * 0.01,
        panX: (options.camera?.panX || 0) + Math.sin(timeSeconds * 0.36) * 0.004,
        panY: (options.camera?.panY || 0) + Math.cos(timeSeconds * 0.32) * 0.004,
        filters: [
          this.createToxicLiquidWarpFilter(timeSeconds, 0.016 + pulse * 0.006, p),
          this.createBlurFilter(0.24 + pulse * 0.2, 2),
        ].filter(Boolean),
      });
    }

    this.drawThrillerSuspenseGrade(accentColor, { alpha: 0.76, cold: true, quiet: true });

    const vapor = this.createFxLayer({ blendMode: "screen", alpha: 0.94 });
    this.drawCinematicGlowPlate(vapor, w * 0.52, h * 0.48, 250, accentColor, 0.065 + pulse * 0.032, { blur: 13, outerStrength: 1.1 });
    this.drawVolumetricSmoke(vapor, timeSeconds, { count: 28, color: accentColor, alpha: 0.085, x: w * 0.52, y: h * 0.6, spreadX: w * 1.0, spreadY: h * 0.7, scale: 2.0, blur: 3.8, rise: 150 });
    this.drawVolumetricSmoke(vapor, timeSeconds + 3.3, { count: 14, color: 0xe9ffb0, alpha: 0.045, x: w * 0.36, y: h * 0.34, spreadX: w * 0.82, spreadY: h * 0.48, scale: 1.5, blur: 4.3, rise: 105 });

    const ooze = this.createFxLayer({ blendMode: "normal", alpha: 0.98 });
    ooze.filters = [
      this.createExternalGlowFilter({ color: accentColor, distance: 20, outerStrength: 0.95, innerStrength: 0.16, quality: 0.18 }),
      this.createBlurFilter(0.12, 2),
    ].filter(Boolean);
    const dropTexture = this.textureToxicOozeDrop();
    const coords = [
      [w * 0.92, h * 0.12, 0.82], [w * 0.18, h * 0.24, 0.68], [w * 0.82, h * 0.38, 0.62],
      [w * 0.28, h * 0.68, 0.48], [w * 0.72, h * 0.76, 0.42],
    ];
    coords.forEach(([x, baseY, scale], i) => {
      const drift = Math.sin(timeSeconds * (0.32 + i * 0.04) + i * 1.8) * (10 + scale * 8);
      const sprite = new this.pixi.Sprite(dropTexture);
      sprite.anchor.set(0.5);
      sprite.x = x + drift;
      sprite.y = baseY + Math.cos(timeSeconds * 0.24 + i) * 8;
      sprite.scale.set(0.22 * scale * (i % 2 ? 0.9 : 1), 0.28 * scale * (1 + pulse * 0.04));
      sprite.rotation = Math.sin(i * 1.1) * 0.18 + Math.sin(timeSeconds * 0.24 + i) * 0.025;
      sprite.alpha = 0.52 + (i % 2) * 0.1;
      ooze.addChild(sprite);
    });

    const g = new this.pixi.Graphics();
    const slime = this.createFillGradient({
      type: "linear",
      start: { x: 0, y: 0 },
      end: { x: 0, y: h * 0.22 },
      colorStops: [
        { offset: 0, color: "rgba(125,255,79,0.28)" },
        { offset: 0.55, color: "rgba(29,135,52,0.12)" },
        { offset: 1, color: "rgba(0,0,0,0)" },
      ],
    });
    const sideFilm = { color: accentColor, alpha: 0.045 + pulse * 0.012 };
    g.moveTo(0, h * 0.08)
      .bezierCurveTo(w * 0.07, h * 0.22, w * 0.03, h * 0.52, w * 0.08, h * 0.84)
      .lineTo(0, h)
      .closePath()
      .fill(sideFilm);
    g.moveTo(w, h * 0.04)
      .bezierCurveTo(w * 0.92, h * 0.18, w * 0.98, h * 0.5, w * 0.91, h * 0.86)
      .lineTo(w, h)
      .closePath()
      .fill(sideFilm);
    for (let i = 0; i < 8; i += 1) {
      const fromLeft = i % 2 === 0;
      const x = fromLeft ? w * (0.02 + Math.sin(i) * 0.012) : w * (0.98 + Math.sin(i) * 0.012);
      const y = h * (0.14 + i * 0.095) + Math.sin(timeSeconds * 0.38 + i) * 18;
      const reach = w * (0.08 + (i % 3) * 0.025);
      g.moveTo(x, y)
        .quadraticCurveTo(fromLeft ? x + reach : x - reach, y + 22, fromLeft ? x + reach * 0.52 : x - reach * 0.52, y + 78)
        .stroke({ color: i % 3 ? accentColor : 0xdfff83, width: 2.2 + (i % 3) * 0.8, alpha: 0.045 + pulse * 0.018 });
    }
    ooze.addChild(g);

    this.drawSoftBeam(vapor, -90, h * 0.7, w + 120, h * 0.28, 130, accentColor, 0.06 + pulse * 0.032, { blur: 3.0 });
  }

  drawHellfireAshOmen(effect, progress, timeSeconds, options = {}) {
    const accentColor = parsePixiColor(effect.accent || "#ff5a18");
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeOutCubic(Math.min(progress / 0.88, 1));
    const pulse = 0.5 + Math.sin(timeSeconds * 2.1) * 0.5;

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "screen",
        alpha: 0.14 + pulse * 0.1,
        zoomBoost: 0.026 + p * 0.018,
        panX: Math.sin(timeSeconds * 0.84) * 0.006,
        panY: -0.006 + Math.cos(timeSeconds * 0.52) * 0.006,
        blur: 0.8 + pulse * 0.8,
        blurQuality: 2,
      });
    }

    this.drawThrillerSuspenseGrade(accentColor, { alpha: 0.82, cold: false, quiet: true });

    const heat = this.createFxLayer({ blendMode: "screen", alpha: 0.98 });
    const g = new this.pixi.Graphics();
    const bottomGlow = this.createFillGradient({
      type: "linear",
      start: { x: 0, y: h },
      end: { x: 0, y: h * 0.46 },
      colorStops: [
        { offset: 0, color: "rgba(255,60,16,0.52)" },
        { offset: 0.42, color: "rgba(255,128,24,0.2)" },
        { offset: 1, color: "rgba(0,0,0,0)" },
      ],
    });
    g.rect(0, h * 0.46, w, h * 0.54).fill(bottomGlow || { color: accentColor, alpha: 0.2 });
    g.rect(0, 0, w, h).stroke({ color: 0x000000, width: 100, alpha: 0.22 });
    for (let i = 0; i < 10; i += 1) {
      const x = w * (0.04 + i * 0.11) + Math.sin(i * 2.1) * 20;
      const base = h + 24;
      const flameH = 150 + (i % 5) * 42 + pulse * 42;
      g.moveTo(x - 28, base)
        .quadraticCurveTo(x - 42, base - flameH * 0.48, x + Math.sin(timeSeconds + i) * 18, base - flameH)
        .quadraticCurveTo(x + 48, base - flameH * 0.42, x + 26, base)
        .closePath()
        .fill({ color: i % 3 ? accentColor : 0xffd45f, alpha: 0.16 + pulse * 0.08 });
    }
    heat.addChild(g);
    this.drawCinematicGlowPlate(heat, w * 0.48, h * 0.9, 320, accentColor, 0.15 + pulse * 0.05, { blur: 13, outerStrength: 1.45 });
    this.drawSoftBeam(heat, -90, h * 0.9, w + 120, h * 0.16, 170, 0xffd15f, 0.08 + pulse * 0.045, { blur: 3.0 });
    this.drawVolumetricSmoke(heat, timeSeconds, { count: 30, color: 0x5a2416, alpha: 0.1, x: w * 0.54, y: h * 0.68, spreadX: w * 1.05, spreadY: h * 0.56, scale: 2.2, blur: 3.6, rise: 260 });

    const embers = this.createFxLayer({ blendMode: "screen", alpha: 0.96 });
    const e = new this.pixi.Graphics();
    for (let i = 0; i < 82; i += 1) {
      const lane = Math.abs(Math.sin(i * 12.989));
      const x = w * (0.04 + lane * 0.92) + Math.sin(timeSeconds * 1.7 + i) * 18;
      const y = h - ((timeSeconds * (70 + (i % 7) * 18) + i * 47) % (h + 180));
      const r = 1.5 + (i % 5) * 1.2;
      const hot = i % 4 === 0;
      e.ellipse(x, y, r * (hot ? 2.2 : 1.2), r, Math.sin(i), 0, Math.PI * 2)
        .fill({ color: hot ? 0xfff1a6 : accentColor, alpha: 0.22 + (i % 5) * 0.045 });
    }
    embers.addChild(e);
  }

  drawBulletImpactGlass(effect, progress, timeSeconds, options = {}) {
    const accentColor = parsePixiColor(effect.accent || "#f5f0dc");
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeOutCubic(Math.min(progress / 0.7, 1));
    const pulse = 0.5 + Math.sin(timeSeconds * 5.4) * 0.5;
    const cx = w * (0.58 + Math.sin(timeSeconds * 0.35) * 0.012);
    const cy = h * (0.38 + Math.cos(timeSeconds * 0.3) * 0.01);

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "screen",
        alpha: 0.1 + pulse * 0.08,
        zoomBoost: 0.035 + p * 0.026,
        panX: Math.sin(timeSeconds * 18) * 0.004,
        panY: Math.cos(timeSeconds * 16) * 0.004,
        blur: 0.5 + pulse * 0.7,
        blurQuality: 2,
      });
    }

    this.drawThrillerSuspenseGrade(accentColor, { alpha: 0.7, cold: true, quiet: true });

    const glass = this.createFxLayer({ blendMode: "screen", alpha: 0.96 });
    const g = new this.pixi.Graphics();
    g.rect(0, 0, w, h).fill({ color: 0xc8f4ff, alpha: 0.035 + pulse * 0.018 });
    g.circle(cx, cy, 8 + p * 5).fill({ color: 0xffffff, alpha: 0.7 });
    g.circle(cx, cy, 22 + p * 10).stroke({ color: accentColor, width: 4, alpha: 0.24 + pulse * 0.1 });
    const crackAngles = [-2.68, -2.12, -1.52, -0.86, -0.28, 0.32, 0.92, 1.42, 2.08, 2.62];
    crackAngles.forEach((angle, i) => {
      const length = 140 + (i % 4) * 66 + p * 70;
      let x = cx;
      let y = cy;
      g.moveTo(x, y);
      for (let j = 1; j < 5; j += 1) {
        const kink = Math.sin(i * 2.4 + j * 1.7) * 0.18;
        const seg = length * (j / 4);
        const nx = cx + Math.cos(angle + kink) * seg;
        const ny = cy + Math.sin(angle + kink) * seg * 0.86;
        g.lineTo(nx, ny);
        x = nx;
        y = ny;
      }
      g.stroke({ color: i % 3 ? accentColor : 0xffffff, width: 1.6 + (i % 3) * 0.8, alpha: 0.32 + pulse * 0.1 });
      if (i % 2 === 0) {
        const branchAngle = angle + (i % 4 ? 0.38 : -0.34);
        g.moveTo(x * 0.55 + cx * 0.45, y * 0.55 + cy * 0.45)
          .lineTo(cx + Math.cos(branchAngle) * length * 0.68, cy + Math.sin(branchAngle) * length * 0.48)
          .stroke({ color: 0xffffff, width: 1.1, alpha: 0.2 + pulse * 0.06 });
      }
    });
    const facets = [
      [40, 118, 210, 212, 88, 420], [cx + 20, cy - 70, w - 34, 70, w - 112, cy + 80],
      [70, h - 260, 280, h - 332, 210, h - 88], [w - 260, h - 320, w - 44, h - 210, w - 150, h - 40],
    ];
    facets.forEach((s, i) => {
      g.moveTo(s[0], s[1]).lineTo(s[2], s[3]).lineTo(s[4], s[5]).closePath()
        .stroke({ color: i % 2 ? accentColor : 0xffffff, width: 2.2, alpha: 0.12 + pulse * 0.06 })
        .fill({ color: 0xdaf8ff, alpha: 0.028 + pulse * 0.014 });
    });
    glass.addChild(g);
    this.drawShardParticles(glass, timeSeconds, { color: accentColor, count: 42, alpha: 0.62, x: cx, y: cy, spreadX: w * 0.82, spreadY: h * 0.8, scale: 1.25 });
    this.drawCinematicDust(glass, timeSeconds, { count: 50, color: 0xffffff, alpha: 0.16, drift: 0.18 });
    this.drawSoftBeam(glass, -80, cy + 120, w + 80, cy - 48, 90, 0xffffff, 0.12 + pulse * 0.06, { blur: 1.4 });
  }

  drawBlackInkCurse(effect, progress, timeSeconds, options = {}) {
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeOutCubic(Math.min(progress / 0.9, 1));
    const pulse = 0.5 + Math.sin(timeSeconds * 1.5) * 0.5;

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "multiply",
        alpha: 0.22 + pulse * 0.08,
        zoomBoost: 0.02 + p * 0.014,
        panX: Math.sin(timeSeconds * 0.38) * 0.004,
        panY: Math.cos(timeSeconds * 0.42) * 0.005,
        blur: 1.5,
        blurQuality: 2,
      });
    }

    this.drawThrillerSuspenseGrade(0x050505, { alpha: 0.82, cold: false, quiet: true });

    const ink = this.createFxLayer({ blendMode: "normal", alpha: 0.98 });
    const g = new this.pixi.Graphics();
    g.rect(0, 0, w, h).fill({ color: 0x000000, alpha: 0.12 + pulse * 0.06 });
    g.rect(0, 0, w, h).stroke({ color: 0x000000, width: 92, alpha: 0.34 + p * 0.08 });
    for (let i = 0; i < 11; i += 1) {
      const x = w * (0.04 + i * 0.096) + Math.sin(i * 1.9) * 16;
      const len = 88 + (i % 5) * 48 + pulse * 34;
      g.moveTo(x, 0)
        .bezierCurveTo(x - 28, len * 0.32, x + 42, len * 0.66, x + Math.sin(i) * 26, len)
        .stroke({ color: 0x000000, width: 16 + (i % 4) * 8, alpha: 0.52 + pulse * 0.1 });
      g.moveTo(x - 4, 6)
        .bezierCurveTo(x - 18, len * 0.35, x + 18, len * 0.62, x + Math.sin(i) * 20, len - 12)
        .stroke({ color: 0xf2ead4, width: 2.2, alpha: 0.08 + pulse * 0.035 });
    }
    for (let i = 0; i < 8; i += 1) {
      const y = h * (0.18 + i * 0.105) + Math.sin(timeSeconds * 0.8 + i) * 20;
      const fromLeft = i % 2 === 0;
      const x1 = fromLeft ? -80 : w + 80;
      const x2 = fromLeft ? w * (0.38 + Math.sin(i) * 0.12) : w * (0.62 + Math.sin(i) * 0.12);
      g.moveTo(x1, y)
        .quadraticCurveTo(w * 0.5, y + Math.cos(i) * 80, x2, y + 58)
        .stroke({ color: 0x000000, width: 26 + (i % 3) * 12, alpha: 0.3 + pulse * 0.08 });
      g.moveTo(x1, y - 6)
        .quadraticCurveTo(w * 0.5, y + Math.cos(i) * 80 - 5, x2, y + 50)
        .stroke({ color: 0xf7f1dd, width: 2.4, alpha: 0.055 });
    }
    ink.addChild(g);

    const splatterTexture = this.textureInkSplatter();
    const splatters = [
      [w * 0.18, h * 0.28, 0.92, -0.42], [w * 0.78, h * 0.2, 0.72, 0.35],
      [w * 0.28, h * 0.73, 1.25, 0.12], [w * 0.86, h * 0.66, 0.86, -0.24],
    ];
    splatters.forEach(([x, y, scale, rotation], i) => {
      const sprite = new this.pixi.Sprite(splatterTexture);
      sprite.anchor.set(0.5);
      sprite.x = x + Math.sin(timeSeconds * 0.32 + i) * 8;
      sprite.y = y + Math.cos(timeSeconds * 0.28 + i) * 7;
      sprite.scale.set(scale * (0.9 + pulse * 0.04));
      sprite.rotation = rotation + Math.sin(timeSeconds * 0.22 + i) * 0.035;
      sprite.alpha = 0.58 + (i % 2) * 0.1;
      ink.addChild(sprite);
    });

    const paper = this.createFxLayer({ blendMode: "screen", alpha: 0.72 });
    const e = new this.pixi.Graphics();
    for (let i = 0; i < 7; i += 1) {
      const y = h * (0.16 + i * 0.12) + Math.sin(timeSeconds * 0.6 + i) * 12;
      e.moveTo(w * 0.08, y)
        .lineTo(w * 0.92, y + Math.sin(i * 1.7) * 42)
        .stroke({ color: 0xf3ead1, width: 1.5 + (i % 2), alpha: 0.04 + pulse * 0.025 });
    }
    paper.addChild(e);
    this.restoreHorrorSlitFocus(options.panelTexture, options.camera, {
      alpha: 0.42 + pulse * 0.1,
      y: h * 0.52,
      width: w * 0.68,
      height: h * 0.16,
      skew: -42 + Math.sin(timeSeconds * 0.8) * 18,
      zoomBoost: 0.024,
    });
  }

  drawThrillerProVfx(effect, progress, timeSeconds, options = {}) {
    const layout = effect.layout || "";
    const accentColor = parsePixiColor(effect.accent || "#f0d36a");
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeOutCubic(Math.min(progress / 0.9, 1));
    const pulse = 0.5 + Math.sin(timeSeconds * 2.4) * 0.5;

    if (options.panelTexture) {
      const jitter = layout.includes("chase") || layout.includes("identity") ? 0.01 : 0.004;
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: layout.includes("knife") || layout.includes("interrogation") ? "multiply" : "screen",
        alpha: layout.includes("countdown") ? 0.18 + pulse * 0.12 : 0.12 + p * 0.08,
        zoomBoost: layout.includes("chase") ? 0.055 + pulse * 0.018 : 0.022 + p * 0.018,
        panX: Math.sin(timeSeconds * 5.7) * jitter,
        panY: Math.cos(timeSeconds * 4.9) * jitter,
        blur: layout.includes("identity") ? 1.2 : 0.6,
        blurQuality: 2,
      });
    }

    this.drawThrillerSuspenseGrade(accentColor, {
      alpha: layout.includes("knife") || layout.includes("interrogation") ? 0.82 : 0.62,
      cold: layout.includes("surveillance") || layout.includes("phone") || layout.includes("identity"),
    });

    if (layout === "thriller-chase-pulse") {
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.96 });
      const g = new this.pixi.Graphics();
      const shift = (timeSeconds * 190) % 180;
      this.drawCinematicLightLeaks(layer, timeSeconds, accentColor, { count: 5, alphaBoost: 0.03 });
      for (let i = -2; i < 12; i += 1) {
        const y = i * 124 + shift;
        this.drawTaperedQuad(g, -120, y + 90, w + 140, y - 160, 4, 42 + (i % 3) * 18, i % 3 ? accentColor : 0xffffff, 0.13 + pulse * 0.055);
      }
      g.rect(0, 0, w, h).stroke({ color: 0x000000, width: 64, alpha: 0.2 + pulse * 0.08 });
      layer.addChild(g);
      this.drawNoirRain(layer, timeSeconds, { count: 78, alpha: 0.2, angle: -0.36, speed: 310 });
      this.drawShardParticles(layer, timeSeconds, { color: accentColor, count: 20, alpha: 0.48, y: h * 0.44, spreadY: h * 0.62, scale: 1.15 });
      this.restoreHorrorSlitFocus(options.panelTexture, options.camera, {
        alpha: 0.62,
        y: h * (0.47 + Math.sin(timeSeconds * 1.4) * 0.035),
        width: w * 0.78,
        height: h * 0.13,
        skew: -86,
        zoomBoost: 0.04,
      });
    } else if (layout === "thriller-surveillance-scan") {
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.9 });
      const g = new this.pixi.Graphics();
      const scanY = ((timeSeconds * 165) % (h + 180)) - 90;
      this.drawSoftBeam(layer, -40, scanY, w + 40, scanY + 18, 74, accentColor, 0.3 + pulse * 0.09, { blur: 0.6 });
      this.drawCinematicGlowPlate(layer, w * 0.64, h * 0.37, 190, accentColor, 0.075 + pulse * 0.035, { blur: 7 });
      for (let i = 0; i < 12; i += 1) {
        const y = i * h / 12 + Math.sin(timeSeconds * 2 + i) * 3;
        g.rect(0, y, w, 1.5).fill({ color: accentColor, alpha: 0.075 });
      }
      this.drawCornerBrackets(g, w * 0.12, h * 0.18, w * 0.76, h * 0.56, accentColor, 0.62 + pulse * 0.14);
      this.drawCornerBrackets(g, w * 0.23, h * 0.6, w * 0.48, h * 0.22, 0xffffff, 0.28);
      layer.addChild(g);
    } else if (layout === "thriller-evidence-pinboard") {
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.92 });
      const g = new this.pixi.Graphics();
      this.drawCinematicLightLeaks(layer, timeSeconds, 0xd23a35, { count: 3, alphaBoost: 0.02 });
      const points = [
        [w * 0.16, h * 0.24], [w * 0.7, h * 0.18], [w * 0.46, h * 0.43],
        [w * 0.82, h * 0.56], [w * 0.28, h * 0.68], [w * 0.62, h * 0.82],
      ];
      for (let i = 0; i < points.length - 1; i += 1) {
        const a = points[i];
        const b = points[(i + 2) % points.length];
        g.moveTo(a[0], a[1]).lineTo(b[0], b[1]).stroke({ color: 0xd23a35, width: 3.2, alpha: 0.34 + p * 0.18 });
      }
      points.forEach(([x, y], i) => {
        g.rect(x - 54, y - 36, 108, 72).fill({ color: 0xf1e2bf, alpha: 0.13 + (i % 2) * 0.04 });
        g.rect(x - 6, y - 6, 12, 12).fill({ color: i % 2 ? 0xffffff : accentColor, alpha: 0.72 });
      });
      layer.addChild(g);
      this.restoreHorrorSlitFocus(options.panelTexture, options.camera, { alpha: 0.5, y: h * 0.52, width: w * 0.66, height: h * 0.18, skew: 38, zoomBoost: 0.018 });
    } else if (layout === "thriller-crosshair-lock") {
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.86 });
      const g = new this.pixi.Graphics();
      const x = w * (0.5 + Math.sin(timeSeconds * 0.8) * 0.035);
      const y = h * (0.44 + Math.cos(timeSeconds * 0.7) * 0.025);
      const boxW = w * (0.48 + pulse * 0.04);
      const boxH = h * (0.28 + pulse * 0.025);
      this.drawCinematicGlowPlate(layer, x, y, 150, accentColor, 0.06 + pulse * 0.03, { blur: 5 });
      this.drawCornerBrackets(g, x - boxW / 2, y - boxH / 2, boxW, boxH, accentColor, 0.66);
      g.moveTo(x - boxW * 0.72, y).lineTo(x - boxW * 0.36, y).stroke({ color: 0xffffff, width: 3.2, alpha: 0.36 });
      g.moveTo(x + boxW * 0.36, y).lineTo(x + boxW * 0.72, y).stroke({ color: 0xffffff, width: 3.2, alpha: 0.36 });
      g.moveTo(x, y - boxH * 0.8).lineTo(x, y - boxH * 0.44).stroke({ color: 0xffffff, width: 3, alpha: 0.32 });
      g.moveTo(x, y + boxH * 0.44).lineTo(x, y + boxH * 0.8).stroke({ color: 0xffffff, width: 3, alpha: 0.32 });
      layer.addChild(g);
    } else if (layout === "thriller-knife-edge-light") {
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.96 });
      const g = new this.pixi.Graphics();
      this.drawCinematicGlowPlate(layer, w * 0.5, h * 0.48, 280, accentColor, 0.045 + pulse * 0.025, { blur: 9 });
      this.drawSoftBeam(layer, -80, h * 0.76, w + 80, h * 0.18, 108 + pulse * 44, 0xffffff, 0.34 + pulse * 0.1, { blur: 0.7 });
      this.drawSoftBeam(layer, w * 0.1, h * 0.88, w * 0.82, h * 0.12, 28, accentColor, 0.48, { blur: 0.2 });
      g.rect(0, 0, w, h).fill({ color: 0x000000, alpha: 0.24 });
      g.moveTo(w * 0.06, h * 0.78).lineTo(w * 0.88, h * 0.12).stroke({ color: 0xffffff, width: 4, alpha: 0.48 });
      layer.addChild(g);
      this.restoreHorrorSlitFocus(options.panelTexture, options.camera, { alpha: 0.54, y: h * 0.49, width: w * 0.8, height: h * 0.1, skew: -112, zoomBoost: 0.03 });
    } else if (layout === "thriller-phone-signal-trace") {
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.9 });
      const g = new this.pixi.Graphics();
      this.drawCinematicGlowPlate(layer, w * 0.62, h * 0.42, 210, accentColor, 0.075 + pulse * 0.03, { blur: 7 });
      const path = [
        [w * 0.12, h * 0.78], [w * 0.28, h * 0.64], [w * 0.46, h * 0.7],
        [w * 0.62, h * 0.42], [w * 0.84, h * 0.28],
      ];
      for (let i = 0; i < path.length - 1; i += 1) {
        const a = path[i];
        const b = path[i + 1];
        g.moveTo(a[0], a[1]).lineTo(b[0], b[1]).stroke({ color: accentColor, width: 4.2, alpha: 0.38 + p * 0.16 });
      }
      path.forEach(([x, y], i) => {
        g.rect(x - 10, y - 10, 20, 20).stroke({ color: i === path.length - 1 ? 0xffffff : accentColor, width: 2.6, alpha: 0.58 });
      });
      for (let i = 0; i < 16; i += 1) {
        g.rect((i % 4) * w * 0.25, Math.floor(i / 4) * h * 0.25, w * 0.25, h * 0.25)
          .stroke({ color: accentColor, width: 1, alpha: 0.025 });
      }
      layer.addChild(g);
    } else if (layout === "thriller-countdown-pressure") {
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.92 });
      const g = new this.pixi.Graphics();
      const tick = Math.floor(timeSeconds * 3) % 8;
      this.drawCinematicGlowPlate(layer, w * 0.5, h * 0.5, 260, accentColor, 0.055 + pulse * 0.04, { blur: 8 });
      for (let i = 0; i < 8; i += 1) {
        const active = i <= tick;
        g.rect(w * 0.12 + i * w * 0.095, h * 0.12, w * 0.055, 18 + active * 10)
          .fill({ color: active ? accentColor : 0xffffff, alpha: active ? 0.66 : 0.16 });
        g.rect(w * 0.12 + i * w * 0.095, h * 0.86, w * 0.055, 16 + active * 8)
          .fill({ color: active ? accentColor : 0xffffff, alpha: active ? 0.48 : 0.12 });
      }
      g.rect(0, 0, w, h).stroke({ color: accentColor, width: 26 + pulse * 24, alpha: 0.16 + pulse * 0.1 });
      g.rect(0, h * 0.28, w, h * 0.44).fill({ color: 0x000000, alpha: 0.14 + pulse * 0.1 });
      layer.addChild(g);
    } else if (layout === "thriller-interrogation-lamp") {
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.98 });
      const g = new this.pixi.Graphics();
      const swing = Math.sin(timeSeconds * 1.15) * 80;
      this.drawCinematicGlowPlate(layer, w * 0.42 - swing * 0.12, h * 0.48, 260, accentColor, 0.075 + pulse * 0.035, { blur: 9 });
      this.drawSoftBeam(layer, w * 0.5 + swing, -40, w * 0.38 - swing * 0.22, h * 0.78, 340, accentColor, 0.28 + pulse * 0.12, { blur: 2.2 });
      g.rect(0, 0, w, h * 0.2).fill({ color: 0x000000, alpha: 0.52 });
      g.rect(0, h * 0.76, w, h * 0.24).fill({ color: 0x000000, alpha: 0.42 });
      layer.addChild(g);
      this.drawVolumetricSmoke(layer, timeSeconds, { count: 22, color: accentColor, alpha: 0.12, x: w * 0.42, y: h * 0.55, spreadX: w * 0.72, spreadY: h * 0.42, scale: 1.8, blur: 2.4 });
      this.drawCinematicDust(layer, timeSeconds, { count: 64, color: 0xffffff, alpha: 0.2, drift: 0.36 });
      this.restoreHorrorSlitFocus(options.panelTexture, options.camera, { alpha: 0.48, y: h * 0.48, width: w * 0.58, height: h * 0.28, skew: swing * 0.22, zoomBoost: 0.02 });
    } else if (layout === "thriller-city-noir-pursuit") {
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.86 });
      const g = new this.pixi.Graphics();
      for (let i = 0; i < 5; i += 1) {
        this.drawSoftBeam(layer, w * (0.1 + i * 0.22), 0, w * (0.02 + i * 0.2), h, 170, i % 2 ? accentColor : 0xffffff, 0.08 + pulse * 0.04, { blur: 1.8 });
      }
      this.drawCinematicGlowPlate(layer, w * 0.22, h * 0.18, 210, 0xffffff, 0.045, { blur: 9 });
      g.rect(0, 0, w, h).stroke({ color: 0x000000, width: 118, alpha: 0.36 });
      layer.addChild(g);
      this.drawNoirRain(layer, timeSeconds, { count: 110, alpha: 0.24, angle: -0.18, speed: 350 });
      this.drawVolumetricSmoke(layer, timeSeconds, { count: 16, color: 0x8aa0aa, alpha: 0.08, y: h * 0.78, spreadY: h * 0.24, scale: 2.4, blur: 2.8 });
    } else if (layout === "thriller-identity-fracture") {
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.92 });
      const g = new this.pixi.Graphics();
      this.drawCinematicGlowPlate(layer, w * 0.52, h * 0.42, 240, accentColor, 0.06 + pulse * 0.03, { blur: 7 });
      const shards = [
        [80, 120, 310, 230, 120, 440], [330, 80, 610, 160, 470, 420],
        [80, 520, 360, 430, 260, 850], [410, 500, 680, 420, 590, 980],
        [130, 910, 430, 820, 350, 1220],
      ];
      shards.forEach((s, i) => {
        g.moveTo(s[0], s[1]).lineTo(s[2], s[3]).lineTo(s[4], s[5]).closePath()
          .stroke({ color: i % 2 ? accentColor : 0xffffff, width: 3.2, alpha: 0.28 + pulse * 0.08 })
          .fill({ color: i % 2 ? accentColor : 0xffffff, alpha: 0.038 + pulse * 0.02 });
      });
      for (let i = 0; i < 7; i += 1) {
        const y = h * (0.16 + i * 0.12) + Math.sin(timeSeconds * 4 + i) * 9;
        g.rect(40 + (i % 2) * 30, y, w - 80, 3).fill({ color: i % 2 ? accentColor : 0xffffff, alpha: 0.08 });
      }
      layer.addChild(g);
      this.drawShardParticles(layer, timeSeconds, { color: accentColor, count: 34, alpha: 0.56, spreadY: h * 1.05, scale: 1.35 });
      this.restoreHorrorVerticalTear(options.panelTexture, options.camera, timeSeconds, { alpha: 0.5, x: w * 0.48, width: w * 0.32, zoomBoost: 0.035 });
    } else if (layout === "thriller-crime-scene-light-sweep") {
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.98 });
      const g = new this.pixi.Graphics();
      const sweep = Math.sin(timeSeconds * 0.82) * 170;
      this.drawCinematicGlowPlate(layer, w * 0.38 + sweep * 0.16, h * 0.48, 310, accentColor, 0.07 + pulse * 0.035, { blur: 9 });
      this.drawSoftBeam(layer, w * 0.16 + sweep, -60, w * 0.48 - sweep * 0.12, h * 0.92, 330, accentColor, 0.28 + pulse * 0.1, { blur: 2.2 });
      this.drawSoftBeam(layer, w + 80 - sweep * 0.34, h * 0.06, w * 0.28, h * 0.74, 160, 0xffffff, 0.11 + pulse * 0.04, { blur: 1.6 });
      for (let i = 0; i < 7; i += 1) {
        const x = w * (0.12 + i * 0.13) + Math.sin(timeSeconds * 0.9 + i) * 12;
        const y = h * (0.68 + Math.cos(i) * 0.06);
        g.rect(x - 14, y - 9, 28, 18).stroke({ color: i % 2 ? accentColor : 0xffffff, width: 2.6, alpha: 0.24 + pulse * 0.1 });
      }
      g.rect(0, 0, w, h).stroke({ color: 0x000000, width: 126, alpha: 0.34 });
      g.rect(0, h * 0.78, w, h * 0.22).fill({ color: 0x000000, alpha: 0.24 });
      layer.addChild(g);
      this.drawVolumetricSmoke(layer, timeSeconds, { count: 18, color: accentColor, alpha: 0.075, x: w * 0.46, y: h * 0.58, spreadX: w * 0.88, spreadY: h * 0.42, scale: 2.0, blur: 2.8 });
      this.drawCinematicDust(layer, timeSeconds, { count: 70, color: 0xffffff, alpha: 0.16, drift: 0.22 });
      this.restoreHorrorSlitFocus(options.panelTexture, options.camera, { alpha: 0.5, y: h * 0.5, width: w * 0.72, height: h * 0.22, skew: sweep * 0.08, zoomBoost: 0.022 });
    } else if (layout === "thriller-police-siren-wash") {
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.98 });
      const g = new this.pixi.Graphics();
      const red = 0xff1c3f;
      const blue = 0x2d8cff;
      const sirenA = Math.pow(0.5 + Math.sin(timeSeconds * 5.8) * 0.5, 1.6);
      const sirenB = Math.pow(0.5 + Math.sin(timeSeconds * 5.8 + Math.PI) * 0.5, 1.6);
      this.drawCinematicGlowPlate(layer, w * 0.18, h * 0.24, 360, red, 0.12 + sirenA * 0.1, { blur: 11, outerStrength: 1.5 });
      this.drawCinematicGlowPlate(layer, w * 0.82, h * 0.28, 360, blue, 0.12 + sirenB * 0.1, { blur: 11, outerStrength: 1.5 });
      this.drawSoftBeam(layer, -120, h * 0.18 + sirenA * 60, w + 100, h * 0.58 - sirenA * 90, 220, red, 0.22 + sirenA * 0.18, { blur: 2.0 });
      this.drawSoftBeam(layer, w + 120, h * 0.08 + sirenB * 80, -100, h * 0.7 - sirenB * 70, 240, blue, 0.22 + sirenB * 0.18, { blur: 2.0 });
      g.rect(0, 0, w, h).fill({ color: red, alpha: sirenA * 0.06 });
      g.rect(0, 0, w, h).fill({ color: blue, alpha: sirenB * 0.07 });
      for (let i = 0; i < 9; i += 1) {
        const y = h * (0.08 + i * 0.105) + Math.sin(timeSeconds * 2 + i) * 18;
        g.rect(0, y, w, 3 + (i % 3)).fill({ color: i % 2 ? blue : red, alpha: 0.08 + (i % 3) * 0.03 });
      }
      g.rect(0, 0, w, h).stroke({ color: 0x000000, width: 82, alpha: 0.18 });
      layer.addChild(g);
      this.drawNoirRain(layer, timeSeconds, { count: 74, alpha: 0.18, angle: -0.2, speed: 300 });
    }
  }

  drawSuspenseProVfx(effect, progress, timeSeconds, options = {}) {
    const layout = effect.layout || "";
    const accentColor = parsePixiColor(effect.accent || "#f3e8c8");
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(progress, 1));
    const breath = 0.5 + Math.sin(timeSeconds * 1.22) * 0.5;

    if (options.panelTexture) {
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "multiply",
        alpha: 0.14 + breath * 0.08,
        zoomBoost: 0.018 + p * 0.012,
        panX: Math.sin(timeSeconds * 0.5) * 0.004,
        panY: Math.cos(timeSeconds * 0.46) * 0.005,
        blur: layout.includes("silence") ? 2.4 : 1.0,
        blurQuality: 2,
      });
    }

    this.drawThrillerSuspenseGrade(accentColor, { alpha: 0.72, cold: true, quiet: true });

    if (layout === "suspense-slow-door-creak") {
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.94 });
      const g = new this.pixi.Graphics();
      const open = 0.08 + p * 0.18 + breath * 0.035;
      g.rect(0, 0, w, h).fill({ color: 0x000000, alpha: 0.24 });
      this.drawCinematicGlowPlate(layer, w * 0.5, h * 0.48, 260, accentColor, 0.06 + breath * 0.035, { blur: 9 });
      this.drawSoftBeam(layer, w * (0.44 - open), 0, w * (0.5 + open), h, 150 + open * 240, accentColor, 0.3 + breath * 0.12, { blur: 1.8 });
      g.rect(0, 0, w * (0.44 - open), h).fill({ color: 0x000000, alpha: 0.56 });
      g.rect(w * (0.5 + open), 0, w, h).fill({ color: 0x000000, alpha: 0.62 });
      layer.addChild(g);
      this.drawVolumetricSmoke(layer, timeSeconds, { count: 18, color: accentColor, alpha: 0.08, x: w * 0.5, y: h * 0.56, spreadX: w * 0.36, spreadY: h * 0.75, scale: 1.7, blur: 2.4 });
      this.restoreHorrorVerticalTear(options.panelTexture, options.camera, timeSeconds, { alpha: 0.52, x: w * 0.49, width: w * (0.1 + open), zoomBoost: 0.018 });
    } else if (layout === "suspense-held-breath-vignette") {
      const layer = this.createFxLayer({ blendMode: "multiply", alpha: 0.98 });
      const g = new this.pixi.Graphics();
      g.rect(0, 0, w, h).fill({ color: 0x000000, alpha: 0.16 + breath * 0.2 });
      g.rect(0, 0, w, h).stroke({ color: 0x000000, width: 124 + breath * 72, alpha: 0.38 + breath * 0.18 });
      g.rect(0, h * (0.08 + breath * 0.08), w, 26).fill({ color: 0x000000, alpha: 0.22 });
      g.rect(0, h * (0.88 - breath * 0.08), w, 30).fill({ color: 0x000000, alpha: 0.26 });
      layer.addChild(g);
      const air = this.createFxLayer({ blendMode: "screen", alpha: 0.42 });
      this.drawCinematicDust(air, timeSeconds, { count: 56, color: accentColor, alpha: 0.14, drift: 0.18 });
    } else if (layout === "suspense-hidden-clue-glint") {
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.96 });
      const g = new this.pixi.Graphics();
      const x = w * (0.64 + Math.sin(timeSeconds * 0.7) * 0.035);
      const y = h * (0.36 + Math.cos(timeSeconds * 0.8) * 0.025);
      const flare = Math.pow(Math.max(0, Math.sin(timeSeconds * 2.8)), 5);
      this.drawCinematicGlowPlate(layer, x, y, 130, accentColor, 0.08 + flare * 0.08, { blur: 6 });
      this.drawSoftBeam(layer, x - 190, y + 26, x + 210, y - 24, 48, accentColor, 0.24 + flare * 0.26, { blur: 0.45 });
      g.moveTo(x - 74, y).lineTo(x + 74, y).stroke({ color: 0xffffff, width: 3.4, alpha: 0.32 + flare * 0.28 });
      g.moveTo(x, y - 56).lineTo(x, y + 56).stroke({ color: accentColor, width: 2.2, alpha: 0.28 + flare * 0.22 });
      this.drawCornerBrackets(g, x - 104, y - 78, 208, 156, accentColor, 0.34 + flare * 0.16);
      layer.addChild(g);
    } else if (layout === "suspense-footstep-ripple") {
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.78 });
      const g = new this.pixi.Graphics();
      this.drawCinematicGlowPlate(layer, w * 0.5, h * 0.78, 230, accentColor, 0.045 + breath * 0.035, { blur: 8 });
      for (let i = 0; i < 6; i += 1) {
        const step = (timeSeconds * 0.74 + i * 0.18) % 1;
        const y = h * (0.64 + i * 0.04);
        const x = w * (0.18 + i * 0.13);
        g.moveTo(x - 52 - step * 34, y + step * 28)
          .quadraticCurveTo(x, y - 22 - step * 20, x + 70 + step * 42, y + step * 22)
          .stroke({ color: i % 2 ? accentColor : 0xffffff, width: 3.2, alpha: 0.24 * (1 - step) });
      }
      g.rect(0, h * 0.62, w, h * 0.38).fill({ color: 0x000000, alpha: 0.18 });
      layer.addChild(g);
    } else if (layout === "suspense-curtain-shadow") {
      const layer = this.createFxLayer({ blendMode: "multiply", alpha: 0.95 });
      const g = new this.pixi.Graphics();
      const offset = Math.sin(timeSeconds * 0.6) * 22;
      for (let i = -1; i < 12; i += 1) {
        const x = i * 78 + offset;
        g.moveTo(x, 0).lineTo(x + 72, 0).lineTo(x + 18, h).lineTo(x - 58, h).closePath()
          .fill({ color: 0x000000, alpha: 0.3 + (i % 2) * 0.09 });
      }
      layer.addChild(g);
      const light = this.createFxLayer({ blendMode: "screen", alpha: 0.5 });
      this.drawSoftBeam(light, -60, h * 0.24, w + 70, h * 0.48, 240, accentColor, 0.15 + breath * 0.08, { blur: 2.4 });
      this.drawCinematicDust(light, timeSeconds, { count: 48, color: 0xffffff, alpha: 0.12, drift: 0.2 });
    } else if (layout === "suspense-silence-drop") {
      const layer = this.createFxLayer({ blendMode: "multiply", alpha: 1 });
      const g = new this.pixi.Graphics();
      g.rect(0, 0, w, h).fill({ color: 0x050608, alpha: 0.36 + p * 0.14 });
      g.rect(0, 0, w, h).stroke({ color: 0x000000, width: 150, alpha: 0.42 + breath * 0.12 });
      g.rect(w * 0.08, h * 0.49, w * 0.84, 3).fill({ color: 0xffffff, alpha: 0.07 + breath * 0.04 });
      layer.addChild(g);
    } else if (layout === "suspense-peek-through-crack") {
      const layer = this.createFxLayer({ blendMode: "multiply", alpha: 0.98 });
      const g = new this.pixi.Graphics();
      g.rect(0, 0, w, h).fill({ color: 0x000000, alpha: 0.62 });
      for (let i = 0; i < 4; i += 1) {
        const x = w * (0.48 + Math.sin(timeSeconds * 0.4 + i) * 0.025) + i * 18 - 24;
        g.moveTo(x, h * 0.08)
          .quadraticCurveTo(x - 42, h * 0.32, x + 20, h * 0.54)
          .quadraticCurveTo(x + 52, h * 0.74, x - 8, h * 0.94)
          .stroke({ color: 0x000000, width: 22 + i * 6, alpha: 0.5 });
      }
      layer.addChild(g);
      const light = this.createFxLayer({ blendMode: "screen", alpha: 0.78 });
      this.drawSoftBeam(light, w * 0.42, 0, w * 0.56, h, 126, accentColor, 0.22 + breath * 0.08, { blur: 1.8 });
      this.drawCinematicDust(light, timeSeconds, { count: 38, color: accentColor, alpha: 0.14, drift: 0.16 });
      this.restoreHorrorVerticalTear(options.panelTexture, options.camera, timeSeconds, { alpha: 0.68, x: w * 0.5, width: w * 0.22, zoomBoost: 0.03 });
    } else if (layout === "suspense-clock-tension") {
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.82 });
      const g = new this.pixi.Graphics();
      const cx = w * 0.5;
      const cy = h * 0.47;
      this.drawCinematicGlowPlate(layer, cx, cy, 250, accentColor, 0.055 + breath * 0.035, { blur: 8 });
      for (let i = 0; i < 12; i += 1) {
        const a = -Math.PI / 2 + i * Math.PI / 6;
        const len = i % 3 === 0 ? 54 : 30;
        g.moveTo(cx + Math.cos(a) * (210 - len), cy + Math.sin(a) * (210 - len))
          .lineTo(cx + Math.cos(a) * 210, cy + Math.sin(a) * 210)
          .stroke({ color: i % 3 === 0 ? accentColor : 0xffffff, width: 3.2, alpha: 0.22 + breath * 0.08 });
      }
      const hand = -Math.PI / 2 + timeSeconds * 1.7;
      g.moveTo(cx, cy).lineTo(cx + Math.cos(hand) * 205, cy + Math.sin(hand) * 205)
        .stroke({ color: accentColor, width: 5, alpha: 0.42 });
      g.rect(0, h * 0.18, w, 3).fill({ color: accentColor, alpha: 0.1 + breath * 0.06 });
      g.rect(0, h * 0.82, w, 3).fill({ color: accentColor, alpha: 0.1 + breath * 0.06 });
      layer.addChild(g);
    } else if (layout === "suspense-dust-in-light") {
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.94 });
      this.drawCinematicGlowPlate(layer, w * 0.34, h * 0.54, 330, accentColor, 0.055 + breath * 0.025, { blur: 10 });
      this.drawSoftBeam(layer, -100, h * 0.1, w * 0.66, h * 0.94, 340, accentColor, 0.24 + breath * 0.08, { blur: 3.0 });
      this.drawSoftBeam(layer, w * 0.86, -40, w * 0.22, h, 220, 0xffffff, 0.12 + breath * 0.05, { blur: 2.8 });
      this.drawCinematicDust(layer, timeSeconds, { count: 112, color: accentColor, alpha: 0.26, drift: 0.28 });
      this.drawVolumetricSmoke(layer, timeSeconds, { count: 16, color: accentColor, alpha: 0.075, x: w * 0.38, y: h * 0.58, spreadX: w * 0.55, spreadY: h * 0.7, scale: 2.0, blur: 2.8 });
    } else if (layout === "suspense-unseen-watcher") {
      const shade = this.createFxLayer({ blendMode: "multiply", alpha: 0.98 });
      const g = new this.pixi.Graphics();
      g.rect(0, 0, w, h).fill({ color: 0x000000, alpha: 0.16 });
      g.moveTo(w * 0.72, 0).lineTo(w, 0).lineTo(w, h).lineTo(w * 0.58, h).closePath()
        .fill({ color: 0x000000, alpha: 0.58 + breath * 0.12 });
      g.moveTo(0, h * 0.18).lineTo(w * 0.24, h * 0.08).lineTo(w * 0.1, h).lineTo(0, h).closePath()
        .fill({ color: 0x000000, alpha: 0.34 });
      shade.addChild(g);
      const edge = this.createFxLayer({ blendMode: "screen", alpha: 0.55 });
      const e = new this.pixi.Graphics();
      this.drawCinematicGlowPlate(edge, w * 0.76, h * 0.42, 220, accentColor, 0.045 + breath * 0.03, { blur: 8 });
      e.moveTo(w * 0.71, h * 0.08).lineTo(w * 0.6, h * 0.92).stroke({ color: accentColor, width: 4.2, alpha: 0.22 + breath * 0.08 });
      e.rect(w * 0.78, h * 0.34, 42, 6).fill({ color: 0xffffff, alpha: 0.12 + breath * 0.08 });
      edge.addChild(e);
    } else if (layout === "suspense-fog-bank") {
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.98 });
      const g = new this.pixi.Graphics();
      const cold = 0x9fc6d4;
      this.drawCinematicGlowPlate(layer, w * 0.48, h * 0.42, 360, accentColor, 0.05 + breath * 0.035, { blur: 12 });
      this.drawSoftBeam(layer, -120, h * 0.16, w * 0.72, h * 0.62, 330, accentColor, 0.12 + breath * 0.07, { blur: 3.2 });
      this.drawVolumetricSmoke(layer, timeSeconds, { count: 42, color: cold, alpha: 0.16, x: w * 0.5, y: h * 0.66, spreadX: w * 1.35, spreadY: h * 0.84, scale: 2.8, blur: 3.6, rise: 260 });
      this.drawVolumetricSmoke(layer, timeSeconds + 4.2, { count: 26, color: 0xffffff, alpha: 0.09, x: w * 0.48, y: h * 0.42, spreadX: w * 1.05, spreadY: h * 0.52, scale: 2.1, blur: 4.2, rise: 190 });
      g.rect(0, 0, w, h).fill({ color: cold, alpha: 0.05 + breath * 0.025 });
      g.rect(0, 0, w, h).stroke({ color: 0x000000, width: 96, alpha: 0.22 });
      for (let i = 0; i < 5; i += 1) {
        const y = h * (0.18 + i * 0.18) + Math.sin(timeSeconds * 0.46 + i) * 24;
        g.rect(0, y, w, 22 + i * 8).fill({ color: 0xffffff, alpha: 0.022 + breath * 0.014 });
      }
      layer.addChild(g);
      this.restoreHorrorVerticalTear(options.panelTexture, options.camera, timeSeconds, { alpha: 0.36, x: w * 0.53, width: w * 0.38, zoomBoost: 0.016 });
    }
  }

  drawThrillerSuspenseGrade(accentColor, options = {}) {
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const layer = this.createFxLayer({ blendMode: "multiply", alpha: options.alpha ?? 0.68 });
    const g = new this.pixi.Graphics();
    const gradient = this.createFillGradient({
      type: "linear",
      start: { x: 0, y: 0 },
      end: { x: 1, y: 1 },
      colorStops: [
        { offset: 0, color: options.cold ? "rgba(3,8,14,0.34)" : "rgba(6,4,2,0.26)" },
        { offset: 0.48, color: "rgba(0,0,0,0.04)" },
        { offset: 1, color: "rgba(0,0,0,0.42)" },
      ],
    });
    g.rect(0, 0, w, h).fill(gradient || { color: 0x020406, alpha: 0.18 });
    g.rect(0, 0, w, h).stroke({ color: 0x000000, width: options.quiet ? 92 : 70, alpha: options.quiet ? 0.24 : 0.18 });
    layer.addChild(g);

    const wash = this.createFxLayer({ blendMode: "screen", alpha: options.quiet ? 0.28 : 0.38 });
    const wG = new this.pixi.Graphics();
    const color = `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},0.10)`;
    const glow = this.createFillGradient({
      type: "radial",
      center: { x: 0.62, y: 0.34 },
      innerRadius: 0.02,
      outerCenter: { x: 0.5, y: 0.5 },
      outerRadius: 0.72,
      colorStops: [
        { offset: 0, color },
        { offset: 0.48, color: "rgba(255,255,255,0.03)" },
        { offset: 1, color: "rgba(255,255,255,0)" },
      ],
    });
    wG.rect(0, 0, w, h).fill(glow || { color: accentColor, alpha: 0.035 });
    wash.addChild(wG);
  }

  drawCornerBrackets(graphics, x, y, width, height, color, alpha = 0.35) {
    const len = Math.min(width, height) * 0.18;
    const lineWidth = 3;
    graphics.moveTo(x, y + len).lineTo(x, y).lineTo(x + len, y).stroke({ color, width: lineWidth, alpha });
    graphics.moveTo(x + width - len, y).lineTo(x + width, y).lineTo(x + width, y + len).stroke({ color, width: lineWidth, alpha });
    graphics.moveTo(x + width, y + height - len).lineTo(x + width, y + height).lineTo(x + width - len, y + height).stroke({ color, width: lineWidth, alpha });
    graphics.moveTo(x + len, y + height).lineTo(x, y + height).lineTo(x, y + height - len).stroke({ color, width: lineWidth, alpha });
  }

  drawNoirRain(parent, timeSeconds, options = {}) {
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const g = new this.pixi.Graphics();
    const count = options.count || 48;
    const angle = options.angle ?? -0.24;
    const speed = options.speed || 220;
    const alpha = options.alpha ?? 0.12;
    for (let i = 0; i < count; i += 1) {
      const seed = Math.sin(i * 47.13) * 10000;
      const x = ((Math.abs(seed) % 1) * (w + 240)) - 120 + Math.sin(i) * 24;
      const y = ((timeSeconds * speed + i * 97) % (h + 220)) - 120;
      const len = 60 + (i % 5) * 24;
      g.moveTo(x, y)
        .lineTo(x + Math.sin(angle) * len, y + Math.cos(angle) * len)
        .stroke({ color: i % 4 === 0 ? 0xffffff : 0x9fb8c7, width: 1.4 + (i % 3) * 0.4, alpha: alpha * (0.6 + (i % 4) * 0.12) });
    }
    parent.addChild(g);
  }

  drawCinematicDust(parent, timeSeconds, options = {}) {
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const g = new this.pixi.Graphics();
    const count = options.count || 40;
    const color = options.color || 0xffffff;
    const alpha = options.alpha || 0.14;
    const drift = options.drift || 0.25;
    for (let i = 0; i < count; i += 1) {
      const x = (Math.abs(Math.sin(i * 19.31)) * w + Math.sin(timeSeconds * drift + i) * 34) % w;
      const y = (Math.abs(Math.cos(i * 23.17)) * h + timeSeconds * (8 + (i % 5) * 3)) % h;
      const size = 1.3 + (i % 4) * 0.9;
      g.circle(x, y, size).fill({ color, alpha: alpha * (0.25 + (i % 5) * 0.14) });
    }
    parent.addChild(g);
  }

  drawVolumetricSmoke(parent, timeSeconds, options = {}) {
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const texture = this.textureSmokeParticle();
    const color = options.color || 0xb8c0c4;
    const count = options.count || 24;
    const alpha = options.alpha ?? 0.16;
    const layer = new this.pixi.Container();
    layer.blendMode = options.blendMode || "screen";
    layer.alpha = options.layerAlpha ?? 1;
    const blur = this.createBlurFilter(options.blur ?? 1.8, 3);
    if (blur) layer.filters = [blur];
    parent.addChild(layer);
    for (let i = 0; i < count; i += 1) {
      const sprite = new this.pixi.Sprite(texture);
      const lane = i / Math.max(1, count - 1);
      const seedX = Math.abs(Math.sin(i * 17.17));
      const seedY = Math.abs(Math.cos(i * 13.91));
      sprite.anchor.set(0.5);
      sprite.x = (options.x ?? w * 0.5) + (seedX - 0.5) * (options.spreadX ?? w * 1.05) + Math.sin(timeSeconds * 0.28 + i) * 44;
      sprite.y = (options.y ?? h * 0.58) + (seedY - 0.5) * (options.spreadY ?? h * 0.72) - ((timeSeconds * (10 + (i % 5) * 3) + i * 29) % (options.rise ?? 180));
      const scale = (options.scale ?? 2.1) * (0.52 + lane * 0.9);
      sprite.scale.set(scale * (1.2 + Math.sin(timeSeconds * 0.33 + i) * 0.12), scale * (0.72 + Math.cos(timeSeconds * 0.27 + i) * 0.08));
      sprite.rotation = Math.sin(timeSeconds * 0.18 + i) * 0.55;
      sprite.tint = i % 5 === 0 ? 0xffffff : color;
      sprite.alpha = alpha * (0.38 + seedY * 0.75);
      layer.addChild(sprite);
    }
  }

  drawToxicBubbleEmitter(parent, timeSeconds, options = {}) {
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const texture = this.textureToxicBubble();
    const count = options.count || 44;
    const color = options.color || 0x9dff52;
    const layer = new this.pixi.Container();
    layer.blendMode = options.blendMode || "screen";
    layer.alpha = options.alpha ?? 0.86;
    const blur = this.createBlurFilter(options.blur ?? 0.45, 2);
    const glow = this.createExternalGlowFilter({ color, distance: 14, outerStrength: 0.8, innerStrength: 0.18, quality: 0.18 });
    layer.filters = [blur, glow].filter(Boolean);
    parent.addChild(layer);

    for (let i = 0; i < count; i += 1) {
      const seedX = Math.abs(Math.sin(i * 31.17));
      const seedY = Math.abs(Math.cos(i * 27.43));
      const rise = (timeSeconds * (26 + (i % 7) * 8) + i * 37) % (h + 180);
      const sprite = new this.pixi.Sprite(texture);
      sprite.anchor.set(0.5);
      sprite.x = (options.x ?? w * 0.5) + (seedX - 0.5) * (options.spreadX ?? w * 1.02) + Math.sin(timeSeconds * 0.72 + i) * (10 + (i % 4) * 3);
      sprite.y = (options.y ?? h * 0.78) + seedY * (options.spreadY ?? h * 0.28) - rise;
      const scale = (options.scale ?? 1) * (0.16 + (i % 6) * 0.055 + seedY * 0.18);
      sprite.scale.set(scale * (1 + Math.sin(timeSeconds * 0.9 + i) * 0.08), scale * (0.9 + Math.cos(timeSeconds * 0.8 + i) * 0.07));
      sprite.rotation = Math.sin(timeSeconds * 0.5 + i) * 0.25;
      sprite.tint = i % 5 === 0 ? 0xf4ffd2 : color;
      sprite.alpha = 0.22 + seedY * 0.5;
      layer.addChild(sprite);
    }
  }

  drawShardParticles(parent, timeSeconds, options = {}) {
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const texture = this.textureShardParticle();
    const color = options.color || 0xffffff;
    const count = options.count || 18;
    const layer = new this.pixi.Container();
    layer.blendMode = "screen";
    layer.alpha = options.alpha ?? 0.72;
    parent.addChild(layer);
    for (let i = 0; i < count; i += 1) {
      const sprite = new this.pixi.Sprite(texture);
      const seed = Math.abs(Math.sin(i * 43.71));
      const drift = (timeSeconds * (34 + (i % 7) * 7) + i * 29) % (w + 260);
      sprite.anchor.set(0.5);
      sprite.x = (options.x ?? w * 0.5) - w * 0.45 + drift;
      sprite.y = (options.y ?? h * 0.5) + (seed - 0.5) * (options.spreadY ?? h * 0.88) + Math.sin(timeSeconds * 0.8 + i) * 22;
      const scale = options.scale ?? 1;
      sprite.scale.set(scale * (0.42 + (i % 5) * 0.15), scale * (0.5 + (i % 3) * 0.12));
      sprite.rotation = -0.82 + seed * 1.64 + timeSeconds * (0.08 + (i % 4) * 0.025);
      sprite.tint = i % 4 === 0 ? 0xffffff : color;
      sprite.alpha = 0.12 + seed * 0.2;
      layer.addChild(sprite);
    }
  }

  drawCinematicGlowPlate(parent, x, y, radius, color, alpha = 0.14, options = {}) {
    const layer = new this.pixi.Container();
    layer.blendMode = options.blendMode || "screen";
    const filters = [];
    const blur = this.createBlurFilter(options.blur ?? 5.5, options.quality || 4);
    if (blur) filters.push(blur);
    const glow = this.createExternalGlowFilter({
      color,
      distance: options.glowDistance ?? 18,
      outerStrength: options.outerStrength ?? 0.8,
      innerStrength: options.innerStrength ?? 0.18,
      quality: 0.2,
    });
    if (glow) filters.push(glow);
    if (filters.length) layer.filters = filters;
    const g = new this.pixi.Graphics();
    g.circle(x, y, radius).fill({ color, alpha });
    g.circle(x, y, radius * 0.55).fill({ color: 0xffffff, alpha: alpha * 0.35 });
    layer.addChild(g);
    parent.addChild(layer);
    return layer;
  }

  drawCinematicLightLeaks(parent, timeSeconds, accentColor, options = {}) {
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const count = options.count || 4;
    for (let i = 0; i < count; i += 1) {
      const y = h * (0.16 + i * 0.18) + Math.sin(timeSeconds * 0.72 + i) * 34;
      const fromLeft = i % 2 === 0;
      const x1 = fromLeft ? -120 : w + 120;
      const x2 = fromLeft ? w * (0.62 + i * 0.08) : w * (0.36 - i * 0.04);
      this.drawSoftBeam(parent, x1, y, x2, y + Math.sin(i * 1.7) * 130, 90 + i * 36, i % 2 ? accentColor : 0xffffff, 0.07 + (options.alphaBoost || 0), { blur: 2.2 });
    }
  }

  drawPetalFallProVfx(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ff9fcf";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const focus = { x: w * 0.5, y: h * 0.48, rx: w * 0.36, ry: h * 0.32 };
    const breath = 0.5 + Math.sin(timeSeconds * 0.72) * 0.5;

    this.drawPanelEcho(options.panelTexture, options.camera, {
      blendMode: "screen",
      alpha: 0.10 + breath * 0.035,
      zoomBoost: 0.018,
      blur: 2.8,
      blurQuality: 3,
    });

    const atmosphere = this.createFxLayer({ blendMode: "screen", alpha: 0.72 });
    const wash = new this.pixi.Graphics();
    const sideGlow = this.createFillGradient({
      type: "linear",
      start: { x: 0, y: 0.18 },
      end: { x: 1, y: 0.82 },
      colorStops: [
        { offset: 0, color: "rgba(255,158,216,0.13)" },
        { offset: 0.42, color: "rgba(255,255,255,0.035)" },
        { offset: 1, color: "rgba(126,176,255,0.10)" },
      ],
    });
    wash.rect(0, 0, w, h).fill(sideGlow || { color: accentColor, alpha: 0.06 });
    for (let i = 0; i < 5; i += 1) {
      const x = w * (0.12 + i * 0.19) + Math.sin(timeSeconds * 0.42 + i) * 12;
      wash.rect(x, 0, 24 + i * 5, h).fill({ color: i % 2 ? 0xffffff : accentColor, alpha: 0.018 + breath * 0.012 });
    }
    atmosphere.addChild(wash);

    const petals = this.createFxLayer({ blendMode: "screen" });
    const g = new this.pixi.Graphics();
    for (let i = 0; i < 28; i += 1) {
      const depth = (i % 7) / 6;
      const speed = 20 + depth * 48;
      const x = -70 + ((i * 89 + timeSeconds * speed) % (w + 140));
      const y = -90 + ((i * 157 + timeSeconds * (34 + depth * 58)) % (h + 180));
      const sway = Math.sin(timeSeconds * (0.82 + depth * 0.5) + i) * (16 + depth * 28);
      const nearFocus = Math.abs(x - focus.x) < focus.rx * 0.92 && Math.abs(y - focus.y) < focus.ry * 0.86;
      const farEdge = x < w * 0.16 || x > w * 0.84 || y < h * 0.16 || y > h * 0.86;
      const alpha = nearFocus ? 0.028 + depth * 0.025 : farEdge ? 0.12 + depth * 0.12 : 0.07 + depth * 0.07;
      const petalW = 3.5 + depth * 6.2;
      const petalH = 9 + depth * 18;
      g.ellipse(x + sway, y, petalW, petalH, Math.sin(timeSeconds * 0.8 + i) * 0.8)
        .fill({ color: i % 8 === 0 ? 0xffffff : accentColor, alpha });
    }
    petals.addChild(g);

    const depthLayer = this.createFxLayer({ blendMode: "multiply", alpha: 0.5 });
    const vignette = new this.pixi.Graphics();
    vignette.rect(0, 0, w, 120).fill({ color: 0x05030b, alpha: 0.08 });
    vignette.rect(0, h - 170, w, 170).fill({ color: 0x05030b, alpha: 0.10 });
    vignette.rect(0, 0, 50, h).fill({ color: 0x05030b, alpha: 0.08 });
    vignette.rect(w - 50, 0, 50, h).fill({ color: 0x05030b, alpha: 0.08 });
    depthLayer.addChild(vignette);
  }

  drawPageFlipProTransition(textureA, textureB, transition, progress, timeSeconds, context = {}) {
    const p = easeInOutCubic(Math.min(progress, 1));
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const foldPulse = Math.sin(p * Math.PI);
    const accent = transition.accent || "#d8c28a";
    const accentColor = parsePixiColor(accent);

    this.drawCoverSprite(textureA, this.root, {
      zoom: 1.06 + foldPulse * 0.015,
      panX: -p * 0.08,
      rotation: -p * 0.012,
      alpha: 1 - p * 0.42,
    });

    const nextLayer = new this.pixi.Container();
    this.root.addChild(nextLayer);
    this.drawCoverSprite(textureB, nextLayer, this.transitionIncomingOptions({
      zoom: 1.12 - p * 0.045,
      panX: 0.08 * (1 - p),
      rotation: 0.008 * (1 - p),
      alpha: Math.min(1, p * 1.34),
    }, p, context));

    const pageShadow = new this.pixi.Graphics();
    pageShadow.rect(0, 0, w, h)
      .fill({ color: 0x000000, alpha: 0.08 + foldPulse * 0.18 });
    this.root.addChild(pageShadow);

    const pageLayer = this.createFxLayer({ blendMode: "normal" });
    const page = new this.pixi.Graphics();
    const curlX = lerp(w + 120, -120, p);
    const foldWidth = 180 + foldPulse * 190;
    page.moveTo(curlX, 0)
      .quadraticCurveTo(curlX - foldWidth * 0.55, h * 0.32, curlX - foldWidth * 0.22, h)
      .lineTo(curlX + foldWidth, h)
      .quadraticCurveTo(curlX + foldWidth * 0.38, h * 0.48, curlX + foldWidth * 0.82, 0)
      .closePath()
      .fill({ color: 0xf7f2df, alpha: 0.82 })
      .stroke({ color: 0x1a140e, width: 2, alpha: 0.2 });
    pageLayer.addChild(page);

    const shadow = new this.pixi.Graphics();
    shadow.rect(curlX - 54, 0, 92, h).fill({ color: 0x000000, alpha: 0.16 + foldPulse * 0.22 });
    shadow.rect(curlX + foldWidth * 0.43, 0, 38, h).fill({ color: 0xffffff, alpha: 0.1 + foldPulse * 0.1 });
    shadow.moveTo(curlX + 10, 0).lineTo(curlX - foldWidth * 0.16, h)
      .stroke({ color: accentColor, width: 3, alpha: 0.18 + foldPulse * 0.2 });
    this.root.addChild(shadow);

    const pageEdge = new this.pixi.Graphics();
    pageEdge.moveTo(curlX - foldWidth * 0.08, 0)
      .quadraticCurveTo(curlX - foldWidth * 0.42, h * 0.45, curlX - foldWidth * 0.2, h)
      .stroke({ color: 0xffffff, width: 5, alpha: 0.28 + foldPulse * 0.18 });
    pageEdge.moveTo(curlX + foldWidth * 0.66, 0)
      .quadraticCurveTo(curlX + foldWidth * 0.32, h * 0.5, curlX + foldWidth * 0.72, h)
      .stroke({ color: 0x000000, width: 4, alpha: 0.1 + foldPulse * 0.12 });
    this.root.addChild(pageEdge);

    const paperLines = new this.pixi.Graphics();
    for (let i = 0; i < 10; i += 1) {
      const y = 90 + i * 118 + Math.sin(timeSeconds + i) * 4;
      paperLines.moveTo(curlX - foldWidth * 0.15, y)
        .lineTo(curlX + foldWidth * 0.56, y + 18)
        .stroke({ color: i % 2 ? 0x000000 : 0xffffff, width: 1, alpha: 0.04 + foldPulse * 0.025 });
    }
    this.root.addChild(paperLines);
    this.drawPaperGrain(accent, 0.07);
  }

  drawImpactFreezePunchProVfx(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ffe95c";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = Math.min(Math.max(progress, 0), 1);
    const strike = Math.max(0, 1 - Math.min(p / 0.18, 1));
    const freezeHold = p > 0.08 && p < 0.42 ? 1 : Math.max(0, 1 - Math.abs(p - 0.25) * 5.2);
    const release = Math.sin(Math.min(Math.max((p - 0.28) / 0.54, 0), 1) * Math.PI);
    const aftershock = Math.max(0, Math.sin(p * Math.PI * 5.2)) * Math.max(0, 1 - p * 0.95);
    const pressure = Math.max(strike, freezeHold * 0.72, aftershock * 0.55);
    const jitter = pressure * (0.7 + Math.sin(timeSeconds * 48) * 0.3);
    const focus = {
      x: w * (0.5 + Math.sin(timeSeconds * 0.9) * 0.01 + Math.sin(timeSeconds * 34) * strike * 0.018),
      y: h * (0.455 + Math.cos(timeSeconds * 0.8) * 0.008 + Math.cos(timeSeconds * 29) * strike * 0.012),
      rx: w * (0.30 + release * 0.025),
      ry: h * (0.235 + release * 0.018),
    };

    const chroma = this.createChromaticPulseFilter(timeSeconds, 0.004 + strike * 0.018 + aftershock * 0.008);
    const heat = this.createHeatWaveFilter(timeSeconds, 0.002 + strike * 0.006 + release * 0.004);
    const snapBlur = this.createBlurFilter(0.25 + strike * 1.1, 2);

    this.drawPanelEcho(options.panelTexture, options.camera, {
      blendMode: "screen",
      alpha: 0.075 + pressure * 0.12,
      zoomBoost: 0.055 + strike * 0.09,
      panX: 0.034 + Math.sin(timeSeconds * 38) * jitter * 0.012,
      panY: -0.026 + Math.cos(timeSeconds * 32) * jitter * 0.01,
      rotation: 0.006 * pressure,
      blur: 1.8 + pressure * 2.8,
      blurQuality: 3,
    });
    this.drawPanelEcho(options.panelTexture, options.camera, {
      blendMode: "multiply",
      alpha: 0.075 + pressure * 0.055,
      zoomBoost: -0.022,
      panX: -0.026 - Math.sin(timeSeconds * 31) * jitter * 0.01,
      panY: 0.018 + Math.cos(timeSeconds * 27) * jitter * 0.008,
      rotation: -0.007 * pressure,
      blur: 0.55,
    });

    if (options.panelTexture) {
      const snapLayer = this.createFxLayer({ blendMode: "normal", alpha: 0.1 + pressure * 0.16 });
      this.drawCoverSprite(options.panelTexture, snapLayer, {
        zoom: 1.17 + (options.camera?.zoom || 1) - 1 + strike * 0.11,
        panX: (options.camera?.panX || 0) + Math.sin(timeSeconds * 42) * strike * 0.014,
        panY: (options.camera?.panY || 0) + Math.cos(timeSeconds * 39) * strike * 0.011,
        rotation: (options.camera?.rotation || 0) + Math.sin(timeSeconds * 36) * strike * 0.007,
        filters: [chroma, heat, snapBlur].filter(Boolean),
      });
    }

    const gradeLayer = this.createFxLayer({ blendMode: "multiply", alpha: 0.56 });
    const grade = new this.pixi.Graphics();
    grade.rect(0, 0, w, h).fill({ color: 0x050407, alpha: 0.012 + freezeHold * 0.028 });
    grade.rect(0, 0, w, 96 + pressure * 22).fill({ color: 0x020205, alpha: 0.08 + pressure * 0.055 });
    grade.rect(0, h - 112 - pressure * 28, w, 112 + pressure * 28).fill({ color: 0x020205, alpha: 0.09 + pressure * 0.065 });
    grade.rect(0, 0, w, h).stroke({ color: 0x020205, width: 52 + pressure * 24, alpha: 0.07 + pressure * 0.045 });
    gradeLayer.addChild(grade);

    const freezeLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.64 });
    freezeLayer.filters = [this.createBlurFilter(0.65 + pressure * 0.8, 3)].filter(Boolean);
    const flash = new this.pixi.Graphics();
    const flashAlpha = Math.max(0, 0.18 - p * 0.55) + Math.max(0, 1 - Math.abs(p - 0.11) * 13) * 0.08;
    flash.rect(0, 0, w, h).fill({ color: 0xffffff, alpha: flashAlpha });
    const freezeWash = this.createFillGradient({
      type: "radial",
      center: { x: focus.x / w, y: focus.y / h },
      innerRadius: 0.05,
      outerCenter: { x: 0.5, y: 0.5 },
      outerRadius: 0.9,
      colorStops: [
        { offset: 0, color: "rgba(255,255,255,0.07)" },
        { offset: 0.36, color: `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},0.035)` },
        { offset: 1, color: "rgba(255,255,255,0)" },
      ],
    });
    flash.moveTo(focus.x - focus.rx * (0.86 + release * 0.24), focus.y - focus.ry * (0.54 + release * 0.14))
      .lineTo(focus.x + focus.rx * (0.88 + release * 0.28), focus.y - focus.ry * (0.72 + release * 0.12))
      .lineTo(focus.x + focus.rx * (0.7 + release * 0.22), focus.y + focus.ry * (0.58 + release * 0.16))
      .lineTo(focus.x - focus.rx * (0.98 + release * 0.22), focus.y + focus.ry * (0.74 + release * 0.12))
      .closePath()
      .fill(freezeWash || { color: accentColor, alpha: 0.045 + pressure * 0.035 });
    freezeLayer.addChild(flash);

    const pressureLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.52 });
    pressureLayer.filters = [this.createBlurFilter(0.35 + pressure * 0.55, 2)].filter(Boolean);
    const rings = new this.pixi.Graphics();
    const wave = easeOutCubic(Math.min(p / 0.64, 1));
    for (let i = 0; i < 6; i += 1) {
      const ring = 0.46 + i * 0.22 + wave * 0.74;
      const alpha = Math.max(0, 0.09 - i * 0.012) + pressure * 0.035;
      const left = focus.x - focus.rx * ring * 1.05;
      const right = focus.x + focus.rx * ring * 1.08;
      const top = focus.y - focus.ry * ring * 0.62;
      const bottom = focus.y + focus.ry * ring * 0.68;
      rings.moveTo(left, focus.y - focus.ry * 0.08)
        .lineTo(focus.x - focus.rx * 0.2, top)
        .lineTo(right, focus.y - focus.ry * 0.18)
        .stroke({ color: i % 2 ? accentColor : 0xffffff, width: i === 0 ? 7 : 3 + (i % 3), alpha });
      rings.moveTo(left + focus.rx * 0.12, focus.y + focus.ry * 0.18)
        .lineTo(focus.x + focus.rx * 0.1, bottom)
        .lineTo(right - focus.rx * 0.08, focus.y + focus.ry * 0.1)
        .stroke({ color: i % 2 ? 0xffffff : accentColor, width: i === 0 ? 5 : 2.5 + (i % 3), alpha: alpha * 0.82 });
    }
    for (let i = 0; i < 34; i += 1) {
      if (i % 7 === 3) continue;
      const angle = -Math.PI * 0.92 + (i / 33) * Math.PI * 1.84 + Math.sin(i + timeSeconds * 0.4) * 0.02;
      const lane = i % 2 ? -1 : 1;
      const inner = 120 + (i % 5) * 18 + wave * 46;
      const outer = 540 + (i % 8) * 42 + pressure * 110;
      const x1 = focus.x + Math.cos(angle) * inner;
      const y1 = focus.y + Math.sin(angle) * inner * 0.68;
      const x2 = focus.x + Math.cos(angle + lane * 0.018) * outer;
      const y2 = focus.y + Math.sin(angle + lane * 0.018) * outer * 0.72;
      this.drawTaperedQuad(
        rings,
        x1,
        y1,
        x2,
        y2,
        1.1 + strike * 2.4,
        7 + (i % 5) * 3 + pressure * 8,
        i % 4 === 0 ? 0xffffff : accentColor,
        0.026 + pressure * 0.055 + (i % 4 === 0 ? 0.024 : 0),
      );
    }
    pressureLayer.addChild(rings);

    const fractureLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.44 });
    fractureLayer.filters = [this.createBlurFilter(0.45, 2)].filter(Boolean);
    const fractures = new this.pixi.Graphics();
    const crackAlpha = 0.05 + freezeHold * 0.08 + aftershock * 0.035;
    for (let i = 0; i < 18; i += 1) {
      const side = i % 2 ? -1 : 1;
      const baseAngle = (i / 18) * Math.PI * 2 + Math.sin(i) * 0.2;
      const start = 90 + (i % 5) * 24;
      const len = 84 + (i % 4) * 38 + pressure * 48;
      const x1 = focus.x + Math.cos(baseAngle) * start;
      const y1 = focus.y + Math.sin(baseAngle) * start * 0.68;
      const midX = x1 + Math.cos(baseAngle + side * 0.18) * len * 0.54;
      const midY = y1 + Math.sin(baseAngle + side * 0.18) * len * 0.34;
      const x2 = x1 + Math.cos(baseAngle + side * 0.08) * len;
      const y2 = y1 + Math.sin(baseAngle + side * 0.08) * len * 0.58;
      fractures.moveTo(x1, y1)
        .lineTo(midX, midY)
        .lineTo(x2, y2)
        .stroke({ color: i % 4 === 0 ? accentColor : 0xffffff, width: i % 5 === 0 ? 4 : 2, alpha: crackAlpha });
    }
    fractureLayer.addChild(fractures);

    const shutterLayer = this.createFxLayer({ blendMode: "normal" });
    const shutter = new this.pixi.Graphics();
    const shutterAlpha = 0.1 + freezeHold * 0.07 + strike * 0.035;
    shutter.rect(0, 0, w, 58 + pressure * 24).fill({ color: 0x020205, alpha: shutterAlpha });
    shutter.rect(0, h - 72 - pressure * 30, w, 72 + pressure * 30).fill({ color: 0x020205, alpha: shutterAlpha + 0.02 });
    shutter.moveTo(0, h * 0.18)
      .lineTo(w * 0.28, h * 0.11)
      .lineTo(w * 0.24, h * 0.15)
      .lineTo(0, h * 0.22)
      .closePath()
      .fill({ color: 0xffffff, alpha: 0.024 + pressure * 0.03 });
    shutter.moveTo(w, h * 0.78)
      .lineTo(w * 0.69, h * 0.89)
      .lineTo(w * 0.73, h * 0.83)
      .lineTo(w, h * 0.72)
      .closePath()
      .fill({ color: 0xffffff, alpha: 0.022 + pressure * 0.026 });
    shutterLayer.addChild(shutter);

    const debrisLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.42 });
    const debris = new this.pixi.Graphics();
    for (let i = 0; i < 44; i += 1) {
      const angle = (i / 44) * Math.PI * 2 + Math.sin(i) * 0.18;
      const dist = 110 + ((i * 43 + timeSeconds * (70 + release * 130)) % 450);
      const x = focus.x + Math.cos(angle) * dist;
      const y = focus.y + Math.sin(angle) * dist * 0.68;
      const size = 1.5 + (i % 5) * 1.4 + pressure * 2;
      debris.circle(x, y, size).fill({ color: i % 5 === 0 ? 0xffffff : accentColor, alpha: 0.032 + release * 0.04 + pressure * 0.024 });
    }
    debrisLayer.addChild(debris);

    if (options.panelTexture) {
      const clarityLayer = this.createFxLayer({ blendMode: "normal", alpha: 0.12 + pressure * 0.08 });
      this.drawCoverSprite(options.panelTexture, clarityLayer, {
        zoom: 1.2 + (options.camera?.zoom || 1) - 1 + strike * 0.1,
        panX: (options.camera?.panX || 0) + Math.sin(timeSeconds * 40) * strike * 0.01,
        panY: (options.camera?.panY || 0) + Math.cos(timeSeconds * 36) * strike * 0.008,
        rotation: (options.camera?.rotation || 0) + Math.sin(timeSeconds * 32) * strike * 0.006,
        filters: [chroma, heat, this.createBlurFilter(1.0 + pressure * 0.8, 3)].filter(Boolean),
      });
      const clarityMask = new this.pixi.Graphics();
      clarityMask.moveTo(w * 0.12, h * 0.27)
        .lineTo(w * 0.88, h * 0.17)
        .lineTo(w * 0.95, h * 0.38)
        .lineTo(w * 0.78, h * 0.68)
        .lineTo(w * 0.16, h * 0.75)
        .lineTo(w * 0.05, h * 0.48)
        .closePath()
        .fill(0xffffff);
      clarityLayer.mask = clarityMask;
      this.root.addChild(clarityMask);
    }
  }

  drawEyeShockZoomProVfx(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ff3458";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = Math.min(Math.max(progress, 0), 1);
    const snap = Math.max(0, 1 - Math.min(p / 0.2, 1));
    const hold = 0.55 + Math.sin(Math.min(p * 1.2, 1) * Math.PI) * 0.45;
    const tremor = (0.35 + snap * 0.95) * (0.65 + Math.sin(timeSeconds * 42) * 0.35);
    const bandCenter = h * (0.425 + Math.sin(timeSeconds * 0.8) * 0.014 + Math.sin(timeSeconds * 31) * snap * 0.006);
    const bandHeight = h * (0.31 + snap * 0.04 + Math.sin(timeSeconds * 5.5) * 0.006);
    const bandTopLeft = bandCenter - bandHeight * 0.55;
    const bandTopRight = bandCenter - bandHeight * 0.68;
    const bandBottomRight = bandCenter + bandHeight * 0.58;
    const bandBottomLeft = bandCenter + bandHeight * 0.72;

    this.drawPanelEcho(options.panelTexture, options.camera, {
      blendMode: "multiply",
      alpha: 0.18 + snap * 0.14,
      zoomBoost: -0.018,
      panX: -0.026 - Math.sin(timeSeconds * 24) * tremor * 0.007,
      panY: 0.018 + Math.cos(timeSeconds * 19) * tremor * 0.006,
      rotation: -0.004 * tremor,
      blur: 0.8 + snap * 1.1,
    });
    this.drawPanelEcho(options.panelTexture, options.camera, {
      blendMode: "screen",
      alpha: 0.12 + snap * 0.16,
      zoomBoost: 0.05 + snap * 0.05,
      panX: 0.03 + Math.sin(timeSeconds * 35) * tremor * 0.008,
      panY: -0.02 + Math.cos(timeSeconds * 29) * tremor * 0.006,
      rotation: 0.005 * tremor,
      blur: 1.4 + snap * 1.6,
      blurQuality: 3,
    });

    if (options.panelTexture) {
      const closeLayer = this.createFxLayer({ blendMode: "normal", alpha: 0.72 + snap * 0.12 });
      const chroma = this.createChromaticPulseFilter(timeSeconds, 0.004 + snap * 0.013);
      const heat = this.createHeatWaveFilter(timeSeconds, 0.0015 + snap * 0.004);
      const blur = this.createBlurFilter(0.12 + snap * 0.55, 2);
      this.drawCoverSprite(options.panelTexture, closeLayer, {
        zoom: 1.38 + (options.camera?.zoom || 1) - 1 + snap * 0.14,
        panX: (options.camera?.panX || 0) + Math.sin(timeSeconds * 38) * tremor * 0.009,
        panY: (options.camera?.panY || 0) - 0.035 + Math.cos(timeSeconds * 33) * tremor * 0.008,
        rotation: (options.camera?.rotation || 0) + Math.sin(timeSeconds * 30) * tremor * 0.005,
        filters: [chroma, heat, blur].filter(Boolean),
      });
      const mask = new this.pixi.Graphics();
      mask.moveTo(12, bandTopLeft - h * 0.018)
        .lineTo(w - 12, bandTopRight - h * 0.018)
        .lineTo(w - 26, bandBottomRight + h * 0.018)
        .lineTo(18, bandBottomLeft + h * 0.018)
        .closePath()
        .fill(0xffffff);
      closeLayer.mask = mask;
      this.root.addChild(mask);
    }

    const gradeLayer = this.createFxLayer({ blendMode: "multiply", alpha: 0.96 });
    const grade = new this.pixi.Graphics();
    grade.rect(0, 0, w, h).fill({ color: 0x020205, alpha: 0.05 + snap * 0.06 });
    grade.rect(0, 0, w, bandTopLeft - 8).fill({ color: 0x010103, alpha: 0.5 + snap * 0.1 });
    grade.rect(0, bandBottomLeft + 8, w, h - bandBottomLeft).fill({ color: 0x010103, alpha: 0.54 + snap * 0.1 });
    grade.rect(0, 0, 42 + snap * 20, h).fill({ color: 0x010103, alpha: 0.36 + snap * 0.1 });
    grade.rect(w - 42 - snap * 20, 0, 42 + snap * 20, h).fill({ color: 0x010103, alpha: 0.36 + snap * 0.1 });
    gradeLayer.addChild(grade);

    const shutterLayer = this.createFxLayer({ blendMode: "normal", alpha: 0.98 });
    const shutter = new this.pixi.Graphics();
    shutter.moveTo(0, bandTopLeft - 20)
      .lineTo(w, bandTopRight - 10)
      .lineTo(w, bandTopRight + 8)
      .lineTo(0, bandTopLeft + 18)
      .closePath()
      .fill({ color: 0xffffff, alpha: 0.055 + snap * 0.055 });
    shutter.moveTo(0, bandBottomLeft - 4)
      .lineTo(w, bandBottomRight - 14)
      .lineTo(w, bandBottomRight + 10)
      .lineTo(0, bandBottomLeft + 20)
      .closePath()
      .fill({ color: 0xffffff, alpha: 0.045 + snap * 0.055 });
    shutter.moveTo(0, bandTopLeft - 2)
      .lineTo(w, bandTopRight - 12)
      .stroke({ color: 0x000000, width: 12, alpha: 0.46 });
    shutter.moveTo(0, bandBottomLeft + 2)
      .lineTo(w, bandBottomRight - 6)
      .stroke({ color: 0x000000, width: 14, alpha: 0.5 });
    shutter.moveTo(0, bandTopLeft + 2)
      .lineTo(w, bandTopRight - 10)
      .stroke({ color: 0xffffff, width: 2.5, alpha: 0.22 + snap * 0.16 });
    shutter.moveTo(0, bandBottomLeft - 2)
      .lineTo(w, bandBottomRight - 10)
      .stroke({ color: accentColor, width: 2.2, alpha: 0.16 + snap * 0.13 });
    shutterLayer.addChild(shutter);

    const traceLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.82 });
    const traces = new this.pixi.Graphics();
    const speed = (timeSeconds * 80) % 160;
    for (let i = 0; i < 36; i += 1) {
      const lane = i / 35;
      const side = i % 2 ? -1 : 1;
      const y = bandCenter + (lane - 0.5) * bandHeight * 1.95 + Math.sin(timeSeconds * 4 + i) * 11;
      const x1 = side > 0 ? -150 - (speed + i * 17) % 120 : w + 150 + (speed + i * 19) % 120;
      const x2 = side > 0 ? w * (0.42 + (i % 7) * 0.055) : w * (0.58 - (i % 7) * 0.055);
      const y2 = bandCenter + (y - bandCenter) * 0.2 + side * (i % 5) * 3;
      const alpha = (i % 5 === 0 ? 0.095 : 0.045) + snap * 0.052 + hold * 0.018;
      this.drawTaperedQuad(
        traces,
        x1,
        y,
        x2,
        y2,
        i % 5 === 0 ? 11 : 4 + (i % 4) * 1.6,
        0.8,
        i % 6 === 0 ? accentColor : 0xffffff,
        alpha,
      );
    }
    for (let i = 0; i < 16; i += 1) {
      const x = (i * 47 + timeSeconds * 55) % (w + 160) - 80;
      const y = bandCenter + Math.sin(i * 1.7 + timeSeconds * 2) * bandHeight * 0.5;
      traces.moveTo(x - 20, y + (i % 2 ? -9 : 9))
        .lineTo(x + 28, y + (i % 2 ? 4 : -4))
        .stroke({ color: i % 4 === 0 ? accentColor : 0xffffff, width: i % 4 === 0 ? 2.4 : 1.3, alpha: 0.075 + snap * 0.055 });
    }
    traceLayer.addChild(traces);

    const inkLayer = this.createFxLayer({ blendMode: "multiply", alpha: 0.56 });
    const ink = new this.pixi.Graphics();
    for (let i = 0; i < 18; i += 1) {
      const y = bandCenter + Math.sin(i * 2.4) * bandHeight * 0.72;
      const x = (i % 2 ? w + 50 : -50);
      const endX = w * (0.5 + Math.sin(i * 1.3) * 0.38);
      const endY = bandCenter + Math.cos(i * 1.9) * bandHeight * 0.3;
      this.drawTaperedQuad(ink, x, y, endX, endY, 14 + (i % 4) * 7, 1.2, 0x000000, 0.048 + snap * 0.045);
    }
    inkLayer.addChild(ink);

    const flashLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.78 });
    const flash = new this.pixi.Graphics();
    const flashAlpha = Math.max(0, 0.16 - p * 0.58) + Math.max(0, 1 - Math.abs(p - 0.1) * 16) * 0.1;
    flash.rect(0, bandTopLeft - 4, w, bandHeight * 1.18).fill({ color: 0xffffff, alpha: flashAlpha });
    flash.moveTo(w * 0.12, bandCenter - bandHeight * 0.42)
      .lineTo(w * 0.84, bandCenter - bandHeight * 0.58)
      .stroke({ color: 0xffffff, width: 2.4, alpha: 0.22 + snap * 0.16 });
    flash.moveTo(w * 0.2, bandCenter + bandHeight * 0.36)
      .lineTo(w * 0.92, bandCenter + bandHeight * 0.2)
      .stroke({ color: accentColor, width: 2.2, alpha: 0.2 + snap * 0.14 });
    flashLayer.addChild(flash);

    this.drawParticleBurst({
      x: w * 0.5 + Math.sin(timeSeconds * 30) * snap * 12,
      y: bandCenter,
      accent,
      count: 34,
      progress: Math.min(1, 0.55 + p * 0.45),
      timeSeconds,
      radius: 230 + snap * 90,
      verticalScale: 0.25,
    });
  }

  drawAfterimageDashProVfx(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#9efcff";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = Math.min(Math.max(progress, 0), 1);
    const dash = Math.sin(Math.min(p / 0.9, 1) * Math.PI);
    const snap = Math.max(0, 1 - Math.min(p / 0.2, 1));
    const glide = easeInOutCubic(Math.min(p, 1));
    const direction = p < 0.5 ? 1 : -1;
    const drift = Math.sin(timeSeconds * 34) * (0.35 + snap * 0.65);

    if (options.panelTexture) {
      for (let i = 0; i < 5; i += 1) {
        const lane = i - 2;
        const offset = direction * (72 + i * 42 + dash * 46);
        const ghostLayer = this.createFxLayer({
          blendMode: i % 2 ? "screen" : "normal",
          alpha: (0.085 - i * 0.011) * (0.34 + dash * 0.26),
        });
        const filters = [
          this.createBlurFilter(4.2 + i * 1.1 + dash * 3.2, 4),
          this.createChromaticPulseFilter(timeSeconds + i * 0.12, 0.0015 + dash * 0.0035),
        ].filter(Boolean);
        this.drawCoverSprite(options.panelTexture, ghostLayer, {
          zoom: 1.14 + (options.camera?.zoom || 1) - 1 + i * 0.012 + dash * 0.035,
          panX: (options.camera?.panX || 0) + offset / w + Math.sin(timeSeconds * 21 + i) * dash * 0.006,
          panY: (options.camera?.panY || 0) + lane * 0.012 + Math.cos(timeSeconds * 17 + i) * dash * 0.004,
          rotation: (options.camera?.rotation || 0) + direction * (0.006 + i * 0.002) + drift * 0.004,
          filters,
        });
      }

      for (let i = 0; i < 6; i += 1) {
        const sliceLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.045 + dash * 0.035 });
        const y = h * (0.2 + i * 0.125) + Math.sin(timeSeconds * 3 + i) * 12;
        const sliceHeight = 34 + (i % 3) * 18;
        const panShift = direction * (0.06 + i * 0.018 + dash * 0.035);
        this.drawCoverSprite(options.panelTexture, sliceLayer, {
          zoom: 1.12 + (options.camera?.zoom || 1) - 1 + dash * 0.04,
          panX: (options.camera?.panX || 0) + panShift,
          panY: (options.camera?.panY || 0),
          rotation: (options.camera?.rotation || 0) + direction * 0.004,
          filters: [this.createBlurFilter(2.2 + dash * 2.4, 3)].filter(Boolean),
        });
        const mask = new this.pixi.Graphics();
        mask.moveTo(-20, y)
          .lineTo(w + 20, y - 18)
          .lineTo(w + 10, y + sliceHeight)
          .lineTo(-10, y + sliceHeight + 18)
          .closePath()
          .fill(0xffffff);
        sliceLayer.mask = mask;
        this.root.addChild(mask);
      }
    }

    const hazeLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.38 });
    hazeLayer.filters = [this.createBlurFilter(0.9 + dash * 0.6, 3)].filter(Boolean);
    const haze = new this.pixi.Graphics();
    const bandGradient = this.createFillGradient({
      type: "linear",
      start: { x: direction > 0 ? 0 : 1, y: 0.5 },
      end: { x: direction > 0 ? 1 : 0, y: 0.5 },
      colorStops: [
        { offset: 0, color: `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},0)` },
        { offset: 0.5, color: `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},${0.045 + dash * 0.035})` },
        { offset: 1, color: "rgba(255,255,255,0)" },
      ],
    });
    for (let i = 0; i < 7; i += 1) {
      const y = h * (0.18 + i * 0.12) + Math.sin(timeSeconds * 2.1 + i) * 18;
      haze.moveTo(direction > 0 ? -90 : w + 90, y - 44)
        .lineTo(direction > 0 ? w * (0.76 + (i % 2) * 0.1) : w * (0.24 - (i % 2) * 0.1), y - 10)
        .lineTo(direction > 0 ? w * (0.86 + (i % 2) * 0.08) : w * (0.14 - (i % 2) * 0.08), y + 42)
        .lineTo(direction > 0 ? -120 : w + 120, y + 18)
        .closePath()
        .fill(bandGradient || { color: accentColor, alpha: 0.026 + dash * 0.034 });
    }
    hazeLayer.addChild(haze);

    const speedLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.42 });
    speedLayer.filters = [this.createBlurFilter(0.35 + dash * 0.35, 2)].filter(Boolean);
    const speed = new this.pixi.Graphics();
    const travel = (timeSeconds * 260) % 360;
    for (let i = 0; i < 54; i += 1) {
      const y = h * ((i * 37) % 1000 / 1000) + Math.sin(i * 1.8 + timeSeconds * 5) * 12;
      const base = direction > 0 ? -220 + ((i * 53 + travel) % 360) : w + 220 - ((i * 47 + travel) % 360);
      const len = 170 + (i % 9) * 32 + dash * 130;
      const x1 = base;
      const x2 = base + direction * len;
      const width = i % 8 === 0 ? 8 + dash * 5 : 1.8 + (i % 4) * 0.75;
      this.drawTaperedQuad(
        speed,
        x1,
        y,
        x2,
        y - direction * (8 + (i % 5) * 5),
        width,
        0.9,
        i % 7 === 0 ? accentColor : 0xffffff,
        (i % 7 === 0 ? 0.045 : 0.026) + dash * 0.024,
      );
    }
    speedLayer.addChild(speed);

    const inkLayer = this.createFxLayer({ blendMode: "multiply", alpha: 0.28 });
    inkLayer.filters = [this.createBlurFilter(0.6 + dash * 0.5, 2)].filter(Boolean);
    const ink = new this.pixi.Graphics();
    for (let i = 0; i < 16; i += 1) {
      const y = h * (0.08 + i * 0.062) + Math.sin(i * 2.6 + timeSeconds * 3.4) * 15;
      const x1 = direction > 0 ? -80 : w + 80;
      const x2 = direction > 0 ? w * (0.28 + (i % 5) * 0.12) : w * (0.72 - (i % 5) * 0.12);
      this.drawTaperedQuad(ink, x1, y + 22, x2, y - 18, 12 + (i % 4) * 4, 1.2, 0x000000, 0.022 + dash * 0.018);
    }
    inkLayer.addChild(ink);

    const flashLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.46 });
    const flash = new this.pixi.Graphics();
    const xFlash = lerp(direction > 0 ? w * 0.22 : w * 0.78, direction > 0 ? w * 0.72 : w * 0.28, glide);
    this.drawTaperedQuad(
      flash,
      xFlash - direction * 300,
      h * 0.46 + Math.sin(timeSeconds * 9) * 12,
      xFlash + direction * 320,
      h * 0.36 + Math.cos(timeSeconds * 8) * 10,
      6 + dash * 18,
      28 + snap * 22,
      0xffffff,
      0.045 + dash * 0.075,
    );
    this.drawTaperedQuad(
      flash,
      xFlash - direction * 250,
      h * 0.56,
      xFlash + direction * 280,
      h * 0.5,
      3 + dash * 8,
      14 + snap * 14,
      accentColor,
      0.04 + dash * 0.06,
    );
    flash.rect(0, 0, w, h).fill({ color: 0xffffff, alpha: Math.max(0, 0.08 - p * 0.28) });
    flashLayer.addChild(flash);

    this.drawParticleBurst({
      x: xFlash,
      y: h * 0.48,
      accent,
      count: 24,
      progress: Math.min(1, 0.48 + dash * 0.52),
      timeSeconds,
      radius: 270 + dash * 110,
      verticalScale: 0.42,
    });
  }

  drawInkFlashImpactProVfx(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ffffff";
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = Math.min(Math.max(progress, 0), 1);
    const snap = Math.max(0, 1 - Math.min(p / 0.18, 1));
    const inkHold = Math.max(0, 1 - Math.abs(p - 0.28) * 3.2);
    const reveal = Math.sin(Math.min(Math.max((p - 0.18) / 0.62, 0), 1) * Math.PI);
    const flicker = Math.max(0, Math.sin(timeSeconds * 38)) * (0.35 + snap * 0.65);

    this.drawPanelEcho(options.panelTexture, options.camera, {
      blendMode: "multiply",
      alpha: 0.13 + inkHold * 0.11,
      zoomBoost: -0.02,
      panX: -0.018 + Math.sin(timeSeconds * 19) * snap * 0.008,
      panY: 0.016 + Math.cos(timeSeconds * 17) * snap * 0.006,
      blur: 0.65 + inkHold * 0.9,
    });

    if (options.panelTexture) {
      const starkLayer = this.createFxLayer({ blendMode: "normal", alpha: 0.1 + inkHold * 0.16 + snap * 0.1 });
      const filters = [
        this.createChromaticPulseFilter(timeSeconds, 0.001 + snap * 0.004),
        this.createBlurFilter(1.15 + snap * 0.8, 3),
      ].filter(Boolean);
      this.drawCoverSprite(options.panelTexture, starkLayer, {
        zoom: 1.14 + (options.camera?.zoom || 1) - 1 + snap * 0.055,
        panX: (options.camera?.panX || 0) + Math.sin(timeSeconds * 36) * snap * 0.012,
        panY: (options.camera?.panY || 0) + Math.cos(timeSeconds * 33) * snap * 0.009,
        rotation: (options.camera?.rotation || 0) + Math.sin(timeSeconds * 29) * snap * 0.006,
        filters,
      });
      const mask = new this.pixi.Graphics();
      const left = lerp(-w * 0.12, w * 0.12, reveal);
      const right = lerp(w * 1.12, w * 0.88, reveal);
      mask.moveTo(left, h * 0.08)
        .lineTo(right, h * 0.0)
        .lineTo(w * 0.98, h * 0.72)
        .lineTo(w * 0.62, h * 0.98)
        .lineTo(w * 0.04, h * 0.88)
        .lineTo(w * 0.16, h * 0.28)
        .closePath()
        .fill(0xffffff);
      starkLayer.mask = mask;
      this.root.addChild(mask);
    }

    const exposureLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.72 });
    const exposure = new this.pixi.Graphics();
    exposure.rect(0, 0, w, h).fill({ color: 0xffffff, alpha: Math.max(0, 0.36 - p * 1.22) + flicker * 0.035 });
    for (let i = 0; i < 5; i += 1) {
      const y = h * (0.12 + i * 0.18) + Math.sin(timeSeconds * 4 + i) * 18;
      this.drawTaperedQuad(
        exposure,
        -90,
        y + 74,
        w + 120,
        y - 110,
        12 + i * 6 + snap * 14,
        52 + (i % 3) * 18,
        0xffffff,
        0.045 + inkHold * 0.06 + snap * 0.07,
      );
    }
    exposureLayer.addChild(exposure);

    const blackLayer = this.createFxLayer({ blendMode: "multiply", alpha: 0.68 });
    blackLayer.filters = [this.createBlurFilter(0.75 + inkHold * 0.9, 3)].filter(Boolean);
    const black = new this.pixi.Graphics();
    black.rect(0, 0, w, h).fill({ color: 0x020203, alpha: 0.045 + inkHold * 0.09 });
    const wipe = easeOutCubic(Math.min(p / 0.52, 1));
    [
      { x1: -110, y1: h * 0.12, x2: w * 0.78, y2: h * 0.02, start: 96, end: 34, alpha: 0.15 },
      { x1: w + 100, y1: h * 0.22, x2: w * 0.2, y2: h * 0.46, start: 68, end: 120, alpha: 0.13 },
      { x1: -120, y1: h * 0.78, x2: w * 0.86, y2: h * 0.56, start: 130, end: 40, alpha: 0.16 },
      { x1: w * 0.2, y1: h + 90, x2: w * 0.78, y2: h * 0.18, start: 64, end: 24, alpha: 0.11 },
      { x1: w + 70, y1: h * 0.9, x2: -70, y2: h * 0.7, start: 90, end: 36, alpha: 0.1 },
    ].forEach((stroke, index) => {
      const offset = Math.sin(timeSeconds * (2.4 + index * 0.3) + index) * 18;
      this.drawTaperedQuad(
        black,
        lerp(stroke.x1, stroke.x2, Math.max(0, wipe - 0.18)) + offset,
        stroke.y1,
        stroke.x2 + offset * 0.3,
        stroke.y2,
        stroke.start * (0.48 + wipe * 0.32),
        stroke.end * (0.56 + inkHold * 0.22),
        0x000000,
        stroke.alpha * 0.52 + inkHold * 0.055 + snap * 0.035,
      );
    });
    for (let i = 0; i < 42; i += 1) {
      const x = ((i * 97 + timeSeconds * 120) % (w + 120)) - 60;
      const y = ((i * 151 + timeSeconds * 70) % (h + 120)) - 60;
      const size = 4 + (i % 8) * 5 + inkHold * 9;
      const sx = size * (1.1 + (i % 3) * 0.5);
      const sy = size * (0.6 + (i % 5) * 0.35);
      black.ellipse(x, y, sx, sy).fill({ color: 0x000000, alpha: 0.02 + inkHold * 0.048 + (i % 7 === 0 ? snap * 0.035 : 0) });
    }
    blackLayer.addChild(black);

    const paperLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.52 });
    const paper = new this.pixi.Graphics();
    for (let i = 0; i < 18; i += 1) {
      const y = h * ((i * 61) % 1000 / 1000);
      paper.moveTo(0, y + Math.sin(timeSeconds + i) * 4)
        .lineTo(w, y - 12 + Math.cos(timeSeconds + i) * 4)
        .stroke({ color: 0xffffff, width: i % 5 === 0 ? 2 : 1, alpha: 0.035 + inkHold * 0.04 });
    }
    for (let i = 0; i < 22; i += 1) {
      const x = ((i * 73 + timeSeconds * 38) % (w + 80)) - 40;
      const y = ((i * 137 + timeSeconds * 54) % (h + 80)) - 40;
      paper.rect(x, y, 1 + (i % 4), 18 + (i % 5) * 11).fill({ color: 0xffffff, alpha: 0.025 + reveal * 0.045 });
    }
    paperLayer.addChild(paper);

    const snapLayer = this.createFxLayer({ blendMode: "normal", alpha: 0.58 });
    const snapMarks = new this.pixi.Graphics();
    const notch = Math.max(snap, Math.sin(Math.min(p / 0.34, 1) * Math.PI) * 0.34);
    snapMarks.rect(0, 0, w, 64 + notch * 28).fill({ color: 0x020205, alpha: 0.13 + notch * 0.07 });
    snapMarks.rect(0, h - 82 - notch * 28, w, 82 + notch * 28).fill({ color: 0x020205, alpha: 0.15 + notch * 0.075 });
    snapMarks.moveTo(0, h * 0.34)
      .lineTo(w * 0.42, h * 0.25)
      .lineTo(w * 0.34, h * 0.3)
      .lineTo(0, h * 0.42)
      .closePath()
      .fill({ color: 0xffffff, alpha: 0.045 + snap * 0.045 });
    snapMarks.moveTo(w, h * 0.62)
      .lineTo(w * 0.55, h * 0.74)
      .lineTo(w * 0.62, h * 0.66)
      .lineTo(w, h * 0.54)
      .closePath()
      .fill({ color: 0xffffff, alpha: 0.04 + snap * 0.04 });
    snapLayer.addChild(snapMarks);

    this.drawParticleBurst({
      x: w * 0.52 + Math.sin(timeSeconds * 28) * snap * 16,
      y: h * 0.48,
      accent,
      count: 20,
      progress: Math.min(1, 0.42 + inkHold * 0.58),
      timeSeconds,
      radius: 230 + inkHold * 120,
      verticalScale: 0.48,
    });
  }

  drawPanelSmashBurstProVfx(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ffef6a";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = Math.min(Math.max(progress, 0), 1);
    const hit = Math.max(0, 1 - Math.min(p / 0.18, 1));
    const breakOut = easeOutCubic(Math.min(p / 0.72, 1));
    const recoil = Math.sin(Math.min(Math.max((p - 0.08) / 0.78, 0), 1) * Math.PI);
    const jitter = hit * (0.65 + Math.sin(timeSeconds * 42) * 0.35);

    this.drawPanelEcho(options.panelTexture, options.camera, {
      blendMode: "multiply",
      alpha: 0.14 + recoil * 0.12,
      zoomBoost: -0.025,
      panX: -0.024 - Math.sin(timeSeconds * 25) * jitter * 0.008,
      panY: 0.018 + Math.cos(timeSeconds * 21) * jitter * 0.006,
      rotation: -0.008,
      blur: 0.7 + recoil * 0.9,
    });
    this.drawPanelEcho(options.panelTexture, options.camera, {
      blendMode: "screen",
      alpha: 0.08 + hit * 0.1 + recoil * 0.045,
      zoomBoost: 0.062 + hit * 0.05,
      panX: 0.034 + Math.sin(timeSeconds * 34) * jitter * 0.01,
      panY: -0.028 + Math.cos(timeSeconds * 31) * jitter * 0.008,
      rotation: 0.01,
      blur: 1.8 + hit * 1.4,
      blurQuality: 3,
    });

    if (options.panelTexture) {
      const pieces = [
        { pts: [[0.06, 0.12], [0.48, 0.05], [0.42, 0.34], [0.12, 0.42]], dx: -0.08, dy: -0.06, rot: -0.018 },
        { pts: [[0.5, 0.04], [0.94, 0.12], [0.82, 0.42], [0.42, 0.34]], dx: 0.08, dy: -0.05, rot: 0.02 },
        { pts: [[0.1, 0.43], [0.42, 0.34], [0.5, 0.62], [0.04, 0.74]], dx: -0.06, dy: 0.02, rot: -0.01 },
        { pts: [[0.42, 0.34], [0.82, 0.42], [0.76, 0.78], [0.5, 0.62]], dx: 0.04, dy: 0.03, rot: 0.014 },
        { pts: [[0.04, 0.74], [0.5, 0.62], [0.46, 0.96], [0.1, 0.9]], dx: -0.04, dy: 0.07, rot: 0.014 },
        { pts: [[0.5, 0.62], [0.76, 0.78], [0.92, 0.9], [0.46, 0.96]], dx: 0.08, dy: 0.06, rot: -0.018 },
      ];
      pieces.forEach((piece, index) => {
        const layer = this.createFxLayer({ blendMode: index % 2 ? "screen" : "normal", alpha: 0.2 + breakOut * 0.1 });
        this.drawCoverSprite(options.panelTexture, layer, {
          zoom: 1.12 + (options.camera?.zoom || 1) - 1 + hit * 0.06,
          panX: (options.camera?.panX || 0) + piece.dx * breakOut + Math.sin(timeSeconds * 30 + index) * hit * 0.006,
          panY: (options.camera?.panY || 0) + piece.dy * breakOut + Math.cos(timeSeconds * 27 + index) * hit * 0.005,
          rotation: (options.camera?.rotation || 0) + piece.rot * breakOut + Math.sin(timeSeconds * 20 + index) * hit * 0.003,
          filters: [
            this.createChromaticPulseFilter(timeSeconds + index * 0.08, 0.001 + hit * 0.0035),
            this.createBlurFilter(1.15 + breakOut * 1.25, 4),
          ].filter(Boolean),
        });
        const mask = new this.pixi.Graphics();
        piece.pts.forEach(([x, y], i) => {
          const px = x * w;
          const py = y * h;
          if (i === 0) mask.moveTo(px, py);
          else mask.lineTo(px, py);
        });
        mask.closePath().fill(0xffffff);
        layer.mask = mask;
        this.root.addChild(mask);
      });
    }

    const frameLayer = this.createFxLayer({ blendMode: "normal", alpha: 0.96 });
    const frame = new this.pixi.Graphics();
    const pad = 22;
    frame.rect(pad, pad, w - pad * 2, h - pad * 2).stroke({ color: 0x000000, width: 18 + hit * 8, alpha: 0.48 + hit * 0.16 });
    frame.rect(pad + 6, pad + 6, w - (pad + 6) * 2, h - (pad + 6) * 2).stroke({ color: 0xffffff, width: 3.5, alpha: 0.22 + hit * 0.14 });
    frame.rect(pad + 12, pad + 12, w - (pad + 12) * 2, h - (pad + 12) * 2).stroke({ color: accentColor, width: 2.4, alpha: 0.16 + recoil * 0.12 });
    frameLayer.addChild(frame);

    const crackLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.68 });
    const cracks = new this.pixi.Graphics();
    const anchors = [
      [w * 0.5, h * 0.04],
      [w * 0.94, h * 0.38],
      [w * 0.74, h * 0.82],
      [w * 0.16, h * 0.72],
      [w * 0.08, h * 0.32],
    ];
    anchors.forEach(([x, y], index) => {
      for (let j = 0; j < 4; j += 1) {
        const angle = -Math.PI + index * 0.72 + j * 0.34 + Math.sin(index + j) * 0.16;
        const len = 70 + j * 42 + breakOut * 120;
        const midX = x + Math.cos(angle + 0.18) * len * 0.46;
        const midY = y + Math.sin(angle + 0.18) * len * 0.38;
        const endX = x + Math.cos(angle) * len;
        const endY = y + Math.sin(angle) * len * 0.86;
        cracks.moveTo(x, y)
          .lineTo(midX, midY)
          .lineTo(endX, endY)
          .stroke({ color: j % 2 ? accentColor : 0xffffff, width: j === 0 ? 3 : 1.6 + (j % 2), alpha: 0.07 + breakOut * 0.08 + hit * 0.045 });
      }
    });
    for (let i = 0; i < 26; i += 1) {
      const side = i % 4;
      const t = (i % 7) / 6;
      const x = side === 0 ? pad : side === 1 ? w - pad : lerp(pad, w - pad, t);
      const y = side === 2 ? pad : side === 3 ? h - pad : lerp(pad, h - pad, t);
      const dx = (x < w * 0.5 ? -1 : 1) * (28 + (i % 5) * 18 + breakOut * 40);
      const dy = (y < h * 0.5 ? -1 : 1) * (24 + (i % 4) * 16 + breakOut * 36);
      cracks.moveTo(x, y)
        .lineTo(x + dx * 0.45, y + dy * 0.28)
        .lineTo(x + dx, y + dy)
        .stroke({ color: i % 5 === 0 ? accentColor : 0xffffff, width: i % 5 === 0 ? 2.2 : 1.2, alpha: 0.05 + breakOut * 0.065 });
    }
    crackLayer.addChild(cracks);

    const pressureLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.62 });
    const pressure = new this.pixi.Graphics();
    for (let i = 0; i < 34; i += 1) {
      const fromLeft = i % 2 === 0;
      const y = h * ((i * 47) % 1000 / 1000) + Math.sin(timeSeconds * 4 + i) * 14;
      const x1 = fromLeft ? -90 : w + 90;
      const x2 = fromLeft ? w * (0.26 + (i % 6) * 0.04) : w * (0.74 - (i % 6) * 0.04);
      const y2 = h * 0.5 + (y - h * 0.5) * 0.38;
      this.drawTaperedQuad(
        pressure,
        x1,
        y,
        x2,
        y2,
        16 + (i % 3) * 7 + hit * 9,
        1.2,
        i % 6 === 0 ? accentColor : 0xffffff,
        0.035 + breakOut * 0.052 + hit * 0.04,
      );
    }
    pressure.rect(0, 0, w, h).fill({ color: 0xffffff, alpha: Math.max(0, 0.22 - p * 0.75) });
    pressureLayer.addChild(pressure);

    const debrisLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.62 });
    debrisLayer.filters = [this.createBlurFilter(0.45 + breakOut * 0.55, 2)].filter(Boolean);
    const debris = new this.pixi.Graphics();
    for (let i = 0; i < 64; i += 1) {
      const angle = (i / 64) * Math.PI * 2 + Math.sin(i) * 0.22;
      const dist = 120 + ((i * 41 + timeSeconds * (95 + breakOut * 160)) % 470);
      const x = w * 0.5 + Math.cos(angle) * dist;
      const y = h * 0.48 + Math.sin(angle) * dist * 0.74;
      const size = 2 + (i % 5) * 1.8 + hit * 2.6;
      debris.rect(x, y, size * (1.5 + (i % 3)), size).fill({ color: i % 7 === 0 ? 0xffffff : accentColor, alpha: 0.04 + breakOut * 0.045 + hit * 0.03 });
    }
    debrisLayer.addChild(debris);
  }

  drawFinalAttackTrailerCardProVfx(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ff4f7a";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = Math.min(Math.max(progress, 0), 1);
    const build = Math.sin(Math.min(p / 0.86, 1) * Math.PI);
    const charge = easeInOutCubic(Math.min(p / 0.78, 1));
    const release = Math.max(0, 1 - Math.abs(p - 0.78) * 8);
    const afterglow = Math.sin(Math.min(Math.max((p - 0.68) / 0.32, 0), 1) * Math.PI);
    const pulse = 0.5 + Math.sin(timeSeconds * 4.2) * 0.5;

    this.drawPanelEcho(options.panelTexture, options.camera, {
      blendMode: "screen",
      alpha: 0.07 + build * 0.085 + release * 0.11,
      zoomBoost: 0.055 + release * 0.08,
      panX: Math.sin(timeSeconds * 0.7) * 0.012 + Math.sin(timeSeconds * 24) * release * 0.012,
      panY: -0.028 - charge * 0.018 + Math.cos(timeSeconds * 22) * release * 0.01,
      blur: 3.0 + build * 3.0,
      blurQuality: 4,
    });
    this.drawPanelEcho(options.panelTexture, options.camera, {
      blendMode: "multiply",
      alpha: 0.07 + charge * 0.06,
      zoomBoost: -0.018,
      panY: 0.018,
      blur: 0.45,
    });

    if (options.panelTexture) {
      const focusLayer = this.createFxLayer({ blendMode: "normal", alpha: 0.08 + build * 0.09 + release * 0.08 });
      this.drawCoverSprite(options.panelTexture, focusLayer, {
        zoom: 1.15 + (options.camera?.zoom || 1) - 1 + charge * 0.06 + release * 0.08,
        panX: (options.camera?.panX || 0) + Math.sin(timeSeconds * 8) * build * 0.006 + Math.sin(timeSeconds * 34) * release * 0.01,
        panY: (options.camera?.panY || 0) - charge * 0.016 + Math.cos(timeSeconds * 31) * release * 0.008,
        rotation: (options.camera?.rotation || 0) + Math.sin(timeSeconds * 4.6) * build * 0.003,
        filters: [
          this.createHeatWaveFilter(timeSeconds, 0.002 + build * 0.006 + release * 0.004),
          this.createChromaticPulseFilter(timeSeconds, 0.001 + release * 0.004),
          this.createBlurFilter(1.0 + release * 0.9, 3),
        ].filter(Boolean),
      });
      const mask = new this.pixi.Graphics();
      mask.moveTo(w * 0.08, h * 0.2)
        .lineTo(w * 0.92, h * 0.1)
        .lineTo(w * 0.96, h * 0.78)
        .lineTo(w * 0.18, h * 0.92)
        .closePath()
        .fill(0xffffff);
      focusLayer.mask = mask;
      this.root.addChild(mask);
    }

    const matteLayer = this.createFxLayer({ blendMode: "normal", alpha: 0.58 });
    matteLayer.filters = [this.createBlurFilter(0.35, 2)].filter(Boolean);
    const matte = new this.pixi.Graphics();
    const bar = 62 + build * 26 + release * 14;
    matte.rect(0, 0, w, bar).fill({ color: 0x010103, alpha: 0.3 + build * 0.06 });
    matte.rect(0, h - bar - 14, w, bar + 14).fill({ color: 0x010103, alpha: 0.34 + build * 0.06 });
    matte.moveTo(0, bar - 10)
      .lineTo(w, bar - 42)
      .stroke({ color: 0xffffff, width: 1.6, alpha: 0.045 + release * 0.075 });
    matte.moveTo(0, h - bar - 4)
      .lineTo(w, h - bar - 52)
      .stroke({ color: accentColor, width: 1.6, alpha: 0.065 + build * 0.05 + release * 0.085 });
    matteLayer.addChild(matte);

    const gradeLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.48 });
    gradeLayer.filters = [this.createBlurFilter(0.8, 2)].filter(Boolean);
    const grade = new this.pixi.Graphics();
    const chargeFill = this.createFillGradient({
      type: "linear",
      start: { x: 0.0, y: 1 },
      end: { x: 1, y: 0.05 },
      colorStops: [
        { offset: 0, color: "rgba(255,255,255,0)" },
        { offset: 0.22, color: `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},${0.055 + build * 0.06})` },
        { offset: 0.52, color: `rgba(255,255,255,${0.03 + release * 0.1})` },
        { offset: 0.86, color: "rgba(255,255,255,0)" },
      ],
    });
    grade.rect(0, 0, w, h).fill(chargeFill || { color: accentColor, alpha: 0.04 + build * 0.035 });
    grade.rect(0, 0, w, h).fill({ color: 0xffffff, alpha: Math.max(0, release * 0.16 - afterglow * 0.04) });
    gradeLayer.addChild(grade);

    const beamLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.42 });
    beamLayer.filters = [this.createBlurFilter(0.9 + build * 0.45, 3)].filter(Boolean);
    const beams = new this.pixi.Graphics();
    for (let i = 0; i < 12; i += 1) {
      const lane = i / 17;
      const baseX = lerp(-80, w + 80, lane) + Math.sin(timeSeconds * 2.1 + i) * 18;
      const width = 7 + (i % 5) * 5 + build * 10 + release * 12;
      this.drawTaperedQuad(
        beams,
        baseX,
        h + 80,
        baseX + Math.sin(i * 1.8) * 120,
        h * (0.08 + (i % 4) * 0.08) - charge * 80,
        width,
        1.2,
        i % 6 === 0 ? 0xffffff : accentColor,
        0.018 + build * 0.036 + release * 0.052,
      );
    }
    for (let i = 0; i < 5; i += 1) {
      const y = h * (0.24 + i * 0.075) + Math.sin(timeSeconds * 3 + i) * 14;
      const offset = (timeSeconds * 260 + i * 59) % (w + 240);
      this.drawTaperedQuad(
        beams,
        -160 + offset,
        y + 80,
        90 + offset,
        y - 80,
        2.4 + build * 5,
        10 + release * 16,
        i % 2 ? accentColor : 0xffffff,
        0.035 + build * 0.035 + release * 0.045,
      );
    }
    beamLayer.addChild(beams);

    const pressureLayer = this.createFxLayer({ blendMode: "multiply", alpha: 0.36 });
    pressureLayer.filters = [this.createBlurFilter(0.7, 2)].filter(Boolean);
    const pressure = new this.pixi.Graphics();
    pressure.rect(0, 0, w, h).stroke({ color: 0x020205, width: 62 + build * 24, alpha: 0.08 + build * 0.035 });
    for (let i = 0; i < 16; i += 1) {
      const side = i % 2 ? -1 : 1;
      const y = h * (0.15 + i * 0.055) + Math.sin(timeSeconds * 3.8 + i) * 20;
      this.drawTaperedQuad(
        pressure,
        side > 0 ? w + 80 : -80,
        y,
        w * 0.5 + side * (120 + (i % 5) * 26),
        h * 0.48 + (y - h * 0.5) * 0.3,
        28 + build * 16,
        1.2,
        0x000000,
        0.024 + build * 0.028 + release * 0.018,
      );
    }
    pressureLayer.addChild(pressure);

    const particleLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.42 });
    const particles = new this.pixi.Graphics();
    for (let i = 0; i < 42; i += 1) {
      const depth = (i % 8) / 7;
      const x = w * 0.5 + Math.sin(i * 2.1 + timeSeconds * (0.8 + depth)) * (w * (0.12 + depth * 0.38));
      const y = h + 70 - ((i * 67 + timeSeconds * (80 + depth * 150 + charge * 120)) % (h + 180));
      const size = 1.5 + depth * 4.5 + pulse * 1.8;
      particles.circle(x, y, size).fill({ color: i % 8 === 0 ? 0xffffff : accentColor, alpha: 0.034 + depth * 0.034 + release * 0.032 });
    }
    particleLayer.addChild(particles);

    const releaseLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.48 });
    releaseLayer.filters = [this.createBlurFilter(0.75 + release * 0.55, 3)].filter(Boolean);
    const rel = new this.pixi.Graphics();
    this.drawTaperedQuad(rel, -90, h * 0.76, w + 120, h * 0.16, 10 + release * 28, 22 + release * 54, 0xffffff, 0.035 + release * 0.15);
    this.drawTaperedQuad(rel, -60, h * 0.82, w + 80, h * 0.28, 4 + release * 14, 10 + release * 28, accentColor, 0.035 + release * 0.1);
    rel.rect(0, 0, w, h).fill({ color: 0xffffff, alpha: Math.max(0, release * 0.11 - p * 0.01) });
    releaseLayer.addChild(rel);

    this.drawParticleBurst({
      x: w * 0.5,
      y: h * 0.5,
      accent,
      count: 24,
      progress: Math.min(1, 0.42 + build * 0.44 + release * 0.24),
      timeSeconds,
      radius: 220 + build * 140 + release * 100,
      verticalScale: 0.58,
    });
  }

  drawMangaActionSpecializedProVfx(effect, progress, timeSeconds, options = {}, variant = "clash") {
    const accent = effect.accent || "#ffd84d";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = Math.min(Math.max(progress, 0), 1);
    const intro = easeOutCubic(Math.min(p / 0.5, 1));
    const hit = Math.max(0, 1 - Math.min(p / 0.2, 1));
    const pulse = 0.5 + Math.sin(timeSeconds * 3.4) * 0.5;
    const breath = 0.5 + Math.sin(timeSeconds * 1.2) * 0.5;
    const applyLayerFilters = (layer, filters = []) => {
      const resolved = filters.filter(Boolean);
      if (resolved.length) layer.filters = resolved;
      return layer;
    };
    const softActionVariant = ["clash", "projectiles", "combo", "clones", "dust", "finisher"].includes(variant);
    const actionAlpha = softActionVariant ? 0.58 : 1;
    const actionBlur = softActionVariant ? 1.35 : 1;

    if (options.panelTexture) {
      const echoMode = variant === "rage" || variant === "finisher" ? "multiply" : "screen";
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: echoMode,
        alpha: (0.1 + intro * 0.12 + hit * 0.12) * actionAlpha,
        zoomBoost: variant === "glint" ? 0.018 : 0.038 + hit * 0.045,
        panX: Math.sin(timeSeconds * (variant === "projectiles" ? 14 : 7)) * (0.008 + hit * 0.008),
        panY: Math.cos(timeSeconds * 6.4) * (0.006 + hit * 0.006),
        rotation: Math.sin(timeSeconds * 7.5) * hit * 0.004,
        blur: (variant === "clones" || variant === "projectiles" ? 2.6 : 0.8 + hit) * actionBlur,
        blurQuality: 3,
      });
    }

    const grade = this.createFxLayer({ blendMode: "multiply", alpha: softActionVariant ? 0.52 : 0.82 });
    const shade = new this.pixi.Graphics();
    shade.rect(0, 0, w, h).fill({ color: 0x020204, alpha: (variant === "glint" ? 0.16 : 0.045 + hit * 0.035) * actionAlpha });
    if (variant === "rage" || variant === "finisher") {
      shade.rect(0, 0, w, h).fill({ color: 0x1a0206, alpha: (variant === "rage" ? 0.13 + breath * 0.08 : 0.07 + hit * 0.06) * actionAlpha });
    }
    shade.rect(0, 0, w, h).stroke({ color: 0x020204, width: 44 + intro * 18, alpha: (0.08 + intro * 0.07) * actionAlpha });
    grade.addChild(shade);

    const atmosphere = this.createFxLayer({ blendMode: "screen", alpha: softActionVariant ? 0.2 : 0.34 });
    applyLayerFilters(atmosphere, [
      this.createExternalBloomFilter({ threshold: 0.2, bloomScale: 0.34, brightness: 1.03, blur: 6, quality: 2 }),
      this.createBlurFilter(softActionVariant ? 0.95 : 0.5, 2),
    ]);
    const wash = new this.pixi.Graphics();
    const washFill = this.createFillGradient({
      type: "linear",
      start: { x: 0, y: variant === "ground" || variant === "dust" ? 1 : 0.18 },
      end: { x: 1, y: variant === "beam" || variant === "projectiles" ? 0.18 : 0.82 },
      colorStops: [
        { offset: 0, color: "rgba(255,255,255,0)" },
        { offset: 0.48, color: `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},${(0.035 + intro * 0.035) * actionAlpha})` },
        { offset: 1, color: "rgba(255,255,255,0)" },
      ],
    });
    wash.rect(0, 0, w, h).fill(washFill || { color: accentColor, alpha: 0.035 + intro * 0.02 });
    atmosphere.addChild(wash);

    if (variant === "clash") {
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.58 });
      applyLayerFilters(layer, [
        this.createExternalBloomFilter({ threshold: 0.12, bloomScale: 0.44, brightness: 1.06, blur: 8, quality: 3 }),
        this.createExternalGlowFilter({ color: accentColor, distance: 14, outerStrength: 0.34, innerStrength: 0.04, quality: 0.18 }),
        this.createBlurFilter(0.85, 3),
      ]);
      const g = new this.pixi.Graphics();
      const cx = w * 0.5 + Math.sin(timeSeconds * 22) * hit * 10;
      const cy = h * 0.46 + Math.cos(timeSeconds * 18) * hit * 8;
      this.drawSoftBeam(layer, -120, h * 0.25, cx + 20, cy, 150 + hit * 56, 0xffffff, 0.08 + hit * 0.075, { blur: 2.2 });
      this.drawSoftBeam(layer, w + 120, h * 0.72, cx - 16, cy + 6, 150 + hit * 56, accentColor, 0.09 + hit * 0.085, { blur: 2.2 });
      this.drawTaperedQuad(g, -80, h * 0.27, cx, cy, 10, 30 + hit * 20, 0xffffff, 0.14 + hit * 0.1);
      this.drawTaperedQuad(g, w + 80, h * 0.72, cx, cy + 6, 10, 30 + hit * 20, accentColor, 0.15 + hit * 0.1);
      for (let i = 0; i < 20; i += 1) {
        const angle = -Math.PI + (i / 29) * Math.PI * 2;
        const inner = 24 + (i % 4) * 8;
        const outer = 92 + (i % 6) * 26 + hit * 70;
        this.drawTaperedQuad(g, cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner * 0.7, cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer * 0.72, 1, 3 + (i % 3), i % 4 ? accentColor : 0xffffff, 0.055 + hit * 0.07);
      }
      layer.addChild(g);
      this.drawCinematicDust(layer, timeSeconds, { count: 26, color: accentColor, alpha: 0.055, drift: 0.34 });
      const ink = this.createFxLayer({ blendMode: "multiply", alpha: 0.34 });
      applyLayerFilters(ink, [this.createBlurFilter(0.9, 2)]);
      const k = new this.pixi.Graphics();
      this.drawTaperedQuad(k, -90, h * 0.75, cx - 80, cy + 24, 78, 10, 0x000000, 0.035 + hit * 0.03);
      this.drawTaperedQuad(k, w + 90, h * 0.2, cx + 90, cy - 18, 78, 10, 0x000000, 0.035 + hit * 0.03);
      ink.addChild(k);
      this.drawParticleBurst({ x: cx, y: cy, accent, count: 24, progress: Math.min(1, 0.48 + intro * 0.52), timeSeconds, radius: 190 + hit * 80, verticalScale: 0.44 });
      return;
    }

    if (variant === "ground") {
      const dust = this.createFxLayer({ blendMode: "screen", alpha: 0.9 });
      applyLayerFilters(dust, [
        this.createExternalBloomFilter({ threshold: 0.16, bloomScale: 0.45, brightness: 1.04, blur: 8, quality: 2 }),
        this.createBlurFilter(0.25, 2),
      ]);
      this.drawVolumetricSmoke(dust, timeSeconds, { count: 24, color: accentColor, alpha: 0.08, x: w * 0.5, y: h * 0.77, spreadX: w * 0.95, spreadY: h * 0.26, scale: 1.7, blur: 2.7, rise: 70 });
      const g = new this.pixi.Graphics();
      const groundY = h * (0.72 + Math.sin(timeSeconds * 0.7) * 0.01);
      const floorFill = this.createFillGradient({
        type: "linear",
        start: { x: 0.5, y: groundY / h },
        end: { x: 0.5, y: 1 },
        colorStops: [
          { offset: 0, color: "rgba(255,255,255,0)" },
          { offset: 0.36, color: `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},0.08)` },
          { offset: 1, color: "rgba(18,11,5,0.22)" },
        ],
      });
      g.rect(0, groundY, w, h - groundY).fill(floorFill || { color: 0x120b05, alpha: 0.12 + intro * 0.06 });
      for (let i = 0; i < 17; i += 1) {
        const side = i % 2 ? -1 : 1;
        const startX = w * 0.5 + side * (16 + (i % 4) * 10);
        const len = 80 + (i % 6) * 42 + intro * 95;
        const x2 = startX + side * len;
        const y2 = groundY + 18 + (i % 5) * 28;
        g.moveTo(startX, groundY + (i % 3) * 8)
          .lineTo((startX + x2) * 0.5, y2 - 22 + Math.sin(i) * 12)
          .lineTo(x2, y2)
          .stroke({ color: i % 4 === 0 ? accentColor : 0xffffff, width: i % 4 === 0 ? 3 : 1.8, alpha: 0.12 + intro * 0.16 });
      }
      for (let i = 0; i < 54; i += 1) {
        const x = (i * 71 + timeSeconds * 55) % (w + 160) - 80;
        const y = groundY + ((i * 37) % 180) - intro * 60;
        const size = 2 + (i % 5) * 2.4;
        g.rect(x, y, size * 1.8, size).fill({ color: i % 6 === 0 ? 0xffffff : accentColor, alpha: 0.055 + intro * 0.08 });
      }
      dust.addChild(g);
      return;
    }

    if (variant === "projectiles") {
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.54 });
      applyLayerFilters(layer, [
        this.createExternalMotionBlurFilter(12, -7, 8),
        this.createExternalBloomFilter({ threshold: 0.18, bloomScale: 0.26, brightness: 1.02, blur: 5, quality: 2 }),
        this.createBlurFilter(0.7, 2),
      ]);
      const g = new this.pixi.Graphics();
      const travel = (timeSeconds * 420) % 520;
      for (let lane = 0; lane < 5; lane += 1) {
        const y = h * (0.22 + lane * 0.12) + Math.sin(timeSeconds * 2.1 + lane) * 12;
        const offset = ((timeSeconds * 190 + lane * 83) % 220) - 110;
        this.drawTaperedQuad(g, -70 + offset, y + 68, w * 0.74 + offset * 0.2, y - 90, 1.8, 11 + lane * 1.8, lane % 2 ? accentColor : 0xffffff, 0.05 + intro * 0.026);
      }
      for (let i = 0; i < 22; i += 1) {
        const depth = (i % 8) / 7;
        const y = h * (0.08 + ((i * 67) % 820) / 1000) + Math.sin(timeSeconds * 3 + i) * 18;
        const x = -220 + ((i * 113 + travel * (0.7 + depth)) % (w + 480));
        const len = 145 + depth * 170;
        const x2 = x + len;
        const y2 = y - 76 - depth * 70;
        this.drawTaperedQuad(g, x, y, x2, y2, 1 + depth * 2.6, 7 + depth * 13, i % 5 === 0 ? 0xffffff : accentColor, 0.044 + depth * 0.052);
        g.circle(x2, y2, 1.8 + depth * 2.6).fill({ color: i % 5 === 0 ? 0xffffff : accentColor, alpha: 0.075 + depth * 0.07 });
      }
      layer.addChild(g);
      this.drawCinematicDust(layer, timeSeconds, { count: 36, color: 0xffffff, alpha: 0.05, drift: 0.32 });
      return;
    }

    if (variant === "beam") {
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.98 });
      applyLayerFilters(layer, [
        this.createExternalBloomFilter({ threshold: 0.08, bloomScale: 0.72, brightness: 1.12, blur: 7, quality: 3 }),
        this.createExternalMotionBlurFilter(10, -5, 7),
        this.createHeatWaveFilter(timeSeconds, 0.004),
      ]);
      const sweep = lerp(-160, 160, easeInOutCubic(Math.min(p, 1)));
      const y1 = h * 0.72 - sweep * 0.14;
      const y2 = h * 0.18 + sweep * 0.08;
      this.drawCinematicGlowPlate(layer, w * 0.48 + sweep * 0.15, h * 0.47, 250, accentColor, 0.055 + pulse * 0.028, { blur: 9, outerStrength: 1.05 });
      this.drawSoftBeam(layer, -120, y1, w + 120, y2, 170 + hit * 58, accentColor, 0.17 + intro * 0.095, { blur: 2.1 });
      this.drawSoftBeam(layer, -90, y1 + 18, w + 90, y2 + 6, 36 + hit * 28, 0xffffff, 0.23 + hit * 0.13, { blur: 0.55 });
      const g = new this.pixi.Graphics();
      for (let i = 0; i < 11; i += 1) {
        const y = y1 + (i - 5) * 18 + Math.sin(timeSeconds * 4 + i) * 14;
        this.drawTaperedQuad(g, -80, y, w + 80, y2 + (i - 5) * 9, 1.4, 9 + (i % 4) * 3.5, i % 3 ? accentColor : 0xffffff, 0.045 + intro * 0.06);
      }
      layer.addChild(g);
      this.drawCinematicDust(layer, timeSeconds, { count: 46, color: 0xffffff, alpha: 0.1, drift: 0.22 });
      return;
    }

    if (variant === "glint") {
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.96 });
      applyLayerFilters(layer, [
        this.createExternalBloomFilter({ threshold: 0.18, bloomScale: 0.58, brightness: 1.12, blur: 4, quality: 3 }),
        this.createExternalGlowFilter({ color: 0xffffff, distance: 12, outerStrength: 0.42, innerStrength: 0.08, quality: 0.18 }),
      ]);
      const g = new this.pixi.Graphics();
      const glint = Math.max(0, Math.sin(Math.min(p / 0.76, 1) * Math.PI));
      const sx = w * 0.16;
      const sy = h * 0.63;
      const ex = w * 0.86;
      const ey = h * 0.3;
      g.rect(0, 0, w, 96).fill({ color: 0x000000, alpha: 0.38 + glint * 0.1 });
      g.rect(0, h - 126, w, 126).fill({ color: 0x000000, alpha: 0.44 + glint * 0.1 });
      this.drawTaperedQuad(g, sx, sy, ex, ey, 2.2, 8 + glint * 18, 0xffffff, 0.46 + glint * 0.28);
      this.drawTaperedQuad(g, sx + 12, sy + 24, ex - 16, ey + 18, 1.2, 5 + glint * 9, accentColor, 0.18 + glint * 0.22);
      for (let i = 0; i < 14; i += 1) {
        const t = i / 13;
        const x = lerp(sx, ex, t) + Math.sin(i * 3.1 + timeSeconds) * 18;
        const y = lerp(sy, ey, t) + Math.cos(i * 2.3 + timeSeconds) * 13;
        g.circle(x, y, 1.5 + (i % 3)).fill({ color: i % 4 ? accentColor : 0xffffff, alpha: 0.1 + glint * 0.18 });
      }
      layer.addChild(g);
      return;
    }

    if (variant === "combo") {
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.52 });
      applyLayerFilters(layer, [
        this.createExternalBloomFilter({ threshold: 0.18, bloomScale: 0.28, brightness: 1.04, blur: 7, quality: 2 }),
        this.createExternalShockwaveFilter(timeSeconds, { amplitude: 4, wavelength: 210, radius: 500, timeScale: 0.24 }),
        this.createBlurFilter(0.45, 2),
      ]);
      const g = new this.pixi.Graphics();
      const hits = [
        { x: w * 0.3, y: h * 0.34, t: 0.16, color: accentColor },
        { x: w * 0.66, y: h * 0.5, t: 0.38, color: 0xffffff },
        { x: w * 0.43, y: h * 0.68, t: 0.62, color: accentColor },
      ];
      hits.forEach((beat, index) => {
        const active = Math.max(0, 1 - Math.abs(p - beat.t) * 7);
        const settle = Math.sin(Math.min(Math.max((p - beat.t + 0.12) / 0.4, 0), 1) * Math.PI);
        const idle = 0.28 + Math.sin(timeSeconds * 3 + index) * 0.05;
        const r = 48 + settle * 32 + active * 34;
        g.moveTo(beat.x - r, beat.y - r * 0.2)
          .lineTo(beat.x - r * 0.2, beat.y - r)
          .lineTo(beat.x + r * 0.9, beat.y - r * 0.36)
          .lineTo(beat.x + r * 0.55, beat.y + r * 0.72)
          .lineTo(beat.x - r * 0.8, beat.y + r * 0.48)
          .closePath()
          .fill({ color: index % 2 ? 0xffffff : accentColor, alpha: 0.014 + idle * 0.022 + active * 0.034 })
          .stroke({ color: index % 2 ? accentColor : 0xffffff, width: 1.2 + active * 2.1, alpha: 0.05 + idle * 0.045 + active * 0.1 });
        for (let j = 0; j < 12; j += 1) {
          const angle = (j / 12) * Math.PI * 2 + index;
          this.drawTaperedQuad(g, beat.x + Math.cos(angle) * 30, beat.y + Math.sin(angle) * 24, beat.x + Math.cos(angle) * (r + 46), beat.y + Math.sin(angle) * (r * 0.72 + 28), 1, 2 + active * 4, j % 3 ? beat.color : 0xffffff, 0.018 + idle * 0.018 + active * 0.064);
        }
      });
      layer.addChild(g);
      return;
    }

    if (variant === "clones") {
      const dir = p < 0.5 ? 1 : -1;
      if (options.panelTexture) {
        for (let i = 0; i < 5; i += 1) {
          const layer = this.createFxLayer({ blendMode: i % 2 ? "multiply" : "screen", alpha: 0.055 + (4 - i) * 0.012 });
          applyLayerFilters(layer, [
            this.createExternalMotionBlurFilter(dir * (15 + i * 3), -7, 9),
            this.createBlurFilter(2.2 + i * 0.6, 3),
          ]);
          this.drawCoverSprite(options.panelTexture, layer, {
            zoom: 1.1 + (options.camera?.zoom || 1) - 1 + i * 0.012,
            panX: (options.camera?.panX || 0) + dir * (0.04 + i * 0.025),
            panY: (options.camera?.panY || 0) + (i - 3) * 0.008,
            rotation: (options.camera?.rotation || 0) + dir * (0.004 + i * 0.002),
            filters: [this.createBlurFilter(3.0 + i * 0.8, 3), this.createChromaticPulseFilter(timeSeconds, 0.001 + i * 0.00045)].filter(Boolean),
          });
          const mask = new this.pixi.Graphics();
          const y = h * (0.08 + i * 0.12);
          mask.moveTo(-20, y)
            .lineTo(w + 20, y - 26)
            .lineTo(w + 10, y + 82)
            .lineTo(-10, y + 118)
            .closePath()
            .fill(0xffffff);
          layer.mask = mask;
          this.root.addChild(mask);
        }
      }
      const speed = this.createFxLayer({ blendMode: "screen", alpha: 0.38 });
      applyLayerFilters(speed, [
        this.createExternalMotionBlurFilter(dir * 26, -10, 11),
        this.createExternalBloomFilter({ threshold: 0.22, bloomScale: 0.2, brightness: 1.02, blur: 5, quality: 2 }),
        this.createBlurFilter(0.7, 2),
      ]);
      const g = new this.pixi.Graphics();
      for (let i = 0; i < 28; i += 1) {
        const y = ((i * 67 + timeSeconds * 120) % (h + 140)) - 70;
        this.drawTaperedQuad(g, dir > 0 ? -90 : w + 90, y, dir > 0 ? w * 0.62 : w * 0.38, y - dir * (18 + (i % 5) * 8), 12 + (i % 4) * 5, 1.2, i % 5 ? accentColor : 0xffffff, 0.022 + intro * 0.034);
      }
      speed.addChild(g);
      return;
    }

    if (variant === "dust") {
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.48 });
      applyLayerFilters(layer, [
        this.createExternalBloomFilter({ threshold: 0.24, bloomScale: 0.22, brightness: 1.02, blur: 7, quality: 2 }),
        this.createBlurFilter(1.2, 3),
      ]);
      const g = new this.pixi.Graphics();
      const baseY = h * 0.77;
      const floorHaze = this.createFillGradient({
        type: "linear",
        start: { x: 0.5, y: 0.52 },
        end: { x: 0.5, y: 1 },
        colorStops: [
          { offset: 0, color: "rgba(255,255,255,0)" },
          { offset: 0.42, color: `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},0.028)` },
          { offset: 1, color: "rgba(255,255,255,0.018)" },
        ],
      });
      g.rect(0, h * 0.52, w, h * 0.48).fill(floorHaze || { color: accentColor, alpha: 0.045 });

      const glowA = this.createFillGradient({
        type: "radial",
        center: { x: 0.24, y: 0.82 },
        innerRadius: 0.02,
        outerCenter: { x: 0.24, y: 0.82 },
        outerRadius: 0.36,
        colorStops: [
          { offset: 0, color: `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},0.065)` },
          { offset: 0.52, color: `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},0.026)` },
          { offset: 1, color: "rgba(255,255,255,0)" },
        ],
      });
      g.rect(0, 0, w, h).fill(glowA || { color: accentColor, alpha: 0.05 });

      for (let i = 0; i < 18; i += 1) {
        const drift = ((timeSeconds * (36 + (i % 5) * 8) + i * 61) % (w + 220)) - 110;
        const depth = (i % 6) / 5;
        const x = drift;
        const y = baseY + Math.sin(timeSeconds * 0.9 + i) * 14 + depth * 74;
        const rx = 36 + depth * 82 + Math.sin(i) * 8;
        const ry = 8 + depth * 20;
        g.ellipse(x, y, rx, ry, -0.16 + Math.sin(i) * 0.08)
          .fill({ color: i % 4 === 0 ? 0xffffff : accentColor, alpha: 0.026 + depth * 0.022 + intro * 0.012 });
      }

      for (let i = 0; i < 24; i += 1) {
        const y = h * (0.62 + (i % 7) * 0.045) + Math.sin(timeSeconds * 1.7 + i) * 12;
        const x = ((i * 83 + timeSeconds * 120) % (w + 180)) - 90;
        this.drawTaperedQuad(
          g,
          x - 64,
          y + 18,
          x + 92,
          y - 18,
          6 + (i % 3) * 3,
          1,
          i % 5 ? accentColor : 0xffffff,
          0.026 + intro * 0.026,
        );
      }

      for (let i = 0; i < 54; i += 1) {
        const x = ((i * 47 + timeSeconds * (34 + (i % 4) * 9)) % (w + 80)) - 40;
        const y = h * 0.58 + ((i * 29 + timeSeconds * 25) % (h * 0.38));
        const size = 1.1 + (i % 5) * 0.7;
        g.circle(x, y, size).fill({ color: i % 6 === 0 ? 0xffffff : accentColor, alpha: 0.024 + (i % 5) * 0.006 });
      }

      const shade = this.createFxLayer({ blendMode: "multiply", alpha: 0.24 });
      const s = new this.pixi.Graphics();
      s.rect(0, h * 0.8, w, h * 0.2).fill({ color: 0x120b05, alpha: 0.08 });
      shade.addChild(s);

      layer.addChild(g);

      const bodyDust = this.createFxLayer({ blendMode: "normal", alpha: 0.32 });
      applyLayerFilters(bodyDust, [this.createBlurFilter(2.0, 3)]);
      const d = new this.pixi.Graphics();
      for (let i = 0; i < 12; i += 1) {
        const depth = (i % 5) / 4;
        const x = w * (0.12 + i * 0.075) + Math.sin(timeSeconds * 0.9 + i) * 26;
        const y = h * (0.71 + depth * 0.08) + Math.cos(timeSeconds * 0.8 + i) * 10;
        const rx = 38 + depth * 76;
        const ry = 9 + depth * 18;
        d.ellipse(x, y, rx, ry, -0.13 + Math.sin(i) * 0.08)
          .fill({ color: accentColor, alpha: 0.026 + depth * 0.015 });
      }
      for (let i = 0; i < 8; i += 1) {
        const x = w * (0.18 + i * 0.095) + Math.sin(timeSeconds * 1.2 + i) * 20;
        const y = h * (0.78 + (i % 3) * 0.035);
        d.ellipse(x, y, 28 + (i % 4) * 18, 5 + (i % 3) * 5, -0.18)
          .fill({ color: 0xffffff, alpha: 0.016 + (i % 3) * 0.006 });
      }
      bodyDust.addChild(d);
      return;
    }

    if (variant === "rage") {
      const layer = this.createFxLayer({ blendMode: "screen", alpha: 0.9 });
      applyLayerFilters(layer, [
        this.createHeatWaveFilter(timeSeconds, 0.004),
        this.createExternalBloomFilter({ threshold: 0.16, bloomScale: 0.44, brightness: 1.08, blur: 6, quality: 2 }),
      ]);
      const g = new this.pixi.Graphics();
      const fill = this.createFillGradient({
        type: "linear",
        start: { x: 0.5, y: 0 },
        end: { x: 0.5, y: 1 },
        colorStops: [
          { offset: 0, color: "rgba(0,0,0,0)" },
          { offset: 0.42, color: "rgba(255,49,85,0.11)" },
          { offset: 1, color: "rgba(0,0,0,0.18)" },
        ],
      });
      g.rect(0, 0, w, h).fill(fill || { color: accentColor, alpha: 0.08 });
      for (let i = 0; i < 36; i += 1) {
        const x = w * ((i * 37) % 1000 / 1000);
        const wav = Math.sin(timeSeconds * 3.2 + i) * (12 + (i % 5) * 3);
        const startY = -40 + (i % 4) * 18;
        const endY = h + 40 - (i % 3) * 20;
        g.moveTo(x + wav, startY)
          .lineTo(x - wav * 0.4, h * 0.34)
          .lineTo(x + wav * 0.8, h * 0.66)
          .lineTo(x - wav, endY)
          .stroke({ color: i % 5 === 0 ? 0xffffff : accentColor, width: i % 5 === 0 ? 2.3 : 1.3, alpha: 0.035 + breath * 0.075 });
      }
      layer.addChild(g);
      return;
    }

    if (variant === "finisher") {
      const layer = this.createFxLayer({ blendMode: "normal", alpha: 0.56 });
      applyLayerFilters(layer, [
        this.createExternalBloomFilter({ threshold: 0.18, bloomScale: 0.24, brightness: 1.03, blur: 7, quality: 2 }),
        this.createExternalRgbSplitFilter(timeSeconds, 1.2),
        this.createBlurFilter(0.55, 2),
      ]);
      const g = new this.pixi.Graphics();
      const strike = Math.max(hit, Math.max(0, 1 - Math.abs(p - 0.52) * 7));
      g.rect(0, 0, w, h).fill({ color: 0xffffff, alpha: Math.max(0, 0.16 - p * 0.5) + strike * 0.075 });
      g.rect(0, 0, w, 72 + strike * 24).fill({ color: 0x010103, alpha: 0.26 + strike * 0.08 });
      g.rect(0, h - 88 - strike * 32, w, 88 + strike * 32).fill({ color: 0x010103, alpha: 0.3 + strike * 0.09 });
      g.moveTo(-40, h * 0.24).lineTo(w * 0.72, h * 0.08).lineTo(w * 0.6, h * 0.18).lineTo(-40, h * 0.42).closePath().fill({ color: 0xffffff, alpha: 0.04 + strike * 0.065 });
      g.moveTo(w + 40, h * 0.7).lineTo(w * 0.25, h * 0.9).lineTo(w * 0.38, h * 0.76).lineTo(w + 40, h * 0.52).closePath().fill({ color: 0xffffff, alpha: 0.036 + strike * 0.058 });
      for (let i = 0; i < 18; i += 1) {
        const y = h * (0.18 + i * 0.04) + Math.sin(timeSeconds * 5 + i) * 9;
        this.drawTaperedQuad(g, -80, y + 96, w + 80, y - 86, 3 + strike * 8, 12 + strike * 24, i % 4 ? 0xffffff : accentColor, 0.016 + strike * 0.04);
      }
      layer.addChild(g);
    }
  }

  drawImpactZoomProVfx(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ff335f";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const hit = Math.max(0, 1 - Math.min(progress / 0.24, 1));
    const rebound = Math.sin(Math.min(progress, 1) * Math.PI);
    const focus = {
      x: w * (0.5 + Math.sin(timeSeconds * 0.8) * 0.012),
      y: h * (0.46 + Math.cos(timeSeconds * 0.7) * 0.01),
      rx: w * 0.31,
      ry: h * 0.25,
    };

    const shock = this.createChromaticPulseFilter(timeSeconds, 0.006 + hit * 0.012);
    if (options.panelTexture) {
      const layer = this.createFxLayer({ blendMode: "normal", alpha: 0.22 + hit * 0.24 });
      this.drawCoverSprite(options.panelTexture, layer, {
        zoom: 1.18 + (options.camera?.zoom || 1) - 1 + hit * 0.08,
        panX: (options.camera?.panX || 0) + Math.sin(timeSeconds * 26) * hit * 0.012,
        panY: (options.camera?.panY || 0) + Math.cos(timeSeconds * 24) * hit * 0.01,
        rotation: (options.camera?.rotation || 0) + Math.sin(timeSeconds * 30) * hit * 0.006,
        filters: [shock, this.createBlurFilter(0.45 + hit * 0.8, 2)].filter(Boolean),
      });
    }

    const impactLayer = this.createFxLayer({ blendMode: "screen" });
    const g = new this.pixi.Graphics();
    const flash = Math.max(0, 0.22 - progress * 0.65);
    g.rect(0, 0, w, h).fill({ color: 0xffffff, alpha: flash });
    for (let i = 0; i < 5; i += 1) {
      g.ellipse(focus.x, focus.y, focus.rx * (0.76 + i * 0.34 + rebound * 0.2), focus.ry * (0.56 + i * 0.24 + rebound * 0.14))
        .stroke({ color: i % 2 ? accentColor : 0xffffff, width: i === 0 ? 5 : 2.5, alpha: (0.18 - i * 0.025) + hit * 0.06 });
    }
    for (let i = 0; i < 20; i += 1) {
      const angle = (i / 20) * Math.PI * 2 + timeSeconds * 0.12;
      const x1 = focus.x + Math.cos(angle) * focus.rx * 0.88;
      const y1 = focus.y + Math.sin(angle) * focus.ry * 0.72;
      const x2 = focus.x + Math.cos(angle) * (w * 0.68 + (i % 4) * 34);
      const y2 = focus.y + Math.sin(angle) * (h * 0.46 + (i % 5) * 24);
      this.drawTaperedQuad(g, x1, y1, x2, y2, 1, 7 + (i % 4), i % 3 ? accentColor : 0xffffff, 0.08 + hit * 0.11);
    }
    impactLayer.addChild(g);
    this.restoreSpeedImpactFocus(options.panelTexture, options.camera, focus, 0.88);
  }

  drawSlashEnergyProVfx(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#55f0c8";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeOutCubic(Math.min(progress / 0.65, 1));
    const focus = { x: w * 0.52, y: h * 0.48, rx: w * 0.32, ry: h * 0.25 };

    if (options.panelTexture) {
      const layer = this.createFxLayer({ blendMode: "normal", alpha: 0.18 + p * 0.2 });
      this.drawCoverSprite(options.panelTexture, layer, {
        zoom: 1.14 + (options.camera?.zoom || 1) - 1,
        panX: (options.camera?.panX || 0) + 0.028,
        panY: (options.camera?.panY || 0) - 0.018,
        rotation: (options.camera?.rotation || 0) - 0.012,
        filters: [this.createHeatWaveFilter(timeSeconds, 0.006 + p * 0.008), this.createChromaticPulseFilter(timeSeconds, 0.003 + p * 0.004)].filter(Boolean),
      });
    }

    const slashLayer = this.createFxLayer({ blendMode: "screen" });
    const g = new this.pixi.Graphics();
    const start = { x: w * 0.08, y: h * 0.78 };
    const end = { x: w * 0.92, y: h * 0.2 };
    for (let i = 0; i < 7; i += 1) {
      const offset = (i - 3) * 22 + Math.sin(timeSeconds * 9 + i) * 5;
      const width = i === 3 ? 16 : 5 + (i % 3) * 2;
      this.drawTaperedQuad(g, start.x - 40 + offset, start.y + offset * 0.32, end.x + 40 + offset, end.y + offset * 0.18, width * 0.22, width, i === 3 ? 0xffffff : accentColor, (i === 3 ? 0.48 : 0.22) * p);
    }
    for (let i = 0; i < 26; i += 1) {
      const t = i / 25;
      const x = lerp(start.x, end.x, t) + Math.sin(i * 7.7 + timeSeconds * 7) * 36;
      const y = lerp(start.y, end.y, t) + Math.cos(i * 5.4 + timeSeconds * 6) * 30;
      g.circle(x, y, 1.8 + (i % 4)).fill({ color: i % 5 === 0 ? 0xffffff : accentColor, alpha: 0.12 + p * 0.18 });
    }
    slashLayer.addChild(g);
    if (options.panelTexture) {
      const cutRestore = this.createFxLayer({ blendMode: "normal", alpha: 0.3 + slash * 0.18 + impact * 0.1 });
      this.drawCoverSprite(options.panelTexture, cutRestore, {
        zoom: 1.16 + (options.camera?.zoom || 1) - 1 + impact * 0.07,
        panX: (options.camera?.panX || 0) + nx * 0.02 + Math.sin(timeSeconds * 28) * impact * 0.008,
        panY: (options.camera?.panY || 0) + ny * 0.02 + Math.cos(timeSeconds * 24) * impact * 0.006,
        rotation: (options.camera?.rotation || 0) - 0.012 + Math.sin(timeSeconds * 20) * impact * 0.005,
        filters: [
          this.createHeatWaveFilter(timeSeconds, 0.003 + slash * 0.008),
          this.createChromaticPulseFilter(timeSeconds, 0.002 + slash * 0.005 + impact * 0.004),
        ].filter(Boolean),
      });
      const cutMask = new this.pixi.Graphics();
      const band = 92 + impact * 24;
      cutMask.moveTo(start.x - nx * band - 80, start.y - ny * band + 46)
        .lineTo(end.x - nx * band + 70, end.y - ny * band - 38)
        .lineTo(end.x + nx * band + 42, end.y + ny * band - 28)
        .lineTo(start.x + nx * band - 58, start.y + ny * band + 42)
        .closePath()
        .fill(0xffffff);
      cutRestore.mask = cutMask;
      this.root.addChild(cutMask);
    }
  }

  drawSlashEnergyCutProVfx(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#83fff2";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = Math.min(Math.max(progress, 0), 1);
    const slash = easeOutCubic(Math.min(p / 0.52, 1));
    const impact = Math.max(0, 1 - Math.min(p / 0.2, 1));
    const afterglow = Math.max(0, Math.sin(Math.min(Math.max((p - 0.18) / 0.64, 0), 1) * Math.PI));
    const flicker = 0.5 + Math.sin(timeSeconds * 18) * 0.5;
    const focus = {
      x: w * (0.52 + Math.sin(timeSeconds * 0.7) * 0.012),
      y: h * (0.49 + Math.cos(timeSeconds * 0.64) * 0.01),
      rx: w * (0.33 + afterglow * 0.018),
      ry: h * (0.255 + afterglow * 0.012),
    };
    const start = { x: w * 0.05, y: h * 0.82 };
    const end = { x: w * 0.94, y: h * 0.17 };
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy) || 1;
    const nx = -dy / length;
    const ny = dx / length;

    this.drawPanelEcho(options.panelTexture, options.camera, {
      blendMode: "screen",
      alpha: 0.07 + slash * 0.09 + impact * 0.04,
      zoomBoost: 0.045 + impact * 0.05,
      panX: 0.034 + Math.sin(timeSeconds * 24) * impact * 0.014,
      panY: -0.026 + Math.cos(timeSeconds * 22) * impact * 0.011,
      rotation: -0.012,
      blur: 1.8 + slash * 2.2,
      blurQuality: 3,
    });
    this.drawPanelEcho(options.panelTexture, options.camera, {
      blendMode: "multiply",
      alpha: 0.07 + slash * 0.045,
      zoomBoost: -0.018,
      panX: -0.018,
      panY: 0.014,
      rotation: 0.01,
      blur: 0.5,
    });

    if (options.panelTexture) {
      const refract = this.createFxLayer({ blendMode: "normal", alpha: 0.09 + slash * 0.13 });
      this.drawCoverSprite(options.panelTexture, refract, {
        zoom: 1.15 + (options.camera?.zoom || 1) - 1 + impact * 0.07,
        panX: (options.camera?.panX || 0) + nx * 0.018 + Math.sin(timeSeconds * 31) * impact * 0.01,
        panY: (options.camera?.panY || 0) + ny * 0.018 + Math.cos(timeSeconds * 27) * impact * 0.008,
        rotation: (options.camera?.rotation || 0) - 0.012 + Math.sin(timeSeconds * 19) * impact * 0.006,
        filters: [
          this.createHeatWaveFilter(timeSeconds, 0.004 + slash * 0.012),
          this.createChromaticPulseFilter(timeSeconds, 0.003 + slash * 0.008 + impact * 0.006),
          this.createBlurFilter(0.75 + impact * 0.75, 3),
        ].filter(Boolean),
      });
    }

    const shadeLayer = this.createFxLayer({ blendMode: "multiply", alpha: 0.54 });
    shadeLayer.filters = [this.createBlurFilter(0.55, 2)].filter(Boolean);
    const shade = new this.pixi.Graphics();
    shade.rect(0, 0, w, h).fill({ color: 0x020205, alpha: 0.012 + slash * 0.018 });
    shade.rect(0, 0, w, h).stroke({ color: 0x020205, width: 52 + impact * 18, alpha: 0.075 + slash * 0.04 });
    this.drawTaperedQuad(shade, start.x - nx * 52, start.y - ny * 52, end.x - nx * 52, end.y - ny * 52, 18, 28, 0x020205, 0.055 + slash * 0.04);
    this.drawTaperedQuad(shade, start.x + nx * 66, start.y + ny * 66, end.x + nx * 66, end.y + ny * 66, 22, 34, 0x020205, 0.042 + slash * 0.034);
    shadeLayer.addChild(shade);

    const bladeLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.68 });
    bladeLayer.filters = [this.createBlurFilter(0.35 + impact * 0.35, 2)].filter(Boolean);
    const blade = new this.pixi.Graphics();
    const travel = lerp(-0.18, 0.08, slash);
    const sx = start.x + dx * travel;
    const sy = start.y + dy * travel;
    const ex = start.x + dx * (0.78 + slash * 0.34);
    const ey = start.y + dy * (0.78 + slash * 0.34);
    const bladeGlow = this.createFillGradient({
      type: "linear",
      start: { x: 0.08, y: 0.82 },
      end: { x: 0.92, y: 0.18 },
      colorStops: [
        { offset: 0, color: "rgba(255,255,255,0)" },
        { offset: 0.36, color: `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},0.10)` },
        { offset: 0.5, color: "rgba(255,255,255,0.24)" },
        { offset: 0.62, color: `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},0.09)` },
        { offset: 1, color: "rgba(255,255,255,0)" },
      ],
    });
    blade.rect(0, 0, w, h).fill(bladeGlow || { color: accentColor, alpha: 0.04 + slash * 0.035 });
    this.drawTaperedQuad(blade, sx, sy, ex, ey, 7 + impact * 12, 14 + impact * 16, 0xffffff, 0.32 + slash * 0.1);
    this.drawTaperedQuad(blade, sx - nx * 18, sy - ny * 18, ex - nx * 18, ey - ny * 18, 3, 8 + impact * 5, accentColor, 0.18 + slash * 0.12);
    this.drawTaperedQuad(blade, sx + nx * 24, sy + ny * 24, ex + nx * 24, ey + ny * 24, 2.5, 6 + impact * 4, accentColor, 0.12 + slash * 0.1);
    this.drawTaperedQuad(blade, start.x - nx * 116, start.y - ny * 116, end.x - nx * 116, end.y - ny * 116, 1.4, 4, 0xffffff, 0.04 + afterglow * 0.045);
    this.drawTaperedQuad(blade, start.x + nx * 132, start.y + ny * 132, end.x + nx * 132, end.y + ny * 132, 1.4, 4, accentColor, 0.035 + afterglow * 0.05);
    bladeLayer.addChild(blade);

    const edgeLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.44 });
    edgeLayer.filters = [this.createBlurFilter(0.45 + slash * 0.3, 2)].filter(Boolean);
    const edge = new this.pixi.Graphics();
    for (let i = 0; i < 9; i += 1) {
      const offset = (i - 4) * 28 + Math.sin(timeSeconds * 10 + i) * 5;
      const width = i === 4 ? 12 : 3 + (i % 3) * 1.5;
      const alpha = i === 4 ? 0.16 + slash * 0.1 : 0.05 + slash * 0.06;
      this.drawTaperedQuad(
        edge,
        start.x + nx * offset - 70,
        start.y + ny * offset + 38,
        end.x + nx * offset + 38,
        end.y + ny * offset - 28,
        width * 0.2,
        width,
        i === 4 || i % 3 === 0 ? 0xffffff : accentColor,
        alpha,
      );
    }
    edgeLayer.addChild(edge);

    const sparksLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.48 });
    const sparks = new this.pixi.Graphics();
    for (let i = 0; i < 30; i += 1) {
      const t = (i % 24) / 23;
      const drift = ((i * 37 + timeSeconds * (90 + slash * 170)) % 170) - 85;
      const x = lerp(start.x, end.x, t) + nx * drift + Math.sin(i * 8.7 + timeSeconds * 8) * 18;
      const y = lerp(start.y, end.y, t) + ny * drift + Math.cos(i * 6.4 + timeSeconds * 7) * 16;
      const sparkLen = 16 + (i % 5) * 12 + slash * 18;
      const side = i % 2 ? -1 : 1;
      sparks.moveTo(x, y)
        .lineTo(x + dx / length * sparkLen + nx * side * 18, y + dy / length * sparkLen + ny * side * 18)
        .stroke({ color: i % 5 === 0 ? 0xffffff : accentColor, width: 1 + (i % 3) * 0.8, alpha: 0.035 + slash * 0.08 + flicker * 0.018 });
      if (i % 4 === 0) {
        sparks.circle(x - nx * side * 8, y - ny * side * 8, 1.4 + (i % 3) * 0.7).fill({ color: accentColor, alpha: 0.05 + afterglow * 0.045 });
      }
    }
    sparksLayer.addChild(sparks);

    const flashLayer = this.createFxLayer({ blendMode: "screen" });
    const flash = new this.pixi.Graphics();
    const flashAlpha = Math.max(0, 0.11 - p * 0.36) + Math.max(0, 1 - Math.abs(p - 0.16) * 9) * 0.055;
    flash.rect(0, 0, w, h).fill({ color: 0xffffff, alpha: flashAlpha });
    flashLayer.addChild(flash);

    const inkLayer = this.createFxLayer({ blendMode: "multiply", alpha: 0.32 });
    inkLayer.filters = [this.createBlurFilter(0.7, 2)].filter(Boolean);
    const ink = new this.pixi.Graphics();
    for (let i = 0; i < 18; i += 1) {
      const y = -80 + ((i * 89 + timeSeconds * 210) % (h + 180));
      const side = i % 2 ? -1 : 1;
      ink.moveTo(side > 0 ? w + 40 : -40, y)
        .lineTo(focus.x + side * (focus.rx * 0.72), focus.y + (y - h * 0.5) * 0.28)
        .stroke({ color: 0x020205, width: 2 + (i % 4) * 0.7, alpha: 0.018 + slash * 0.022 });
    }
    inkLayer.addChild(ink);

    this.restoreSpeedImpactFocus(options.panelTexture, options.camera, focus, 0.18);
  }

  drawPowerAuraProVfx(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#8a7dff";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeOutCubic(Math.min(progress / 0.8, 1));
    const pulse = 0.5 + Math.sin(timeSeconds * 2.4) * 0.5;
    const focus = { x: w * 0.5, y: h * 0.47, rx: w * 0.32, ry: h * 0.26 };

    this.drawPanelEcho(options.panelTexture, options.camera, {
      blendMode: "screen",
      alpha: 0.20 + pulse * 0.08,
      zoomBoost: 0.045 + pulse * 0.012,
      blur: 3.2,
      blurQuality: 3,
    });

    const aura = this.createFxLayer({ blendMode: "screen" });
    const g = new this.pixi.Graphics();
    const fill = this.createFillGradient({
      type: "radial",
      center: { x: focus.x / w, y: focus.y / h },
      innerRadius: 0.05,
      outerCenter: { x: 0.5, y: 0.47 },
      outerRadius: 0.72,
      colorStops: [
        { offset: 0, color: "rgba(255,255,255,0.16)" },
        { offset: 0.38, color: `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},0.16)` },
        { offset: 1, color: "rgba(255,255,255,0)" },
      ],
    });
    g.rect(0, 0, w, h).fill(fill || { color: accentColor, alpha: 0.08 });
    for (let i = 0; i < 7; i += 1) {
      g.ellipse(focus.x, focus.y, focus.rx * (0.75 + i * 0.18 + pulse * 0.08), focus.ry * (0.62 + i * 0.16 + pulse * 0.07))
        .stroke({ color: i % 2 ? accentColor : 0xffffff, width: 2 + (i % 3), alpha: (0.16 - i * 0.015) * p });
    }
    for (let i = 0; i < 30; i += 1) {
      const angle = (i / 30) * Math.PI * 2 + timeSeconds * (0.28 + (i % 4) * 0.025);
      const x = focus.x + Math.cos(angle) * (focus.rx * 1.05 + (i % 5) * 22);
      const y = focus.y + Math.sin(angle) * (focus.ry * 1.0 + (i % 6) * 18);
      g.circle(x, y, 2 + (i % 4)).fill({ color: i % 6 ? accentColor : 0xffffff, alpha: 0.09 + pulse * 0.09 });
    }
    aura.addChild(g);
    this.restoreSpeedImpactFocus(options.panelTexture, options.camera, focus, 0.86);
  }

  drawPowerAuraBurstProVfx(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#6fffb8";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = Math.min(Math.max(progress, 0), 1);
    const charge = easeOutCubic(Math.min(p / 0.78, 1));
    const pulse = 0.5 + Math.sin(timeSeconds * 3.4) * 0.5;
    const hotPulse = 0.5 + Math.sin(timeSeconds * 9.2) * 0.5;
    const surge = Math.sin(Math.min(p / 0.86, 1) * Math.PI);
    const focus = {
      x: w * (0.5 + Math.sin(timeSeconds * 0.72) * 0.012),
      y: h * (0.48 + Math.cos(timeSeconds * 0.62) * 0.01),
      rx: w * (0.31 + surge * 0.025),
      ry: h * (0.27 + surge * 0.018),
    };

    this.drawPanelEcho(options.panelTexture, options.camera, {
      blendMode: "screen",
      alpha: 0.065 + charge * 0.055 + pulse * 0.02,
      zoomBoost: 0.042 + charge * 0.03,
      panX: Math.sin(timeSeconds * 1.3) * 0.012,
      panY: -0.018 - surge * 0.018,
      rotation: Math.sin(timeSeconds * 0.8) * 0.004,
      blur: 3.0 + charge * 3.2,
      blurQuality: 4,
    });
    this.drawPanelEcho(options.panelTexture, options.camera, {
      blendMode: "multiply",
      alpha: 0.035 + charge * 0.028,
      zoomBoost: -0.012,
      panX: -0.014,
      panY: 0.018,
      blur: 0.45,
    });

    if (options.panelTexture) {
      const heatLayer = this.createFxLayer({ blendMode: "normal", alpha: 0.055 + charge * 0.085 });
      this.drawCoverSprite(options.panelTexture, heatLayer, {
        zoom: 1.12 + (options.camera?.zoom || 1) - 1 + surge * 0.045,
        panX: (options.camera?.panX || 0) + Math.sin(timeSeconds * 7.6) * charge * 0.008,
        panY: (options.camera?.panY || 0) - surge * 0.014 + Math.cos(timeSeconds * 7.2) * charge * 0.007,
        rotation: (options.camera?.rotation || 0) + Math.sin(timeSeconds * 3.7) * charge * 0.003,
        filters: [
          this.createHeatWaveFilter(timeSeconds, 0.0025 + charge * 0.006),
          this.createChromaticPulseFilter(timeSeconds, 0.001 + surge * 0.0024 + hotPulse * 0.0008),
          this.createBlurFilter(0.75 + surge * 0.8, 3),
        ].filter(Boolean),
      });
    }

    const shadeLayer = this.createFxLayer({ blendMode: "multiply", alpha: 0.44 });
    const shade = new this.pixi.Graphics();
    const shadeFill = this.createFillGradient({
      type: "linear",
      start: { x: 0.1, y: 0.18 },
      end: { x: 0.9, y: 0.92 },
      colorStops: [
        { offset: 0, color: "rgba(0,0,0,0.14)" },
        { offset: 0.36, color: "rgba(0,0,0,0.02)" },
        { offset: 0.62, color: "rgba(0,0,0,0.04)" },
        { offset: 1, color: "rgba(0,0,0,0.18)" },
      ],
    });
    shade.rect(0, 0, w, h).fill(shadeFill || { color: 0x050608, alpha: 0.16 });
    shade.rect(0, 0, w, h).stroke({ color: 0x020205, width: 48 + surge * 16, alpha: 0.065 + charge * 0.035 });
    shadeLayer.addChild(shade);

    const auraLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.38 });
    auraLayer.filters = [this.createBlurFilter(1.0 + surge * 0.7, 3)].filter(Boolean);
    const aura = new this.pixi.Graphics();
    const auraFill = this.createFillGradient({
      type: "linear",
      start: { x: 0.08, y: 1 },
      end: { x: 0.92, y: 0 },
      colorStops: [
        { offset: 0, color: "rgba(255,255,255,0)" },
        { offset: 0.18, color: `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},0.055)` },
        { offset: 0.52, color: "rgba(255,255,255,0.018)" },
        { offset: 0.82, color: `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},0.05)` },
        { offset: 1, color: "rgba(255,255,255,0)" },
      ],
    });
    aura.rect(0, 0, w, h).fill(auraFill || { color: accentColor, alpha: 0.1 + charge * 0.08 });
    for (let i = 0; i < 18; i += 1) {
      const lane = i / 17;
      const x1 = -70 + lane * (w + 140) + Math.sin(timeSeconds * 1.4 + i) * 22;
      const y1 = h + 70 + (i % 3) * 28;
      const x2 = x1 + Math.sin(i * 2.3) * 150 + (i % 2 ? -70 : 70);
      const y2 = h * (0.1 + (i % 5) * 0.07) - charge * 90;
      const width = 11 + (i % 5) * 7 + surge * 14;
      this.drawTaperedQuad(
        aura,
        x1,
        y1,
        x2,
        y2,
        width,
        1.2 + (i % 3),
        i % 6 === 0 ? 0xffffff : accentColor,
        0.014 + charge * 0.026 + (i % 6 === 0 ? 0.01 : 0),
      );
    }
    for (let i = 0; i < 7; i += 1) {
      const side = i % 2 ? -1 : 1;
      const x = side > 0 ? w + 20 : -20;
      const y = h * (0.24 + i * 0.1) + Math.sin(timeSeconds * 2.1 + i) * 22;
      this.drawTaperedQuad(
        aura,
        x,
        y + 110,
        focus.x + side * focus.rx * (0.68 + (i % 3) * 0.14),
        y - 90 - surge * 50,
        28 + (i % 4) * 8,
        3 + (i % 2) * 2,
        i % 3 === 0 ? 0xffffff : accentColor,
        0.01 + charge * 0.018,
      );
    }
    auraLayer.addChild(aura);

    const flameLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.34 });
    flameLayer.filters = [this.createBlurFilter(1.0 + charge * 0.95, 3)].filter(Boolean);
    const flames = new this.pixi.Graphics();
    for (let i = 0; i < 22; i += 1) {
      const lane = (i / 33 - 0.5) * 2;
      const sway = Math.sin(timeSeconds * (2.1 + (i % 5) * 0.18) + i) * (18 + charge * 18);
      const baseX = focus.x + lane * focus.rx * (0.3 + (i % 4) * 0.12) + sway;
      const baseY = h * (0.92 + (i % 3) * 0.018);
      const tipY = focus.y - focus.ry * (0.82 + (i % 5) * 0.18) - charge * 90 - hotPulse * 22;
      const width = 5 + (i % 4) * 3 + surge * 5;
      this.drawTaperedQuad(
        flames,
        baseX,
        baseY,
        baseX + Math.sin(i + timeSeconds * 4.2) * 30,
        tipY,
        width * 1.8,
        1.2,
        i % 5 === 0 ? 0xffffff : accentColor,
        0.012 + charge * 0.034 + (i % 5 === 0 ? 0.012 : 0),
      );
    }
    flameLayer.addChild(flames);

    const lightningLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.36 });
    lightningLayer.filters = [this.createBlurFilter(0.45, 2)].filter(Boolean);
    const lightning = new this.pixi.Graphics();
    for (let i = 0; i < 8; i += 1) {
      const side = i % 2 ? -1 : 1;
      const baseX = focus.x + side * focus.rx * (0.62 + (i % 3) * 0.18) + Math.sin(timeSeconds * 3.4 + i) * 28;
      const baseY = focus.y + focus.ry * (0.74 + (i % 4) * 0.16);
      lightning.moveTo(baseX, baseY);
      const segments = 5 + (i % 3);
      for (let j = 1; j <= segments; j += 1) {
        const step = j / segments;
        const x = baseX + side * (Math.sin(i * 4.7 + j * 2.4 + timeSeconds * 6.2) * (16 + step * 26));
        const y = baseY - step * (focus.ry * 1.7 + charge * 110) + Math.cos(j + timeSeconds * 4.1) * 12;
        lightning.lineTo(x, y);
      }
      lightning.stroke({
        color: i % 3 === 0 ? 0xffffff : accentColor,
        width: i % 3 === 0 ? 4 : 2.5,
        alpha: 0.035 + charge * 0.06 + hotPulse * 0.02,
      });
    }
    for (let i = 0; i < 5; i += 1) {
      const x = focus.x + (i - 2) * focus.rx * 0.32 + Math.sin(timeSeconds * 2.2 + i) * 18;
      const width = 24 + i * 7 + surge * 26;
      this.drawTaperedQuad(
        lightning,
        x,
        h + 40,
        x + Math.sin(timeSeconds * 3.8 + i) * 36,
        focus.y - focus.ry * (1.1 + i * 0.09),
        width,
        4 + i,
        i % 2 ? accentColor : 0xffffff,
        0.014 + charge * 0.026,
      );
    }
    lightningLayer.addChild(lightning);

    const rayLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.26 });
    rayLayer.filters = [this.createBlurFilter(0.65, 2)].filter(Boolean);
    const rays = new this.pixi.Graphics();
    for (let i = 0; i < 24; i += 1) {
      const angle = -Math.PI * 0.72 + (i / 23) * Math.PI * 1.44 + Math.sin(i * 2.7) * 0.04;
      if (Math.abs(Math.cos(angle)) < 0.14 && i % 4 !== 0) continue;
      const inner = focus.rx * (0.38 + (i % 5) * 0.06);
      const outer = h * (0.42 + charge * 0.18 + (i % 4) * 0.04);
      this.drawTaperedQuad(
        rays,
        focus.x + Math.cos(angle) * inner,
        focus.y + Math.sin(angle) * inner * 0.72,
        focus.x + Math.cos(angle) * outer,
        focus.y + Math.sin(angle) * outer,
        1,
        10 + (i % 4) * 4 + surge * 6,
        i % 5 === 0 ? 0xffffff : accentColor,
        0.012 + charge * 0.022,
      );
    }
    rayLayer.addChild(rays);

    const particleLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.34 });
    const particles = new this.pixi.Graphics();
    for (let i = 0; i < 44; i += 1) {
      const depth = (i % 8) / 7;
      const speed = 72 + depth * 160 + charge * 80;
      const x = focus.x + Math.sin(i * 1.87 + timeSeconds * (0.7 + depth)) * (focus.rx * (0.48 + depth * 0.8));
      const y = h + 80 - ((i * 67 + timeSeconds * speed) % (h + 220));
      const size = 1.4 + depth * 4.2 + hotPulse * 1.3;
      const nearFocus = Math.abs(x - focus.x) < focus.rx * 0.95 && Math.abs(y - focus.y) < focus.ry * 1.12;
      particles.circle(x, y, size).fill({ color: i % 7 === 0 ? 0xffffff : accentColor, alpha: nearFocus ? 0.016 + depth * 0.012 : 0.026 + depth * 0.024 });
    }
    particleLayer.addChild(particles);

    const brushLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.24 });
    brushLayer.filters = [this.createBlurFilter(0.9, 2)].filter(Boolean);
    const brush = new this.pixi.Graphics();
    const brushAccent = 0xffe64d;
    [
      { x1: -80, y1: h * 0.2, x2: w * 0.72, y2: h * 0.03, start: 52, end: 14, color: brushAccent, alpha: 0.08 },
      { x1: w * 0.12, y1: h * 0.98, x2: w * 1.1, y2: h * 0.62, start: 34, end: 110, color: accentColor, alpha: 0.07 },
      { x1: -70, y1: h * 0.7, x2: w * 0.82, y2: h * 0.38, start: 24, end: 60, color: 0xffffff, alpha: 0.055 },
      { x1: w + 40, y1: h * 0.36, x2: w * 0.24, y2: h * 0.82, start: 30, end: 72, color: accentColor, alpha: 0.06 },
    ].forEach((stroke, index) => {
      const wobble = Math.sin(timeSeconds * (1.6 + index * 0.2) + index) * 18;
      this.drawTaperedQuad(
        brush,
        stroke.x1,
        stroke.y1 + wobble,
        stroke.x2,
        stroke.y2 - wobble * 0.6,
        stroke.start * 0.52 + surge * 6,
        stroke.end * 0.54 + hotPulse * 4,
        stroke.color,
        stroke.alpha * 0.32 + charge * 0.008,
      );
    });
    brushLayer.addChild(brush);

    const flashLayer = this.createFxLayer({ blendMode: "screen" });
    const flash = new this.pixi.Graphics();
    const flashAlpha = Math.max(0, 0.045 - p * 0.12) + Math.max(0, 1 - Math.abs(p - 0.72) * 8) * 0.026;
    flash.rect(0, 0, w, h).fill({ color: 0xffffff, alpha: flashAlpha });
    flashLayer.addChild(flash);

    const clarity = new this.pixi.Graphics();
    clarity.blendMode = "multiply";
    clarity.rect(0, h * 0.34, w, h * 0.3).fill({ color: 0x020205, alpha: 0.025 });
    this.root.addChild(clarity);
  }

  drawHeroHalftoneProVfx(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ffd84d";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeOutCubic(Math.min(progress / 0.7, 1));
    const focus = { x: w * 0.5, y: h * 0.47, rx: w * 0.34, ry: h * 0.28 };

    const halftoneLayer = this.createFxLayer({ blendMode: "multiply", alpha: 0.18 + p * 0.16 });
    const dots = new this.pixi.Sprite(this.textureHalftone());
    dots.tint = accentColor;
    dots.width = w;
    dots.height = h;
    dots.x = Math.sin(timeSeconds * 0.8) * 8;
    dots.y = Math.cos(timeSeconds * 0.7) * 8;
    dots.scale.set(2.04 + Math.sin(timeSeconds * 1.1) * 0.03);
    halftoneLayer.addChild(dots);

    this.drawPanelEcho(options.panelTexture, options.camera, {
      blendMode: "screen",
      alpha: 0.15 + p * 0.12,
      zoomBoost: 0.03,
      blur: 1.4,
    });

    const pop = this.createFxLayer({ blendMode: "screen" });
    const g = new this.pixi.Graphics();
    g.ellipse(focus.x, focus.y, focus.rx * (1.1 + p * 0.12), focus.ry * (0.88 + p * 0.08))
      .stroke({ color: 0xffffff, width: 4, alpha: 0.10 + p * 0.08 });
    g.ellipse(focus.x, focus.y, focus.rx * (1.55 + p * 0.16), focus.ry * (1.14 + p * 0.1))
      .stroke({ color: accentColor, width: 3, alpha: 0.13 });
    for (let i = 0; i < 14; i += 1) {
      const angle = (i / 14) * Math.PI * 2 + timeSeconds * 0.08;
      const x1 = focus.x + Math.cos(angle) * focus.rx * 1.05;
      const y1 = focus.y + Math.sin(angle) * focus.ry * 0.86;
      const x2 = focus.x + Math.cos(angle) * (focus.rx * 1.65 + (i % 3) * 22);
      const y2 = focus.y + Math.sin(angle) * (focus.ry * 1.32 + (i % 4) * 16);
      g.moveTo(x1, y1).lineTo(x2, y2).stroke({ color: i % 3 ? accentColor : 0xffffff, width: 3 + (i % 3), alpha: 0.09 + p * 0.08 });
    }
    pop.addChild(g);
    this.restoreSpeedImpactFocus(options.panelTexture, options.camera, focus, 0.82);
  }

  drawRomanceSoftGlowProVfx(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ff8ed6";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(progress, 1));
    const breath = 0.5 + Math.sin(timeSeconds * 0.92) * 0.5;
    const focus = {
      x: w * (0.49 + Math.sin(timeSeconds * 0.24) * 0.025),
      y: h * (0.45 + Math.cos(timeSeconds * 0.2) * 0.016),
      rx: w * 0.34,
      ry: h * 0.27,
    };

    const bloomFilters = [this.createBlurFilter(5.5, 4), this.createChromaticPulseFilter(timeSeconds, 0.0015)].filter(Boolean);
    if (options.panelTexture) {
      const bloomLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.28 + breath * 0.09 });
      this.drawCoverSprite(options.panelTexture, bloomLayer, {
        zoom: 1.16 + (options.camera?.zoom || 1) - 1 + p * 0.03,
        panX: (options.camera?.panX || 0) + Math.sin(timeSeconds * 0.26) * 0.012,
        panY: (options.camera?.panY || 0) - 0.012,
        rotation: (options.camera?.rotation || 0) * 0.4,
        filters: bloomFilters,
      });
    }

    const wash = new this.pixi.Graphics();
    const washFill = this.createFillGradient({
      type: "radial",
      center: { x: focus.x / w, y: focus.y / h },
      innerRadius: 0.06,
      outerCenter: { x: 0.5, y: 0.5 },
      outerRadius: 0.94,
      colorStops: [
        { offset: 0, color: "rgba(255,255,255,0.14)" },
        { offset: 0.4, color: `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},0.10)` },
        { offset: 0.82, color: "rgba(255,214,175,0.08)" },
        { offset: 1, color: "rgba(11,8,20,0.10)" },
      ],
    });
    wash.rect(0, 0, w, h).fill(washFill || { color: accentColor, alpha: 0.07 });
    wash.blendMode = "screen";
    this.root.addChild(wash);

    const rays = this.createFxLayer({ blendMode: "screen" });
    const g = new this.pixi.Graphics();
    this.drawTaperedQuad(g, -90, h * 0.2, w * 0.86, h * 0.04, 120, 22, 0xffffff, 0.055 + breath * 0.035);
    this.drawTaperedQuad(g, w * 0.08, h * 1.03, w * 1.08, h * 0.58, 30, 138, accentColor, 0.036 + breath * 0.022);
    g.ellipse(focus.x, focus.y, focus.rx * (1.28 + breath * 0.07), focus.ry * (1.02 + breath * 0.05))
      .stroke({ color: 0xffffff, width: 3, alpha: 0.09 });
    rays.addChild(g);

    const particles = this.createFxLayer({ blendMode: "screen" });
    const dust = new this.pixi.Graphics();
    for (let i = 0; i < 54; i += 1) {
      const depth = (i % 7) / 6;
      const x = 34 + ((i * 89 + timeSeconds * (14 + depth * 34)) % (w - 68));
      const y = 80 + ((i * 163 - timeSeconds * (18 + depth * 42)) % (h - 160));
      const nearFocus = Math.abs(x - focus.x) < focus.rx * 0.88 && Math.abs(y - focus.y) < focus.ry * 0.82;
      const alpha = nearFocus ? 0.035 : 0.075 + depth * 0.048;
      if (i % 8 === 0) dust.ellipse(x, y, 3 + depth * 4, 12 + depth * 12).fill({ color: 0xffd8b2, alpha });
      else dust.circle(x, y, 1.5 + depth * 4.5).fill({ color: i % 5 === 0 ? 0xffffff : accentColor, alpha });
    }
    particles.addChild(dust);

    this.restoreSpeedImpactFocus(options.panelTexture, options.camera, focus, 0.88);
  }

  drawHorrorDarkPulseProVfx(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#9b0f24";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(progress, 1));
    const pulse = 0.5 + Math.sin(timeSeconds * 1.65) * 0.5;
    const focus = {
      x: w * (0.5 + Math.sin(timeSeconds * 0.44) * 0.018),
      y: h * (0.47 + Math.cos(timeSeconds * 0.41) * 0.014),
      rx: w * 0.34,
      ry: h * 0.28,
    };

    const tear = this.createVhsTearFilter(timeSeconds, 0.004 + pulse * 0.012);
    const chroma = this.createChromaticPulseFilter(timeSeconds, 0.003 + pulse * 0.006);
    if (options.panelTexture) {
      const distortion = this.createFxLayer({ blendMode: "normal", alpha: 0.24 + pulse * 0.14 });
      this.drawCoverSprite(options.panelTexture, distortion, {
        zoom: 1.12 + (options.camera?.zoom || 1) - 1 + pulse * 0.03,
        panX: (options.camera?.panX || 0) + Math.sin(timeSeconds * 2.1) * 0.012,
        panY: (options.camera?.panY || 0) + Math.cos(timeSeconds * 1.8) * 0.01,
        rotation: (options.camera?.rotation || 0) * 0.6,
        filters: [tear, chroma].filter(Boolean),
      });
      this.drawPanelEcho(options.panelTexture, options.camera, {
        blendMode: "multiply",
        alpha: 0.26 + pulse * 0.1,
        zoomBoost: 0.04 + pulse * 0.018,
        panX: -0.014,
        panY: 0.01,
        blur: 2.4,
      });
    }

    const dark = new this.pixi.Graphics();
    const shade = this.createFillGradient({
      type: "radial",
      center: { x: focus.x / w, y: focus.y / h },
      innerRadius: 0.14,
      outerCenter: { x: 0.5, y: 0.53 },
      outerRadius: 0.9,
      colorStops: [
        { offset: 0, color: "rgba(0,0,0,0)" },
        { offset: 0.54, color: "rgba(0,0,0,0.16)" },
        { offset: 1, color: `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},${0.22 + pulse * 0.08})` },
      ],
    });
    dark.rect(0, 0, w, h).fill(shade || { color: 0x050505, alpha: 0.24 });
    dark.blendMode = "multiply";
    this.root.addChild(dark);

    const noise = this.textureNoise();
    const grainLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.06 + pulse * 0.04 });
    const grain = new this.pixi.Sprite(noise);
    grain.width = w;
    grain.height = h;
    grain.x = Math.sin(timeSeconds * 11) * 18;
    grain.y = Math.cos(timeSeconds * 13) * 18;
    grainLayer.addChild(grain);

    const creepLayer = this.createFxLayer({ blendMode: "multiply" });
    const creep = new this.pixi.Graphics();
    for (let i = 0; i < 9; i += 1) {
      const left = i % 2 === 0;
      const y = 110 + i * 132 + Math.sin(timeSeconds * 1.2 + i) * 28;
      const x0 = left ? -70 : w + 70;
      const x1 = left ? w * (0.18 + p * 0.08) : w * (0.82 - p * 0.08);
      const x2 = left ? w * 0.42 : w * 0.58;
      creep.moveTo(x0, y)
        .quadraticCurveTo(x1, y - 90 + pulse * 40, x2, y + 26)
        .stroke({ color: 0x000000, width: 24 + (i % 3) * 10, alpha: 0.045 + pulse * 0.035 });
    }
    creepLayer.addChild(creep);

    const glints = this.createFxLayer({ blendMode: "screen" });
    const g = new this.pixi.Graphics();
    g.ellipse(focus.x, focus.y, focus.rx * (1.1 + pulse * 0.12), focus.ry * (0.96 + pulse * 0.08))
      .stroke({ color: 0xffffff, width: 2, alpha: 0.04 + pulse * 0.045 });
    for (let i = 0; i < 12; i += 1) {
      const alpha = Math.max(0, Math.sin(timeSeconds * 3.2 + i)) * 0.07;
      const x = 60 + ((i * 167 + timeSeconds * 18) % (w - 120));
      const y = 130 + ((i * 211) % (h - 260));
      g.circle(x, y, 1.5 + (i % 3)).fill({ color: i % 3 ? accentColor : 0xffffff, alpha });
    }
    glints.addChild(g);

    this.restoreSpeedImpactFocus(options.panelTexture, options.camera, focus, 0.9);
  }

  drawSpeedLineImpactPro(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ffd84d";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const cx = w * 0.54 + Math.sin(timeSeconds * 5.4) * 5;
    const cy = h * 0.47 + Math.cos(timeSeconds * 4.8) * 7;
    const pulse = 0.5 + Math.sin(timeSeconds * 10) * 0.5;
    const intro = easeOutCubic(Math.min(progress / 0.22, 1));
    const focus = this.speedImpactFocus(progress, timeSeconds);

    this.drawPanelEcho(options.panelTexture, options.camera, {
      blendMode: "multiply",
      alpha: 0.18 * intro,
      panX: -0.018,
      panY: 0.012,
      zoomBoost: 0.018,
      blur: 1.1,
    });
    this.drawPanelEcho(options.panelTexture, options.camera, {
      blendMode: "screen",
      alpha: 0.12 * intro,
      panX: 0.022,
      panY: -0.01,
      zoomBoost: 0.03,
      blur: 0.55,
    });

    this.drawSpeedImpactLighting(accentColor, cx, cy, pulse, intro);

    const aperture = this.createFxLayer({ blendMode: "multiply" });
    const apertureGraphics = new this.pixi.Graphics();
    apertureGraphics.rect(0, 0, w, h).stroke({ color: 0x020204, width: 118, alpha: 0.18 * intro });
    apertureGraphics.ellipse(focus.x, focus.y, focus.rx * 1.2, focus.ry * 1.0)
      .stroke({ color: 0x020204, width: 18, alpha: 0.055 * intro });
    aperture.addChild(apertureGraphics);

    const shadowLayer = this.createFxLayer({ blendMode: "multiply" });
    const shadow = new this.pixi.Graphics();
    for (let i = 0; i < 18; i += 1) {
      const angle = -Math.PI * 0.88 + (i / 17) * Math.PI * 1.76 + Math.sin(i * 8.17) * 0.018;
      if (Math.abs(Math.cos(angle)) < 0.22 && i % 4 !== 0) continue;
      const inner = 360 + (i % 5) * 36 + pulse * 14;
      const outer = 880 + (i % 8) * 44;
      const width = 5 + (i % 4) * 2.2;
      const alpha = 0.09 + (i % 4) * 0.018;
      this.drawTaperedQuad(
        shadow,
        cx + Math.cos(angle) * inner,
        cy + Math.sin(angle) * inner,
        cx + Math.cos(angle) * outer,
        cy + Math.sin(angle) * outer,
        width * 0.28,
        width,
        0x020204,
        alpha * intro,
      );
    }
    shadowLayer.addChild(shadow);

    const energyLayer = this.createFxLayer({ blendMode: "screen" });
    const energy = new this.pixi.Graphics();
    for (let i = 0; i < 20; i += 1) {
      const angle = -Math.PI * 0.82 + (i / 19) * Math.PI * 1.64 + Math.sin(timeSeconds * 1.8 + i) * 0.012;
      if (Math.abs(Math.cos(angle)) < 0.18 && i % 5 !== 0) continue;
      const inner = 355 + (i % 6) * 30;
      const outer = 800 + ((i * 37) % 230);
      const width = 2 + (i % 4) * 1.35;
      const color = i % 5 === 0 ? 0xffffff : i % 3 === 0 ? 0xff335f : accentColor;
      const alpha = (i % 5 === 0 ? 0.13 : 0.085) * intro;
      this.drawTaperedQuad(
        energy,
        cx + Math.cos(angle) * inner,
        cy + Math.sin(angle) * inner,
        cx + Math.cos(angle) * outer,
        cy + Math.sin(angle) * outer,
        Math.max(1.5, width * 0.2),
        width,
        color,
        alpha,
      );
    }
    energyLayer.addChild(energy);

    const rimLayer = this.createFxLayer({ blendMode: "screen" });
    const rim = new this.pixi.Graphics();
    for (let i = 0; i < 9; i += 1) {
      const side = i % 2 === 0 ? -1 : 1;
      const x = side < 0 ? 26 + (i % 3) * 14 : w - 26 - (i % 3) * 14;
      const y = 80 + i * 132 + ((timeSeconds * 210) % 90);
      rim.moveTo(x, y - 160)
        .lineTo(x + side * 78, y + 180)
        .stroke({ color: i % 3 === 0 ? 0xffffff : accentColor, width: 5 + (i % 3) * 2, alpha: 0.12 * intro });
    }
    rimLayer.addChild(rim);

    const diagonalLayer = this.createFxLayer({ blendMode: "screen" });
    const diagonal = new this.pixi.Graphics();
    for (let i = 0; i < 5; i += 1) {
      const y = -120 + i * 180 + ((timeSeconds * 150 + i * 31) % 74);
      const offset = (i % 4) * 34;
      const bandWidth = i % 3 === 0 ? 7 : 2.6;
      this.drawTaperedQuad(diagonal, -120 - offset, y + 130, w + 160, y - 310, bandWidth, bandWidth * 0.35, i % 3 === 0 ? accentColor : 0xffffff, i % 3 === 0 ? 0.08 : 0.075);
    }
    diagonalLayer.addChild(diagonal);

    this.drawSpeedImpactEdgeVignette();
    this.restoreSpeedImpactFocus(options.panelTexture, options.camera, focus, intro);

    const impactLayer = this.createFxLayer({ blendMode: "screen" });
    const impact = new this.pixi.Graphics();
    impact.ellipse(cx, cy, 92 + pulse * 18, 62 + pulse * 12).stroke({ color: 0xffffff, width: 3, alpha: 0.11 * intro });
    impact.ellipse(cx, cy, 168 + pulse * 24, 112 + pulse * 16).stroke({ color: accentColor, width: 3, alpha: 0.10 * intro });
    impact.ellipse(cx, cy, 258 + pulse * 34, 170 + pulse * 22).stroke({ color: 0xff335f, width: 2, alpha: 0.075 * intro });
    impactLayer.addChild(impact);

    const inkLayer = this.createFxLayer({ blendMode: "multiply" });
    const inkHatch = new this.pixi.Graphics();
    for (let i = 0; i < 16; i += 1) {
      const y = 64 + i * 58 + Math.sin(timeSeconds * 3.4 + i) * 8;
      const width = 2 + (i % 3);
      inkHatch.moveTo(-40, y).lineTo(w + 40, y - 210 - (i % 5) * 14).stroke({ color: 0x000000, width, alpha: 0.032 });
    }
    inkLayer.addChild(inkHatch);

    const flash = new this.pixi.Graphics();
    flash.blendMode = "screen";
    flash.rect(0, 0, w, h).fill({ color: 0xffffff, alpha: Math.max(0, 0.10 - progress * 0.36) });
    this.root.addChild(flash);
  }

  restoreSpeedImpactFocus(texture, camera = {}, focus, intro = 1) {
    if (!texture || !focus) return;
    const layer = new this.pixi.Container();
    layer.alpha = 0.34 + intro * 0.12;
    layer.filters = [this.createBlurFilter(0.35, 2)].filter(Boolean);
    const mask = new this.pixi.Graphics();
    mask.ellipse(focus.x, focus.y, focus.rx, focus.ry).fill(0xffffff);
    layer.mask = mask;
    this.root.addChild(layer, mask);
    this.drawCoverSprite(texture, layer, {
      zoom: (1.08 + (camera.zoom || 1) - 1),
      panX: camera.panX || 0,
      panY: camera.panY || 0,
      rotation: camera.rotation || 0,
    });
  }

  restoreGlitchSignalFocus(texture, camera = {}, focus, timeSeconds = 0, intro = 1) {
    if (!texture || !focus) return;
    const layer = new this.pixi.Container();
    layer.alpha = 0.72 + intro * 0.14;
    const mask = new this.pixi.Graphics();
    const strips = 7;
    for (let i = 0; i < strips; i += 1) {
      const row = (i / (strips - 1)) - 0.5;
      const wobble = Math.sin(timeSeconds * 8 + i * 1.7) * (4 + (i % 3) * 3);
      const height = focus.ry * (0.16 + (i % 3) * 0.018);
      const width = focus.rx * (1.3 - Math.abs(row) * 0.48 + (i % 2) * 0.14);
      const x = focus.x - width / 2 + wobble + (i % 3 - 1) * 10;
      const y = focus.y + row * focus.ry * 1.34;
      mask.rect(x, y, width, height).fill(0xffffff);
    }
    mask.rect(focus.x - focus.rx * 0.56, focus.y - focus.ry * 0.54, focus.rx * 1.12, focus.ry * 0.22).fill(0xffffff);
    mask.rect(focus.x - focus.rx * 0.62, focus.y + focus.ry * 0.34, focus.rx * 1.18, focus.ry * 0.2).fill(0xffffff);
    layer.mask = mask;
    this.root.addChild(layer, mask);
    this.drawCoverSprite(texture, layer, {
      zoom: (1.08 + (camera.zoom || 1) - 1),
      panX: camera.panX || 0,
      panY: camera.panY || 0,
      rotation: camera.rotation || 0,
    });

    const edgeLayer = this.createFxLayer({ blendMode: "screen", alpha: 0.78 });
    const edge = new this.pixi.Graphics();
    const accent = 0x42f5ff;
    for (let i = 0; i < 8; i += 1) {
      const y = focus.y - focus.ry * 0.58 + i * focus.ry * 0.17 + Math.sin(timeSeconds * 11 + i) * 5;
      edge.rect(focus.x - focus.rx * 0.66 + (i % 2) * 24, y, focus.rx * (1.05 - (i % 3) * 0.12), 2)
        .fill({ color: i % 3 === 0 ? 0xffffff : accent, alpha: 0.09 + (i % 3) * 0.025 });
    }
    edgeLayer.addChild(edge);
  }

  restoreHorrorSlitFocus(texture, camera = {}, options = {}) {
    if (!texture) return;
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const layer = new this.pixi.Container();
    layer.alpha = options.alpha ?? 0.82;
    const mask = new this.pixi.Graphics();
    const centerY = options.y ?? h * 0.47;
    const width = options.width ?? w * 0.72;
    const height = options.height ?? h * 0.16;
    const skew = options.skew ?? -42;
    mask.moveTo(w * 0.5 - width * 0.5, centerY - height * 0.5)
      .lineTo(w * 0.5 + width * 0.5, centerY - height * 0.5 + skew * 0.12)
      .lineTo(w * 0.5 + width * 0.46, centerY + height * 0.5)
      .lineTo(w * 0.5 - width * 0.54, centerY + height * 0.5 - skew * 0.12)
      .closePath()
      .fill(0xffffff);
    layer.mask = mask;
    this.root.addChild(layer, mask);
    this.drawCoverSprite(texture, layer, {
      zoom: (1.08 + (camera.zoom || 1) - 1) + (options.zoomBoost || 0),
      panX: (camera.panX || 0) + (options.panX || 0),
      panY: (camera.panY || 0) + (options.panY || 0),
      rotation: (camera.rotation || 0) + (options.rotation || 0),
    });
  }

  restoreHorrorVerticalTear(texture, camera = {}, timeSeconds = 0, options = {}) {
    if (!texture) return;
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const layer = new this.pixi.Container();
    layer.alpha = options.alpha ?? 0.76;
    const mask = new this.pixi.Graphics();
    const x = options.x ?? w * 0.5;
    const width = options.width ?? w * 0.2;
    mask.moveTo(x - width * 0.42 + Math.sin(timeSeconds * 2.2) * 8, h * 0.08)
      .quadraticCurveTo(x - width * 0.7, h * 0.32, x - width * 0.36, h * 0.5)
      .quadraticCurveTo(x - width * 0.12, h * 0.72, x - width * 0.5, h * 0.94)
      .lineTo(x + width * 0.34 + Math.cos(timeSeconds * 2.5) * 8, h * 0.96)
      .quadraticCurveTo(x + width * 0.68, h * 0.66, x + width * 0.28, h * 0.48)
      .quadraticCurveTo(x + width * 0.04, h * 0.28, x + width * 0.46, h * 0.08)
      .closePath()
      .fill(0xffffff);
    layer.mask = mask;
    this.root.addChild(layer, mask);
    this.drawCoverSprite(texture, layer, {
      zoom: (1.08 + (camera.zoom || 1) - 1) + (options.zoomBoost || 0),
      panX: (camera.panX || 0) + (options.panX || 0),
      panY: (camera.panY || 0) + (options.panY || 0),
      rotation: (camera.rotation || 0) + (options.rotation || 0),
    });
  }

  drawImpactZoomPro(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#e44d35";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const hit = Math.max(0, 1 - Math.min(progress / 0.3, 1));
    const p = easeOutCubic(Math.min(progress / 0.82, 1));
    const pulse = Math.sin(Math.min(progress * 2.2, 1) * Math.PI);
    const cx = w * 0.52 + Math.sin(timeSeconds * 10) * 6 * hit;
    const cy = h * 0.48 + Math.cos(timeSeconds * 9) * 7 * hit;
    const focus = {
      x: cx,
      y: cy + h * 0.03,
      rx: w * 0.32,
      ry: h * 0.24,
    };

    this.drawImpactZoomLighting(accentColor, cx, cy, hit, pulse);

    const burstLayer = this.createFxLayer({ blendMode: "multiply" });
    const burst = new this.pixi.Graphics();
    const rays = 42;
    for (let i = 0; i < rays; i += 1) {
      const angle = (i / rays) * Math.PI * 2 + Math.sin(i * 4.11) * 0.025;
      const inner = 170 + (i % 4) * 18 + p * 80;
      const outer = 680 + (i % 7) * 62 + hit * 140;
      const width = 6 + (i % 5) * 4;
      this.drawTaperedQuad(
        burst,
        cx + Math.cos(angle) * inner,
        cy + Math.sin(angle) * inner,
        cx + Math.cos(angle) * outer,
        cy + Math.sin(angle) * outer,
        width * 0.2,
        width,
        0x050505,
        0.18 + hit * 0.18,
      );
    }
    burstLayer.addChild(burst);

    const hotLayer = this.createFxLayer({ blendMode: "screen" });
    const hot = new this.pixi.Graphics();
    for (let i = 0; i < 24; i += 1) {
      const angle = (i / 24) * Math.PI * 2 + timeSeconds * 0.06;
      const inner = 145 + p * 120;
      const outer = 420 + pulse * 210 + (i % 4) * 42;
      const color = i % 4 === 0 ? 0xffffff : accentColor;
      this.drawTaperedQuad(
        hot,
        cx + Math.cos(angle) * inner,
        cy + Math.sin(angle) * inner,
        cx + Math.cos(angle) * outer,
        cy + Math.sin(angle) * outer,
        1.6,
        4 + (i % 3) * 2,
        color,
        i % 4 === 0 ? 0.26 : 0.18,
      );
    }
    hotLayer.addChild(hot);

    const rings = new this.pixi.Graphics();
    rings.blendMode = "screen";
    rings.circle(cx, cy, 74 + p * 64).stroke({ color: 0xffffff, width: 4, alpha: 0.16 + hit * 0.16 });
    rings.circle(cx, cy, 138 + p * 102).stroke({ color: accentColor, width: 3, alpha: 0.14 });
    this.root.addChild(rings);

    this.restoreSpeedImpactFocus(options.panelTexture, options.camera, focus, 0.72);

    const foregroundHit = new this.pixi.Graphics();
    foregroundHit.blendMode = "screen";
    foregroundHit.circle(cx, cy, 54 + pulse * 20).stroke({ color: 0xffffff, width: 4, alpha: 0.14 });
    foregroundHit.moveTo(cx - 210, cy - 16).lineTo(cx - 72, cy - 6).stroke({ color: 0xffffff, width: 5, alpha: 0.18 });
    foregroundHit.moveTo(cx + 72, cy + 8).lineTo(cx + 220, cy + 24).stroke({ color: 0xffffff, width: 5, alpha: 0.18 });
    foregroundHit.moveTo(cx - 16, cy - 220).lineTo(cx - 6, cy - 84).stroke({ color: accentColor, width: 5, alpha: 0.18 });
    foregroundHit.moveTo(cx + 10, cy + 86).lineTo(cx + 34, cy + 236).stroke({ color: accentColor, width: 5, alpha: 0.18 });
    this.root.addChild(foregroundHit);

    const flash = new this.pixi.Graphics();
    flash.blendMode = "screen";
    flash.rect(0, 0, w, h).fill({ color: 0xffffff, alpha: Math.max(0, 0.22 - progress * 0.42) });
    flash.circle(cx, cy, 190 + hit * 90).fill({ color: accentColor, alpha: 0.075 + hit * 0.06 });
    this.root.addChild(flash);

    const ink = new this.pixi.Graphics();
    ink.blendMode = "multiply";
    for (let i = 0; i < 16; i += 1) {
      const angle = -0.9 + i * 0.12;
      const y = cy + Math.sin(i) * 220;
      ink.moveTo(-30, y).lineTo(w + 30, y + Math.sin(angle) * 160).stroke({ color: 0x000000, width: 2 + (i % 3), alpha: 0.055 });
    }
    this.root.addChild(ink);
  }

  drawImpactZoomLighting(accentColor, cx, cy, hit, pulse) {
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const shadow = new this.pixi.Graphics();
    const shadowGradient = this.createFillGradient({
      type: "radial",
      center: { x: cx / w, y: cy / h },
      innerRadius: 0.08,
      outerCenter: { x: 0.5, y: 0.5 },
      outerRadius: 0.86,
      colorStops: [
        { offset: 0, color: "rgba(0,0,0,0)" },
        { offset: 0.54, color: "rgba(0,0,0,0.05)" },
        { offset: 1, color: "rgba(0,0,0,0.38)" },
      ],
    });
    shadow.rect(0, 0, w, h).fill(shadowGradient || { color: 0x050505, alpha: 0.16 });
    shadow.blendMode = "multiply";
    this.root.addChild(shadow);

    const light = new this.pixi.Graphics();
    const lightGradient = this.createFillGradient({
      type: "radial",
      center: { x: cx / w, y: cy / h },
      innerRadius: 0.02,
      outerCenter: { x: cx / w, y: cy / h },
      outerRadius: 0.48,
      colorStops: [
        { offset: 0, color: "rgba(255,255,255,0.20)" },
        { offset: 0.28, color: `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},${0.18 + hit * 0.1})` },
        { offset: 1, color: "rgba(255,255,255,0)" },
      ],
    });
    light.rect(0, 0, w, h).fill(lightGradient || { color: accentColor, alpha: 0.09 + pulse * 0.05 });
    light.blendMode = "screen";
    this.root.addChild(light);
  }

  drawPowerAuraBurstPro(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ffd84d";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeOutCubic(Math.min(progress / 0.86, 1));
    const pulse = 0.5 + Math.sin(timeSeconds * 8) * 0.5;
    const cx = w * 0.5 + Math.sin(timeSeconds * 1.6) * 10;
    const cy = h * 0.45 + Math.cos(timeSeconds * 1.4) * 8;
    const focus = {
      x: cx,
      y: cy + h * 0.02,
      rx: w * 0.34,
      ry: h * 0.28,
    };

    const grade = new this.pixi.Graphics();
    const gradeFill = this.createFillGradient({
      type: "radial",
      center: { x: cx / w, y: cy / h },
      innerRadius: 0.05,
      outerCenter: { x: 0.5, y: 0.5 },
      outerRadius: 0.78,
      colorStops: [
        { offset: 0, color: "rgba(255,255,255,0.10)" },
        { offset: 0.34, color: `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},0.13)` },
        { offset: 1, color: "rgba(0,0,0,0.26)" },
      ],
    });
    grade.rect(0, 0, w, h).fill(gradeFill || { color: accentColor, alpha: 0.08 });
    grade.blendMode = "screen";
    this.root.addChild(grade);

    const auraLayer = this.createFxLayer({ blendMode: "screen" });
    const aura = new this.pixi.Graphics();
    for (let i = 0; i < 5; i += 1) {
      const rx = 96 + i * 54 + p * 36 + pulse * 14;
      const ry = 150 + i * 70 + p * 48 + pulse * 20;
      aura.ellipse(cx, cy, rx, ry)
        .stroke({ color: i === 0 ? 0xffffff : accentColor, width: i === 0 ? 4 : 3, alpha: 0.26 - i * 0.028 });
    }
    auraLayer.addChild(aura);

    const rayLayer = this.createFxLayer({ blendMode: "screen" });
    const rays = new this.pixi.Graphics();
    for (let i = 0; i < 34; i += 1) {
      const angle = (Math.PI * 2 * i) / 34 + Math.sin(i * 5.7) * 0.035 + timeSeconds * 0.035;
      const inner = 118 + (i % 5) * 18;
      const outer = 480 + p * 150 + (i % 7) * 28;
      const width = 2 + (i % 4) * 1.8;
      if (Math.abs(Math.cos(angle)) < 0.14 && i % 3 !== 0) continue;
      this.drawTaperedQuad(
        rays,
        cx + Math.cos(angle) * inner,
        cy + Math.sin(angle) * inner,
        cx + Math.cos(angle) * outer,
        cy + Math.sin(angle) * outer,
        1.2,
        width,
        i % 5 === 0 ? 0xffffff : accentColor,
        i % 5 === 0 ? 0.14 : 0.11,
      );
    }
    rayLayer.addChild(rays);

    this.restoreSpeedImpactFocus(options.panelTexture, options.camera, focus, 0.68);

    const particleLayer = this.createFxLayer({ blendMode: "screen" });
    const particles = new this.pixi.Graphics();
    for (let i = 0; i < 38; i += 1) {
      const angle = (Math.PI * 2 * i) / 38 + timeSeconds * (0.18 + (i % 4) * 0.02);
      const radius = 160 + (i % 6) * 42 + Math.sin(timeSeconds * 2 + i) * 14;
      const x = cx + Math.cos(angle) * radius;
      const y = cy + Math.sin(angle) * radius * 1.28;
      particles.circle(x, y, 2 + (i % 4)).fill({ color: i % 6 === 0 ? 0xffffff : accentColor, alpha: 0.18 + (i % 4) * 0.035 });
    }
    particleLayer.addChild(particles);

    const core = new this.pixi.Graphics();
    core.blendMode = "screen";
    core.circle(cx, cy, 54 + pulse * 15).stroke({ color: 0xffffff, width: 4, alpha: 0.22 });
    core.circle(cx, cy, 96 + pulse * 20).stroke({ color: accentColor, width: 3, alpha: 0.18 });
    core.circle(cx, cy, 150 + pulse * 28).stroke({ color: accentColor, width: 2, alpha: 0.12 });
    this.root.addChild(core);
  }

  drawSpeedImpactLighting(accentColor, cx, cy, pulse, intro) {
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;

    const grade = new this.pixi.Graphics();
    const shadowGradient = this.createFillGradient({
      type: "radial",
      center: { x: 0.52, y: 0.44 },
      innerRadius: 0.12,
      outerCenter: { x: 0.5, y: 0.5 },
      outerRadius: 0.82,
      colorStops: [
        { offset: 0, color: "rgba(0,0,0,0)" },
        { offset: 0.58, color: "rgba(0,0,0,0.04)" },
        { offset: 1, color: "rgba(0,0,0,0.34)" },
      ],
    });
    grade.rect(0, 0, w, h).fill(shadowGradient || { color: 0x050608, alpha: 0.18 });
    grade.blendMode = "multiply";
    this.root.addChild(grade);

    const beam = new this.pixi.Graphics();
    const beamGradient = this.createFillGradient({
      type: "linear",
      start: { x: 0, y: 0.22 },
      end: { x: 1, y: 0.78 },
      colorStops: [
        { offset: 0, color: "rgba(255,255,255,0)" },
        { offset: 0.34, color: "rgba(255,246,160,0.22)" },
        { offset: 0.58, color: `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},0.24)` },
        { offset: 1, color: "rgba(255,255,255,0)" },
      ],
    });
    beam.rect(0, 0, w, h).fill(beamGradient || { color: accentColor, alpha: 0.055 + pulse * 0.025 });
    beam.blendMode = "screen";
    this.root.addChild(beam);

    const glow = new this.pixi.Graphics();
    glow.blendMode = "screen";
    glow.circle(cx, cy, 150 + pulse * 28).fill({ color: accentColor, alpha: 0.07 * intro });
    glow.circle(cx, cy, 250 + pulse * 44).fill({ color: 0xffffff, alpha: 0.045 * intro });
    this.root.addChild(glow);
  }

  drawSpeedImpactEdgeVignette() {
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const edge = new this.pixi.Graphics();
    edge.blendMode = "multiply";
    edge.rect(0, 0, w, h).stroke({ color: 0x000000, width: 34, alpha: 0.18 });
    this.root.addChild(edge);
  }

  createFillGradient(options) {
    if (!this.pixi.FillGradient) return null;
    try {
      return new this.pixi.FillGradient({ ...options, textureSpace: "local" });
    } catch {
      return null;
    }
  }

  textureSoftBeam(key = "soft-beam-v1") {
    return this.createCanvasTexture(key, 512, 160, (ctx, width, height) => {
      const image = ctx.createImageData(width, height);
      const cx = width * 0.5;
      const cy = height * 0.5;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const nx = Math.abs((x - cx) / cx);
          const ny = Math.abs((y - cy) / cy);
          const endFade = Math.pow(Math.max(0, 1 - nx), 0.72);
          const softEdge = Math.pow(Math.max(0, 1 - ny * ny), 2.4);
          const alpha = Math.floor(255 * endFade * softEdge);
          const idx = (y * width + x) * 4;
          image.data[idx] = 255;
          image.data[idx + 1] = 255;
          image.data[idx + 2] = 255;
          image.data[idx + 3] = alpha;
        }
      }
      ctx.putImageData(image, 0, 0);
    });
  }

  drawSoftBeam(parent, x1, y1, x2, y2, width, color = 0xffffff, alpha = 0.1, options = {}) {
    const texture = this.textureSoftBeam(options.textureKey || "soft-beam-v1");
    if (!texture) return null;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const sprite = new this.pixi.Sprite(texture);
    sprite.anchor.set(0.5);
    sprite.x = (x1 + x2) * 0.5;
    sprite.y = (y1 + y2) * 0.5;
    sprite.rotation = Math.atan2(dy, dx);
    sprite.scale.set(len / 512, width / 160);
    sprite.alpha = alpha;
    sprite.tint = color;
    const blur = options.blur ?? 0.35;
    if (blur) sprite.filters = [this.createBlurFilter(blur, options.blurQuality || 2)].filter(Boolean);
    parent.addChild(sprite);
    return sprite;
  }

  drawTaperedQuad(graphics, x1, y1, x2, y2, startWidth, endWidth, color, alpha = 1) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    graphics.moveTo(x1 + nx * startWidth, y1 + ny * startWidth)
      .lineTo(x2 + nx * endWidth, y2 + ny * endWidth)
      .lineTo(x2 - nx * endWidth, y2 - ny * endWidth)
      .lineTo(x1 - nx * startWidth, y1 - ny * startWidth)
      .closePath()
      .fill({ color, alpha });
  }

  drawSpeedDirectionArrows(accent, timeSeconds) {
    const graphics = new this.pixi.Graphics();
    const color = parsePixiColor(accent || "#ffffff");
    for (let i = 0; i < 5; i += 1) {
      const y = 250 + i * 150 + Math.sin(timeSeconds * 3 + i) * 18;
      const x = 90 + (i % 2) * 70;
      graphics.moveTo(x, y)
        .lineTo(x + 430, y)
        .lineTo(x + 390, y - 34)
        .moveTo(x + 430, y)
        .lineTo(x + 390, y + 34)
        .stroke({ color, width: 5, alpha: 0.42 });
    }
    this.root.addChild(graphics);
  }

  drawPowerCore(accent, progress) {
    const graphics = new this.pixi.Graphics();
    const cx = PIXI_PREVIEW_SIZE.width / 2;
    const cy = PIXI_PREVIEW_SIZE.height * 0.43;
    const color = parsePixiColor(accent || "#ffd84d");
    for (let i = 0; i < 4; i += 1) {
      graphics.circle(cx, cy, 72 + i * 44 + Math.sin(progress * Math.PI) * 20)
        .fill({ color, alpha: 0.1 - i * 0.015 })
        .stroke({ color: i === 0 ? 0xffffff : color, width: 3 + i, alpha: 0.34 });
    }
    this.root.addChild(graphics);
  }

  drawPageImpactFrame(accent, progress, timeSeconds) {
    const graphics = new this.pixi.Graphics();
    const color = parsePixiColor(accent || "#ffffff");
    const cx = PIXI_PREVIEW_SIZE.width / 2;
    const cy = PIXI_PREVIEW_SIZE.height * 0.44;
    const wobble = Math.sin(timeSeconds * 16) * 8 * (1 - progress);
    graphics.rect(cx - 230 + wobble, cy - 300, 460, 600)
      .stroke({ color: 0xffffff, width: 8, alpha: 0.72 });
    graphics.rect(cx - 255 - wobble, cy - 325, 510, 650)
      .stroke({ color, width: 5, alpha: 0.62 });
    this.root.addChild(graphics);
    this.drawImpactBurst(accent, progress, timeSeconds);
  }

  drawComicTextureEffect(effect, progress, timeSeconds) {
    const accent = effect.accent || "#ffd84d";
    if ((effect.layout || "").includes("halftone") || (effect.layout || "").includes("kirby")) this.drawHalftoneDots(accent, timeSeconds, 0.28);
    if ((effect.layout || "").includes("flash")) this.drawFlash(accent, progress);
    this.drawImpactBurst(accent, progress, timeSeconds);
  }

  drawHorrorEffect(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#050505";
    const layout = effect.layout || "";
    if (layout === "ink-bleed") {
      this.drawInkBleedRevealPro(effect, progress, timeSeconds, options);
      return;
    }
    if (layout === "shadow-creep") {
      this.drawShadowCreepPro(effect, progress, timeSeconds, options);
      return;
    }
    if (layout === "vhs-horror") {
      this.drawVhsPossessionPro(effect, progress, timeSeconds, options);
      return;
    }
    this.drawVignetteLayer(0.42 + Math.sin(timeSeconds * 2) * 0.06);
    if (layout.includes("vhs")) this.drawGlitchBars("#00eaff", timeSeconds, 0.38);
    else this.drawInkSplats(accent, progress, timeSeconds);
  }

  drawInkBleedRevealPro(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#050505";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeOutCubic(Math.min(progress / 0.86, 1));
    const creep = 0.5 + Math.sin(timeSeconds * 1.8) * 0.5;
    const focus = {
      x: w * 0.52,
      y: h * 0.47,
      rx: w * 0.32,
      ry: h * 0.28,
    };

    const grade = new this.pixi.Graphics();
    const gradeFill = this.createFillGradient({
      type: "radial",
      center: { x: focus.x / w, y: focus.y / h },
      innerRadius: 0.12,
      outerCenter: { x: 0.5, y: 0.5 },
      outerRadius: 0.9,
      colorStops: [
        { offset: 0, color: "rgba(0,0,0,0)" },
        { offset: 0.56, color: "rgba(0,0,0,0.12)" },
        { offset: 1, color: "rgba(0,0,0,0.52)" },
      ],
    });
    grade.rect(0, 0, w, h).fill(gradeFill || { color: 0x050505, alpha: 0.22 });
    grade.blendMode = "multiply";
    this.root.addChild(grade);

    const inkLayer = this.createFxLayer({ blendMode: "multiply" });
    const ink = new this.pixi.Graphics();
    for (let i = 0; i < 34; i += 1) {
      const side = i % 4;
      const base = (i * 97) % (side < 2 ? w : h);
      const radius = 28 + (i % 5) * 18 + p * (60 + (i % 4) * 26) + creep * 12;
      const x = side === 0 ? base : side === 1 ? base : side === 2 ? -22 + p * 70 : w + 22 - p * 70;
      const y = side === 0 ? -18 + p * 92 : side === 1 ? h + 18 - p * 112 : base;
      ink.circle(x + Math.sin(timeSeconds * 2 + i) * 10, y + Math.cos(timeSeconds * 2.2 + i) * 10, radius)
        .fill({ color: accentColor, alpha: 0.12 + (i % 4) * 0.035 });
    }
    for (let i = 0; i < 15; i += 1) {
      const x = 50 + ((i * 131 + timeSeconds * 8) % (w - 100));
      const y = 100 + ((i * 173) % (h - 220));
      ink.ellipse(x, y, 12 + (i % 4) * 9 + p * 18, 42 + (i % 5) * 16 + p * 28)
        .fill({ color: accentColor, alpha: 0.055 + p * 0.045 });
    }
    inkLayer.addChild(ink);

    const scratchLayer = this.createFxLayer({ blendMode: "screen" });
    const scratches = new this.pixi.Graphics();
    for (let i = 0; i < 18; i += 1) {
      const x = 48 + ((i * 83 + timeSeconds * 34) % (w - 96));
      const y = 120 + ((i * 151) % (h - 240));
      scratches.moveTo(x, y)
        .lineTo(x + 16 + (i % 3) * 12, y - 54 - (i % 4) * 18)
        .stroke({ color: i % 5 === 0 ? 0xffffff : 0x9f0f1f, width: 1.5 + (i % 3), alpha: 0.07 + p * 0.1 });
    }
    scratchLayer.addChild(scratches);

    this.restoreSpeedImpactFocus(options.panelTexture, options.camera, focus, 0.7);

    const frame = new this.pixi.Graphics();
    frame.blendMode = "multiply";
    frame.rect(0, 0, w, h).stroke({ color: 0x000000, width: 88, alpha: 0.2 + p * 0.12 });
    this.root.addChild(frame);
  }

  drawShadowCreepPro(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#050505";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const breath = 0.5 + Math.sin(timeSeconds * 1.7) * 0.5;
    const p = easeInOutCubic(Math.min(progress, 1));
    const focus = {
      x: w * (0.5 + Math.sin(timeSeconds * 0.6) * 0.012),
      y: h * (0.46 + Math.cos(timeSeconds * 0.5) * 0.01),
      rx: w * 0.35,
      ry: h * 0.3,
    };

    this.drawPanelEcho(options.panelTexture, options.camera, {
      blendMode: "multiply",
      alpha: 0.24 + breath * 0.08,
      zoomBoost: 0.018 + breath * 0.012,
      panX: Math.sin(timeSeconds * 0.52) * 0.01,
      panY: Math.cos(timeSeconds * 0.47) * 0.01,
      blur: 1.8,
      blurQuality: 2,
    });
    this.drawPanelEcho(options.panelTexture, options.camera, {
      blendMode: "screen",
      alpha: 0.055 + breath * 0.035,
      zoomBoost: 0.006,
      panX: -0.012,
      panY: 0.006,
      blur: 0.8,
    });

    const shade = new this.pixi.Graphics();
    const shadeFill = this.createFillGradient({
      type: "radial",
      center: { x: focus.x / w, y: focus.y / h },
      innerRadius: 0.18,
      outerCenter: { x: 0.5, y: 0.52 },
      outerRadius: 0.88,
      colorStops: [
        { offset: 0, color: "rgba(0,0,0,0)" },
        { offset: 0.5, color: `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},0.10)` },
        { offset: 1, color: "rgba(0,0,0,0.52)" },
      ],
    });
    shade.rect(0, 0, w, h).fill(shadeFill || { color: 0x050505, alpha: 0.22 + breath * 0.08 });
    shade.blendMode = "multiply";
    this.root.addChild(shade);

    const creepLayer = this.createFxLayer({ blendMode: "multiply" });
    const creep = new this.pixi.Graphics();
    for (let i = 0; i < 12; i += 1) {
      const y = 70 + i * 130 + Math.sin(timeSeconds * 1.4 + i) * 22;
      const width = 82 + (i % 4) * 46 + breath * 35;
      creep.ellipse(-18 + p * 48, y, width, 95 + (i % 3) * 22)
        .fill({ color: 0x000000, alpha: 0.10 + (i % 3) * 0.028 });
      creep.ellipse(w + 18 - p * 42, y + 48, width * 0.88, 88 + (i % 4) * 18)
        .fill({ color: 0x000000, alpha: 0.085 + (i % 4) * 0.02 });
    }
    for (let i = 0; i < 8; i += 1) {
      const left = i % 2 === 0;
      const y = 140 + i * 126 + Math.cos(timeSeconds * 1.2 + i) * 28;
      const x0 = left ? -35 : w + 35;
      const x1 = left ? 120 + p * 55 : w - 120 - p * 55;
      const x2 = left ? 250 + breath * 42 : w - 250 - breath * 42;
      const sign = left ? 1 : -1;
      creep.moveTo(x0, y)
        .quadraticCurveTo(x1, y - 80 * sign, x2, y + 18)
        .stroke({ color: 0x000000, width: 18 + (i % 3) * 7, alpha: 0.045 + breath * 0.02 });
    }
    creepLayer.addChild(creep);

    const cold = this.createFxLayer({ blendMode: "screen" });
    const edgeLight = new this.pixi.Graphics();
    edgeLight.rect(0, 0, w, h).stroke({ color: 0x6170a8, width: 42, alpha: 0.038 + breath * 0.03 });
    edgeLight.ellipse(focus.x, focus.y, focus.rx + 18 + breath * 12, focus.ry + 30 + breath * 14)
      .stroke({ color: 0xffffff, width: 2, alpha: 0.032 + breath * 0.045 });
    edgeLight.ellipse(focus.x, focus.y, focus.rx * 1.42 + breath * 16, focus.ry * 1.28 + breath * 18)
      .stroke({ color: 0x9b0f24, width: 2, alpha: 0.035 + breath * 0.025 });
    cold.addChild(edgeLight);

    this.restoreSpeedImpactFocus(options.panelTexture, options.camera, focus, 0.82);

    const grain = new this.pixi.Graphics();
    grain.blendMode = "multiply";
    for (let i = 0; i < 88; i += 1) {
      const x = (i * 53) % w;
      const y = (i * 137 + timeSeconds * 18) % h;
      grain.rect(x, y, 18 + (i % 5) * 9, 2).fill({ color: 0x000000, alpha: 0.018 + (i % 4) * 0.006 });
    }
    this.root.addChild(grain);

    const pulseGlints = new this.pixi.Graphics();
    pulseGlints.blendMode = "screen";
    for (let i = 0; i < 9; i += 1) {
      const x = 70 + ((i * 181 + timeSeconds * 10) % (w - 140));
      const y = 150 + ((i * 229) % (h - 300));
      const alpha = Math.max(0, Math.sin(timeSeconds * 2.8 + i)) * 0.06;
      pulseGlints.circle(x, y, 2 + (i % 3)).fill({ color: i % 3 ? 0x9b0f24 : 0xffffff, alpha });
    }
    this.root.addChild(pulseGlints);
  }

  drawVhsPossessionPro(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#00eaff";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeOutCubic(Math.min(progress / 0.8, 1));
    const glitchBeat = Math.max(0, Math.sin(timeSeconds * 9.5));
    const tearBeat = Math.max(0, Math.sin(timeSeconds * 17.3 + 0.8));
    const focus = {
      x: w * 0.52,
      y: h * 0.48,
      rx: w * 0.34,
      ry: h * 0.28,
    };

    const grade = new this.pixi.Graphics();
    grade.rect(0, 0, w, h).fill({ color: 0x071017, alpha: 0.06 + glitchBeat * 0.035 });
    grade.rect(0, 0, w, h).stroke({ color: 0x000000, width: 82, alpha: 0.2 });
    grade.blendMode = "multiply";
    this.root.addChild(grade);

    const scanLayer = this.createFxLayer({ blendMode: "screen" });
    const scan = new this.pixi.Graphics();
    for (let y = 0; y < h; y += 13) {
      const alpha = 0.025 + ((y / 13) % 3) * 0.008 + glitchBeat * 0.012;
      scan.rect(0, y + ((timeSeconds * 36) % 13), w, 2).fill({ color: 0xffffff, alpha });
    }
    const sweepY = (timeSeconds * 190) % h;
    scan.rect(0, sweepY, w, 6).fill({ color: accentColor, alpha: 0.14 + glitchBeat * 0.08 });
    scanLayer.addChild(scan);

    const tearLayer = this.createFxLayer({ blendMode: "screen" });
    const tear = new this.pixi.Graphics();
    for (let i = 0; i < 8; i += 1) {
      const y = 100 + ((i * 149 + timeSeconds * 250) % (h - 200));
      const height = 5 + (i % 4) * 7;
      const offset = Math.sin(timeSeconds * 12 + i) * (18 + tearBeat * 34);
      tear.rect(offset - 40, y, w + 80, height)
        .fill({ color: i % 3 === 0 ? 0xffffff : accentColor, alpha: 0.07 + tearBeat * 0.09 });
      if (i % 2 === 0) {
        tear.rect(-offset * 0.5, y + height + 4, w + 60, 2)
          .fill({ color: 0xff254a, alpha: 0.045 + tearBeat * 0.045 });
      }
    }
    tearLayer.addChild(tear);

    const chroma = this.createFxLayer({ blendMode: "screen" });
    const offsets = new this.pixi.Graphics();
    const shift = 12 + tearBeat * 14;
    offsets.rect(42 + shift, 96, w - 84, h - 192).stroke({ color: 0xff254a, width: 2, alpha: 0.055 + tearBeat * 0.05 });
    offsets.rect(42 - shift, 96, w - 84, h - 192).stroke({ color: accentColor, width: 2, alpha: 0.065 + tearBeat * 0.05 });
    chroma.addChild(offsets);

    this.restoreSpeedImpactFocus(options.panelTexture, options.camera, focus, 0.74);

    const tracking = new this.pixi.Graphics();
    tracking.blendMode = "screen";
    tracking.rect(0, 0, w, h).stroke({ color: accentColor, width: 3, alpha: 0.08 + glitchBeat * 0.04 });
    tracking.rect(48, h - 128 + Math.sin(timeSeconds * 4) * 5, w - 96, 3)
      .fill({ color: 0xffffff, alpha: 0.18 + tearBeat * 0.1 });
    for (let i = 0; i < 9; i += 1) {
      const x = 58 + i * 66;
      tracking.rect(x, h - 120, 28, 2).fill({ color: accentColor, alpha: 0.18 });
    }
    this.root.addChild(tracking);
  }

  drawSciMagicEffect(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#8a7dff";
    const layout = effect.layout || "";
    if (layout === "holo-scan") {
      this.drawHologramScanEffectPro(effect, progress, timeSeconds, options);
      return;
    }
    if (layout === "portal-lock") {
      this.drawNeonPortalAuraPro(effect, progress, timeSeconds, options);
      return;
    }
    if (layout === "arcane-reveal") {
      this.drawArcaneCircleRevealPro(effect, progress, timeSeconds, options);
      return;
    }
    if (layout === "rune-glow") {
      this.drawRuneGlowPro(effect, progress, timeSeconds, options);
      return;
    }
    if (layout.includes("hud") || layout.includes("holo") || layout.includes("data")) this.drawHud(accent, timeSeconds);
    else this.drawPortal(accent, progress, timeSeconds);
    if (layout.includes("rune") || layout.includes("arcane")) this.drawRuneMarks(accent, timeSeconds);
  }

  drawNeonPortalAuraPro(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#8a7dff";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeOutCubic(Math.min(progress / 0.82, 1));
    const pulse = 0.5 + Math.sin(timeSeconds * 3.2) * 0.5;
    const focus = { x: w * 0.5, y: h * 0.47, rx: w * 0.31, ry: h * 0.27 };

    const grade = new this.pixi.Graphics();
    const glow = this.createFillGradient({
      type: "radial",
      start: { x: 0.5, y: 0.46 },
      end: { x: 0.5, y: 0.46 },
      colorStops: [
        { offset: 0, color: "rgba(255,255,255,0)" },
        { offset: 0.45, color: `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},0.08)` },
        { offset: 0.82, color: "rgba(15,6,40,0.18)" },
        { offset: 1, color: "rgba(0,0,0,0.10)" },
      ],
    });
    grade.rect(0, 0, w, h).fill(glow || { color: accentColor, alpha: 0.055 });
    grade.blendMode = "screen";
    this.root.addChild(grade);

    const portalLayer = this.createFxLayer({ blendMode: "screen" });
    const rings = new this.pixi.Graphics();
    const cx = focus.x + Math.sin(timeSeconds * 0.7) * 8;
    const cy = focus.y + Math.cos(timeSeconds * 0.6) * 10;
    for (let i = 0; i < 7; i += 1) {
      const t = i / 6;
      const rx = 132 + i * 23 + p * 24 + Math.sin(timeSeconds * 2.1 + i) * 6;
      const ry = 218 + i * 30 + p * 30 + Math.cos(timeSeconds * 1.7 + i) * 7;
      rings.ellipse(cx, cy, rx, ry)
        .stroke({ color: i % 3 === 0 ? 0xffffff : accentColor, width: 2 + (i % 3), alpha: (0.20 - t * 0.07) + pulse * 0.05 });
    }
    for (let i = 0; i < 22; i += 1) {
      const angle = (i / 22) * Math.PI * 2 + timeSeconds * (0.28 + (i % 3) * 0.04);
      const rx = 188 + (i % 4) * 34;
      const ry = 284 + (i % 5) * 26;
      const x = cx + Math.cos(angle) * rx;
      const y = cy + Math.sin(angle) * ry;
      rings.circle(x, y, 2 + (i % 4)).fill({ color: i % 5 === 0 ? 0xffffff : accentColor, alpha: 0.16 + pulse * 0.08 });
    }
    portalLayer.addChild(rings);

    const edge = new this.pixi.Graphics();
    edge.ellipse(cx, cy, 210 + pulse * 11, 330 + pulse * 16)
      .stroke({ color: 0xffffff, width: 7, alpha: 0.10 + p * 0.08 });
    edge.ellipse(cx, cy, 225 + pulse * 14, 352 + pulse * 19)
      .stroke({ color: accentColor, width: 4, alpha: 0.22 });
    portalLayer.addChild(edge);

    this.restoreSpeedImpactFocus(options.panelTexture, options.camera, focus, 0.78);

    const shade = new this.pixi.Graphics();
    shade.rect(0, 0, 54, h).fill({ color: 0x05030d, alpha: 0.18 });
    shade.rect(w - 54, 0, 54, h).fill({ color: 0x05030d, alpha: 0.18 });
    this.root.addChild(shade);
  }

  drawArcaneCircleRevealPro(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#a875ff";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeOutCubic(Math.min(progress / 0.78, 1));
    const focus = { x: w * 0.5, y: h * 0.47, rx: w * 0.30, ry: h * 0.24 };
    const cx = focus.x;
    const cy = focus.y + Math.sin(timeSeconds * 0.6) * 8;
    const warm = 0xffd884;

    const bloom = new this.pixi.Graphics();
    const fill = this.createFillGradient({
      type: "radial",
      start: { x: 0.5, y: 0.46 },
      end: { x: 0.5, y: 0.46 },
      colorStops: [
        { offset: 0, color: "rgba(255,255,255,0)" },
        { offset: 0.46, color: "rgba(255,216,132,0.10)" },
        { offset: 0.78, color: "rgba(168,117,255,0.12)" },
        { offset: 1, color: "rgba(0,0,0,0.08)" },
      ],
    });
    bloom.rect(0, 0, w, h).fill(fill || { color: accentColor, alpha: 0.06 });
    bloom.blendMode = "screen";
    this.root.addChild(bloom);

    const circleLayer = this.createFxLayer({ blendMode: "screen" });
    const circle = new this.pixi.Graphics();
    const ringCount = 4;
    for (let i = 0; i < ringCount; i += 1) {
      const rx = 134 + i * 31 + p * 18 + Math.sin(timeSeconds * 1.7 + i) * 5;
      const ry = 212 + i * 38 + p * 22 + Math.cos(timeSeconds * 1.4 + i) * 6;
      circle.ellipse(cx, cy, rx, ry)
        .stroke({ color: i % 2 ? accentColor : warm, width: i === 0 ? 4 : 2, alpha: 0.22 + (ringCount - i) * 0.035 });
    }
    for (let i = 0; i < 18; i += 1) {
      const angle = (i / 18) * Math.PI * 2 + timeSeconds * 0.22;
      const innerX = cx + Math.cos(angle) * 188;
      const innerY = cy + Math.sin(angle) * 287;
      const outerX = cx + Math.cos(angle) * 216;
      const outerY = cy + Math.sin(angle) * 330;
      circle.moveTo(innerX, innerY).lineTo(outerX, outerY)
        .stroke({ color: i % 3 ? accentColor : 0xffffff, width: i % 3 ? 2 : 3, alpha: i % 3 ? 0.20 : 0.16 });
    }
    for (let i = 0; i < 10; i += 1) {
      const angle = (i / 10) * Math.PI * 2 - timeSeconds * 0.18;
      const x = cx + Math.cos(angle) * (236 + (i % 2) * 18);
      const y = cy + Math.sin(angle) * (352 + (i % 3) * 12);
      circle.moveTo(x - 12, y).lineTo(x + 12, y)
        .moveTo(x, y - 12).lineTo(x, y + 12)
        .stroke({ color: i % 2 ? warm : accentColor, width: 2, alpha: 0.22 });
    }
    circleLayer.addChild(circle);

    this.restoreSpeedImpactFocus(options.panelTexture, options.camera, focus, 0.82);

    const sparks = new this.pixi.Graphics();
    sparks.blendMode = "screen";
    for (let i = 0; i < 20; i += 1) {
      const angle = (i / 20) * Math.PI * 2 + timeSeconds * (0.5 + (i % 4) * 0.07);
      const x = cx + Math.cos(angle) * (focus.rx * 1.05 + (i % 4) * 22);
      const y = cy + Math.sin(angle) * (focus.ry * 1.25 + (i % 5) * 20);
      sparks.circle(x, y, 2 + (i % 3)).fill({ color: i % 4 ? accentColor : warm, alpha: 0.15 + p * 0.08 });
    }
    this.root.addChild(sparks);
  }

  drawRuneGlowPro(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#f5d46b";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeOutCubic(Math.min(progress / 0.8, 1));
    const focus = { x: w * 0.52, y: h * 0.48, rx: w * 0.28, ry: h * 0.22 };

    const shade = new this.pixi.Graphics();
    shade.rect(0, 0, w, h).fill({ color: 0x0b0704, alpha: 0.08 });
    shade.blendMode = "multiply";
    this.root.addChild(shade);

    const runeLayer = this.createFxLayer({ blendMode: "screen" });
    const runes = new this.pixi.Graphics();
    const positions = [
      [0.19, 0.24], [0.81, 0.28], [0.17, 0.55], [0.83, 0.58],
      [0.28, 0.78], [0.72, 0.78], [0.50, 0.19], [0.50, 0.83],
    ];
    positions.forEach(([px, py], index) => {
      const x = w * px + Math.sin(timeSeconds * 1.2 + index) * 5;
      const y = h * py + Math.cos(timeSeconds * 1.1 + index) * 6;
      const size = 18 + (index % 3) * 6 + p * 4;
      const alpha = 0.22 + Math.sin(timeSeconds * 2.4 + index) * 0.05;
      runes.moveTo(x - size, y).lineTo(x + size, y)
        .moveTo(x, y - size).lineTo(x, y + size)
        .stroke({ color: index % 3 === 0 ? 0xffffff : accentColor, width: 2, alpha });
      runes.ellipse(x, y, size * 0.78, size * 1.15)
        .stroke({ color: accentColor, width: 2, alpha: alpha * 0.72 });
    });
    runes.ellipse(focus.x, focus.y, focus.rx * 1.04, focus.ry * 1.14)
      .stroke({ color: accentColor, width: 2, alpha: 0.14 + p * 0.06 });
    runes.ellipse(focus.x, focus.y, focus.rx * 0.74, focus.ry * 0.82)
      .stroke({ color: 0xffffff, width: 1, alpha: 0.10 });
    runeLayer.addChild(runes);

    this.restoreSpeedImpactFocus(options.panelTexture, options.camera, focus, 0.78);

    const dust = new this.pixi.Graphics();
    dust.blendMode = "screen";
    for (let i = 0; i < 26; i += 1) {
      const x = 62 + ((i * 97 + timeSeconds * 18) % (w - 124));
      const y = 105 + ((i * 151 - timeSeconds * 31) % (h - 210));
      const nearCenter = Math.abs(x - focus.x) < focus.rx * 0.9 && Math.abs(y - focus.y) < focus.ry * 0.9;
      dust.circle(x, y, 1.5 + (i % 4)).fill({ color: i % 6 ? accentColor : 0xffffff, alpha: nearCenter ? 0.05 : 0.16 });
    }
    this.root.addChild(dust);
  }

  drawHologramScanEffectPro(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#00d4ff";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeOutCubic(Math.min(progress / 0.78, 1));
    const scanY = lerp(h * 0.12, h * 0.82, (timeSeconds * 0.22) % 1);
    const focus = {
      x: w * 0.52,
      y: h * 0.48,
      rx: w * 0.32,
      ry: h * 0.26,
    };

    const grade = new this.pixi.Graphics();
    const glow = this.createFillGradient({
      type: "linear",
      start: { x: 0.5, y: 0 },
      end: { x: 0.5, y: 1 },
      colorStops: [
        { offset: 0, color: "rgba(255,255,255,0)" },
        { offset: 0.48, color: `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},0.10)` },
        { offset: 0.52, color: "rgba(255,255,255,0.09)" },
        { offset: 1, color: "rgba(255,255,255,0)" },
      ],
    });
    grade.rect(0, 0, w, h).fill(glow || { color: accentColor, alpha: 0.045 });
    grade.blendMode = "screen";
    this.root.addChild(grade);

    const gridLayer = this.createFxLayer({ blendMode: "screen" });
    const grid = new this.pixi.Graphics();
    for (let x = 72; x < w - 72; x += 72) {
      grid.moveTo(x + Math.sin(timeSeconds * 0.8 + x) * 3, 150)
        .lineTo(x, h - 150)
        .stroke({ color: accentColor, width: 1, alpha: 0.045 });
    }
    for (let y = 154; y < h - 154; y += 72) {
      grid.moveTo(58, y).lineTo(w - 58, y)
        .stroke({ color: accentColor, width: 1, alpha: 0.04 });
    }
    gridLayer.addChild(grid);

    const scanLayer = this.createFxLayer({ blendMode: "screen" });
    const scan = new this.pixi.Graphics();
    scan.rect(48, scanY - 18, w - 96, 36).fill({ color: accentColor, alpha: 0.045 + p * 0.04 });
    scan.moveTo(58, scanY).lineTo(w - 58, scanY).stroke({ color: 0xffffff, width: 5, alpha: 0.22 });
    scan.moveTo(58, scanY + 14).lineTo(w - 58, scanY + 14).stroke({ color: accentColor, width: 2, alpha: 0.34 });
    scanLayer.addChild(scan);

    const brackets = this.createFxLayer({ blendMode: "screen" });
    const b = new this.pixi.Graphics();
    const bw = focus.rx * 1.15;
    const bh = focus.ry * 1.08;
    const x1 = focus.x - bw;
    const x2 = focus.x + bw;
    const y1 = focus.y - bh;
    const y2 = focus.y + bh;
    const corner = 52 + Math.sin(timeSeconds * 3) * 5;
    [
      [x1, y1, x1 + corner, y1], [x1, y1, x1, y1 + corner],
      [x2, y1, x2 - corner, y1], [x2, y1, x2, y1 + corner],
      [x1, y2, x1 + corner, y2], [x1, y2, x1, y2 - corner],
      [x2, y2, x2 - corner, y2], [x2, y2, x2, y2 - corner],
    ].forEach(([xa, ya, xb, yb]) => b.moveTo(xa, ya).lineTo(xb, yb).stroke({ color: accentColor, width: 3, alpha: 0.32 }));
    b.ellipse(focus.x, focus.y, focus.rx * 0.72, focus.ry * 0.52)
      .stroke({ color: 0xffffff, width: 2, alpha: 0.14 });
    brackets.addChild(b);

    this.restoreSpeedImpactFocus(options.panelTexture, options.camera, focus, 0.7);

    const ticks = new this.pixi.Graphics();
    ticks.blendMode = "screen";
    for (let i = 0; i < 18; i += 1) {
      const angle = (Math.PI * 2 * i) / 18 + timeSeconds * 0.25;
      const x = focus.x + Math.cos(angle) * (focus.rx * 1.2 + (i % 3) * 18);
      const y = focus.y + Math.sin(angle) * (focus.ry * 1.2 + (i % 4) * 14);
      ticks.circle(x, y, 2 + (i % 3)).fill({ color: i % 5 === 0 ? 0xffffff : accentColor, alpha: 0.18 });
    }
    this.root.addChild(ticks);
  }

  drawRomanceEffect(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ff8ed6";
    if ((effect.layout || "") === "soft-bloom") {
      this.drawSoftBloomPushShowcase(effect, progress, timeSeconds, options);
      return;
    }
    this.drawSoftBloom(accent, progress);
    this.drawParticles(accent, timeSeconds, (effect.layout || "").includes("petal"));
    if ((effect.layout || "").includes("heart")) this.drawHeartLayer(accent, progress, timeSeconds);
  }

  drawSoftBloomPushShowcase(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ff8ed6";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeInOutCubic(Math.min(progress, 1));
    const breath = 0.5 + Math.sin(timeSeconds * 1.35) * 0.5;
    const focus = {
      x: w * (0.5 + Math.sin(timeSeconds * 0.24) * 0.018),
      y: h * (0.45 + Math.cos(timeSeconds * 0.2) * 0.012),
      rx: w * 0.33,
      ry: h * 0.27,
    };

    this.drawPanelEcho(options.panelTexture, options.camera, {
      blendMode: "screen",
      alpha: 0.22 + breath * 0.08,
      zoomBoost: 0.035,
      panX: Math.sin(timeSeconds * 0.28) * 0.008,
      panY: Math.cos(timeSeconds * 0.24) * 0.006,
      blur: 3.6,
      blurQuality: 3,
    });
    this.drawPanelEcho(options.panelTexture, options.camera, {
      blendMode: "screen",
      alpha: 0.13,
      zoomBoost: 0.012,
      blur: 1.2,
    });

    const grade = new this.pixi.Graphics();
    const gradeFill = this.createFillGradient({
      type: "radial",
      center: { x: focus.x / w, y: focus.y / h },
      innerRadius: 0.08,
      outerCenter: { x: 0.5, y: 0.48 },
      outerRadius: 0.92,
      colorStops: [
        { offset: 0, color: "rgba(255,255,255,0.10)" },
        { offset: 0.42, color: `rgba(${(accentColor >> 16) & 255},${(accentColor >> 8) & 255},${accentColor & 255},0.08)` },
        { offset: 0.78, color: "rgba(255,218,178,0.08)" },
        { offset: 1, color: "rgba(12,8,20,0.10)" },
      ],
    });
    grade.rect(0, 0, w, h).fill(gradeFill || { color: accentColor, alpha: 0.065 });
    grade.blendMode = "screen";
    this.root.addChild(grade);

    const lightLayer = this.createFxLayer({ blendMode: "screen" });
    const light = new this.pixi.Graphics();
    const beamAlpha = 0.055 + breath * 0.035;
    this.drawTaperedQuad(light, -80, h * 0.17, w * 0.78, h * 0.03, 92, 18, 0xffffff, beamAlpha);
    this.drawTaperedQuad(light, w * 0.12, h * 1.02, w * 1.05, h * 0.62, 24, 112, accentColor, 0.034 + breath * 0.028);
    light.ellipse(focus.x, focus.y, focus.rx * (1.08 + breath * 0.06), focus.ry * (0.92 + breath * 0.05))
      .stroke({ color: 0xffffff, width: 3, alpha: 0.075 + p * 0.04 });
    light.ellipse(focus.x, focus.y, focus.rx * (1.42 + breath * 0.04), focus.ry * (1.18 + breath * 0.04))
      .stroke({ color: accentColor, width: 2, alpha: 0.07 });
    lightLayer.addChild(light);

    const particles = this.createFxLayer({ blendMode: "screen" });
    const dust = new this.pixi.Graphics();
    for (let i = 0; i < 42; i += 1) {
      const depth = (i % 5) / 4;
      const x = 44 + ((i * 101 + timeSeconds * (12 + depth * 18)) % (w - 88));
      const y = 86 + ((i * 157 - timeSeconds * (18 + depth * 24)) % (h - 172));
      const nearFocus = Math.abs(x - focus.x) < focus.rx * 0.9 && Math.abs(y - focus.y) < focus.ry * 0.9;
      const radius = 1.6 + depth * 5.2;
      if (i % 7 === 0) {
        dust.ellipse(x, y, radius * 0.75, radius * 2.2).fill({ color: 0xffd8b2, alpha: nearFocus ? 0.04 : 0.08 + depth * 0.03 });
      } else {
        dust.circle(x, y, radius).fill({ color: i % 6 === 0 ? 0xffffff : accentColor, alpha: nearFocus ? 0.045 : 0.09 + depth * 0.038 });
      }
    }
    particles.addChild(dust);

    this.restoreSpeedImpactFocus(options.panelTexture, options.camera, focus, 0.82);

    const silk = new this.pixi.Graphics();
    silk.blendMode = "screen";
    silk.rect(0, 0, w, 118).fill({ color: 0xffffff, alpha: 0.018 + breath * 0.012 });
    silk.rect(0, h - 150, w, 150).fill({ color: accentColor, alpha: 0.022 + breath * 0.014 });
    this.root.addChild(silk);
  }

  drawFantasyEffect(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#f5d46b";
    if ((effect.layout || "") === "fire-overlay") {
      this.drawDragonFireOverlayPro(effect, progress, timeSeconds, options);
      return;
    }
    if ((effect.layout || "").includes("fire")) this.drawFireOverlay(accent, timeSeconds);
    else if ((effect.layout || "").includes("scroll")) this.drawPaperGrain(accent, 0.32);
    else this.drawParticles(accent, timeSeconds, false);
    this.drawRuneMarks(accent, timeSeconds);
  }

  drawDragonFireOverlayPro(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ff7a18";
    const accentColor = parsePixiColor(accent);
    const w = PIXI_PREVIEW_SIZE.width;
    const h = PIXI_PREVIEW_SIZE.height;
    const p = easeOutCubic(Math.min(progress / 0.72, 1));
    const focus = { x: w * 0.50, y: h * 0.44, rx: w * 0.32, ry: h * 0.24 };

    const heat = new this.pixi.Graphics();
    const grade = this.createFillGradient({
      type: "linear",
      start: { x: 0.5, y: 1 },
      end: { x: 0.5, y: 0 },
      colorStops: [
        { offset: 0, color: "rgba(255,97,14,0.22)" },
        { offset: 0.28, color: "rgba(255,166,49,0.10)" },
        { offset: 0.62, color: "rgba(255,255,255,0.02)" },
        { offset: 1, color: "rgba(0,0,0,0)" },
      ],
    });
    heat.rect(0, 0, w, h).fill(grade || { color: accentColor, alpha: 0.08 });
    heat.blendMode = "screen";
    this.root.addChild(heat);

    const flameLayer = this.createFxLayer({ blendMode: "screen" });
    const flames = new this.pixi.Graphics();
    const flameCount = 18;
    for (let i = 0; i < flameCount; i += 1) {
      const baseX = -28 + i * ((w + 56) / (flameCount - 1));
      const sway = Math.sin(timeSeconds * 3.2 + i * 0.9) * 16;
      const height = 138 + (i % 5) * 22 + Math.sin(timeSeconds * 4.1 + i) * 42;
      const gap = Math.abs(baseX - focus.x) < focus.rx * 0.95 ? 0.66 : 1;
      const alpha = (0.18 + (i % 3) * 0.025) * gap * p;
      flames.moveTo(baseX - 36, h)
        .quadraticCurveTo(baseX + sway - 18, h - height * 0.48, baseX + sway, h - height)
        .quadraticCurveTo(baseX + sway + 28, h - height * 0.45, baseX + 50, h)
        .closePath()
        .fill({ color: i % 4 === 0 ? 0xfff0a3 : accentColor, alpha });
      flames.moveTo(baseX - 12, h)
        .quadraticCurveTo(baseX + sway + 6, h - height * 0.38, baseX + sway + 18, h - height * 0.72)
        .quadraticCurveTo(baseX + sway + 30, h - height * 0.35, baseX + 34, h)
        .closePath()
        .fill({ color: 0xffd15a, alpha: alpha * 0.62 });
    }
    flameLayer.addChild(flames);

    const sideLicks = new this.pixi.Graphics();
    for (let i = 0; i < 7; i += 1) {
      const y = 170 + i * 105 + Math.sin(timeSeconds * 2.4 + i) * 14;
      const len = 90 + (i % 3) * 32;
      sideLicks.moveTo(0, y)
        .quadraticCurveTo(54, y - 36, len, y + 14)
        .stroke({ color: i % 2 ? accentColor : 0xfff0a3, width: 8, alpha: 0.10 + p * 0.05 });
      sideLicks.moveTo(w, y + 44)
        .quadraticCurveTo(w - 58, y - 16, w - len, y + 34)
        .stroke({ color: accentColor, width: 7, alpha: 0.09 + p * 0.04 });
    }
    flameLayer.addChild(sideLicks);

    this.restoreSpeedImpactFocus(options.panelTexture, options.camera, focus, 0.84);

    const embers = new this.pixi.Graphics();
    embers.blendMode = "screen";
    for (let i = 0; i < 34; i += 1) {
      const x = 34 + ((i * 73 + timeSeconds * (34 + (i % 5) * 9)) % (w - 68));
      const y = h - 84 - ((i * 109 + timeSeconds * (88 + (i % 4) * 11)) % (h * 0.58));
      const nearCenter = Math.abs(x - focus.x) < focus.rx && Math.abs(y - focus.y) < focus.ry;
      embers.circle(x, y, 2 + (i % 4)).fill({ color: i % 5 ? accentColor : 0xfff0a3, alpha: nearCenter ? 0.05 : 0.18 });
    }
    this.root.addChild(embers);

    const topSmoke = new this.pixi.Graphics();
    topSmoke.rect(0, 0, w, 86).fill({ color: 0x090604, alpha: 0.08 });
    topSmoke.rect(0, h - 72, w, 72).fill({ color: 0x000000, alpha: 0.08 });
    this.root.addChild(topSmoke);
  }

  drawNoirEffect(effect, progress, timeSeconds) {
    const accent = effect.accent || "#cfb46a";
    this.drawPaperGrain(accent, 0.2);
    this.drawVignetteLayer(0.28);
    if ((effect.layout || "").includes("rain")) this.drawRain(accent, timeSeconds);
    if ((effect.layout || "").includes("case")) this.drawFileOverlay(accent, progress);
  }

  drawReadingEffect(effect, progress, timeSeconds) {
    const accent = effect.accent || "#ffffff";
    this.drawVignetteLayer(0.16);
    if ((effect.layout || "").includes("scroll") || (effect.layout || "").includes("drop")) this.drawScrollGuide(accent, progress);
    else this.drawBreathFrame(accent, progress);
  }

  drawComedyEffect(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ff9f1c";
    if (!options.hasTextStyle) this.drawSfxWord((effect.layout || "").includes("freeze") ? "?" : "POP", PIXI_PREVIEW_SIZE.width * 0.52, PIXI_PREVIEW_SIZE.height * 0.38, accent, progress);
    this.drawHalftoneDots(accent, timeSeconds, 0.18);
  }

  drawPromoEffect(effect, progress, timeSeconds, options = {}) {
    const accent = effect.accent || "#ffd84d";
    if ((effect.layout || "").includes("before") || (effect.layout || "").includes("timelapse")) this.drawPromoTiles(accent, progress, timeSeconds);
    else if (!options.hasTextStyle) this.drawRibbonText((effect.layout || "").includes("cta") ? "READ NOW" : "NEW CHAPTER", PIXI_PREVIEW_SIZE.height - 170, accent, progress);
    this.drawSpeedStreaks(accent, timeSeconds, 10, 0.12);
  }

  drawSfxText(textStyle, progress, timeSeconds) {
    const text = String(textStyle.text || textStyle.title || "BAM").toUpperCase();
    if (textStyle.layout === "sfx-vertical") {
      text.split("").slice(0, 5).forEach((char, index) => {
        this.drawSfxWord(char, PIXI_PREVIEW_SIZE.width * 0.28, 250 + index * 96, textStyle.accent, progress, 0.78);
      });
      return;
    }
    if (textStyle.layout === "speed-title") this.drawSpeedStreaks(textStyle.accent, timeSeconds, 24, 0.18);
    this.drawSfxWord(text, PIXI_PREVIEW_SIZE.width / 2, PIXI_PREVIEW_SIZE.height * 0.38, textStyle.accent, progress, text.length <= 4 ? 1 : 0.72);
  }

  drawMagicText(textStyle, progress, timeSeconds) {
    this.drawPortal(textStyle.accent, progress, timeSeconds);
    this.drawRuneMarks(textStyle.accent, timeSeconds);
    this.drawCaption(textStyle.text || textStyle.title || "ARCANE", { ...textStyle, fill: textStyle.fill || "rgba(10,8,18,0.86)", y: 455 });
  }

  drawFutureText(textStyle, progress, timeSeconds) {
    this.drawHud(textStyle.accent, timeSeconds);
    if ((textStyle.layout || "").includes("glitch")) this.drawGlitchBars(textStyle.accent, timeSeconds, 0.22);
    this.drawCaption(textStyle.text || textStyle.title || "SIGNAL", { ...textStyle, fill: textStyle.fill || "rgba(0,17,24,0.86)", y: 430 });
  }

  drawHorrorText(textStyle, progress, timeSeconds) {
    this.drawVignetteLayer(0.36);
    this.drawInkSplats(textStyle.accent || "#b50018", progress, timeSeconds);
    this.drawCaption(textStyle.text || textStyle.title || "STOP", { ...textStyle, fill: textStyle.fill || "#050505", y: 430 });
  }

  drawRomanceText(textStyle, progress, timeSeconds) {
    this.drawParticles(textStyle.accent || "#ff8ed6", timeSeconds, false);
    if ((textStyle.layout || "").includes("heart")) this.drawHeartLayer(textStyle.accent, progress, timeSeconds);
    this.drawCaption(textStyle.text || textStyle.title || "LOVE", { ...textStyle, y: 430 });
  }

  drawDossierText(textStyle, progress, timeSeconds) {
    this.drawPaperGrain(textStyle.accent || "#cfb46a", 0.24);
    this.drawCaption(textStyle.text || textStyle.title || "CASE FILE", { ...textStyle, y: 400, height: 160 });
  }

  drawSocialText(textStyle, progress, timeSeconds) {
    const layout = textStyle.layout || "";
    const y = layout === "lower-third" || layout === "chat-card" ? PIXI_PREVIEW_SIZE.height - 260 : 430;
    this.drawCaption(textStyle.text || textStyle.title || "NEXT", { ...textStyle, y, height: layout === "chat-card" ? 118 : 132 });
  }

  drawFantasyCardText(textStyle, progress, timeSeconds) {
    this.drawParticles(textStyle.accent || "#d8ff8f", timeSeconds, false);
    this.drawCaption(textStyle.text || textStyle.title || "LEGEND", { ...textStyle, y: 410, height: 160 });
  }

  drawTargetReticle(cx, cy, radius, color, timeSeconds) {
    const graphics = new this.pixi.Graphics();
    graphics.circle(cx, cy, radius).stroke({ color, width: 3, alpha: 0.72 });
    graphics.circle(cx, cy, radius * 0.56).stroke({ color, width: 2, alpha: 0.48 });
    for (let i = 0; i < 4; i += 1) {
      const angle = timeSeconds * 0.8 + i * Math.PI / 2;
      graphics.moveTo(cx + Math.cos(angle) * (radius + 18), cy + Math.sin(angle) * (radius + 18))
        .lineTo(cx + Math.cos(angle) * (radius + 72), cy + Math.sin(angle) * (radius + 72))
        .stroke({ color, width: 3, alpha: 0.58 });
    }
    this.root.addChild(graphics);
  }

  drawSpeedStreaks(accent, timeSeconds, count, alpha) {
    const color = parsePixiColor(accent || "#ffffff");
    const texture = this.textureSpeedStreaks(`speed-streaks-720x1280-${count}`, count);
    const offset = (timeSeconds * 160) % PIXI_PREVIEW_SIZE.height;
    for (let i = -1; i <= 0; i += 1) {
      this.drawCachedFullFrameTexture(texture, {
        y: offset + i * PIXI_PREVIEW_SIZE.height,
        tint: color,
        alpha,
        blendMode: "screen",
      });
    }
  }

  drawImpactBurst(accent, progress, timeSeconds) {
    const sprite = this.drawCachedFullFrameTexture(this.textureImpactBurst(), {
      tint: parsePixiColor(accent),
      alpha: 0.92,
    });
    sprite.anchor.set(0.5);
    sprite.x = PIXI_PREVIEW_SIZE.width * 0.5;
    sprite.y = PIXI_PREVIEW_SIZE.height * 0.5;
    sprite.rotation = timeSeconds * 0.04;
    sprite.scale.set(0.96 + Math.sin(progress * Math.PI) * 0.1);
  }

  drawSlash(accent, progress) {
    const graphics = new this.pixi.Graphics();
    const p = easeOutCubic(progress);
    for (let i = 0; i < 4; i += 1) {
      const y = 920 - i * 140;
      graphics.moveTo(80 + i * 38, y)
        .lineTo(120 + p * 640, y - 480)
        .stroke({ color: i === 0 ? 0xffffff : parsePixiColor(accent), width: i === 0 ? 18 : 8, alpha: i === 0 ? 0.84 : 0.68 });
    }
    this.root.addChild(graphics);
  }

  drawPortal(accent, progress, timeSeconds) {
    const graphics = new this.pixi.Graphics();
    const cx = PIXI_PREVIEW_SIZE.width / 2;
    const cy = PIXI_PREVIEW_SIZE.height * 0.46;
    for (let i = 0; i < 5; i += 1) {
      graphics.ellipse(cx, cy, 120 + i * 36 + progress * 40, 190 + i * 48 + progress * 30)
        .stroke({ color: parsePixiColor(accent), width: 3 + i, alpha: 0.22 + i * 0.1 });
      graphics.rotation = Math.sin(timeSeconds * 0.6) * 0.04;
    }
    this.root.addChild(graphics);
  }

  drawHud(accent, timeSeconds) {
    const graphics = new this.pixi.Graphics();
    const color = parsePixiColor(accent);
    graphics.rect(86, 170, PIXI_PREVIEW_SIZE.width - 172, PIXI_PREVIEW_SIZE.height - 340)
      .stroke({ color, width: 3, alpha: 0.65 });
    graphics.moveTo(PIXI_PREVIEW_SIZE.width / 2, 120).lineTo(PIXI_PREVIEW_SIZE.width / 2, PIXI_PREVIEW_SIZE.height - 120)
      .stroke({ color, width: 2, alpha: 0.36 });
    for (let i = 0; i < 9; i += 1) {
      graphics.rect(118, 220 + i * 58, 120 + ((i * 31) % 160), 8)
        .fill({ color, alpha: 0.2 + Math.sin(timeSeconds * 4 + i) * 0.05 });
    }
    this.root.addChild(graphics);
  }

  drawParticles(accent, timeSeconds, petals = false) {
    const color = parsePixiColor(accent);
    const texture = this.textureFloatingParticles(petals ? "floating-petals-720x1280" : "floating-particles-720x1280", petals);
    const offsetX = (timeSeconds * 22) % PIXI_PREVIEW_SIZE.width;
    const offsetY = (timeSeconds * 48) % PIXI_PREVIEW_SIZE.height;
    for (let ix = -1; ix <= 0; ix += 1) {
      for (let iy = -1; iy <= 0; iy += 1) {
        this.drawCachedFullFrameTexture(texture, {
          x: offsetX + ix * PIXI_PREVIEW_SIZE.width,
          y: offsetY + iy * PIXI_PREVIEW_SIZE.height,
          tint: color,
          alpha: petals ? 0.9 : 0.86,
          blendMode: "screen",
        });
      }
    }
  }

  drawWipeLine(x, accent) {
    const graphics = new this.pixi.Graphics();
    graphics.rect(x - 3, 0, 6, PIXI_PREVIEW_SIZE.height).fill({ color: parsePixiColor(accent || "#ffffff"), alpha: 0.28 });
    this.root.addChild(graphics);
  }

  drawSequenceProgress(progress) {
    const safeProgress = Math.max(0, Math.min(progress, 1));
    const graphics = new this.pixi.Graphics();
    const x = 58;
    const y = PIXI_PREVIEW_SIZE.height - 70;
    const width = PIXI_PREVIEW_SIZE.width - 116;
    graphics.roundRect(x, y, width, 8, 4)
      .fill({ color: 0xffffff, alpha: 0.28 });
    graphics.roundRect(x, y, width * safeProgress, 8, 4)
      .fill({ color: 0xff4f8b, alpha: 0.92 });
    this.root.addChild(graphics);
  }

  drawSafeFrame() {
    const graphics = new this.pixi.Graphics();
    graphics.roundRect(18, 18, PIXI_PREVIEW_SIZE.width - 36, PIXI_PREVIEW_SIZE.height - 36, 24)
      .stroke({ color: 0xffffff, width: 2, alpha: 0.26 });
    this.root.addChild(graphics);
  }

  drawBadge(label, accent) {
    const graphics = new this.pixi.Graphics();
    graphics.roundRect(34, 34, 210, 42, 21)
      .fill({ color: 0x050509, alpha: 0.72 })
      .stroke({ color: parsePixiColor(accent || "#55f0c8"), width: 2, alpha: 0.46 });
    this.root.addChild(graphics);
    const text = new this.pixi.Text({
      text: label,
      style: {
        fontFamily: "Inter, system-ui",
        fontSize: 17,
        fontWeight: "900",
        fill: accent || "#55f0c8",
      },
    });
    text.x = 54;
    text.y = 44;
    this.root.addChild(text);
  }
}

function easeOutCubic(value) {
  return 1 - Math.pow(1 - Math.max(0, Math.min(value, 1)), 3);
}

function easeOutBack(value) {
  const t = Math.max(0, Math.min(value, 1));
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function easeInOutCubic(value) {
  const t = Math.max(0, Math.min(value, 1));
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function lerp(start, end, value) {
  return start + (end - start) * Math.max(0, Math.min(value, 1));
}

function parsePixiColor(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return 0xffffff;
  if (value.startsWith("#")) return Number.parseInt(value.slice(1).padEnd(6, "0").slice(0, 6), 16);
  const rgba = value.match(/rgba?\\(([^)]+)\\)/);
  if (rgba) {
    const [r, g, b] = rgba[1].split(",").map((part) => Number.parseInt(part.trim(), 10) || 0);
    return (r << 16) + (g << 8) + b;
  }
  return 0xffffff;
}
