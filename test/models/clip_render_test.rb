require "test_helper"

class ClipRenderTest < ActiveSupport::TestCase
  test "requires user to own the project" do
    render = clip_renders(:one)
    render.user = users(:two)

    assert_not render.valid?
    assert_includes render.errors[:user], "must own the project"
  end

  test "requires clip to belong to project" do
    render = clip_renders(:one)
    render.clip = clips(:two)

    assert_not render.valid?
    assert_includes render.errors[:clip], "must belong to the project"
  end

  test "only pixi renderer is allowed for now" do
    render = clip_renders(:one)
    render.renderer = "remotion"

    assert_not render.valid?
    assert_includes render.errors[:renderer], "is not included in the list"
  end
end
