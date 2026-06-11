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
    assert_match(/\AClip sin título \d+\z/, project.title)
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
    assert_select "[data-flow-step=direction]"
    assert_select "[data-flow-step=preview]"
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

  test "show rejects another user's project" do
    sign_in_as(users(:one))

    get project_path(id: projects(:two))

    assert_response :not_found
  end
end
