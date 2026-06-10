class ProjectAssetsController < ApplicationController
  before_action :set_project
  before_action :set_asset, only: %i[show download destroy]

  def create
    @asset = @project.project_assets.new(asset_params)
    @asset.user = Current.user

    if @asset.save
      redirect_to project_path(id: @project), notice: t("flash.asset_uploaded")
    else
      redirect_to project_path(id: @project), alert: @asset.errors.full_messages.to_sentence
    end
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
      params.require(:project_asset).permit(:kind, :file)
    end
end
