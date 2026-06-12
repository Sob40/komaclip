class ClipTemplate < ApplicationRecord
  belongs_to :user
  belongs_to :source_clip, class_name: "Clip", optional: true

  normalizes :name, with: ->(name) { name.to_s.strip }

  validates :name, presence: true, length: { maximum: 120 }
  validates :content_locale, inclusion: { in: Project::CONTENT_LOCALES }
  validate :settings_must_be_object

  def self.from_clip(user:, clip:, name: nil)
    contract = clip.scene_contract.to_h

    new(
      user: user,
      source_clip: clip,
      name: name.presence || clip.title,
      content_locale: contract["contentLocale"].presence || clip.project.content_locale,
      settings: {
        "renderer" => contract["renderer"],
        "format" => contract["format"],
        "durationMs" => contract["durationMs"],
        "visual" => contract["visual"],
        "music" => contract["music"]
      }.compact
    )
  end

  private

    def settings_must_be_object
      errors.add(:settings, "must be an object") unless settings.is_a?(Hash)
    end
end
