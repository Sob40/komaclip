class ApplicationMailer < ActionMailer::Base
  default from: "from@example.com"
  layout "mailer"

  private

    def default_url_options
      options = super
      return options if I18n.locale == I18n.default_locale

      options.merge(locale: I18n.locale)
    end
end
