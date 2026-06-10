class DashboardController < ApplicationController
  def show
    @projects = Current.user.projects.order(updated_at: :desc)
  end
end
