require "test_helper"

class ProjectAssetsControllerTest < ActionDispatch::IntegrationTest
  test "create requires authentication" do
    post project_assets_path(project_id: projects(:one)), params: {
      project_asset: { kind: "source_page", file: sample_image_upload }
    }

    assert_redirected_to new_session_path
  end

  test "create attaches image asset to owned project" do
    projects(:one).update!(metadata: { "materialReady" => true })
    sign_in_as(users(:one))

    assert_difference -> { projects(:one).project_assets.count }, 1 do
      assert_difference -> { projects(:one).panels.count }, 1 do
        post project_assets_path(project_id: projects(:one)), params: {
          project_asset: { kind: "source_page", file: sample_image_upload }
        }
      end
    end

    asset = projects(:one).project_assets.order(:created_at).last
    panel = projects(:one).panels.order(:position).last
    assert_equal users(:one), asset.user
    assert_equal "sample-page.png", asset.filename
    assert_equal "image/png", asset.content_type
    assert_equal "ready", asset.status
    assert asset.file.attached?
    assert_equal asset, panel.project_asset
    assert_equal "Scene 2", panel.label
    assert_equal false, projects(:one).reload.metadata.fetch("materialReady")
    assert_redirected_to project_path(id: projects(:one))
  end

  test "create attaches multiple image assets to owned project" do
    sign_in_as(users(:one))

    assert_difference -> { projects(:one).project_assets.count }, 2 do
      assert_difference -> { projects(:one).panels.count }, 2 do
        post project_assets_path(project_id: projects(:one)), params: {
          project_asset: { kind: "source_page", files: [ sample_image_upload, sample_image_upload ] }
        }
      end
    end

    assert_redirected_to project_path(id: projects(:one))
    follow_redirect!
    assert_select "div", /2 assets uploaded/
  end

  test "create rejects multi upload batch when one file is invalid" do
    sign_in_as(users(:one))

    assert_no_difference -> { projects(:one).project_assets.count } do
      post project_assets_path(project_id: projects(:one)), params: {
        project_asset: { kind: "source_page", files: [ sample_image_upload, text_upload ] }
      }
    end

    assert_redirected_to project_path(id: projects(:one))
    follow_redirect!
    assert_select "div", /real JPG, PNG, or WebP/
  end

  test "create rejects blank multi upload without model translation noise" do
    sign_in_as(users(:one))

    assert_no_difference -> { projects(:one).project_assets.count } do
      post project_assets_path(project_id: projects(:one), locale: :es), params: {
        project_asset: { kind: "source_page", files: [ "" ] }
      }
    end

    assert_redirected_to project_path(id: projects(:one), locale: :es)
    follow_redirect!
    assert_select "div", "Elige al menos un archivo."
    assert_select "body", text: /Translation missing/, count: 0
  end

  test "create rejects unsupported file type" do
    sign_in_as(users(:one))

    assert_no_difference -> { projects(:one).project_assets.count } do
      post project_assets_path(project_id: projects(:one)), params: {
        project_asset: { kind: "source_page", file: text_upload }
      }
    end

    assert_redirected_to project_path(id: projects(:one))
    follow_redirect!
    assert_select "div", /real JPG, PNG, or WebP/
  end

  test "create rejects spoofed image file" do
    sign_in_as(users(:one))

    assert_no_difference -> { projects(:one).project_assets.count } do
      post project_assets_path(project_id: projects(:one)), params: {
        project_asset: { kind: "source_page", file: spoofed_image_upload }
      }
    end

    assert_redirected_to project_path(id: projects(:one))
    follow_redirect!
    assert_select "div", /real JPG, PNG, or WebP/
  end

  test "create rejects another user's project" do
    sign_in_as(users(:one))

    post project_assets_path(project_id: projects(:two)), params: {
      project_asset: { kind: "source_page", file: sample_image_upload }
    }

    assert_response :not_found
  end

  test "show renders owned asset" do
    asset = create_asset_for(users(:one), projects(:one))
    sign_in_as(users(:one))

    get project_asset_path(project_id: projects(:one), id: asset)

    assert_response :success
    assert_select "h1", "sample-page.png"
  end

  test "show rejects another user's asset" do
    sign_in_as(users(:one))

    get project_asset_path(project_id: projects(:two), id: project_assets(:two))

    assert_response :not_found
  end

  test "download redirects to a signed blob URL" do
    asset = create_asset_for(users(:one), projects(:one))
    sign_in_as(users(:one))

    get download_project_asset_path(project_id: projects(:one), id: asset)

    assert_response :redirect
    assert_includes response.location, "/rails/active_storage/"
  end

  test "destroy removes owned asset" do
    asset = create_asset_for(users(:one), projects(:one))
    panel = projects(:one).panels.create!(project_asset: asset, position: 2, label: "Disposable scene")
    projects(:one).update!(metadata: { "materialReady" => true })
    sign_in_as(users(:one))

    assert_difference -> { projects(:one).project_assets.count }, -1 do
      assert_difference -> { projects(:one).panels.count }, -1 do
        delete project_asset_path(project_id: projects(:one), id: asset)
      end
    end

    assert_not Panel.exists?(panel.id)
    assert_equal false, projects(:one).reload.metadata.fetch("materialReady")
    assert_redirected_to project_path(id: projects(:one))
  end

  private

    def create_asset_for(user, project)
      project.project_assets.create!(
        user: user,
        kind: "source_page",
        file: sample_image_upload
      )
    end

    def sample_image_upload
      Rack::Test::UploadedFile.new(Rails.root.join("test/fixtures/files/sample-page.png"), "image/png")
    end

    def text_upload
      Rack::Test::UploadedFile.new(Rails.root.join("test/fixtures/files/sample-not-image.txt"), "text/plain")
    end

    def spoofed_image_upload
      Rack::Test::UploadedFile.new(Rails.root.join("test/fixtures/files/fake-page.png"), "image/png")
    end
end
