require "test_helper"

class VisualLabControllerTest < ActionDispatch::IntegrationTest
  test "requires authentication" do
    get visual_lab_path

    assert_redirected_to new_session_path
  end

  test "requires admin user" do
    sign_in_as(users(:one))

    get visual_lab_path

    assert_response :not_found
  end

  test "admin can browse visual lab" do
    user = users(:one)
    user.update!(role: "admin")
    sign_in_as(user)

    get visual_lab_path

    assert_response :success
    assert_select "h1", "Visual Lab"
    assert_select ".kc-visual-preset-card", minimum: 1
  end

  test "admin can filter by genre and type" do
    user = users(:one)
    user.update!(role: "admin")
    sign_in_as(user)

    get visual_lab_path, params: { genre: "action", type: "effect" }

    assert_response :success
    assert_select "select[name=genre] option[selected][value=action]"
    assert_select "select[name=type] option[selected][value=effect]"
    assert_select ".kc-visual-preset-card", minimum: 1
  end

  test "admin can curate preset genres" do
    user = users(:one)
    user.update!(role: "admin")
    sign_in_as(user)

    patch visual_lab_curation_path(id: "fx-manga-speed-impact"), params: {
      visual_preset_curation: {
        general: "1",
        genres: [ "action", "thriller" ],
        notes: "Works well on fast panels."
      }
    }

    assert_response :success
    payload = JSON.parse(response.body)
    assert_equal "fx-manga-speed-impact", payload.fetch("preset_id")
    assert_equal true, payload.fetch("general")
    assert_equal [ "action", "thriller" ], payload.fetch("genres")

    curation = VisualPresetCuration.find_by!(preset_id: "fx-manga-speed-impact")
    assert_equal "Works well on fast panels.", curation.notes
  end

  test "non admin cannot curate preset genres" do
    sign_in_as(users(:one))

    patch visual_lab_curation_path(id: "fx-manga-speed-impact"), params: {
      visual_preset_curation: { general: "1", genres: [ "action" ] }
    }

    assert_response :not_found
  end
end
