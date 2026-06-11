class PanelsController < ApplicationController
  before_action :set_project
  before_action :set_asset, only: :create
  before_action :set_panel, only: %i[show destroy]

  def create
    if (existing_panel = @asset.panels.find(&:full_crop?))
      redirect_to project_panel_path(project_id: @project, id: existing_panel), notice: t("flash.panel_already_exists")
      return
    end

    position = next_position
    @panel = @project.panels.new(
      project_asset: @asset,
      position: position,
      label: panel_label(position),
      crop: Panel::FULL_CROP
    )

    if @panel.save
      redirect_to project_panel_path(project_id: @project, id: @panel), notice: t("flash.panel_created")
    else
      redirect_to project_asset_path(project_id: @project, id: @asset), alert: @panel.errors.full_messages.to_sentence
    end
  end

  def show
  end

  def destroy
    @panel.destroy
    redirect_to project_path(id: @project), notice: t("flash.panel_deleted"), status: :see_other
  end

  private

    def set_project
      @project = Current.user.projects.find(params[:project_id])
    end

    def set_asset
      @asset = @project.project_assets.find(params[:asset_id])
    end

    def set_panel
      @panel = @project.panels.includes(:project_asset).find(params[:id])
    end

    def next_position
      @project.panels.maximum(:position).to_i + 1
    end

    def panel_label(position)
      params.dig(:panel, :label).presence || t("panels.default_label", position: position)
    end
end
