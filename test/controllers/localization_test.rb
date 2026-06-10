require "test_helper"

class LocalizationTest < ActionDispatch::IntegrationTest
  test "english is the default public locale" do
    get root_path

    assert_response :success
    assert_select "html[lang=?]", "en"
    assert_select "h1", /Create social promo clips/
  end

  test "spanish public route renders spanish locale" do
    get root_path(locale: :es)

    assert_response :success
    assert_select "html[lang=?]", "es"
    assert_select "h1", /Crea clips promocionales/
    assert_select "a[href=?]", root_path
  end

  test "localized routes keep locale on unauthenticated redirects" do
    get dashboard_path(locale: :es)

    assert_redirected_to new_session_path(locale: :es)
  end

  test "registration form stores selected route locale" do
    get new_registration_path(locale: :es)

    assert_response :success
    assert_select "input[name=?][value=?]", "user[locale]", "es"
  end

  test "signed in user locale follows explicit route locale" do
    user = users(:one)
    assert_equal "en", user.locale

    sign_in_as(user)
    get dashboard_path(locale: :es)

    assert_response :success
    assert_equal "es", user.reload.locale
  end
end
