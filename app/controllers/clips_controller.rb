class ClipsController < ApplicationController
  PROPOSAL_GENRES = %w[romance drama action horror fantasy scifi thriller comedy].freeze
  PROPOSAL_SCENE_TIMES = %w[auto short standard cinematic].freeze
  PROPOSAL_INTENSITIES = %w[auto subtle balanced intense].freeze
  SCENE_MODES = %w[auto soft impact dramatic clear].freeze
  EFFECT_INTENSITIES = %w[auto subtle balanced intense].freeze
  SCENE_DURATION_WEIGHTS = { "short" => 0.75, "normal" => 1.0, "long" => 1.35 }.freeze
  MIN_SCENE_DURATION_SECONDS = 0.7
  MAX_SCENE_DURATION_SECONDS = 8.0
  PROPOSAL_TEXT_MAX_LENGTH = 280
  TEXT_STYLE_OPTIONS = {
    "global" => [
      { value: "caption", icon: "type", key: "clean_caption" },
      { value: "speech", icon: "book", key: "speech_bubble" },
      { value: "burst", icon: "zap", key: "impact_burst" }
    ],
    "romance" => [
      { value: "thought", icon: "spark", key: "soft_thought" }
    ],
    "drama" => [
      { value: "thought", icon: "spark", key: "soft_thought" }
    ],
    "action" => [
      { value: "manga_vertical", icon: "target", key: "vertical_sfx" }
    ],
    "horror" => [
      { value: "manga_vertical", icon: "target", key: "vertical_sfx" }
    ],
    "fantasy" => [
      { value: "thought", icon: "spark", key: "soft_thought" },
      { value: "manga_vertical", icon: "target", key: "vertical_sfx" }
    ],
    "scifi" => [
      { value: "manga_vertical", icon: "target", key: "vertical_sfx" }
    ],
    "thriller" => [
      { value: "manga_vertical", icon: "target", key: "vertical_sfx" }
    ],
    "comedy" => [
      { value: "thought", icon: "spark", key: "soft_thought" }
    ]
  }.freeze

  before_action :set_project
  before_action :set_clip, only: %i[show update destroy regenerate reorder]

  def create
    panels = @project.panels.includes(:project_asset).order(:position).reject(&:excluded?)

    if panels.empty?
      redirect_to project_path(id: @project), alert: t("flash.clip_requires_panels")
      return
    end

    apply_direction_params

    unless direction_ready?
      redirect_to project_path(id: @project, anchor: "direction"), alert: t("flash.direction_required")
      return
    end

    position = 1
    proposal = proposal_settings
    scene_contract = SceneContracts::InitialClipBuilder.new(
      project: @project,
      panels: panels,
      proposal: proposal,
      generation_seed: "#{@project.id}:#{position}:#{Time.current.to_f}"
    ).build
    direction = ProjectDirection.for(@project)
    music = scene_contract["music"]
    clip = nil

    Clip.transaction do
      @project.clips.destroy_all
      clip = @project.clips.create!(
        title: t("clips.default_title", position: position),
        position: position,
        status: "ready",
        duration_ms: scene_contract.fetch("durationMs"),
        metadata: { "direction" => direction, "proposal" => proposal, "music" => music },
        scene_contract: scene_contract
      )
    end

    redirect_to project_clip_path(project_id: @project, id: clip)
  rescue ActiveRecord::RecordInvalid => error
    redirect_to project_path(id: @project), alert: error.record.errors.full_messages.to_sentence
  end

  def show
    @direction = ProjectDirection.normalize(@clip.metadata.to_h.fetch("direction", ProjectDirection.for(@project)))
    @proposal = @clip.metadata.to_h.fetch("proposal", @clip.scene_contract.to_h.fetch("proposal", {})).to_h
    @music_catalog = MusicCatalog.all
    @preview_contract = normalized_scene_contract
    @music = @preview_contract["music"].to_h
    @text_style_options = text_style_options_for(@proposal.fetch("genre", "drama"))
    @preview_payload = preview_payload(@preview_contract)
    @preview_assets = preview_assets_for(@preview_contract)
  end

  def update
    contract = normalized_scene_contract
    metadata = @clip.metadata.to_h
    permitted_clip_params = clip_params.to_h
    shots_params = permitted_clip_params.fetch("shots", {})

    if oversized_clip_scene_text?(shots_params)
      respond_to do |format|
        format.html { redirect_to project_clip_path(project_id: @project, id: @clip), alert: t("flash.panel_text_too_long", count: Panel::MAX_SCENE_TEXT_LENGTH) }
        format.json { render json: { error: t("flash.panel_text_too_long", count: Panel::MAX_SCENE_TEXT_LENGTH) }, status: :unprocessable_entity }
      end
      return
    end

    contract["shots"] = contract.fetch("shots", []).map.with_index do |shot, index|
      update_contract_shot(shot.deep_dup, shots_params[shot.fetch("panelId").to_s], index)
    end
    retime_contract_shots!(contract)
    contract["music"] = updated_music_payload
    contract = normalized_scene_contract(contract)

    metadata["music"] = contract["music"]
    @clip.update!(
      title: clip_params[:title].presence || @clip.title,
      duration_ms: contract["durationMs"].to_i,
      metadata: metadata,
      scene_contract: contract
    )

    respond_to do |format|
      format.html { redirect_to project_clip_path(project_id: @project, id: @clip), notice: t("flash.clip_updated") }
      format.json { render json: { status: "saved", updated_at: @clip.updated_at.iso8601 } }
    end
  end

  def regenerate
    panels = @project.panels.includes(:project_asset).order(:position).reject(&:excluded?)

    if panels.empty?
      redirect_to project_path(id: @project), alert: t("flash.clip_requires_panels")
      return
    end

    apply_direction_params

    unless direction_ready?
      redirect_to project_path(id: @project, anchor: "direction"), alert: t("flash.direction_required")
      return
    end

    mode = regeneration_mode
    proposal = regeneration_proposal_settings
    contract = SceneContracts::InitialClipBuilder.new(
      project: @project,
      panels: panels,
      proposal: proposal,
      generation_seed: "#{@project.id}:#{@clip.id}:#{mode}:#{Time.current.to_f}"
    ).build
    contract = merge_preserved_scene_edits(contract, normalized_scene_contract)
    contract = normalized_scene_contract(contract)
    direction = ProjectDirection.for(@project)

    @clip.update!(
      status: "ready",
      duration_ms: contract.fetch("durationMs").to_i,
      metadata: @clip.metadata.to_h.merge(
        "direction" => direction,
        "proposal" => proposal,
        "music" => contract["music"],
        "lastRegenerationMode" => mode
      ),
      scene_contract: contract
    )

    redirect_to project_clip_path(project_id: @project, id: @clip)
  end

  def reorder
    contract = normalized_scene_contract
    panel_ids = Array(params[:panel_ids]).map(&:to_s)
    shots_by_panel_id = contract.fetch("shots", []).index_by { |shot| shot.fetch("panelId").to_s }

    if panel_ids.blank? || panel_ids.size != shots_by_panel_id.size || panel_ids.any? { |panel_id| !shots_by_panel_id.key?(panel_id) }
      render json: { error: t("flash.clip_reorder_invalid") }, status: :unprocessable_entity
      return
    end

    contract["shots"] = panel_ids.map.with_index do |panel_id, index|
      shot = shots_by_panel_id.fetch(panel_id).deep_dup
      shot["position"] = index + 1
      shot["label"] = t("projects.show.scene_title", position: index + 1)
      shot["phase"] = clip_shot_phase(index, panel_ids.size)
      shot["transition"] = "none" if index.zero?
      shot
    end
    retime_contract_shots!(contract)
    contract = normalized_scene_contract(contract)

    @clip.update!(
      duration_ms: contract.fetch("durationMs").to_i,
      scene_contract: contract
    )

    render json: {
      panel_ids: panel_ids,
      duration_ms: contract.fetch("durationMs").to_i,
      shots: contract.fetch("shots", []).map { |shot| { panel_id: shot.fetch("panelId"), position: shot.fetch("position"), label: shot.fetch("label") } }
    }
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

    def direction_ready?
      metadata = @project.metadata.to_h
      metadata["directionStyleChosen"] == true || metadata["directionStage"] == "ready" || @project.clips.exists?
    end

    def apply_direction_params
      goal = safe_choice(params[:direction_goal], ProjectDirection.goal_options, nil)
      style = safe_choice(params[:direction_style], ProjectDirection.style_options, nil)
      return if goal.blank? && style.blank?

      current_direction = ProjectDirection.for(@project)
      metadata = @project.metadata.to_h
      metadata["direction"] = current_direction.merge(
        "goal" => goal.presence || current_direction.fetch("goal"),
        "style" => style.presence || current_direction.fetch("style"),
        "format" => ProjectDirection::DEFAULT.fetch("format")
      )
      metadata["directionGoalChosen"] = true
      metadata["directionStyleChosen"] = true
      metadata["directionStage"] = "ready"
      @project.update!(metadata: metadata)
    end

    def clip_params
      params.fetch(:clip, {}).permit(:title, :music_id, :music_volume, :music_start_offset_ms, shots: {})
    end

    def updated_music_payload
      MusicCatalog.payload_for(
        id: clip_params[:music_id].presence || @clip.scene_contract.to_h.dig("music", "id") || "none",
        volume: clip_params[:music_volume].presence || @clip.scene_contract.to_h.dig("music", "volume") || MusicCatalog::DEFAULT_VOLUME,
        start_offset_ms: clip_params[:music_start_offset_ms].presence || @clip.scene_contract.to_h.dig("music", "startOffsetMs") || 0
      )
    end

    def oversized_clip_scene_text?(shots_params)
      shots_params.values.any? do |shot_params|
        params = shot_params.to_h
        params["text"].to_s.strip.length > Panel::MAX_SCENE_TEXT_LENGTH
      end
    end

    def update_contract_shot(shot, raw_shot_params, index)
      return shot unless raw_shot_params.present?

      shot_params = raw_shot_params.to_h
      no_text = truthy_param?(shot_params["no_text"])
      text = shot_params["text"].to_s.strip
      shot["noText"] = no_text
      no_text || text.blank? ? shot.delete("text") : shot["text"] = text
      shot.delete("context")
      assign_shot_choice(shot, "sceneMode", shot_params["scene_mode"], SCENE_MODES)
      apply_scene_mode_defaults(shot, index) if shot_params["scene_mode"].present?
      assign_shot_choice(shot, "sceneMotion", shot_params["scene_motion"], Panel::SCENE_MOTIONS)
      assign_shot_choice(shot, "sceneBubble", shot_params["scene_bubble"], Panel::SCENE_BUBBLES)
      assign_shot_choice(shot, "scenePosition", shot_params["scene_position"], Panel::SCENE_POSITIONS)
      assign_shot_choice(shot, "sceneSize", shot_params["scene_size"], Panel::SCENE_SIZES)
      assign_shot_choice(shot, "sceneDuration", shot_params["scene_duration"], Panel::SCENE_DURATIONS)
      assign_shot_choice(shot, "effectIntensity", shot_params["effect_intensity"], EFFECT_INTENSITIES)
      shot["transition"] = index.zero? ? "none" : normalized_shot_transition(shot_params["transition"], shot["transition"])
      apply_custom_duration(shot, shot_params["duration_seconds"]) if shot_params.key?("duration_seconds")
      apply_motion_intensity_defaults(shot) if shot_params.key?("scene_motion") && !shot_params.key?("effect_intensity")
      sync_shot_overlay(shot)
      sync_shot_motion(shot)
      shot
    end

    def retime_contract_shots!(contract)
      shots = contract.fetch("shots", [])
      return if shots.empty?

      cursor = 0

      shots.each_with_index do |shot, index|
        duration = custom_duration_ms_for(shot) || weighted_duration_ms_for(contract, shots, index)

        shot["startMs"] = cursor
        shot["durationMs"] = duration
        shot["endMs"] = cursor + duration
        shot["pixiRhythm"]["parameters"]["durationMs"] = duration if shot.dig("pixiRhythm", "parameters")
        cursor += duration
      end

      contract["durationMs"] = cursor
    end

    def apply_scene_mode_defaults(shot, index)
      case shot["sceneMode"]
      when "soft"
        shot["sceneMotion"] = "float"
        shot["sceneBubble"] = "caption"
        shot["sceneDuration"] = "long"
        shot["effectIntensity"] = "subtle"
        shot["transition"] = index.zero? ? "none" : "cut"
      when "impact"
        shot["sceneMotion"] = "impact"
        shot["sceneBubble"] = "burst"
        shot["sceneDuration"] = "short"
        shot["effectIntensity"] = "intense"
        shot["transition"] = index.zero? ? "none" : "panel_slam"
      when "dramatic"
        shot["sceneMotion"] = "cinematic"
        shot["sceneBubble"] = "caption"
        shot["sceneDuration"] = "long"
        shot["effectIntensity"] = "balanced"
        shot["transition"] = index.zero? ? "none" : "ink_flash"
      when "clear"
        shot["sceneMotion"] = "scroll"
        shot["sceneBubble"] = "caption"
        shot["sceneDuration"] = "normal"
        shot["effectIntensity"] = "subtle"
        shot["transition"] = index.zero? ? "none" : "cut"
      else
        shot["sceneMotion"] = "auto"
        shot["sceneBubble"] = "auto"
        shot["sceneDuration"] = "auto"
        shot["effectIntensity"] = "auto"
        shot["transition"] = index.zero? ? "none" : "cut"
      end
    end

    def assign_shot_choice(shot, key, value, allowed)
      value = value.to_s
      shot[key] = allowed.include?(value) ? value : shot.fetch(key, "auto")
    end

    def apply_custom_duration(shot, value)
      duration_ms = sanitize_duration_ms(value)
      shot["customDurationMs"] = duration_ms
      shot["sceneDuration"] = "custom"
    end

    def sanitize_duration_ms(value)
      seconds = value.to_s.tr(",", ".").to_f
      seconds = MIN_SCENE_DURATION_SECONDS if seconds < MIN_SCENE_DURATION_SECONDS
      seconds = MAX_SCENE_DURATION_SECONDS if seconds > MAX_SCENE_DURATION_SECONDS
      (seconds * 1000).round
    end

    def custom_duration_ms_for(shot)
      duration = shot["customDurationMs"].to_i
      return nil unless duration.positive?

      duration.clamp((MIN_SCENE_DURATION_SECONDS * 1000).round, (MAX_SCENE_DURATION_SECONDS * 1000).round)
    end

    def weighted_duration_ms_for(contract, shots, index)
      total_duration = [ contract["durationMs"].to_i, @clip.duration_ms.to_i, shots.size * 700 ].max
      weights = shots.map { |shot| SCENE_DURATION_WEIGHTS.fetch(shot["sceneDuration"].to_s, 1.0) }
      total_weight = weights.sum

      [ (total_duration * (weights[index] / total_weight)).round, 700 ].max
    end

    def merge_preserved_scene_edits(new_contract, current_contract)
      current_shots = current_contract.fetch("shots", []).index_by { |shot| shot.fetch("panelId").to_s }
      new_contract["shots"] = new_contract.fetch("shots", []).map do |shot|
        preserve_scene_edit(shot.deep_dup, current_shots[shot.fetch("panelId").to_s])
      end
      retime_regenerated_contract_shots!(new_contract)
      new_contract
    end

    def preserve_scene_edit(shot, current_shot)
      return shot unless current_shot.present?

      preserve_scene_text(shot, current_shot)
      preserve_scene_text_style(shot, current_shot) if edited_text_style?(current_shot)
      preserve_scene_motion(shot, current_shot) if edited_motion?(current_shot)
      preserve_scene_duration(shot, current_shot) if custom_duration_ms_for(current_shot)
      sync_shot_overlay(shot)
      sync_shot_motion(shot)
      shot
    end

    def preserve_scene_text(shot, current_shot)
      text = current_shot["text"].to_s.strip
      shot["noText"] = current_shot["noText"] == true
      if text.blank? || shot["noText"]
        shot.delete("text")
      else
        shot["text"] = text
      end
    end

    def preserve_scene_text_style(shot, current_shot)
      shot["sceneBubble"] = current_shot.fetch("sceneBubble", shot["sceneBubble"])
      shot["scenePosition"] = current_shot.fetch("scenePosition", shot["scenePosition"])
      shot["sceneSize"] = current_shot.fetch("sceneSize", shot["sceneSize"])
    end

    def preserve_scene_motion(shot, current_shot)
      shot["sceneMotion"] = current_shot.fetch("sceneMotion", shot["sceneMotion"])
      shot["effectIntensity"] = current_shot.fetch("effectIntensity", shot["effectIntensity"])
    end

    def preserve_scene_duration(shot, current_shot)
      duration = custom_duration_ms_for(current_shot)
      return unless duration

      shot["customDurationMs"] = duration
      shot["sceneDuration"] = "custom"
    end

    def edited_text_style?(shot)
      %w[clip_edit live_edit].include?(shot.dig("overlay", "source").to_s)
    end

    def edited_motion?(shot)
      %w[clip_edit live_edit].include?(shot.dig("motion", "source").to_s)
    end

    def retime_regenerated_contract_shots!(contract)
      shots = contract.fetch("shots", [])
      return if shots.empty?

      cursor = 0
      weights = shots.map { |shot| SCENE_DURATION_WEIGHTS.fetch(shot["sceneDuration"].to_s, 1.0) }
      fixed_duration = shots.sum { |shot| custom_duration_ms_for(shot).to_i }
      flexible_indexes = shots.each_index.reject { |index| custom_duration_ms_for(shots[index]) }
      flexible_weight = flexible_indexes.sum { |index| weights[index] }
      target_duration = [ contract["durationMs"].to_i, fixed_duration + (flexible_indexes.size * 700) ].max

      shots.each_with_index do |shot, index|
        duration = custom_duration_ms_for(shot) || regenerated_weighted_duration_ms(target_duration, fixed_duration, weights[index], flexible_weight)
        shot["startMs"] = cursor
        shot["durationMs"] = duration
        shot["endMs"] = cursor + duration
        shot["pixiRhythm"]["parameters"]["durationMs"] = duration if shot.dig("pixiRhythm", "parameters")
        cursor += duration
      end

      contract["durationMs"] = cursor
    end

    def regenerated_weighted_duration_ms(target_duration, fixed_duration, weight, flexible_weight)
      return 700 if flexible_weight.to_f <= 0

      available_duration = [ target_duration - fixed_duration, 700 ].max
      [ (available_duration * (weight / flexible_weight)).round, 700 ].max
    end

    def clip_shot_phase(index, total)
      return "HOOK" if index.zero?
      return "CLOSE" if index == total - 1
      return "CLIMAX" if index == total - 2

      "BODY"
    end

    def apply_motion_intensity_defaults(shot)
      shot["effectIntensity"] = case shot["sceneMotion"]
      when "float" then "subtle"
      when "impact" then "intense"
      else "balanced"
      end
    end

    def normalized_shot_transition(value, fallback)
      value = value.to_s
      return "cut" if value == "auto"
      return value if (Panel::SCENE_TRANSITIONS - [ "auto" ]).include?(value)

      (Panel::SCENE_TRANSITIONS - [ "auto" ]).include?(fallback) ? fallback : "cut"
    end

    def sync_shot_overlay(shot)
      text = shot["text"].to_s.strip

      if shot["noText"] == true || text.blank? || shot["scenePosition"] == "none"
        shot.delete("overlay")
        return
      end

      shot["overlay"] = {
        "text" => text,
        "source" => "clip_edit",
        "style" => resolved_shot_choice(shot, "sceneBubble", "resolvedBubble", "caption"),
        "position" => resolved_shot_choice(shot, "scenePosition", "resolvedPosition", "bottom_safe"),
        "size" => resolved_shot_choice(shot, "sceneSize", "resolvedSize", "medium")
      }
    end

    def sync_shot_motion(shot)
      motion = shot["sceneMotion"].to_s
      resolved_motion = if motion == "auto"
        shot.dig("motion", "style").presence || default_motion_for_phase(shot["phase"])
      else
        motion
      end

      shot["motion"] = {
        "style" => resolved_motion,
        "source" => motion == "auto" ? "direction" : "clip_edit",
        "intensity" => shot.fetch("effectIntensity", "auto")
      }
    end

    def default_motion_for_phase(phase)
      case phase
      when "HOOK" then "cinematic"
      when "CLIMAX" then "impact"
      when "CLOSE" then "scroll"
      else "parallax"
      end
    end

    def truthy_param?(value)
      ActiveModel::Type::Boolean.new.cast(value)
    end

    def resolved_shot_choice(shot, authored_key, resolved_key, fallback)
      authored_value = shot[authored_key].to_s
      return authored_value if authored_value.present? && authored_value != "auto"

      shot[resolved_key].presence || fallback
    end

    def proposal_settings
      {
        "genre" => safe_choice(params[:proposal_genre], PROPOSAL_GENRES, "drama"),
        "sceneTime" => safe_choice(params[:proposal_scene_time], PROPOSAL_SCENE_TIMES, "auto"),
        "intensity" => safe_choice(params[:proposal_intensity], PROPOSAL_INTENSITIES, "balanced"),
        "brief" => clean_proposal_text(params[:proposal_brief]),
        "noSpoilers" => clean_proposal_text(params[:proposal_no_spoilers])
      }.compact
    end

    def regeneration_proposal_settings
      current = @clip.metadata.to_h.fetch("proposal", @clip.scene_contract.to_h.fetch("proposal", {})).to_h

      proposal_settings.merge(
        "genre" => safe_choice(current["genre"], PROPOSAL_GENRES, "drama"),
        "brief" => current["brief"].presence,
        "noSpoilers" => current["noSpoilers"].presence
      ).compact
    end

    def safe_choice(value, allowed, fallback)
      value = value.to_s
      allowed.include?(value) ? value : fallback
    end

    def regeneration_mode
      "variant"
    end

    def clean_proposal_text(value)
      text = value.to_s.squish
      text.presence&.first(PROPOSAL_TEXT_MAX_LENGTH)
    end

    def normalized_scene_contract(contract = @clip.scene_contract)
      SceneContracts::PixiContractNormalizer.new(
        project: @project,
        contract: contract,
        proposal: @clip.metadata.to_h.fetch("proposal", contract.to_h.fetch("proposal", {})).to_h
      ).call
    end

    def text_style_options_for(genre)
      options = TEXT_STYLE_OPTIONS.fetch("global") + TEXT_STYLE_OPTIONS.fetch(genre.to_s, [])
      options.uniq { |option| option.fetch(:value) }
    end

    def preview_payload(contract)
      assets = preview_assets_for(contract)

      {
        contract: contract,
        assets: assets.transform_values do |asset|
          {
            id: asset.id,
            filename: asset.filename,
            contentType: asset.content_type,
            url: asset.file.attached? ? rails_blob_url(asset.file, disposition: "inline") : nil
          }
        end
      }
    end

    def preview_assets_for(contract)
      asset_ids = contract.fetch("shots", []).map { |shot| shot.fetch("assetId") }.uniq
      @project.project_assets.with_attached_file.where(id: asset_ids).index_by(&:id)
    end
end
