require "test_helper"

class PanelTest < ActiveSupport::TestCase
  test "requires asset to belong to the same project" do
    panel = panels(:one)
    panel.project_asset = project_assets(:two)

    assert_not panel.valid?
    assert_includes panel.errors[:project_asset], "must belong to the project"
  end

  test "requires unique position within project" do
    panel = Panel.new(project: projects(:one), project_asset: project_assets(:one), position: panels(:one).position)

    assert_not panel.valid?
    assert_includes panel.errors[:position], "has already been taken"
  end

  test "defaults to full normalized crop" do
    panel = Panel.new(project: projects(:one), project_asset: project_assets(:one), position: 2)

    assert panel.valid?
    assert_equal Panel::FULL_CROP, panel.crop
    assert_equal "Panel 2", panel.label
  end

  test "recognizes full normalized crop" do
    assert Panel.full_crop?(Panel::FULL_CROP)
    assert panels(:one).full_crop?
    assert_not Panel.full_crop?({ "unit" => "normalized", "x" => 0.1, "y" => 0.0, "width" => 0.9, "height" => 1.0 })
  end

  test "requires crop to stay inside normalized image bounds" do
    panel = Panel.new(
      project: projects(:one),
      project_asset: project_assets(:one),
      position: 2,
      crop: { "unit" => "normalized", "x" => 0.8, "y" => 0.0, "width" => 0.4, "height" => 1.0 }
    )

    assert_not panel.valid?
    assert_includes panel.errors[:crop], "must stay within the image"
  end

  test "requires an extractable source asset" do
    asset = project_assets(:one)
    asset.kind = "reference_image"
    panel = Panel.new(project: projects(:one), project_asset: asset, position: 2)

    assert_not panel.valid?
    assert_includes panel.errors[:project_asset], "must be a ready source page or panel image"
  end
end
