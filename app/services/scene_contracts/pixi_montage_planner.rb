require "set"

module SceneContracts
  class PixiMontagePlanner
    STYLE_KEY_MAP = {
      "trailer_tense" => "trailer-tense",
      "impact_fast" => "battle-impact",
      "chapter_clean" => "chapter-clean",
      "webtoon_scroll" => "webtoon-scroll",
      "character_spotlight" => "character-spotlight",
      "sales_pitch" => "kickstarter-pitch",
      "making_of" => "making-of"
    }.freeze

    TRANSITION_ID_BY_TYPE = {
      "speed_wipe" => "tr-speed-wipe-pro",
      "panel_slam" => "tr-impact-smash-cut",
      "page_slice" => "tr-page-flip-pro",
      "ink_flash" => "tr-glitch-tear"
    }.freeze

    TRANSITION_TYPE_BY_ID = {
      "tr-speed-wipe-pro" => "speed_wipe",
      "tr-impact-smash-cut" => "panel_slam",
      "tr-page-flip-pro" => "page_slice",
      "tr-glitch-tear" => "glitch_tear",
      "tr-vertical-scroll-cut" => "vertical_scroll"
    }.freeze

    MOTION_STYLE_BY_MOTION_TAG = {
      "camera-cut-panels" => "manga",
      "panel-board" => "manga",
      "slow-push-in" => "cinematic",
      "snap-zoom" => "impact",
      "whip-pan" => "swipe",
      "dutch-drift" => "cinematic",
      "vertical-scan" => "scroll",
      "crash-punch-in" => "impact",
      "hero-rise" => "parallax",
      "cliffhanger-drop" => "cinematic",
      "floating-parallax" => "float",
      "noir-creep" => "cinematic",
      "orbit-reveal" => "parallax",
      "page-glide" => "scroll",
      "micro-shake" => "beat",
      "romance-drift" => "float",
      "horror-creep-zoom" => "glitch"
    }.freeze

    PATTERN_PROFILES = {
      "trailer-tense" => {
        text: %w[text-category:trailer-card text-category:caption-hook intent:trailer intent:suspense energy:medium],
        effect: %w[visual-category:horror-thriller intent:suspense intent:reveal reelSlot:build reelSlot:reveal energy:medium],
        cameraMotion: %w[visual-category:camera-manga-motion motion:slow-push-in motion:noir-creep motion:horror-creep-zoom motion:orbit-reveal intent:tension intent:suspense],
        transition: %w[visual-category:horror-thriller mechanic:glitch-tear intent:disturb reelSlot:reveal],
        preferredText: %w[tx-horror-ink-warning tx-scifi-hud-caption tx-hook-clean-caption tx-manga-impact-sfx tx-romance-letter-card],
        preferredEffects: %w[fx-glitch-horror-signal fx-panel-zoom-editorial fx-manga-speed-impact fx-webtoon-vertical-scroll fx-petal-bloom-depth],
        preferredCameraMotions: %w[fx-camera-slow-push-in fx-camera-horror-creep-zoom fx-camera-noir-creep fx-camera-orbit-reveal],
        preferredTransitions: %w[tr-glitch-tear tr-impact-smash-cut tr-speed-wipe-pro tr-page-flip-pro tr-vertical-scroll-cut],
        slots: {
          "HOOK" => %w[reelSlot:hook intent:hook],
          "BODY" => %w[reelSlot:build intent:suspense],
          "CLIMAX" => %w[reelSlot:reveal intent:reveal],
          "CLOSE" => %w[reelSlot:cta intent:promo]
        }
      },
      "battle-impact" => {
        text: %w[visual-category:manga-action text-category:impact-sfx text-category:slash-speed intent:impact energy:high],
        effect: %w[visual-category:manga-action intent:action intent:impact mechanic:radial-burst mechanic:halftone-burst mechanic:speed-lines energy:high reelSlot:beat],
        cameraMotion: %w[visual-category:camera-manga-motion motion:camera-cut-panels motion:panel-board motion:crash-punch-in motion:whip-pan motion:snap-zoom motion:micro-shake intent:impact energy:high],
        transition: %w[visual-category:manga-action mechanic:speed-wipe mechanic:impact-smash energy:high],
        preferredText: %w[tx-manga-impact-sfx tx-manga-dokan-explosion-sfx tx-manga-speedline-shout-banner tx-hook-clean-caption],
        preferredEffects: %w[fx-manga-burst-focus-frame fx-manga-halftone-burst fx-impact-freeze-punch fx-manga-speed-impact fx-panel-smash-burst],
        preferredCameraMotions: %w[fx-camera-cut-panel-rhythm fx-camera-manga-panel-board fx-camera-crash-punch-in fx-camera-whip-pan fx-camera-snap-zoom fx-camera-micro-shake],
        preferredTransitions: %w[tr-speed-wipe-pro tr-impact-smash-cut tr-page-flip-pro tr-glitch-tear],
        slots: {
          "HOOK" => %w[reelSlot:hook intent:hook],
          "BODY" => %w[reelSlot:beat intent:action],
          "CLIMAX" => %w[reelSlot:climax intent:impact],
          "CLOSE" => %w[reelSlot:cta intent:promo]
        }
      },
      "chapter-clean" => {
        text: %w[visual-category:universal-editorial text-category:caption-hook mechanic:caption intent:context energy:medium],
        effect: %w[visual-category:universal-editorial mechanic:panel-zoom intent:reading-flow energy:low],
        cameraMotion: %w[visual-category:camera-manga-motion motion:slow-push-in motion:page-glide intent:reading-flow energy:low],
        transition: %w[visual-category:universal-editorial mechanic:page-flip intent:chapter-flow energy:medium],
        preferredText: %w[tx-editorial-safe-lower-caption tx-hook-clean-caption tx-editorial-chapter-tag tx-editorial-minimal-title-card],
        preferredEffects: %w[fx-panel-zoom-editorial fx-webtoon-long-page-glide fx-webtoon-vertical-scroll],
        preferredCameraMotions: %w[fx-camera-slow-push-in fx-camera-page-glide fx-camera-floating-parallax],
        preferredTransitions: %w[tr-page-flip-pro tr-vertical-scroll-cut tr-speed-wipe-pro],
        slots: {
          "HOOK" => %w[reelSlot:hook intent:hook],
          "BODY" => %w[reelSlot:sequence intent:context],
          "CLIMAX" => %w[reelSlot:reveal intent:reveal],
          "CLOSE" => %w[reelSlot:cta intent:promo]
        }
      },
      "webtoon-scroll" => {
        text: %w[visual-category:webtoon-manhwa format:webtoon text-category:caption-hook intent:reading-flow energy:medium],
        effect: %w[visual-category:webtoon-manhwa format:webtoon intent:reading-flow mechanic:vertical-scroll energy:low-medium],
        cameraMotion: %w[visual-category:camera-manga-motion motion:vertical-scan motion:page-glide intent:reading-flow energy:low-medium],
        transition: %w[visual-category:webtoon-manhwa format:webtoon mechanic:vertical-scroll intent:reading-flow],
        preferredText: %w[tx-webtoon-vertical-scroll-caption tx-webtoon-episode-drop-card tx-webtoon-long-page-narration-strip],
        preferredEffects: %w[fx-webtoon-vertical-scroll fx-webtoon-long-page-glide fx-webtoon-floating-panel-stack],
        preferredCameraMotions: %w[fx-camera-vertical-scan fx-camera-page-glide fx-camera-slow-push-in],
        preferredTransitions: %w[tr-vertical-scroll-cut tr-page-flip-pro tr-speed-wipe-pro],
        slots: {
          "HOOK" => %w[reelSlot:hook intent:hook],
          "BODY" => %w[reelSlot:sequence intent:reading-flow],
          "CLIMAX" => %w[reelSlot:climax intent:suspense],
          "CLOSE" => %w[reelSlot:cta intent:promo]
        }
      },
      "character-spotlight" => {
        text: %w[text-category:character-hype text-category:romance-emotion intent:character intent:emotion energy:low],
        effect: %w[intent:character-intro intent:emotion reelSlot:emotion energy:low-medium],
        cameraMotion: %w[visual-category:camera-manga-motion motion:floating-parallax motion:romance-drift motion:slow-push-in intent:emotion intent:character energy:low],
        transition: %w[mechanic:page-flip energy:medium intent:chapter-flow],
        preferredText: %w[tx-romance-heart-glow-nameplate tx-romance-confession-whisper tx-manga-rival-nameplate],
        preferredEffects: %w[fx-petal-bloom-depth fx-romance-heartbeat-aura-pulse fx-romance-blush-sparkle-focus],
        preferredCameraMotions: %w[fx-camera-floating-parallax fx-camera-romance-drift fx-camera-slow-push-in],
        preferredTransitions: %w[tr-page-flip-pro tr-vertical-scroll-cut tr-speed-wipe-pro],
        slots: {
          "HOOK" => %w[reelSlot:introduce intent:character],
          "BODY" => %w[reelSlot:emotion intent:emotion],
          "CLIMAX" => %w[reelSlot:reveal intent:reveal],
          "CLOSE" => %w[reelSlot:cta intent:promo]
        }
      },
      "kickstarter-pitch" => {
        text: %w[visual-category:promo-social text-category:social-cta text-category:caption-hook intent:promo energy:medium],
        effect: %w[visual-category:promo-social intent:promo intent:teaser intent:release energy:medium-high],
        cameraMotion: %w[visual-category:camera-manga-motion motion:hero-rise motion:crash-punch-in motion:orbit-reveal intent:promo energy:medium-high],
        transition: %w[visual-category:manga-action visual-category:universal-editorial mechanic:impact-smash energy:high],
        preferredText: %w[tx-promo-release-banner tx-promo-shop-cta-card tx-hook-clean-caption tx-manga-impact-sfx],
        preferredEffects: %w[fx-manga-speed-impact fx-panel-zoom-editorial fx-glitch-horror-signal],
        preferredCameraMotions: %w[fx-camera-hero-rise fx-camera-crash-punch-in fx-camera-slow-push-in],
        preferredTransitions: %w[tr-impact-smash-cut tr-speed-wipe-pro tr-page-flip-pro],
        slots: {
          "HOOK" => %w[reelSlot:hook intent:hook],
          "BODY" => %w[reelSlot:promo intent:promo],
          "CLIMAX" => %w[reelSlot:reveal intent:release],
          "CLOSE" => %w[reelSlot:cta intent:promo]
        }
      },
      "making-of" => {
        text: %w[visual-category:promo-social mechanic:caption intent:context energy:medium],
        effect: %w[visual-category:promo-social intent:promo intent:adaptation mechanic:panel-stitch energy:medium],
        cameraMotion: %w[visual-category:camera-manga-motion motion:page-glide motion:vertical-scan motion:slow-push-in intent:reading-flow energy:low-medium],
        transition: %w[visual-category:webtoon-manhwa visual-category:universal-editorial mechanic:vertical-scroll mechanic:page-flip],
        preferredText: %w[tx-promo-creator-hook-caption tx-editorial-process-note tx-hook-clean-caption],
        preferredEffects: %w[fx-webtoon-panel-stitch-reveal fx-panel-zoom-editorial fx-webtoon-vertical-scroll],
        preferredCameraMotions: %w[fx-camera-page-glide fx-camera-vertical-scan fx-camera-slow-push-in],
        preferredTransitions: %w[tr-vertical-scroll-cut tr-page-flip-pro tr-speed-wipe-pro],
        slots: {
          "HOOK" => %w[reelSlot:hook intent:hook],
          "BODY" => %w[reelSlot:sequence intent:context],
          "CLIMAX" => %w[reelSlot:reveal intent:adaptation],
          "CLOSE" => %w[reelSlot:cta intent:promo]
        }
      }
    }.freeze

    GENRE_PROFILES = {
      "action" => {
        text: %w[visual-category:manga-action skin:manga-comic intent:action energy:high],
        effect: %w[visual-category:manga-action skin:manga intent:action energy:high],
        cameraMotion: %w[visual-category:camera-manga-motion motion:crash-punch-in motion:whip-pan motion:snap-zoom energy:high],
        transition: %w[visual-category:manga-action skin:manga energy:high]
      },
      "horror" => {
        text: %w[visual-category:horror-thriller skin:horror-thriller intent:suspense energy:medium],
        effect: %w[visual-category:horror-thriller skin:horror-thriller intent:suspense energy:medium-high],
        cameraMotion: %w[visual-category:camera-manga-motion motion:horror-creep-zoom motion:noir-creep motion:slow-push-in intent:dread],
        transition: %w[visual-category:horror-thriller skin:horror-scifi intent:disturb]
      },
      "thriller" => {
        text: %w[visual-category:horror-thriller subgenre:thriller intent:suspense intent:mystery],
        effect: %w[visual-category:horror-thriller subgenre:thriller intent:suspense reelSlot:clue],
        cameraMotion: %w[visual-category:camera-manga-motion motion:noir-creep motion:slow-push-in motion:horror-creep-zoom intent:suspense],
        transition: %w[visual-category:horror-thriller intent:disturb reelSlot:reveal]
      },
      "scifi" => {
        text: %w[visual-category:scifi-tech skin:scifi-tech text-category:scifi-hud intent:analysis],
        effect: %w[visual-category:scifi-tech skin:scifi-tech mechanic:hud intent:analysis],
        cameraMotion: %w[visual-category:camera-manga-motion motion:orbit-reveal motion:vertical-scan motion:slow-push-in intent:analysis intent:reveal],
        transition: %w[skin:horror-scifi mechanic:glitch-tear intent:disturb]
      },
      "romance" => {
        text: %w[visual-category:romance-fantasy skin:romance-fantasy text-category:romance-emotion intent:emotion energy:low],
        effect: %w[visual-category:romance-fantasy skin:romance-fantasy intent:emotion energy:low],
        cameraMotion: %w[visual-category:camera-manga-motion motion:romance-drift motion:floating-parallax motion:slow-push-in intent:emotion],
        transition: %w[mechanic:page-flip energy:medium]
      },
      "fantasy" => {
        text: %w[visual-category:romance-fantasy skin:soft-fantasy intent:magic text-category:power-aura],
        effect: %w[visual-category:romance-fantasy skin:soft-fantasy intent:fantasy intent:magic],
        cameraMotion: %w[visual-category:camera-manga-motion motion:floating-parallax motion:orbit-reveal motion:hero-rise intent:reveal],
        transition: %w[mechanic:page-flip energy:medium]
      },
      "comedy" => {
        text: %w[visual-category:comedy-slice skin:comedy-slice text-category:comedy-pop energy:medium],
        effect: %w[visual-category:comedy-slice skin:comedy-slice intent:reaction energy:medium],
        cameraMotion: %w[visual-category:camera-manga-motion motion:micro-shake motion:snap-zoom motion:page-glide intent:intensity],
        transition: %w[energy:medium intent:chapter-flow]
      },
      "drama" => {
        text: %w[visual-category:universal-editorial text-category:trailer-card mechanic:caption energy:medium],
        effect: %w[visual-category:universal-editorial mechanic:panel-zoom intent:reading-flow energy:low-medium],
        cameraMotion: %w[visual-category:camera-manga-motion motion:slow-push-in motion:page-glide motion:orbit-reveal energy:low-medium],
        transition: %w[visual-category:universal-editorial mechanic:page-flip intent:chapter-flow]
      }
    }.freeze

    def initialize(direction:, proposal:, visual_intensity:, generation_seed: nil)
      @direction = ProjectDirection.normalize(direction)
      @proposal = proposal.to_h
      @visual_intensity = visual_intensity.presence || "auto"
      @generation_seed = generation_seed.to_s
      @used = Hash.new { |hash, key| hash[key] = Set.new }
    end

    def plan_shot(overlay:, motion_style:, transition:, phase:, index:, total:, duration_ms:)
      context = {
        motion_style: motion_style,
        transition: transition,
        overlay_style: overlay.to_h["style"],
        phase: phase.to_s.upcase,
        index: index,
        total: total,
        duration_ms: duration_ms
      }

      text_preset = overlay.present? ? pick("text", context) : nil
      camera_preset = pick("cameraMotion", context)
      effect_preset = pick("effect", context)
      transition_preset = visible_transition?(transition) ? pick_transition(transition, context) : nil

      {
        "pixiTextStyle" => text_contract(text_preset, overlay),
        "pixiCameraMotion" => camera_motion_contract(camera_preset, motion_style, index),
        "pixiActiveEffect" => active_effect_contract(effect_preset, phase),
        "pixiTransitionOut" => transition_contract(transition_preset, transition),
        "pixiTags" => plan_tags(text_preset, camera_preset, effect_preset, transition_preset, phase, motion_style)
      }
    end

    def canonical_style_key
      STYLE_KEY_MAP.fetch(direction.fetch("style"), "chapter-clean")
    end

    private

      attr_reader :direction, :proposal, :visual_intensity, :generation_seed, :used

      def profile
        @profile ||= PATTERN_PROFILES.fetch(canonical_style_key, PATTERN_PROFILES.fetch("chapter-clean"))
      end

      def genre
        @genre ||= proposal["genre"].presence || ProjectDirection.proposal_defaults_for(direction).fetch("genre")
      end

      def genre_profile
        GENRE_PROFILES.fetch(genre.to_s, GENRE_PROFILES.fetch("drama"))
      end

      def role_tags(role, context)
        phase = context.fetch(:phase)
        tags = Array(profile[role.to_sym]) + Array(genre_profile[role.to_sym]) + Array(profile.dig(:slots, phase))
        tags += %w[energy:high intent:impact] if visual_intensity == "intense" && %w[effect cameraMotion transition].include?(role)
        tags += %w[energy:low] if visual_intensity == "subtle" && %w[effect cameraMotion].include?(role)
        tags += text_context_tags(context) if role == "text"
        tags += motion_context_tags(context) if role == "cameraMotion"
        tags += transition_context_tags(context) if role == "transition"
        tags.uniq
      end

      def text_context_tags(context)
        case context.fetch(:overlay_style).to_s
        when "burst"
          %w[visual-category:manga-action text-category:impact-sfx mechanic:sfx intent:impact energy:high]
        when "manga_vertical"
          %w[visual-category:manga-action text-category:kakimoji-mood mechanic:kakimoji-pressure]
        when "speech", "thought"
          %w[text-category:romance-emotion intent:emotion energy:low]
        else
          %w[mechanic:caption text-category:caption-hook]
        end
      end

      def motion_context_tags(context)
        case context.fetch(:motion_style).to_s
        when "impact" then %w[motion:crash-punch-in motion:snap-zoom intent:impact energy:high]
        when "swipe" then %w[motion:whip-pan intent:speed energy:medium-high]
        when "scroll" then %w[motion:vertical-scan motion:page-glide intent:reading-flow]
        when "parallax" then %w[motion:floating-parallax motion:orbit-reveal]
        when "float" then %w[motion:floating-parallax motion:romance-drift]
        when "beat" then %w[motion:micro-shake intent:intensity]
        when "glitch", "rgb" then %w[motion:horror-creep-zoom motion:noir-creep intent:disturb]
        when "manga" then %w[motion:camera-cut-panels motion:panel-board intent:impact]
        else %w[motion:slow-push-in]
        end
      end

      def transition_context_tags(context)
        case context.fetch(:transition).to_s
        when "speed_wipe" then %w[mechanic:speed-wipe energy:high]
        when "panel_slam" then %w[mechanic:impact-smash energy:high intent:shock]
        when "page_slice" then %w[mechanic:page-flip intent:chapter-flow]
        when "ink_flash", "glitch_tear" then %w[mechanic:glitch-tear mechanic:ink-flash intent:disturb]
        when "vertical_scroll" then %w[mechanic:vertical-scroll intent:reading-flow]
        else []
        end
      end

      def pick(type, context)
        candidates = VisualPresetCatalog.for_type(type)
        return nil if candidates.empty?

        scored = candidates.map { |preset| [ preset, score_preset(preset, type, context) ] }
        scored.reject! { |_preset, score| score <= 0 }
        scored.sort_by! { |preset, score| [ -score, used[type].include?(preset.fetch("id")) ? 1 : 0, preset.fetch("id") ] }
        selected = varied_selection(scored, type, context)
        used[type] << selected.fetch("id") if selected
        selected
      end

      def varied_selection(scored, type, context)
        return scored.first&.first if generation_seed.blank?

        best_score = scored.first&.second.to_f
        return nil unless best_score.positive?

        pool = scored.select { |_preset, score| score >= best_score * 0.78 }.first(type == "effect" ? 6 : 4)
        pool = scored.first(type == "effect" ? 4 : 3) if pool.empty?
        offset = stable_index("#{generation_seed}:#{type}:#{context.fetch(:phase)}:#{context.fetch(:index)}", pool.length)
        pool.fetch(offset).first
      end

      def stable_index(seed, length)
        return 0 unless length.positive?

        seed.each_byte.reduce(2_166_136_261) { |hash, byte| ((hash ^ byte) * 16_777_619) & 0xffffffff } % length
      end

      def pick_transition(transition, context)
        if TRANSITION_ID_BY_TYPE[transition].present?
          preset = VisualPresetCatalog.find(TRANSITION_ID_BY_TYPE.fetch(transition))
          return preset if preset
        end

        pick("transition", context)
      end

      def score_preset(preset, role, context)
        tags = VisualPresetCatalog.tags_for(preset)
        wanted = role_tags(role, context)
        preferred = Array(profile[preferred_key_for(role)])
        score = 1.0

        wanted.each do |tag|
          score += tag_score_weight(tag) if tags.include?(tag)
          prefix = tag.split(":", 2).first
          score += tag_prefix_bonus(tag) if prefix.present? && tags.any? { |candidate| candidate.start_with?("#{prefix}:") }
        end

        preferred_index = preferred.index(preset.fetch("id"))
        score += 16 - preferred_index * 2 if preferred_index
        score *= 0.42 if used[role].include?(preset.fetch("id"))
        score *= 0.36 if strict_visual_family?(role) && !compatible_visual_family?(tags, wanted)
        score *= 0.58 if visual_intensity == "subtle" && tags.include?("energy:high")
        score *= 1.16 if visual_intensity == "intense" && (tags.include?("energy:high") || tags.include?("energy:medium-high"))
        score += overlay_style_boost(preset, role, context)
        score += motion_style_boost(preset, role, context)
        score
      end

      def overlay_style_boost(preset, role, context)
        return 0 unless role == "text"

        tags = VisualPresetCatalog.tags_for(preset)
        case context.fetch(:overlay_style).to_s
        when "burst"
          return 42 if tags.include?("text-category:impact-sfx") || tags.include?("mechanic:sfx")
          return 24 if tags.include?("visual-category:manga-action") && tags.include?("intent:impact")
        when "manga_vertical"
          return 34 if tags.include?("mechanic:kakimoji-pressure") || tags.include?("layout:sfx-vertical")
        end

        0
      end

      def motion_style_boost(preset, role, context)
        motion = context.fetch(:motion_style).to_s
        return effect_motion_boost(preset, motion) if role == "effect"
        return 0 unless role == "cameraMotion"

        catalog_motion = VisualPresetCatalog.tag_value(preset, "motion")
        wanted = case motion
        when "impact" then %w[crash-punch-in snap-zoom micro-shake]
        when "swipe" then %w[whip-pan camera-cut-panels]
        when "scroll" then %w[vertical-scan page-glide]
        when "manga" then %w[camera-cut-panels panel-board crash-punch-in]
        when "float" then %w[floating-parallax romance-drift]
        when "parallax" then %w[floating-parallax orbit-reveal]
        when "beat" then %w[micro-shake snap-zoom]
        when "glitch", "rgb" then %w[horror-creep-zoom noir-creep dutch-drift]
        else []
        end

        wanted.include?(catalog_motion) ? 36 : 0
      end

      def effect_motion_boost(preset, motion)
        tags = VisualPresetCatalog.tags_for(preset)
        wanted = case motion
        when "impact"
          %w[mechanic:radial-burst mechanic:impact-freeze mechanic:panel-smash mechanic:sfx-slam intent:impact]
        when "swipe"
          %w[mechanic:slash mechanic:speed-lines intent:speed intent:action]
        when "manga"
          %w[visual-category:manga-action mechanic:speed-lines mechanic:radial-burst intent:action]
        when "beat"
          %w[mechanic:halftone-burst mechanic:combo-hits mechanic:sfx-slam intent:impact]
        when "glitch", "rgb"
          %w[mechanic:glitch visual-category:horror-thriller visual-category:scifi-tech]
        when "scroll"
          %w[mechanic:vertical-scroll mechanic:long-page-glide intent:reading-flow]
        else
          []
        end

        (tags & wanted).any? ? 38 : 0
      end

      def preferred_key_for(role)
        {
          "text" => :preferredText,
          "effect" => :preferredEffects,
          "cameraMotion" => :preferredCameraMotions,
          "transition" => :preferredTransitions
        }.fetch(role)
      end

      def tag_score_weight(tag)
        return 10 if tag.start_with?("visual-category:")
        return 7 if tag.start_with?("skin:", "text-category:")
        return 6 if tag.start_with?("mechanic:")
        return 5 if tag.start_with?("intent:")
        return 4 if tag.start_with?("reelSlot:")
        return 3 if tag.start_with?("energy:")

        3
      end

      def tag_prefix_bonus(tag)
        return 1.8 if tag.start_with?("visual-category:")
        return 1.4 if tag.start_with?("skin:")
        return 1.1 if tag.start_with?("intent:")

        0.7
      end

      def strict_visual_family?(role)
        return true if canonical_style_key.in?(%w[battle-impact webtoon-scroll]) && role.in?(%w[text effect cameraMotion transition])
        return true if canonical_style_key == "chapter-clean" && role.in?(%w[text effect])
        return true if genre.in?(%w[action horror thriller scifi romance fantasy comedy]) && role.in?(%w[text effect])

        false
      end

      def compatible_visual_family?(actual_tags, wanted_tags)
        wanted = visual_family_tags(wanted_tags)
        actual = visual_family_tags(actual_tags)
        return true if wanted.empty? || actual.empty?

        wanted.intersect?(actual)
      end

      def visual_family_tags(tags)
        tags.select { |tag| tag.start_with?("visual-category:", "skin:") }
      end

      def text_contract(preset, overlay)
        return nil if preset.blank? || overlay.blank?

        catalog_layout = VisualPresetCatalog.layout_for(preset)
        visual_category = VisualPresetCatalog.visual_category_for(preset)
        {
          "id" => preset.fetch("id"),
          "visualPresetId" => preset.fetch("id"),
          "kind" => "textStyle",
          "type" => "text",
          "title" => preset["title"],
          "layout" => overlay.fetch("style", "caption"),
          "catalogLayout" => catalog_layout,
          "mvpLayout" => catalog_layout,
          "textAnimation" => text_animation_for(catalog_layout, overlay.fetch("style", "caption")),
          "tags" => VisualPresetCatalog.tags_for(preset),
          "englishDescription" => preset["englishDescription"],
          "parameters" => preset.to_h.fetch("parameters", {}).merge(
            "position" => overlay.fetch("position", "bottom_safe"),
            "size" => overlay.fetch("size", "medium"),
            "assetSlots" => MangaFxCatalog.slots_for_preset(preset_id: preset.fetch("id"), visual_category: visual_category)
          )
        }
      end

      def camera_motion_contract(preset, fallback_motion_style, index)
        return nil if preset.blank?

        motion_tag = VisualPresetCatalog.tag_value(preset, "motion")
        motion_style = MOTION_STYLE_BY_MOTION_TAG.fetch(motion_tag, fallback_motion_style)
        layout = VisualPresetCatalog.layout_for(preset)
        {
          "id" => preset.fetch("id"),
          "visualPresetId" => preset.fetch("id"),
          "kind" => "cameraMotion",
          "type" => "cameraMotion",
          "title" => preset["title"],
          "layout" => layout,
          "motionStyle" => motion_style,
          "tags" => VisualPresetCatalog.tags_for(preset),
          "englishDescription" => preset["englishDescription"],
          "parameters" => preset.to_h.fetch("parameters", {}).merge(
            camera_motion_parameters(motion_style, index)
          ).merge(
            "catalogMotion" => motion_tag,
            "catalogLayout" => layout
          )
        }
      end

      def active_effect_contract(preset, phase)
        return nil if preset.blank?

        visual_category = VisualPresetCatalog.visual_category_for(preset)
        layout = VisualPresetCatalog.layout_for(preset)
        {
          "id" => preset.fetch("id"),
          "visualPresetId" => preset.fetch("id"),
          "kind" => "activeEffect",
          "type" => "effect",
          "title" => preset["title"],
          "layout" => layout,
          "effectType" => VisualPresetCatalog.mechanic_for(preset),
          "tags" => VisualPresetCatalog.tags_for(preset),
          "englishDescription" => preset["englishDescription"],
          "parameters" => preset.to_h.fetch("parameters", {}).merge(
            "intensity" => visual_intensity,
            "phase" => phase.to_s.downcase,
            "profile" => visual_category,
            "visualCategory" => visual_category,
            "assetSlots" => MangaFxCatalog.slots_for_preset(preset_id: preset.fetch("id"), visual_category: visual_category)
          )
        }
      end

      def transition_contract(preset, fallback_transition)
        return nil if preset.blank?

        visual_category = VisualPresetCatalog.visual_category_for(preset, "manga-action")
        transition_type = TRANSITION_TYPE_BY_ID.fetch(preset.fetch("id"), fallback_transition)
        layout = VisualPresetCatalog.layout_for(preset)
        {
          "id" => preset.fetch("id"),
          "visualPresetId" => preset.fetch("id"),
          "kind" => "transitionOut",
          "type" => "transition",
          "title" => preset["title"],
          "layout" => layout,
          "transitionType" => transition_type,
          "mvpTransitionType" => VisualPresetCatalog.mechanic_for(preset, layout),
          "tags" => VisualPresetCatalog.tags_for(preset),
          "englishDescription" => preset["englishDescription"],
          "parameters" => preset.to_h.fetch("parameters", {}).merge(
            "durationMs" => transition_duration_ms(transition_type),
            "tempo" => %w[speed_wipe panel_slam].include?(transition_type) ? 1.18 : 1.0,
            "layout" => layout,
            "visualCategory" => visual_category,
            "assetSlots" => MangaFxCatalog.slots_for_preset(preset_id: preset.fetch("id"), visual_category: visual_category)
          )
        }
      end

      def plan_tags(*items, phase, motion_style)
        items.compact.flat_map { |item| VisualPresetCatalog.tags_for(item) }.push(
          "phase:#{phase.to_s.downcase}",
          "genre:#{genre}",
          "style:#{direction.fetch("style")}",
          "mvpStyle:#{canonical_style_key}",
          "motion:#{motion_style}"
        ).uniq
      end

      def text_animation_for(catalog_layout, overlay_layout)
        return "pop_lock" if overlay_layout == "burst" || catalog_layout.in?(%w[black-star white-star speed-title])
        return "manga_reveal" if catalog_layout == "sfx-vertical"
        return "glitch" if catalog_layout.in?(%w[terminal glitch])
        return "bubble_rise" if catalog_layout.in?(%w[love-letter chat-card rose-drama])

        "rise_lock"
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

      def transition_duration_ms(transition)
        case transition
        when "panel_slam" then 430
        when "page_slice" then 560
        when "ink_flash" then 500
        else 460
        end
      end

      def visible_transition?(transition)
        transition.present? && !%w[none cut].include?(transition)
      end
  end
end
