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
end
