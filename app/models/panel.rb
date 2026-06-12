class Panel < ApplicationRecord
  MAX_SCENE_TEXT_LENGTH = 140
  SCENE_MOTIONS = %w[auto cinematic impact swipe scroll parallax beat glitch float rgb manga].freeze
  SCENE_BUBBLES = %w[auto caption speech burst thought manga_vertical].freeze
  SCENE_POSITIONS = %w[auto top_safe center_safe bottom_safe bottom_real none].freeze
  SCENE_SIZES = %w[auto small medium large].freeze
  SCENE_DURATIONS = %w[auto short normal long].freeze
  SCENE_TRANSITIONS = %w[auto cut speed_wipe panel_slam page_slice ink_flash].freeze

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
  validate :scene_text_fits_limit
  validate :asset_belongs_to_project
  validate :asset_can_create_panel
  validate :crop_is_normalized_rectangle

  def self.full_crop?(crop)
    return false unless crop.is_a?(Hash)

    crop["unit"] == "normalized" &&
      crop["x"].to_f.zero? &&
      crop["y"].to_f.zero? &&
      crop["width"].to_f == 1.0 &&
      crop["height"].to_f == 1.0
  end

  def full_crop?
    self.class.full_crop?(crop)
  end

  def scene_text
    metadata.to_h["sceneText"].to_s
  end

  def display_scene_text
    return "" if no_text?

    scene_text
  end

  def no_text?
    metadata.to_h["noText"] == true
  end

  def excluded?
    metadata.to_h["skipScene"] == true
  end

  def scene_motion
    metadata_choice("sceneMotion", SCENE_MOTIONS, "auto")
  end

  def scene_bubble
    metadata_choice("sceneBubble", SCENE_BUBBLES, "auto")
  end

  def scene_position
    metadata_choice("scenePosition", SCENE_POSITIONS, "auto")
  end

  def scene_size
    metadata_choice("sceneSize", SCENE_SIZES, "auto")
  end

  def scene_duration
    metadata_choice("sceneDuration", SCENE_DURATIONS, "auto")
  end

  def scene_transition
    metadata_choice("sceneTransition", SCENE_TRANSITIONS, "auto")
  end

  private

    def set_default_crop
      self.crop = FULL_CROP if crop.blank?
    end

    def set_default_label
      self.label = "Panel #{position}" if label.blank? && position.present?
    end

    def scene_text_fits_limit
      return if scene_text.length <= MAX_SCENE_TEXT_LENGTH

      errors.add(:metadata, "scene text is too long")
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

    def metadata_choice(key, allowed, fallback)
      value = metadata.to_h[key].to_s
      allowed.include?(value) ? value : fallback
    end
end
