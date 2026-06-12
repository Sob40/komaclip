require "test_helper"

class MusicCatalogTest < ActiveSupport::TestCase
  test "selects default tracks by proposal genre" do
    assert_equal "piano-horror", MusicCatalog.default_for("genre" => "horror").id
    assert_equal "romantic-05", MusicCatalog.default_for("genre" => "romance").id
    assert_equal "i-wont-surrender", MusicCatalog.default_for("genre" => "unknown").id
  end

  test "builds safe payloads and clamps volume" do
    payload = MusicCatalog.payload_for(id: "cyberpunk-city", volume: 160, start_offset_ms: 12_500)

    assert_equal "cyberpunk-city", payload.fetch("id")
    assert_equal 100, payload.fetch("volume")
    assert_equal 8000, payload.fetch("startOffsetMs")
    assert_equal "/music/cyberpunk-city.mp3", payload.fetch("url")
    assert_nil MusicCatalog.payload_for(id: "none")
  end

  test "loads all local MVP music tracks" do
    tracks = MusicCatalog.all.reject { |track| track.id == "none" }

    assert_equal 42, tracks.size
    assert_includes tracks.map(&:id), "mixkit-action-k-o-1068"
    assert tracks.all? { |track| track.url.start_with?("/music/") }
  end
end
