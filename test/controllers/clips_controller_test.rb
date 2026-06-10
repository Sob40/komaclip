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
    assert_select "pre", /komaclip.scene.v1/
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
end
