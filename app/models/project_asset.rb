require "mini_magick"

class ProjectAsset < ApplicationRecord
  MAX_FILE_SIZE = 25.megabytes
  CONTENT_TYPES = %w[
    image/jpeg
    image/png
    image/webp
  ].freeze
  KINDS = %w[source_page panel_image reference_image].freeze
  STATUSES = %w[pending ready failed].freeze

  belongs_to :project
  belongs_to :user

  has_one_attached :file
  has_many :panels, dependent: :destroy

  before_validation :sync_file_metadata

  normalizes :filename, with: ->(filename) { filename.to_s.strip }
  normalizes :content_type, with: ->(content_type) { content_type.to_s.strip.downcase }

  validates :kind, inclusion: { in: KINDS }
  validates :status, inclusion: { in: STATUSES }
  validates :filename, :content_type, presence: true
  validates :byte_size, numericality: { greater_than: 0, only_integer: true }
  validates :storage_key, uniqueness: true, allow_nil: true
  validate :file_is_attached
  validate :file_is_supported_image
  validate :file_size_is_allowed
  validate :user_matches_project

  def extractable_panel_source?
    status == "ready" && %w[source_page panel_image].include?(kind)
  end

  private

    def sync_file_metadata
      return unless file.attached?

      self.filename = file.filename.to_s
      self.content_type = detected_file_content_type.presence || file.content_type
      self.byte_size = file.byte_size
      self.checksum = file.blob.checksum
      self.storage_key = file.blob.key
      self.metadata = metadata.to_h.merge("image" => decoded_image_metadata) if decoded_image_metadata.present?
      self.status = "ready" if status.blank? || status == "pending"
    end

    def file_is_attached
      errors.add(:file, "must be attached") unless file.attached?
    end

    def file_is_supported_image
      return unless file.attached?

      unless CONTENT_TYPES.include?(detected_file_content_type)
        errors.add(:file, "must be a real JPG, PNG, or WebP image")
        return
      end

      errors.add(:file, "must be a readable image") if decoded_image_metadata.blank?
    end

    def file_size_is_allowed
      return unless file.attached?
      return if file.byte_size <= MAX_FILE_SIZE

      errors.add(:file, "must be smaller than 25 MB")
    end

    def detected_file_content_type
      @detected_file_content_type ||= with_file_io do |io|
        Marcel::MimeType.for(io, name: nil, declared_type: nil)
      end
    rescue ActiveStorage::FileNotFoundError, Errno::ENOENT
      nil
    end

    def decoded_image_metadata
      @decoded_image_metadata ||= with_file_path do |path|
        image = MiniMagick::Image.open(path)
        {
          "width" => image.width,
          "height" => image.height
        }
      end
    rescue ActiveStorage::FileNotFoundError, Errno::ENOENT, MiniMagick::Error
      nil
    end

    def with_file_io
      if (upload = pending_upload)
        io = upload.tempfile
        io.rewind
        yield io
      else
        file.open do |io|
          io.rewind
          yield io
        end
      end
    ensure
      io&.rewind
    end

    def with_file_path
      if (upload = pending_upload)
        yield upload.tempfile.path
      else
        file.open do |io|
          yield io.path
        end
      end
    end

    def pending_upload
      attachable = attachment_changes["file"]&.attachable
      return attachable if attachable.respond_to?(:tempfile) && attachable.tempfile.present?

      nil
    end

    def user_matches_project
      return unless project && user
      return if project.user_id == user_id

      errors.add(:user, "must own the project")
    end
end
