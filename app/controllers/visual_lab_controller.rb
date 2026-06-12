class VisualLabController < ApplicationController
  before_action :require_admin

  def index
    @visual_lab = VisualLabCatalog.new(params)
    @filters = @visual_lab.filters
    @facets = @visual_lab.facets
    @stats = @visual_lab.stats
    @items = @visual_lab.items
  end

  def update_curation
    curation = VisualPresetCuration.find_or_initialize_by(preset_id: params[:id])

    if curation.update(curation_params)
      render json: {
        preset_id: curation.preset_id,
        general: curation.general,
        genres: curation.genres,
        notes: curation.notes.to_s
      }
    else
      render json: { errors: curation.errors.full_messages }, status: :unprocessable_content
    end
  end

  private

    def curation_params
      permitted = params.fetch(:visual_preset_curation, {}).permit(:general, :notes, genres: [])
      permitted[:general] = ActiveModel::Type::Boolean.new.cast(permitted[:general])
      permitted[:genres] = Array(permitted[:genres]).reject(&:blank?)
      permitted
    end

    def require_admin
      head :not_found unless Current.user&.admin?
    end
end
