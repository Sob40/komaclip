require "test_helper"

class ProjectsControllerTest < ActionDispatch::IntegrationTest
  test "new requires authentication" do
    get new_project_path

    assert_redirected_to new_session_path
  end

  test "dashboard opens current clip maker workspace" do
    sign_in_as(users(:one))

    get dashboard_path

    assert_redirected_to project_path(id: users(:one).projects.order(updated_at: :desc).first)
  end

  test "new renders project form with current user locale as content default" do
    user = users(:one)
    user.update!(locale: "es")
    sign_in_as(user)

    get new_project_path(locale: :es)

    assert_response :success
    assert_select "h1", "Nuevo clip"
    assert_select "select[name=?] option[value=?][selected]", "project[content_locale]", "es"
  end

  test "create persists project for current user" do
    sign_in_as(users(:one))

    post projects_path, params: { project: { title: "New launch", content_locale: "en" } }

    assert_equal 1, users(:one).projects.count
    project = users(:one).projects.order(:created_at).last
    assert_equal "New launch", project.title
    assert_equal "en", project.content_locale
    assert_redirected_to project_path(id: project)
  end

  test "create without form params starts a named draft for current user" do
    user = users(:one)
    user.update!(locale: "es")
    sign_in_as(user)

    post projects_path

    assert_equal 1, user.projects.count
    project = user.projects.order(:created_at).last
    assert_equal "Clip actual", project.title
    assert_equal "es", project.content_locale
    assert_equal "draft", project.status
    assert_redirected_to project_path(id: project)
  end

  test "create keeps spanish route locale" do
    sign_in_as(users(:one))

    post projects_path(locale: :es), params: { project: { title: "Lanzamiento", content_locale: "es" } }

    project = users(:one).projects.order(:created_at).last
    assert_redirected_to project_path(id: project, locale: :es)
  end

  test "create invalid project renders validation errors" do
    sign_in_as(users(:one))

    assert_no_difference -> { Project.count } do
      post projects_path, params: { project: { title: "", content_locale: "fr" } }
    end

    assert_response :unprocessable_entity
    assert_select "div", /Clip title can't be blank/
  end

  test "show renders owned project" do
    sign_in_as(users(:one))

    get project_path(id: projects(:one))

    assert_response :success
    assert_select "[data-flow-step=material]"
    assert_select ".kc-material-review"
    assert_select ".kc-scene-card", minimum: 1
    assert_select "[data-flow-step=direction]"
    assert_select ".kc-direction-summary-button", text: /Reader hook/
    assert_select ".kc-direction-summary-button", text: /Clean chapter/
    assert_select "[data-flow-step=proposal]"
    assert_select ".kc-proposal-ready-card", text: /Generated clip/
    assert_select "select[name=proposal_genre]", count: 0
    assert_select "a", text: /Open editor/
    assert_select "a[href=?]", project_clip_path(project_id: projects(:one), id: clips(:one)), minimum: 2
    assert_select ".kc-project-phone-link[href=?]", project_clip_path(project_id: projects(:one), id: clips(:one))
  end

  test "show previews scene text over material thumbnail" do
    panels(:one).update!(
      metadata: {
        "sceneText" => "Launch reveal",
        "sceneMotion" => "impact",
        "sceneTransition" => "panel_slam"
      }
    )
    sign_in_as(users(:one))

    get project_path(id: projects(:one))

    assert_response :success
    assert_select ".kc-scene-text-preview", text: "Launch reveal"
    assert_select ".kc-scene-visual-preview.is-motion-impact.is-transition-panel-slam"
  end

  test "show starts with only material step for an empty project" do
    project = users(:one).projects.create!(title: "Empty flow", content_locale: "en")
    sign_in_as(users(:one))

    get project_path(id: project)

    assert_response :success
    assert_select "[data-flow-step=material]"
    assert_select "[data-flow-step=direction]", count: 0
    assert_select "[data-flow-step=proposal]", count: 0
  end

  test "show keeps direction hidden until uploaded material is confirmed" do
    project = users(:one).projects.create!(title: "Review first", content_locale: "en")
    asset = project.project_assets.create!(user: users(:one), kind: "source_page", file: sample_image_upload)
    project.panels.create!(project_asset: asset, position: 1, label: "Scene 1")
    sign_in_as(users(:one))

    get project_path(id: project)

    assert_response :success
    assert_select ".kc-material-review"
    assert_select "[data-flow-step=direction]", count: 0
    assert_select "[data-flow-step=proposal]", count: 0
  end

  test "confirm material folds material and opens direction" do
    project = users(:one).projects.create!(title: "Confirmable", content_locale: "en")
    asset = project.project_assets.create!(user: users(:one), kind: "source_page", file: sample_image_upload)
    project.panels.create!(project_asset: asset, position: 1, label: "Scene 1")
    sign_in_as(users(:one))

    post confirm_material_project_path(id: project)

    assert_redirected_to project_path(id: project, anchor: "direction")
    assert_equal true, project.reload.metadata.fetch("materialReady")

    follow_redirect!
    assert_select ".kc-project-flow.is-material-ready"
    assert_select "[data-flow-step=direction]"
    assert_select "[data-goal-choice]", minimum: 4
    assert_select ".kc-phone-placeholder span", text: "Choose goal and style to prepare the clip."
    assert_select "[data-flow-step=proposal]", count: 0
  end

  test "choose direction advances from goal to style and then ready" do
    project = users(:one).projects.create!(title: "Directed", content_locale: "en", metadata: { "materialReady" => true })
    asset = project.project_assets.create!(user: users(:one), kind: "source_page", file: sample_image_upload)
    project.panels.create!(project_asset: asset, position: 1, label: "Scene 1")
    sign_in_as(users(:one))

    post choose_direction_project_path(id: project), params: { direction: { goal: "launch" } }

    assert_redirected_to project_path(id: project, anchor: "direction")
    assert_equal "launch", project.reload.metadata.dig("direction", "goal")
    assert_equal "style", project.metadata.fetch("directionStage")

    follow_redirect!
    assert_select ".kc-direction-summary-button", text: /Announce chapter/
    assert_select "[data-style-choice]", minimum: 7
    assert_select "form[action=?]", project_clips_path(project_id: project), count: 0

    post choose_direction_project_path(id: project), params: { direction: { style: "webtoon_scroll" } }

    assert_redirected_to project_path(id: project, anchor: "direction")
    assert_equal "webtoon_scroll", project.reload.metadata.dig("direction", "style")
    assert_equal true, project.metadata.fetch("directionStyleChosen")

    follow_redirect!
    assert_select ".kc-project-flow.is-direction-ready"
    assert_select ".kc-direction-summary-button", text: /Webtoon scroll/
    assert_select "[data-flow-step=proposal]"
    assert_select "h2", text: /Adjust and create the proposal/
    assert_select "select[name=proposal_scene_time] option[selected][value=cinematic]", text: /Comfortable read/
    assert_select "select[name=proposal_intensity] option[selected][value=balanced]", text: /Balanced/
    assert_select ".kc-phone-placeholder span", text: /Create the proposal/
    assert_select "form[action=?]", project_clips_path(project_id: project)

    post choose_direction_project_path(id: project), params: { stage: "style" }

    assert_redirected_to project_path(id: project, anchor: "direction")
    assert_equal "style", project.reload.metadata.fetch("directionStage")

    follow_redirect!
    assert_select "[data-style-choice]", minimum: 7
    assert_select "form[action=?]", project_clips_path(project_id: project), count: 0
  end

  test "confirm material requires at least one scene" do
    project = users(:one).projects.create!(title: "No scenes", content_locale: "en")
    sign_in_as(users(:one))

    post confirm_material_project_path(id: project)

    assert_redirected_to project_path(id: project)
    follow_redirect!
    assert_select "div", /Upload at least one scene/
  end

  test "show rejects another user's project" do
    sign_in_as(users(:one))

    get project_path(id: projects(:two))

    assert_response :not_found
  end

  private

    def sample_image_upload
      Rack::Test::UploadedFile.new(Rails.root.join("test/fixtures/files/sample-page.png"), "image/png")
    end
end
