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

  def content_locale_options
    Project::CONTENT_LOCALES.map { |locale| [ t("content_locales.#{locale}"), locale ] }
  end

  def project_asset_kind_options
    ProjectAsset::KINDS.map { |kind| [ t("project_asset_kinds.#{kind}"), kind ] }
  end

  def direction_goal_icon(goal)
    icon = {
      "readers" => "book",
      "launch" => "rocket",
      "community" => "user",
      "sales" => "megaphone"
    }.fetch(goal, "spark")

    kc_icon(icon)
  end

  def direction_style_icon(style)
    icon = {
      "trailer_tense" => "film",
      "impact_fast" => "zap",
      "chapter_clean" => "book",
      "webtoon_scroll" => "scan",
      "character_spotlight" => "user",
      "sales_pitch" => "megaphone",
      "making_of" => "brush"
    }.fetch(style, "spark")

    kc_icon(icon)
  end

  def kc_icon(name)
    paths = {
      "book" => [
        "M5 4h7a4 4 0 0 1 4 4v12a4 4 0 0 0-4-3H5V4Z",
        "M19 4h-3a4 4 0 0 0-4 4v12a4 4 0 0 1 4-3h3V4Z"
      ],
      "rocket" => [
        "M14 4c3.2-.8 5.2.1 6 1-.2 3.6-1.8 6.6-5 9.1l-5.1-5.1C11 6.6 12.2 4.8 14 4Z",
        "M9 10 5 9l-2 2 4 2",
        "M14 15l1 4-2 2-2-4",
        "M8 16c-1.7.2-3 .9-4 2 .9.3 1.9.9 2 2 1.2-.8 1.9-2.2 2-4Z"
      ],
      "user" => [
        "M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Z",
        "M4 21a8 8 0 0 1 16 0"
      ],
      "megaphone" => [
        "M4 13h3l10 5V6L7 11H4v2Z",
        "M7 13v5a2 2 0 0 0 4 0v-3",
        "M19 9a4 4 0 0 1 0 6"
      ],
      "film" => [
        "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z",
        "M8 4v16M16 4v16M3 9h18M3 15h18"
      ],
      "zap" => [
        "M13 2 4 14h7l-1 8 10-13h-7l1-7Z"
      ],
      "scan" => [
        "M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3",
        "M7 12h10"
      ],
      "brush" => [
        "M14 4 20 10 10 20H4v-6L14 4Z",
        "M13 5l6 6"
      ],
      "spark" => [
        "m12 2 1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2Z"
      ]
    }

    content_tag(:svg, viewBox: "0 0 24 24", class: "kc-icon", aria: { hidden: true }) do
      safe_join(paths.fetch(name).map { |path| tag.path(d: path) })
    end
  end
end
