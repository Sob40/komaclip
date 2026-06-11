class ClipsController < ApplicationController
  before_action :set_project
  before_action :set_clip, only: %i[show destroy]

  def create
    panels = @project.panels.includes(:project_asset).order(:position).to_a

    if panels.empty?
      redirect_to project_path(id: @project), alert: t("flash.clip_requires_panels")
      return
    end

    position = next_position
    scene_contract = SceneContracts::InitialClipBuilder.new(project: @project, panels: panels).build
    direction = ProjectDirection.for(@project)
    clip = @project.clips.new(
      title: t("clips.default_title", position: position),
      position: position,
      status: "ready",
      duration_ms: scene_contract.fetch("durationMs"),
      metadata: { "direction" => direction },
      scene_contract: scene_contract
    )

    if clip.save
      redirect_to project_clip_path(project_id: @project, id: clip), notice: t("flash.clip_created")
    else
      redirect_to project_path(id: @project), alert: clip.errors.full_messages.to_sentence
    end
  end

  def show
    @preview_payload = preview_payload
  end

  def destroy
    @clip.destroy
    redirect_to project_path(id: @project), notice: t("flash.clip_deleted"), status: :see_other
  end

  private

    def set_project
      @project = Current.user.projects.find(params[:project_id])
    end

    def set_clip
      @clip = @project.clips.find(params[:id])
    end

    def next_position
      @project.clips.maximum(:position).to_i + 1
    end

    def preview_payload
      contract = @clip.scene_contract.deep_dup
      asset_ids = contract.fetch("shots", []).map { |shot| shot.fetch("assetId") }.uniq
      assets = @project.project_assets.with_attached_file.where(id: asset_ids).index_by(&:id)

      {
        contract: contract,
        assets: assets.transform_values do |asset|
          {
            id: asset.id,
            filename: asset.filename,
            contentType: asset.content_type,
            url: asset.file.attached? ? rails_blob_url(asset.file, disposition: "inline") : nil
          }
        end
      }
    end
end
