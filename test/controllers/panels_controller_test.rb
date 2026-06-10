require "test_helper"

class PanelsControllerTest < ActionDispatch::IntegrationTest
  test "create requires authentication" do
    post project_asset_panels_path(project_id: projects(:one), asset_id: project_assets(:one))

    assert_redirected_to new_session_path
  end

  test "create extracts full-page panel from owned asset" do
    sign_in_as(users(:one))

    assert_difference -> { projects(:one).panels.count }, 1 do
      post project_asset_panels_path(project_id: projects(:one), asset_id: project_assets(:one))
    end

    panel = projects(:one).panels.order(:position).last
    assert_equal project_assets(:one), panel.project_asset
    assert_equal 2, panel.position
    assert_equal Panel::FULL_CROP, panel.crop
    assert_redirected_to project_panel_path(project_id: projects(:one), id: panel)
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

  test "destroy removes owned panel" do
    panel = Panel.create!(project: projects(:one), project_asset: project_assets(:one), position: 2)
    sign_in_as(users(:one))

    assert_difference -> { projects(:one).panels.count }, -1 do
      delete project_panel_path(project_id: projects(:one), id: panel)
    end

    assert_redirected_to project_path(id: projects(:one))
  end
end
