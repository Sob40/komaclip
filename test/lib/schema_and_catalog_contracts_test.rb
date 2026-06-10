require "test_helper"
require "json"

class SchemaAndCatalogContractsTest < ActiveSupport::TestCase
  SCHEMA_FILES = %w[
    schemas/montage.schema.json
    schemas/render-payload.schema.json
    schemas/visual-preset.schema.json
  ].freeze

  CATALOG_FILES = %w[
    data/catalogs/catalog-manifest.json
    data/catalogs/visual-catalog-v2.json
  ].freeze

  test "schema and catalog json files parse" do
    (SCHEMA_FILES + CATALOG_FILES).each do |relative_path|
      assert read_json(relative_path), relative_path
    end
  end

  test "schema files keep object contract shape" do
    SCHEMA_FILES.each do |relative_path|
      schema = read_json(relative_path)

      assert_equal "object", schema.fetch("type"), relative_path
      assert schema.fetch("required").any?, relative_path
      assert schema.fetch("properties").any?, relative_path
    end
  end

  test "visual catalog keeps imported pixi v2 contract" do
    catalog = read_json("data/catalogs/visual-catalog-v2.json")

    assert_equal "p2r.visual.v2", catalog.fetch("contractVersion")
    assert_equal "pixi", catalog.fetch("renderer")
    assert_equal "pixi-only", catalog.fetch("sourceOfTruth")
    assert_equal 11, catalog.fetch("visualCategories").size
    assert_equal 5, catalog.fetch("textAnimations").size
    assert_equal 223, catalog.fetch("presets").size
  end

  test "visual catalog summary matches preset counts" do
    catalog = read_json("data/catalogs/visual-catalog-v2.json")
    presets = catalog.fetch("presets")
    summary = catalog.fetch("summary")
    preset_counts = presets.map { |preset| preset.fetch("type") }.tally

    assert_equal summary.fetch("effect"), preset_counts.fetch("effect")
    assert_equal summary.fetch("cameraMotion"), preset_counts.fetch("cameraMotion")
    assert_equal summary.fetch("text"), preset_counts.fetch("text")
    assert_equal summary.fetch("transition"), preset_counts.fetch("transition")
    assert_equal summary.fetch("textAnimation"), catalog.fetch("textAnimations").size
    assert_equal summary.fetch("productionReady"), presets.count { |preset| preset["isProductionReady"] == true }
  end

  test "visual catalog preset ids are unique" do
    presets = read_json("data/catalogs/visual-catalog-v2.json").fetch("presets")
    ids = presets.map { |preset| preset.fetch("id") }

    assert_equal ids.uniq.size, ids.size
  end

  test "catalog manifest references existing internal catalog" do
    manifest = read_json("data/catalogs/catalog-manifest.json")
    imported_catalog = manifest.fetch("catalogs").find { |catalog| catalog.fetch("id") == "visual-catalog-v2-imported" }

    assert imported_catalog, "visual-catalog-v2-imported is missing from catalog manifest"
    assert_equal "en", imported_catalog.fetch("defaultLocale")
    assert_includes imported_catalog.fetch("supportedLocales"), "es"
    assert_equal "internal", imported_catalog.fetch("productionExposure")
    assert_equal false, imported_catalog.fetch("publicSelectable")
    assert_path_exists Rails.root.join(imported_catalog.fetch("path"))
  end

  private

  def read_json(relative_path)
    JSON.parse(Rails.root.join(relative_path).read)
  end
end
