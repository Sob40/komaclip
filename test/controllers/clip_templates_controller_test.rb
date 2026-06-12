require "test_helper"

class ClipTemplatesControllerTest < ActionDispatch::IntegrationTest
  test "index lists only current user's templates" do
    sign_in_as(users(:one))
    clip = create_ready_clip_for(projects(:one))
    own_template = ClipTemplate.from_clip(user: users(:one), clip: clip, name: "Launch style")
    own_template.save!
    other_template = ClipTemplate.from_clip(user: users(:two), clip: clips(:two), name: "Hidden style")
    other_template.save!

    get clip_templates_path

    assert_response :success
    assert_select "h1", "Templates"
    assert_select "input[value=?]", own_template.name
    assert_select "input[value=?]", other_template.name, count: 0
  end

  test "create saves a lightweight template from an owned clip" do
    sign_in_as(users(:one))
    clip = create_ready_clip_for(projects(:one))

    assert_difference -> { users(:one).clip_templates.count }, 1 do
      post clip_templates_path, params: { clip_id: clip.id }
    end

    template = users(:one).clip_templates.order(:created_at).last
    assert_equal clip, template.source_clip
    assert_equal "baseline-panel-sequence", template.settings.dig("visual", "presetId")
    assert_equal "i-wont-surrender", template.settings.dig("music", "id")
    assert_nil template.settings["shots"]
    assert_redirected_to project_clip_path(project_id: projects(:one), id: clip)
  end

  test "use creates a new draft with template settings but no assets" do
    sign_in_as(users(:one))
    clip = create_ready_clip_for(projects(:one))
    template = ClipTemplate.from_clip(user: users(:one), clip: clip, name: "Launch style")
    template.save!

    post use_clip_template_path(id: template)

    assert_equal 1, users(:one).projects.count
    project = users(:one).projects.order(:created_at).last
    assert_equal template.content_locale, project.content_locale
    assert_equal template.id, project.metadata.fetch("templateId")
    assert_equal template.settings, project.metadata.fetch("templateSettings")
    assert_equal 0, project.project_assets.count
    assert_redirected_to project_path(id: project)
  end

  test "update renames owned template" do
    sign_in_as(users(:one))
    clip = create_ready_clip_for(projects(:one))
    template = ClipTemplate.from_clip(user: users(:one), clip: clip, name: "Old name")
    template.save!

    patch clip_template_path(id: template), params: { clip_template: { name: "Cleaner style" } }

    assert_redirected_to clip_templates_path
    assert_equal "Cleaner style", template.reload.name
  end

  test "create rejects another user's clip" do
    sign_in_as(users(:one))

    assert_no_difference -> { ClipTemplate.count } do
      post clip_templates_path, params: { clip_id: clips(:two).id }
    end

    assert_response :not_found
  end

  private

    def create_ready_clip_for(project)
      panels = project.panels.includes(:project_asset).order(:position).to_a

      project.clips.create!(
        title: "Template source",
        position: project.clips.maximum(:position).to_i + 1,
        status: "ready",
        duration_ms: SceneContracts::InitialClipBuilder::DEFAULT_DURATION_MS,
        scene_contract: SceneContracts::InitialClipBuilder.new(project: project, panels: panels).build
      )
    end
end
