module SceneContracts
  class PixiContractNormalizer
    DEFAULT_FORMAT = InitialClipBuilder::FORMAT
    DEFAULT_VISUAL = InitialClipBuilder::VISUAL

    def initialize(project:, contract:, proposal: {})
      @project = project
      @contract = contract.to_h.deep_dup
      @proposal = proposal.presence || @contract["proposal"].to_h
    end

    def call
      normalized = contract
      normalized["contractVersion"] = Clip::CONTRACT_VERSION
      normalized["renderer"] = "pixi"
      normalized["format"] = DEFAULT_FORMAT.merge(normalized["format"].to_h)
      normalized["contentLocale"] ||= project.content_locale
      normalized["direction"] = direction
      normalized["proposal"] = proposal if proposal.present?
      normalized["visual"] = normalized_visual(normalized["visual"])
      normalized["music"] = normalized_music(normalized["music"])
      normalized["shots"] = normalized_shots(normalized.fetch("shots", []))
      normalized["durationMs"] ||= normalized["shots"].sum { |shot| shot.fetch("durationMs", 0).to_i }
      normalized
    end

    private

      attr_reader :project, :contract, :proposal

      def direction
        @direction ||= ProjectDirection.normalize(contract["direction"].presence || ProjectDirection.for(project))
      end

      def proposal_genre
        @proposal_genre ||= proposal["genre"].presence || ProjectDirection.proposal_defaults_for(direction).fetch("genre")
      end

      def normalized_visual(visual)
        DEFAULT_VISUAL.merge(visual.to_h).merge(
          "montage" => visual.to_h.fetch("montage", {
            "presetKey" => direction.fetch("style"),
            "genre" => proposal_genre,
            "source" => "komaclip-contract-normalizer"
          })
        )
      end

      def normalized_music(music)
        payload = music.to_h
        if payload["id"].present?
          return MusicCatalog.payload_for(
            id: payload["id"],
            volume: payload["volume"],
            start_offset_ms: payload["startOffsetMs"]
          )
        end

        MusicCatalog.payload_for(id: MusicCatalog.default_for(proposal).id, volume: MusicCatalog::DEFAULT_VOLUME)
      end

      def normalized_shots(shots)
        cursor = 0
        total = shots.size

        shots.map.with_index do |raw_shot, index|
          shot = raw_shot.to_h.deep_dup
          duration_ms = normalized_duration_ms(shot)
          start_ms = numeric_or_nil(shot["startMs"]) || cursor
          end_ms = numeric_or_nil(shot["endMs"]) || start_ms + duration_ms
          duration_ms = [ end_ms - start_ms, 700 ].max
          cursor = start_ms + duration_ms

          phase = shot["phase"].presence || shot_phase(index, total)
          transition = index.zero? ? "none" : normalized_transition(shot["transition"])
          motion_style = resolved_motion_style(shot, phase)
          overlay = overlay_for(shot)
          rhythm = pixi_rhythm_for(phase, motion_style, transition, duration_ms)
          pixi_plan = pixi_montage_planner.plan_shot(
            overlay: overlay,
            motion_style: motion_style,
            transition: transition,
            phase: phase,
            index: index,
            total: total,
            duration_ms: duration_ms
          )
          text_style = pixi_plan["pixiTextStyle"]
          camera_motion = pixi_plan["pixiCameraMotion"]
          active_effect = pixi_plan["pixiActiveEffect"]
          transition_out = pixi_plan["pixiTransitionOut"]

          shot.merge(
            "phase" => phase,
            "startMs" => start_ms,
            "endMs" => start_ms + duration_ms,
            "durationMs" => duration_ms,
            "noText" => shot["noText"] == true,
            "sceneMotion" => shot["sceneMotion"].presence || "auto",
            "sceneBubble" => shot["sceneBubble"].presence || overlay.to_h["style"].presence || "auto",
            "scenePosition" => shot["scenePosition"].presence || overlay.to_h["position"].presence || "auto",
            "sceneSize" => shot["sceneSize"].presence || overlay.to_h["size"].presence || "auto",
            "sceneDuration" => shot["sceneDuration"].presence || "auto",
            "effectIntensity" => shot["effectIntensity"].presence || normalized_visual(contract["visual"]).fetch("intensity", "auto"),
            "overlay" => overlay,
            "motion" => {
              "style" => motion_style,
              "source" => shot["sceneMotion"].to_s == "auto" ? "direction" : "clip_edit",
              "intensity" => shot["effectIntensity"].presence || normalized_visual(contract["visual"]).fetch("intensity", "auto")
            },
            "transition" => transition,
            "pixiTextStyle" => text_style,
            "pixiCameraMotion" => camera_motion,
            "pixiActiveEffect" => active_effect,
            "pixiTransitionOut" => transition_out,
            "pixiRhythm" => rhythm,
            "pixiVisualPresetIds" => pixi_visual_preset_ids(text_style, camera_motion, active_effect, transition_out, rhythm),
            "pixiTags" => pixi_plan.fetch("pixiTags", pixi_tags(phase, motion_style, transition))
          ).compact
        end
      end

      def pixi_montage_planner
        @pixi_montage_planner ||= PixiMontagePlanner.new(
          direction: direction,
          proposal: proposal,
          visual_intensity: normalized_visual(contract["visual"]).fetch("intensity", "auto"),
          generation_seed: contract.to_h.dig("visual", "montage", "generationSeed")
        )
      end

      def normalized_duration_ms(shot)
        duration = numeric_or_nil(shot["durationMs"])
        return duration if duration&.positive?

        start_ms = numeric_or_nil(shot["startMs"])
        end_ms = numeric_or_nil(shot["endMs"])
        return end_ms - start_ms if start_ms && end_ms && end_ms > start_ms

        1_800
      end

      def numeric_or_nil(value)
        number = Integer(value, exception: false)
        number if number
      end

      def shot_phase(index, total)
        return "HOOK" if index.zero?
        return "CLOSE" if index == total - 1
        return "CLIMAX" if index == total - 2

        "BODY"
      end

      def normalized_transition(value)
        transition = value.to_s.presence || "cut"
        return "cut" if transition == "auto"
        return transition if (Panel::SCENE_TRANSITIONS - [ "auto" ]).include?(transition)

        "cut"
      end

      def resolved_motion_style(shot, phase)
        authored = shot["sceneMotion"].to_s
        return authored if authored.present? && authored != "auto"

        shot.dig("motion", "style").presence || default_motion_for_phase(phase)
      end

      def overlay_for(shot)
        text = shot["text"].to_s.strip
        return nil if shot["noText"] == true || text.blank? || shot["scenePosition"] == "none"

        existing = shot["overlay"].to_h
        {
          "text" => text,
          "source" => existing["source"].presence || "contract_normalized",
          "style" => resolved_shot_choice(shot, "sceneBubble", "resolvedBubble", existing["style"].presence || "caption"),
          "position" => resolved_shot_choice(shot, "scenePosition", "resolvedPosition", existing["position"].presence || "bottom_safe"),
          "size" => resolved_shot_choice(shot, "sceneSize", "resolvedSize", existing["size"].presence || "medium")
        }
      end

      def resolved_shot_choice(shot, authored_key, resolved_key, fallback)
        authored_value = shot[authored_key].to_s
        return authored_value if authored_value.present? && authored_value != "auto"

        shot[resolved_key].presence || fallback
      end

      def pixi_text_style_for(overlay)
        return nil if overlay.blank?

        layout = overlay.fetch("style", "caption")
        {
          "id" => text_preset_id_for(layout),
          "kind" => "textStyle",
          "layout" => layout,
          "catalogLayout" => text_catalog_layout_for(layout),
          "textAnimation" => text_animation_for(layout),
          "parameters" => {
            "position" => overlay.fetch("position", "bottom_safe"),
            "size" => overlay.fetch("size", "medium"),
            "assetSlots" => MangaFxCatalog.slots_for_preset(preset_id: text_preset_id_for(layout), visual_category: text_visual_category_for(layout))
          }
        }
      end

      def text_preset_id_for(layout)
        case layout
        when "burst" then "tx-manga-impact-sfx"
        when "manga_vertical" then "tx-manga-dododo-pressure"
        when "speech", "thought" then "tx-webtoon-floating-thought-card"
        else "tx-hook-clean-caption"
        end
      end

      def text_catalog_layout_for(layout)
        case layout
        when "burst" then "black-star"
        when "manga_vertical" then "sfx-vertical"
        when "speech", "thought" then "love-letter"
        else "lower-third"
        end
      end

      def text_animation_for(layout)
        case layout
        when "burst" then "pop_lock"
        when "manga_vertical" then "manga_reveal"
        when "speech", "thought" then "bubble_rise"
        else "rise_lock"
        end
      end

      def text_visual_category_for(layout)
        case layout
        when "speech", "thought" then "romance-fantasy"
        else "manga-action"
        end
      end

      def pixi_camera_motion_for(motion_style, index)
        {
          "id" => "cam-#{motion_style}",
          "kind" => "cameraMotion",
          "motionStyle" => motion_style,
          "parameters" => camera_motion_parameters(motion_style, index)
        }
      end

      def camera_motion_parameters(motion_style, index)
        {
          "zoomStart" => motion_style == "rgb" ? 1.22 : motion_style == "impact" ? 1.16 : motion_style == "parallax" ? 1.12 : index.even? ? 1.0 : 1.08,
          "zoomEnd" => motion_style == "rgb" ? 1.02 : motion_style == "impact" ? 1.02 : motion_style == "beat" ? 1.08 : index.even? ? 1.1 : 1.0,
          "panX" => motion_style == "rgb" ? (index.even? ? -0.08 : 0.08) : motion_style == "float" ? 0.02 : motion_style == "parallax" ? 0.06 : index.even? ? -0.04 : 0.04,
          "panY" => motion_style == "scroll" ? 0 : motion_style == "float" ? (Math.sin(index + 1) * 0.04).round(4) : index % 3 == 0 ? -0.03 : 0.03,
          "tempo" => %w[impact beat rgb manga].include?(motion_style) ? 1.28 : 1.0
        }
      end

      def pixi_active_effect_for(motion_style, phase, shot)
        effect = active_effect_contract(motion_style, phase)
        {
          "id" => effect.fetch("id"),
          "kind" => "activeEffect",
          "layout" => effect.fetch("layout"),
          "parameters" => {
            "intensity" => shot["effectIntensity"].presence || normalized_visual(contract["visual"]).fetch("intensity", "auto"),
            "phase" => phase.to_s.downcase,
            "profile" => effect.fetch("profile"),
            "assetSlots" => MangaFxCatalog.slots_for(effect_id: effect.fetch("id"), visual_category: effect.fetch("profile"))
          }
        }
      end

      def active_effect_contract(motion_style, phase)
        return effect_contract("fx-impact-freeze-punch", "impact-freeze-punch-pro-vfx", "manga-action") if motion_style == "impact" || (phase == "CLIMAX" && proposal_genre == "action")
        return effect_contract("fx-panel-smash-burst", "panel-smash-burst-pro-vfx", "manga-action") if motion_style == "beat"
        return effect_contract("fx-slash-energy-cut", "slash-energy-cut-pro-vfx", "manga-action") if motion_style == "swipe"
        return effect_contract("fx-manga-speed-impact", "speed-impact-pro-vfx", "manga-action") if motion_style == "manga" || proposal_genre == "action"
        return effect_contract("fx-scifi-hud", "scifi-hud", "scifi-hud") if %w[rgb glitch].include?(motion_style) || proposal_genre == "scifi"
        return effect_contract("fx-horror-signal", "horror-signal", "horror-signal") if %w[horror thriller].include?(proposal_genre)
        return effect_contract("fx-romance-petals", "romance-petals", "romance-petals") if proposal_genre == "romance"
        return effect_contract("fx-fantasy-spark", "fantasy-spark", "fantasy-spark") if proposal_genre == "fantasy"
        return effect_contract("fx-comedy-pop", "comedy-pop", "comedy-pop") if proposal_genre == "comedy"

        effect_contract("fx-editorial-grain", "editorial-grain", "editorial-grain")
      end

      def effect_contract(id, layout, profile)
        { "id" => id, "layout" => layout, "profile" => profile }
      end

      def pixi_transition_out_for(transition)
        return nil unless visible_transition?(transition)

        contract = transition_contract(transition)
        {
          "id" => contract.fetch("id"),
          "kind" => "transitionOut",
          "transitionType" => transition,
          "parameters" => {
            "durationMs" => transition_duration_ms(transition),
            "tempo" => %w[speed_wipe panel_slam].include?(transition) ? 1.18 : 1.0,
            "layout" => contract.fetch("layout"),
            "assetSlots" => MangaFxCatalog.slots_for_preset(preset_id: contract.fetch("id"), visual_category: "manga-action")
          }
        }
      end

      def transition_contract(transition)
        case transition
        when "speed_wipe" then { "id" => "tr-speed-wipe-pro", "layout" => "speed-wipe" }
        when "panel_slam" then { "id" => "tr-impact-smash-cut", "layout" => "impact-smash" }
        when "page_slice" then { "id" => "tr-page-flip-pro", "layout" => "page-flip-pro-vfx" }
        when "ink_flash" then { "id" => "tr-ink-flash-impact", "layout" => "ink-flash-impact-pro-vfx" }
        else { "id" => "tr-#{transition.tr("_", "-")}", "layout" => transition.tr("_", "-") }
        end
      end

      def transition_duration_ms(transition)
        case transition
        when "panel_slam" then 430
        when "page_slice" then 560
        when "ink_flash" then 500
        else 460
        end
      end

      def pixi_rhythm_for(phase, motion_style, transition, duration_ms)
        intensity = rhythm_intensity_for(phase, motion_style)
        {
          "id" => "rhythm-#{phase.to_s.downcase}-#{motion_style}",
          "kind" => "rhythm",
          "tempo" => rhythm_tempo_for(motion_style),
          "parameters" => {
            "durationMs" => duration_ms,
            "intensity" => intensity,
            "beats" => rhythm_beats_for(phase, motion_style, transition, intensity)
          }
        }
      end

      def rhythm_tempo_for(motion_style)
        return 1.35 if %w[impact beat rgb manga swipe].include?(motion_style)
        return 0.82 if %w[scroll float].include?(motion_style)

        1.0
      end

      def rhythm_intensity_for(phase, motion_style)
        return "hit" if phase == "CLIMAX" || %w[impact beat manga].include?(motion_style)
        return "hook" if phase == "HOOK"
        return "hold" if phase == "CLOSE" || %w[scroll float].include?(motion_style)

        "pulse"
      end

      def rhythm_beats_for(phase, motion_style, transition, intensity)
        beats = [
          { "at" => 0.08, "kind" => "entry", "strength" => intensity == "hold" ? 0.34 : 0.48 },
          { "at" => phase == "HOOK" ? 0.32 : 0.5, "kind" => intensity == "hit" ? "impact" : "story", "strength" => intensity == "hit" ? 0.88 : 0.54 }
        ]

        beats << { "at" => 0.68, "kind" => "impact", "strength" => 0.72 } if %w[impact beat manga swipe].include?(motion_style)
        beats << { "at" => 0.9, "kind" => visible_transition?(transition) ? "exit" : "hold", "strength" => visible_transition?(transition) ? 0.62 : 0.26 }
        beats
      end

      def pixi_visual_preset_ids(*contracts)
        contracts.compact.map { |item| item.fetch("id") }
      end

      def pixi_tags(phase, motion_style, transition)
        [
          "phase:#{phase.to_s.downcase}",
          "genre:#{proposal_genre}",
          "style:#{direction.fetch("style")}",
          "motion:#{motion_style}",
          visible_transition?(transition) ? "transition:#{transition}" : nil
        ].compact
      end

      def visible_transition?(transition)
        transition.present? && !%w[none cut].include?(transition)
      end

      def default_motion_for_phase(phase)
        case phase
        when "HOOK" then "cinematic"
        when "CLIMAX" then "impact"
        when "CLOSE" then "scroll"
        else "parallax"
        end
      end
  end
end
