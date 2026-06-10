import { Controller } from "@hotwired/stimulus"
import { Application, Assets, Container, Graphics, Sprite, Text, TextStyle } from "pixi.js"

export default class extends Controller {
  static targets = ["stage", "payload", "status"]

  async connect() {
    this.payload = JSON.parse(this.payloadTarget.textContent)
    this.frame = { width: 360, height: 640 }
    this.currentShotIndex = 0

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
    await this.renderCurrentShot()
  }

  disconnect() {
    this.app?.destroy(true)
  }

  previousShot() {
    this.moveShot(-1)
  }

  nextShot() {
    this.moveShot(1)
  }

  moveShot(delta) {
    const shots = this.payload.contract.shots

    if (shots.length === 0) {
      return
    }

    this.currentShotIndex = (this.currentShotIndex + delta + shots.length) % shots.length
    void this.renderCurrentShot()
  }

  async renderCurrentShot() {
    const shots = this.payload.contract.shots
    const shot = shots[this.currentShotIndex]
    const asset = this.payload.assets[String(shot.assetId)]

    this.app.stage.removeChildren()
    this.drawBackground()

    const shotLayer = new Container()
    this.app.stage.addChild(shotLayer)

    if (asset?.url) {
      try {
        const texture = await Assets.load(asset.url)
        const sprite = new Sprite(texture)
        this.fitSprite(sprite, shot.crop)
        shotLayer.addChild(sprite)
      } catch {
        this.drawPlaceholder(shotLayer, shot)
      }
    } else {
      this.drawPlaceholder(shotLayer, shot)
    }

    this.drawSafeFrame()
    this.drawCaption(shot)
    this.statusTarget.textContent = `${this.currentShotIndex + 1} / ${shots.length}`
  }

  drawBackground() {
    const background = new Graphics()
    background.rect(0, 0, this.frame.width, this.frame.height)
    background.fill("#09090b")
    this.app.stage.addChild(background)
  }

  drawSafeFrame() {
    const safeFrame = new Graphics()
    safeFrame.roundRect(24, 40, this.frame.width - 48, this.frame.height - 80, 16)
    safeFrame.stroke({ color: "#ffffff", alpha: 0.24, width: 1 })
    this.app.stage.addChild(safeFrame)
  }

  drawCaption(shot) {
    const panel = new Graphics()
    panel.roundRect(28, this.frame.height - 88, this.frame.width - 56, 52, 12)
    panel.fill({ color: "#18181b", alpha: 0.84 })
    this.app.stage.addChild(panel)

    const label = new Text({
      text: shot.label,
      style: new TextStyle({
        fill: "#ffffff",
        fontFamily: "Arial",
        fontSize: 18,
        fontWeight: "700"
      })
    })

    label.x = 44
    label.y = this.frame.height - 72
    this.app.stage.addChild(label)
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

  fitSprite(sprite, crop) {
    const cropWidth = Math.max(crop.width, 0.01)
    const cropHeight = Math.max(crop.height, 0.01)
    const croppedTextureWidth = sprite.texture.width * cropWidth
    const croppedTextureHeight = sprite.texture.height * cropHeight
    const scale = Math.max(this.frame.width / croppedTextureWidth, this.frame.height / croppedTextureHeight)

    sprite.scale.set(scale)
    sprite.x = (this.frame.width - sprite.texture.width * scale) / 2 - sprite.texture.width * scale * crop.x
    sprite.y = (this.frame.height - sprite.texture.height * scale) / 2 - sprite.texture.height * scale * crop.y
  }
}
