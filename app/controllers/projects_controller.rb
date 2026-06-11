class ProjectsController < ApplicationController
  def new
    @project = Current.user.projects.new(content_locale: Current.user.locale)
  end

  def create
    @project = Current.user.projects.new(create_project_params)

    if @project.save
      redirect_to project_path(id: @project), notice: t("flash.project_created")
    else
      render :new, status: :unprocessable_entity
    end
  end

  def show
    @project = Current.user.projects.find(params[:id])
    @project_assets = @project.project_assets.order(created_at: :desc).to_a
    @panels = @project.panels.includes(:project_asset).order(:position).to_a
    @clips = @project.clips.order(:position).to_a
    @clips_count = @clips.size
    @renders_count = @project.clip_renders.count
    @material_uploaded = @panels.any?
    @material_ready = @material_uploaded && material_confirmed?
    @proposal_ready = @material_ready && @clips.any?
    @latest_clip = @clips.last
    @direction = ProjectDirection.for(@project)
  end

  def confirm_material
    @project = Current.user.projects.find(params[:id])

    if @project.panels.exists?
      @project.update!(metadata: @project.metadata.to_h.merge("materialReady" => true))
      redirect_to project_path(id: @project, anchor: "direction"), notice: t("flash.material_confirmed")
    else
      redirect_to project_path(id: @project), alert: t("flash.material_requires_scenes")
    end
  end

  private

    def project_params
      params.require(:project).permit(:title, :content_locale)
    end

    def create_project_params
      return project_params if params[:project].present?

      {
        title: t("projects.default_title", number: Current.user.projects.count + 1),
        content_locale: Current.user.locale
      }
    end

    def material_confirmed?
      @project.metadata.to_h["materialReady"] == true || @clips.any?
    end
end
