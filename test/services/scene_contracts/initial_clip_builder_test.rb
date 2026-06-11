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
      assert_equal({ "goal" => "readers", "style" => "chapter_clean", "format" => "reels_9_16" }, contract.fetch("direction"))
      assert_equal "p2r.visual.v2", contract.fetch("visual").fetch("catalogContractVersion")
      assert_equal 1, contract.fetch("shots").size

      shot = contract.fetch("shots").first
      assert_equal panels(:one).id, shot.fetch("panelId")
      assert_equal project_assets(:one).id, shot.fetch("assetId")
      assert_equal panels(:one).crop, shot.fetch("crop")
      assert_nil shot["text"]
      assert_equal "none", shot.fetch("transition")
    end

    test "includes scene text from panel metadata" do
      panel = panels(:one)
      panel.update!(metadata: { "sceneText" => "New chapter starts here" })

      contract = InitialClipBuilder.new(project: projects(:one), panels: [ panel ]).build

      assert_equal "New chapter starts here", contract.fetch("shots").first.fetch("text")
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
            }
          }
        }
      )

      contract = InitialClipBuilder.new(project: project, panels: [ panels(:one) ]).build

      assert_equal 12_000, contract.fetch("durationMs")
      assert_equal({ "width" => 720, "height" => 1280, "fps" => 24 }, contract.fetch("format"))
      assert_equal "soft-pan", contract.fetch("visual").fetch("presetId")
      assert_nil contract.fetch("visual")["ignored"]
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
