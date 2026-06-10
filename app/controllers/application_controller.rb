class ApplicationController < ActionController::Base
  include Authentication
  # Only allow modern browsers supporting webp images, web push, badges, import maps, CSS nesting, and CSS :has.
  allow_browser versions: :modern
  around_action :switch_locale
  before_action :sync_user_locale_from_route
  helper_method :available_locales

  private

    def switch_locale(&action)
      I18n.with_locale(resolved_locale, &action)
    end

    def resolved_locale
      requested_locale || resume_session&.user&.locale || I18n.default_locale
    end

    def requested_locale
      locale = params[:locale].presence
      locale if available_locale?(locale)
    end

    def available_locale?(locale)
      I18n.available_locales.map(&:to_s).include?(locale.to_s)
    end

    def available_locales
      I18n.available_locales
    end

    def sync_user_locale_from_route
      return unless requested_locale && Current.user
      return if Current.user.locale == requested_locale

      Current.user.update!(locale: requested_locale)
    end

    def default_url_options
      return {} if I18n.locale == I18n.default_locale

      { locale: I18n.locale }
    end
end
