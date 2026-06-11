require "test_helper"

class ClipTemplateTest < ActiveSupport::TestCase
  test "builds lightweight settings from a clip without storing shots" do
    clip = clips(:two)
    template = ClipTemplate.from_clip(user: users(:two), clip: clip)

    assert_equal clip.title, template.name
    assert_equal "es", template.content_locale
    assert_equal "pixi", template.settings.fetch("renderer")
    assert_equal "baseline-panel-sequence", template.settings.dig("visual", "presetId")
    assert_nil template.settings["shots"]
  end
end
