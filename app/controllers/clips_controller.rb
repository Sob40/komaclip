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
    clip = @project.clips.new(
      title: t("clips.default_title", position: position),
      position: position,
      status: "ready",
      duration_ms: SceneContracts::InitialClipBuilder::DEFAULT_DURATION_MS,
      scene_contract: SceneContracts::InitialClipBuilder.new(project: @project, panels: panels).build
    )

    if clip.save
      redirect_to project_clip_path(project_id: @project, id: clip), notice: t("flash.clip_created")
    else
      redirect_to project_path(id: @project), alert: clip.errors.full_messages.to_sentence
    end
  end

  def show
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
end
