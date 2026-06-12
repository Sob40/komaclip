require "json"

class VisualPresetCatalog
  MANIFEST_PATH = Rails.root.join("data/catalogs/visual-catalog-v2.json")

  class << self
    def manifest
      @manifest ||= JSON.parse(MANIFEST_PATH.read)
    end

    def presets
      @presets ||= begin
        items = manifest.fetch("presets")
        items = items.values if items.is_a?(Hash)
        items.map(&:deep_dup)
      end
    end

    def for_type(type)
      presets.select { |preset| preset["type"].to_s == type.to_s }
    end

    def find(id)
      presets.find { |preset| preset["id"].to_s == id.to_s }
    end

    def tags_for(preset)
      Array(preset.to_h["tags"]).map(&:to_s)
    end

    def tag_value(preset, prefix, fallback = nil)
      tags_for(preset).find { |tag| tag.start_with?("#{prefix}:") }&.split(":", 2)&.last || fallback
    end

    def visual_category_for(preset, fallback = "universal-editorial")
      tag_value(preset, "visual-category", fallback)
    end

    def mechanic_for(preset, fallback = nil)
      tag_value(preset, "mechanic", fallback)
    end

    def layout_for(preset)
      preset.to_h.dig("parameters", "layout").presence || mechanic_for(preset).to_s.tr("_", "-")
    end
  end
end
