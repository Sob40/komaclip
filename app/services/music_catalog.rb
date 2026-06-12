class MusicCatalog
  Track = Data.define(:id, :title, :artist, :mood, :url, :source, :license, :license_url)

  DEFAULT_VOLUME = 42
  MUSIC_PATH = Rails.root.join("public/music/music.json")
  MUSIC_URL_PREFIX = "/music"

  DEFAULT_BY_GENRE = {
    "action" => "epical-drums-01",
    "thriller" => "fright-night",
    "horror" => "piano-horror",
    "scifi" => "cyberpunk-city",
    "romance" => "romantic-05",
    "drama" => "i-wont-surrender",
    "comedy" => "mixkit-comedy-comical-2",
    "fantasy" => "mixkit-fantasy-kodama-night-town-114"
  }.freeze

  class << self
    def all
      @all ||= [ none, *local_tracks ]
    end

    def find(id)
      all.find { |track| track.id == id.to_s } || none
    end

    def none
      Track.new(
        id: "none",
        title: "No music",
        artist: "",
        mood: "Silent preview",
        url: nil,
        source: "",
        license: "",
        license_url: ""
      )
    end

    def default_for(proposal)
      find(DEFAULT_BY_GENRE.fetch(proposal.to_h["genre"].to_s, "i-wont-surrender"))
    end

    def payload_for(id:, volume: DEFAULT_VOLUME, start_offset_ms: 0)
      track = find(id)
      return nil if track.id == "none"

      {
        "id" => track.id,
        "title" => track.title,
        "artist" => track.artist,
        "mood" => track.mood,
        "url" => track.url,
        "source" => track.source,
        "license" => track.license,
        "licenseUrl" => track.license_url,
        "volume" => normalize_volume(volume),
        "startOffsetMs" => normalize_start_offset_ms(start_offset_ms)
      }
    end

    def normalize_volume(value)
      value.to_i.clamp(0, 100)
    end

    def normalize_start_offset_ms(value)
      value.to_i.clamp(0, 8_000)
    end

    private

      def local_tracks
        JSON.parse(MUSIC_PATH.read).filter_map do |entry|
          file = entry.fetch("file", "").to_s
          next unless file.end_with?(".mp3")

          Track.new(
            id: File.basename(file, ".mp3"),
            title: entry.fetch("title", File.basename(file, ".mp3").titleize),
            artist: entry.fetch("artist", ""),
            mood: entry.fetch("mood", entry.fetch("genre", "")),
            url: "#{MUSIC_URL_PREFIX}/#{file}",
            source: entry.fetch("source", "Local"),
            license: entry.fetch("license", ""),
            license_url: entry.fetch("licenseUrl", "")
          )
        end
      end
  end
end
