class ClipRender < ApplicationRecord
  RENDERERS = %w[pixi].freeze
  STATUSES = %w[queued processing succeeded failed canceled].freeze

  belongs_to :project
  belongs_to :clip
  belongs_to :user

  validates :renderer, inclusion: { in: RENDERERS }
  validates :status, inclusion: { in: STATUSES }
  validates :duration_ms, numericality: { greater_than_or_equal_to: 0, only_integer: true }, allow_nil: true
  validates :output_key, uniqueness: true, allow_nil: true
  validate :user_matches_project
  validate :clip_belongs_to_project

  private

    def user_matches_project
      return unless project && user
      return if project.user_id == user_id

      errors.add(:user, "must own the project")
    end

    def clip_belongs_to_project
      return unless project && clip
      return if clip.project_id == project_id

      errors.add(:clip, "must belong to the project")
    end
end
