class PasswordsMailer < ApplicationMailer
  def reset(user)
    @user = user
    I18n.with_locale(user.locale.presence || I18n.default_locale) do
      mail subject: t(".subject"), to: user.email_address
    end
  end
end
