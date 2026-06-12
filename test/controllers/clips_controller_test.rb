require "test_helper"

class ClipsControllerTest < ActionDispatch::IntegrationTest
  test "create requires authentication" do
    post project_clips_path(project_id: projects(:one))

    assert_redirected_to new_session_path
  end

  test "create requires panels" do
    project = users(:one).projects.create!(title: "Empty project", content_locale: "en")
    sign_in_as(users(:one))

    assert_no_difference -> { project.clips.count } do
      post project_clips_path(project_id: project)
    end

    assert_redirected_to project_path(id: project)
    follow_redirect!
    assert_select "div", /Create at least one panel/
  end

  test "create builds ready clip from owned panels" do
    projects(:one).update!(metadata: { "materialReady" => true, "directionStage" => "ready", "directionGoalChosen" => true, "directionStyleChosen" => true })
    previous_clip = projects(:one).clips.first
    sign_in_as(users(:one))

    assert_no_difference -> { projects(:one).clips.count } do
      post project_clips_path(project_id: projects(:one)), params: {
        proposal_genre: "horror",
        proposal_scene_time: "auto",
        proposal_intensity: "balanced",
        proposal_brief: "Make it tense",
        proposal_no_spoilers: "Do not reveal the ending"
      }
    end

    clip = projects(:one).clips.reload.order(:position).last
    assert_not_equal previous_clip.id, clip.id
    assert_equal "ready", clip.status
    assert_equal 1, clip.position
    assert_equal "Clip 1", clip.title
    assert_equal 8000, clip.duration_ms
    assert_equal "pixi", clip.scene_contract.fetch("renderer")
    assert_equal({ "goal" => "readers", "style" => "chapter_clean", "format" => "vertical_social" }, clip.metadata.fetch("direction"))
    assert_equal clip.metadata.fetch("direction"), clip.scene_contract.fetch("direction")
    assert_equal({ "genre" => "horror", "sceneTime" => "auto", "intensity" => "balanced", "brief" => "Make it tense", "noSpoilers" => "Do not reveal the ending" }, clip.metadata.fetch("proposal"))
    assert_equal clip.metadata.fetch("proposal"), clip.scene_contract.fetch("proposal")
    assert_equal "piano-horror", clip.scene_contract.fetch("music").fetch("id")
    assert_equal clip.metadata.fetch("music"), clip.scene_contract.fetch("music")
    assert_equal [ panels(:one).id ], clip.scene_contract.fetch("shots").map { |shot| shot.fetch("panelId") }
    assert_redirected_to project_clip_path(project_id: projects(:one), id: clip)
  end

  test "create skips excluded scenes" do
    project = projects(:one)
    second_asset = create_asset_for(users(:one), project)
    second_panel = project.panels.create!(project_asset: second_asset, position: 2, label: "Scene 2")
    panels(:one).update!(metadata: { "skipScene" => true })
    project.update!(metadata: { "materialReady" => true, "directionStage" => "ready", "directionGoalChosen" => true, "directionStyleChosen" => true })
    sign_in_as(users(:one))

    assert_no_difference -> { project.clips.count } do
      post project_clips_path(project_id: project)
    end

    clip = project.clips.reload.order(:position).last
    assert_equal [ second_panel.id ], clip.scene_contract.fetch("shots").map { |shot| shot.fetch("panelId") }
  end

  test "create stores expanded proposal controls" do
    project = projects(:one)
    project.update!(metadata: { "materialReady" => true, "directionStage" => "ready", "directionGoalChosen" => true, "directionStyleChosen" => true })
    sign_in_as(users(:one))

    assert_no_difference -> { project.clips.count } do
      post project_clips_path(project_id: project), params: {
        proposal_genre: "fantasy",
        proposal_scene_time: "cinematic",
        proposal_intensity: "intense"
      }
    end

    clip = project.clips.reload.order(:position).last
    assert_equal({ "genre" => "fantasy", "sceneTime" => "cinematic", "intensity" => "intense" }, clip.metadata.fetch("proposal"))
    assert_equal 22_000, clip.duration_ms
    assert_equal "intense", clip.scene_contract.fetch("visual").fetch("intensity")
  end

  test "create requires completed direction" do
    project = users(:one).projects.create!(title: "Undirected project", content_locale: "en", metadata: { "materialReady" => true })
    asset = create_asset_for(users(:one), project)
    project.panels.create!(project_asset: asset, position: 1, label: "Fresh panel")
    sign_in_as(users(:one))

    assert_no_difference -> { project.clips.count } do
      post project_clips_path(project_id: project)
    end

    assert_redirected_to project_path(id: project, anchor: "direction")
    follow_redirect!
    assert_select "div", /Choose goal and style/
  end

  test "create applies reusable template settings from project metadata" do
    project = users(:one).projects.create!(
      title: "Templated project",
      content_locale: "en",
      metadata: {
        "materialReady" => true,
        "directionStage" => "ready",
        "directionGoalChosen" => true,
        "directionStyleChosen" => true,
        "templateSettings" => {
          "durationMs" => 12_000,
          "format" => { "width" => 720, "height" => 1280, "fps" => 24 },
          "visual" => { "presetId" => "soft-pan" }
        }
      }
    )
    asset = create_asset_for(users(:one), project)
    project.panels.create!(project_asset: asset, position: 1, label: "Fresh panel")
    sign_in_as(users(:one))

    assert_difference -> { project.clips.count }, 1 do
      post project_clips_path(project_id: project)
    end

    clip = project.clips.order(:position).last
    assert_equal 12_000, clip.duration_ms
    assert_equal 12_000, clip.scene_contract.fetch("durationMs")
    assert_equal({ "width" => 720, "height" => 1280, "fps" => 24 }, clip.scene_contract.fetch("format"))
    assert_equal "soft-pan", clip.scene_contract.fetch("visual").fetch("presetId")
  end

  test "create rejects another user's project" do
    sign_in_as(users(:one))

    post project_clips_path(project_id: projects(:two))

    assert_response :not_found
  end

  test "show renders owned clip" do
    clip = create_clip_for(projects(:one))
    sign_in_as(users(:one))

    get project_clip_path(project_id: projects(:one), id: clip)

    assert_response :success
    assert_select ".kc-global-settings-summary", /Global settings/
    assert_select "h1", text: clip.title, count: 0
    assert_select "script[src*='clip_preview']"
    assert_select "[data-controller~='clip-preview']"
    assert_select "[data-controller~='clip-autosave']"
    assert_select "script[type='application/json']", /komaclip.scene.v1/
    assert_select "pre", false
    assert_select ".kc-flash-notice", false
    assert_select "a", { text: /Back to project/, count: 0 }
    assert_select ".kc-global-settings-panel"
    assert_select ".kc-global-settings-panel[open]"
    assert_select ".kc-global-settings-summary", text: /Clean chapter/
    assert_select "select[name=direction_goal]", count: 0
    assert_select "select[name=direction_style]"
    assert_select "select[name=proposal_genre]", count: 0
    assert_select "input[type=hidden][name=proposal_genre]"
    assert_select "select[name=proposal_scene_time]"
    assert_select "select[name=proposal_intensity]"
    assert_select "button", text: /Vary clip/
    assert_select "button", text: /Rebuild all/, count: 0
    assert_select "select[data-action='clip-preview#setPreviewPlatform'] option", 3
    assert_select ".kc-preview-output-row select[data-action='clip-preview#setPreviewPlatform']"
    assert_select ".kc-preview-output-row button[data-action='clip-preview#togglePlatformGuides']"
    assert_select ".kc-platform-guides .kc-platform-guide-label", 4
    assert_select ".kc-platform-safe-zone .kc-platform-guide-label", text: /Recommended text zone/
    assert_select ".kc-preview-output-row button[disabled]", text: /Export/
    assert_select ".kc-preview-stage-shell[data-platform='instagram_reels']"
    assert_select "[data-clip-preview-target='status']", count: 0
    assert_select "[data-clip-preview-target='progress']"
    assert_select "[data-action='clip-preview#togglePlayback']"
    assert_select "[data-action='clip-preview#restart']"
    assert_select "[data-action='clip-preview#previousShot']", count: 0
    assert_select "[data-action='clip-preview#nextShot']", count: 0
    assert_select ".kc-global-music-panel select[name='clip[music_id]']"
    assert_select "select[name='clip[music_id]'] option", 43
    assert_select ".kc-global-music-panel input[name='clip[music_volume]'][type=range]"
    assert_select ".kc-global-music-panel input[name='clip[music_start_offset_ms]'][type=hidden]"
    assert_select ".kc-global-music-panel button[data-action='clip-preview#fitCutsToMusic']", text: /Fit audio/
    assert_select ".kc-preview-music-panel", count: 0
    assert_select ".kc-autosave-pill", count: 0
    assert_select ".kc-clip-shot-selector[name=clip_scene_inspector]", minimum: 1
    assert_select ".kc-clip-shot-selector[checked]", count: 0
    assert_select ".kc-clip-shot-expand-cue", minimum: 1
    assert_select "[data-controller~='clip-scene-list']"
    assert_select "[data-clip-drag-handle]", minimum: 1
    assert_select ".kc-clip-shot-summary", minimum: 1
    assert_select ".kc-clip-shot-inspector", minimum: 1
    assert_select "textarea[name*='[context]']", count: 0
    assert_select "input[name*='[duration_seconds]'][type=text]", minimum: 1
    assert_select ".kc-text-style-options input[type=radio][name*='[scene_bubble]']", minimum: 1
    assert_select ".kc-text-size-options input[type=radio][name*='[scene_size]']", minimum: 1
    assert_select ".kc-text-position-options input[type=radio][name*='[scene_position]']", minimum: 1
    assert_select ".kc-scene-motion-options input[type=radio][name*='[scene_motion]']", minimum: 1
    assert_select ".kc-reading-pace-options input[type=radio][name*='[scene_duration]']", count: 0
    assert_select ".kc-scene-intensity-options input[type=radio][name*='[effect_intensity]']", count: 0
    assert_select "input[type=checkbox][name*='[highlight]']", count: 0
    assert_select "input[type=checkbox][name*='[locked]']", count: 0
    assert_select "select[name*='[effect_intensity]']", count: 0
    assert_select "form[action=?][method=post]", project_clip_path(project_id: projects(:one), id: clip)
  end

  test "show normalizes legacy pixi contract for preview" do
    clip = create_clip_for(projects(:one))
    legacy_contract = clip.scene_contract.deep_dup
    legacy_contract["shots"].each do |shot|
      shot.except!("pixiTextStyle", "pixiCameraMotion", "pixiActiveEffect", "pixiTransitionOut", "pixiRhythm", "pixiVisualPresetIds")
    end
    clip.update!(scene_contract: legacy_contract)
    sign_in_as(users(:one))

    get project_clip_path(project_id: projects(:one), id: clip)

    assert_response :success
    assert_includes @response.body, "pixiRhythm"
    assert_includes @response.body, "rhythm-hook"
    assert_includes @response.body, "pixiActiveEffect"
  end

  test "show signs asset urls only in preview payload" do
    project = users(:one).projects.create!(title: "Signed preview project", content_locale: "en")
    asset = create_asset_for(users(:one), project)
    project.panels.create!(project_asset: asset, position: 1, label: "Attached panel")
    clip = create_clip_for(project)
    sign_in_as(users(:one))

    get project_clip_path(project_id: project, id: clip)

    assert_response :success
    assert_select "script[type='application/json']", /rails\/active_storage/
    refute_includes JSON.generate(clip.reload.scene_contract), "rails/active_storage"
  end

  test "show rejects another user's clip" do
    sign_in_as(users(:one))

    get project_clip_path(project_id: projects(:two), id: clips(:two))

    assert_response :not_found
  end

  test "update edits generated shot settings in the clip contract" do
    second_asset = create_asset_for(users(:one), projects(:one))
    second_panel = projects(:one).panels.create!(project_asset: second_asset, position: 2, label: "Scene 2")
    clip = create_clip_for(projects(:one))
    sign_in_as(users(:one))

    patch project_clip_path(project_id: projects(:one), id: clip), params: {
      clip: {
        shots: {
          second_panel.id.to_s => {
            text: "Edited hook",
            no_text: "0",
            duration_seconds: "4.2",
            scene_bubble: "manga_vertical",
            scene_size: "large",
            scene_position: "top_safe",
            scene_motion: "impact"
          }
        },
        music_id: "cyberpunk-city",
        music_volume: "31",
        music_start_offset_ms: "1200"
      }
    }

    assert_redirected_to project_clip_path(project_id: projects(:one), id: clip)
    shot = clip.reload.scene_contract.fetch("shots").detect { |candidate| candidate.fetch("panelId") == second_panel.id }
    assert_equal "Edited hook", shot.fetch("text")
    assert_not shot.key?("context")
    assert_equal false, shot.fetch("noText")
    assert_equal "manga_vertical", shot.fetch("sceneBubble")
    assert_equal "large", shot.fetch("sceneSize")
    assert_equal "top_safe", shot.fetch("scenePosition")
    assert_equal "impact", shot.fetch("sceneMotion")
    assert_equal "custom", shot.fetch("sceneDuration")
    assert_equal 4200, shot.fetch("customDurationMs")
    assert_equal 4200, shot.fetch("durationMs")
    assert_equal "intense", shot.fetch("effectIntensity")
    assert_equal "Edited hook", shot.fetch("overlay").fetch("text")
    assert_equal "clip_edit", shot.fetch("overlay").fetch("source")
    assert_equal "manga_vertical", shot.fetch("overlay").fetch("style")
    assert_equal "large", shot.fetch("overlay").fetch("size")
    assert_equal "top_safe", shot.fetch("overlay").fetch("position")
    assert_equal "intense", shot.fetch("motion").fetch("intensity")
    assert_equal "cyberpunk-city", clip.scene_contract.fetch("music").fetch("id")
    assert_equal 31, clip.scene_contract.fetch("music").fetch("volume")
    assert_equal 1200, clip.scene_contract.fetch("music").fetch("startOffsetMs")
    assert_equal clip.metadata.fetch("music"), clip.scene_contract.fetch("music")
  end

  test "update persists normalized pixi contracts for legacy clips" do
    clip = create_clip_for(projects(:one))
    legacy_contract = clip.scene_contract.deep_dup
    legacy_contract["shots"].each do |shot|
      shot.except!("pixiTextStyle", "pixiCameraMotion", "pixiActiveEffect", "pixiTransitionOut", "pixiRhythm", "pixiVisualPresetIds")
    end
    clip.update!(scene_contract: legacy_contract)
    sign_in_as(users(:one))

    patch project_clip_path(project_id: projects(:one), id: clip), params: {
      clip: {
        music_id: "cyberpunk-city",
        music_volume: "31"
      }
    }

    shot = clip.reload.scene_contract.fetch("shots").first
    assert_redirected_to project_clip_path(project_id: projects(:one), id: clip)
    assert_equal "cyberpunk-city", clip.scene_contract.fetch("music").fetch("id")
    assert_equal "rhythm-hook-cinematic", shot.fetch("pixiRhythm").fetch("id")
    assert_equal "fx-panel-zoom-editorial", shot.fetch("pixiActiveEffect").fetch("id")
    assert_includes shot.fetch("pixiVisualPresetIds"), "rhythm-hook-cinematic"
  end

  test "update returns json for autosave" do
    clip = create_clip_for(projects(:one))
    sign_in_as(users(:one))

    patch project_clip_path(project_id: projects(:one), id: clip), params: {
      clip: {
        music_id: "cyberpunk-city",
        music_volume: "31"
      }
    }, as: :json

    assert_response :success
    assert_equal "saved", JSON.parse(response.body).fetch("status")
    assert_equal "cyberpunk-city", clip.reload.scene_contract.fetch("music").fetch("id")
  end

  test "update can suppress shot text without editing source panel" do
    panels(:one).update!(metadata: { "sceneText" => "Source text" })
    clip = create_clip_for(projects(:one))
    sign_in_as(users(:one))

    patch project_clip_path(project_id: projects(:one), id: clip), params: {
      clip: {
        shots: {
          panels(:one).id.to_s => {
            text: "Hidden in clip",
            no_text: "1"
          }
        }
      }
    }

    shot = clip.reload.scene_contract.fetch("shots").first
    assert_redirected_to project_clip_path(project_id: projects(:one), id: clip)
    assert_nil shot["text"]
    assert_equal true, shot.fetch("noText")
    assert_nil shot["overlay"]
    assert_equal "Source text", panels(:one).reload.scene_text
  end

  test "regenerate variant preserves manual scene edits" do
    clip = create_clip_for(projects(:one))
    contract = clip.scene_contract.deep_dup
    shot = contract.fetch("shots").first
    shot["text"] = "Manual hook"
    shot["noText"] = false
    shot["sceneBubble"] = "burst"
    shot["sceneSize"] = "large"
    shot["scenePosition"] = "top_safe"
    shot["sceneMotion"] = "impact"
    shot["effectIntensity"] = "intense"
    shot["sceneDuration"] = "custom"
    shot["customDurationMs"] = 4200
    shot["durationMs"] = 4200
    shot["endMs"] = 4200
    shot["overlay"] = { "text" => "Manual hook", "source" => "clip_edit", "style" => "burst", "position" => "top_safe", "size" => "large" }
    shot["motion"] = { "style" => "impact", "source" => "clip_edit", "intensity" => "intense" }
    contract["durationMs"] = 4200
    clip.update!(duration_ms: 4200, scene_contract: contract)
    sign_in_as(users(:one))

    assert_no_difference -> { projects(:one).clips.count } do
      post regenerate_project_clip_path(project_id: projects(:one), id: clip), params: {
        regeneration_mode: "variant",
        direction_style: "impact_fast",
        proposal_genre: "action",
        proposal_scene_time: "short",
        proposal_intensity: "intense"
      }
    end

    assert_redirected_to project_clip_path(project_id: projects(:one), id: clip)
    shot = clip.reload.scene_contract.fetch("shots").first
    assert_equal "Manual hook", shot.fetch("text")
    assert_equal "burst", shot.fetch("sceneBubble")
    assert_equal "large", shot.fetch("sceneSize")
    assert_equal "top_safe", shot.fetch("scenePosition")
    assert_equal "impact", shot.fetch("sceneMotion")
    assert_equal "custom", shot.fetch("sceneDuration")
    assert_equal 4200, shot.fetch("customDurationMs")
    assert_equal "clip_edit", shot.fetch("overlay").fetch("source")
    assert_equal "clip_edit", shot.fetch("motion").fetch("source")
    assert_equal "variant", clip.metadata.fetch("lastRegenerationMode")
    assert_equal({ "genre" => "drama", "sceneTime" => "short", "intensity" => "intense" }, clip.metadata.fetch("proposal"))
  end

  test "regenerate treats full mode as a safe variant" do
    clip = create_clip_for(projects(:one))
    contract = clip.scene_contract.deep_dup
    shot = contract.fetch("shots").first
    shot["text"] = "Manual hook"
    shot["sceneDuration"] = "custom"
    shot["customDurationMs"] = 4200
    shot["durationMs"] = 4200
    shot["endMs"] = 4200
    shot["overlay"] = { "text" => "Manual hook", "source" => "clip_edit", "style" => "burst" }
    contract["durationMs"] = 4200
    clip.update!(duration_ms: 4200, scene_contract: contract)
    sign_in_as(users(:one))

    assert_no_difference -> { projects(:one).clips.count } do
      post regenerate_project_clip_path(project_id: projects(:one), id: clip), params: {
        regeneration_mode: "full",
        proposal_genre: "comedy",
        proposal_scene_time: "standard",
        proposal_intensity: "balanced"
      }
    end

    assert_redirected_to project_clip_path(project_id: projects(:one), id: clip)
    shot = clip.reload.scene_contract.fetch("shots").first
    assert_equal "Manual hook", shot["text"]
    assert_equal 4200, shot.fetch("customDurationMs")
    assert_equal "variant", clip.metadata.fetch("lastRegenerationMode")
    assert_equal({ "genre" => "drama", "sceneTime" => "standard", "intensity" => "balanced" }, clip.metadata.fetch("proposal"))
  end

  test "reorder persists clip scene order" do
    second_asset = create_asset_for(users(:one), projects(:one))
    third_asset = create_asset_for(users(:one), projects(:one))
    second_panel = projects(:one).panels.create!(project_asset: second_asset, position: 2, label: "Scene 2")
    third_panel = projects(:one).panels.create!(project_asset: third_asset, position: 3, label: "Scene 3")
    clip = create_clip_for(projects(:one))
    sign_in_as(users(:one))

    patch reorder_project_clip_path(project_id: projects(:one), id: clip), params: {
      panel_ids: [ third_panel.id, panels(:one).id, second_panel.id ]
    }, as: :json

    assert_response :success
    contract = clip.reload.scene_contract
    shots = contract.fetch("shots")
    assert_equal [ third_panel.id, panels(:one).id, second_panel.id ], shots.map { |shot| shot.fetch("panelId") }
    assert_equal [ 1, 2, 3 ], shots.map { |shot| shot.fetch("position") }
    assert_equal [ "Scene 1", "Scene 2", "Scene 3" ], shots.map { |shot| shot.fetch("label") }
    assert_equal "HOOK", shots.first.fetch("phase")
    assert_equal "none", shots.first.fetch("transition")
    assert_equal contract.fetch("durationMs"), shots.sum { |shot| shot.fetch("durationMs") }
  end

  test "reorder rejects missing clip scenes" do
    second_asset = create_asset_for(users(:one), projects(:one))
    second_panel = projects(:one).panels.create!(project_asset: second_asset, position: 2, label: "Scene 2")
    clip = create_clip_for(projects(:one))
    sign_in_as(users(:one))

    patch reorder_project_clip_path(project_id: projects(:one), id: clip), params: {
      panel_ids: [ second_panel.id ]
    }, as: :json

    assert_response :unprocessable_entity
  end

  test "update rejects oversized shot text" do
    clip = create_clip_for(projects(:one))
    sign_in_as(users(:one))

    patch project_clip_path(project_id: projects(:one), id: clip), params: {
      clip: {
        shots: {
          panels(:one).id.to_s => {
            text: "x" * (Panel::MAX_SCENE_TEXT_LENGTH + 1),
            no_text: "0"
          }
        }
      }
    }

    assert_redirected_to project_clip_path(project_id: projects(:one), id: clip)
    assert_nil clip.reload.scene_contract.fetch("shots").first["text"]
  end

  test "destroy removes owned clip" do
    clip = create_clip_for(projects(:one))
    sign_in_as(users(:one))

    assert_difference -> { projects(:one).clips.count }, -1 do
      delete project_clip_path(project_id: projects(:one), id: clip)
    end

    assert_redirected_to project_path(id: projects(:one))
  end

  private

    def create_clip_for(project)
      panels = project.panels.includes(:project_asset).order(:position)

      project.clips.create!(
        title: "Controller test clip",
        position: 2,
        status: "ready",
        duration_ms: SceneContracts::InitialClipBuilder::DEFAULT_DURATION_MS,
        scene_contract: SceneContracts::InitialClipBuilder.new(project: project, panels: panels).build
      )
    end

    def create_asset_for(user, project)
      project.project_assets.create!(
        user: user,
        kind: "source_page",
        file: sample_image_upload
      )
    end

    def sample_image_upload
      Rack::Test::UploadedFile.new(Rails.root.join("test/fixtures/files/sample-page.png"), "image/png")
    end
end
