class Project < ApplicationRecord
  CONTENT_LOCALES = %w[en es].freeze
  STATUSES = %w[draft active archived].freeze

  belongs_to :user
  has_many :project_assets, dependent: :destroy
  has_many :panels, dependent: :destroy
  has_many :clips, dependent: :destroy
  has_many :clip_renders, dependent: :destroy

  normalizes :title, with: ->(title) { title.to_s.strip }

  validates :title, presence: true, length: { maximum: 120 }
  validates :content_locale, inclusion: { in: CONTENT_LOCALES }
  validates :status, inclusion: { in: STATUSES }
end
