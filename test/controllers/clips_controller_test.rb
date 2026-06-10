require "test_helper"

class ClipsControllerTest < ActionDispatch::IntegrationTest
  test "create requires authentication" do
    post project_clips_path(project_id: projects(:one))

    assert_redirected_to new_session_path
  end

  test "create requires panels" do
    project = users(:one).projects.create!(title: "Empty project", content_locale: "en")
    sign_in_as(users(:one))

    assert_no_difference -> { project.clips.count } do
      post project_clips_path(project_id: project)
    end

    assert_redirected_to project_path(id: project)
    follow_redirect!
    assert_select "div", /Create at least one panel/
  end

  test "create builds ready clip from owned panels" do
    sign_in_as(users(:one))

    assert_difference -> { projects(:one).clips.count }, 1 do
      post project_clips_path(project_id: projects(:one))
    end

    clip = projects(:one).clips.order(:position).last
    assert_equal "ready", clip.status
    assert_equal 8000, clip.duration_ms
    assert_equal "pixi", clip.scene_contract.fetch("renderer")
    assert_equal [ panels(:one).id ], clip.scene_contract.fetch("shots").map { |shot| shot.fetch("panelId") }
    assert_redirected_to project_clip_path(project_id: projects(:one), id: clip)
  end

  test "create rejects another user's project" do
    sign_in_as(users(:one))

    post project_clips_path(project_id: projects(:two))

    assert_response :not_found
  end

  test "show renders owned clip" do
    clip = create_clip_for(projects(:one))
    sign_in_as(users(:one))

    get project_clip_path(project_id: projects(:one), id: clip)

    assert_response :success
    assert_select "h1", clip.title
    assert_select "[data-controller='clip-preview']"
    assert_select "script[type='application/json']", /komaclip.scene.v1/
    assert_select "pre", /komaclip.scene.v1/
  end

  test "show signs asset urls only in preview payload" do
    project = users(:one).projects.create!(title: "Signed preview project", content_locale: "en")
    asset = create_asset_for(users(:one), project)
    project.panels.create!(project_asset: asset, position: 1, label: "Attached panel")
    clip = create_clip_for(project)
    sign_in_as(users(:one))

    get project_clip_path(project_id: project, id: clip)

    assert_response :success
    assert_select "script[type='application/json']", /rails\/active_storage/
    refute_includes JSON.generate(clip.reload.scene_contract), "rails/active_storage"
  end

  test "show rejects another user's clip" do
    sign_in_as(users(:one))

    get project_clip_path(project_id: projects(:two), id: clips(:two))

    assert_response :not_found
  end

  test "destroy removes owned clip" do
    clip = create_clip_for(projects(:one))
    sign_in_as(users(:one))

    assert_difference -> { projects(:one).clips.count }, -1 do
      delete project_clip_path(project_id: projects(:one), id: clip)
    end

    assert_redirected_to project_path(id: projects(:one))
  end

  private

    def create_clip_for(project)
      panels = project.panels.includes(:project_asset).order(:position)

      project.clips.create!(
        title: "Controller test clip",
        position: 2,
        status: "ready",
        duration_ms: SceneContracts::InitialClipBuilder::DEFAULT_DURATION_MS,
        scene_contract: SceneContracts::InitialClipBuilder.new(project: project, panels: panels).build
      )
    end

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
