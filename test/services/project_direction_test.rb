require "test_helper"

class ProjectDirectionTest < ActiveSupport::TestCase
  test "proposal defaults follow selected style" do
    defaults = ProjectDirection.proposal_defaults_for("style" => "impact_fast")

    assert_equal "action", defaults.fetch("genre")
    assert_equal "short", defaults.fetch("sceneTime")
    assert_equal "intense", defaults.fetch("intensity")
  end

  test "proposal defaults fall back safely" do
    defaults = ProjectDirection.proposal_defaults_for("style" => "unknown")

    assert_equal "drama", defaults.fetch("genre")
    assert_equal "standard", defaults.fetch("sceneTime")
    assert_equal "subtle", defaults.fetch("intensity")
  end
end
