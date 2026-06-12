class VisualPresetCuration < ApplicationRecord
  GENRES = VisualLabCatalog::GENRES.freeze

  validates :preset_id, presence: true, uniqueness: true
  validate :genres_are_known

  before_validation :normalize_genres

  def self.for_presets(preset_ids)
    where(preset_id: preset_ids).index_by(&:preset_id)
  end

  private

    def normalize_genres
      self.genres = Array(genres).map(&:to_s).map(&:strip).reject(&:blank?).uniq
    end

    def genres_are_known
      unknown = Array(genres) - GENRES
      errors.add(:genres, "include unknown values: #{unknown.join(', ')}") if unknown.any?
    end
end
