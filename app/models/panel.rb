class Panel < ApplicationRecord
  belongs_to :project
  belongs_to :project_asset

  validates :position, numericality: { greater_than_or_equal_to: 1, only_integer: true }, uniqueness: { scope: :project_id }
  validate :asset_belongs_to_project

  private

    def asset_belongs_to_project
      return unless project && project_asset
      return if project_asset.project_id == project_id

      errors.add(:project_asset, "must belong to the project")
    end
end
