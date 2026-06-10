class Clip < ApplicationRecord
  STATUSES = %w[draft ready archived].freeze

  belongs_to :project
  has_many :clip_renders, dependent: :destroy

  normalizes :title, with: ->(title) { title.to_s.strip }

  validates :title, presence: true, length: { maximum: 120 }
  validates :position, numericality: { greater_than_or_equal_to: 1, only_integer: true }, uniqueness: { scope: :project_id }
  validates :status, inclusion: { in: STATUSES }
  validates :duration_ms, numericality: { greater_than_or_equal_to: 0, only_integer: true }
end
