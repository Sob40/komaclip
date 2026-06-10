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
    @project = Current.user.projects.includes(:project_assets, :panels, :clips, :clip_renders).find(params[:id])
  end

  private

    def project_params
      params.require(:project).permit(:title, :content_locale)
    end
end
