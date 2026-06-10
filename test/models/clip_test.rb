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
end
