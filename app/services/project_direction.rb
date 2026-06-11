class ProjectDirection
  DEFAULT = {
    "goal" => "readers",
    "style" => "chapter_clean",
    "format" => "vertical_social"
  }.freeze

  ALLOWED = {
    "goal" => %w[readers launch community sales],
    "style" => %w[chapter_clean trailer_tense impact_fast],
    "format" => %w[vertical_social reels_9_16]
  }.freeze

  def self.for(project)
    normalize(project.metadata.to_h.fetch("direction", {}))
  end

  def self.normalize(direction)
    direction = direction.to_h

    safe_direction = DEFAULT.each_with_object({}) do |(key, fallback), memo|
      value = direction[key].to_s
      memo[key] = ALLOWED.fetch(key).include?(value) ? value : fallback
    end

    safe_direction["format"] = "vertical_social" if safe_direction["format"] == "reels_9_16"
    safe_direction
  end
end
