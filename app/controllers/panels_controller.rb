class PanelsController < ApplicationController
  before_action :set_project
  before_action :set_asset, only: :create
  before_action :set_panel, only: %i[show update destroy duplicate move]

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

  def update
    @panel.update!(metadata: @panel.metadata.to_h.merge("noText" => !ActiveModel::Type::Boolean.new.cast(panel_params[:with_text])))
    mark_material_dirty!

    redirect_to project_path(id: @project), notice: t("flash.panel_updated")
  end

  def duplicate
    new_position = @panel.position + 1

    Panel.transaction do
      shift_positions_from(new_position)
      @project.panels.create!(
        project_asset: @panel.project_asset,
        position: new_position,
        label: t("projects.show.scene_title", position: new_position),
        crop: @panel.crop,
        metadata: @panel.metadata.to_h
      )
      normalize_positions!
      mark_material_dirty!
    end

    redirect_to project_path(id: @project), notice: t("flash.panel_duplicated")
  end

  def move
    direction = params[:direction].to_s
    target_position = direction == "up" ? @panel.position - 1 : @panel.position + 1
    target_panel = @project.panels.find_by(position: target_position)

    if target_panel
      original_position = @panel.position
      Panel.transaction do
        @panel.update_columns(position: -1, updated_at: Time.current)
        target_panel.update!(position: original_position)
        @panel.update!(position: target_position)
        normalize_positions!
        mark_material_dirty!
      end
    end

    redirect_to project_path(id: @project), notice: t("flash.panel_reordered")
  end

  def reorder
    panel_ids = Array(params[:panel_ids]).map(&:to_i)
    panels_by_id = @project.panels.where(id: panel_ids).index_by(&:id)

    if panel_ids.blank? || panels_by_id.size != @project.panels.count
      render json: { error: t("flash.panel_reorder_invalid") }, status: :unprocessable_entity
      return
    end

    Panel.transaction do
      panels_by_id.values.each_with_index { |panel, index| panel.update_columns(position: -(index + 1), updated_at: Time.current) }
      panel_ids.each.with_index(1) { |panel_id, position| panels_by_id.fetch(panel_id).update!(position: position, label: t("projects.show.scene_title", position: position)) }
      mark_material_dirty!
    end

    render json: { panel_ids: panel_ids }
  end

  def destroy
    asset = @panel.project_asset
    @panel.destroy
    asset.destroy unless asset.panels.exists?
    normalize_positions!
    mark_material_dirty!
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

    def panel_params
      params.fetch(:panel, {}).permit(:with_text)
    end

    def shift_positions_from(position)
      @project.panels.where(position: position..).order(position: :desc).each do |panel|
        panel.update_columns(position: panel.position + 1, updated_at: Time.current)
      end
    end

    def normalize_positions!
      @project.panels.order(:position, :id).each.with_index(1) do |panel, position|
        panel.update!(position: position, label: t("projects.show.scene_title", position: position))
      end
    end

    def mark_material_dirty!
      @project.update!(metadata: @project.metadata.to_h.merge("materialReady" => false))
    end
end
