require "test_helper"

class PanelsControllerTest < ActionDispatch::IntegrationTest
  test "create requires authentication" do
    post project_asset_panels_path(project_id: projects(:one), asset_id: project_assets(:one))

    assert_redirected_to new_session_path
  end

  test "create extracts full-page panel from owned asset" do
    asset = create_asset_for(users(:one), projects(:one))
    sign_in_as(users(:one))

    assert_difference -> { projects(:one).panels.count }, 1 do
      post project_asset_panels_path(project_id: projects(:one), asset_id: asset)
    end

    panel = projects(:one).panels.order(:position).last
    assert_equal asset, panel.project_asset
    assert_equal 2, panel.position
    assert_equal Panel::FULL_CROP, panel.crop
    assert_redirected_to project_panel_path(project_id: projects(:one), id: panel)
  end

  test "create redirects to existing full-page panel for the same asset" do
    sign_in_as(users(:one))

    assert_no_difference -> { projects(:one).panels.count } do
      post project_asset_panels_path(project_id: projects(:one), asset_id: project_assets(:one))
    end

    assert_redirected_to project_panel_path(project_id: projects(:one), id: panels(:one))
    follow_redirect!
    assert_select "div", /full-page panel already exists/
  end

  test "create rejects another user's asset" do
    sign_in_as(users(:one))

    post project_asset_panels_path(project_id: projects(:two), asset_id: project_assets(:two))

    assert_response :not_found
  end

  test "show renders owned panel" do
    sign_in_as(users(:one))

    get project_panel_path(project_id: projects(:one), id: panels(:one))

    assert_response :success
    assert_select "h1", panels(:one).label
    assert_select "a", text: project_assets(:one).filename
  end

  test "show rejects another user's panel" do
    sign_in_as(users(:one))

    get project_panel_path(project_id: projects(:two), id: panels(:two))

    assert_response :not_found
  end

  test "update saves scene text for owned panel and marks material dirty" do
    projects(:one).update!(metadata: { "materialReady" => true })
    sign_in_as(users(:one))

    patch project_panel_path(project_id: projects(:one), id: panels(:one)), params: {
      panel: { scene_text: "Launch reveal" }
    }

    assert_redirected_to project_path(id: projects(:one))
    assert_equal "Launch reveal", panels(:one).reload.metadata.fetch("sceneText")
    assert_equal false, projects(:one).reload.metadata.fetch("materialReady")
  end

  test "update rejects oversized scene text" do
    projects(:one).update!(metadata: { "materialReady" => true })
    sign_in_as(users(:one))

    patch project_panel_path(project_id: projects(:one), id: panels(:one)), params: {
      panel: { scene_text: "x" * (Panel::MAX_SCENE_TEXT_LENGTH + 1) }
    }

    assert_redirected_to project_path(id: projects(:one))
    assert_nil panels(:one).reload.metadata["sceneText"]
    assert_equal true, projects(:one).reload.metadata.fetch("materialReady")
  end

  test "duplicate inserts a copied scene after the original" do
    projects(:one).update!(metadata: { "materialReady" => true })
    sign_in_as(users(:one))

    assert_difference -> { projects(:one).panels.count }, 1 do
      post duplicate_project_panel_path(project_id: projects(:one), id: panels(:one))
    end

    duplicate = projects(:one).panels.order(:position).second
    assert_equal project_assets(:one), duplicate.project_asset
    assert_equal 2, duplicate.position
    assert_equal "Scene 2", duplicate.label
    assert_equal false, projects(:one).reload.metadata.fetch("materialReady")
    assert_redirected_to project_path(id: projects(:one))
  end

  test "reorder persists scene order and marks material dirty" do
    second_asset = create_asset_for(users(:one), projects(:one))
    second_panel = projects(:one).panels.create!(project_asset: second_asset, position: 2, label: "Scene 2")
    projects(:one).update!(metadata: { "materialReady" => true })
    sign_in_as(users(:one))

    patch reorder_project_panels_path(project_id: projects(:one)), params: {
      panel_ids: [ second_panel.id, panels(:one).id ]
    }, as: :json

    assert_response :success
    assert_equal [ second_panel.id, panels(:one).id ], projects(:one).panels.order(:position).pluck(:id)
    assert_equal false, projects(:one).reload.metadata.fetch("materialReady")
  end

  test "destroy removes owned panel" do
    panel = Panel.create!(project: projects(:one), project_asset: project_assets(:one), position: 2)
    sign_in_as(users(:one))

    assert_difference -> { projects(:one).panels.count }, -1 do
      delete project_panel_path(project_id: projects(:one), id: panel)
    end

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
end
