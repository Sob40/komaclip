require "test_helper"

module SceneContracts
  class InitialClipBuilderTest < ActiveSupport::TestCase
    test "builds a pixi scene contract from ordered panels" do
      contract = InitialClipBuilder.new(project: projects(:one), panels: [ panels(:one) ]).build

      assert_equal "komaclip.scene.v1", contract.fetch("contractVersion")
      assert_equal "pixi", contract.fetch("renderer")
      assert_equal({ "width" => 1080, "height" => 1920, "fps" => 30 }, contract.fetch("format"))
      assert_equal 8000, contract.fetch("durationMs")
      assert_equal projects(:one).content_locale, contract.fetch("contentLocale")
      assert_equal({ "goal" => "readers", "style" => "chapter_clean", "format" => "vertical_social" }, contract.fetch("direction"))
      assert_equal "p2r.visual.v2", contract.fetch("visual").fetch("catalogContractVersion")
      assert_equal(
        { "presetKey" => "chapter_clean", "genre" => "drama", "source" => "komaclip-director-lite" },
        contract.fetch("visual").fetch("montage")
      )
      assert_equal "i-wont-surrender", contract.fetch("music").fetch("id")
      assert_equal MusicCatalog::DEFAULT_VOLUME, contract.fetch("music").fetch("volume")
      assert_equal 1, contract.fetch("shots").size

      shot = contract.fetch("shots").first
      assert_equal panels(:one).id, shot.fetch("panelId")
      assert_equal project_assets(:one).id, shot.fetch("assetId")
      assert_equal "HOOK", shot.fetch("phase")
      assert_equal panels(:one).crop, shot.fetch("crop")
      assert_nil shot["text"]
      assert_equal 0, shot.fetch("startMs")
      assert_equal 8000, shot.fetch("endMs")
      assert_equal 8000, shot.fetch("durationMs")
      assert_equal "auto", shot.fetch("pace")
      assert_equal "auto", shot.fetch("effectIntensity")
      assert_nil shot["overlay"]
      assert_equal({ "style" => "cinematic", "source" => "direction", "intensity" => "auto" }, shot.fetch("motion"))
      assert_equal "none", shot.fetch("transition")
      assert_equal "fx-camera-page-glide", shot.fetch("pixiCameraMotion").fetch("id")
      assert_equal "scroll", shot.fetch("pixiCameraMotion").fetch("motionStyle")
      assert_equal "fx-panel-zoom-editorial", shot.fetch("pixiActiveEffect").fetch("id")
      assert_equal [ "noir-ink-grain" ], shot.fetch("pixiActiveEffect").fetch("parameters").fetch("assetSlots").map { |slot| slot.fetch("id") }
      assert_equal "rhythm-hook-cinematic", shot.fetch("pixiRhythm").fetch("id")
      assert_equal "hook", shot.fetch("pixiRhythm").fetch("parameters").fetch("intensity")
      assert_nil shot["pixiTextStyle"]
      assert_nil shot["pixiTransitionOut"]
      assert_equal [ "fx-camera-page-glide", "fx-panel-zoom-editorial", "rhythm-hook-cinematic" ], shot.fetch("pixiVisualPresetIds")
      assert_includes shot.fetch("pixiTags"), "style:chapter_clean"
      assert_includes shot.fetch("pixiTags"), "mvpStyle:chapter-clean"
    end

    test "includes scene text from panel metadata" do
      panel = panels(:one)
      panel.update!(metadata: { "sceneText" => "New chapter starts here" })

      contract = InitialClipBuilder.new(project: projects(:one), panels: [ panel ]).build

      shot = contract.fetch("shots").first
      assert_equal "New chapter starts here", shot.fetch("text")
      assert_equal(
        { "text" => "New chapter starts here", "source" => "scene_text", "style" => "caption", "position" => "top_safe", "size" => "large" },
        shot.fetch("overlay")
      )
      assert_equal "tx-editorial-safe-lower-caption", shot.fetch("pixiTextStyle").fetch("id")
      assert_equal "lower-third", shot.fetch("pixiTextStyle").fetch("catalogLayout")
      assert_equal "top_safe", shot.fetch("pixiTextStyle").fetch("parameters").fetch("position")
      assert_equal "large", shot.fetch("pixiTextStyle").fetch("parameters").fetch("size")
      assert_equal [ "noir-ink-grain" ], shot.fetch("pixiTextStyle").fetch("parameters").fetch("assetSlots").map { |slot| slot.fetch("id") }
    end

    test "includes mvp scene controls and suppresses text when requested" do
      panel = panels(:one)
      panel.update!(
        metadata: {
          "sceneText" => "Hidden caption",
          "noText" => true,
          "sceneMotion" => "impact",
          "sceneBubble" => "burst",
          "scenePosition" => "bottom_real",
          "sceneSize" => "large",
          "sceneDuration" => "short",
          "sceneTransition" => "panel_slam"
        }
      )

      contract = InitialClipBuilder.new(project: projects(:one), panels: [ panel ]).build
      shot = contract.fetch("shots").first

      assert_nil shot["text"]
      assert_equal true, shot.fetch("noText")
      assert_equal "impact", shot.fetch("sceneMotion")
      assert_equal "burst", shot.fetch("sceneBubble")
      assert_equal "bottom_real", shot.fetch("scenePosition")
      assert_equal "large", shot.fetch("sceneSize")
      assert_equal "short", shot.fetch("sceneDuration")
      assert_nil shot["overlay"]
      assert_equal({ "style" => "impact", "source" => "scene", "intensity" => "auto" }, shot.fetch("motion"))
      assert_equal "none", shot.fetch("transition")
    end

    test "includes proposal settings when provided" do
      proposal = { "genre" => "action", "sceneTime" => "auto", "intensity" => "balanced", "brief" => "Fast hook" }

      contract = InitialClipBuilder.new(project: projects(:one), panels: [ panels(:one) ], proposal: proposal).build

      assert_equal proposal, contract.fetch("proposal")
      assert_equal "balanced", contract.fetch("visual").fetch("intensity")
      assert_equal "epical-drums-01", contract.fetch("music").fetch("id")
    end

    test "uses proposal scene time to recommend clip duration" do
      project = projects(:one)
      second_panel = project.panels.create!(project_asset: project_assets(:one), position: 2, label: "Scene 2")
      third_panel = project.panels.create!(project_asset: project_assets(:one), position: 3, label: "Scene 3")
      panels = [ panels(:one), second_panel, third_panel ]

      contract = InitialClipBuilder.new(
        project: project,
        panels: panels,
        proposal: { "sceneTime" => "cinematic", "intensity" => "intense" }
      ).build

      assert_equal 22_000, contract.fetch("durationMs")
      assert_equal "intense", contract.fetch("visual").fetch("intensity")
      assert_equal [ "HOOK", "CLIMAX", "CLOSE" ], contract.fetch("shots").map { |shot| shot.fetch("phase") }
      assert_equal [ 7_333, 7_333, 7_334 ], contract.fetch("shots").map { |shot| shot.fetch("durationMs") }
      assert_equal [ 0, 7_333, 14_666 ], contract.fetch("shots").map { |shot| shot.fetch("startMs") }
      assert_equal [ 7_333, 14_666, 22_000 ], contract.fetch("shots").map { |shot| shot.fetch("endMs") }
      assert_equal [ "cinematic", "scroll", "float" ], contract.fetch("shots").map { |shot| shot.fetch("motion").fetch("style") }
      assert_equal [ "none", "cut", "cut" ], contract.fetch("shots").map { |shot| shot.fetch("transition") }
      assert_equal [ "cinematic", "cinematic", "cinematic" ], contract.fetch("shots").map { |shot| shot.fetch("pace") }
      assert_equal [ "intense", "intense", "intense" ], contract.fetch("shots").map { |shot| shot.fetch("effectIntensity") }
    end

    test "uses direction style variants for motion transition and pixi tags" do
      project = projects(:one)
      project.update!(
        metadata: {
          "direction" => {
            "goal" => "launch",
            "style" => "impact_fast",
            "format" => "vertical_social"
          }
        }
      )
      second_panel = project.panels.create!(project_asset: project_assets(:one), position: 2, label: "Scene 2")
      third_panel = project.panels.create!(project_asset: project_assets(:one), position: 3, label: "Scene 3")
      fourth_panel = project.panels.create!(project_asset: project_assets(:one), position: 4, label: "Scene 4")

      contract = InitialClipBuilder.new(
        project: project,
        panels: [ panels(:one), second_panel, third_panel, fourth_panel ],
        proposal: { "genre" => "action", "sceneTime" => "short", "intensity" => "intense" }
      ).build

      assert_equal "impact_fast", contract.fetch("visual").fetch("montage").fetch("presetKey")
      assert_equal [ "manga", "impact", "impact", "rgb" ], contract.fetch("shots").map { |shot| shot.fetch("motion").fetch("style") }
      assert_equal [ "none", "speed_wipe", "ink_flash", "panel_slam" ], contract.fetch("shots").map { |shot| shot.fetch("transition") }
      assert_includes contract.fetch("shots").third.fetch("pixiTags"), "genre:action"
      assert_equal "fx-manga-halftone-burst", contract.fetch("shots").third.fetch("pixiActiveEffect").fetch("id")
      assert_equal "manga-halftone-burst-pro-vfx", contract.fetch("shots").third.fetch("pixiActiveEffect").fetch("layout")
      assert_equal [ "shonen-impact-frame", "shonen-speed-lines-radial" ], contract.fetch("shots").third.fetch("pixiActiveEffect").fetch("parameters").fetch("assetSlots").map { |slot| slot.fetch("id") }
      assert_equal "rhythm-climax-impact", contract.fetch("shots").third.fetch("pixiRhythm").fetch("id")
      assert_equal "hit", contract.fetch("shots").third.fetch("pixiRhythm").fetch("parameters").fetch("intensity")
      assert_equal "tr-glitch-tear", contract.fetch("shots").third.fetch("pixiTransitionOut").fetch("id")
      assert_equal "glitch-tear", contract.fetch("shots").third.fetch("pixiTransitionOut").fetch("parameters").fetch("layout")
      assert_equal [ "horror-scratch-lines", "horror-dirty-fog" ], contract.fetch("shots").third.fetch("pixiTransitionOut").fetch("parameters").fetch("assetSlots").map { |slot| slot.fetch("id") }
      assert_includes contract.fetch("shots").third.fetch("pixiVisualPresetIds"), "tr-glitch-tear"
    end

    test "applies safe template settings from project metadata" do
      project = projects(:one)
      project.update!(
        metadata: {
          "templateSettings" => {
            "durationMs" => 12_000,
            "format" => { "width" => 720, "height" => 1280, "fps" => 24 },
            "visual" => {
              "presetId" => "soft-pan",
              "catalogContractVersion" => "p2r.visual.v2",
              "ignored" => { "nested" => true }
            },
            "music" => { "id" => "cyberpunk-city", "volume" => 28 }
          }
        }
      )

      contract = InitialClipBuilder.new(project: project, panels: [ panels(:one) ]).build

      assert_equal 12_000, contract.fetch("durationMs")
      assert_equal({ "width" => 720, "height" => 1280, "fps" => 24 }, contract.fetch("format"))
      assert_equal "soft-pan", contract.fetch("visual").fetch("presetId")
      assert_nil contract.fetch("visual")["ignored"]
      assert_equal "cyberpunk-city", contract.fetch("music").fetch("id")
      assert_equal 28, contract.fetch("music").fetch("volume")
      assert_equal 12_000, contract.fetch("shots").first.fetch("durationMs")
    end

    test "falls back when template settings are out of range" do
      project = projects(:one)
      project.update!(
        metadata: {
          "templateSettings" => {
            "durationMs" => 500_000,
            "format" => { "width" => 10_000, "height" => 1, "fps" => 500 }
          }
        }
      )

      contract = InitialClipBuilder.new(project: project, panels: [ panels(:one) ]).build

      assert_equal 60_000, contract.fetch("durationMs")
      assert_equal({ "width" => 1080, "height" => 1920, "fps" => 30 }, contract.fetch("format"))
    end
  end
end
