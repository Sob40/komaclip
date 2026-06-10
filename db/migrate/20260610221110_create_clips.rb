class CreateClips < ActiveRecord::Migration[8.1]
  def change
    create_table :clips do |t|
      t.references :project, null: false, foreign_key: true
      t.string :title, null: false
      t.integer :position, null: false
      t.string :status, null: false, default: "draft"
      t.integer :duration_ms, null: false, default: 0
      t.jsonb :scene_contract, null: false, default: {}
      t.jsonb :metadata, null: false, default: {}

      t.timestamps
    end

    add_index :clips, [ :project_id, :position ], unique: true
    add_index :clips, [ :project_id, :status ]
  end
end
