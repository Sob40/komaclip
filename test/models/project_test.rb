require "test_helper"

class ProjectTest < ActiveSupport::TestCase
  test "requires supported content locale" do
    project = projects(:one)
    project.content_locale = "fr"

    assert_not project.valid?
    assert_includes project.errors[:content_locale], "is not included in the list"
  end

  test "normalizes title whitespace" do
    project = Project.new(user: users(:one), title: "  My launch  ")

    assert_equal "My launch", project.title
  end
end
