class DashboardController < ApplicationController
  def show
    project = Current.user.projects.order(updated_at: :desc).first_or_create!(
      title: t("projects.default_title"),
      content_locale: Current.user.locale
    )

    redirect_to project_path(id: project)
  end
end
