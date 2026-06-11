class ProjectAssetsController < ApplicationController
  before_action :set_project
  before_action :set_asset, only: %i[show download destroy]

  def create
    uploads = asset_uploads
    raise ActionController::ParameterMissing, :files if uploads.empty?

    ProjectAsset.transaction do
      uploads.each do |upload|
        @project.project_assets.create!(
          user: Current.user,
          kind: asset_kind,
          file: upload
        )
      end
    end

    redirect_to project_path(id: @project), notice: t("flash.assets_uploaded", count: uploads.size)
  rescue ActionController::ParameterMissing
    redirect_to project_path(id: @project), alert: t("flash.asset_file_required")
  rescue ActiveRecord::RecordInvalid => error
    redirect_to project_path(id: @project), alert: error.record.errors.full_messages.to_sentence
  end

  def show
  end

  def download
    redirect_to rails_blob_url(@asset.file, disposition: "attachment"), allow_other_host: true
  end

  def destroy
    @asset.destroy
    redirect_to project_path(id: @project), notice: t("flash.asset_deleted"), status: :see_other
  end

  private

    def set_project
      @project = Current.user.projects.find(params[:project_id])
    end

    def set_asset
      @asset = @project.project_assets.find(params[:id])
    end

    def asset_params
      params.require(:project_asset).permit(:kind, :file, files: [])
    end

    def asset_kind
      asset_params.fetch(:kind)
    end

    def asset_uploads
      permitted = asset_params
      Array(permitted[:files].presence || permitted[:file]).compact_blank
    end
end
