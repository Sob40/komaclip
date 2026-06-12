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

  def scene_visual_preview_classes(panel)
    motion = panel.scene_motion
    transition = panel.scene_transition
    classes = [ "kc-scene-visual-preview" ]
    classes << "is-motion-#{motion.tr("_", "-")}" unless motion == "auto"
    classes << "is-transition-#{transition.tr("_", "-")}" unless transition == "auto" || transition == "cut"
    classes
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
      ],
      "target" => [
        "M12 3a9 9 0 1 0 9 9h-2a7 7 0 1 1-7-7V3Z",
        "M12 7a5 5 0 1 0 5 5h-2a3 3 0 1 1-3-3V7Z",
        "M13 11 21 3v5h-3v3h-5Z"
      ],
      "upload" => [
        "M12 16V4",
        "m7 9 5-5 5 5",
        "M5 16v3h14v-3"
      ],
      "type" => [
        "M4 6h16",
        "M9 6v12M15 6v12M7 18h4M13 18h4"
      ],
      "copy" => [
        "M8 8h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z",
        "M4 14H3a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1"
      ],
      "trash" => [
        "M4 7h16",
        "M10 11v6M14 11v6",
        "M6 7l1 14h10l1-14",
        "M9 7V4h6v3"
      ],
      "eye-off" => [
        "M3 3l18 18",
        "M10.6 10.6A3 3 0 0 0 14 14",
        "M9.3 5.2A10.8 10.8 0 0 1 12 5c5 0 8.4 4.2 10 7a14.7 14.7 0 0 1-3 3.8",
        "M6.5 6.7A14.5 14.5 0 0 0 2 12c1.6 2.8 5 7 10 7a10.9 10.9 0 0 0 5-1.2"
      ],
      "eye" => [
        "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z",
        "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
      ],
      "play" => [
        "M8 5v14l11-7-11-7Z"
      ],
      "rotate-ccw" => [
        "M3 12a9 9 0 1 0 3-6.7",
        "M3 4v6h6"
      ],
      "clock" => [
        "M12 3a9 9 0 1 0 9 9 9 9 0 0 0-9-9Z",
        "M12 7v5l3 2"
      ],
      "music" => [
        "M9 18V5l10-2v13",
        "M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3Z",
        "M19 16a3 3 0 1 1-3-3 3 3 0 0 1 3 3Z"
      ],
      "waveform" => [
        "M4 12h2",
        "M8 7v10",
        "M12 4v16",
        "M16 8v8",
        "M20 11v2"
      ],
      "download" => [
        "M12 4v11",
        "m7 10 5 5 5-5",
        "M5 20h14"
      ],
      "arrow-left" => [
        "M19 12H5",
        "M12 5 5 12l7 7"
      ],
      "arrow-right" => [
        "M5 12h14",
        "M12 5l7 7-7 7"
      ],
      "chevron-down" => [
        "m6 9 6 6 6-6"
      ],
      "save" => [
        "M5 4h12l2 2v14H5V4Z",
        "M8 4v6h8V4",
        "M8 20v-6h8v6"
      ],
      "lock" => [
        "M7 11V8a5 5 0 0 1 10 0v3",
        "M6 11h12v9H6v-9Z",
        "M12 15v2"
      ],
      "wand" => [
        "M15 4l5 5",
        "M13 6l5 5",
        "M4 20 17 7",
        "M5 5l1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3Z",
        "M19 14l.7 2.1L22 17l-2.3.9L19 20l-.7-2.1L16 17l2.3-.9L19 14Z"
      ]
    }

    content_tag(:svg, viewBox: "0 0 24 24", class: "kc-icon", aria: { hidden: true }) do
      safe_join(paths.fetch(name).map { |path| tag.path(d: path) })
    end
  end
end
