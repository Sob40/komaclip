require "test_helper"

module SceneContracts
  class PixiContractNormalizerTest < ActiveSupport::TestCase
    test "fills pixi contracts for legacy shots without changing source material" do
      legacy_contract = clips(:two).scene_contract.deep_dup
      legacy_contract["shots"].first.except!("pixiTextStyle", "pixiCameraMotion", "pixiActiveEffect", "pixiTransitionOut", "pixiRhythm", "pixiVisualPresetIds")
      legacy_contract["shots"].first["text"] = "Legacy hook"
      legacy_contract["shots"].first["sceneBubble"] = "burst"
      legacy_contract["shots"].first["sceneMotion"] = "impact"

      normalized = PixiContractNormalizer.new(
        project: projects(:two),
        contract: legacy_contract,
        proposal: { "genre" => "action", "intensity" => "intense" }
      ).call
      shot = normalized.fetch("shots").first

      assert_equal "pixi", normalized.fetch("renderer")
      assert_equal "Legacy hook", shot.fetch("text")
      assert_equal "tx-manga-dokan-explosion-sfx", shot.fetch("pixiTextStyle").fetch("id")
      assert_equal [ "shonen-sfx-burst-bubble" ], shot.fetch("pixiTextStyle").fetch("parameters").fetch("assetSlots").map { |slot| slot.fetch("id") }
      assert_equal "fx-camera-crash-punch-in", shot.fetch("pixiCameraMotion").fetch("id")
      assert_equal "impact", shot.fetch("pixiCameraMotion").fetch("motionStyle")
      assert_equal "fx-impact-freeze-punch", shot.fetch("pixiActiveEffect").fetch("id")
      assert_equal [ "shonen-impact-frame", "shonen-speed-lines-radial" ], shot.fetch("pixiActiveEffect").fetch("parameters").fetch("assetSlots").map { |slot| slot.fetch("id") }
      assert_equal "rhythm-hook-impact", shot.fetch("pixiRhythm").fetch("id")
      assert_includes shot.fetch("pixiVisualPresetIds"), "rhythm-hook-impact"
      assert_equal "baseline-panel-sequence", normalized.fetch("visual").fetch("presetId")
      assert normalized.fetch("music").fetch("id").present?
    end
  end
end
