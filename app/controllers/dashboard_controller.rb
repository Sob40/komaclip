class DashboardController < ApplicationController
  def show
    @projects = Current.user.projects.order(updated_at: :desc)
    @clip_templates = Current.user.clip_templates.order(updated_at: :desc)
  end
end
