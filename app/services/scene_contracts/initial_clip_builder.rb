module SceneContracts
  class InitialClipBuilder
    DEFAULT_DURATION_MS = 8_000
    MIN_DURATION_MS = 1_000
    MAX_DURATION_MS = 60_000
    AUTO_PANEL_MS = 2_200

    FORMAT = {
      "width" => 1080,
      "height" => 1920,
      "fps" => 30
    }.freeze
    FORMAT_LIMITS = {
      "width" => 360..2160,
      "height" => 640..3840,
      "fps" => 12..60
    }.freeze
    VISUAL = {
      "presetId" => "baseline-panel-sequence",
      "catalogContractVersion" => "p2r.visual.v2"
    }.freeze
    SCENE_DURATION_WEIGHTS = {
      "short" => 0.75,
      "normal" => 1.0,
      "long" => 1.35
    }.freeze
    DIRECTOR_VARIANTS = {
      "trailer_tense" => {
        motions: %w[cinematic float swipe cinematic parallax scroll cinematic],
        bubbles: %w[caption caption burst caption caption burst caption],
        positions: %w[bottom_safe bottom_safe top_safe bottom_safe],
        transitions: %w[speed_wipe cut ink_flash speed_wipe]
      },
      "impact_fast" => {
        motions: %w[manga impact swipe rgb manga beat impact],
        bubbles: %w[burst caption burst caption burst caption burst],
        positions: %w[center_safe top_safe center_safe bottom_safe],
        transitions: %w[speed_wipe ink_flash panel_slam page_slice]
      },
      "chapter_clean" => {
        motions: %w[cinematic scroll float cinematic parallax swipe cinematic],
        bubbles: %w[caption caption burst caption caption burst caption],
        positions: %w[bottom_safe bottom_safe center_safe bottom_safe],
        transitions: %w[cut cut ink_flash cut]
      },
      "webtoon_scroll" => {
        motions: %w[scroll scroll cinematic scroll parallax scroll cinematic],
        bubbles: %w[caption caption burst caption caption burst caption],
        positions: %w[bottom_safe bottom_safe bottom_safe top_safe],
        transitions: %w[page_slice speed_wipe cut page_slice]
      },
      "character_spotlight" => {
        motions: %w[parallax float cinematic parallax float scroll cinematic],
        bubbles: %w[caption caption burst caption caption burst caption],
        positions: %w[bottom_safe center_safe bottom_safe bottom_safe],
        transitions: %w[cut ink_flash speed_wipe cut]
      },
      "sales_pitch" => {
        motions: %w[cinematic parallax scroll cinematic beat cinematic scroll],
        bubbles: %w[caption caption burst caption caption burst caption],
        positions: %w[bottom_safe bottom_safe center_safe bottom_safe],
        transitions: %w[ink_flash cut speed_wipe ink_flash]
      },
      "making_of" => {
        motions: %w[beat float cinematic swipe beat parallax float],
        bubbles: %w[caption caption burst caption caption burst caption],
        positions: %w[bottom_safe top_safe bottom_safe bottom_safe],
        transitions: %w[cut speed_wipe ink_flash cut]
      }
    }.freeze
    GENRE_TRANSITIONS = {
      "romance" => %w[speed_wipe ink_flash cut],
      "drama" => %w[speed_wipe ink_flash page_slice],
      "action" => %w[speed_wipe panel_slam page_slice],
      "horror" => %w[ink_flash page_slice cut],
      "fantasy" => %w[ink_flash page_slice speed_wipe],
      "scifi" => %w[ink_flash speed_wipe cut],
      "thriller" => %w[ink_flash cut page_slice],
      "comedy" => %w[panel_slam speed_wipe cut]
    }.freeze

    def initialize(project:, panels:, proposal: {}, generation_seed: nil)
      @project = project
      @panels = panels
      @proposal = proposal
      @generation_seed = generation_seed
    end

    def build
      clip_duration_ms = duration_ms

      {
        "contractVersion" => Clip::CONTRACT_VERSION,
        "renderer" => "pixi",
        "format" => format,
        "durationMs" => clip_duration_ms,
        "contentLocale" => project.content_locale,
        "direction" => direction,
        "visual" => visual,
        "proposal" => proposal.presence,
        "music" => music,
        "shots" => shots(clip_duration_ms)
      }.compact
    end

    private

      attr_reader :project, :panels, :proposal, :generation_seed

      def template_settings
        @template_settings ||= project.metadata.to_h.fetch("templateSettings", {}).to_h
      end

      def direction
        @direction ||= ProjectDirection.for(project)
      end

      def director_variant
        @director_variant ||= DIRECTOR_VARIANTS.fetch(direction.fetch("style"), DIRECTOR_VARIANTS.fetch("chapter_clean"))
      end

      def duration_ms
        value = template_settings["durationMs"].to_i
        return proposal_duration_ms unless value.positive?

        value.clamp(MIN_DURATION_MS, MAX_DURATION_MS)
      end

      def proposal_duration_ms
        mode = proposal.to_h["sceneTime"].to_s
        return DEFAULT_DURATION_MS if mode.blank?

        panel_count = [ panels.size, 1 ].max
        auto_duration = if panel_count == 1
          DEFAULT_DURATION_MS
        elsif panel_count == 2
          10_000
        else
          panel_count * AUTO_PANEL_MS
        end

        duration = case mode
        when "short"
          (auto_duration * 0.78).round.clamp(8_000, 15_000)
        when "standard"
          auto_duration.clamp(15_000, 45_000)
        when "cinematic"
          (auto_duration * 1.12).round.clamp(22_000, MAX_DURATION_MS)
        else
          auto_duration.clamp(DEFAULT_DURATION_MS, 45_000)
        end

        duration.clamp(MIN_DURATION_MS, MAX_DURATION_MS)
      end

      def format
        settings_format = template_settings["format"].is_a?(Hash) ? template_settings["format"] : {}

        FORMAT.each_with_object({}) do |(key, default), memo|
          value = settings_format[key].to_i
          memo[key] = FORMAT_LIMITS.fetch(key).cover?(value) ? value : default
        end
      end

      def visual
        settings_visual = template_settings["visual"].is_a?(Hash) ? template_settings["visual"] : {}
        proposal_intensity = proposal.to_h["intensity"].presence

        VISUAL.merge(
          settings_visual.slice("presetId", "catalogContractVersion").select { |_key, value| value.is_a?(String) && value.present? }
        ).merge(
          proposal_intensity.present? ? { "intensity" => proposal_intensity } : {}
        ).merge(
          "montage" => {
            "presetKey" => direction.fetch("style"),
            "genre" => proposal_genre,
            "source" => "komaclip-director-lite",
            "generationSeed" => generation_seed.presence
          }.compact
        )
      end

      def music
        settings_music = template_settings["music"].is_a?(Hash) ? template_settings["music"] : {}
        track_id = settings_music["id"].presence || MusicCatalog.default_for(proposal).id
        volume = settings_music.key?("volume") ? settings_music["volume"] : MusicCatalog::DEFAULT_VOLUME

        MusicCatalog.payload_for(id: track_id, volume: volume)
      end

      def shots(clip_duration_ms)
        timings = shot_timings(clip_duration_ms)

        panels.map.with_index do |panel, index|
          text = panel.display_scene_text.presence
          timing = timings.fetch(index)
          phase = shot_phase(index)
          motion_style = resolved_motion_for(panel, phase, index)
          bubble_style = resolved_bubble_for(panel, phase, index)
          text_position = resolved_position_for(panel, phase, index)
          text_size = resolved_size_for(panel, phase)
          transition = index.zero? ? "none" : resolved_transition_for(panel, index)
          overlay = overlay_for(panel, text, bubble_style, text_position, text_size)
          rhythm = pixi_rhythm_for(phase, motion_style, transition, timing.fetch("durationMs"))
          pixi_plan = pixi_montage_planner.plan_shot(
            overlay: overlay,
            motion_style: motion_style,
            transition: transition,
            phase: phase,
            index: index,
            total: panels.size,
            duration_ms: timing.fetch("durationMs")
          )
          text_style = pixi_plan["pixiTextStyle"]
          camera_motion = pixi_plan["pixiCameraMotion"]
          active_effect = pixi_plan["pixiActiveEffect"]
          transition_out = pixi_plan["pixiTransitionOut"]

          {
            "panelId" => panel.id,
            "assetId" => panel.project_asset_id,
            "phase" => phase,
            "position" => panel.position,
            "label" => panel.label,
            "filename" => panel.project_asset.filename,
            "crop" => panel.crop,
            "text" => text,
            "noText" => panel.no_text?,
            "sceneMotion" => panel.scene_motion,
            "sceneBubble" => panel.scene_bubble,
            "scenePosition" => panel.scene_position,
            "sceneSize" => panel.scene_size,
            "sceneDuration" => panel.scene_duration,
            "resolvedBubble" => bubble_style,
            "resolvedPosition" => text_position,
            "resolvedSize" => text_size,
            "startMs" => timing.fetch("startMs"),
            "endMs" => timing.fetch("endMs"),
            "durationMs" => timing.fetch("durationMs"),
            "pace" => proposal.to_h["sceneTime"].presence || "auto",
            "effectIntensity" => visual.fetch("intensity", "auto"),
            "overlay" => overlay,
            "motion" => motion_for(panel, motion_style),
            "transition" => transition,
            "pixiTextStyle" => text_style,
            "pixiCameraMotion" => camera_motion,
            "pixiActiveEffect" => active_effect,
            "pixiTransitionOut" => transition_out,
            "pixiRhythm" => rhythm,
            "pixiVisualPresetIds" => pixi_visual_preset_ids(text_style, camera_motion, active_effect, transition_out, rhythm),
            "pixiTags" => pixi_plan.fetch("pixiTags", pixi_tags(phase, motion_style, transition))
          }.compact
        end
      end

      def pixi_montage_planner
        @pixi_montage_planner ||= PixiMontagePlanner.new(
          direction: direction,
          proposal: proposal,
          visual_intensity: visual.fetch("intensity", "auto"),
          generation_seed: generation_seed
        )
      end

      def shot_timings(clip_duration_ms)
        weights = panels.map { |panel| SCENE_DURATION_WEIGHTS.fetch(panel.scene_duration, 1.0) }
        total_weight = weights.sum
        cursor = 0

        weights.map.with_index do |weight, index|
          duration = if index == weights.size - 1
            clip_duration_ms - cursor
          else
            (clip_duration_ms * (weight / total_weight)).round
          end

          duration = [ duration, MIN_DURATION_MS ].max
          timing = {
            "startMs" => cursor,
            "endMs" => cursor + duration,
            "durationMs" => duration
          }
          cursor += duration
          timing
        end
      end

      def shot_phase(index)
        return "HOOK" if index.zero?
        return "CLOSE" if index == panels.size - 1
        return "CLIMAX" if index == panels.size - 2

        "BODY"
      end

      def overlay_for(panel, text, bubble_style, text_position, text_size)
        return nil if panel.no_text? || text.blank? || text_position == "none"

        {
          "text" => text,
          "source" => "scene_text",
          "style" => bubble_style,
          "position" => text_position,
          "size" => text_size
        }
      end

      def motion_for(panel, motion_style)
        {
          "style" => motion_style,
          "source" => panel.scene_motion == "auto" ? "direction" : "scene",
          "intensity" => visual.fetch("intensity", "auto")
        }
      end

      def resolved_motion_for(panel, phase, index)
        return panel.scene_motion unless panel.scene_motion == "auto"
        return "impact" if phase == "CLIMAX" && %w[action horror thriller comedy].include?(proposal_genre)
        return "scroll" if phase == "CLOSE" && direction.fetch("style") == "webtoon_scroll"

        director_value(:motions, index, default_motion_for_phase(phase))
      end

      def resolved_bubble_for(panel, phase, index)
        return panel.scene_bubble unless panel.scene_bubble == "auto"
        return "burst" if phase == "CLIMAX" && %w[action comedy fantasy].include?(proposal_genre)

        director_value(:bubbles, index, "caption")
      end

      def resolved_position_for(panel, phase, index)
        return panel.scene_position unless panel.scene_position == "auto"
        return "top_safe" if phase == "HOOK"
        return "bottom_safe" if phase == "CLOSE"

        director_value(:positions, index, "center_safe")
      end

      def resolved_size_for(panel, phase)
        return panel.scene_size unless panel.scene_size == "auto"
        return "large" if phase == "HOOK"
        return "medium" if phase == "CLOSE"

        "medium"
      end

      def resolved_transition_for(panel, index)
        return normalized_transition(panel) unless panel.scene_transition == "auto"

        style_transition = director_value(:transitions, index - 1, nil)
        return style_transition if style_transition.present?

        GENRE_TRANSITIONS.fetch(proposal_genre, %w[speed_wipe ink_flash cut])[(index - 1) % 3]
      end

      def director_value(key, index, fallback)
        values = director_variant.fetch(key, [])
        value = values[index % values.size] if values.any?
        value.presence || fallback
      end

      def proposal_genre
        @proposal_genre ||= proposal.to_h["genre"].presence || ProjectDirection.proposal_defaults_for(direction).fetch("genre")
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

      def camera_motion_parameters(motion_style, index)
        {
          "zoomStart" => motion_style == "rgb" ? 1.22 : motion_style == "impact" ? 1.16 : motion_style == "parallax" ? 1.12 : index.even? ? 1.0 : 1.08,
          "zoomEnd" => motion_style == "rgb" ? 1.02 : motion_style == "impact" ? 1.02 : motion_style == "beat" ? 1.08 : index.even? ? 1.1 : 1.0,
          "panX" => motion_style == "rgb" ? (index.even? ? -0.08 : 0.08) : motion_style == "float" ? 0.02 : motion_style == "parallax" ? 0.06 : index.even? ? -0.04 : 0.04,
          "panY" => motion_style == "scroll" ? 0 : motion_style == "float" ? (Math.sin(index + 1) * 0.04).round(4) : index % 3 == 0 ? -0.03 : 0.03,
          "tempo" => %w[impact beat rgb manga].include?(motion_style) ? 1.28 : 1.0
        }
      end

      def pixi_active_effect_for(motion_style, phase)
        contract = active_effect_contract(motion_style, phase)
        {
          "id" => contract.fetch("id"),
          "kind" => "activeEffect",
          "layout" => contract.fetch("layout"),
          "parameters" => {
            "intensity" => visual.fetch("intensity", "auto"),
            "phase" => phase.to_s.downcase,
            "profile" => contract.fetch("profile"),
            "assetSlots" => MangaFxCatalog.slots_for(effect_id: contract.fetch("id"), visual_category: contract.fetch("profile"))
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
        {
          "id" => id,
          "layout" => layout,
          "profile" => profile
        }
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
        when "speed_wipe"
          { "id" => "tr-speed-wipe-pro", "layout" => "speed-wipe" }
        when "panel_slam"
          { "id" => "tr-impact-smash-cut", "layout" => "impact-smash" }
        when "page_slice"
          { "id" => "tr-page-flip-pro", "layout" => "page-flip-pro-vfx" }
        when "ink_flash"
          { "id" => "tr-ink-flash-impact", "layout" => "ink-flash-impact-pro-vfx" }
        else
          { "id" => "tr-#{transition.tr("_", "-")}", "layout" => transition.tr("_", "-") }
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

      def pixi_visual_preset_ids(*contracts)
        contracts.compact.map { |contract| contract.fetch("id") }
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

      def normalized_transition(panel)
        return "cut" if panel.scene_transition == "auto"

        panel.scene_transition
      end
  end
end
