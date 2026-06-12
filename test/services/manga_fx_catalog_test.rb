require "test_helper"

class MangaFxCatalogTest < ActiveSupport::TestCase
  test "returns safe slots for known effect presets" do
    slots = MangaFxCatalog.slots_for(effect_id: "fx-impact-freeze-punch", visual_category: "manga-action")

    assert_equal [ "shonen-impact-frame", "shonen-speed-lines-radial" ], slots.map { |slot| slot.fetch("id") }
    assert slots.all? { |slot| slot.fetch("packId") == "shonen-action" }
    assert_equal "/manga-fx/shonen-action/impact-frame-owned-v1.png", slots.first.fetch("url")
    assert_equal "owned", slots.first.fetch("licenseStatus")
    assert_nil slots.second.fetch("url")
    assert_equal "owned_required", slots.second.fetch("licenseStatus")
  end

  test "returns slots for transition and text presets" do
    transition_slots = MangaFxCatalog.slots_for_preset(preset_id: "tr-impact-smash-cut", visual_category: "manga-action")
    text_slots = MangaFxCatalog.slots_for_preset(preset_id: "tx-manga-impact-sfx", visual_category: "manga-action")

    assert_equal [ "shonen-transition-panel-slam", "shonen-impact-frame" ], transition_slots.map { |slot| slot.fetch("id") }
    assert_equal [ "shonen-sfx-burst-bubble" ], text_slots.map { |slot| slot.fetch("id") }
  end

  test "falls back by visual category when preset is not mapped" do
    slots = MangaFxCatalog.slots_for_preset(preset_id: "fx-custom-horror", visual_category: "horror-thriller")

    assert_equal [ "horror-scratch-lines" ], slots.map { |slot| slot.fetch("id") }
  end

  test "validates the manifest contract" do
    assert_equal true, MangaFxCatalog.validate!
  end

  test "does not expose urls without an app safe license" do
    unsafe_slot = MangaFxCatalog::Slot.new(
      id: "unsafe",
      pack_id: "test",
      pack_label: "Test",
      kind: "speed-lines",
      asset_type: "transparent-image",
      role: "overlay",
      url: "https://cdn.example.com/manga-fx/speed.png",
      blend_mode: "screen",
      anchor: "cover",
      animation: "radial-pulse",
      fallback: "drawSpeedLines",
      license_status: "owned_required"
    )
    safe_slot = unsafe_slot.with(license_status: "owned")

    assert_nil MangaFxCatalog.payload_for(unsafe_slot).fetch("url")
    assert_equal "https://cdn.example.com/manga-fx/speed.png", MangaFxCatalog.payload_for(safe_slot).fetch("url")
  end

  test "allows app served manga fx urls" do
    safe_slot = MangaFxCatalog::Slot.new(
      id: "local",
      pack_id: "test",
      pack_label: "Test",
      kind: "impact-frame",
      asset_type: "transparent-image",
      role: "accent",
      url: "/manga-fx/shonen-action/local.png",
      blend_mode: "normal",
      anchor: "cover",
      animation: "slam-pop",
      fallback: "drawImpactFrame",
      license_status: "owned"
    )

    assert_equal "/manga-fx/shonen-action/local.png", MangaFxCatalog.payload_for(safe_slot).fetch("url")
  end
end
