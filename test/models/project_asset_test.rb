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

  test "syncs metadata from attached file" do
    asset = ProjectAsset.create!(
      project: projects(:one),
      user: users(:one),
      kind: "source_page",
      file: Rack::Test::UploadedFile.new(Rails.root.join("test/fixtures/files/sample-page.png"), "image/png")
    )

    assert_equal "sample-page.png", asset.filename
    assert_equal "image/png", asset.content_type
    assert_equal "ready", asset.status
    assert asset.byte_size.positive?
    assert asset.storage_key.present?
    assert asset.checksum.present?
    assert_equal({ "width" => 10, "height" => 10 }, asset.metadata.fetch("image"))
  end

  test "rejects files that spoof an image extension and content type" do
    asset = ProjectAsset.new(
      project: projects(:one),
      user: users(:one),
      kind: "source_page",
      file: Rack::Test::UploadedFile.new(Rails.root.join("test/fixtures/files/fake-page.png"), "image/png")
    )

    assert_not asset.valid?
    assert_includes asset.errors[:file], "must be a real JPG, PNG, or WebP image"
  end
end
