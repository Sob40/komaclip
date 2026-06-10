require "test_helper"

class ProjectAssetTest < ActiveSupport::TestCase
  test "requires user to own the project" do
    asset = project_assets(:one)
    asset.user = users(:two)

    assert_not asset.valid?
    assert_includes asset.errors[:user], "must own the project"
  end

  test "requires positive byte size" do
    asset = project_assets(:one)
    asset.byte_size = 0

    assert_not asset.valid?
    assert_includes asset.errors[:byte_size], "must be greater than 0"
  end
end
