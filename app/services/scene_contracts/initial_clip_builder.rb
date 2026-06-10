module SceneContracts
  class InitialClipBuilder
    DEFAULT_DURATION_MS = 8_000
    FORMAT = {
      "width" => 1080,
      "height" => 1920,
      "fps" => 30
    }.freeze

    def initialize(project:, panels:)
      @project = project
      @panels = panels
    end

    def build
      {
        "contractVersion" => Clip::CONTRACT_VERSION,
        "renderer" => "pixi",
        "format" => FORMAT,
        "durationMs" => DEFAULT_DURATION_MS,
        "contentLocale" => project.content_locale,
        "visual" => {
          "presetId" => "baseline-panel-sequence",
          "catalogContractVersion" => "p2r.visual.v2"
        },
        "shots" => shots
      }
    end

    private

      attr_reader :project, :panels

      def shots
        duration = (DEFAULT_DURATION_MS.to_f / panels.size).round

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
