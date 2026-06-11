module SceneContracts
  class InitialClipBuilder
    DEFAULT_DURATION_MS = 8_000
    MIN_DURATION_MS = 1_000
    MAX_DURATION_MS = 60_000

    FORMAT = {
      "width" => 1080,
      "height" => 1920,
      "fps" => 30
    }.freeze
    FORMAT_LIMITS = {
      "width" => 360..2160,
      "height" => 640..3840,
      "fps" => 12..60
    }.freeze
    VISUAL = {
      "presetId" => "baseline-panel-sequence",
      "catalogContractVersion" => "p2r.visual.v2"
    }.freeze

    def initialize(project:, panels:)
      @project = project
      @panels = panels
    end

    def build
      clip_duration_ms = duration_ms

      {
        "contractVersion" => Clip::CONTRACT_VERSION,
        "renderer" => "pixi",
        "format" => format,
        "durationMs" => clip_duration_ms,
        "contentLocale" => project.content_locale,
        "visual" => visual,
        "shots" => shots(clip_duration_ms)
      }
    end

    private

      attr_reader :project, :panels

      def template_settings
        @template_settings ||= project.metadata.to_h.fetch("templateSettings", {}).to_h
      end

      def duration_ms
        value = template_settings["durationMs"].to_i
        return DEFAULT_DURATION_MS unless value.positive?

        value.clamp(MIN_DURATION_MS, MAX_DURATION_MS)
      end

      def format
        settings_format = template_settings["format"].is_a?(Hash) ? template_settings["format"] : {}

        FORMAT.each_with_object({}) do |(key, default), memo|
          value = settings_format[key].to_i
          memo[key] = FORMAT_LIMITS.fetch(key).cover?(value) ? value : default
        end
      end

      def visual
        settings_visual = template_settings["visual"].is_a?(Hash) ? template_settings["visual"] : {}

        VISUAL.merge(
          settings_visual.slice("presetId", "catalogContractVersion").select { |_key, value| value.is_a?(String) && value.present? }
        )
      end

      def shots(clip_duration_ms)
        duration = (clip_duration_ms.to_f / panels.size).round

        panels.map.with_index do |panel, index|
          {
            "panelId" => panel.id,
            "assetId" => panel.project_asset_id,
            "position" => panel.position,
            "label" => panel.label,
            "filename" => panel.project_asset.filename,
            "crop" => panel.crop,
            "durationMs" => duration,
            "transition" => index.zero? ? "none" : "cut"
          }
        end
      end
  end
end
