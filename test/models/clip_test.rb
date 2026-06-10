require "test_helper"

class ClipTest < ActiveSupport::TestCase
  test "requires valid status" do
    clip = clips(:one)
    clip.status = "rendering"

    assert_not clip.valid?
    assert_includes clip.errors[:status], "is not included in the list"
  end

  test "requires non-negative duration" do
    clip = clips(:one)
    clip.duration_ms = -1

    assert_not clip.valid?
    assert_includes clip.errors[:duration_ms], "must be greater than or equal to 0"
  end

  test "ready clip requires valid scene contract" do
    clip = clips(:one)
    clip.status = "ready"
    clip.duration_ms = 8000
    clip.scene_contract = {}

    assert_not clip.valid?
    assert_includes clip.errors[:scene_contract], "must use the current contract version"
    assert_includes clip.errors[:scene_contract], "must include at least one shot"
  end

  test "accepts initial pixi scene contract" do
    panels = [ panels(:one) ]
    contract = SceneContracts::InitialClipBuilder.new(project: projects(:one), panels: panels).build
    clip = Clip.new(project: projects(:one), title: "Initial clip", position: 2, status: "ready", duration_ms: 8000, scene_contract: contract)

    assert clip.valid?
  end
end
