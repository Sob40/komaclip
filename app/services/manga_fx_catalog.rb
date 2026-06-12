require "json"
require "uri"

class MangaFxCatalog
  Slot = Data.define(:id, :pack_id, :pack_label, :kind, :asset_type, :role, :url, :blend_mode, :anchor, :animation, :fallback, :license_status)

  MANIFEST_PATH = Rails.root.join("data/catalogs/manga-fx-packs.json")

  class << self
    def manifest
      @manifest ||= JSON.parse(MANIFEST_PATH.read)
    end

    def packs
      manifest.fetch("packs")
    end

    def all_slots
      @all_slots ||= packs.flat_map do |pack|
        pack.fetch("slots").map { |slot| build_slot(pack, slot) }
      end
    end

    def find_slot(id)
      all_slots.find { |slot| slot.id == id.to_s }
    end

    def slots_for(effect_id:, visual_category: nil)
      slots_for_preset(preset_id: effect_id, visual_category: visual_category)
    end

    def slots_for_preset(preset_id:, visual_category: nil)
      slot_ids = manifest.fetch("presetSlots", {}).fetch(preset_id.to_s, [])
      slots = slot_ids.filter_map { |id| find_slot(id) }
      slots = fallback_slots_for(visual_category) if slots.empty?
      slots.map { |slot| payload_for(slot) }
    end

    def payload_for(slot)
      {
        "id" => slot.id,
        "packId" => slot.pack_id,
        "packLabel" => slot.pack_label,
        "kind" => slot.kind,
        "assetType" => slot.asset_type,
        "role" => slot.role,
        "url" => safe_asset_url(slot),
        "blendMode" => slot.blend_mode,
        "anchor" => slot.anchor,
        "animation" => slot.animation,
        "fallback" => slot.fallback,
        "licenseStatus" => slot.license_status
      }
    end

    def safe_asset_url(slot)
      return nil unless slot.url.present?
      return nil unless allowed_license_status?(slot.license_status)

      slot.url
    end

    def allowed_license_status?(status)
      manifest.fetch("licensePolicy").fetch("allowed").include?(status.to_s)
    end

    def validate!
      errors = []
      errors << "contractVersion must be komaclip.manga-fx-packs.v1" unless manifest["contractVersion"] == "komaclip.manga-fx-packs.v1"
      errors << "renderer must be pixi" unless manifest["renderer"] == "pixi"

      slots = all_slots
      slot_ids = slots.map(&:id)
      duplicate_slot_ids = slot_ids.tally.select { |_id, count| count > 1 }.keys
      errors << "duplicate slot ids: #{duplicate_slot_ids.join(", ")}" if duplicate_slot_ids.any?

      packs.each do |pack|
        errors << "pack #{pack["id"]} has no slots" if pack.fetch("slots", []).empty?
        errors << "pack #{pack["id"]} has no visual categories" if pack.fetch("visualCategories", []).empty?
      end

      slots.each do |slot|
        errors << "slot #{slot.id} missing fallback" if slot.fallback.blank?
        errors << "slot #{slot.id} has blocked license status #{slot.license_status}" if blocked_license_status?(slot.license_status)
        errors << "slot #{slot.id} has url without app-safe license" if slot.url.present? && !allowed_license_status?(slot.license_status)
        errors << "slot #{slot.id} has unsupported url #{slot.url}" if slot.url.present? && !allowed_asset_url?(slot.url)
      end

      referenced_slot_ids = manifest.fetch("presetSlots", {}).values.flatten
      missing_slot_ids = referenced_slot_ids - slot_ids
      errors << "presetSlots reference missing slots: #{missing_slot_ids.uniq.join(", ")}" if missing_slot_ids.any?

      raise ArgumentError, errors.join("; ") if errors.any?

      true
    end

    def blocked_license_status?(status)
      manifest.fetch("licensePolicy").fetch("blocked").include?(status.to_s)
    end

    def allowed_asset_url?(url)
      uri = URI.parse(url.to_s)
      return true if uri.relative? && url.to_s.start_with?(manifest.fetch("storage").fetch("recommendedBasePath"))
      return true if uri.relative? && url.to_s.start_with?("/#{manifest.fetch("storage").fetch("recommendedBasePath")}")
      return true if uri.is_a?(URI::HTTPS) && uri.host.present?

      false
    rescue URI::InvalidURIError
      false
    end

    private

      def build_slot(pack, slot)
        Slot.new(
          id: slot.fetch("id"),
          pack_id: pack.fetch("id"),
          pack_label: pack.fetch("label"),
          kind: slot.fetch("kind"),
          asset_type: slot.fetch("assetType"),
          role: slot.fetch("role"),
          url: slot["url"],
          blend_mode: slot.fetch("blendMode", "normal"),
          anchor: slot.fetch("anchor", "cover"),
          animation: slot.fetch("animation", "none"),
          fallback: slot.fetch("fallback"),
          license_status: slot.fetch("licenseStatus")
        )
      end

      def fallback_slots_for(visual_category)
        return [] if visual_category.blank?

        pack = packs.find { |candidate| candidate.fetch("visualCategories").include?(visual_category.to_s) }
        return [] unless pack

        pack.fetch("slots", []).first(1).map { |slot| build_slot(pack, slot) }
      end
  end
end
