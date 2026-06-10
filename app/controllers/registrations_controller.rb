class RegistrationsController < ApplicationController
  allow_unauthenticated_access only: %i[new create]
  rate_limit to: 5, within: 3.minutes, only: :create, with: -> { redirect_to new_registration_path, alert: "Try again later." }

  def new
    @user = User.new(locale: I18n.locale.to_s)
  end

  def create
    @user = User.new(registration_params)

    if @user.save
      start_new_session_for @user
      redirect_to dashboard_path
    else
      render :new, status: :unprocessable_entity
    end
  end

  private

    def registration_params
      params.require(:user).permit(:email_address, :password, :password_confirmation, :locale)
    end
end
