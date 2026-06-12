class VisualLabCatalog
  TYPES = %w[effect text transition cameraMotion].freeze
  GENRES = %w[action romance horror thriller scifi fantasy comedy drama webtoon promo].freeze
  PAGE_SIZE = 72

  GENRE_TAGS = {
    "action" => %w[visual-category:manga-action skin:action skin:manga skin:manga-action subgenre:action intent:action intent:impact energy:high],
    "romance" => %w[visual-category:romance-fantasy skin:romance skin:romance-fantasy text-category:romance-emotion intent:emotion],
    "horror" => %w[visual-category:horror-thriller skin:horror skin:horror-thriller subgenre:horror intent:dread intent:disturb],
    "thriller" => %w[visual-category:horror-thriller subgenre:thriller subgenre:suspense intent:suspense intent:clue],
    "scifi" => %w[visual-category:scifi-tech skin:scifi-tech subgenre:scifi text-category:scifi-hud intent:analysis],
    "fantasy" => %w[visual-category:romance-fantasy skin:fantasy-romance skin:soft-fantasy subgenre:fantasy intent:fantasy intent:magic],
    "comedy" => %w[visual-category:comedy-slice skin:comedy-slice text-category:comedy-pop intent:comedy],
    "drama" => %w[visual-category:universal-editorial skin:comic-editorial intent:drama intent:context mechanic:caption],
    "webtoon" => %w[visual-category:webtoon-manhwa format:webtoon intent:reading-flow mechanic:vertical-scroll],
    "promo" => %w[visual-category:promo-social skin:promo-social intent:promo reelSlot:cta]
  }.freeze

  attr_reader :filters

  def initialize(raw_filters = {})
    @filters = normalize_filters(raw_filters)
  end

  def items
    @items ||= filtered_items.first(PAGE_SIZE)
  end

  def filtered_count
    filtered_items.size
  end

  def total_count
    catalog_items.size
  end

  def limited?
    filtered_count > PAGE_SIZE
  end

  def stats
    {
      total: catalog_items.size,
      lab: catalog_items.count { |item| item.fetch(:show_in_lab) },
      production: catalog_items.count { |item| item.fetch(:show_in_production_picker) },
      needs_polish: catalog_items.count { |item| item.fetch(:quality_status) == "needsPolish" },
      showcase: catalog_items.count { |item| item.fetch(:quality_status) == "showcaseReady" }
    }
  end

  def facets
    {
      types: TYPES,
      categories: catalog_items.map { |item| item.fetch(:visual_category) }.compact.uniq.sort,
      statuses: catalog_items.map { |item| item.fetch(:quality_status) }.compact.uniq.sort,
      energies: catalog_items.map { |item| item.fetch(:energy) }.compact.uniq.sort,
      genres: GENRES
    }
  end

  private

    def filtered_items
      catalog_items.select { |item| matches_filters?(item) }
    end

    def catalog_items
      @catalog_items ||= begin
        presets = VisualPresetCatalog.presets.select { |preset| preset["showInLab"] }
        curations = VisualPresetCuration.for_presets(presets.map { |preset| preset.fetch("id") })

        presets.map { |preset| decorate(preset, curations[preset.fetch("id")]) }
      end
    end

    def decorate(preset, curation = nil)
      tags = VisualPresetCatalog.tags_for(preset)
      visual_category = tag_value(tags, "visual-category", "universal-editorial")
      mechanic = tag_value(tags, "mechanic", VisualPresetCatalog.layout_for(preset))
      energy = tag_value(tags, "energy")
      matched_genres = matching_genres(tags)
      curated_genres = Array(curation&.genres)

      {
        id: preset.fetch("id"),
        name: preset.fetch("name"),
        type: preset.fetch("type"),
        tags: tags,
        quality_status: preset["qualityStatus"] || preset["implementationStatus"],
        implementation_status: preset["implementationStatus"],
        show_in_lab: preset["showInLab"] == true,
        show_in_production_picker: preset["showInProductionPicker"] == true,
        visual_category: visual_category,
        mechanic: mechanic,
        energy: energy,
        reel_slot: tag_value(tags, "reelSlot"),
        skin: tag_value(tags, "skin"),
        parameters: preset.to_h.fetch("parameters", {}),
        preview_scene: preset.to_h.fetch("previewScene", {}),
        ai_description: preset["aiSelectorDescription"].presence || preset["englishDescription"],
        english_description: preset["englishDescription"],
        preview_tone: preview_tone_for(visual_category, tags),
        matched_genres: matched_genres,
        curated_genres: curated_genres,
        curation_general: curation&.general == true,
        curation_notes: curation&.notes.to_s,
        offered_genres: (matched_genres + curated_genres).uniq
      }
    end

    def matches_filters?(item)
      return false if filters[:type].present? && item.fetch(:type) != filters[:type]
      return false if filters[:category].present? && item.fetch(:visual_category) != filters[:category]
      return false if filters[:status].present? && item.fetch(:quality_status) != filters[:status]
      return false if filters[:energy].present? && item.fetch(:energy) != filters[:energy]
      return false if filters[:genre].present? && item.fetch(:offered_genres).exclude?(filters[:genre]) && !item.fetch(:curation_general)

      query_matches?(item)
    end

    def query_matches?(item)
      query = filters[:q]
      return true if query.blank?

      haystack = [
        item.fetch(:id),
        item.fetch(:name),
        item.fetch(:visual_category),
        item.fetch(:mechanic),
        item.fetch(:ai_description),
        item.fetch(:tags).join(" ")
      ].join(" ").downcase

      haystack.include?(query.downcase)
    end

    def matching_genres(tags)
      GENRE_TAGS.select do |_genre, wanted_tags|
        tags.intersect?(wanted_tags)
      end.keys
    end

    def preview_tone_for(visual_category, tags)
      return "action" if visual_category.in?(%w[manga-action comic-superhero])
      return "horror" if visual_category.in?(%w[horror-thriller noir-mystery])
      return "romance" if visual_category == "romance-fantasy"
      return "scifi" if visual_category == "scifi-tech"
      return "webtoon" if visual_category == "webtoon-manhwa" || tags.include?("format:webtoon")
      return "comedy" if visual_category == "comedy-slice"
      return "promo" if visual_category == "promo-social"

      "editorial"
    end

    def tag_value(tags, prefix, fallback = nil)
      tags.find { |tag| tag.start_with?("#{prefix}:") }&.split(":", 2)&.last || fallback
    end

    def normalize_filters(raw_filters)
      permitted = raw_filters.respond_to?(:permit) ? raw_filters.permit(:q, :type, :category, :status, :genre, :energy).to_h : raw_filters.to_h
      permitted.symbolize_keys.transform_values { |value| value.to_s.strip }.select { |_key, value| value.present? }
    end
end
