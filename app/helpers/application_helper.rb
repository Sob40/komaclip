module ApplicationHelper
  def localized_current_path(locale)
    locale = locale.to_s
    route_locale = locale == I18n.default_locale.to_s ? nil : locale

    url_for(locale: route_locale, only_path: true)
  rescue ActionController::UrlGenerationError
    root_path(locale: route_locale)
  end

  def locale_link_label(locale)
    t("locales.#{locale}")
  end
end
