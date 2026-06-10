class CreateClipRenders < ActiveRecord::Migration[8.1]
  def change
    create_table :clip_renders do |t|
      t.references :project, null: false, foreign_key: true
      t.references :clip, null: false, foreign_key: true
      t.references :user, null: false, foreign_key: true
      t.string :status, null: false, default: "queued"
      t.string :renderer, null: false, default: "pixi"
      t.jsonb :scene_contract, null: false, default: {}
      t.string :output_key
      t.string :error_code
      t.text :error_message
      t.integer :duration_ms
      t.datetime :completed_at
      t.jsonb :metadata, null: false, default: {}

      t.timestamps
    end

    add_index :clip_renders, [ :project_id, :status ]
    add_index :clip_renders, [ :user_id, :status ]
    add_index :clip_renders, [ :status, :created_at ]
    add_index :clip_renders, :output_key, unique: true
  end
end
