class ProjectsController < ApplicationController
  def new
    @project = Current.user.projects.new(content_locale: Current.user.locale)
  end

  def create
    @project = Current.user.projects.new(project_params)

    if @project.save
      redirect_to project_path(id: @project), notice: t("flash.project_created")
    else
      render :new, status: :unprocessable_entity
    end
  end

  def show
    @project = Current.user.projects.find(params[:id])
    @project_assets = @project.project_assets.order(created_at: :desc)
    @panels = @project.panels.includes(:project_asset).order(:position)
    @clips_count = @project.clips.count
    @renders_count = @project.clip_renders.count
  end

  private

    def project_params
      params.require(:project).permit(:title, :content_locale)
    end
end
