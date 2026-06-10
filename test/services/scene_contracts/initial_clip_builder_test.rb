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
      assert_equal "p2r.visual.v2", contract.fetch("visual").fetch("catalogContractVersion")
      assert_equal 1, contract.fetch("shots").size

      shot = contract.fetch("shots").first
      assert_equal panels(:one).id, shot.fetch("panelId")
      assert_equal project_assets(:one).id, shot.fetch("assetId")
      assert_equal panels(:one).crop, shot.fetch("crop")
      assert_equal "none", shot.fetch("transition")
    end
  end
end
