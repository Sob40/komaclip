class ProjectDirection
  DEFAULT = {
    "goal" => "readers",
    "style" => "chapter_clean",
    "format" => "reels_9_16"
  }.freeze

  ALLOWED = {
    "goal" => %w[readers launch community sales],
    "style" => %w[chapter_clean trailer_tense impact_fast],
    "format" => %w[reels_9_16]
  }.freeze

  def self.for(project)
    direction = project.metadata.to_h.fetch("direction", {}).to_h

    DEFAULT.each_with_object({}) do |(key, fallback), memo|
      value = direction[key].to_s
      memo[key] = ALLOWED.fetch(key).include?(value) ? value : fallback
    end
  end
end
