class Clip < ApplicationRecord
  CONTRACT_VERSION = "komaclip.scene.v1"
  STATUSES = %w[draft ready archived].freeze

  belongs_to :project
  has_many :clip_renders, dependent: :destroy
  has_many :clip_templates, foreign_key: :source_clip_id, dependent: :nullify

  normalizes :title, with: ->(title) { title.to_s.strip }

  validates :title, presence: true, length: { maximum: 120 }
  validates :position, numericality: { greater_than_or_equal_to: 1, only_integer: true }, uniqueness: { scope: :project_id }
  validates :status, inclusion: { in: STATUSES }
  validates :duration_ms, numericality: { greater_than_or_equal_to: 0, only_integer: true }
  validate :scene_contract_is_valid_for_ready_clip

  private

    def scene_contract_is_valid_for_ready_clip
      return if status == "draft" && scene_contract.blank?

      unless scene_contract.is_a?(Hash)
        errors.add(:scene_contract, "must be an object")
        return
      end

      errors.add(:scene_contract, "must use the current contract version") unless scene_contract["contractVersion"] == CONTRACT_VERSION
      errors.add(:scene_contract, "must use pixi renderer") unless scene_contract["renderer"] == "pixi"
      errors.add(:scene_contract, "must include at least one shot") unless scene_contract["shots"].is_a?(Array) && scene_contract["shots"].any?
      errors.add(:scene_contract, "duration must match the clip") unless scene_contract["durationMs"] == duration_ms
    end
end
