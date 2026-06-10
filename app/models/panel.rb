class Panel < ApplicationRecord
  FULL_CROP = {
    "unit" => "normalized",
    "x" => 0.0,
    "y" => 0.0,
    "width" => 1.0,
    "height" => 1.0
  }.freeze

  belongs_to :project
  belongs_to :project_asset

  before_validation :set_default_crop
  before_validation :set_default_label

  normalizes :label, with: ->(label) { label.to_s.strip }

  validates :label, presence: true, length: { maximum: 120 }
  validates :position, numericality: { greater_than_or_equal_to: 1, only_integer: true }, uniqueness: { scope: :project_id }
  validate :asset_belongs_to_project
  validate :asset_can_create_panel
  validate :crop_is_normalized_rectangle

  private

    def set_default_crop
      self.crop = FULL_CROP if crop.blank?
    end

    def set_default_label
      self.label = "Panel #{position}" if label.blank? && position.present?
    end

    def asset_belongs_to_project
      return unless project && project_asset
      return if project_asset.project_id == project_id

      errors.add(:project_asset, "must belong to the project")
    end

    def asset_can_create_panel
      return unless project_asset
      return if project_asset.extractable_panel_source?

      errors.add(:project_asset, "must be a ready source page or panel image")
    end

    def crop_is_normalized_rectangle
      required_keys = FULL_CROP.keys
      return errors.add(:crop, "must include normalized rectangle keys") unless required_keys.all? { |key| crop.key?(key) }
      return errors.add(:crop, "unit must be normalized") unless crop["unit"] == "normalized"

      x = crop["x"].to_f
      y = crop["y"].to_f
      width = crop["width"].to_f
      height = crop["height"].to_f

      return errors.add(:crop, "must stay within the image") if x.negative? || y.negative?
      return errors.add(:crop, "must have positive width and height") unless width.positive? && height.positive?
      errors.add(:crop, "must stay within the image") if x + width > 1.0 || y + height > 1.0
    end
end
