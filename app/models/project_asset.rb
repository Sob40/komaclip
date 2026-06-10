class ProjectAsset < ApplicationRecord
  KINDS = %w[source_page panel_image reference_image audio].freeze
  STATUSES = %w[pending ready failed].freeze

  belongs_to :project
  belongs_to :user

  has_many :panels, dependent: :restrict_with_error

  normalizes :filename, with: ->(filename) { filename.to_s.strip }
  normalizes :content_type, with: ->(content_type) { content_type.to_s.strip.downcase }

  validates :kind, inclusion: { in: KINDS }
  validates :status, inclusion: { in: STATUSES }
  validates :filename, :content_type, presence: true
  validates :byte_size, numericality: { greater_than: 0, only_integer: true }
  validates :storage_key, uniqueness: true, allow_nil: true
  validate :user_matches_project

  private

    def user_matches_project
      return unless project && user
      return if project.user_id == user_id

      errors.add(:user, "must own the project")
    end
end
