require "test_helper"

class PasswordsMailerTest < ActionMailer::TestCase
  test "reset email uses the user locale" do
    user = users(:one)
    user.update!(locale: "es")

    mail = PasswordsMailer.reset(user)

    assert_equal [ user.email_address ], mail.to
    assert_equal "Restablece tu contraseña", mail.subject
    assert_match "/es/passwords/", mail.body.encoded
  end
end
