require "test_helper"

class ProjectsControllerTest < ActionDispatch::IntegrationTest
  test "new requires authentication" do
    get new_project_path

    assert_redirected_to new_session_path
  end

  test "dashboard lists only current user's projects" do
    sign_in_as(users(:one))

    get dashboard_path

    assert_response :success
    assert_select "h1", "Workspace"
    assert_select "a", text: projects(:one).title
    assert_select "a", text: projects(:two).title, count: 0
  end

  test "new renders project form with current user locale as content default" do
    user = users(:one)
    user.update!(locale: "es")
    sign_in_as(user)

    get new_project_path(locale: :es)

    assert_response :success
    assert_select "h1", "Nuevo proyecto"
    assert_select "select[name=?] option[value=?][selected]", "project[content_locale]", "es"
  end

  test "create persists project for current user" do
    sign_in_as(users(:one))

    assert_difference -> { users(:one).projects.count }, 1 do
      post projects_path, params: { project: { title: "New launch", content_locale: "en" } }
    end

    project = users(:one).projects.order(:created_at).last
    assert_equal "New launch", project.title
    assert_equal "en", project.content_locale
    assert_redirected_to project_path(id: project)
  end

  test "create without form params starts a named draft for current user" do
    user = users(:one)
    user.update!(locale: "es")
    sign_in_as(user)

    assert_difference -> { user.projects.count }, 1 do
      post projects_path
    end

    project = user.projects.order(:created_at).last
    assert_match(/\AProyecto sin título \d+\z/, project.title)
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
    assert_select "div", /Project title can't be blank/
  end

  test "show renders owned project" do
    sign_in_as(users(:one))

    get project_path(id: projects(:one))

    assert_response :success
    assert_select "[data-flow-step=material]"
    assert_select ".kc-material-review"
    assert_select ".kc-scene-card", minimum: 1
    assert_select "[data-flow-step=direction]"
    assert_select ".kc-direction-card", text: /Reader hook/
    assert_select ".kc-direction-card", text: /Clean chapter/
    assert_select ".kc-direction-card", text: /Vertical social/
    assert_select "[data-flow-step=preview]"
  end

  test "show previews scene text over material thumbnail" do
    panels(:one).update!(metadata: { "sceneText" => "Launch reveal" })
    sign_in_as(users(:one))

    get project_path(id: projects(:one))

    assert_response :success
    assert_select ".kc-scene-text-preview", text: "Launch reveal"
  end

  test "show starts with only material step for an empty project" do
    project = users(:one).projects.create!(title: "Empty flow", content_locale: "en")
    sign_in_as(users(:one))

    get project_path(id: project)

    assert_response :success
    assert_select "[data-flow-step=material]"
    assert_select "[data-flow-step=direction]", count: 0
    assert_select "[data-flow-step=preview]", count: 0
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
    assert_select "[data-flow-step=preview]", count: 0
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
    assert_select "[data-flow-step=preview]", count: 0
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
