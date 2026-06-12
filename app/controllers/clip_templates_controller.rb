class ClipTemplatesController < ApplicationController
  def index
    @clip_templates = Current.user.clip_templates.order(updated_at: :desc)
  end

  def create
    clip = owned_clips.find(params.require(:clip_id))
    template = ClipTemplate.from_clip(user: Current.user, clip: clip, name: template_params[:name])

    if template.save
      redirect_to project_clip_path(project_id: clip.project, id: clip), notice: t("flash.clip_template_saved")
    else
      redirect_to project_clip_path(project_id: clip.project, id: clip), alert: template.errors.full_messages.to_sentence
    end
  end

  def use
    template = Current.user.clip_templates.find(params[:id])
    project = Current.user.projects.create!(
      title: t("projects.default_title"),
      content_locale: template.content_locale,
      metadata: {
        "templateId" => template.id,
        "templateName" => template.name,
        "templateSettings" => template.settings
      }
    )
    Current.user.projects.where.not(id: project.id).destroy_all

    redirect_to project_path(id: project), notice: t("flash.clip_template_applied", name: template.name)
  end

  def update
    template = Current.user.clip_templates.find(params[:id])

    if template.update(template_params)
      redirect_to clip_templates_path, notice: t("flash.clip_template_updated")
    else
      redirect_to clip_templates_path, alert: template.errors.full_messages.to_sentence
    end
  end

  def destroy
    Current.user.clip_templates.find(params[:id]).destroy
    redirect_to clip_templates_path, notice: t("flash.clip_template_deleted"), status: :see_other
  end

  private

    def owned_clips
      Clip.joins(:project).where(projects: { user_id: Current.user.id })
    end

    def template_params
      params.fetch(:clip_template, {}).permit(:name)
    end
end
