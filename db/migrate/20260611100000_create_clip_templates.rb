class CreateClipTemplates < ActiveRecord::Migration[8.1]
  def change
    create_table :clip_templates do |t|
      t.references :user, null: false, foreign_key: true
      t.references :source_clip, foreign_key: { to_table: :clips }
      t.string :name, null: false
      t.string :content_locale, null: false, default: "en"
      t.jsonb :settings, null: false, default: {}
      t.jsonb :metadata, null: false, default: {}

      t.timestamps
    end

    add_index :clip_templates, [ :user_id, :updated_at ]
  end
end
