# This file is auto-generated from the current state of the database. Instead
# of editing this file, please use the migrations feature of Active Record to
# incrementally modify your database, and then regenerate this schema definition.
#
# This file is the source Rails uses to define your schema when running `bin/rails
# db:schema:load`. When creating a new database, `bin/rails db:schema:load` tends to
# be faster and is potentially less error prone than running all of your
# migrations from scratch. Old migrations may fail to apply correctly if those
# migrations use external dependencies or application code.
#
# It's strongly recommended that you check this file into your version control system.

ActiveRecord::Schema[8.1].define(version: 2026_06_10_221837) do
  # These are extensions that must be enabled in order to support this database
  enable_extension "pg_catalog.plpgsql"

  create_table "active_storage_attachments", force: :cascade do |t|
    t.bigint "blob_id", null: false
    t.datetime "created_at", null: false
    t.string "name", null: false
    t.bigint "record_id", null: false
    t.string "record_type", null: false
    t.index ["blob_id"], name: "index_active_storage_attachments_on_blob_id"
    t.index ["record_type", "record_id", "name", "blob_id"], name: "index_active_storage_attachments_uniqueness", unique: true
  end

  create_table "active_storage_blobs", force: :cascade do |t|
    t.bigint "byte_size", null: false
    t.string "checksum"
    t.string "content_type"
    t.datetime "created_at", null: false
    t.string "filename", null: false
    t.string "key", null: false
    t.text "metadata"
    t.string "service_name", null: false
    t.index ["key"], name: "index_active_storage_blobs_on_key", unique: true
  end

  create_table "active_storage_variant_records", force: :cascade do |t|
    t.bigint "blob_id", null: false
    t.string "variation_digest", null: false
    t.index ["blob_id", "variation_digest"], name: "index_active_storage_variant_records_uniqueness", unique: true
  end

  create_table "clip_renders", force: :cascade do |t|
    t.bigint "clip_id", null: false
    t.datetime "completed_at"
    t.datetime "created_at", null: false
    t.integer "duration_ms"
    t.string "error_code"
    t.text "error_message"
    t.jsonb "metadata", default: {}, null: false
    t.string "output_key"
    t.bigint "project_id", null: false
    t.string "renderer", default: "pixi", null: false
    t.jsonb "scene_contract", default: {}, null: false
    t.string "status", default: "queued", null: false
    t.datetime "updated_at", null: false
    t.bigint "user_id", null: false
    t.index ["clip_id"], name: "index_clip_renders_on_clip_id"
    t.index ["output_key"], name: "index_clip_renders_on_output_key", unique: true
    t.index ["project_id", "status"], name: "index_clip_renders_on_project_id_and_status"
    t.index ["project_id"], name: "index_clip_renders_on_project_id"
    t.index ["status", "created_at"], name: "index_clip_renders_on_status_and_created_at"
    t.index ["user_id", "status"], name: "index_clip_renders_on_user_id_and_status"
    t.index ["user_id"], name: "index_clip_renders_on_user_id"
  end

  create_table "clips", force: :cascade do |t|
    t.datetime "created_at", null: false
    t.integer "duration_ms", default: 0, null: false
    t.jsonb "metadata", default: {}, null: false
    t.integer "position", null: false
    t.bigint "project_id", null: false
    t.jsonb "scene_contract", default: {}, null: false
    t.string "status", default: "draft", null: false
    t.string "title", null: false
    t.datetime "updated_at", null: false
    t.index ["project_id", "position"], name: "index_clips_on_project_id_and_position", unique: true
    t.index ["project_id", "status"], name: "index_clips_on_project_id_and_status"
    t.index ["project_id"], name: "index_clips_on_project_id"
  end

  create_table "identities", force: :cascade do |t|
    t.string "avatar_url"
    t.datetime "created_at", null: false
    t.string "email_address", null: false
    t.string "name"
    t.string "provider", null: false
    t.string "uid", null: false
    t.datetime "updated_at", null: false
    t.bigint "user_id", null: false
    t.index ["provider", "uid"], name: "index_identities_on_provider_and_uid", unique: true
    t.index ["user_id"], name: "index_identities_on_user_id"
  end

  create_table "panels", force: :cascade do |t|
    t.datetime "created_at", null: false
    t.jsonb "crop", default: {}, null: false
    t.string "label"
    t.jsonb "metadata", default: {}, null: false
    t.integer "position", null: false
    t.bigint "project_asset_id", null: false
    t.bigint "project_id", null: false
    t.datetime "updated_at", null: false
    t.index ["project_asset_id"], name: "index_panels_on_project_asset_id"
    t.index ["project_id", "position"], name: "index_panels_on_project_id_and_position", unique: true
    t.index ["project_id"], name: "index_panels_on_project_id"
  end

  create_table "project_assets", force: :cascade do |t|
    t.bigint "byte_size", null: false
    t.string "checksum"
    t.string "content_type", null: false
    t.datetime "created_at", null: false
    t.string "filename", null: false
    t.string "kind", null: false
    t.jsonb "metadata", default: {}, null: false
    t.bigint "project_id", null: false
    t.string "status", default: "pending", null: false
    t.string "storage_key"
    t.datetime "updated_at", null: false
    t.bigint "user_id", null: false
    t.index ["project_id", "kind"], name: "index_project_assets_on_project_id_and_kind"
    t.index ["project_id", "status"], name: "index_project_assets_on_project_id_and_status"
    t.index ["project_id"], name: "index_project_assets_on_project_id"
    t.index ["storage_key"], name: "index_project_assets_on_storage_key", unique: true
    t.index ["user_id"], name: "index_project_assets_on_user_id"
  end

  create_table "projects", force: :cascade do |t|
    t.string "content_locale", default: "en", null: false
    t.datetime "created_at", null: false
    t.jsonb "metadata", default: {}, null: false
    t.string "status", default: "draft", null: false
    t.string "title", null: false
    t.datetime "updated_at", null: false
    t.bigint "user_id", null: false
    t.index ["user_id", "status"], name: "index_projects_on_user_id_and_status"
    t.index ["user_id", "updated_at"], name: "index_projects_on_user_id_and_updated_at"
    t.index ["user_id"], name: "index_projects_on_user_id"
  end

  create_table "sessions", force: :cascade do |t|
    t.datetime "created_at", null: false
    t.string "ip_address"
    t.datetime "updated_at", null: false
    t.string "user_agent"
    t.bigint "user_id", null: false
    t.index ["user_id"], name: "index_sessions_on_user_id"
  end

  create_table "users", force: :cascade do |t|
    t.string "avatar_url"
    t.datetime "created_at", null: false
    t.string "email_address", null: false
    t.string "locale", default: "en", null: false
    t.string "name"
    t.string "password_digest", null: false
    t.string "polar_customer_id"
    t.string "role", default: "user", null: false
    t.datetime "updated_at", null: false
    t.index ["email_address"], name: "index_users_on_email_address", unique: true
    t.index ["polar_customer_id"], name: "index_users_on_polar_customer_id", unique: true
  end

  add_foreign_key "active_storage_attachments", "active_storage_blobs", column: "blob_id"
  add_foreign_key "active_storage_variant_records", "active_storage_blobs", column: "blob_id"
  add_foreign_key "clip_renders", "clips"
  add_foreign_key "clip_renders", "projects"
  add_foreign_key "clip_renders", "users"
  add_foreign_key "clips", "projects"
  add_foreign_key "identities", "users"
  add_foreign_key "panels", "project_assets"
  add_foreign_key "panels", "projects"
  add_foreign_key "project_assets", "projects"
  add_foreign_key "project_assets", "users"
  add_foreign_key "projects", "users"
  add_foreign_key "sessions", "users"
end
